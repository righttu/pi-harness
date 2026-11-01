import { DurableObject } from "cloudflare:workers";
import { R2Bucket, Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createGitClient } from "@cloudflare/computer/git";
import { createGitModule } from "@cloudflare/computer/modules/git";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  UsageDoc,
  type Extension,
  type ToolRegistration
} from "@earendil-works/pi-durable";
import { routeAgentRequest } from "agents";
import { PiHarness, ROOT_SESSION } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { createFetchTool, parseAllowList } from "./fetch-tool";
import { createPublish, publishFile, verifyShare, type PublishDeps } from "./publish";
import { PiSessionIndex, splitSessionId } from "./sessions";
import {
  effectiveSettings,
  PiSettings,
  SETTABLE,
  SETTINGS,
  SETTINGS_NAME,
  type SettingsMap
} from "./settings";
import { PiSessionSockets } from "./sockets";
import {
  createReview,
  enterPlanMode,
  leavePlanMode,
  Plan,
  PlanDoc,
  ReviewerRole
} from "./quality";
import { createSubagent } from "./subagent";
import { createSubagents } from "./subagents";
import { createWorkspaceTools, JAVASCRIPT_BACKEND } from "./workspace";

export { PiSessionIndex, PiSettings };

// AI Gateway 的名字和动态路由的名字。换模型只改路由配置，不改这里。
const GATEWAY_ID = "pi-gateway";
const MODEL_ID = "dynamic/pi-route";
const PROVIDER_ID = "aigw";
/**
 * 路由背后模型的上下文窗口默认值（变量 PI_CONTEXT_WINDOW 覆盖）。这是
 * compaction 的分母：上下文超过 contextWindow - reserveTokens 就压缩。路由
 * 换成小窗口模型要改，否则压缩来不及触发就会 context overflow。
 */
const CONTEXT_WINDOW = 128_000;
/** /workspace/r2 只读挂载最多从桶里复制这么多字节。 */
const R2_MOUNT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Dashboard 里只设这三样（Settings → Variables and Secrets）：
 *   CF_ACCOUNT_ID    账号 id（Text）。必填。
 *   CF_AIG_TOKEN     AI Gateway token（Secret）。必填。
 *   PI_SHARE_SECRET  可选（Secret）。分享链接的签名密钥；不设用 CF_AIG_TOKEN。
 *                    单独设的好处：换 AIG token 时旧分享链接不失效。
 *
 * 其余 PI_* 配置在右栏 Config 页改，定义和默认值见 src/settings.ts 的 SETTINGS。
 * 合并后的生效配置是 GatewayEnv（PiAgent.#config）。
 */
type GatewayEnv = {
  CF_ACCOUNT_ID: string;
  CF_AIG_TOKEN: string;
  PI_SHARE_SECRET?: string;
  PI_MODEL_INPUT?: string;
  PI_CONTEXT_WINDOW?: string;
  PI_MAX_TOKENS?: string;
  PI_MODEL_REASONING?: string;
  PI_SIDE_ROUTE?: string;
  PI_PRICE_INPUT?: string;
  PI_PRICE_OUTPUT?: string;
  PI_FETCH_ALLOW?: string;
  PI_PUBLIC_URL?: string;
};

/** 密钥 + 应用内设置（含默认值）→ 生效配置。Dashboard 里的 PI_* 变量不参与。 */
export function resolveConfig(env: Env, saved: SettingsMap): GatewayEnv {
  const infra = env as unknown as Pick<GatewayEnv, "CF_ACCOUNT_ID" | "CF_AIG_TOKEN" | "PI_SHARE_SECRET">;
  return {
    CF_ACCOUNT_ID: infra.CF_ACCOUNT_ID,
    CF_AIG_TOKEN: infra.CF_AIG_TOKEN,
    ...(infra.PI_SHARE_SECRET ? { PI_SHARE_SECRET: infra.PI_SHARE_SECRET } : {}),
    ...effectiveSettings(saved)
  } as GatewayEnv;
}

