import {
  Badge,
  Button,
  Empty,
  InputArea,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import {
  ArrowDownIcon,
  ArrowsClockwiseIcon,
  BrainIcon,
  CaretLeftIcon,
  CheckCircleIcon,
  CodeIcon,
  DownloadSimpleIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  GearIcon,
  GitBranchIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  GitForkIcon,
  ListChecksIcon,
  PencilSimpleIcon,
  PlusIcon,
  SidebarSimpleIcon,
  StopIcon,
  SunIcon,
  TrashIcon,
  UploadSimpleIcon,
  UsersThreeIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon
} from "@phosphor-icons/react";
import { code } from "@streamdown/code";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import type { ToolInfo, TranscriptMessage, TranscriptPart } from "./protocol";
import { usePiSession } from "./use-pi-session";
import type { PiRunningTool } from "./view";
import "./styles.css";

const SESSION_KEY = "pi-harness-session";
const MODEL = "dynamic/pi-route";

const SUGGESTIONS = [
  {
    icon: <FilePlusIcon size={15} />,
    label: "Write a file",
    value:
      "Write a haiku about Durable Objects to /workspace/haiku.txt, then read it back."
  },
  {
    icon: <CodeIcon size={15} />,
    label: "Run JavaScript",
    value:
      "Use exec to run JavaScript that lists /workspace and returns the size of each file."
  },
  {
    icon: <GitBranchIcon size={15} />,
    label: "Clone a repo",
    value:
      "Clone https://github.com/octocat/Hello-World into /workspace/hello, then show its git log."
  }
] satisfies Array<{ icon: ReactNode; label: string; value: string }>;

// ============================================================================
// 会话列表（多会话支持）
//
// 一个"会话" = 一个 Durable Object，名字就是这里的 UUID。
//
// 目录的"真相"在服务端（GET/POST/PATCH /api/sessions，见 server.ts 和
// sessions.ts），换浏览器也找得回来。localStorage 里留一份缓存：
//   - SESSIONS_KEY：目录缓存，首屏先用它渲染，服务端回来后替换；
//   - SESSION_KEY：当前选中的那个；
//   - 第一次升级时，把本地目录里服务端没有的会话 POST 上去（迁移）。
// ============================================================================

const SESSIONS_KEY = "pi-harness-sessions";

/**
 * 一条会话。`id` 是目录项 id：根会话 = DO 的 UUID，分支 = "UUID:<pi session>"。
 * `object` 是 DO 名，`branch` 是 pi session id（根会话没有）。
 * `title` 是用户改的名字，或者从第一条消息自动取的；没有就显示 id。
 */
type SessionEntry = {
  id: string;
  object: string;
  branch?: string;
  parent?: string;
  createdAt: number;
  title?: string;
};

/** 服务端目录项（src/sessions.ts 的 SessionRecord）。 */
type SessionRecord = {
  id: string;
  object: string;
  branch: string | null;
  parent: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
};

function fromRecord(record: SessionRecord): SessionEntry {
  return {
    id: record.id,
    object: record.object,
    ...(record.branch ? { branch: record.branch } : {}),
    ...(record.parent ? { parent: record.parent } : {}),
    createdAt: record.createdAt,
    ...(record.title ? { title: record.title } : {})
  };
}

/** 本地新建的根会话。 */
function newEntry(): SessionEntry {
  const id = crypto.randomUUID();
  return { id, object: id, createdAt: Date.now() };
}

/** 会话状态（server.ts 的 SessionState）。 */
type SessionState = {
  planMode: boolean;
  plan: string[];
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: number;
  };
};

/** `/api/session/<object>/<sub>?session=<branch>` 这类地址。 */
function sessionUrl(entry: Pick<SessionEntry, "object" | "branch">, sub: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams({ ...(entry.branch ? { session: entry.branch } : {}), ...params });
  const query = search.toString();
  return `/api/session/${entry.object}/${sub}${query ? `?${query}` : ""}`;
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

const sessionsApi = {
  list: () => fetchJson<SessionRecord[]>("/api/sessions"),
  register: (entry: SessionEntry) =>
    fetchJson<SessionRecord>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        id: entry.id,
        createdAt: entry.createdAt,
        ...(entry.title ? { title: entry.title } : {})
      })
    }),
  rename: (id: string, title: string) =>
    fetchJson<SessionRecord>(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title })
    }),
  remove: (id: string) =>
    fetchJson<{ deleted: string }>(`/api/sessions/${id}`, { method: "DELETE" }),
  fork: (entry: SessionEntry, title: string) =>
    fetchJson<SessionRecord>(sessionUrl(entry, "fork"), {
      method: "POST",
      body: JSON.stringify({ title })
    }),
  state: (entry: SessionEntry) => fetchJson<SessionState>(sessionUrl(entry, "state")),
  setPlanMode: (entry: SessionEntry, on: boolean) =>
    fetchJson<{ planMode: boolean }>(sessionUrl(entry, "plan"), {
      method: "POST",
      body: JSON.stringify({ on })
    })
};

/** 读取会话目录；不存在或损坏则返回空数组。 */
function loadSessions(): SessionEntry[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s): s is SessionEntry =>
          typeof s === "object" &&
          s !== null &&
          typeof (s as SessionEntry).id === "string" &&
          typeof (s as SessionEntry).createdAt === "number"
      )
      // 旧版缓存没有 object 字段：根会话的 object 就是 id。
      .map((s) => ({ ...s, object: s.object ?? s.id.split(":")[0] }));
  } catch {
    return [];
  }
}

