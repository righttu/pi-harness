// ============================================================================
// SubAgent 扩展：给模型一个 `subagent` 工具，把一个独立子任务委派给
// 同一个 Durable Object 里新开的一个子对话（child conversation）去做，
// 然后把子对话的最终回答作为工具结果返回给父对话。
//
// 要点（来自 Pi Durable 官方示例 22-subagent-foreground.ts）：
// - 子对话和父对话在同一个 DO、同一个 SQLite 里，不会新建 DO。
// - 子对话的 owner 是这次工具调用对应的任务（task）。所以：
//     父对话被 abort → 子对话一起 abort；
//     子对话没做完 → 父对话不算空闲。
// - replay: "safe"：DO 崩溃重启后重跑这个工具，会通过 ownership 索引
//   找回已经建好的子对话和已经提交的请求，不会重复建一个。
// - 子对话会复制父对话的配置（模型、系统提示、工作区工具），但我们把
//   subagent 工具本身从子对话里移除，防止无限套娃。
// ============================================================================

import type { Context } from "@earendil-works/chord";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineExtension,
  defineTool,
  LiveDoc,
  type EntryId,
  type Extension,
  type ToolExecutionApi
} from "@earendil-works/pi-durable";

/** 记录的子对话步骤上限，防止一个跑很久的子对话把 details 撑大。 */
const MAX_STEPS = 200;

/** 从子对话的最终 assistant 条目里取出纯文本。 */
async function answerText(
  api: ToolExecutionApi,
  answer: EntryId,
  context: Context
): Promise<string> {
  const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
  const message = entry?.model?.[0] as AssistantMessage | undefined;
  if (!message) return "";
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

/**
 * 导出的扩展对象。在 server.ts 里用 `registry.install(Subagent)` 安装。
 * 用 const 自引用（下面 `remove: [Subagent]`）是官方示例的写法，运行时合法。
 */
export const Subagent: Extension = defineExtension({
  name: "subagent",
  tools: [
    defineTool({
      name: "subagent",
      description:
        "Delegate a self-contained task to a subagent and get its final answer back. " +
        "Use it for work that can be described completely in one message and does not " +
        "need the current conversation's history, such as researching one question, " +
        "drafting one document, or processing one file. The subagent shares this " +
        "workspace and has the same file tools, but cannot spawn subagents itself.",
      parameters: Type.Object({
        task: Type.String({
          description:
            "Everything the subagent needs to know: the goal, the inputs (file paths or " +
            "pasted content), and what form the answer should take."
        })
      }),
      // 崩溃后重跑是安全的：ownership 索引会找回已有的子对话，requestId 会找回已有的提交。
      replay: "safe",
      execute: async (args, api, context) => {
        const { task } = args;

        // ── 1. 找到或创建子对话（在一次 commit 里完成，保证原子性）──
        const child = await api.commit(async (tx) => {
          // 重跑时：这个任务已经拥有一个子对话，直接复用。
          const existing = (
            await tx.scanConversations({ ownerTaskId: api.taskId }, 1)
          ).items[0];
          if (existing !== undefined) return existing.id;
          // 首次：新建一个由本次工具调用拥有的子对话。
          // 它会复制父对话的 agent 配置：模型、系统提示、扩展、工具。
          const created = await tx.createConversation({
            ownership: { kind: "task", taskId: api.taskId }
          });
          // 子对话里不再提供 subagent 工具，避免递归委派。
          await configure(tx, created.id, {
            extensions: { remove: [Subagent] }
          });
          return created.id;
        }, context);

        // ── 2. 把子对话 id 挂到工具调用的 details 上，前端可以据此找到子对话 ──
        await api.details({ conversationId: child }, context);

        // ── 3. 把任务提交给子对话 ──
        const handle = (await api.conversation(child, context))!;
        // 固定的 requestId：重跑时拿回同一个提交，而不是再提交一次。
        const request = {
          type: "input",
          content: task,
          requestId: `subagent:${api.taskId}`
        } as const;
        const submission = await handle.submit(request, context);

        // ── 4. 盯着子对话的 pi.live 文档，把它的工具调用过程转成一行行
        //       步骤：运行中的工具通过 api.output() 流给前端（父对话里那张
        //       Subagent 卡片会实时显示），完成后整份步骤表放进 details。
        //       每个 callId 的 running / done 各只记一次，所以步骤数有界。 ──
        const steps: string[] = [];
        const seen = new Set<string>();
        const note = (line: string) => {
          if (steps.length >= MAX_STEPS) return;
          steps.push(line);
          api.output(`${line}\n`);
        };
        let attempts = 0;
        const watch = await api.watchDoc(LiveDoc, child, context);
        watch?.start(async (live) => {
          if (!live) return;
          // 子对话向模型发了第几次请求（重试也算）。
          const attempt = live.generation?.attempt ?? 0;
          if (attempt > attempts) {
            attempts = attempt;
            note(attempt === 1 ? "→ model" : `→ model (retry ${attempt})`);
          }
          for (const slot of live.tools ?? []) {
            if (slot.status === "pending") continue;
            const key = `${slot.callId}:${slot.status}`;
            if (seen.has(key)) continue;
            seen.add(key);
            note(slot.status === "running" ? `→ ${slot.name}` : `✓ ${slot.name}`);
          }
        });

        // ── 5. 等子对话答完 ──
        let settled;
        try {
          settled = await submission.wait(context);
        } finally {
          await watch?.stop();
        }
        if (settled.status !== "done" || settled.type !== "input") {
          throw new Error(`Subagent did not finish: ${settled.status}`);
        }
        note("✓ answer");

        // ── 6. 把子对话的最终回答作为工具输出返回给父对话 ──
        const text = await answerText(api, settled.answer, context);
        return {
          output: [{ type: "text", text }],
          details: { conversationId: child, task, steps }
        };
      }
    })
  ]
});
