// ============================================================================
// 应用内设置。
//
// 两层：这里的值 > 代码默认值。Dashboard 变量不再参与这些项（只留密钥和
// 账号 id：CF_ACCOUNT_ID、CF_AIG_TOKEN、PI_SHARE_SECRET）。
//
// SETTINGS 是唯一的定义表：server.ts 用它合并配置，Config 页用它画表单。
// 加一个设置项只改这里。
//
// 存储：一个全局单例 Durable Object（名字 "global"），SQLite 一张 key/value 表。
// 单例、不按用户分：这是个人实例，模型配置本来就是全局的。
// ============================================================================

import { DurableObject } from "cloudflare:workers";

export type SettingKind =
  | { kind: "select"; options: readonly { value: string; label: string }[] }
  | { kind: "number"; min?: number; max?: number }
  | { kind: "text"; placeholder?: string };

export type SettingDef = SettingKind & {
  name: string;
  label: string;
  defaultValue: string;
  description: string;
};

export const SETTINGS: readonly SettingDef[] = [
  {
    name: "PI_MODEL_INPUT",
    label: "模型输入",
    kind: "select",
    options: [
      { value: "text", label: "只看文字" },
      { value: "text,image", label: "文字 + 图片" }
    ],
    defaultValue: "text",
    description:
      "路由背后的模型能不能看图。选「文字 + 图片」后聊天框可贴图、read 会把图片/PDF 喂给模型。模型其实不支持的话请求会报错。"
  },
  {
    name: "PI_CONTEXT_WINDOW",
    label: "上下文窗口（token）",
    kind: "number",
    min: 4000,
    max: 10_000_000,
    defaultValue: "128000",
    description: "模型一次能看多少 token。决定对话多长时开始自动压缩。路由换成不同窗口的模型时改。"
  },
  {
    name: "PI_MAX_TOKENS",
    label: "单次回答上限（token）",
    kind: "number",
    min: 256,
    max: 200_000,
    defaultValue: "8192",
    description: "模型一次回答最多多少 token。只是上限，不会让回答变长。"
  },
  {
    name: "PI_MODEL_REASONING",
    label: "思考型模型",
    kind: "select",
    options: [
      { value: "false", label: "否" },
      { value: "true", label: "是" }
    ],
    defaultValue: "false",
    description: "模型是不是先思考再回答的类型（qwen3-thinking、DeepSeek-R1、o 系列）。影响 pi 怎么请求和展示思考内容。"
  },
  {
    name: "PI_SIDE_ROUTE",
    label: "子代理路由",
    kind: "text",
    placeholder: "pi-side",
    defaultValue: "",
    description:
      "子代理（subagent / subagents / review）走的 AI Gateway 动态路由名。空 = 和主 Agent 同一条路由。改后新建的子代理生效。"
  },
  {
    name: "PI_PRICE_INPUT",
    label: "输入价格（$/百万 token）",
    kind: "number",
    min: 0,
    defaultValue: "0",
    description: "主模型每百万输入 token 的美元价格，用于标题栏成本显示。0 = 只显示 token 数。"
  },
  {
    name: "PI_PRICE_OUTPUT",
    label: "输出价格（$/百万 token）",
    kind: "number",
    min: 0,
    defaultValue: "0",
    description: "主模型每百万输出 token 的美元价格。"
  },
  {
    name: "PI_FETCH_ALLOW",
    label: "联网白名单",
    kind: "text",
    placeholder: "*",
    defaultValue: "*",
    description: "fetch 工具允许访问的主机名，逗号分隔，后缀匹配（example.com 也放行 api.example.com）。* 放行全部。"
  },
  {
    name: "PI_PUBLIC_URL",
    label: "站点根地址",
    kind: "text",
    placeholder: "https://pi-agent.example.com",
    defaultValue: "",
    description: "分享链接用的站点根。空 = 用最近一次访问的地址。一般不用设。"
  }
];

export const SETTABLE = new Set(SETTINGS.map((def) => def.name));
export const SETTINGS_NAME = "global";

/** 应用内已设的值（只含非空、非默认的项）。 */
export type SettingsMap = Record<string, string>;

/** 合并成"每个设置项都有值"的生效配置。 */
export function effectiveSettings(saved: SettingsMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of SETTINGS) {
    const value = saved[def.name];
    out[def.name] = value !== undefined && value !== "" ? value : def.defaultValue;
  }
  return out;
}

/** 校验一个值；返回错误信息或 undefined。 */
export function validateSetting(def: SettingDef, value: string): string | undefined {
  if (def.kind === "select" && !def.options.some((option) => option.value === value)) {
    return `${def.label}：只能是 ${def.options.map((o) => o.value).join(" / ")}`;
  }
  if (def.kind === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) return `${def.label}：必须是数字`;
    if (def.min !== undefined && n < def.min) return `${def.label}：不能小于 ${def.min}`;
    if (def.max !== undefined && n > def.max) return `${def.label}：不能大于 ${def.max}`;
  }
  return undefined;
}

export class PiSettings extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(
        `CREATE TABLE IF NOT EXISTS settings (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         )`
      );
      // 一次性迁移：以前这些项可以在 Dashboard 变量里设。第一次启动把已有的
      // 搬进来，之后 Dashboard 里的同名变量就不再读了（可以删掉）。
      const seeded = sql
        .exec<{ value: string }>("SELECT value FROM settings WHERE key = '__seeded__'")
        .toArray()[0];
      if (!seeded) {
        const vars = env as unknown as Record<string, string | undefined>;
        const now = Date.now();
        for (const def of SETTINGS) {
          const value = vars[def.name];
          if (value && value !== def.defaultValue) {
            sql.exec(
              "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
              def.name,
              value,
              now
            );
          }
        }
        sql.exec(
          "INSERT INTO settings (key, value, updated_at) VALUES ('__seeded__', '1', ?1)",
          now
        );
      }
    });
  }

  /** 应用内已设的值。 */
  all(): SettingsMap {
    const out: SettingsMap = {};
    for (const row of this.ctx.storage.sql
      .exec<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key NOT LIKE '\\_\\_%' ESCAPE '\\'")
      .toArray()) {
      out[row.key] = row.value;
    }
    return out;
  }

  /** 设一个值；`null`、空或等于默认值表示清掉（回到默认）。校验失败抛错。 */
  set(key: string, value: string | null): SettingsMap {
    const def = SETTINGS.find((d) => d.name === key);
    if (!def) throw new Error(`${key} is not a setting`);
    const trimmed = value?.trim() ?? "";
    if (trimmed === "" || trimmed === def.defaultValue) {
      this.ctx.storage.sql.exec("DELETE FROM settings WHERE key = ?1", key);
      return this.all();
    }
    const problem = validateSetting(def, trimmed);
    if (problem) throw new Error(problem);
    this.ctx.storage.sql.exec(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      trimmed,
      Date.now()
    );
    return this.all();
  }
}
