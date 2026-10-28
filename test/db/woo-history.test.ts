import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

describe.skipIf(!dbAvailable)("WooCommerce からの移行の続き（0023_woo_history）", () => {
  let f: Fixture;
  let other: Fixture;
  let member: string;
  let skuCode: string;
  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "wh@example.com", slug: "wh-shop", publish: true, stock: 10 });
    other = await createShopFixture({ email: "wh-o@example.com", slug: "wh-other", publish: true });
    const pool = getPool();
    member = (await pool.query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'm@example.com') returning id", [f.shopId])).rows[0]!.id;
    skuCode = (await pool.query<{ code: string }>("select code from skus where id = $1", [f.skuId])).rows[0]!.code;
    // 会員の注文で配るクーポン（取り込んだ注文では配らないことを確かめる）
    await pool.query("insert into coupon_campaigns (shop_id, name, kind, value, auto_grant) values ($1, '次回', 'fixed', 100, 'after_purchase')", [f.shopId]);
  });
  afterAll(closePool);

  const importOrders = (owner: string, orders: unknown[], shop = f.shopId) =>
    asUser(owner, async (c) => (await c.query<{ r: Record<string, unknown> }>("select import_orders($1, $2::jsonb) as r", [shop, JSON.stringify(orders)])).rows[0]!.r);

  const wcOrder = (n: number, extra: Record<string, unknown> = {}) => ({
    ref: `woocommerce:${n}`,
    number: n,
    status: "shipped",
    created_at: "2026-01-10T03:00:00Z",
    shipped_at: "2026-01-12T03:00:00Z",
    total_jpy: 2560,
    shipping_jpy: 660,
    discount_jpy: 100,
    shipping_tax_rate: "10",
    customer_email: "M@example.com",
    customer_name: "山田 花子",
    shipping_address: { state: "東京都", line1: "1-1" },
    payment_ref: "pi_1",
    items: [
      { sku: skuCode, name: "お茶（旧名）", variant: null, qty: 1, unit_price_jpy: 1000, discount_jpy: 100, tax_rate: "8" },
      { sku: "GONE-1", name: "販売終了の品", variant: "赤", qty: 1, unit_price_jpy: 1000, tax_rate: "10" },
    ],
    ...extra,
  });

  it("import_orders: 番号のまま入れ、会員に結び、SKU の無い明細は品名で残す。連番は続きから。在庫・自動発行には触らない", async () => {
    const pool = getPool();
    const before = (await pool.query<{ available: number }>("select available from inventory where sku_id = $1", [f.skuId])).rows[0]!.available;
    const r = await importOrders(f.ownerId, [wcOrder(5001), wcOrder(5002, { status: "refunded", customer_email: "guest@example.com" }), { ref: "x", number: "abc" }]);
    expect(r).toEqual({ created: 2, existing: 0, invalid: 1, items: 4, items_without_sku: 2, conflicts: [] });
    const o = (await pool.query("select status, customer_id, customer_email, payment_provider, shipped_at is not null as shipped, discount_jpy, shipping_tax_rate, created_at from orders where shop_id = $1 and number = 5001", [f.shopId])).rows[0];
    expect(o).toMatchObject({ status: "shipped", customer_id: member, customer_email: "m@example.com", payment_provider: "woocommerce", shipped: true, discount_jpy: 100 });
    expect(Number(o.shipping_tax_rate)).toBe(10);
    expect((o.created_at as Date).toISOString()).toBe("2026-01-10T03:00:00.000Z");
    const items = (await pool.query("select oi.sku_id is not null as has_sku, oi.item_name, oi.item_variant, oi.tax_rate, oi.discount_jpy from order_items oi join orders o on o.id = oi.order_id where o.shop_id = $1 and o.number = 5001 order by item_name", [f.shopId])).rows;
    expect(items).toEqual([
      { has_sku: true, item_name: "お茶（旧名）", item_variant: null, tax_rate: "8.00", discount_jpy: 100 },
      { has_sku: false, item_name: "販売終了の品", item_variant: "赤", tax_rate: "10.00", discount_jpy: 0 },
    ]);
    expect((await pool.query("select order_seq from shops where id = $1", [f.shopId])).rows[0].order_seq).toBe(5002);
    expect((await pool.query<{ available: number }>("select available from inventory where sku_id = $1", [f.skuId])).rows[0]!.available).toBe(before);
    expect((await pool.query("select count(*)::int as n from coupon_grants where shop_id = $1", [f.shopId])).rows[0].n).toBe(0);
    expect((await pool.query("select count(*)::int as n from hook_deliveries where shop_id = $1", [f.shopId])).rows[0].n).toBe(0);

    // 2 回目は重ねない。同じ番号の別の注文は飛ばして知らせる
    expect(await importOrders(f.ownerId, [wcOrder(5001), wcOrder(5002, { ref: "woocommerce:other" })])).toMatchObject({ created: 0, existing: 1, conflicts: [5002] });
    // 他人のショップには入れられない
    expect(await expectDbError(() => importOrders(other.ownerId, [wcOrder(6001)]))).toMatch(/shop_not_found/);
  });

  it("取り込んだ注文は注文照会・会員の注文で取り込んだ時点の品名で見える", async () => {
    const r = await asService(async (c) => (await c.query<{ r: { items: { name: string; sku: string }[] } }>("select lookup_order($1, 5001, 'm@example.com') as r", [f.shopId])).rows[0]!.r);
    expect(r.items.map((i) => i.name).sort()).toEqual(["お茶（旧名）", "販売終了の品"]);
    expect(r.items.find((i) => i.name === "販売終了の品")!.sku).toBe("赤");
    const m = await asService(async (c) => (await c.query<{ r: { number: number } }>("select member_order($1, $2, 0, 5001) as r", [f.shopId, member])).rows[0]!.r);
    expect(m).toMatchObject({ number: 5001 });
  });

  it("import_coupon_usage: 1 人ごとの使用回数を、ゲストと会員の両方の識別子で数に入れる。入れ直しても重ならない", async () => {
    const pool = getPool();
    const camp = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into coupon_campaigns (shop_id, name, code, kind, value, per_customer_limit) values ($1, '初回', 'FIRST', 'fixed', 500, 1) returning id", [f.shopId]))).rows[0]!.id;
    const run = (emails: string[], reset: boolean) => asUser(f.ownerId, async (c) => (await c.query<{ r: Record<string, unknown> }>("select import_coupon_usage($1, 'first', $2::text[], $3) as r", [f.shopId, emails, reset])).rows[0]!.r);
    expect(await run(["M@example.com", "guest@example.com", "not-an-email"], true)).toEqual({ found: true, uses: 2 });
    expect(await run(["M@example.com", "guest@example.com"], true)).toEqual({ found: true, uses: 2 });
    const subjects = (await pool.query<{ subject: string }>("select subject from coupon_redemptions where campaign_id = $1 order by subject", [camp])).rows.map((x) => x.subject);
    const sha = (e: string) => `e:${createHash("sha256").update(e).digest("hex")}`;
    expect(subjects.sort()).toEqual([`c:${member}`, sha("guest@example.com"), sha("m@example.com")].sort());
    // 判定（coupon_lookup）で使用済みとして数える
    const used = async (subject: string) => (await asService(async (c) => (await c.query<{ r: { used_by_subject: number }[] }>("select coupon_lookup($1, array['FIRST'], $2) as r", [f.shopId, subject])).rows[0]!.r))[0]!.used_by_subject;
    expect(await used(`c:${member}`)).toBe(1);
    expect(await used(sha("guest@example.com"))).toBe(1);
    expect(await used(sha("new@example.com"))).toBe(0);
    expect(await run(["a@example.com"], false)).toEqual({ found: true, uses: 1 });
    expect((await asUser(f.ownerId, async (c) => (await c.query<{ r: unknown }>("select import_coupon_usage($1, 'NOPE', '{}', true) as r", [f.shopId])).rows[0]!.r))).toEqual({ found: false, uses: 0 });
    // 取り込んだ使用は予約が無いので、使用済みのまま（解放の状態にはできない）
    expect(await expectDbError(() => pool.query("update coupon_redemptions set status = 'released' where campaign_id = $1 and reservation_id is null", [camp]))).toMatch(/coupon_redemptions_imported_used/);
  });

  it("coupon_grants_for_emails: 会員にはその会員の発行済み、会員でない人にはコードだけのものを発行し、2 回目は同じコードを返す", async () => {
    const camp = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into coupon_campaigns (shop_id, name, kind, value, external_ref) values ($1, 'VIP', 'percent', 10, 'woocommerce:9') returning id", [f.shopId]))).rows[0]!.id;
    const run = (emails: string[]) => asUser(f.ownerId, async (c) => (await c.query<{ r: { email: string; code: string; member: boolean }[] }>("select coupon_grants_for_emails($1, $2, $3::text[]) as r", [f.shopId, camp, emails])).rows[0]!.r);
    const first = await run(["M@example.com", "outside@example.com", "*@example.com", "m@example.com"]);
    expect(first.map((x) => [x.email, x.member])).toEqual([["m@example.com", true], ["outside@example.com", false]]);
    const rows = (await getPool().query("select customer_id, code from coupon_grants where campaign_id = $1 order by customer_id nulls last", [camp])).rows;
    expect(rows.map((x) => x.customer_id)).toEqual([member, null]);
    const again = await run(["m@example.com"]);
    expect(again[0]!.code).toBe(first.find((x) => x.member)!.code);
    // 取り込み元の ID は二重にできない
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("insert into coupon_campaigns (shop_id, name, kind, value, external_ref) values ($1, 'VIP2', 'percent', 10, 'woocommerce:9')", [f.shopId])))).toMatch(/coupon_campaigns_external_ref/);
  });

  it("restore_history: 取り込み元の ID・明細の品名・SKU の無い明細を戻す（2 回目は重ねない）", async () => {
    const pool = getPool();
    const oldOrder = "44444444-4444-4444-8444-444444444444";
    const oldSku = "22222222-2222-4222-8222-222222222222";
    const tables = {
      products: [{ id: "11111111-1111-4111-8111-111111111111", slug: "tea", name: "お茶", published: true }],
      skus: [{ id: oldSku, product_id: "11111111-1111-4111-8111-111111111111", code: "TEA-1", price_jpy: 1000 }],
      orders: [{ id: oldOrder, number: 7001, status: "shipped", total_jpy: 2000, external_ref: "woocommerce:7001" }],
      order_items: [
        { order_id: oldOrder, sku_id: oldSku, qty: 1, unit_price_jpy: 1000, item_name: "お茶（旧名）" },
        { order_id: oldOrder, sku_id: null, qty: 1, unit_price_jpy: 1000, item_name: "販売終了の品", item_variant: "赤" },
      ],
    };
    const dst = await asUser(f.ownerId, async (c) => (await c.query<{ id: string }>("insert into shops (owner_id, slug, name) values ($1, 'wh-restore', 'Dst') returning id", [f.ownerId])).rows[0]!.id);
    await asService((c) => c.query("select restore_shop_data($1, $2::jsonb)", [dst, JSON.stringify(tables)]));
    const r = await asService(async (c) => (await c.query<{ r: Record<string, number> }>("select restore_history($1, $2::jsonb) as r", [dst, JSON.stringify(tables)])).rows[0]!.r);
    expect(r).toEqual({ history_orders: 1, history_items: 2 });
    expect(await asService(async (c) => (await c.query<{ r: Record<string, number> }>("select restore_history($1, $2::jsonb) as r", [dst, JSON.stringify(tables)])).rows[0]!.r)).toEqual({ history_orders: 0, history_items: 0 });
    const items = (await pool.query("select sku_id is not null as has_sku, item_name, item_variant from order_items where shop_id = $1 order by item_name", [dst])).rows;
    expect(items).toEqual([
      { has_sku: true, item_name: "お茶（旧名）", item_variant: null },
      { has_sku: false, item_name: "販売終了の品", item_variant: "赤" },
    ]);
    expect((await pool.query("select external_ref from orders where shop_id = $1", [dst])).rows[0].external_ref).toBe("woocommerce:7001");
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select restore_history($1, '{}'::jsonb)", [dst])))).toMatch(/permission denied/);
  });
});
