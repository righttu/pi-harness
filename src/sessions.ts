// ============================================================================
// 会话目录：一个很小的 Durable Object，用 SQLite 存"这个用户有哪些会话"。
//
// 以前目录只在浏览器 localStorage 里，换个浏览器就找不回会话了。现在目录在
// 服务端，浏览器只缓存一份。
//
// "这个用户"是谁：Worker 用 Cloudflare Access 注入的
// `Cf-Access-Authenticated-User-Email` 头做 owner，一个 owner 一个 PiSessionIndex
// 实例。没有接 Access 时所有人共用 "public" 这一个目录（和现在"知道 URL 就能
// 用"的信任模型一致）。接上 Access 后不用改代码，每个人自动看到自己的列表。
//
// 这里只存目录项；会话内容仍然在各自的 PiAgent 对象里。
// ============================================================================

import { DurableObject } from "cloudflare:workers";

export type SessionRecord = {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
};

type Row = {
  id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
};

function toRecord(row: Row): SessionRecord {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class PiSessionIndex extends DurableObject<Env> {
  /** 上一次写入用的时间戳；同一毫秒内的两次写入也要分得出先后。 */
  #last = 0;

  /** 单调递增的"现在"，列表按它排序。 */
  #now(): number {
    this.#last = Math.max(Date.now(), this.#last + 1);
    return this.#last;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 建表在构造函数里做，任何 RPC 到达前就绪。
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS sessions (
           id TEXT PRIMARY KEY,
           title TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         )`
      );
    });
  }

  /** 全部会话，最近更新的在前。 */
  list(): SessionRecord[] {
    return this.ctx.storage.sql
      .exec<Row>("SELECT * FROM sessions ORDER BY updated_at DESC")
      .toArray()
      .map(toRecord);
  }

  /**
   * 新建或补登记一个会话（客户端把 localStorage 里的旧目录迁过来也走这里）。
   * 已存在的只在传了 title 时更新标题。
   */
  upsert(input: {
    id: string;
    title?: string | null;
    createdAt?: number;
  }): SessionRecord {
    const now = this.#now();
    const createdAt = input.createdAt ?? now;
    this.ctx.storage.sql.exec(
      `INSERT INTO sessions (id, title, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(id) DO UPDATE SET
         title = COALESCE(excluded.title, sessions.title),
         updated_at = excluded.updated_at`,
      input.id,
      input.title ?? null,
      createdAt,
      now
    );
    return this.get(input.id)!;
  }

  /** 改名；空字符串表示清掉自定义标题。 */
  rename(id: string, title: string): SessionRecord | undefined {
    this.ctx.storage.sql.exec(
      "UPDATE sessions SET title = ?2, updated_at = ?3 WHERE id = ?1",
      id,
      title.trim() === "" ? null : title.trim(),
      this.#now()
    );
    return this.get(id);
  }

  /** 记一下"刚用过"，列表按这个排序。 */
  touch(id: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
      id,
      this.#now()
    );
  }

  remove(id: string): void {
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE id = ?1", id);
  }

  private get(id: string): SessionRecord | undefined {
    const row = this.ctx.storage.sql
      .exec<Row>("SELECT * FROM sessions WHERE id = ?1", id)
      .toArray()[0];
    return row ? toRecord(row) : undefined;
  }
}
