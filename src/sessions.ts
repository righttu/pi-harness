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

/**
 * 一条目录项。
 *   id      根会话是 DO 的 UUID；分支是 "<uuid>:<pi session id>"。
 *   object  所属 DO 的 UUID（分支和它的源会话相同）。
 *   branch  pi session id；根会话为 null。
 *   parent  分支是从哪条目录项 fork 出来的；根会话为 null。
 */
export type SessionRecord = {
  id: string;
  object: string;
  branch: string | null;
  parent: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
};

type Row = {
  id: string;
  object: string;
  branch: string | null;
  parent: string | null;
  title: string | null;
  created_at: number;
  updated_at: number;
};

function toRecord(row: Row): SessionRecord {
  return {
    id: row.id,
    object: row.object,
    branch: row.branch,
    parent: row.parent,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** 把目录项 id 拆成 DO 名和 pi session。 */
export function splitSessionId(id: string): { object: string; branch: string | null } {
  const colon = id.indexOf(":");
  return colon === -1
    ? { object: id, branch: null }
    : { object: id.slice(0, colon), branch: id.slice(colon + 1) };
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
      const sql = ctx.storage.sql;
      sql.exec(
        `CREATE TABLE IF NOT EXISTS sessions (
           id TEXT PRIMARY KEY,
           title TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         )`
      );
      // 第二版加的列（分支支持）。旧表没有就补上；object 对旧行等于 id。
      const columns = new Set(
        sql.exec<{ name: string }>("PRAGMA table_info(sessions)").toArray().map((c) => c.name)
      );
      if (!columns.has("object")) {
        sql.exec("ALTER TABLE sessions ADD COLUMN object TEXT");
        sql.exec("UPDATE sessions SET object = id WHERE object IS NULL");
      }
      if (!columns.has("branch")) sql.exec("ALTER TABLE sessions ADD COLUMN branch TEXT");
      if (!columns.has("parent")) sql.exec("ALTER TABLE sessions ADD COLUMN parent TEXT");
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
    parent?: string | null;
  }): SessionRecord {
    const now = this.#now();
    const createdAt = input.createdAt ?? now;
    const { object, branch } = splitSessionId(input.id);
    this.ctx.storage.sql.exec(
      `INSERT INTO sessions (id, object, branch, parent, title, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(id) DO UPDATE SET
         title = COALESCE(excluded.title, sessions.title),
         updated_at = excluded.updated_at`,
      input.id,
      object,
      branch,
      input.parent ?? null,
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

  /** 删掉一个 DO 的根会话和它所有分支（DO 本身被 destroy 时用）。 */
  removeObject(object: string): void {
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE object = ?1", object);
  }

  private get(id: string): SessionRecord | undefined {
    const row = this.ctx.storage.sql
      .exec<Row>("SELECT * FROM sessions WHERE id = ?1", id)
      .toArray()[0];
    return row ? toRecord(row) : undefined;
  }
}
