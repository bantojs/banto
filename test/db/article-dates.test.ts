import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0124_article_field_dates: 記事の項目の日付（date）と日時（datetime）。値の形はトリガーが確かめ、datetime は UTC にそろえる。
 * 会員の一覧（articles_member_page）は p_sort = field:<key>（早い順・値の無い記事は後ろ）と p_field_from（その値以降だけ）
 */
describe.skipIf(!dbAvailable)("記事の日付の項目（0124）", () => {
  let f: Fixture;
  let blog: string;
  let cid: string;
  let sid: string;
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => asUser(f.ownerId, async (c) => (await c.query(sql, params)).rows as T[]);
  const add = (handle: string, fields: Record<string, unknown>, daysAgo: number) =>
    q<{ fields: Record<string, unknown> }>("insert into articles (shop_id, blog_id, handle, title, published, published_at, fields) values ($1, $2, $3, $3, true, now() - make_interval(days => $5), $4) returning fields", [f.shopId, blog, handle, JSON.stringify(fields), daysAgo]);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "ad-owner@example.com", slug: "ad-shop", publish: true });
    await getPool().query("update shops set settings = settings || '{\"members_enabled\": true, \"modules\": {\"blog\": true}}' where id = $1", [f.shopId]);
    blog = (await q<{ id: string }>("insert into blogs (shop_id, handle, title, article_fields) values ($1, 'events', 'イベント', $2) returning id", [f.shopId, JSON.stringify([{ key: "starts", label: "開催日", type: "date" }, { key: "opens", label: "開場", type: "datetime" }])]))[0]!.id;
    cid = (await getPool().query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'm@example.com') returning id", [f.shopId])).rows[0]!.id;
    sid = (await asService(async (c) => (await c.query<{ r: string }>("select member_session_start($1, $2, 0, 'web', 'x', 3600) as r", [f.shopId, cid])).rows[0]!.r));
  });
  afterAll(closePool);

  it("値の形: date は YYYY-MM-DD でありえる日付だけ、datetime は時差つきだけで UTC にそろえる", async () => {
    expect((await add("a", { starts: "2026-11-20", opens: "2026-11-20T10:00:00+09:00" }, 1))[0]!.fields).toEqual({ starts: "2026-11-20", opens: "2026-11-20T01:00:00Z" });
    expect(await expectDbError(() => add("b", { starts: "2026-02-30" }, 1))).toMatch(/article_field_invalid:starts/);
    expect(await expectDbError(() => add("c", { starts: "20261120" }, 1))).toMatch(/article_field_invalid:starts/);
    expect(await expectDbError(() => add("d", { opens: "2026-11-20T10:00:00" }, 1))).toMatch(/article_field_invalid:opens/);
    expect(await expectDbError(() => q("update blogs set article_fields = $2 where id = $1", [blog, JSON.stringify([{ key: "x", label: "x", type: "date", multiple: true }])]))).toMatch(/article_fields_invalid/);
  });

  it("会員の一覧: field:<key> の早い順（値の無い記事は後ろ）、p_field_from でその値以降だけ", async () => {
    await add("e1", { starts: "2026-12-01" }, 5);
    await add("e2", { starts: "2026-11-01" }, 4);
    await add("e3", {}, 3);
    const page = async (sort: string | null, from: string | null) =>
      (await asService(async (c) => (await c.query<{ r: { handle: string }[] }>("select articles_member_page($1, $2, 0, 12, null, $3, 0, $4, $5, null, $6) as r", [f.shopId, blog, cid, sid, sort, from])).rows[0]!.r)).map((x) => x.handle);
    expect(await page("field:starts", null)).toEqual(["e2", "a", "e1", "e3"]);
    expect(await page("field:starts", "2026-11-15")).toEqual(["a", "e1"]);
    expect(await page(null, null)).toEqual(["a", "e3", "e2", "e1"]);
    expect(await expectDbError(() => page("new", "2026-11-15"))).toMatch(/invalid_field_from/);
    expect(await expectDbError(() => page("field:Bad", null))).toMatch(/invalid_sort/);
  });

  it("ブログの並び順 field:<キー> は日付・日時の項目だけ。会員の一覧は p_sort が無ければその順。API で article_from_today も", async () => {
    expect(await expectDbError(() => q("update blogs set article_order = 'field:nothing' where id = $1", [blog]))).toMatch(/invalid_article_order/);
    await q("update blogs set article_order = 'field:starts', article_from_today = true where id = $1", [blog]);
    const list = (await asService(async (c) => (await c.query<{ r: { handle: string }[] }>("select articles_member_page($1, $2, 0, 12, null, $3, 0, $4) as r", [f.shopId, blog, cid, sid])).rows[0]!.r)).map((x) => x.handle);
    expect(list).toEqual(["e2", "a", "e1", "e3"]);
    // 項目を消すと並び順と合わなくなるので断る
    expect(await expectDbError(() => q("update blogs set article_fields = '[]' where id = $1", [blog]))).toMatch(/invalid_article_order/);
    const raw = `banto_${crypto.randomUUID()}`;
    const { createHash } = await import("node:crypto");
    const h = createHash("sha256").update(raw).digest("hex");
    await q("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, '{content:read,content:write}')", [f.shopId, f.ownerId, h, raw.slice(0, 12)]);
    const r = await asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select api_blog_update($1, 'events', $2) as r", [h, JSON.stringify({ article_order: "field:opens", article_from_today: false })])).rows[0]!.r);
    expect(r).toMatchObject({ article_order: "field:opens", article_from_today: false });
    expect(await expectDbError(() => asService((c) => c.query("select api_blog_update($1, 'events', $2)", [h, JSON.stringify({ article_from_today: "yes" })])))).toMatch(/invalid_article_from_today/);
  });

  it("0125 いつまで出すか: 終了日があればその値で、無ければ並び順の項目で今日以降を決める。終了日の項目は日付・日時だけ", async () => {
    await q("update blogs set article_order = 'new', article_fields = $2 where id = $1", [blog, JSON.stringify([{ key: "starts", label: "開催日", type: "date" }, { key: "opens", label: "開場", type: "datetime" }, { key: "ends", label: "終了日", type: "date" }])]);
    await add("run", { starts: "2026-11-10", ends: "2026-11-30" }, 6);
    const page = async (untilKey: string | null, untilFrom: string | null) =>
      (await asService(async (c) => (await c.query<{ r: { handle: string }[] }>("select articles_member_page($1, $2, 0, 12, null, $3, 0, $4, 'field:starts', null, '2026-11-15', $5, $6) as r", [f.shopId, blog, cid, sid, untilKey, untilFrom])).rows[0]!.r)).map((x) => x.handle);
    expect(await page(null, null)).toEqual(["a", "e1"]);
    expect(await page("ends", "2026-11-15")).toEqual(["run", "a", "e1"]);
    expect(await expectDbError(() => page("ends", null))).toMatch(/invalid_until/);
    expect(await expectDbError(() => q("update blogs set article_until = 'nothing' where id = $1", [blog]))).toMatch(/invalid_article_until/);
    await q("update blogs set article_until = 'ends' where id = $1", [blog]);
  });
});
