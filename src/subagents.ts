// ============================================================================
// 后台子代理（并行）。给模型一个 `subagents` 工具：
//   spawn(name, message)   起一个有名字的子代理并派第一个任务，立刻返回
//   send(name, message)    再给它发消息（默认 steer 插话；followUp 排队）
//   stop(name)             中止它手头的工作，它还在，可以继续用
//   status(name?)          看谁在忙、谁空闲
// 子代理的回答不是工具结果，而是在完成时作为一条新的用户消息
// "[subagent <name> answered, no reply needed] ..." 投递回父对话。所以父对话
// 可以一次 spawn 三个子代理然后继续干自己的事，三份答案陆续送达。
//
// 和 src/subagent.ts（前台、阻塞、直接拿回答案）是两个工具：前台适合"我现在
// 就要这个结果"，后台适合"分头去做，回头汇总"。
//
// 改编自 Pi Durable 官方示例 22-subagent-background.ts。关键机制：
// - 每个子代理是同一个 DO 里的一个独立对话，有自己的记忆。
// - 它的对话归一个 Anchor 任务所有。Anchor 是 background 任务，立刻结束，
//   作用只是做"边界"：父对话的 abort（Esc）和空闲等待到此为止，不会波及
//   子代理；但 root.abort({ background: true }) 仍能把一切停掉。
// - 每条消息由一个 Reporter 任务投递：发给子代理 → 等答案 → 作为 followUp
//   提交回父对话。Reporter 也是 background 任务，而且是 durable task：
//   DO 被回收后重启，它从上一个 checkpoint 继续，requestId 保证消息和报告
//   都不会重复。
// - 目录（名字 → 对话 id）存在父对话的一个 document 里，随事务提交。
// ============================================================================

import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  LiveDoc,
  type ConversationId,
  type EntryId,
  type Extension,
  type ModelRef,
  type TaskId
} from "@earendil-works/pi-durable";
import type { SubagentOptions } from "./subagent";

type Subagent = {
  conversationId: ConversationId;
  /** 已经报告过的答案；几条消息可能汇成一个答案，只报一次。 */
  reported: EntryId[];
};

/** 父对话的子代理目录。 */
const Subagents = defineDoc<{
  agents: Record<string, Subagent>;
  reporters: Record<string, TaskId>;
}>({
  checkpointWhen: () => false,
  kind: "app.subagents",
  version: 1,
  scope: "conversation",
  history: "latest",
  // 父对话被 fork 出去的分支不带子代理。
  fork: "initial",
  initial: () => ({ agents: {}, reporters: {} })
});

/** 见文件头：只是一个立刻结束的 background 任务，当子代理对话的"主人"。 */
const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "app.subagent-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_anchor, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context
      )
  },
  abort: (_anchor, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context)
});

type ReporterInput = {
  name: string;
  conversationId: ConversationId;
  message: string;
  followUp: boolean;
};
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };

/** 投递一条消息给子代理，把它的答案报告回父对话。 */
const Reporter = defineTask<ReporterInput, ReporterState, null>({
  name: "app.subagent-reporter",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    // 发消息，等答案，决定报告什么。
    deliver: async (reporter, runtime, context) => {
      const { name, conversationId, message, followUp } = reporter.input;
      const subagent = (await runtime.conversation(conversationId, context))!;
      const request = {
        type: "input",
        content: message,
        whenBusy: followUp ? "followUp" : "steer"
      } as const;
      const submission = await subagent.submit(
        { ...request, requestId: `subagent:${reporter.id}` },
        context
      );
      const settled = await submission.wait(context);
      // 一次提交里决定报告内容并记下"这个答案已报告"，重启后不会再决定一次。
      await runtime.commit(async (tx) => {
        const next = (report?: string) =>
          ({ status: "running", checkpoint: { phase: "report", report } }) as const;
        if (settled.status === "unanswered") {
          // aborted：被 stop 了，或排队时被撤回。没什么可报的。
          return next(
            settled.reason === "aborted"
              ? undefined
              : `[subagent ${name} failed: ${settled.reason}]`
          );
        }
        if (settled.type !== "input") return next();
        const agent = (await tx.doc(Subagents, runtime.conversationId)).agents[name]!;
        if (agent.reported.includes(settled.answer)) return next();
        agent.reported.push(settled.answer);
        const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as
          | AssistantMessage
          | undefined;
        return next(`[subagent ${name} answered, no reply needed] ${textOf(answer)}`);
      }, context);
    },
    // 作为 followUp 提交给父对话：父对话空闲就立刻开新一轮，忙就排在当前答案后。
    report: async (reporter, runtime, context) => {
      const report = reporter.state.checkpoint.report;
      if (report !== undefined) {
        const main = (await runtime.conversation(runtime.conversationId, context))!;
        await main.submit(
          {
            type: "input",
            content: report,
            whenBusy: "followUp",
            requestId: `subagent-report:${reporter.id}`
          },
          context
        );
      }
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context
      );
    }
  },
  abort: (_reporter, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context)
});

