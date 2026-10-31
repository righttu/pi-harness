import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/** 会话目录 Durable Object（src/sessions.ts）。 */
describe("SessionIndex", () => {
  it("registers, renames, orders by last update, and removes sessions", async () => {
    const index = env.SessionIndex.getByName(`owner-${crypto.randomUUID()}`);
    expect(await index.list()).toEqual([]);

    const a = await index.upsert({ id: crypto.randomUUID(), createdAt: 1000 });
    const b = await index.upsert({ id: crypto.randomUUID(), title: "second" });
    expect(a.title).toBeNull();
    expect(a.createdAt).toBe(1000);
    expect(b.title).toBe("second");

    // 最近更新的在前：b 后登记。
    expect((await index.list()).map((s) => s.id)).toEqual([b.id, a.id]);

    // 再登记一次已有的：不传 title 不会清掉已有标题。
    await index.upsert({ id: b.id });
    expect((await index.list()).find((s) => s.id === b.id)?.title).toBe("second");

    // 改名把 a 顶到最前；空标题清掉自定义名字。
    const renamed = await index.rename(a.id, "  first  ");
    expect(renamed?.title).toBe("first");
    expect((await index.list()).map((s) => s.id)).toEqual([a.id, b.id]);
    expect((await index.rename(a.id, "   "))?.title).toBeNull();

    await index.remove(b.id);
    expect((await index.list()).map((s) => s.id)).toEqual([a.id]);

    // 删不存在的不报错。
    await index.remove(crypto.randomUUID());
    expect(await index.rename(crypto.randomUUID(), "x")).toBeUndefined();
  });
});