/** Config 页的一行：定义 + 当前值。 */
export type ConfigItem = (typeof SETTINGS)[number] & {
  /** 当前生效的值。 */
  value: string;
  /** 用的是默认值，还是应用内改过。 */
  isDefault: boolean;
};

export function describeConfig(saved: SettingsMap): ConfigItem[] {
  const effective = effectiveSettings(saved);
  return SETTINGS.map((def) => ({
    ...def,
    value: effective[def.name],
    isDefault: saved[def.name] === undefined
  }));
}

/** 从变量读出来的模型能力。 */
function modelProfile(env: GatewayEnv) {
  const input = (env.PI_MODEL_INPUT ?? "text")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is "text" | "image" => s === "text" || s === "image");
  return {
    input: input.length === 0 ? (["text"] as const) : input,
    vision: input.includes("image"),
    contextWindow: Number(env.PI_CONTEXT_WINDOW) || CONTEXT_WINDOW,
    maxTokens: Number(env.PI_MAX_TOKENS) || 8192,
    reasoning: env.PI_MODEL_REASONING === "true"
  };
}

/** 分享链接签名密钥。 */
function shareSecret(env: GatewayEnv): string {
  return env.PI_SHARE_SECRET || env.CF_AIG_TOKEN;
}

/** 一个会话（pi session）的状态，GET /api/session/<id>/state 返回。 */
export type SessionState = {
  planMode: boolean;
  plan: string[];
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    /** 美元；没配价格时为 0。 */
    cost: number;
  };
};

/** 文件面板的一行。 */
export type FileEntry = {
  name: string;
  path: string;
  size: number;
  mtime: number;
  kind: "dir" | "file" | "link";
};

