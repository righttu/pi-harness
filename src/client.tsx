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
  BrainIcon,
  CheckCircleIcon,
  CodeIcon,
  FilePlusIcon,
  GearIcon,
  GitBranchIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  StopIcon,
  SunIcon,
  TrashIcon,
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
// 以前 localStorage 只存一个当前 UUID（SESSION_KEY），点 + 就把它覆盖掉，
// 旧会话的 DO 还在，但浏览器找不回去了。
// 现在改为：
//   - SESSIONS_KEY 存一个数组 [{ id, createdAt }]，是你所有会话的目录；
//   - SESSION_KEY 仍然存"当前选中的那个"，保持和旧版本兼容；
//   - 第一次升级时，把旧的单个 UUID 自动迁移进列表。
// ============================================================================

const SESSIONS_KEY = "pi-harness-sessions";

type SessionEntry = { id: string; createdAt: number };

/** 读取会话目录；不存在或损坏则返回空数组。 */
function loadSessions(): SessionEntry[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is SessionEntry =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as SessionEntry).id === "string" &&
        typeof (s as SessionEntry).createdAt === "number"
    );
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
    sessions = [{ id: legacy, createdAt: Date.now() }, ...sessions];
  }
  if (sessions.length === 0) {
    sessions = [{ id: crypto.randomUUID(), createdAt: Date.now() }];
  }
  saveSessions(sessions);
  const current =
    legacy && sessions.some((s) => s.id === legacy) ? legacy : sessions[0].id;
  localStorage.setItem(SESSION_KEY, current);
  return { current, sessions };
}

