import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** 会員限定の商品（0098、docs/audiences.md「会員限定の商品」）: 匿名の RLS と公開の関数・会員の読み取り・買えるか */
describe.skipIf(!dbAvailable)("会員限定の商品（0098）", () => {
  let a: Fixture;
  let gold: string;
  let lp: string;
  let goldCid: string;
  let silverCid: string;
  let goldSid: string;
  let silverSid: string;
  const svc = <T>(sql: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(sql, args)).rows[0]!.r);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "ap-a@example.com", slug: "ap-a", publish: true, stock: 5 });
    const pool = getPool();
    await pool.query("update shops set settings = jsonb_build_object('modules', jsonb_build_object('audiences', true), 'customer_fields', $2::jsonb) where id = $1", [a.shopId, JSON.stringify([{ key: "rank", label: "ランク", type: "select", options: ["gold", "silver"] }])]);
    gold = (await pool.query<{ id: string }>("insert into audiences (shop_id, name, condition) values ($1, 'ゴールド', $2) returning id", [a.shopId, JSON.stringify({ all: [{ member: true }, { attr: "rank", in: ["gold"] }] })])).rows[0]!.id;
    lp = (await pool.query<{ id: string }>("insert into audiences (shop_id, name, condition) values ($1, 'LP', $2) returning id", [a.shopId, JSON.stringify({ param: "ref", set: true })])).rows[0]!.id;
    // 見せない（hide）の商品・買えない（buy）の商品・存在も隠す商品
    for (const [slug, mode, hide] of [["vip", "hide", false], ["early", "buy", false], ["secret", "hide", true]] as const) {
      const p = (await pool.query<{ id: string }>("insert into products (shop_id, slug, name, published, audience_id, audience_mode, audience_hide, tags) values ($1, $2, $2, true, $3, $4, $5, '{vip}') returning id", [a.shopId, slug, gold, mode, hide])).rows[0]!.id;
      const k = (await pool.query<{ id: string }>("insert into skus (shop_id, product_id, code, price_jpy) values ($1, $2, $3, 5000) returning id", [a.shopId, p, `${slug}-1`])).rows[0]!.id;
      await pool.query("update inventory set available = 3 where sku_id = $1", [k]);
    }
    goldCid = (await pool.query<{ id: string }>("insert into customers (shop_id, email, attributes) values ($1, 'g@example.com', '{\"rank\":\"gold\"}') returning id", [a.shopId])).rows[0]!.id;
    silverCid = (await pool.query<{ id: string }>("insert into customers (shop_id, email, attributes) values ($1, 's@example.com', '{\"rank\":\"silver\"}') returning id", [a.shopId])).rows[0]!.id;
    await pool.query("update shops set settings = settings || '{\"members_enabled\": true}' where id = $1", [a.shopId]);
    goldSid = await svc<string>("select member_session_start($1, $2, 0, 'web', 'x', 3600) as r", [a.shopId, goldCid]);
    silverSid = await svc<string>("select member_session_start($1, $2, 0, 'web', 'x', 3600) as r", [a.shopId, silverCid]);
  });
  afterAll(closePool);

  it("匿名: 見せない商品は一覧・詳細・件数・サイトマップ・フィード・在庫・SKU・画像から消え、buy の商品は見える", async () => {
    const slugs = (await asAnon((c) => c.query<{ slug: string }>("select slug from products where shop_id = $1 order by slug", [a.shopId]))).rows.map((r) => r.slug);
    expect(slugs).toEqual(["early", "tee"]);
    const list = (await asAnon((c) => c.query<{ r: { items: { slug: string }[] } }>("select product_public_list($1) as r", [a.shopId]))).rows[0]!.r.items.map((i) => i.slug).sort();
    expect(list).toEqual(["early", "tee"]);
    expect((await asAnon((c) => c.query<{ r: unknown }>("select product_public_get($1, 'vip') as r", [a.shopId]))).rows[0]!.r).toBeNull();
    expect((await asAnon((c) => c.query<{ r: { audience_mode: string } }>("select product_public_get($1, 'early') as r", [a.shopId]))).rows[0]!.r.audience_mode).toBe("buy");
    expect((await asAnon((c) => c.query<{ r: number }>("select product_public_count($1) as r", [a.shopId]))).rows[0]!.r).toBe(2);
    const skus = (await asAnon((c) => c.query<{ code: string }>("select code from skus where shop_id = $1 order by code", [a.shopId]))).rows.map((r) => r.code);
    expect(skus).toEqual(["TEE-M", "early-1"]);
    // タグの件数に見せない商品を数えない（vip のタグは early の 1 件だけ）
    const facets = (await asAnon((c) => c.query<{ r: { tags: { tag: string; count: number }[] } }>("select product_public_facets($1) as r", [a.shopId]))).rows[0]!.r;
    expect(facets.tags.find((t) => t.tag === "vip")?.count).toBe(1);
    // ゲストの URL: 存在も隠す商品は null（404）、そうでなければ「会員の方だけ」
    const gate = async (slug: string) => (await asAnon((c) => c.query<{ r: string | null }>("select product_public_gate($1, $2) as r", [a.shopId, slug]))).rows[0]!.r;
    expect(await gate("vip")).toBe("members");
    expect(await gate("secret")).toBeNull();
    expect(await gate("tee")).toBeNull();
  });

  it("会員: 合う会員には見せない商品も一覧と詳細に出て買える。合わない会員・切れたセッションはゲストと同じ", async () => {
    const list = async (cid: string, sid: string) => (await svc<{ items: { slug: string }[] }>("select product_member_list($1, $2, 0, $3) as r", [a.shopId, cid, sid])).items.map((i) => i.slug).sort();
    expect(await list(goldCid, goldSid)).toEqual(["early", "secret", "tee", "vip"]);
    expect(await list(silverCid, silverSid)).toEqual(["early", "tee"]);
    expect(await list(goldCid, silverSid)).toEqual(["early", "tee"]);
    const get = (slug: string, cid: string, sid: string) => svc<{ product: { slug: string }; skus: { available: number }[]; purchasable: boolean } | null>("select product_member_get($1, $2, $3, 0, $4) as r", [a.shopId, slug, cid, sid]);
    const vip = await get("vip", goldCid, goldSid);
    expect(vip?.product.slug).toBe("vip");
    expect(vip?.skus[0]?.available).toBe(3);
    expect(vip?.purchasable).toBe(true);
    expect(await get("vip", silverCid, silverSid)).toBeNull();
    expect((await get("early", silverCid, silverSid))?.purchasable).toBe(false);
    expect((await get("tee", silverCid, silverSid))?.purchasable).toBe(true);
    const skuIds = (await getPool().query<{ id: string }>("select id from skus where shop_id = $1", [a.shopId])).rows.map((r) => r.id);
    const cart = async (cid: string, sid: string) => (await svc<{ sku: { code: string }; purchasable: boolean }[]>("select product_member_skus($1, $2, 0, $3, $4) as r", [a.shopId, cid, sid, skuIds])).map((x) => `${x.sku.code}:${x.purchasable}`).sort();
    expect(await cart(goldCid, goldSid)).toEqual(["TEE-M:true", "early-1:true", "secret-1:true", "vip-1:true"]);
    expect(await cart(silverCid, silverSid)).toEqual(["TEE-M:true", "early-1:false"]);
    // 独自項目が変われば、すぐに DB の判定が変わる
    await getPool().query("update customers set attributes = '{\"rank\":\"gold\"}' where id = $1", [silverCid]);
    expect(await list(silverCid, silverSid)).toContain("vip");
    await getPool().query("update customers set attributes = '{\"rank\":\"silver\"}' where id = $1", [silverCid]);
  });

  it("表示用の条件（URL のパラメータ）は商品に付けられない・付いている条件を表示用にできない・使われている条件は消せない。service_role だけ", async () => {
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("update products set audience_id = $2 where id = $1", [a.productId, lp])))).toMatch(/audience_display_only/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("update audiences set condition = $2 where id = $1", [gold, JSON.stringify({ param: "ref", set: true })])))).toMatch(/audience_display_only_in_use/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("delete from audiences where id = $1", [gold])))).toMatch(/foreign key|violates/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select product_member_get($1, 'vip', $2, 0, $3)", [a.shopId, goldCid, goldSid])))).toMatch(/permission denied|service_role only/);
    expect(await expectDbError(() => asAnon((c) => c.query("select product_member_list($1, $2, 0, $3)", [a.shopId, goldCid, goldSid])))).toMatch(/permission denied/);
  });
});
