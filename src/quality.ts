// ============================================================================
// 提高执行质量的两个扩展：Reviewer 和 Plan mode。
//
// Reviewer（参考官方 27-reviewer.ts）
//   给主 Agent 一个 `review` 工具。调用时在同一个 DO 里开一个只读子对话：
//   角色是审查员，只有 read / ls / find / grep，默认用 sidekick 模型。它有一个
//   "再看一遍"循环：每次回答如果没说 "No further findings." 就被要求再查一轮，
//   最多 3 轮。最终发现列表作为工具结果回到主 Agent。系统提示要求主 Agent
//   写完代码先 review 再汇报，所以从用户角度看是"自动审查"。
//
// Plan mode（参考官方 26-plan-mode.ts）
//   用户在界面上打开 Plan 开关后，主对话被切成只读：只有 read / ls / find /
//   grep 和 submit_plan，系统提示要求"先读代码、写计划、什么都别改"。模型调
//   submit_plan 提交步骤列表后这一轮结束。用户看过计划点"执行"，界面关掉
//   Plan 开关（恢复全部工具）并发 "按计划执行"。
// ============================================================================

import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  section,
  type AgentChange,
  type Extension,
  type ModelRef,
  type ToolRegistration
} from "@earendil-works/pi-durable";

/** 只读工具的名字；从工作区工具里挑出来给 reviewer 和 plan mode 用。 */
export const READ_ONLY_TOOLS = new Set(["read", "ls", "find", "grep"]);

function textOf(message: AssistantMessage | undefined): string {
  return (message?.content ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

// ─── Reviewer ────────────────────────────────────────────────────────────────

const DONE = "No further findings.";
const MAX_REVIEW_PASSES = 3;

/** 审查员的角色和"再看一遍"循环。只装在 reviewer 子对话上。 */
export const ReviewerRole: Extension = defineExtension({
  name: "reviewer-role",
  sections: [
    section(
      "role",
      () =>
        "You are a code reviewer. You are given a description of a change and read-only access to the " +
        "workspace. Read the changed files and anything they depend on. Report concrete problems as a " +
        "numbered list: bugs, unhandled cases, security issues, broken assumptions, missing tests. For " +
        "each, give the file and line and a one-sentence fix. Do not restate what the code does, do " +
        "not praise, do not suggest style changes unless they hide a bug. Never edit files. " +
        `When you have nothing left to report, say exactly "${DONE}".`
    )
  ],
  hooks: [
    hook(GenerationTask, {
      onYield: (answer) =>
        textOf(answer).includes(DONE)
          ? undefined
          : {
              continue: `Look again for anything you missed. Say "${DONE}" when there is nothing left.`
            }
    })
  ]
});

export type QualityOptions = {
  /** 子对话（reviewer）用的模型；不传继承主对话。 */
  childModel?: ModelRef;
  /** 工作区的全部工具；这里挑出只读的那几个。 */
  workspaceTools: readonly ToolRegistration[];
  /** 子对话里要移除的扩展：subagent / subagents / review 自己。 */
  removeInChild: readonly Extension[];
};

/** `review` 工具的扩展。 */
export function createReview(options: QualityOptions): Extension {
  const readOnly = options.workspaceTools.filter((tool) => READ_ONLY_TOOLS.has(tool.name));
  const Review: Extension = defineExtension({
    name: "review",
    tools: [
      defineTool({
        name: "review",
        description:
          "Have an independent reviewer check code you just wrote or changed, before you report it as done. " +
          "Describe what changed and why, and list the files. The reviewer reads the workspace (it cannot " +
          "edit) and returns a numbered list of concrete problems, or confirms there are none. Fix what it " +
          "finds, then tell the user what the review found and what you fixed.",
        parameters: Type.Object({
          summary: Type.String({
            description: "What you changed and why, in a few sentences."
          }),
          files: Type.Array(Type.String(), {
            description: "Absolute paths of the files to review."
          })
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          const child = await api.commit(async (tx) => {
            const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
            if (existing !== undefined) return existing.id;
            const created = await tx.createConversation({
              ownership: { kind: "task", taskId: api.taskId }
            });
            await configure(tx, created.id, {
              extensions: { add: [ReviewerRole], remove: [...options.removeInChild, Review] },
              tools: readOnly,
              ...(options.childModel ? { model: options.childModel } : {})
            });
            return created.id;
          }, context);
          await api.details({ conversationId: child }, context);

          const handle = (await api.conversation(child, context))!;
          const content =
            `Review this change.\n\nSummary: ${args.summary}\n\nFiles:\n` +
            args.files.map((file) => `- ${file}`).join("\n");
          // 审查循环最多跑 MAX_REVIEW_PASSES 轮：onYield 的 continue 会一直续，
          // 这里给 reviewer 的提示里写明上限，避免模型永远不说 DONE。
          const settled = await (
            await handle.submit(
              {
                type: "input",
                content: `${content}\n\nYou have at most ${MAX_REVIEW_PASSES} passes.`,
                requestId: `review:${api.taskId}`
              },
              context
            )
          ).wait(context);
          if (settled.status !== "done" || settled.type !== "input") {
            throw new Error(`Review did not finish: ${settled.status}`);
          }
          // 把 reviewer 这一轮里所有 assistant 回答拼起来（续问会产生多条）。
          const page = await api.commit(
            (tx) => tx.scanEntries({ conversationId: child }, 50),
            context
          );
          const findings = page.items
            .filter((entry) => AssistantEntry.is(entry))
            .map((entry) => textOf(entry.model?.[0] as AssistantMessage | undefined))
            .filter((text) => text.trim() !== "")
            .join("\n\n")
            .replace(DONE, "")
            .trim();
          return {
            output: [{ type: "text", text: findings === "" ? DONE : findings }],
            details: { conversationId: child, files: args.files }
          };
        }
      })
    ]
  });
  return Review;
}

// ─── Plan mode ───────────────────────────────────────────────────────────────

/** 当前计划。fork 出去的分支保留 fork 时的计划。 */
export const PlanDoc = defineDoc<{ steps: string[] }>({
  checkpointWhen: () => false,
  kind: "app.plan",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ steps: [] })
});

const submitPlan = defineTool({
  name: "submit_plan",
  description:
    "Submit your plan as an ordered list of concrete steps. Each step should name the files it touches. " +
    "This ends your turn; the user will review the plan.",
  parameters: Type.Object({ steps: Type.Array(Type.String()) }),
  replay: "safe",
  execute: async (args, api, context) => {
    await api.commit(async (tx) => {
      (await tx.doc(PlanDoc, api.conversationId)).steps = args.steps;
    }, context);
    return {
      output: [{ type: "text", text: "Plan submitted. Wait for the user to approve it." }],
      control: { terminate: true }
    };
  }
});

export const Plan: Extension = defineExtension({
  name: "plan",
  tools: [submitPlan],
  sections: [
    section(
      "plan_mode",
      () =>
        "You are in plan mode. Read whatever you need to understand the task, then call submit_plan with " +
        "an ordered list of steps. Change nothing. Do not write, edit or run anything."
    )
  ]
});

/** 进入 plan mode：只读工具 + submit_plan。 */
export function enterPlanMode(workspaceTools: readonly ToolRegistration[]): AgentChange {
  return {
    extensions: { add: [Plan] },
    tools: [...workspaceTools.filter((tool) => READ_ONLY_TOOLS.has(tool.name)), submitPlan]
  };
}

/** 离开 plan mode：回到默认扩展选择和全部工具。 */
export const leavePlanMode: AgentChange = { extensions: null, tools: null };
