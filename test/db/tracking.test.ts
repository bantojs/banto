import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

describe.skipIf(!dbAvailable)("送り状番号・税区分の取り込み・復元の続き（0022_tracking）", () => {
  let f: Fixture;
  let other: Fixture;
  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "tr@example.com", slug: "tr-shop", publish: true });
    other = await createShopFixture({ email: "tr-o@example.com", slug: "tr-other", publish: true });
    const pool = getPool();
    for (const [n, st] of [[3001, "paid"], [3002, "shipped"], [3003, "cancelled"]] as const) {
      const o = (await pool.query<{ id: string }>("insert into orders (shop_id, status, total_jpy, shipping_jpy, customer_email, number) values ($1, $2, 1000, 0, 'b@example.com', $3) returning id", [f.shopId, st, n])).rows[0]!;
      await pool.query("insert into order_items (shop_id, order_id, sku_id, qty, unit_price_jpy) values ($1, $2, $3, 1, 1000)", [f.shopId, o.id, f.skuId]);
    }
  });
  afterAll(closePool);

  const ship = (owner: string, items: unknown[], shop = f.shopId) =>
    asUser(owner, async (c) => (await c.query<{ r: Record<string, unknown> }>("select ship_orders($1, $2::jsonb) as r", [shop, JSON.stringify(items)])).rows[0]!.r);

  it("ship_orders: 支払い済みは発送済みにして order.shipped を送り、発送済みは番号だけ入れ直す。区切りは外す", async () => {
    await getPool().query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'x', 'https://example.com/h', '{order.shipped}')", [f.shopId]);
    const r = await ship(f.ownerId, [
      { number: "3001", carrier: "yamato", tracking: "1234-5678-9012" },
      { number: 3002, carrier: "sagawa", tracking: "4000 1111 2222" },
      { number: 3003, carrier: "yamato", tracking: "999988887777" },
      { number: 9999, carrier: "yamato", tracking: "999988887777" },
      { number: 3001, carrier: "fedex", tracking: "1" },
    ]);
    expect(r).toEqual({ shipped: 1, updated: 1, invalid: 1, missing: [3003, 9999] });
    const rows = (await getPool().query("select number, status, tracking_carrier, tracking_number, shipped_at is not null as shipped from orders where shop_id = $1 order by number", [f.shopId])).rows;
    expect(rows).toEqual([
      { number: 3001, status: "shipped", tracking_carrier: "yamato", tracking_number: "123456789012", shipped: true },
      { number: 3002, status: "shipped", tracking_carrier: "sagawa", tracking_number: "400011112222", shipped: false },
      { number: 3003, status: "cancelled", tracking_carrier: null, tracking_number: null, shipped: false },
    ]);
    // 通知は発送済みにした 1 件だけ。ペイロードにお問い合わせ番号を載せない
    const hooks = (await getPool().query<{ event: string; payload: Record<string, unknown> }>("select event, payload from hook_deliveries where shop_id = $1", [f.shopId])).rows;
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ event: "order.shipped", payload: { order_number: 3001, status: "shipped" } });
    expect(JSON.stringify(hooks[0]!.payload)).not.toContain("123456789012");
    // 他人のショップ・購入者は呼べない
    expect(await expectDbError(() => ship(other.ownerId, []))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => asAnon((c) => c.query("select ship_orders($1, '[]'::jsonb)", [f.shopId])))).toMatch(/permission denied/);
  });

  it("注文照会とメールの連絡先にお問い合わせ番号が載る。連絡先には明細の税率と値引き・ショップの税の設定も載る", async () => {
    const r = await asAnon(async (c) => (await c.query<{ r: Record<string, unknown> }>("select lookup_order($1, 3001, 'b@example.com') as r", [f.shopId])).rows[0]!.r);
    expect(r["tracking"]).toEqual({ carrier: "yamato", number: "123456789012" });
    expect(JSON.stringify(r)).not.toContain("shipping_address");
    const id = (await getPool().query<{ id: string }>("select id from orders where shop_id = $1 and number = 3001", [f.shopId])).rows[0]!.id;
    await getPool().query("update shops set settings = settings || '{\"tax_rate_reduced\": 8, \"tax_rounding\": \"ceil\"}' where id = $1", [f.shopId]);
    const ct = await asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select order_contact($1, $2) as r", [id, f.shopId])).rows[0]!.r);
    expect(ct).toMatchObject({ tracking: { carrier: "yamato" }, shipping_tax_rate: 10, items: [{ qty: 1, tax_rate: 10, discount_jpy: 0 }], shop: { tax: { tax_rate_reduced: 8, tax_rounding: "ceil" } } });
  });

  it("import_tax_classes: slug で税区分を入れる。区分の値が違う行は飛ばす。他人のショップには入れられない", async () => {
    const slug = (await getPool().query<{ slug: string }>("select slug from products where id = $1", [f.productId])).rows[0]!.slug;
    const run = (owner: string, items: unknown[], shop = f.shopId) => asUser(owner, async (c) => (await c.query<{ n: number }>("select import_tax_classes($1, $2::jsonb) as n", [shop, JSON.stringify(items)])).rows[0]!.n);
    expect(await run(f.ownerId, [{ slug, tax_class: "reduced" }, { slug, tax_class: "zero" }, { slug: "nope", tax_class: "exempt" }])).toBe(1);
    expect((await getPool().query("select tax_class from products where id = $1", [f.productId])).rows[0].tax_class).toBe("reduced");
    expect(await run(f.ownerId, [{ slug, tax_class: "reduced" }])).toBe(0);
    expect(await expectDbError(() => run(other.ownerId, [{ slug, tax_class: "exempt" }]))).toMatch(/shop_not_found/);
  });

  it("restore_commerce: クーポン（対象の id の振り直し・使用済みの数）、発行済み（会員が戻らないものは飛ばす）、注文と明細の値引き・配送の指定・お問い合わせ番号", async () => {
    const pool = getPool();
    // 書き出しの元（旧 id）
    const oldProduct = "11111111-1111-4111-8111-111111111111";
    const oldSku = "22222222-2222-4222-8222-222222222222";
    const oldCampaign = "33333333-3333-4333-8333-333333333333";
    const oldOrder = "44444444-4444-4444-8444-444444444444";
    const member = "55555555-5555-4555-8555-555555555555";
    const gone = "66666666-6666-4666-8666-666666666666";
    const tables = {
      products: [{ id: oldProduct, slug: "tea", name: "お茶", published: true }],
      skus: [{ id: oldSku, product_id: oldProduct, code: "TEA-1", price_jpy: 1000 }],
      inventory: [],
      product_images: [],
      customers: [{ id: member, email: "m@example.com" }],
      orders: [{ id: oldOrder, number: 1001, status: "shipped", total_jpy: 900, shipping_jpy: 0, discount_jpy: 100, discounts: [{ code: "SALE", name: "セール", amount_jpy: 100 }], amount_paid_jpy: 900, delivery: { date: "2026-10-20", slot: "am" }, tracking_carrier: "japanpost", tracking_number: "AB123456789JP" }],
      order_items: [{ order_id: oldOrder, sku_id: oldSku, qty: 1, unit_price_jpy: 1000, discount_jpy: 100 }],
      hook_endpoints: [],
      categories: [],
      coupon_campaigns: [{ id: oldCampaign, name: "セール", code: "SALE", kind: "fixed", value: 100, usage_limit: 5, conditions: { product_ids: [oldProduct, "77777777-7777-4777-8777-777777777777"] }, active: true, claimable: true }],
      coupon_slots: [{ campaign_id: oldCampaign, status: "used" }, { campaign_id: oldCampaign, status: "used" }],
      coupon_grants: [
        { campaign_id: oldCampaign, code: "AAAA-BBBB-CCCC", customer_id: member, status: "used", used_at: "2026-10-01T00:00:00Z" },
        { campaign_id: oldCampaign, code: "DDDD-EEEE-FFFF", customer_id: null, status: "held" },
        { campaign_id: oldCampaign, code: "GGGG-HHHH-JJJJ", customer_id: gone, status: "available" },
      ],
    };
    const dst = await asUser(f.ownerId, async (c) => (await c.query<{ id: string }>("insert into shops (owner_id, slug, name) values ($1, 'tr-restore', 'Dst') returning id", [f.ownerId])).rows[0]!.id);
    await asService((c) => c.query("select restore_shop_data($1, $2::jsonb)", [dst, JSON.stringify(tables)]));
    const counts = await asService(async (c) => (await c.query<{ r: Record<string, number> }>("select restore_commerce($1, $2::jsonb) as r", [dst, JSON.stringify(tables)])).rows[0]!.r);
    expect(counts).toEqual({ coupon_campaigns: 1, coupon_grants: 2, coupon_grants_skipped: 1, order_discounts: 1, item_discounts: 1 });

    const newProduct = (await pool.query<{ id: string }>("select id from products where shop_id = $1 and slug = 'tea'", [dst])).rows[0]!.id;
    const camp = (await pool.query<{ id: string; conditions: { product_ids: string[] }; claimable: boolean }>("select id, conditions, claimable from coupon_campaigns where shop_id = $1", [dst])).rows[0]!;
    expect(camp.conditions.product_ids).toEqual([newProduct]);
    expect(camp.claimable).toBe(true);
    const slots = (await pool.query("select status, count(*)::int as n from coupon_slots where campaign_id = $1 group by status order by status", [camp.id])).rows;
    expect(slots).toEqual([{ status: "free", n: 3 }, { status: "used", n: 2 }]);
    const grants = (await pool.query("select code, status, customer_id from coupon_grants where shop_id = $1 order by code", [dst])).rows;
    expect(grants).toEqual([
      { code: "AAAA-BBBB-CCCC", status: "used", customer_id: member },
      { code: "DDDD-EEEE-FFFF", status: "available", customer_id: null },
    ]);
    const o = (await pool.query("select discount_jpy, amount_paid_jpy, delivery, tracking_carrier, tracking_number, discounts from orders where shop_id = $1 and number = 1001", [dst])).rows[0];
    expect(o).toEqual({ discount_jpy: 100, amount_paid_jpy: 900, delivery: { date: "2026-10-20", slot: "am" }, tracking_carrier: "japanpost", tracking_number: "AB123456789JP", discounts: [{ code: "SALE", name: "セール", amount_jpy: 100 }] });
    expect((await pool.query("select discount_jpy from order_items where shop_id = $1", [dst])).rows[0].discount_jpy).toBe(100);

    // 2 回目はクーポンを重ねない
    const again = await asService(async (c) => (await c.query<{ r: Record<string, number> }>("select restore_commerce($1, $2::jsonb) as r", [dst, JSON.stringify(tables)])).rows[0]!.r);
    expect(again["coupon_campaigns"]).toBe(0);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select restore_commerce($1, '{}'::jsonb)", [dst])))).toMatch(/permission denied/);
  });
});
