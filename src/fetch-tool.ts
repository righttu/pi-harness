// ============================================================================
// `fetch` 工具：让模型访问网络。
//
// - 域名白名单：Worker 变量 PI_FETCH_ALLOW，逗号分隔的主机名，后缀匹配
//   （"example.com" 也放行 api.example.com）；"*" 放行全部。默认 "*"。
//   这是防提示注入把工作区内容外传的主要手段，对外开放时建议收紧。
// - 返回给模型的正文最多 MAX_TEXT_BYTES（再多撑上下文）；HTML 会去掉标签和
//   脚本只留文字。要完整内容或二进制（PDF、zip、图片）就传 savePath，
//   响应体直接流进工作区文件，不进内存，模型再用 read / exec 处理。
// - 超时 30 秒。只允许 http(s)。
// ============================================================================

import type { Workspace } from "@cloudflare/computer";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolExecutionResult
} from "@earendil-works/pi-durable";

const MAX_TEXT_BYTES = 64 * 1024;
const TIMEOUT_MS = 30_000;

export type FetchToolOptions = {
  workspace: Workspace;
  /** 允许的主机名；"*" 表示全部。getter：实时读配置。 */
  allow: () => readonly string[];
  /** 把相对/不规范的工作区路径规范化并检查在 /workspace 内。 */
  normalizePath: (path: string) => string;
};

export function parseAllowList(value: string | undefined): string[] {
  const list = (value ?? "*")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length === 0 ? ["*"] : list;
}

function allowed(hostname: string, allow: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allow.some((rule) => rule === "*" || host === rule || host.endsWith(`.${rule}`));
}

/** 粗糙但够用的 HTML → 文本。 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|br|li|tr|h[1-6]|section|article|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export function createFetchTool(options: FetchToolOptions): Extension {
  return defineExtension({
    name: "fetch",
    tools: [
      defineTool({
        name: "fetch",
        description:
          "Make an HTTP request. Returns the status, content type and the response text (HTML is reduced " +
          "to its text; long bodies are cut at 64 KiB). To keep the whole response, or to download a " +
          "binary file (PDF, zip, image, dataset), pass savePath: the body is written to that workspace " +
          "file and nothing is returned inline. Only http(s) URLs on allowed hosts.",
        parameters: Type.Object({
          url: Type.String(),
          method: Type.Optional(
            Type.Union([Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PUT"), Type.Literal("HEAD")])
          ),
          headers: Type.Optional(Type.Record(Type.String(), Type.String())),
          body: Type.Optional(Type.String({ description: "Request body for POST/PUT." })),
          savePath: Type.Optional(
            Type.String({ description: "Absolute /workspace path to save the response body to." })
          )
        }),
        // GET 重跑无害，但 POST 不是；统一标 unsafe，让模型看到调用被打断后自己决定。
        replay: "unsafe",
        execute: async (args): Promise<ToolExecutionResult> => {
          const fail = (text: string): ToolExecutionResult => ({
            output: [{ type: "text", text }],
            isError: true
          });
          let target: URL;
          try {
            target = new URL(args.url);
          } catch {
            return fail(`Invalid URL: ${args.url}`);
          }
          if (target.protocol !== "http:" && target.protocol !== "https:") {
            return fail(`Only http(s) URLs are allowed, got ${target.protocol}`);
          }
          const allow = options.allow();
          if (!allowed(target.hostname, allow)) {
            return fail(
              `Host ${target.hostname} is not in the allow list (${allow.join(", ")}). ` +
                "Ask the user to add it to PI_FETCH_ALLOW if it is needed."
            );
          }

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
          let response: Response;
          try {
            response = await fetch(target, {
              method: args.method ?? "GET",
              headers: { "user-agent": "pi-harness/1.0", ...(args.headers ?? {}) },
              ...(args.body !== undefined && args.method !== "GET" && args.method !== "HEAD"
                ? { body: args.body }
                : {}),
              signal: controller.signal,
              redirect: "follow"
            });
          } catch (error) {
            clearTimeout(timer);
            return fail(
              `Request failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }

          const type = response.headers.get("content-type") ?? "";
          const head = `${response.status} ${response.statusText}\ncontent-type: ${type}`;

          try {
            if (args.savePath) {
              const path = options.normalizePath(args.savePath);
              const dir = path.slice(0, path.lastIndexOf("/"));
              await options.workspace.fs.mkdir(dir, { recursive: true });
              await options.workspace.fs.writeFile(path, response.body ?? new Uint8Array());
              const stat = await options.workspace.fs.stat(path);
              return {
                output: [{ type: "text", text: `${head}\nsaved: ${path} (${stat.size} bytes)` }],
                isError: !response.ok,
                details: { status: response.status, savedTo: path, size: stat.size }
              };
            }

            // 只读前 MAX_TEXT_BYTES，剩下的丢掉，不把整个正文拉进内存。
            const reader = response.body?.getReader();
            const chunks: Uint8Array[] = [];
            let received = 0;
            let truncated = false;
            if (reader) {
              while (received < MAX_TEXT_BYTES) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.byteLength;
              }
              if (received >= MAX_TEXT_BYTES) {
                truncated = true;
                await reader.cancel();
              }
            }
            const merged = new Uint8Array(received);
            let offset = 0;
            for (const chunk of chunks) {
              merged.set(chunk, offset);
              offset += chunk.byteLength;
            }
            let text = new TextDecoder().decode(merged.subarray(0, MAX_TEXT_BYTES));
            if (/text\/html/i.test(type)) text = htmlToText(text);
            const note = truncated
              ? `\n\n[truncated at ${MAX_TEXT_BYTES} bytes; pass savePath to keep the whole response]`
              : "";
            return {
              output: [{ type: "text", text: `${head}\n\n${text}${note}` }],
              isError: !response.ok,
              details: { status: response.status, contentType: type, truncated }
            };
          } finally {
            clearTimeout(timer);
          }
        }
      })
    ]
  });
}
