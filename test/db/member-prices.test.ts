import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** 会員価格（0099、docs/audiences.md「会員価格」）: 単価は DB が決める */
describe.skipIf(!dbAvailable)("会員価格（0099）", () => {
  let a: Fixture;
  let gold: string;
  let member: string;
  let lp: string;
  let goldCid: string;
  let silverCid: string;
  let catTops: string;
  let catShirts: string;
  const pool = () => getPool();
  const price = async (sku: string, cid: string | null) => (await pool().query<{ r: number }>("select banto_sku_member_price($1, $2) as r", [sku, cid])).rows[0]!.r;

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "mp-a@example.com", slug: "mp-a", publish: true, stock: 10 });
    await pool().query("update shops set settings = jsonb_build_object('modules', jsonb_build_object('audiences', true), 'members_enabled', true, 'customer_fields', $2::jsonb) where id = $1", [a.shopId, JSON.stringify([{ key: "rank", label: "ランク", type: "select", options: ["gold", "silver"] }])]);
    gold = (await pool().query<{ id: string }>("insert into audiences (shop_id, name, condition) values ($1, 'ゴールド', $2) returning id", [a.shopId, JSON.stringify({ all: [{ member: true }, { attr: "rank", in: ["gold"] }] })])).rows[0]!.id;
    member = (await pool().query<{ id: string }>("insert into audiences (shop_id, name, condition) values ($1, '会員', $2) returning id", [a.shopId, JSON.stringify({ member: true })])).rows[0]!.id;
    lp = (await pool().query<{ id: string }>("insert into audiences (shop_id, name, condition) values ($1, 'LP', $2) returning id", [a.shopId, JSON.stringify({ param: "ref", set: true })])).rows[0]!.id;
    catTops = (await pool().query<{ id: string }>("insert into categories (shop_id, slug, name) values ($1, 'tops', 'トップス') returning id", [a.shopId])).rows[0]!.id;
    catShirts = (await pool().query<{ id: string }>("insert into categories (shop_id, slug, name, parent_id) values ($1, 'shirts', 'シャツ', $2) returning id", [a.shopId, catTops])).rows[0]!.id;
    await pool().query("update products set category_id = $2, tags = '{sale}', brand = 'Banto', attributes = '{\"season\":\"ss\"}' where id = $1", [a.productId, catShirts]);
    goldCid = (await pool().query<{ id: string }>("insert into customers (shop_id, email, attributes) values ($1, 'g@example.com', '{\"rank\":\"gold\"}') returning id", [a.shopId])).rows[0]!.id;
    silverCid = (await pool().query<{ id: string }>("insert into customers (shop_id, email, attributes) values ($1, 's@example.com', '{\"rank\":\"silver\"}') returning id", [a.shopId])).rows[0]!.id;
  });
  afterAll(closePool);

  it("当てはまる決まりのうちいちばん安い単価。通常の価格（3000）より高くしない。ゲストは通常の価格", async () => {
    const add = (name: string, aud: string, extra: Record<string, unknown>) =>
      asUser(a.ownerId, (c) => c.query("insert into price_rules (shop_id, name, audience_id, product_ids, sku_ids, product_condition, price_jpy, percent_off) values ($1, $2, $3, $4, $5, $6, $7, $8)", [a.shopId, name, aud, extra["product_ids"] ?? [], extra["sku_ids"] ?? [], extra["cond"] ? JSON.stringify(extra["cond"]) : null, extra["price"] ?? null, extra["pct"] ?? null]));
    // 会員はみんな 10% 引き（親のカテゴリーで当てる → 子のカテゴリーの商品にも）
    await add("会員 10%", member, { cond: { category: [catTops] }, pct: 10 });
    expect(await price(a.skuId, silverCid)).toBe(2700);
    expect(await price(a.skuId, null)).toBe(3000);
    // ゴールドは SKU を直接 2500
    await add("ゴールド", gold, { sku_ids: [a.skuId], price: 2500 });
    expect(await price(a.skuId, goldCid)).toBe(2500);
    expect(await price(a.skuId, silverCid)).toBe(2700);
    // 通常より高い決まりは効かない
    await add("高い", member, { product_ids: [a.productId], price: 9999 });
    expect(await price(a.skuId, silverCid)).toBe(2700);
    // タグ・ブランド・商品の独自項目の条件
    await add("タグと季節", gold, { cond: { all: [{ tag: ["sale"] }, { brand: ["banto"] }, { attr: "season", in: ["SS"] }] }, pct: 50 });
    expect(await price(a.skuId, goldCid)).toBe(1500);
    // 期間外・無効は効かない
    await pool().query("update price_rules set starts_at = now() + interval '1 day' where name = 'タグと季節'");
    expect(await price(a.skuId, goldCid)).toBe(2500);
    await pool().query("update price_rules set enabled = false where name = 'ゴールド'");
    expect(await price(a.skuId, goldCid)).toBe(2700);
    // ゲストに見せる会員価格（いちばん安いもの、今効いている決まりで）
    const floor = (await asAnon((c) => c.query<{ member_price_jpy: number }>("select * from product_public_member_prices($1, $2)", [a.shopId, [a.skuId]]))).rows[0]?.member_price_jpy;
    expect(floor).toBe(2700);
    // モジュールが OFF なら効かない
    await pool().query("update shops set settings = jsonb_set(settings, '{modules,audiences}', 'false') where id = $1", [a.shopId]);
    expect(await price(a.skuId, goldCid)).toBe(3000);
    await pool().query("update shops set settings = jsonb_set(settings, '{modules,audiences}', 'true') where id = $1", [a.shopId]);
  });

  it("予約の単価を写し直す（会員の予約だけ）。決まりの形・権限・表示用の条件の拒否", async () => {
    const res = await asService(async (c) => (await c.query<{ r: string }>("select reserve_stock($1, $2::jsonb) as r", [a.shopId, JSON.stringify([{ sku_id: a.skuId, qty: 2 }])])).rows[0]!.r);
    const items = (cid: string | null) =>
      asService(async (c) => {
        await c.query("update reservations set customer_id = $2 where id = $1", [res, cid]);
        return (await c.query<{ r: { unit_price_jpy: number }[] }>("select apply_reservation_member_prices($1, $2) as r", [res, a.shopId])).rows[0]!.r;
      });
    expect((await items(null))[0]!.unit_price_jpy).toBe(3000);
    expect((await items(silverCid))[0]!.unit_price_jpy).toBe(2700);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select apply_reservation_member_prices($1, $2)", [res, a.shopId])))).toMatch(/permission denied|service_role only/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("insert into price_rules (shop_id, name, audience_id, sku_ids, price_jpy) values ($1, 'x', $2, $3, 1)", [a.shopId, lp, [a.skuId]])))).toMatch(/audience_display_only/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("insert into price_rules (shop_id, name, audience_id, price_jpy) values ($1, 'x', $2, 1)", [a.shopId, gold])))).toMatch(/price_rules_target_check/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("insert into price_rules (shop_id, name, audience_id, sku_ids, price_jpy, percent_off) values ($1, 'x', $2, $3, 1, 10)", [a.shopId, gold, [a.skuId]])))).toMatch(/price_rules_price_check/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("insert into price_rules (shop_id, name, audience_id, product_condition, price_jpy) values ($1, 'x', $2, $3, 1)", [a.shopId, gold, JSON.stringify({ color: ["red"] })])))).toMatch(/invalid_product_condition/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("update audiences set condition = $2 where id = $1", [member, JSON.stringify({ param: "ref", set: true })])))).toMatch(/audience_display_only_in_use/);
    expect(await expectDbError(() => asAnon((c) => c.query("select * from price_rules")))).toMatch(/permission denied/);
  });
});
