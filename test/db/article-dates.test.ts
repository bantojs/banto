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
});
