import { DurableObject } from "cloudflare:workers";
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createGitClient } from "@cloudflare/computer/git";
import { createGitModule } from "@cloudflare/computer/modules/git";
import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { routeAgentRequest } from "agents";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { PiSessionIndex } from "./sessions";
import { PiSessionSockets } from "./sockets";
import { Subagent } from "./subagent";
import { SubagentsExtension } from "./subagents";
import { createWorkspaceTools, JAVASCRIPT_BACKEND } from "./workspace";

export { PiSessionIndex };

// AI Gateway 的名字和动态路由的名字。换模型只改路由配置，不改这里。
const GATEWAY_ID = "pi-gateway";
const MODEL_ID = "dynamic/pi-route";
const PROVIDER_ID = "aigw";
/**
 * 路由背后模型的上下文窗口。这是 compaction 的分母：上下文超过
 * contextWindow - reserveTokens 就压缩。路由换成小窗口模型要改这里，
 * 否则压缩来不及触发就会 context overflow。
 */
const CONTEXT_WINDOW = 128_000;

/** Worker 变量（Dashboard → Settings → Variables and Secrets）。 */
type GatewayEnv = { CF_ACCOUNT_ID: string; CF_AIG_TOKEN: string };

/** 文件面板的一行。 */
export type FileEntry = {
  name: string;
  path: string;
  size: number;
  mtime: number;
  kind: "dir" | "file" | "link";
};

/** 文件预览/下载最多取这么多字节；再大的文件让模型用 exec 处理。 */
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