/** 浏览器里内联预览最多取这么多字节（整个文件下载不受此限）。 */
const PREVIEW_BYTES = 2 * 1024 * 1024;

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
/** 目录项 id：UUID，或 "UUID:<pi session id>"（分支）。 */
const SESSION_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::([1-9][0-9]{0,15}))?$/i;
/** 单个工作区文件的上限。工作区整体受 DO 存储上限约束（付费 10 GB），这里
 * 只是防呆：真正的大文件应该走 R2（publish）。 */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

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
const PREAMBLE = `You are a concise playground assistant. You have a durable workspace at /workspace: read, write, edit, delete, list (ls), find and grep files there, and run JavaScript modules in it with exec, which can also use git. You can reach the web with fetch (save large or binary responses to a file with savePath). Paths are absolute. Use tools whenever they can answer the request, and explain their results plainly.

How to work:
- Look before you act: ls or find the relevant directory before guessing paths.
- Never overwrite a file you have not read in this conversation. Prefer edit over write for existing files.
- Large files: read them in parts with offset/limit, or grep for what you need. Do not read whole logs or data dumps.
- For tasks with several steps, say what you are going to do, then report briefly after each step completes, so progress is visible if the task is long.
- When a step fails, say what failed and what you are trying next; do not silently retry the same thing.
- Use subagent for one self-contained piece of work you need before continuing. Use subagents to run several independent pieces in parallel while you keep working; their answers arrive as later messages.
- After writing or changing code, call review with a summary and the file paths before you report it as done. Fix what it finds, then say what the review found and what you fixed.
- When the result is a file the user wants (a document, slides, an archive, an image), publish it and give the link instead of pasting its contents.
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
    // ======================================================================
    // /workspace/r2：pi-files 桶里 mount/ 前缀下的对象，启动时复制进来，只读。
    // 注意这是"复制"不是"实时视图"——R2Bucket 挂载是 eager 的，所以只适合
    // 放模板、参考文档这类小东西；大文件走 publish。
    // ======================================================================
    mounts: {
      "/workspace/r2": R2Bucket(this.env.PI_FILES, {
        prefix: "mount/",
        mode: "read-only",
        maxBytes: R2_MOUNT_MAX_BYTES
      })
    },
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
  /** 工作区工具，harness 工厂里赋值；plan mode 切换时要用。 */
  workspaceTools: ToolRegistration[] = [];
  /**
   * 当前生效的配置 = Dashboard 变量 + 应用内设置（PiSettings）。harness 打开时
   * 载入；Config 页改了之后 Worker 调 refreshConfig() 更新。读配置的地方一律
   * 通过 this.#config，不直接读 this.env，这样改动才能生效。
   */
  #config: GatewayEnv = resolveConfig(this.env, {});
  /** pi 的模型目录。换配置时重新 setProvider，同一个对象，pi 每次请求都从这里读。 */
  readonly models = createModels();

  async #loadConfig(): Promise<void> {
    const saved = await this.env.PiSettings.getByName(SETTINGS_NAME).all();
    this.#config = resolveConfig(this.env, saved);
  }

  /**
   * 按当前配置（重新）注册 AI Gateway provider：lead 路由，以及设了
   * PI_SIDE_ROUTE 时的 sidekick 路由。模型能力、价格都从配置来。
   */
  #applyModels(): void {
    const { CF_ACCOUNT_ID, CF_AIG_TOKEN, PI_SIDE_ROUTE, PI_PRICE_INPUT, PI_PRICE_OUTPUT } = this.#config;
    const profile = modelProfile(this.#config);
    const baseUrl = `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${GATEWAY_ID}/compat`;
    // pi 按 cost 字段算每轮花费；单位是美元 / 百万 token。
    const price = {
      input: Number(PI_PRICE_INPUT ?? 0) || 0,
      output: Number(PI_PRICE_OUTPUT ?? 0) || 0,
      cacheRead: 0,
      cacheWrite: 0
    };
    // 每条动态路由在这里是一个"模型"；同一个 provider、同一个入口，只有 id 不同。
    const routeModel = (id: string, name: string): Model<"openai-completions"> => ({
      id,
      name,
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl,
      reasoning: profile.reasoning,
      input: [...profile.input],
      cost: price,
      contextWindow: profile.contextWindow,
      maxTokens: profile.maxTokens,
      headers: { "cf-aig-authorization": `Bearer ${CF_AIG_TOKEN}` },
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }
    });
    const lead = routeModel(MODEL_ID, "AI Gateway dynamic route (lead)");
    const side = PI_SIDE_ROUTE
      ? routeModel(`dynamic/${PI_SIDE_ROUTE}`, "AI Gateway dynamic route (sidekick)")
      : undefined;
    this.models.setProvider(
      createProvider({
        id: PROVIDER_ID,
        name: "Cloudflare AI Gateway",
        baseUrl,
        auth: {
          apiKey: {
            name: "AI Gateway token",
            resolve: async () => ({ auth: { apiKey: CF_AIG_TOKEN } })
          }
        },
        models: side ? [lead, side] : [lead],
        api: openAICompletionsApi()
      })
    );
  }

  /** 子代理走的模型；没设 PI_SIDE_ROUTE 就继承父对话。每次创建子对话时读。 */
  #childModel = () =>
    this.#config.PI_SIDE_ROUTE
      ? { provider: PROVIDER_ID, modelId: `dynamic/${this.#config.PI_SIDE_ROUTE}` }
      : undefined;

  /** Config 页改了设置后由 Worker 调用：重新载入并应用。 */
  async refreshConfig(): Promise<void> {
    await this.#loadConfig();
    this.#applyModels();
  }
  /** 最近一次请求的站点根，publish 生成链接用（PI_PUBLIC_URL 优先）。 */
  #origin: string | undefined;
  /** publish 工具和 Files 面板"分享"共用。 */
  get publishDeps(): PublishDeps {
    const env = this.#config;
    return {
      workspace: this.workspace,
      bucket: this.env.PI_FILES,
      secret: shareSecret(env),
      object: this.ctx.id.name ?? this.ctx.id.toString(),
      origin: () => env.PI_PUBLIC_URL?.replace(/\/$/, "") || this.#origin,
      contentTypeOf
    };
  }
  readonly harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      // pi's own extension: the system prompt and the workspace tools.
      // ==================================================================
      // 工具输出上限。read 默认 256 KiB ≈ 6 万 token，一次就占掉半个上下文
      // 窗口；收到 48 KiB，超出的部分提示模型用 offset/limit 分段或 grep。
      // exec 的 stdout 同理。
      // ==================================================================
      this.workspaceTools = createWorkspaceTools(this.workspace, {
        read: { maxBytes: 48 * 1024, maxLines: 1200 },
        execOutput: { maxBytes: 32 * 1024, maxLines: 800 }
      });
      const playground: Extension = {
        name: "playground",
        sections: [{ key: "preamble", render: () => PREAMBLE, tag: false }],
        tools: this.workspaceTools
      };
      this.registry.install(playground);
      // ======================================================================
      // 两种子代理，都单独作为扩展安装（不合并进 playground），这样子对话
      // 可以只移除它们、保留工作区工具。
      //   Subagent（src/subagent.ts）：前台，阻塞，直接返回答案。
      //   SubagentsExtension（src/subagents.ts）：后台，并行，答案稍后作为
      //   新消息送回。
      // ======================================================================
      // 不走 Workers AI binding，而是用 OpenAI 兼容协议直接打 AI Gateway 的
      // /compat 入口（和 Brain 一样）。这个入口支持 Workers AI、内置供应商和
      // custom provider，所以路由节点换什么模型这里都不用改。
      // 配置 = Dashboard 变量 + 应用内设置；模型 provider 按配置注册，之后
      // refreshConfig() 可以重建。
      await this.#loadConfig();
      this.#applyModels();
      // ======================================================================
      // lead / sidekick 分层：设了 PI_SIDE_ROUTE，子代理就走那条路由（通常是
      // 更便宜、更快或更擅长写代码的模型）；主 Agent 仍用 pi-route。
      // childModel 是 getter，改设置后新建的子对话立刻用新路由。
      // ======================================================================
      const childModel = this.#childModel;
      const subagent = createSubagent({ childModel });
      const subagents = createSubagents({ childModel });
      const review = createReview({
        childModel,
        workspaceTools: this.workspaceTools,
        removeInChild: [subagent, subagents]
      });
      const publish = createPublish(this.publishDeps);
      const web = createFetchTool({
        workspace: this.workspace,
        allow: () => parseAllowList(this.#config.PI_FETCH_ALLOW),
        normalizePath: normalizeWorkspacePath
      });
      for (const extension of [subagent, subagents, review, publish, web, ReviewerRole, Plan]) {
        this.registry.install(extension);
      }
      // ======================================================================
      // 默认只选这几个扩展。ReviewerRole 只装在 reviewer 子对话上，Plan 只在
      // 用户打开 plan mode 时加到主对话上（见 setPlanMode）。不写这一条，
      // "默认"就是全部已安装扩展，Plan 的系统提示会一直生效。
      // ======================================================================
      const defaultExtensions = [playground, subagent, subagents, review, publish, web];
      const models = this.models;
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          onWake,
          settings: {
            extensions: defaultExtensions,
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
  readonly sockets = new PiSessionSockets(
    this.harness,
    this.registry,
    (tag) => this.ctx.getWebSockets(tag),
    {
      capabilities: () => ({ vision: modelProfile(this.#config).vision }),
      onRequest: (request) => {
        this.#origin = new URL(request.url).origin;
      }
    }
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  /** Host startup, after the harness has opened pi. */
  async onStart(): Promise<void> {
    // 新对象的工作区是空的，连 /workspace 目录都没有；模型第一步 ls 就会
    // 报 "no such path"。这里先建好。mkdir recursive 对已存在的目录是 no-op。
    await this.workspace.fs.mkdir("/workspace", { recursive: true });
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
    let entries: Awaited<ReturnType<typeof this.workspace.fs.readdir>>;
    try {
      entries = await this.workspace.fs.readdir(dir, { limit: 1000 });
    } catch (error) {
      // 新会话还没写过文件时 /workspace 本身不存在：当作空目录，不报错。
      if (dir === "/workspace" && /no such path/i.test(String(error))) return [];
      throw error;
    }
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

  /**
   * 读文件，返回流。Workers RPC 会把流带流控地传给 Worker，再传给浏览器，
   * 整个过程不进内存，文件多大都行。`maxBytes` 给预览用：只取前面一段。
   */
  async readFile(
    path: string,
    maxBytes?: number
  ): Promise<{ stream: ReadableStream<Uint8Array>; size: number; truncated: boolean }> {
    const file = normalizeWorkspacePath(path);
    const stat = await this.workspace.fs.stat(file);
    if (!stat.isFile) throw new Error(`Not a file: ${file}`);
    const byteLength = maxBytes === undefined ? stat.size : Math.min(stat.size, maxBytes);
    const stream = await this.workspace.fs.readFile(file, { byteOffset: 0, byteLength });
    return { stream, size: stat.size, truncated: byteLength < stat.size };
  }

  /** 上传：从流写一个文件（覆盖）。目录不存在就建。同样不进内存。 */
  async writeFile(
    path: string,
    body: ReadableStream<Uint8Array>
  ): Promise<{ path: string; size: number }> {
    const file = normalizeWorkspacePath(path);
    if (file === "/workspace") throw new Error("Path is a directory");
    const dir = file.slice(0, file.lastIndexOf("/"));
    await this.workspace.fs.mkdir(dir, { recursive: true });
    await this.workspace.fs.writeFile(file, body);
    const stat = await this.workspace.fs.stat(file);
    return { path: file, size: stat.size };
  }

  // ==========================================================================
  // 分支：在同一个 DO 里 fork 一个 pi session，它看得到源会话到现在为止的全部
  // 历史，之后各走各的。工作区是共享的（同一个 DO）。返回新 session 的 id，
  // 前端用 ?session=<id> 连它。
  // ==========================================================================
  async fork(from: string): Promise<string> {
    const session = await this.harness.sessions.fork(from);
    return session.id;
  }

  /** Files 面板"分享"：发布一个文件，返回链接。origin 来自调用方请求。 */
  async publish(path: string, expiresSeconds: number | undefined, origin: string) {
    this.#origin = origin;
    return publishFile(this.publishDeps, normalizeWorkspacePath(path), expiresSeconds);
  }

  /** 会话状态：是否在 plan mode、当前计划、token 用量。 */
  async sessionState(session: string): Promise<SessionState> {
    const pi = await this.harness.pi();
    const conversation = await this.harness.conversation(session);
    const agent = await conversation.agent(BACKGROUND_CONTEXT);
    const planMode = agent.extensions.some((extension) => extension.name === Plan.name);
    const plan = (await pi.snapshot(PlanDoc, conversation.id, BACKGROUND_CONTEXT))?.steps ?? [];
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
    const state = await pi.snapshot(UsageDoc, conversation.id, BACKGROUND_CONTEXT);
    for (const bucket of Object.values(state?.models ?? {})) {
      usage.input += bucket.input ?? 0;
      usage.output += bucket.output ?? 0;
      usage.cacheRead += bucket.cacheRead ?? 0;
      usage.cacheWrite += bucket.cacheWrite ?? 0;
      usage.totalTokens += bucket.totalTokens ?? 0;
      usage.cost += bucket.cost?.total ?? 0;
    }
    return { planMode, plan, usage };
  }

  /** 切换 plan mode（见 src/quality.ts）。 */
  async setPlanMode(session: string, on: boolean): Promise<void> {
    const conversation = await this.harness.conversation(session);
    await conversation.configure(
      on ? enterPlanMode(this.workspaceTools) : leavePlanMode,
      BACKGROUND_CONTEXT
    );
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
//   GET    /api/sessions                      当前用户的会话目录
//   POST   /api/sessions                      登记一个会话 { id?, title?, createdAt? }
//   PATCH  /api/sessions/<sid>                改名 { title }
//   DELETE /api/sessions/<sid>                删除：根会话 → 清掉整个 DO 和它所有分支；
//                                             分支 → 只从目录移除（数据随 DO）
//   DELETE /api/session/<uuid>                同上（旧路径）
//   GET    /api/session/<uuid>/files?path=    列目录
//   GET    /api/session/<uuid>/file?path=     读文件 [&download=1]
//   PUT    /api/session/<uuid>/file?path=     上传（body 是文件内容）
//   POST   /api/session/<uuid>/fork?session=  fork 一个分支，返回 { id, branch }
//   GET    /api/session/<uuid>/state?session= { planMode, plan, usage }
//   POST   /api/session/<uuid>/plan?session=  { on: boolean } 切换 plan mode
//   POST   /api/session/<uuid>/share?path=&expires=  发布文件，返回 { url, expiresAt }
//   GET    /share/<key>?exp=&sig=             下载已发布的文件（签名校验）
//
// <sid> 是目录项 id（UUID 或 UUID:branch）；?session= 是 pi session id，省略为根。
// 返回 undefined 表示不归这里管，交给 routeAgentRequest。
// ============================================================================
async function handleApi(
  request: Request,
  url: URL,
  env: Env
): Promise<Response | undefined> {
  const { method } = request;
  const index = () => env.PiSessionIndex.getByName(ownerOf(request));
  const bad = (message: string, status = 400) => Response.json({ error: message }, { status });

  // 已发布文件的下载。key 形如 shared/<uuid>/<ts>-<name>。
  if (url.pathname.startsWith("/share/") && method === "GET") {
    const key = url.pathname
      .slice("/share/".length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig") ?? "";
    const secret = shareSecret(resolveConfig(env, {}));
    if (!key.startsWith("shared/") || !(await verifyShare(secret, key, exp, sig))) {
      return bad("Link is invalid or has expired", 403);
    }
    const object = await env.PI_FILES.get(key);
    if (!object) return bad("Not found", 404);
    const name = key.slice(key.lastIndexOf("/") + 1).replace(/^\d+-/, "");
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "private, no-store");
    if (url.searchParams.get("inline") !== "1") {
      headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    }
    return new Response(object.body, { headers });
  }

  // 当前生效的配置和每个变量的说明（右栏 Config 标签页）；PATCH 改应用内设置。
  if (url.pathname === "/api/config") {
    const settings = env.PiSettings.getByName(SETTINGS_NAME);
    if (method === "GET") return Response.json(describeConfig(await settings.all()));
    if (method === "PATCH") {
      const body = (await request.json().catch(() => ({}))) as {
        key?: string;
        value?: string | null;
        /** 当前打开的会话对象，改完让它立刻重载配置；其他对象重启后生效。 */
        object?: string;
      };
      if (!body.key || !SETTABLE.has(body.key)) return bad("Unknown setting");
      const saved = await settings.set(body.key, body.value ?? null);
      if (body.object && UUID.test(body.object)) {
        await env.PiAgent.getByName(body.object).refreshConfig();
      }
      return Response.json(describeConfig(saved));
    }
    return bad("Method not allowed", 405);
  }

  if (url.pathname === "/api/sessions") {
    if (method === "GET") return Response.json(await index().list());
    if (method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        id?: string;
        title?: string | null;
        createdAt?: number;
      };
      const id = body.id ?? crypto.randomUUID();
      if (!SESSION_ID.test(id)) return bad("Bad id");
      return Response.json(
        await index().upsert({
          id,
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(typeof body.createdAt === "number" ? { createdAt: body.createdAt } : {})
        })
      );
    }
    return bad("Method not allowed", 405);
  }

  const entry = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (entry) {
    const id = entry[1];
    if (!SESSION_ID.test(id)) return bad("Bad id");
    if (method === "PATCH") {
      const body = (await request.json().catch(() => ({}))) as { title?: string };
      const record = await index().rename(id, body.title ?? "");
      return record ? Response.json(record) : bad("Not found", 404);
    }
    if (method === "DELETE") {
      const { object, branch } = splitSessionId(id);
      if (branch === null) {
        await env.PiAgent.getByName(object).destroy();
        await index().removeObject(object);
      } else {
        await index().remove(id);
      }
      return Response.json({ deleted: id });
    }
    return bad("Method not allowed", 405);
  }

  const match = url.pathname.match(
    /^\/api\/session\/([^/]+)(\/files|\/file|\/fork|\/state|\/plan|\/share)?$/
  );
  if (!match) return undefined;
  const id = match[1];
  const sub = match[2];
  // 只接受 UUID 格式，避免拿任意字符串去当 DO 名字。
  if (!UUID.test(id)) return bad("Bad id");
  const agent = env.PiAgent.getByName(id);
  const session = url.searchParams.get("session") ?? ROOT_SESSION;
  if (!/^[1-9][0-9]{0,15}$/.test(session)) return bad("Bad session");

  if (sub === undefined && method === "DELETE") {
    await agent.destroy();
    await index().removeObject(id);
    return Response.json({ deleted: id });
  }
  if (sub === "/files" && method === "GET") {
    const path = url.searchParams.get("path") ?? "/workspace";
    return Response.json(await agent.listFiles(path));
  }
  if (sub === "/file" && method === "GET") {
    const path = url.searchParams.get("path");
    if (!path) return bad("path required");
    const download = url.searchParams.get("download") === "1";
    // 预览只取开头一段；下载给整个文件。
    const { stream, size, truncated } = await agent.readFile(
      path,
      download ? undefined : PREVIEW_BYTES
    );
    const name = path.slice(path.lastIndexOf("/") + 1);
    const headers = new Headers({
      "content-type": contentTypeOf(path),
      "x-file-size": String(size),
      "x-file-truncated": String(truncated),
      "cache-control": "no-store"
    });
    if (download) {
      headers.set("content-length", String(size));
      headers.set(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
      );
    }
    return new Response(stream, { headers });
  }
  if (sub === "/file" && method === "PUT") {
    const path = url.searchParams.get("path");
    if (!path) return bad("path required");
    if (!request.body) return bad("body required");
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_UPLOAD_BYTES) return bad(`File too large (max ${MAX_UPLOAD_BYTES} bytes)`, 413);
    return Response.json(await agent.writeFile(path, request.body));
  }
  if (sub === "/fork" && method === "POST") {
    const branch = await agent.fork(session);
    const sourceId = session === ROOT_SESSION ? id : `${id}:${session}`;
    const body = (await request.json().catch(() => ({}))) as { title?: string };
    const record = await index().upsert({
      id: `${id}:${branch}`,
      parent: sourceId,
      ...(body.title ? { title: body.title } : {})
    });
    return Response.json(record);
  }
  if (sub === "/state" && method === "GET") {
    return Response.json(await agent.sessionState(session));
  }
  if (sub === "/share" && method === "POST") {
    const path = url.searchParams.get("path");
    if (!path) return bad("path required");
    const expires = Number(url.searchParams.get("expires")) || undefined;
    return Response.json(await agent.publish(path, expires, url.origin));
  }
  if (sub === "/plan" && method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { on?: boolean };
    await agent.setPlanMode(session, body.on === true);
    return Response.json({ planMode: body.on === true });
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
