import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** 会員限定のページ・記事（0100、docs/audiences.md「会員限定のページ・記事」） */
describe.skipIf(!dbAvailable)("会員限定のページ・記事（0100）", () => {
  let a: Fixture;
  let gold: string;
  let lp: string;
  let blog: string;
  let goldCid: string;
  let silverCid: string;
  let goldSid: string;
  let silverSid: string;
  const svc = <T>(sql: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(sql, args)).rows[0]!.r);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "ac-a@example.com", slug: "ac-a", publish: true });
    const pool = getPool();
    await pool.query("update shops set settings = jsonb_build_object('modules', jsonb_build_object('audiences', true, 'pages', true, 'blog', true), 'members_enabled', true, 'customer_fields', $2::jsonb) where id = $1", [a.shopId, JSON.stringify([{ key: "rank", label: "ランク", type: "select", options: ["gold", "silver"] }])]);
    gold = (await pool.query<{ id: string }>("insert into audiences (shop_id, name, condition) values ($1, 'ゴールド', $2) returning id", [a.shopId, JSON.stringify({ all: [{ member: true }, { attr: "rank", in: ["gold"] }] })])).rows[0]!.id;
    lp = (await pool.query<{ id: string }>("insert into audiences (shop_id, name, condition) values ($1, 'LP', $2) returning id", [a.shopId, JSON.stringify({ param: "ref", set: true })])).rows[0]!.id;
    for (const [h, aud, hide] of [["about", null, false], ["vip", gold, false], ["secret", gold, true]] as const) {
      await pool.query("insert into pages (shop_id, handle, title, body, published, nav, audience_id, audience_hide) values ($1, $2, $2, 'b', true, 'header', $3, $4)", [a.shopId, h, aud, hide]);
    }
    blog = (await pool.query<{ id: string }>("insert into blogs (shop_id, handle, title) values ($1, 'news', 'お知らせ') returning id", [a.shopId])).rows[0]!.id;
    for (const [h, aud] of [["hello", null], ["vip-news", gold]] as const) {
      await pool.query("insert into articles (shop_id, blog_id, handle, title, body, published, published_at, audience_id) values ($1, $2, $3, $3, 'b', true, now() - interval '1 hour', $4)", [a.shopId, blog, h, aud]);
    }
    goldCid = (await pool.query<{ id: string }>("insert into customers (shop_id, email, attributes) values ($1, 'g@example.com', '{\"rank\":\"gold\"}') returning id", [a.shopId])).rows[0]!.id;
    silverCid = (await pool.query<{ id: string }>("insert into customers (shop_id, email, attributes) values ($1, 's@example.com', '{\"rank\":\"silver\"}') returning id", [a.shopId])).rows[0]!.id;
    goldSid = await svc<string>("select member_session_start($1, $2, 0, 'web', 'x', 3600) as r", [a.shopId, goldCid]);
    silverSid = await svc<string>("select member_session_start($1, $2, 0, 'web', 'x', 3600) as r", [a.shopId, silverCid]);
  });
  afterAll(closePool);

  it("匿名: 会員限定のページ・記事は読めず、メニューにも出ない。URL では「会員の方だけ」（存在も隠すなら null）", async () => {
    const pages = (await asAnon((c) => c.query<{ handle: string }>("select handle from pages where shop_id = $1", [a.shopId]))).rows.map((r) => r.handle);
    expect(pages).toEqual(["about"]);
    const arts = (await asAnon((c) => c.query<{ handle: string }>("select handle from articles where shop_id = $1", [a.shopId]))).rows.map((r) => r.handle);
    expect(arts).toEqual(["hello"]);
    const nav = (await asAnon((c) => c.query<{ r: { pages_nav: { handle: string }[] } }>("select shop_public_get('ac-a') as r"))).rows[0]!.r.pages_nav.map((p) => p.handle);
    expect(nav).toEqual(["about"]);
    const gate = async (kind: string, handle: string) => (await asAnon((c) => c.query<{ r: string | null }>("select content_public_gate($1, $2, $3, $4) as r", [a.shopId, kind, blog, handle]))).rows[0]!.r;
    expect(await gate("page", "vip")).toBe("members");
    expect(await gate("page", "secret")).toBeNull();
    expect(await gate("article", "vip-news")).toBe("members");
    expect(await gate("page", "about")).toBeNull();
  });

  it("会員: 合う会員は読める・一覧にも出る。合わない会員・切れたセッションは読めない。表示用の条件は使えない", async () => {
    const page = (h: string, cid: string, sid: string) => svc<{ handle: string } | null>("select page_member_get($1, $2, $3, 0, $4) as r", [a.shopId, h, cid, sid]);
    expect((await page("vip", goldCid, goldSid))?.handle).toBe("vip");
    expect(await page("vip", silverCid, silverSid)).toBeNull();
    expect(await page("vip", goldCid, silverSid)).toBeNull();
    expect((await page("about", silverCid, silverSid))?.handle).toBe("about");
    const art = (cid: string, sid: string) => svc<{ handle: string } | null>("select article_member_get($1, $2, 'vip-news', $3, 0, $4) as r", [a.shopId, blog, cid, sid]);
    expect((await art(goldCid, goldSid))?.handle).toBe("vip-news");
    expect(await art(silverCid, silverSid)).toBeNull();
    const list = async (cid: string, sid: string) => (await svc<{ handle: string }[]>("select articles_member_page($1, $2, 0, 12, null, $3, 0, $4) as r", [a.shopId, blog, cid, sid])).map((x) => x.handle).sort();
    expect(await list(goldCid, goldSid)).toEqual(["hello", "vip-news"]);
    expect(await list(silverCid, silverSid)).toEqual(["hello"]);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("update pages set audience_id = $2 where shop_id = $1 and handle = 'about'", [a.shopId, lp])))).toMatch(/audience_display_only/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("update audiences set condition = $2 where id = $1", [gold, JSON.stringify({ param: "ref", set: true })])))).toMatch(/audience_display_only_in_use/);
    expect(await expectDbError(() => asAnon((c) => c.query("select page_member_get($1, 'vip', $2, 0, $3)", [a.shopId, goldCid, goldSid])))).toMatch(/permission denied/);
  });

  it("ブログをまたぐ一覧（articles_member_multi、0140）: 選んだブログの記事を新しい順に 1 つの並びで。会員限定は合う会員だけ・手で並べた順は受けない・service_role だけ", async () => {
    const pool = getPool();
    const staff = (await pool.query<{ id: string }>("insert into blogs (shop_id, handle, title) values ($1, 'staff', 'スタッフ') returning id", [a.shopId])).rows[0]!.id;
    const other = (await pool.query<{ id: string }>("insert into blogs (shop_id, handle, title) values ($1, 'other', 'ほか') returning id", [a.shopId])).rows[0]!.id;
    await pool.query("insert into articles (shop_id, blog_id, handle, title, body, published, published_at) values ($1, $2, 'staff-1', 'staff-1', 'b', true, now() - interval '10 minutes')", [a.shopId, staff]);
    await pool.query("insert into articles (shop_id, blog_id, handle, title, body, published, published_at) values ($1, $2, 'other-1', 'other-1', 'b', true, now() - interval '5 minutes')", [a.shopId, other]);
    const multi = async (cid: string, sid: string, ids: string[], sort: string | null = null) =>
      (await svc<{ handle: string; blog_id: string }[]>("select articles_member_multi($1, $2::uuid[], 0, 12, null, $3, 0, $4, $5) as r", [a.shopId, ids, cid, sid, sort])).map((x) => x.handle);
    // news の記事（1 時間前）より staff-1（10 分前）が新しい。other は選んでいない
    const gold2 = await multi(goldCid, goldSid, [blog, staff]);
    expect(gold2[0]).toBe("staff-1");
    expect(gold2.slice(1).sort()).toEqual(["hello", "vip-news"]);
    expect((await multi(silverCid, silverSid, [blog, staff])).sort()).toEqual(["hello", "staff-1"]);
    expect(await multi(silverCid, silverSid, [blog, staff, other], "title")).toEqual(["hello", "other-1", "staff-1"]);
    expect(await expectDbError(() => multi(goldCid, goldSid, [blog, staff], "manual"))).toMatch(/invalid_sort/);
    expect(await expectDbError(() => multi(goldCid, goldSid, []))).toMatch(/invalid_blogs/);
    expect(await expectDbError(() => asAnon((c) => c.query("select articles_member_multi($1, $2::uuid[], 0, 12, null, $3, 0, $4)", [a.shopId, [blog], goldCid, goldSid])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select articles_member_multi($1, $2::uuid[], 0, 12, null, $3, 0, $4)", [a.shopId, [blog], goldCid, goldSid])))).toMatch(/permission denied/);
  });
});
