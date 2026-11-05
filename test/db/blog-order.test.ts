import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0116_blog_order: ブログの記事の並び順（新しい順・題の順・手で並べる）とフィードを出すか。
 * 手で並べる順は articles.position（新しい記事は最後）、書くのは article_positions_set（項目 content・そのブログの記事だけ）。
 * 並び順だけの変更では更新日時を変えない。会員の一覧（articles_member_page）も同じ並び
 */
describe.skipIf(!dbAvailable)("ブログの並び順とフィード（0116）", () => {
  let f: Fixture;
  let other: Fixture;
  let blogId: string;
  let otherBlog: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "bo-owner@example.com", slug: "bo-shop", publish: true });
    other = await createShopFixture({ email: "bo-other@example.com", slug: "bo-other", publish: true });
    for (const s of [f.shopId, other.shopId]) await getPool().query("update shops set settings = jsonb_set(settings, '{modules}', '{\"blog\": true}'::jsonb) where id = $1", [s]);
    blogId = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into blogs (shop_id, handle, title) values ($1, 'staff', 'スタッフ') returning id", [f.shopId]))).rows[0]!.id;
    otherBlog = (await asUser(other.ownerId, (c) => c.query<{ id: string }>("insert into blogs (shop_id, handle, title) values ($1, 'news', 'news') returning id", [other.shopId]))).rows[0]!.id;
    // 公開した日時: amada が新しい → kato → sato（題の順は amada・kato・sato と逆にしておく）
    const add = async (handle: string, title: string, minutesAgo: number) =>
      (ids[handle] = (
        await asUser(f.ownerId, (c) =>
          c.query<{ id: string }>("insert into articles (shop_id, blog_id, handle, title, body, published, published_at) values ($1, $2, $3, $4, 'b', true, now() - make_interval(mins => $5)) returning id", [f.shopId, blogId, handle, title, minutesAgo]),
        )
      ).rows[0]!.id);
    await add("sato", "あ 佐藤", 30);
    await add("kato", "い 加藤", 20);
    await add("amada", "う 天田", 10);
  });
  afterAll(closePool);

  const anonOrder = async (order: string) => (await asAnon((c) => c.query<{ handle: string }>(`select handle from articles where blog_id = $1 order by ${order}`, [blogId]))).rows.map((r) => r.handle);
  const memberPage = async (sort: string | null) =>
    (
      await asService((c) =>
        c.query<{ r: { handle: string }[] }>("select articles_member_page($1, $2, 0, 12, null, $3, 0, $4, $5) as r", [f.shopId, blogId, randomUUID(), randomUUID(), sort]),
      )
    ).rows[0]!.r.map((x) => x.handle);

  it("既定は新しい順・フィードあり。新しい記事はそのブログの最後の順になる", async () => {
    const b = (await asAnon((c) => c.query<{ article_order: string; feed: boolean }>("select article_order, feed from blogs where id = $1", [blogId]))).rows[0]!;
    expect(b).toEqual({ article_order: "new", feed: true });
    const pos = (await asAnon((c) => c.query<{ handle: string; position: number }>("select handle, position from articles where blog_id = $1 order by position", [blogId]))).rows;
    expect(pos).toEqual([
      { handle: "sato", position: 1 },
      { handle: "kato", position: 2 },
      { handle: "amada", position: 3 },
    ]);
    expect(await memberPage(null)).toEqual(["amada", "kato", "sato"]);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update blogs set article_order = 'random' where id = $1", [blogId])))).toMatch(/check constraint/);
  });

  it("並び順を変えると会員の一覧もそれに従う（p_sort で上書きできる）", async () => {
    await asUser(f.ownerId, (c) => c.query("update blogs set article_order = 'title' where id = $1", [blogId]));
    expect(await memberPage(null)).toEqual(await anonOrder("title asc, published_at desc, id desc"));
    expect(await memberPage(null)).toEqual(["sato", "kato", "amada"]);
    await asUser(f.ownerId, (c) => c.query("update blogs set article_order = 'manual' where id = $1", [blogId]));
    expect(await memberPage(null)).toEqual(["sato", "kato", "amada"]);
    expect(await memberPage("new")).toEqual(["amada", "kato", "sato"]);
    expect(await expectDbError(() => memberPage("random"))).toMatch(/invalid_sort/);
  });

  it("手で並べる: 項目 content の人だけ、そのブログの記事だけ。並びだけでは更新日時を変えない", async () => {
    const before = (await getPool().query<{ updated_at: Date }>("select updated_at from articles where id = $1", [ids["amada"]])).rows[0]!.updated_at;
    const n = (await asUser(f.ownerId, (c) => c.query<{ n: number }>("select article_positions_set($1, $2) as n", [blogId, JSON.stringify({ [ids["amada"]!]: 1, [ids["sato"]!]: 3, [ids["kato"]!]: 2 })]))).rows[0]!.n;
    expect(n).toBe(2);
    expect(await memberPage(null)).toEqual(["amada", "kato", "sato"]);
    expect(await anonOrder("position asc, published_at desc, id desc")).toEqual(["amada", "kato", "sato"]);
    const after = (await getPool().query<{ updated_at: Date }>("select updated_at from articles where id = $1", [ids["amada"]])).rows[0]!.updated_at;
    expect(after.getTime()).toBe(before.getTime());
    // 本文を直せば更新日時は変わる
    await asUser(f.ownerId, (c) => c.query("update articles set body = 'c' where id = $1", [ids["amada"]]));
    expect((await getPool().query<{ updated_at: Date }>("select updated_at from articles where id = $1", [ids["amada"]])).rows[0]!.updated_at.getTime()).toBeGreaterThan(before.getTime());
    // ほかのショップの人・ほかのブログの記事・形の違う値
    expect(await expectDbError(() => asUser(other.ownerId, (c) => c.query("select article_positions_set($1, $2)", [blogId, JSON.stringify({ [ids["amada"]!]: 9 })])))).toMatch(/forbidden/);
    expect((await asUser(other.ownerId, (c) => c.query<{ n: number }>("select article_positions_set($1, $2) as n", [otherBlog, JSON.stringify({ [ids["amada"]!]: 9 })]))).rows[0]!.n).toBe(0);
    for (const bad of [{ [ids["amada"]!]: 0 }, { [ids["amada"]!]: 1.5 }, { [ids["amada"]!]: "1" }, { x: 1 }, []])
      expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select article_positions_set($1, $2)", [blogId, JSON.stringify(bad)])))).toMatch(/invalid_positions/);
    expect(await expectDbError(() => asAnon((c) => c.query("select article_positions_set($1, '{}')", [blogId])))).toMatch(/permission denied/);
    // 新しい記事は最後に
    const fresh = (await asUser(f.ownerId, (c) => c.query<{ position: number }>("insert into articles (shop_id, blog_id, handle, title, published) values ($1, $2, 'new-one', 'え', true) returning position", [f.shopId, blogId]))).rows[0]!.position;
    expect(fresh).toBe(4);
  });

  it("フィードを外せる（列は運営者だけが書ける）", async () => {
    await asUser(f.ownerId, (c) => c.query("update blogs set feed = false where id = $1", [blogId]));
    expect((await asAnon((c) => c.query<{ feed: boolean }>("select feed from blogs where id = $1", [blogId]))).rows[0]!.feed).toBe(false);
    expect(await expectDbError(() => asAnon((c) => c.query("update blogs set feed = true where id = $1", [blogId])))).toMatch(/permission denied/);
  });
});
