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
import { PiSessionSockets } from "./sockets";
import { createWorkspaceTools, JAVASCRIPT_BACKEND } from "./workspace";

// AI Gateway 的名字和动态路由的名字。换模型只改路由配置，不改这里。
const GATEWAY_ID = "pi-gateway";
const MODEL_ID = "dynamic/pi-route";
const PROVIDER_ID = "aigw";

/** Worker 变量（Dashboard → Settings → Variables and Secrets）。 */
type GatewayEnv = { CF_ACCOUNT_ID: string; CF_AIG_TOKEN: string };

const PREAMBLE =
  "You are a concise playground assistant. You have a durable workspace at /workspace: read, write, edit, delete, list (ls), find and grep files there, and run JavaScript modules in it with exec, which can also use git. Paths are absolute. Use tools whenever they can answer the request, and explain their results plainly.";

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
        tools: createWorkspaceTools(this.workspace)
      });
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
        contextWindow: 128000,
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
            retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 }
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
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/api/session") {
      // A fresh session id for the client to open its WebSocket against.
      return Response.json({ session: crypto.randomUUID() });
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
