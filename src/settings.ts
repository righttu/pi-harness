// ============================================================================
// 应用内设置：一个全局单例 Durable Object（名字固定 "global"），SQLite 里一张
// key/value 表，存右栏 Config 页里改的值。
//
// 优先级：这里的值 > Dashboard 变量 > 代码默认值。
// 只放非密钥的 PI_* 配置；CF_ACCOUNT_ID、CF_AIG_TOKEN、PI_SHARE_SECRET 仍然
// 只能在 Dashboard 设（SETTABLE 之外的 key 会被拒绝）。
//
// 单例、不按用户分：这是个人实例，模型配置本来就是全局的。
// ============================================================================

import { DurableObject } from "cloudflare:workers";

/** 允许在应用内修改的变量。和 server.ts 的 describeConfig 保持一致。 */
export const SETTABLE = new Set([
  "PI_MODEL_INPUT",
  "PI_CONTEXT_WINDOW",
  "PI_MAX_TOKENS",
  "PI_MODEL_REASONING",
  "PI_SIDE_ROUTE",
  "PI_PRICE_INPUT",
  "PI_PRICE_OUTPUT",
  "PI_FETCH_ALLOW",
  "PI_PUBLIC_URL"
]);

export const SETTINGS_NAME = "global";

export class PiSettings extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS settings (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         )`
      );
    });
  }

  /** 全部已设置的值。 */
  all(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.ctx.storage.sql
      .exec<{ key: string; value: string }>("SELECT key, value FROM settings")
      .toArray()) {
      out[row.key] = row.value;
    }
    return out;
  }

  /** 设一个值；`null` 或空字符串表示清掉，回退到 Dashboard 变量 / 默认值。 */
  set(key: string, value: string | null): Record<string, string> {
    if (!SETTABLE.has(key)) throw new Error(`${key} cannot be set from the app`);
    const trimmed = value?.trim() ?? "";
    if (trimmed === "") {
      this.ctx.storage.sql.exec("DELETE FROM settings WHERE key = ?1", key);
    } else {
      this.ctx.storage.sql.exec(
        `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        key,
        trimmed,
        Date.now()
      );
    }
    return this.all();
  }
}