/** 只允许 /workspace 下的绝对路径，去掉 .. 和重复的斜杠。 */
function normalizeWorkspacePath(input: string): string {
  const parts: string[] = [];
  for (const part of input.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const path = `/${parts.join("/")}`;
  if (path !== "/workspace" && !path.startsWith("/workspace/")) {
    throw new Error(`Path must be inside /workspace: ${input}`);
  }
  return path;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 会话目录属于谁。接了 Cloudflare Access 后这个头是登录邮箱；没接就是
 * "public"，所有人共用一个目录。
 */
function ownerOf(request: Request): string {
  return request.headers.get("cf-access-authenticated-user-email") ?? "public";
}

/** 按扩展名猜 content-type，给文件预览和下载用。 */
function contentTypeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const types: Record<string, string> = {
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    json: "application/json; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    ts: "text/plain; charset=utf-8",
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf"
  };
  return types[ext] ?? "application/octet-stream";
}

// ============================================================================
// 系统提示。前半段说有什么；后半段是工作方式约束——模型（尤其是 Qwen 这类）
// 不会自己遵守这些隐含规范，写明了才稳定。
// ============================================================================
const PREAMBLE = `You are a concise playground assistant. You have a durable workspace at /workspace: read, write, edit, delete, list (ls), find and grep files there, and run JavaScript modules in it with exec, which can also use git. Paths are absolute. Use tools whenever they can answer the request, and explain their results plainly.

How to work:
- Look before you act: ls or find the relevant directory before guessing paths.
- Never overwrite a file you have not read in this conversation. Prefer edit over write for existing files.
- Large files: read them in parts with offset/limit, or grep for what you need. Do not read whole logs or data dumps.
- For tasks with several steps, say what you are going to do, then report briefly after each step completes, so progress is visible if the task is long.
- When a step fails, say what failed and what you are trying next; do not silently retry the same thing.
- Use subagent for one self-contained piece of work you need before continuing. Use subagents to run several independent pieces in parallel while you keep working; their answers arrive as later messages.
- Finish with a short summary of what changed, with file paths.`;

/** Playable pi session backed by one Durable Object. */
export class PiAgent extends DurableObject<Env> {
  // A durable filesystem on the object's SQLite, beside pi's own tables.
  // `exec` runs JavaScript modules in a fresh Dynamic Worker per call, with
  // no network of its own. `git` turns on `workspace.git`, which the `ws:git`
  // module calls in the host; `allowNetwork` lets it clone, fetch and push.
  readonly workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    git: createGitClient(),
    backends: [
      new WorkerJavaScriptBackend({
        id: JAVASCRIPT_BACKEND,
        loader: this.env.LOADER,
        root: "/workspace",
        access: "read-write",
        modules: { "ws:git": createGitModule({ allowNetwork: true }) }
      })
    ]
  });
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      // pi's own extension: the system prompt and the workspace tools.
      this.registry.install({
        name: "playground",
        sections: [{ key: "preamble", render: () => PREAMBLE, tag: false }],
        tools: createWorkspaceTools(this.workspace, {
          // ==============================================================
          // 工具输出上限。read 默认 256 KiB ≈ 6 万 token，一次就占掉半个
          // 上下文窗口；收到 48 KiB，超出的部分提示模型用 offset/limit 分段
          // 或 grep。exec 的 stdout 同理。
          // ==============================================================
          read: { maxBytes: 48 * 1024, maxLines: 1200 },
          execOutput: { maxBytes: 32 * 1024, maxLines: 800 }
        })
      });
      // ======================================================================
      // 两种子代理，都单独作为扩展安装（不合并进 playground），这样子对话
      // 可以只移除它们、保留工作区工具。
      //   Subagent（src/subagent.ts）：前台，阻塞，直接返回答案。
      //   SubagentsExtension（src/subagents.ts）：后台，并行，答案稍后作为
      //   新消息送回。
      // ======================================================================
      this.registry.install(Subagent);
      this.registry.install(SubagentsExtension);
      // 不走 Workers AI binding，而是用 OpenAI 兼容协议直接打 AI Gateway 的
      // /compat 入口（和 Brain 一样）。这个入口支持 Workers AI、内置供应商和
      // custom provider，所以路由节点换什么模型这里都不用改。
      const { CF_ACCOUNT_ID, CF_AIG_TOKEN } = this.env as unknown as GatewayEnv;
      const baseUrl = `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${GATEWAY_ID}/compat`;
      const routeModel: Model<"openai-completions"> = {
        id: MODEL_ID,
        name: "AI Gateway dynamic route",
        api: "openai-completions",
        provider: PROVIDER_ID,
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: CONTEXT_WINDOW,
        maxTokens: 8192,
        headers: { "cf-aig-authorization": `Bearer ${CF_AIG_TOKEN}` },
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }
      };
      const gateway = createProvider({
        id: PROVIDER_ID,
        name: "Cloudflare AI Gateway",
        baseUrl,
        auth: {
          apiKey: {
            name: "AI Gateway token",
            resolve: async () => ({ auth: { apiKey: CF_AIG_TOKEN } })
          }
        },
        models: [routeModel],
        api: openAICompletionsApi()
      });
      const models = createModels();
      models.setProvider(gateway);
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          onWake,
          settings: {
            // pi doubles the delay before each retry: 1, 2, 4, 8 and 16 seconds,
            // so a rate-limited model gets about 30 seconds to recover.
            retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 },
            // ==============================================================
            // 上下文压缩。pi 默认就开着，这里写明数值便于调整：
            //   - 上下文超过 contextWindow - reserveTokens（128k - 16k = 112k）
            //     时，下一次请求前先阻塞压缩：把早期对话总结成一段摘要，
            //     最近 keepRecentTokens 保持原样。
            //   - 超过 112k - backgroundTokens = 80k 时，就先在后台开始
            //     压缩，不打断当前轮；摘要在轮次边界落地。
            //   - 工具结果多的会话（read 大文件、长 exec 输出）最容易触发。
            // 换小窗口模型用 modelOverrides 单独给它一套数值。
            // ==============================================================
            compaction: {
              enabled: true,
              reserveTokens: 16_384,
              keepRecentTokens: 24_000,
              backgroundTokens: 32_768
            },
            // 工具并行执行：模型一轮发出多个独立工具调用时同时跑。
            toolExecution: "parallel"
          },
          onReport: (error) => console.warn("pi report", error)
        },
        context
      );
    },
    defaults: { model: { provider: PROVIDER_ID, id: MODEL_ID } }
  });

  // App glue, not the harness: how this app puts sessions on a socket.
  readonly sockets = new PiSessionSockets(this.harness, this.registry, (tag) =>
    this.ctx.getWebSockets(tag)
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  /** Host startup, after the harness has opened pi. */
  async onStart(): Promise<void> {
    await this.sockets.reattach();
  }

  // ==========================================================================
  // 删除会话：把这个 Durable Object 的所有数据彻底清掉。
  // 由 Worker 的 `DELETE /api/session/<id>` 通过 RPC 调用。
  // 顺序：
  //   1. 关掉连着的 WebSocket，前端会收到 close；
  //   2. lifecycle.dispose()：关闭 Pi 等在内存里的资源；
  //   3. lifecycle.disableAlarms()：清掉 Alarm，否则它还会把对象叫醒；
  //   4. storage.deleteAll()：删掉 SQLite 里的全部数据（Pi 的对话、任务、
  //      工作区文件、Lifecycle 的 job 表）；
  //   5. 稍后 ctx.abort()：把这个已经"掏空"的内存实例也干掉，下次同名
  //      访问会从零开始构造一个全新的对象。
  // 官方说明：Lifecycle 文档 "Explicit disposal" 一节。
  // ==========================================================================
  // ==========================================================================
  // 文件面板用的两个 RPC。只读；写文件仍然只有模型（通过工具）能做。
  // ==========================================================================

  /** 列目录。路径必须在 /workspace 下。 */
  async listFiles(path: string): Promise<FileEntry[]> {
    const dir = normalizeWorkspacePath(path);
    const entries = await this.workspace.fs.readdir(dir, { limit: 1000 });
    return entries
      .map((entry) => ({
        name: entry.name,
        path: dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`,
        size: entry.size,
        mtime: entry.mtime,
        kind: entry.isDirectory
          ? ("dir" as const)
          : entry.isSymbolicLink
            ? ("link" as const)
            : ("file" as const)
      }))
      .sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1
      );
  }

  /** 读文件的前 maxBytes 字节。返回 bytes 让 Worker 决定 content-type。 */
  async readFile(
    path: string,
    maxBytes = MAX_PREVIEW_BYTES
  ): Promise<{ data: Uint8Array; size: number; truncated: boolean }> {
    const file = normalizeWorkspacePath(path);
    const stat = await this.workspace.fs.stat(file);
    if (!stat.isFile) throw new Error(`Not a file: ${file}`);
    const stream = await this.workspace.fs.readFile(file, {
      byteOffset: 0,
      byteLength: Math.min(stat.size, maxBytes)
    });
    const data = new Uint8Array(await new Response(stream).arrayBuffer());
    return { data, size: stat.size, truncated: stat.size > data.byteLength };
  }

  async destroy(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(1000, "session deleted");
      } catch {
        // 已经关了就算了
      }
    }
    await this.lifecycle.dispose();
    await this.lifecycle.disableAlarms();
    await this.ctx.storage.deleteAll();
    // 先让 RPC 正常返回，再重置实例；abort 会让当前调用抛错，所以不能同步调。
    setTimeout(() => this.ctx.abort("session deleted"), 50);
  }
}

// ============================================================================
// REST 路由（WebSocket 之外的部分）。
//
//   GET    /api/sessions                 当前用户的会话目录
//   POST   /api/sessions                 登记一个会话 { id?, title?, createdAt? }
//   PATCH  /api/sessions/<uuid>          改名 { title }
//   DELETE /api/session/<uuid>           删除会话：清掉 PiAgent 的全部数据，
//                                        并从目录移除
//   GET    /api/session/<uuid>/files?path=/workspace[/sub]      列目录
//   GET    /api/session/<uuid>/file?path=/workspace/x[&download=1]  读文件
//
// 返回 undefined 表示不归这里管，交给 routeAgentRequest。
// ============================================================================
async function handleApi(
  request: Request,
  url: URL,
  env: Env
): Promise<Response | undefined> {
  const { method } = request;
  const index = () => env.PiSessionIndex.getByName(ownerOf(request));

  if (url.pathname === "/api/sessions") {
    if (method === "GET") return Response.json(await index().list());
    if (method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        id?: string;
        title?: string | null;
        createdAt?: number;
      };
      const id = body.id ?? crypto.randomUUID();
      if (!UUID.test(id)) return Response.json({ error: "Bad id" }, { status: 400 });
      return Response.json(
        await index().upsert({
          id,
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(typeof body.createdAt === "number" ? { createdAt: body.createdAt } : {})
        })
      );
    }
    return new Response("Method not allowed", { status: 405 });
  }

  const renaming = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (renaming && method === "PATCH") {
    const id = renaming[1];
    if (!UUID.test(id)) return Response.json({ error: "Bad id" }, { status: 400 });
    const body = (await request.json().catch(() => ({}))) as { title?: string };
    const record = await index().rename(id, body.title ?? "");
    return record
      ? Response.json(record)
      : Response.json({ error: "Not found" }, { status: 404 });
  }

  const session = url.pathname.match(/^\/api\/session\/([^/]+)(\/files|\/file)?$/);
  if (!session) return undefined;
  const id = session[1];
  // 只接受 UUID 格式，避免拿任意字符串去当 DO 名字。
  if (!UUID.test(id)) return Response.json({ error: "Bad id" }, { status: 400 });
  const agent = env.PiAgent.getByName(id);

  if (session[2] === undefined && method === "DELETE") {
    await agent.destroy();
    await index().remove(id);
    return Response.json({ deleted: id });
  }
  if (session[2] === "/files" && method === "GET") {
    const path = url.searchParams.get("path") ?? "/workspace";
    return Response.json(await agent.listFiles(path));
  }
  if (session[2] === "/file" && method === "GET") {
    const path = url.searchParams.get("path");
    if (!path) return Response.json({ error: "path required" }, { status: 400 });
    const { data, size, truncated } = await agent.readFile(path);
    const name = path.slice(path.lastIndexOf("/") + 1);
    const headers = new Headers({
      "content-type": contentTypeOf(path),
      "x-file-size": String(size),
      "x-file-truncated": String(truncated),
      "cache-control": "no-store"
    });
    if (url.searchParams.get("download") === "1") {
      headers.set(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
      );
    }
    return new Response(data.buffer as ArrayBuffer, { headers });
  }
  return undefined;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/session") {
      // A fresh session id for the client to open its WebSocket against.
      return Response.json({ session: crypto.randomUUID() });
    }
    try {
      const api = await handleApi(request, url, env);
      if (api) return api;
    } catch (error) {
      console.error("Pi playground API failed", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 }
      );
    }
    try {
      return (
        (await routeAgentRequest(request, env, { cors: true })) ??
        new Response("Not found", { status: 404 })
      );
    } catch (error) {
      console.error("Pi playground request failed", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
} satisfies ExportedHandler<Env>;
