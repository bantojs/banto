import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0112_product_pick: 本文の「商品を並べる」で選んだ商品を書いた順に（見えない商品は飛ばす）。
 * 0113_category_media: カテゴリーの説明と画像（形は DB の制約で確かめる）
 */
describe.skipIf(!dbAvailable)("選んだ商品（0112）とカテゴリーの説明・画像（0113）", () => {
  let a: Fixture;
  let b: Fixture;
  let goldCid: string;
  let goldSid: string;
  const svc = <T>(sql: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(sql, args)).rows[0]!.r);
  const pick = async (shopId: string, slugs: string[]) =>
    (await asAnon((c) => c.query<{ r: { items: { slug: string; min_price_jpy: number | null; image: unknown }[] } }>("select product_public_pick($1, $2) as r", [shopId, slugs]))).rows[0]!.r.items;

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "pick-a@example.com", slug: "pick-a", publish: true, stock: 5 });
    b = await createShopFixture({ email: "pick-b@example.com", slug: "pick-b", publish: true, stock: 5 });
    const pool = getPool();
    await pool.query("update shops set settings = jsonb_build_object('modules', jsonb_build_object('audiences', true), 'members_enabled', true, 'customer_fields', $2::jsonb) where id = $1", [a.shopId, JSON.stringify([{ key: "rank", label: "ランク", type: "select", options: ["gold"] }])]);
    const gold = (await pool.query<{ id: string }>("insert into audiences (shop_id, name, condition) values ($1, 'ゴールド', $2) returning id", [a.shopId, JSON.stringify({ all: [{ member: true }, { attr: "rank", in: ["gold"] }] })])).rows[0]!.id;
    for (const [slug, published, audience] of [["coat", true, null], ["knit", true, null], ["draft", false, null], ["vip", true, gold]] as const) {
      const p = (await pool.query<{ id: string }>("insert into products (shop_id, slug, name, published, audience_id) values ($1, $2, $2, $3, $4) returning id", [a.shopId, slug, published, audience])).rows[0]!.id;
      await pool.query("insert into skus (shop_id, product_id, code, price_jpy) values ($1, $2, $3, 4000)", [a.shopId, p, `${slug}-1`]);
    }
    goldCid = (await pool.query<{ id: string }>("insert into customers (shop_id, email, attributes) values ($1, 'g@example.com', '{\"rank\":\"gold\"}') returning id", [a.shopId])).rows[0]!.id;
    goldSid = await svc<string>("select member_session_start($1, $2, 0, 'web', 'x', 3600) as r", [a.shopId, goldCid]);
  });
  afterAll(closePool);

  it("書いた順に返し、非公開・会員限定・無い・ほかのショップの商品は飛ばす。一覧と同じ列", async () => {
    const items = await pick(a.shopId, ["knit", "draft", "vip", "nope", "tee", "coat"]);
    expect(items.map((x) => x.slug)).toEqual(["knit", "tee", "coat"]);
    expect(items[0]!.min_price_jpy).toBe(4000);
    expect(items[0]).toHaveProperty("image");
    // ほかのショップの slug（b にも tee がある）は a の行だけ
    expect((await pick(b.shopId, ["coat", "tee"])).map((x) => x.slug)).toEqual(["tee"]);
    // 非公開のショップは空
    await getPool().query("update shops set published = false where id = $1", [b.shopId]);
    expect(await pick(b.shopId, ["tee"])).toEqual([]);
    expect(await pick(a.shopId, [])).toEqual([]);
  });

  it("101 個からは断る。会員の経路は service_role だけで、合う会員には会員限定の商品も返す", async () => {
    expect(await expectDbError(() => pick(a.shopId, Array.from({ length: 101 }, (_, i) => `p${i}`)))).toMatch(/too_many_slugs/);
    const member = async (sid: string) => (await svc<{ items: { slug: string }[] }>("select product_member_pick($1, $2, 0, $3, $4) as r", [a.shopId, goldCid, sid, ["vip", "coat"]])).items.map((x) => x.slug);
    expect(await member(goldSid)).toEqual(["vip", "coat"]);
    // 切れたセッションはゲストと同じ
    expect(await member("00000000-0000-0000-0000-000000000000")).toEqual(["coat"]);
    expect(await expectDbError(() => asAnon((c) => c.query("select product_member_pick($1, $2, 0, $3, $4)", [a.shopId, goldCid, goldSid, ["vip"]])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asAnon((c) => c.query("select banto_product_pick($1, $2, '{}')", [a.shopId, ["coat"]])))).toMatch(/permission denied/);
  });

  it("カテゴリーの説明と画像: 運営者が書け、公開中のショップは匿名で読める。鍵はこのショップの categories/ だけ", async () => {
    const cat = await asUser(a.ownerId, async (c) => (await c.query<{ id: string }>("insert into categories (shop_id, slug, name) values ($1, 'outer', 'アウター') returning id", [a.shopId])).rows[0]!.id);
    const key = `categories/${a.shopId}/0123456789abcdef.webp`;
    await asUser(a.ownerId, (c) => c.query("update categories set description = $2, image = $3 where id = $1", [cat, "秋冬の羽織り", JSON.stringify({ key, width: 1600, height: 900 })]));
    const row = (await asAnon((c) => c.query<{ description: string; image: { key: string } }>("select description, image from categories where id = $1", [cat]))).rows[0]!;
    expect(row.description).toBe("秋冬の羽織り");
    expect(row.image.key).toBe(key);
    const bad = async (image: unknown) => expectDbError(() => asUser(a.ownerId, (c) => c.query("update categories set image = $2 where id = $1", [cat, JSON.stringify(image)])));
    expect(await bad({ key: `categories/${b.shopId}/0123456789abcdef.webp`, width: 10, height: 10 })).toMatch(/categories_image_check/);
    expect(await bad({ key: `products/${a.shopId}/0123456789abcdef.webp`, width: 10, height: 10 })).toMatch(/categories_image_check/);
    expect(await bad({ key, width: 5000, height: 10 })).toMatch(/categories_image_check/);
    expect(await bad({ key })).toMatch(/categories_image_check/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("update categories set description = $2 where id = $1", [cat, "あ".repeat(2001)])))).toMatch(/categories_description_check/);
    // ほかのショップの運営者は書けない（RLS で 0 行）
    const n = await asUser(b.ownerId, async (c) => (await c.query("update categories set description = 'x' where id = $1", [cat])).rowCount);
    expect(n).toBe(0);
  });
});