function textOf(message: AssistantMessage | undefined): string {
  return (message?.content ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

/**
 * 构造扩展。任务定义随扩展一起安装，DO 重启后尚未完成的 Reporter 才能接着跑。
 * 在 server.ts 用 `registry.install(createSubagents({...}))`。
 */
export function createSubagents(options: SubagentOptions = {}): Extension {
  const childModel: ModelRef | undefined = options.childModel;
  const subagentsTool = defineTool({
  name: "subagents",
  description:
    "Run several tasks in parallel with named background subagents, and keep working while they run. " +
    "Actions: spawn (name, message) starts a subagent on a task; send (name, message) gives it another " +
    "message (followUp: true queues it after its current answer instead of interrupting); stop (name) " +
    "aborts its current work; status (name, or omit for all) shows who is working. Each subagent shares " +
    "this workspace and remembers its own earlier messages. Its answer arrives later as a new message " +
    "beginning '[subagent <name> answered]'. Use `subagent` instead when you need one result before you " +
    "can continue.",
  parameters: Type.Object({
    action: Type.Union([
      Type.Literal("spawn"),
      Type.Literal("send"),
      Type.Literal("stop"),
      Type.Literal("status")
    ]),
    name: Type.Optional(Type.String({ description: "Short identifier, e.g. 'reader' or 'tests'." })),
    message: Type.Optional(Type.String({ description: "The task or message for the subagent." })),
    followUp: Type.Optional(Type.Boolean())
  }),
  // 崩溃打断的调用不重跑：重复一次 stop 可能停掉更新的工作。模型会看到调用
  // 被打断，可以用 status 确认。
  replay: "unsafe",
  execute: async (args, api, context) => {
    const { action, name, message, followUp } = args;
    const reply = (text: string, conversationId?: ConversationId) => ({
      output: [{ type: "text" as const, text }],
      ...(conversationId === undefined || name === undefined
        ? {}
        : { details: { name, conversationId } })
    });
    const registry = (await api.snapshot(Subagents, api.conversationId, context)) ?? {
      agents: {},
      reporters: {}
    };

    if (action === "status") {
      const names = name === undefined ? Object.keys(registry.agents) : [name];
      const lines: string[] = [];
      for (const each of names) {
        const found = Object.hasOwn(registry.agents, each) ? registry.agents[each] : undefined;
        if (found === undefined) continue;
        // 从收到输入到给出最终答案之间，对话有 run。
        const busy =
          (await api.snapshot(LiveDoc, found.conversationId, context))?.run !== undefined;
        lines.push(`${each}: ${busy ? "working" : "idle"}`);
      }
      return reply(lines.length === 0 ? "No subagents." : lines.join("\n"));
    }
    if (name === undefined) return reply(`${action} needs a name.`);
    const agent = Object.hasOwn(registry.agents, name) ? registry.agents[name] : undefined;
    if (action !== "spawn" && agent === undefined) return reply(`No subagent named ${name}.`);

    if (action === "stop") {
      await (await api.conversation(agent!.conversationId, context))!.abort(context);
      return reply(`Stopped ${name}.`, agent!.conversationId);
    }
    if (message === undefined) return reply(`${action} needs a message.`);

    // spawn 和 send：一次提交里起一个 Reporter 去送这条消息。
    const result = await api.commit(async (tx) => {
      const state = await tx.doc(Subagents, api.conversationId);
      const background = { ownership: { kind: "conversation" }, background: true } as const;
      if (action === "spawn") {
        if (Object.hasOwn(state.agents, name)) return `${name} already exists; use send.`;
        const anchor = await tx.createTask(Anchor, null, background);
        // 由父对话的一个任务拥有：从父对话的配置复制而来（模型、工具、提示）。
        const child = await tx.createConversation({
          ownership: { kind: "task", taskId: anchor }
        });
        // 子代理不能再派子代理；并且知道自己是谁。
        await configure(tx, child.id, {
          extensions: { remove: [SubagentsExtension] },
          ...(childModel ? { model: childModel } : {}),
          instructions:
            `You are the subagent "${name}", working for a main agent in a shared workspace. ` +
            "Do the task you are given completely, then answer with the result. Do not ask the " +
            "main agent questions unless you are blocked."
        });
        state.agents[name] = { conversationId: child.id, reported: [] };
      }
      const conversationId = state.agents[name]!.conversationId;
      const input = {
        name,
        conversationId,
        message,
        followUp: action === "send" && followUp === true
      };
      state.reporters[api.taskId] = await tx.createTask(Reporter, input, background);
      return action === "send" ? `Sent to ${name}.` : `Started ${name}.`;
    }, context);
    const current = (await api.snapshot(Subagents, api.conversationId, context))?.agents[name];
    return reply(result, current?.conversationId);
  }
});

  const SubagentsExtension: Extension = defineExtension({
    name: "subagents",
    tasks: [Anchor, Reporter],
    tools: [subagentsTool]
  });
  return SubagentsExtension;
}

/** 前端用：识别子代理的报告消息。 */
export const SUBAGENT_REPORT = /^\[subagent (\S+) ([^\]]*)\] ?([\s\S]*)$/;