/** 列表里显示的名字：UUID 前 8 位 + 创建时间。 */
function sessionLabel(entry: SessionEntry): string {
  const when = new Date(entry.createdAt);
  const time = `${when.getMonth() + 1}/${when.getDate()} ${String(
    when.getHours()
  ).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  return `${entry.id.slice(0, 8)} · ${time}`;
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

/** 子对话过程里的一条步骤。 */
function StepItem({
  label,
  done,
  active
}: {
  label: string;
  done?: boolean;
  active?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      {done ? (
        <CheckCircleIcon size={12} className="shrink-0 text-kumo-success" />
      ) : active ? (
        <GearIcon size={12} className="shrink-0 animate-spin text-kumo-accent" />
      ) : (
        <div className="size-3 shrink-0 rounded-full border border-kumo-inactive" />
      )}
      <span
        className={`text-xs ${
          done
            ? "text-kumo-subtle line-through"
            : active
              ? "text-kumo-default font-medium"
              : "text-kumo-inactive"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

/** 子对话调用时展示的卡片（运行中）。 */
function SubagentCallCard({
  part,
  running
}: {
  part: Extract<TranscriptPart, { type: "tool-call" }>;
  running: boolean;
}) {
  const task =
    (part.arguments as { task?: string } | undefined)?.task ?? "Unknown task";
  return (
    <details className="rounded-xl border border-kumo-line bg-kumo-base" open={running}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        {running ? (
          <GearIcon size={14} className="animate-spin text-kumo-accent" />
        ) : (
          <CheckCircleIcon size={14} className="text-kumo-success" />
        )}
        <GitBranchIcon size={14} className="text-kumo-subtle" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          Subagent
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
          <p className="whitespace-pre-wrap text-xs text-kumo-default">
            {task}
          </p>
        </div>
        {running && (
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
              Progress
            </p>
            <div className="space-y-1.5">
              <StepItem done label="Create sub-conversation" />
              <StepItem done label="Submit task" />
              <StepItem active label="Processing in sub-conversation…" />
            </div>
          </div>
        )}
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
    | { conversationId?: string; task?: string; status?: string }
    | undefined;
  const task = details?.task ?? "Unknown task";
  const conversationId = details?.conversationId;

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
          <span className="font-semibold">Subagent</span>
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
              Result
            </p>
            <div className="rounded-lg bg-kumo-elevated p-2.5 text-xs leading-5 whitespace-pre-wrap">
              {text}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

function ToolCallCard({
  part,
  running
}: {
  part: Extract<TranscriptPart, { type: "tool-call" }>;
  running: boolean;
}) {
  if (part.name === "subagent") {
    return <SubagentCallCard part={part} running={running} />;
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
  if (part.name === "subagent") {
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
  running: boolean;
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
      return <ToolCallCard part={part} running={running} />;
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

function UserMessage({ message }: { message: TranscriptMessage }) {
  const text = message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
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
  runningTools: readonly string[];
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
            running={
              streaming &&
              part.type === "tool-call" &&
              runningTools.includes(part.name)
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
  runningTools: readonly string[];
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

function Sidebar({
  tools,
  activeTools,
  onClose
}: {
  tools: readonly ToolInfo[];
  activeTools: readonly string[];
  onClose: () => void;
}) {
  return (
    <aside
      className="flex min-h-0 flex-col border-l border-kumo-line bg-kumo-base"
      aria-label="Tools"
    >
      <div className="flex h-[68px] shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4">
        <Text size="sm" bold>
          Tools
        </Text>
        <Button
          variant="ghost"
          shape="square"
          aria-label="Close tools"
          onClick={onClose}
          icon={<XIcon size={16} />}
        />
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {tools.map((tool) => (
          <Surface
            key={tool.name}
            className="rounded-lg p-3 ring ring-kumo-line"
          >
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
    </aside>
  );
}

function App() {
  // ==========================================================================
  // 会话状态：当前会话 id + 会话目录。两者都同步写回 localStorage。
  // ==========================================================================
  const [initial] = useState(initSessions);
  const [session, setSessionState] = useState(initial.current);
  const [sessions, setSessions] = useState<SessionEntry[]>(initial.sessions);
  const [deleting, setDeleting] = useState(false);

  /** 切换当前会话（也会记进 localStorage，刷新后还是它）。 */
  const setSession = (id: string) => {
    localStorage.setItem(SESSION_KEY, id);
    setSessionState(id);
  };
  // ==========================================================================

  const [prompt, setPrompt] = useState("");
  const [toolsOpen, setToolsOpen] = useState(
    () => window.matchMedia("(min-width: 1100px)").matches
  );
  const endRef = useRef<HTMLDivElement>(null);
  const {
    status,
    messages,
    live,
    running,
    tools: running_,
    catalog,
    queued,
    retry,
    error,
    submit: submitPrompt,
    abort
  } = usePiSession(session);
  const runningTools = running_.map((tool) => tool.name);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, live, running]);

  const connected = status === "open";

  /** While a run is going, Enter queues a follow-up and Steer joins the run. */
  const submit = (whenBusy: "followUp" | "steer" = "followUp") => {
    const text = prompt.trim();
    if (!text || !connected) return;
    setPrompt("");
    submitPrompt(text, whenBusy);
  };

  // ==========================================================================
  // 新建 / 删除会话
  // ==========================================================================

  /** 新建：生成一个新 UUID，加进目录顶部，并切换过去。旧会话保留。 */
  const newSession = () => {
    const entry: SessionEntry = { id: crypto.randomUUID(), createdAt: Date.now() };
    const next = [entry, ...sessions];
    setSessions(next);
    saveSessions(next);
    setSession(entry.id);
  };

  /**
   * 删除当前会话：
   *   1. 先切到另一个会话（没有就新建一个），让 WebSocket 不再连着要删的 DO；
   *   2. 从目录里移除；
   *   3. 调 DELETE /api/session/<id>，服务端把那个 DO 的数据全部删掉。
   */
  const deleteSession = async () => {
    const target = session;
    if (!window.confirm(`删除会话 ${target.slice(0, 8)}？对话记录和工作区文件会一起删除，不可恢复。`)) {
      return;
    }
    setDeleting(true);
    try {
      const remaining = sessions.filter((s) => s.id !== target);
      let next = remaining;
      if (next.length === 0) {
        next = [{ id: crypto.randomUUID(), createdAt: Date.now() }];
      }
      setSessions(next);
      saveSessions(next);
      setSession(next[0].id);
      const response = await fetch(`/api/session/${target}`, { method: "DELETE" });
      if (!response.ok) {
        console.error("delete session failed", response.status, await response.text());
      }
    } finally {
      setDeleting(false);
    }
  };
  // ==========================================================================

  const empty = messages.length === 0 && !live && !running;

  return (
    <div
      className={`grid h-dvh overflow-hidden bg-kumo-elevated text-kumo-default ${
        toolsOpen
          ? "lg:grid-cols-[minmax(520px,1fr)_minmax(300px,26vw)]"
          : "grid-cols-1"
      }`}
    >
      <section className="flex min-h-0 min-w-0 flex-col" aria-label="Chat">
        <header className="shrink-0 border-b border-kumo-line bg-kumo-base">
          <div className="mx-auto flex h-[68px] max-w-3xl items-center justify-between gap-3 px-5">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-kumo-brand text-white">
                <BrainIcon size={20} weight="bold" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold">Pi harness</h1>
                {/* ============================================================
                    会话选择器：下拉列出所有会话，选中即切换。
                    ============================================================ */}
                <select
                  aria-label="Switch session"
                  value={session}
                  onChange={(event) => setSession(event.target.value)}
                  className="max-w-[220px] truncate rounded border border-kumo-line bg-kumo-base px-1.5 py-0.5 text-xs text-kumo-subtle"
                >
                  {sessions.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {sessionLabel(entry)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Badge variant="secondary" className="hidden sm:inline-flex">
                {MODEL.split("/").at(-1)}
              </Badge>
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
              <Button
                variant="ghost"
                shape="square"
                aria-label="New session"
                onClick={newSession}
                icon={<PlusIcon size={16} />}
              />
              {/* 删除当前会话（连同服务端数据） */}
              <Button
                variant="ghost"
                shape="square"
                aria-label="Delete session"
                disabled={deleting}
                onClick={deleteSession}
                icon={<TrashIcon size={16} />}
              />
              <ModeToggle />
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
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
                      : runningTools.length > 0
                        ? `Running ${runningTools.join(", ")}`
                        : "Waiting for the model"}
                  </div>
                </Surface>
              </div>
            ) : null}

            {running_.map((tool) =>
              tool.output ? (
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

            <div ref={endRef} />
          </div>
        </main>

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
                    ? "Queue a follow-up, or steer the running turn"
                    : "Ask Pi to use a tool"
                }
                aria-label="Message Pi"
                disabled={!connected}
                rows={2}
                className="flex-1 !bg-transparent !shadow-none !ring-0 !outline-none focus:!ring-0"
              />
              {running ? (
                <div className="mb-0.5 flex gap-1.5">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label="Steer"
                    disabled={prompt.trim() === ""}
                    onClick={() => submit("steer")}
                  >
                    Steer
                  </Button>
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
          tools={catalog}
          activeTools={runningTools}
          onClose={() => setToolsOpen(false)}
        />
      ) : null}
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
