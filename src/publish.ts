// ============================================================================
// 把工作区文件发布到 R2，拿一个带签名、会过期的下载链接。
//
// 为什么不用 @cloudflare/computer/assets 的 createAssets：它生成的是 R2 的
// S3 预签名 URL，需要你再建一对 R2 S3 API 密钥。这里用 Worker 自己的路由
// `/share/<key>?exp=&sig=` 发文件，HMAC 签名，不需要额外密钥；代价是链接
// 走我们的域名——域名上开了 Cloudflare Access 的话，收链接的人也得能登录，
// 除非给 `/share/*` 加一条 Access bypass 策略。
//
// 文件从工作区 readFile() 拿到的是流，直接 put 进 R2，不进内存，所以没有
// 大小上限（R2 单对象 5 TiB）。
// ============================================================================

import type { Workspace } from "@cloudflare/computer";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";

/** 链接默认有效期和上限（秒）。 */
export const DEFAULT_SHARE_SECONDS = 24 * 60 * 60;
export const MAX_SHARE_SECONDS = 7 * 24 * 60 * 60;

export type PublishResult = { key: string; url: string; size: number; expiresAt: number };

export type PublishDeps = {
  workspace: Workspace;
  bucket: R2Bucket;
  /** 签名密钥（存在 PiSettings，自动生成）。 */
  secret: () => Promise<string>;
  /** 这个 DO 的名字，用作 R2 key 的目录。 */
  object: string;
  /** 链接的站点根，例如 https://pi-agent.example.com。不知道时返回相对路径。 */
  origin: () => string | undefined;
  contentTypeOf: (path: string) => string;
};

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 签名内容：key 和过期时间。 */
export async function signShare(secret: string, key: string, exp: number): Promise<string> {
  return hmac(secret, `${key}\n${exp}`);
}

export async function verifyShare(
  secret: string,
  key: string,
  exp: number,
  sig: string
): Promise<boolean> {
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = await signShare(secret, key, exp);
  if (expected.length !== sig.length) return false;
  // 常量时间比较
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/** 把一个工作区文件复制到 R2 并返回链接。 */
export async function publishFile(
  deps: PublishDeps,
  path: string,
  expiresSeconds = DEFAULT_SHARE_SECONDS
): Promise<PublishResult> {
  const seconds = Math.min(Math.max(60, Math.floor(expiresSeconds)), MAX_SHARE_SECONDS);
  const stat = await deps.workspace.fs.stat(path);
  if (!stat.isFile) throw new Error(`Not a file: ${path}`);
  const name = path.slice(path.lastIndexOf("/") + 1);
  const key = `shared/${deps.object}/${Date.now()}-${name}`;
  // R2 put() 要求流有已知长度；工作区的流没有，用 stat 的大小套一层。
  const stream = (await deps.workspace.fs.readFile(path)).pipeThrough(
    new FixedLengthStream(stat.size)
  );
  await deps.bucket.put(key, stream, {
    httpMetadata: { contentType: deps.contentTypeOf(path) },
    customMetadata: { source: path, object: deps.object }
  });
  const exp = Math.floor(Date.now() / 1000) + seconds;
  const sig = await signShare(await deps.secret(), key, exp);
  const relative = `/share/${key.split("/").map(encodeURIComponent).join("/")}?exp=${exp}&sig=${sig}`;
  const origin = deps.origin();
  return { key, url: origin ? `${origin}${relative}` : relative, size: stat.size, expiresAt: exp * 1000 };
}

/** 给模型的 `publish` 工具。 */
export function createPublish(deps: PublishDeps): Extension {
  return defineExtension({
    name: "publish",
    tools: [
      defineTool({
        name: "publish",
        description:
          "Publish a workspace file so the user can download it: copies it to durable object storage and " +
          "returns a link that expires. Use this to hand over anything you produced (documents, slides, " +
          "archives, images) instead of pasting the contents. Default expiry 24 hours, max 7 days.",
        parameters: Type.Object({
          path: Type.String({ description: "Absolute path of the file in /workspace." }),
          expiresSeconds: Type.Optional(
            Type.Number({ description: "How long the link stays valid, in seconds." })
          )
        }),
        // 重跑会再传一份（新 key），没有副作用冲突，但也不白费：标 unsafe 让模型知道被打断了。
        replay: "unsafe",
        execute: async (args) => {
          const result = await publishFile(deps, args.path, args.expiresSeconds);
          return {
            output: [
              {
                type: "text",
                text:
                  `Published ${args.path} (${result.size} bytes).\n` +
                  `Download: ${result.url}\n` +
                  `Expires: ${new Date(result.expiresAt).toISOString()}`
              }
            ],
            details: result
          };
        }
      })
    ]
  });
}