function saveSessions(sessions: SessionEntry[]): void {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

/**
 * 启动时决定"当前会话"和"会话目录"。
 * 兼容旧版：如果目录为空但旧的单个 UUID 还在，就把它收进目录。
 */
function initSessions(): { current: string; sessions: SessionEntry[] } {
  let sessions = loadSessions();
  const legacy = localStorage.getItem(SESSION_KEY);
  if (legacy && !sessions.some((s) => s.id === legacy)) {
    sessions = [{ id: legacy, object: legacy, createdAt: Date.now() }, ...sessions];
  }
  if (sessions.length === 0) {
    sessions = [newEntry()];
  }
  saveSessions(sessions);
  const current =
    legacy && sessions.some((s) => s.id === legacy) ? legacy : sessions[0].id;
  localStorage.setItem(SESSION_KEY, current);
  return { current, sessions };
}

function sessionTime(entry: SessionEntry): string {
  const when = new Date(entry.createdAt);
  return `${when.getMonth() + 1}/${when.getDate()} ${String(
    when.getHours()
  ).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
}

/** 列表里显示的名字：用户起的标题，否则 UUID 前 8 位（分支再加 #<id>）。 */
function sessionLabel(entry: SessionEntry): string {
  if (entry.title?.trim()) return entry.title.trim();
  return entry.branch ? `${entry.object.slice(0, 8)} #${entry.branch}` : entry.object.slice(0, 8);
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** 自动标题：第一条用户消息的前 40 个字符。 */
function autoTitle(messages: readonly TranscriptMessage[]): string | undefined {
  const first = messages.find((message) => message.role === "user");
  if (!first) return undefined;
  const text = first.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
// ============================================================================

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") ?? "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((value) => (value === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-40 overflow-auto rounded-lg bg-kumo-elevated p-2.5 text-xs leading-5 whitespace-pre-wrap break-words">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

// ============================================================================
// 子对话（subagent）的过程展示。
//
// 服务端 src/subagent.ts 盯着子对话的 pi.live 文档，把它每次请求模型、
// 每个工具的开始/结束写成一行步骤（"→ read"、"✓ read"、"→ model"…）：
//   - 运行中：通过 api.output() 流过来，前端在 view.tools[].output 里；
//   - 完成后：整份步骤表放在工具结果的 details.steps 里。
// 下面两张卡片分别负责这两个阶段。
// ============================================================================

/** 把 "→ name" / "✓ name" 形式的步骤文本渲染成列表。最后一个 "→" 是进行中。 */
function StepList({ steps, running }: { steps: readonly string[]; running: boolean }) {
  if (steps.length === 0) {
    return running ? (
      <div className="flex items-center gap-2 text-xs text-kumo-subtle">
        <GearIcon size={12} className="animate-spin" />
        Starting sub-conversation…
      </div>
    ) : null;
  }
  // 每个工具名只要出现过 "✓"，它之前的 "→" 就算完成。
  const finished = new Set(
    steps.filter((s) => s.startsWith("✓")).map((s) => s.slice(1).trim())
  );
  return (
    <ol className="space-y-1">
      {steps.map((step, index) => {
        const done = step.startsWith("✓");
        const name = step.slice(1).trim();
        // "→ x" 且还没有对应的 "✓ x"，并且子对话仍在跑：进行中。
        const active = !done && running && !finished.has(name);
        if (done) return null; // 只画一条：用 "→" 那条代表这个工具
        return (
          <li key={index} className="flex items-center gap-2">
            {active ? (
              <GearIcon size={12} className="shrink-0 animate-spin text-kumo-accent" />
            ) : (
              <CheckCircleIcon size={12} className="shrink-0 text-kumo-success" />
            )}
            <span
              className={`font-mono text-xs ${
                active ? "font-medium text-kumo-default" : "text-kumo-subtle"
              }`}
            >
              {name}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function taskOf(args: unknown): string {
  const a = args as { task?: string; summary?: string } | undefined;
  return a?.task ?? a?.summary ?? "Unknown task";
}

/** 这几种工具用"子对话"卡片（任务 + 过程 + 结果）而不是通用 JSON 卡片。 */
const CHILD_TOOLS = new Set(["subagent", "review"]);
const childLabel = (name: string) => (name === "review" ? "Review" : "Subagent");

/** 子对话调用时展示的卡片。`output` 是运行中流过来的步骤文本。 */
function SubagentCallCard({
  part,
  running,
  output
}: {
  part: Extract<TranscriptPart, { type: "tool-call" }>;
  running: boolean;
  output: string;
}) {
  const task = taskOf(part.arguments);
  const steps = output.split("\n").filter((line) => line.trim() !== "");
  return (
    <details
      className="rounded-xl border border-kumo-line bg-kumo-base"
      open={running || undefined}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        {running ? (
          <GearIcon size={14} className="animate-spin text-kumo-accent" />
        ) : (
          <CheckCircleIcon size={14} className="text-kumo-success" />
        )}
        <GitBranchIcon size={14} className="text-kumo-subtle" />
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="font-semibold">{childLabel(part.name)}</span>
          <span className="ml-2 text-kumo-subtle">{task}</span>
        </span>
        <Badge variant={running ? "primary" : "secondary"}>
          {running ? "Running" : "Called"}
        </Badge>
      </summary>
      <div className="space-y-3 border-t border-kumo-line px-3 py-3">
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
            Task
          </p>
          <p className="whitespace-pre-wrap text-xs text-kumo-default">{task}</p>
        </div>
        {running ? (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              Progress
            </p>
            <StepList steps={steps} running />
          </div>
        ) : null}
      </div>
    </details>
  );
}

/** 子对话完成后的结果卡片。 */
function SubagentResultCard({
  part
}: {
  part: Extract<TranscriptPart, { type: "tool-result" }>;
}) {
  const details = part.details as
    | { conversationId?: string; task?: string; steps?: string[] }
    | undefined;
  const task = details?.task ?? "Unknown task";
  const conversationId = details?.conversationId;
  const steps = details?.steps ?? [];

  const text = part.content
    .filter((content) => content.type === "text")
    .map((content) => (content.type === "text" ? content.text : ""))
    .join("\n");

  return (
    <details className="rounded-xl border border-kumo-line bg-kumo-base">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        {part.error ? (
          <XCircleIcon size={14} className="text-kumo-danger" />
        ) : (
          <CheckCircleIcon size={14} className="text-kumo-success" />
        )}
        <GitBranchIcon size={14} className="text-kumo-subtle" />
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="font-semibold">{childLabel(part.name)}</span>
          <span className="ml-2 text-kumo-subtle">
            {task.slice(0, 60)}
            {task.length > 60 ? "…" : ""}
          </span>
        </span>
        <Badge variant={part.error ? "destructive" : "secondary"}>
          {part.error ? "Failed" : "Done"}
        </Badge>
      </summary>
      <div className="space-y-3 border-t border-kumo-line px-3 py-3">
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
            Task
          </p>
          <p className="whitespace-pre-wrap text-xs text-kumo-default">
            {task}
          </p>
        </div>
        {steps.length > 0 ? (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              Steps ({steps.filter((s) => s.startsWith("→")).length})
            </p>
            <StepList steps={steps} running={false} />
          </div>
        ) : null}
        {conversationId && (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              Conversation ID
            </p>
            <code className="rounded bg-kumo-elevated px-1.5 py-0.5 text-xs">
              {conversationId}
            </code>
          </div>
        )}
        {text && (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              {part.name === "review" ? "Findings" : "Result"}
            </p>
            <div className="rounded-lg bg-kumo-elevated p-2.5">
              <Streamdown className="sd-theme text-xs leading-5" plugins={{ code }} controls={false}>
                {text}
              </Streamdown>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

function ToolCallCard({
  part,
  running,
  output
}: {
  part: Extract<TranscriptPart, { type: "tool-call" }>;
  running: boolean;
  output: string;
}) {
  if (CHILD_TOOLS.has(part.name)) {
    return <SubagentCallCard part={part} running={running} output={output} />;
  }
  return (
    <details className="rounded-xl border border-kumo-line bg-kumo-base">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        {running ? (
          <GearIcon size={14} className="animate-spin text-kumo-inactive" />
        ) : (
          <CheckCircleIcon size={14} className="text-kumo-success" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          {part.name}
        </span>
        <Badge variant="secondary">{running ? "Running" : "Called"}</Badge>
      </summary>
      <div className="border-t border-kumo-line px-3 py-3">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
          Arguments
        </p>
        <JsonBlock value={part.arguments} />
      </div>
    </details>
  );
}

function ToolResultCard({
  part
}: {
  part: Extract<TranscriptPart, { type: "tool-result" }>;
}) {
  if (CHILD_TOOLS.has(part.name)) {
    return <SubagentResultCard part={part} />;
  }
  const text = part.content
    .filter((content) => content.type === "text")
    .map((content) => (content.type === "text" ? content.text : ""))
    .join("\n");
  const images = part.content.filter((content) => content.type === "image");
  return (
    <details className="rounded-xl border border-kumo-line bg-kumo-base">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        {part.error ? (
          <XCircleIcon size={14} className="text-kumo-danger" />
        ) : (
          <CheckCircleIcon size={14} className="text-kumo-success" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="font-semibold">{part.name}</span>
          {text ? <span className="ml-2 text-kumo-subtle">{text}</span> : null}
        </span>
        <Badge variant={part.error ? "destructive" : "secondary"}>
          {part.error ? "Failed" : "Done"}
        </Badge>
      </summary>
      <div className="space-y-3 border-t border-kumo-line px-3 py-3">
        {text ? (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              Result
            </p>
            <JsonBlock value={text} />
          </div>
        ) : null}
        {images.map((image, index) =>
          image.type === "image" ? (
            <img
              key={index}
              src={`data:${image.mimeType};base64,${image.data}`}
              alt={`${part.name} output`}
              className="max-w-full rounded-lg"
            />
          ) : null
        )}
        {part.details !== undefined ? (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              Details
            </p>
            <JsonBlock value={part.details} />
          </div>
        ) : null}
      </div>
    </details>
  );
}

function AssistantPart({
  part,
  running
}: {
  part: TranscriptPart;
  /** The live slot of this tool call, while it runs. */
  running: PiRunningTool | undefined;
}) {
  switch (part.type) {
    case "text":
      return (
        <Streamdown
          className="sd-theme text-sm leading-6"
          plugins={{ code }}
          controls={false}
        >
          {part.text}
        </Streamdown>
      );
    case "thinking":
      return (
        <details className="rounded-xl border border-kumo-line px-3 py-2">
          <summary className="cursor-pointer list-none text-xs font-semibold text-kumo-subtle">
            Thinking
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-xs italic leading-5 text-kumo-subtle">
            {part.text}
          </p>
        </details>
      );
    case "tool-call":
      return (
        <ToolCallCard
          part={part}
          running={running !== undefined}
          output={running?.output ?? ""}
        />
      );
    case "tool-result":
      return <ToolResultCard part={part} />;
    case "image":
      return (
        <img
          src={`data:${part.mimeType};base64,${part.data}`}
          alt=""
          className="max-w-full rounded-lg"
        />
      );
  }
}

/**
 * 后台子代理的报告以用户消息的形式进入父对话（见 src/subagents.ts 的
 * Reporter），形如 "[subagent reader answered, no reply needed] ..."。
 * 和 subagents.ts 的 SUBAGENT_REPORT 保持一致；不直接 import 那个文件，
 * 免得把 pi-durable 打进浏览器包。
 */
const SUBAGENT_REPORT = /^\[subagent (\S+) ([^\]]*)\] ?([\s\S]*)$/;

function SubagentReport({ name, status, body }: { name: string; status: string; body: string }) {
  const failed = status.startsWith("failed");
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-elevated text-kumo-subtle ring ring-kumo-line">
        <UsersThreeIcon size={17} />
      </div>
      <details className="min-w-0 flex-1 rounded-xl border border-kumo-line bg-kumo-base" open>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
          <GitBranchIcon size={14} className="text-kumo-subtle" />
          <span className="min-w-0 flex-1 truncate text-xs">
            <span className="font-semibold">Subagent {name}</span>
            <span className="ml-2 text-kumo-subtle">{failed ? status : "reported"}</span>
          </span>
          <Badge variant={failed ? "destructive" : "secondary"}>
            {failed ? "Failed" : "Report"}
          </Badge>
        </summary>
        {body ? (
          <div className="border-t border-kumo-line px-3 py-3">
            <Streamdown className="sd-theme text-sm leading-6" plugins={{ code }} controls={false}>
              {body}
            </Streamdown>
          </div>
        ) : null}
      </details>
    </div>
  );
}

function UserMessage({ message }: { message: TranscriptMessage }) {
  const text = message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
  const report = SUBAGENT_REPORT.exec(text);
  if (report) {
    return <SubagentReport name={report[1]} status={report[2]} body={report[3] ?? ""} />;
  }
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-kumo-contrast px-4 py-2.5 text-sm leading-relaxed text-kumo-inverse">
        {text}
      </div>
    </div>
  );
}

function AssistantMessage({
  message,
  streaming = false,
  runningTools
}: {
  message: TranscriptMessage;
  streaming?: boolean;
  runningTools: readonly PiRunningTool[];
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-white">
        <BrainIcon size={17} weight="bold" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        {message.parts.map((part, index) => (
          <AssistantPart
            key={`${message.id}-${index}`}
            part={part}
            // 按 callId 找这个调用的运行槽位，而不是按名字：同名工具可能
            // 在一轮里被调用多次。
            running={
              part.type === "tool-call"
                ? runningTools.find((tool) => tool.callId === part.id)
                : undefined
            }
          />
        ))}
        {streaming ? <span className="streaming-cursor" /> : null}
        {message.error ? (
          <div
            role="alert"
            className="rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
          >
            {message.error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ToolMessage({ message }: { message: TranscriptMessage }) {
  return (
    <div className="ml-11 space-y-2">
      {message.parts.map((part, index) =>
        part.type === "tool-result" ? (
          <ToolResultCard key={`${message.id}-${index}`} part={part} />
        ) : null
      )}
    </div>
  );
}

function Message({
  message,
  streaming = false,
  runningTools
}: {
  message: TranscriptMessage;
  streaming?: boolean;
  runningTools: readonly PiRunningTool[];
}) {
  switch (message.role) {
    case "user":
      return <UserMessage message={message} />;
    case "assistant":
      return (
        <AssistantMessage
          message={message}
          streaming={streaming}
          runningTools={runningTools}
        />
      );
    case "tool":
      return <ToolMessage message={message} />;
    case "notice":
      return message.parts.length === 0 ? null : (
        <p className="text-center text-xs text-kumo-inactive">
          {message.parts
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("")}
        </p>
      );
  }
}

function ToolsPanel({
  tools,
  activeTools
}: {
  tools: readonly ToolInfo[];
  activeTools: readonly string[];
}) {
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
      {tools.map((tool) => (
        <Surface key={tool.name} className="rounded-lg p-3 ring ring-kumo-line">
          <div className="flex items-center gap-2">
            {activeTools.includes(tool.name) ? (
              <GearIcon size={14} className="animate-spin text-kumo-accent" />
            ) : (
              <WrenchIcon size={14} className="text-kumo-inactive" />
            )}
            <code className="text-xs font-semibold">{tool.name}</code>
          </div>
          <p className="mt-1 text-xs text-kumo-subtle">{tool.description}</p>
        </Surface>
      ))}
    </div>
  );
}

// ============================================================================
// 文件面板：浏览当前会话的 /workspace，点文件预览，可下载。
// 数据来自 GET /api/session/<id>/files 和 /file（见 server.ts）。
// 一轮运行结束时自动刷新一次，因为模型刚才可能写了文件。
// ============================================================================

type FileEntry = {
  name: string;
  path: string;
  size: number;
  mtime: number;
  kind: "dir" | "file" | "link";
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const TEXT_TYPES = /^(text\/|application\/(json|javascript|xml))/;
const IMAGE_TYPES = /^image\//;

/** 按扩展名选代码高亮语言；返回 undefined 表示当普通文本。 */
function languageOf(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
    ts: "typescript", tsx: "tsx", json: "json", jsonc: "json",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", swift: "swift",
    sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell",
    html: "html", css: "css", scss: "scss", xml: "xml", svg: "xml",
    yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", sql: "sql",
    csv: "csv", diff: "diff", patch: "diff", dockerfile: "docker"
  };
  return map[ext];
}

function FilePreview({
  session,
  path,
  onClose
}: {
  session: string;
  path: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "text"; text: string; truncated: boolean; size: number }
    | { kind: "image"; url: string }
    | { kind: "binary"; size: number; type: string }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  const url = `/api/session/${session}/file?path=${encodeURIComponent(path)}`;

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
        const type = response.headers.get("content-type") ?? "";
        const size = Number(response.headers.get("x-file-size") ?? 0);
        const truncated = response.headers.get("x-file-truncated") === "true";
        if (TEXT_TYPES.test(type)) {
          const text = await response.text();
          if (!cancelled) setState({ kind: "text", text, truncated, size });
        } else if (IMAGE_TYPES.test(type)) {
          if (!cancelled) setState({ kind: "image", url });
        } else if (!cancelled) {
          setState({ kind: "binary", size, type });
        }
      } catch (cause) {
        if (!cancelled) {
          setState({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-kumo-line px-2 py-1.5">
        <Button
          variant="ghost"
          shape="square"
          size="sm"
          aria-label="Back to file list"
          onClick={onClose}
          icon={<CaretLeftIcon size={14} />}
        />
        <code className="min-w-0 flex-1 truncate text-xs" title={path}>
          {path.replace(/^\/workspace\/?/, "")}
        </code>
        <a
          href={`${url}&download=1`}
          download
          className="rounded p-1.5 text-kumo-subtle hover:bg-kumo-elevated"
          aria-label="Download"
          title="Download"
        >
          <DownloadSimpleIcon size={14} />
        </a>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {state.kind === "loading" ? (
          <p className="text-xs text-kumo-subtle">Loading…</p>
        ) : state.kind === "error" ? (
          <p className="text-xs text-kumo-danger">{state.message}</p>
        ) : state.kind === "image" ? (
          <img src={state.url} alt={path} className="max-w-full rounded-lg" />
        ) : state.kind === "binary" ? (
          <p className="text-xs text-kumo-subtle">
            {state.type || "binary"} · {formatSize(state.size)}. No preview; use Download.
          </p>
        ) : (
          <>
            {state.truncated ? (
              <p className="mb-2 text-[10px] text-kumo-inactive">
                Showing the first part of {formatSize(state.size)}. Download for the whole file.
              </p>
            ) : null}
            {/\.(md|markdown)$/i.test(path) ? (
              <Streamdown className="sd-theme text-sm leading-6" plugins={{ code }} controls={false}>
                {state.text}
              </Streamdown>
            ) : languageOf(path) ? (
              <Streamdown className="sd-theme text-xs" plugins={{ code }} controls={false}>
                {/* 外层用四个反引号，文件内容里出现 ``` 也不会把围栏切断 */}
                {`\`\`\`\`${languageOf(path)}\n${state.text}\n\`\`\`\``}
              </Streamdown>
            ) : (
              <pre className="text-xs leading-5 whitespace-pre-wrap break-words">{state.text}</pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FilesPanel({ session, refreshKey }: { session: string; refreshKey: number }) {
  const [dir, setDir] = useState("/workspace");
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [uploading, setUploading] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  /** 上传到当前目录，同名覆盖。一个个传，失败就停。 */
  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    try {
      for (const file of Array.from(files)) {
        setUploading(file.name);
        const target = `${dir}/${file.name}`;
        const response = await fetch(
          `/api/session/${session}/file?path=${encodeURIComponent(target)}`,
          { method: "PUT", body: file }
        );
        if (!response.ok) throw new Error(`${file.name}: ${response.status} ${await response.text()}`);
      }
      setTick((n) => n + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUploading(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  // 换会话回到根目录、关掉预览。
  useEffect(() => {
    setDir("/workspace");
    setOpen(null);
  }, [session]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchJson<FileEntry[]>(`/api/session/${session}/files?path=${encodeURIComponent(dir)}`)
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((cause) => {
        if (!cancelled) {
          setEntries([]);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session, dir, refreshKey, tick]);

  if (open) {
    return <FilePreview session={session} path={open} onClose={() => setOpen(null)} />;
  }

  const crumbs = dir.split("/").filter(Boolean); // ["workspace", "sub", ...]
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-kumo-line px-3 py-1.5 text-xs">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {crumbs.map((crumb, index) => {
            const target = `/${crumbs.slice(0, index + 1).join("/")}`;
            const last = index === crumbs.length - 1;
            return (
              <span key={target} className="flex min-w-0 items-center gap-1">
                {index > 0 ? <span className="text-kumo-inactive">/</span> : null}
                <button
                  type="button"
                  disabled={last}
                  onClick={() => setDir(target)}
                  className={`truncate ${last ? "font-semibold" : "text-kumo-subtle hover:underline"}`}
                >
                  {crumb}
                </button>
              </span>
            );
          })}
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => void upload(event.target.files)}
        />
        <span title={uploading ? `Uploading ${uploading}…` : `Upload to ${dir}`}>
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            aria-label="Upload files"
            disabled={uploading !== null}
            onClick={() => fileInput.current?.click()}
            icon={
              uploading ? (
                <GearIcon size={14} className="animate-spin" />
              ) : (
                <UploadSimpleIcon size={14} />
              )
            }
          />
        </span>
        <Button
          variant="ghost"
          shape="square"
          size="sm"
          aria-label="Refresh files"
          onClick={() => setTick((n) => n + 1)}
          icon={<ArrowsClockwiseIcon size={14} />}
        />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-2">
        {error ? <li className="px-2 py-1 text-xs text-kumo-danger">{error}</li> : null}
        {entries === null ? (
          <li className="px-2 py-1 text-xs text-kumo-subtle">Loading…</li>
        ) : entries.length === 0 && !error ? (
          <li className="px-2 py-1 text-xs text-kumo-subtle">Empty</li>
        ) : null}
        {entries?.map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              onClick={() => (entry.kind === "dir" ? setDir(entry.path) : setOpen(entry.path))}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-kumo-elevated"
            >
              {entry.kind === "dir" ? (
                <FolderIcon size={14} className="shrink-0 text-kumo-accent" weight="fill" />
              ) : (
                <FileIcon size={14} className="shrink-0 text-kumo-subtle" />
              )}
              <span className="min-w-0 flex-1 truncate text-xs">{entry.name}</span>
              {entry.kind !== "dir" ? (
                <span className="shrink-0 text-[10px] text-kumo-inactive">
                  {formatSize(entry.size)}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Sidebar({
  session,
  tools,
  activeTools,
  filesRefreshKey,
  onClose
}: {
  session: string;
  tools: readonly ToolInfo[];
  activeTools: readonly string[];
  filesRefreshKey: number;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"files" | "tools">("files");
  const tabClass = (active: boolean) =>
    `rounded-md px-2.5 py-1 text-xs font-semibold ${
      active ? "bg-kumo-elevated text-kumo-default" : "text-kumo-subtle hover:text-kumo-default"
    }`;
  return (
    <aside
      className="flex min-h-0 flex-col border-l border-kumo-line bg-kumo-base"
      aria-label="Workspace"
    >
      <div className="flex h-[68px] shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-3">
        <div className="flex items-center gap-1" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "files"}
            className={tabClass(tab === "files")}
            onClick={() => setTab("files")}
          >
            Files
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "tools"}
            className={tabClass(tab === "tools")}
            onClick={() => setTab("tools")}
          >
            Tools
          </button>
        </div>
        <Button
          variant="ghost"
          shape="square"
          aria-label="Close panel"
          onClick={onClose}
          icon={<XIcon size={16} />}
        />
      </div>
      {tab === "files" ? (
        <FilesPanel session={session} refreshKey={filesRefreshKey} />
      ) : (
        <ToolsPanel tools={tools} activeTools={activeTools} />
      )}
    </aside>
  );
}

// ============================================================================
// 左侧会话栏：列出所有会话，当前的高亮；每一项悬停出现"改名"和"删除"按钮，
// 不用先切过去再删。
// ============================================================================
function SessionSidebar({
  sessions,
  current,
  deleting,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onClose
}: {
  sessions: readonly SessionEntry[];
  current: string;
  deleting: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  // 根会话按目录顺序；每个根会话后面紧跟它（这个 DO）的分支。
  const ordered: SessionEntry[] = [];
  for (const entry of sessions) {
    if (entry.branch) continue;
    ordered.push(entry, ...sessions.filter((s) => s.branch && s.object === entry.object));
  }
  // 根会话已不在目录里的孤儿分支放最后。
  for (const entry of sessions) {
    if (entry.branch && !ordered.includes(entry)) ordered.push(entry);
  }
  return (
    <aside
      className="flex min-h-0 flex-col border-r border-kumo-line bg-kumo-base"
      aria-label="Sessions"
    >
      <div className="flex h-[68px] shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-3">
        <div className="flex items-center gap-2 pl-1">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-white">
            <BrainIcon size={17} weight="bold" />
          </div>
          <Text size="sm" bold>
            Pi harness
          </Text>
        </div>
        <div className="flex items-center">
          <Button
            variant="ghost"
            shape="square"
            aria-label="New session"
            onClick={onNew}
            icon={<PlusIcon size={16} />}
          />
          <Button
            variant="ghost"
            shape="square"
            aria-label="Hide sessions"
            onClick={onClose}
            icon={<SidebarSimpleIcon size={16} />}
          />
        </div>
      </div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {ordered.map((entry) => {
          const active = entry.id === current;
          const busy = deleting.has(entry.id);
          return (
            <li
              key={entry.id}
              className={`group flex items-center gap-1 rounded-lg pr-1 ${
                entry.branch ? "ml-3 border-l border-kumo-line pl-1" : ""
              } ${active ? "bg-kumo-elevated" : "hover:bg-kumo-elevated/60"} ${busy ? "opacity-50" : ""}`}
            >
              <button
                type="button"
                onClick={() => onSelect(entry.id)}
                disabled={busy}
                aria-current={active ? "true" : undefined}
                className="min-w-0 flex-1 px-2.5 py-2 text-left"
              >
                <div className={`flex items-center gap-1 truncate text-sm ${active ? "font-semibold" : ""}`}>
                  {entry.branch ? <GitForkIcon size={12} className="shrink-0 text-kumo-inactive" /> : null}
                  <span className="truncate">{sessionLabel(entry)}</span>
                </div>
                <div className="truncate text-[10px] text-kumo-inactive">
                  {sessionTime(entry)} · {entry.object.slice(0, 8)}
                  {entry.branch ? ` #${entry.branch}` : ""}
                </div>
              </button>
              {/* 悬停或当前项才显示操作按钮，避免列表太吵 */}
              <div
                className={`flex shrink-0 items-center ${
                  active ? "" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
                }`}
              >
                <Button
                  variant="ghost"
                  shape="square"
                  size="sm"
                  aria-label={`Rename ${sessionLabel(entry)}`}
                  disabled={busy}
                  onClick={() => onRename(entry.id)}
                  icon={<PencilSimpleIcon size={14} />}
                />
                <Button
                  variant="ghost"
                  shape="square"
                  size="sm"
                  aria-label={`Delete ${sessionLabel(entry)}`}
                  disabled={busy}
                  onClick={() => onDelete(entry.id)}
                  icon={<TrashIcon size={14} />}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

/** 离底部多近算"在底部"，像素。 */
const STICK_THRESHOLD = 80;

function App() {
  // ==========================================================================
  // 会话状态：当前会话 id + 会话目录。两者都同步写回 localStorage。
  // ==========================================================================
  const [initial] = useState(initSessions);
  const [session, setSessionState] = useState(initial.current);
  const [sessions, setSessions] = useState<SessionEntry[]>(initial.sessions);
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());

  /** 切换当前会话（也会记进 localStorage，刷新后还是它）。 */
  const setSession = (id: string) => {
    localStorage.setItem(SESSION_KEY, id);
    setSessionState(id);
  };

  const updateSessions = (next: SessionEntry[]) => {
    setSessions(next);
    saveSessions(next);
  };

  // 启动时和服务端目录同步：本地有、服务端没有的先迁上去，然后以服务端为准。
  // 服务端不可用就继续用本地缓存，不影响聊天。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const remote = await sessionsApi.list();
        const known = new Set(remote.map((record) => record.id));
        const missing = loadSessions().filter((entry) => !known.has(entry.id));
        for (const entry of missing) {
          remote.push(await sessionsApi.register(entry));
        }
        if (cancelled) return;
        const merged = remote
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map(fromRecord);
        if (merged.length === 0) {
          // 服务端是空的（全新账号）：把当前这个登记上去。
          const current = loadSessions().find((s) => s.id === localStorage.getItem(SESSION_KEY));
          const entry = current ?? newEntry();
          merged.push(fromRecord(await sessionsApi.register(entry)));
        }
        updateSessions(merged);
        if (!merged.some((s) => s.id === localStorage.getItem(SESSION_KEY))) {
          setSession(merged[0].id);
        }
      } catch (cause) {
        console.warn("session index unavailable, using local cache", cause);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // ==========================================================================

  /** 当前目录项；目录里找不到（比如刚被别处删了）就按根会话对待。 */
  const current: SessionEntry = sessions.find((s) => s.id === session) ?? {
    id: session,
    object: session.split(":")[0],
    ...(session.includes(":") ? { branch: session.split(":")[1] } : {}),
    createdAt: 0
  };

  const [prompt, setPrompt] = useState("");
  const wide = () => window.matchMedia("(min-width: 1100px)").matches;
  const [toolsOpen, setToolsOpen] = useState(wide);
  const [sessionsOpen, setSessionsOpen] = useState(wide);
  const {
    status,
    messages,
    live,
    running,
    tools: runningTools,
    catalog,
    queued,
    retry,
    error,
    submit: submitPrompt,
    abort
  } = usePiSession(current.object, current.branch);

  // ==========================================================================
  // 自动滚动，但只在你本来就在底部的时候。
  //
  // 往上翻历史时 stuck 变成 false，新内容来了也不动你；翻回底部（或点
  // 右下角的箭头、或发新消息）又会重新跟随。
  // ==========================================================================
  const scrollRef = useRef<HTMLElement>(null);
  const stuckRef = useRef(true);
  const [stuck, setStuck] = useState(true);

  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (!el) return;
    stuckRef.current = true;
    setStuck(true);
    el.scrollTo({ top: el.scrollHeight, behavior });
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    if (atBottom !== stuckRef.current) {
      stuckRef.current = atBottom;
      setStuck(atBottom);
    }
  };

  useEffect(() => {
    if (stuckRef.current) scrollToBottom();
  }, [messages, live, running, runningTools]);

  // 换会话：从底部开始看。
  useEffect(() => {
    scrollToBottom("instant");
  }, [session]);

  // 会话还没名字时，用它的第一条消息当名字（本地立刻生效，服务端异步同步）。
  useEffect(() => {
    const entry = sessions.find((s) => s.id === session);
    if (!entry || entry.title) return;
    const title = autoTitle(messages);
    if (!title) return;
    updateSessions(sessions.map((s) => (s.id === session ? { ...s, title } : s)));
    sessionsApi.rename(session, title).catch((cause) => console.warn("rename failed", cause));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, session]);

  // 一轮跑完刷新文件面板：模型可能刚写了文件。
  const [filesRefreshKey, setFilesRefreshKey] = useState(0);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) setFilesRefreshKey((n) => n + 1);
    wasRunning.current = running;
  }, [running]);

  const connected = status === "open";

  /** While a run is going, Enter queues a follow-up and Steer joins the run. */
  const submit = (whenBusy: "followUp" | "steer" = "followUp") => {
    const text = prompt.trim();
    if (!text || !connected) return;
    setPrompt("");
    submitPrompt(text, whenBusy);
    scrollToBottom();
  };

  // ==========================================================================
  // 新建 / 改名 / 删除会话
  // ==========================================================================

  /** 新建：生成一个新 UUID，加进目录顶部，并切换过去。旧会话保留。 */
  const newSession = () => {
    const entry = newEntry();
    updateSessions([entry, ...sessions]);
    setSession(entry.id);
    sessionsApi.register(entry).catch((cause) => console.warn("register failed", cause));
  };

  const renameSession = (id: string) => {
    const entry = sessions.find((s) => s.id === id);
    if (!entry) return;
    const title = window.prompt("会话名称", entry.title ?? "");
    if (title === null) return;
    updateSessions(
      sessions.map((s) =>
        s.id === id ? { ...s, title: title.trim() || undefined } : s
      )
    );
    sessionsApi.rename(id, title).catch((cause) => console.warn("rename failed", cause));
  };

  /**
   * 删除任意一个会话（不必是当前的）：
   *   1. 先从目录里移除；如果删的是当前会话，切到剩下的第一个（没有就新建），
   *      让 WebSocket 不再连着要删的 DO；
   *   2. 调 DELETE /api/session/<id>，服务端把那个 DO 的数据全部删掉；
   *   3. 失败就把目录项放回去，数据还在服务端，下次还能再删。
   */
  const deleteSession = async (target: string) => {
    const entry = sessions.find((s) => s.id === target);
    if (!entry) return;
    const branches = sessions.filter((s) => s.branch && s.object === entry.object && s.id !== target);
    const warning = entry.branch
      ? `删除分支「${sessionLabel(entry)}」？只是从列表移除；它的记录随源会话一起保存或删除。`
      : `删除会话「${sessionLabel(entry)}」？对话记录和工作区文件会一起删除，不可恢复。` +
        (branches.length > 0 ? `\n它的 ${branches.length} 个分支也会一起删除。` : "");
    if (!window.confirm(warning)) return;
    // 删根会话时，它的分支也从本地列表去掉（服务端 removeObject 会一起删）。
    const removing = new Set(entry.branch ? [target] : [target, ...branches.map((s) => s.id)]);
    setDeleting((set) => new Set(set).add(target));
    let next = sessions.filter((s) => !removing.has(s.id));
    if (next.length === 0) {
      const fresh = newEntry();
      next = [fresh];
      sessionsApi.register(fresh).catch((cause) => console.warn("register failed", cause));
    }
    updateSessions(next);
    if (removing.has(session)) setSession(next[0].id);
    try {
      await sessionsApi.remove(target);
    } catch (cause) {
      console.error("delete session failed", cause);
      window.alert(`删除失败：${cause instanceof Error ? cause.message : String(cause)}`);
      updateSessions([entry, ...loadSessions().filter((s) => s.id !== target)]);
    } finally {
      setDeleting((set) => {
        const copy = new Set(set);
        copy.delete(target);
        return copy;
      });
    }
  };
  // ==========================================================================

  // ==========================================================================
  // 分支 / Plan mode / 用量
  // ==========================================================================
  const [forking, setForking] = useState(false);
  const [sessionState, setSessionInfo] = useState<SessionState | null>(null);
  const planMode = sessionState?.planMode ?? false;

  // 载入和每轮结束时刷新状态（用量、plan mode、计划）。
  useEffect(() => {
    let cancelled = false;
    setSessionInfo(null);
    sessionsApi
      .state(current)
      .then((state) => {
        if (!cancelled) setSessionInfo(state);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.id, filesRefreshKey]);

  const branchSession = async () => {
    setForking(true);
    try {
      const title = `${sessionLabel(current)} · branch`;
      const record = await sessionsApi.fork(current, title);
      const entry = fromRecord(record);
      updateSessions([entry, ...sessions]);
      setSession(entry.id);
    } catch (cause) {
      window.alert(`分支失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setForking(false);
    }
  };

  const togglePlanMode = async (on: boolean) => {
    try {
      await sessionsApi.setPlanMode(current, on);
      setSessionInfo((state) => (state ? { ...state, planMode: on } : state));
    } catch (cause) {
      window.alert(`切换失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  /** 用户看过计划点"执行"：关 plan mode，让模型按计划做。 */
  const executePlan = async () => {
    await togglePlanMode(false);
    submitPrompt("The plan is approved. Execute it step by step, reporting after each step.", "followUp");
    scrollToBottom();
  };
  // ==========================================================================

  const empty = messages.length === 0 && !live && !running;
  const runningNames = runningTools.map((tool) => tool.name);

  // 三栏：会话 | 聊天 | 工具。前后两栏都可以收起。
  const columns = [
    sessionsOpen ? "minmax(220px,18vw)" : null,
    "minmax(480px,1fr)",
    toolsOpen ? "minmax(300px,26vw)" : null
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className="grid h-dvh overflow-hidden bg-kumo-elevated text-kumo-default"
      style={{ gridTemplateColumns: columns }}
    >
      {sessionsOpen ? (
        <SessionSidebar
          sessions={sessions}
          current={session}
          deleting={deleting}
          onSelect={setSession}
          onNew={newSession}
          onRename={renameSession}
          onDelete={(id) => void deleteSession(id)}
          onClose={() => setSessionsOpen(false)}
        />
      ) : null}

      <section className="relative flex min-h-0 min-w-0 flex-col" aria-label="Chat">
        <header className="shrink-0 border-b border-kumo-line bg-kumo-base">
          <div className="mx-auto flex h-[68px] max-w-3xl items-center justify-between gap-3 px-5">
            <div className="flex min-w-0 items-center gap-2">
              {sessionsOpen ? null : (
                <Button
                  variant="ghost"
                  shape="square"
                  aria-label="Show sessions"
                  onClick={() => setSessionsOpen(true)}
                  icon={<SidebarSimpleIcon size={16} />}
                />
              )}
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold">{sessionLabel(current)}</h1>
                <p className="truncate text-xs text-kumo-subtle">
                  {current.object.slice(0, 8)}
                  {current.branch ? ` · branch #${current.branch}` : ""}
                  {sessionState ? (
                    <span
                      className="ml-2"
                      title={`input ${sessionState.usage.input.toLocaleString()} · output ${sessionState.usage.output.toLocaleString()} · cache read ${sessionState.usage.cacheRead.toLocaleString()}`}
                    >
                      · {formatTokens(sessionState.usage.input)} in / {formatTokens(sessionState.usage.output)} out
                      {sessionState.usage.cost > 0 ? ` · $${sessionState.usage.cost.toFixed(4)}` : ""}
                    </span>
                  ) : null}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Badge variant="secondary" className="hidden sm:inline-flex">
                {MODEL.split("/").at(-1)}
              </Badge>
              {/* Plan mode 开关：开着时模型只能读和提交计划 */}
              <span title={planMode ? "Plan mode 开着：模型只读、只出计划。再点关闭。" : "打开 Plan mode：先让模型出计划，你确认后再执行。"}>
                <Button
                  variant={planMode ? "primary" : "ghost"}
                  size="sm"
                  aria-pressed={planMode}
                  disabled={!connected || running}
                  onClick={() => void togglePlanMode(!planMode)}
                  icon={<ListChecksIcon size={14} />}
                >
                  Plan
                </Button>
              </span>
              {/* 分支：从当前会话 fork 一个新会话，共享到现在为止的历史 */}
              <span title="从这里分支：新会话看得到到现在为止的全部对话，之后各走各的。工作区共享。">
                <Button
                  variant="ghost"
                  shape="square"
                  aria-label="Branch from here"
                  disabled={!connected || running || forking}
                  onClick={() => void branchSession()}
                  icon={<GitForkIcon size={16} />}
                />
              </span>
              <Badge variant={connected ? "success" : "secondary"}>
                {connected
                  ? "Live"
                  : status === "connecting"
                    ? "Connecting"
                    : "Reconnecting"}
              </Badge>
              <Button
                variant="ghost"
                shape="square"
                aria-label="Tools"
                aria-expanded={toolsOpen}
                onClick={() => setToolsOpen((open) => !open)}
                icon={<WrenchIcon size={16} />}
              />
              <ModeToggle />
            </div>
          </div>
        </header>

        <main
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto max-w-3xl space-y-5 px-5 py-6">
            {empty ? (
              <div className="py-10 sm:py-16">
                <Empty
                  icon={<BrainIcon size={32} />}
                  title="Ask Pi something that needs a tool"
                  description="Tool calls and results stream in as they happen."
                />
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <Button
                      key={suggestion.label}
                      variant="secondary"
                      size="sm"
                      icon={suggestion.icon}
                      disabled={!connected}
                      onClick={() => setPrompt(suggestion.value)}
                    >
                      {suggestion.label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            {messages.map((message) => (
              <Message
                key={message.id}
                message={message}
                runningTools={runningTools}
              />
            ))}

            {live ? (
              <Message message={live} streaming runningTools={runningTools} />
            ) : null}

            {running && !live ? (
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-white">
                  <BrainIcon size={17} weight="bold" />
                </div>
                <Surface className="rounded-xl px-4 py-3 ring ring-kumo-line">
                  <div className="flex items-center gap-2 text-sm text-kumo-subtle">
                    <GearIcon size={15} className="animate-spin" />
                    {retry
                      ? `Retrying: ${retry.error}`
                      : runningNames.length > 0
                        ? `Running ${runningNames.join(", ")}`
                        : "Waiting for the model"}
                  </div>
                </Surface>
              </div>
            ) : null}

            {/* 运行中工具的流式输出。subagent 的输出已经画在它自己的卡片里。 */}
            {runningTools.map((tool) =>
              tool.output && !CHILD_TOOLS.has(tool.name) ? (
                <pre
                  key={tool.callId}
                  className="ml-11 max-h-40 overflow-auto rounded-lg bg-kumo-elevated p-2.5 text-xs"
                >
                  {tool.output}
                </pre>
              ) : null
            )}

            {queued > 0 ? (
              <p className="ml-11 text-xs text-kumo-subtle">
                {queued} queued behind this run
              </p>
            ) : null}

            {error ? (
              <div
                role="alert"
                className="rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
              >
                {error}
              </div>
            ) : null}
          </div>
        </main>

        {/* 翻上去看历史时出现：点一下回到底部并重新跟随。 */}
        {!stuck ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-[132px] flex justify-center">
            <Button
              variant="secondary"
              size="sm"
              className="pointer-events-auto shadow-md"
              icon={<ArrowDownIcon size={14} />}
              onClick={() => scrollToBottom()}
            >
              {running ? "Follow" : "Latest"}
            </Button>
          </div>
        ) : null}

        {/* Plan mode 下模型提交了计划：列出来，让用户决定执行还是改。 */}
        {planMode && sessionState && sessionState.plan.length > 0 && !running ? (
          <div className="shrink-0 border-t border-kumo-line bg-kumo-base">
            <div className="mx-auto max-w-3xl px-5 pt-4">
              <Surface className="rounded-xl p-4 ring ring-kumo-line">
                <div className="mb-2 flex items-center gap-2">
                  <ListChecksIcon size={16} className="text-kumo-accent" />
                  <Text size="sm" bold>
                    Plan ({sessionState.plan.length} steps)
                  </Text>
                </div>
                <ol className="list-decimal space-y-1 pl-5 text-sm leading-6">
                  {sessionState.plan.map((step, index) => (
                    <li key={index}>{step}</li>
                  ))}
                </ol>
                <div className="mt-3 flex gap-2">
                  <Button variant="primary" size="sm" disabled={!connected} onClick={() => void executePlan()}>
                    Execute plan
                  </Button>
                  <span className="self-center text-xs text-kumo-subtle">
                    或在下面输入修改意见，模型会重新出计划。
                  </span>
                </div>
              </Surface>
            </div>
          </div>
        ) : null}

        <div className="shrink-0 border-t border-kumo-line bg-kumo-base">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            className="mx-auto max-w-3xl px-5 pt-4"
          >
            <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm transition-shadow focus-within:border-transparent focus-within:ring-2 focus-within:ring-kumo-ring">
              <InputArea
                value={prompt}
                onValueChange={setPrompt}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder={
                  running
                    ? "Enter: queue for after this turn · Steer: interrupt it now"
                    : "Ask Pi to use a tool"
                }
                aria-label="Message Pi"
                disabled={!connected}
                rows={2}
                className="flex-1 !bg-transparent !shadow-none !ring-0 !outline-none focus:!ring-0"
              />
              {running ? (
                <div className="mb-0.5 flex gap-1.5">
                  {/* title 就是悬停提示：说明 Steer 和 Enter 的区别 */}
                  <span
                    title={
                      "Steer: 插进当前这一轮。模型下一次调完工具回来就会看到，可以中途改方向。\n" +
                      "Enter: 排队。等这一轮完全结束后，作为下一条消息处理。"
                    }
                  >
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      aria-label="Steer: interrupt the running turn with this message"
                      disabled={prompt.trim() === ""}
                      onClick={() => submit("steer")}
                    >
                      Steer
                    </Button>
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    shape="square"
                    aria-label="Stop"
                    onClick={abort}
                    icon={<StopIcon size={18} weight="fill" />}
                  />
                </div>
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  shape="square"
                  aria-label="Send message"
                  disabled={!connected || prompt.trim() === ""}
                  icon={<PaperPlaneRightIcon size={18} />}
                  className="mb-0.5"
                />
              )}
            </div>
          </form>
          <div className="flex items-center justify-center gap-2 px-5 py-3">
            <span className="hidden text-[10px] text-kumo-inactive sm:inline">
              Enter to send · Shift+Enter for a new line
            </span>
            <span className="hidden text-kumo-line sm:inline">·</span>
            <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
          </div>
        </div>
      </section>

      {toolsOpen ? (
        <Sidebar
          session={current.object}
          tools={catalog}
          activeTools={runningNames}
          filesRefreshKey={filesRefreshKey}
          onClose={() => setToolsOpen(false)}
        />
      ) : null}
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
