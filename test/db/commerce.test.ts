import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const items = (skuId: string, qty: number) => JSON.stringify([{ sku_id: skuId, qty }]);

describe.skipIf(!dbAvailable)("商取引（0004_commerce）", () => {
  let f: Fixture;
  let other: Fixture;
  let token: { raw: string; hash: string };

  const reserve = (qty: number) => asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, items(f.skuId, qty)])).rows[0]!.id);
  const confirm = (resId: string, order: Record<string, unknown> = { payment_provider: "stripe", payment_ref: "pi_1" }) =>
    asService(async (c) => (await c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [resId, f.shopId, JSON.stringify(order)])).rows[0]!.id);
  const available = async () => (await getPool().query<{ available: number }>("select available from inventory where sku_id = $1", [f.skuId])).rows[0]!.available;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "owner@example.com", slug: "shop", publish: true, stock: 20 });
    other = await createShopFixture({ email: "other@example.com", slug: "other", publish: true, stock: 20 });
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    token = { raw, hash: createHash("sha256").update(raw).digest("hex") };
    await asUser(f.ownerId, (c) =>
      c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [f.shopId, f.ownerId, token.hash, raw.slice(0, 12), ["orders:read", "orders:write", "orders:pii"]]),
    );
  });
  afterAll(closePool);

  it("送料と注文番号: attach で送料を付け、確定時に total に含まれ、番号は 1001 から連番", async () => {
    const r1 = await reserve(2);
    await asService((c) => c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [r1, f.shopId, JSON.stringify({ customer_email: "a@example.com", customer_name: "A", shipping_address: { state: "北海道" }, shipping_jpy: 1500 })]));
    const o1 = await confirm(r1);
    const row1 = await getPool().query("select number, total_jpy, shipping_jpy, customer_email, customer_id from orders where id = $1", [o1]);
    expect(row1.rows[0]).toEqual({ number: 1001, total_jpy: 7500, shipping_jpy: 1500, customer_email: "a@example.com", customer_id: null });
    const res = await getPool().query("select customer from reservations where id = $1", [r1]);
    expect(res.rows[0].customer).toBeNull();

    const r2 = await reserve(1);
    const o2 = await confirm(r2);
    const row2 = await getPool().query("select number, total_jpy, shipping_jpy from orders where id = $1", [o2]);
    expect(row2.rows[0]).toEqual({ number: 1002, total_jpy: 3000, shipping_jpy: 0 });

    // 他ショップは独立した連番
    const rr = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [other.shopId, items(other.skuId, 1)])).rows[0]!.id);
    const oo = await asService(async (c) => (await c.query<{ id: string }>("select confirm_reservation($1, $2) as id", [rr, other.shopId])).rows[0]!.id);
    expect((await getPool().query("select number from orders where id = $1", [oo])).rows[0].number).toBe(1001);

    // hooks のペイロードに番号と送料
    const hook = await getPool().query("select payload from hook_deliveries where event = 'order.paid' limit 1");
    void hook;
    expect(await expectDbError(() => asService((c) => c.query("select attach_reservation_customer($1, $2, '{\"shipping_jpy\": -1}')", [r2, f.shopId])))).toMatch(/reservation_not_found|invalid_shipping/);
  });

  it("cancel_order: 在庫を戻し、refunded / cancelled を区別、冪等。shipped は不可", async () => {
    const before = await available();
    const r = await reserve(3);
    const o = await confirm(r);
    expect(await available()).toBe(before - 3);
    const info = await asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select order_payment_info($1, $2) as r", [o, f.shopId])).rows[0]!.r);
    expect(info).toMatchObject({ order_id: o, status: "paid", payment_provider: "stripe", payment_ref: "pi_1", total_jpy: 9000 });
    expect(await asService(async (c) => (await c.query<{ r: unknown }>("select order_payment_info($1, $2) as r", [o, other.shopId])).rows[0]!.r)).toBeNull();

    const first = await asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select cancel_order($1, $2, true) as r", [o, f.shopId])).rows[0]!.r);
    expect(first).toMatchObject({ status: "refunded", already: false, payment_ref: "pi_1" });
    expect(await available()).toBe(before);
    const again = await asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select cancel_order($1, $2, false) as r", [o, f.shopId])).rows[0]!.r);
    expect(again).toMatchObject({ status: "refunded", already: true });
    expect(await available()).toBe(before); // 二重に戻らない
    const hooks = await getPool().query("select count(*)::int as n from hook_deliveries where event = 'order.cancelled'");
    void hooks;

    const r2 = await reserve(1);
    const o2 = await confirm(r2);
    await getPool().query("update orders set status = 'shipped', shipped_at = now() where id = $1", [o2]);
    expect(await expectDbError(() => asService((c) => c.query("select cancel_order($1, $2, false)", [o2, f.shopId])))).toMatch(/not_cancellable/);
    expect(await expectDbError(() => asService((c) => c.query("select cancel_order($1, $2, false)", [o2, other.shopId])))).toMatch(/not_found/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select cancel_order($1, $2, false)", [o2, f.shopId])))).toMatch(/permission denied/);
  });

  it("order_contact はメール用の連絡先と明細を返す（service_role のみ）", async () => {
    const r = await reserve(1);
    await asService((c) => c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [r, f.shopId, JSON.stringify({ customer_email: "mail@example.com", customer_name: "宛先", shipping_address: { state: "東京都", line1: "1-1" }, shipping_jpy: 500 })]));
    const o = await confirm(r);
    const contact = await asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select order_contact($1, $2) as r", [o, f.shopId])).rows[0]!.r);
    expect(contact).toMatchObject({ customer_email: "mail@example.com", customer_name: "宛先", shipping_jpy: 500, total_jpy: 3500, shop: { name: "Shop shop", slug: "shop" } });
    expect(contact["items"]).toEqual([{ name: "Tシャツ", sku: "TEE-M", qty: 1, unit_price_jpy: 3000, tax_rate: 10, discount_jpy: 0 }]);
    expect(await expectDbError(() => asAnon((c) => c.query("select order_contact($1, $2)", [o, f.shopId])))).toMatch(/permission denied/);
  });

  it("lookup_order: 番号 + メールで状態だけ。住所は返さない。メール違い・非公開ショップは null", async () => {
    const r = await reserve(1);
    await asService((c) => c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [r, f.shopId, JSON.stringify({ customer_email: "Look@Example.com", customer_name: "照会", shipping_address: { state: "東京都", line1: "秘密" }, shipping_jpy: 0 })]));
    const o = await confirm(r);
    const number = (await getPool().query("select number from orders where id = $1", [o])).rows[0].number;
    const found = await asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select lookup_order($1, $2, $3) as r", [f.shopId, number, " look@example.com "])).rows[0]!.r);
    expect(found).toMatchObject({ number, status: "paid", total_jpy: 3000 });
    expect(JSON.stringify(found)).not.toContain("秘密");
    expect(JSON.stringify(found)).not.toContain("照会");
    expect(await asService(async (c) => (await c.query<{ r: unknown }>("select lookup_order($1, $2, 'wrong@example.com') as r", [f.shopId, number])).rows[0]!.r)).toBeNull();
    await getPool().query("update shops set published = false where id = $1", [f.shopId]);
    expect(await asService(async (c) => (await c.query<{ r: unknown }>("select lookup_order($1, $2, 'look@example.com') as r", [f.shopId, number])).rows[0]!.r)).toBeNull();
    await getPool().query("update shops set published = true where id = $1", [f.shopId]);
  });

  it("会員: customers は owner だけが読める（会員は Supabase のユーザーではない。0012）。会員の注文は customer_id で紐づく", async () => {
    const someone = await createAuthUser("someone@example.com");
    const memberId = (await getPool().query<{ id: string }>("insert into customers (shop_id, email, name) values ($1, 'member@example.com', '会員') returning id", [f.shopId])).rows[0]!.id;
    // ログインしただけの Supabase のユーザーは、customers を作れず、読めない
    expect(await expectDbError(() => asUser(someone, (c) => c.query("insert into customers (id, shop_id, email) values ($1, $2, 'x@example.com')", [someone, f.shopId])))).toMatch(/row-level security/);
    expect((await asUser(someone, (c) => c.query("select count(*)::int as n from customers"))).rows[0].n).toBe(0);
    // owner は閲覧・削除できる（更新はできない）
    await asUser(f.ownerId, async (c) => {
      expect((await c.query("select count(*)::int as n from customers")).rows[0].n).toBe(1);
      expect((await c.query("update customers set name = 'x' where id = $1", [memberId])).rowCount).toBe(0);
    });
    await asUser(other.ownerId, async (c) => {
      expect((await c.query("select count(*)::int as n from customers")).rows[0].n).toBe(0);
    });

    const r = await reserve(1);
    await asService((c) => c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [r, f.shopId, JSON.stringify({ customer_email: "member@example.com", customer_name: "会員", shipping_address: { state: "大阪府" }, shipping_jpy: 0, customer_id: memberId, customer_epoch: 0 })]));
    const o = await confirm(r);
    expect((await getPool().query("select customer_id from orders where id = $1", [o])).rows[0].customer_id).toBe(memberId);
    // 会員 ID と同じ uid の Supabase ユーザーがいても、注文は読めない（会員の経路は service_role の member_get だけ）
    expect((await asUser(memberId, (c) => c.query("select count(*)::int as n from orders"))).rows[0].n).toBe(0);
    await asUser(f.ownerId, (c) => c.query("delete from customers where id = $1", [memberId]));
    expect((await getPool().query("select count(*)::int as n from customers")).rows[0].n).toBe(0);
  });

  it("api_*: 注文検索（番号・メール）、発送、キャンセル（返金後）", async () => {
    const rpc = <T = unknown>(fn: string, args: unknown[]) =>
      asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
    const r = await reserve(1);
    await asService((c) => c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [r, f.shopId, JSON.stringify({ customer_email: "search@example.com", customer_name: "検索 太郎", shipping_address: {}, shipping_jpy: 300 })]));
    const o = await confirm(r);
    const number = (await getPool().query("select number from orders where id = $1", [o])).rows[0].number;
    const byNumber = await rpc<{ items: Record<string, unknown>[] }>("api_orders_list", [token.hash, null, null, null, 50, 0, String(number)]);
    expect(byNumber!.items).toHaveLength(1);
    expect(byNumber!.items[0]).toMatchObject({ number, shipping_jpy: 300, total_jpy: 3300 });
    const byMail = await rpc<{ items: unknown[] }>("api_orders_list", [token.hash, null, null, null, 50, 0, "search@"]);
    expect(byMail!.items).toHaveLength(1);
    const byName = await rpc<{ items: unknown[] }>("api_orders_list", [token.hash, null, null, null, 50, 0, "検索"]);
    expect(byName!.items).toHaveLength(1);

    expect(await expectDbError(() => rpc("api_order_update_status", [token.hash, o, "cancelled"]))).toMatch(/invalid_status/);
    const info = await rpc<Record<string, unknown>>("api_order_payment_info", [token.hash, o]);
    expect(info).toMatchObject({ payment_provider: "stripe", payment_ref: "pi_1" });
    const before = await available();
    const cancelled = await rpc<Record<string, unknown>>("api_order_cancel", [token.hash, o, true]);
    expect(cancelled).toMatchObject({ status: "refunded", number });
    expect(await available()).toBe(before + 1);
  });
});
