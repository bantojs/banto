import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { CONFIRM_SQL, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

type J = Record<string, unknown>;

/**
 * 0156_order_payment_status: お支払いの状態を注文の状態と分ける（後払いの器）。
 * 未入金の注文は受付（pending）→ 発送（shipped）と進み、入金の記録（order_payment_record）で paid になって order.paid が出る。
 * 売上・会員の購入額は入金済みだけ。未入金の注文は受付のあいだも受け取り拒否でも取り消せて、在庫が戻る
 */
describe.skipIf(!dbAvailable)("お支払いの状態（0156）", () => {
  let f: Fixture;
  let other: Fixture;
  let ordersOnly: string;
  let cid: string;
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const stock = async () => (await getPool().query<{ available: number }>("select available from inventory where sku_id = $1", [f.skuId])).rows[0]!.available;
  const row = async (id: string) => (await getPool().query<J>("select status::text as status, payment_status, paid_at, cancel_reason from orders where id = $1", [id])).rows[0]!;
  const hooks = async (event: string, id: string) => (await getPool().query<{ payload: J }>("select payload from hook_deliveries where event = $1 and payload->>'order_id' = $2", [event, id])).rows.map((r) => r.payload);

  /** Banto で予約して確定した注文を作り、未入金の受付にする（作る口は次の版の同梱モジュール。ここでは superuser で状態だけ変える） */
  async function unpaidOrder(opts: { customer?: string; total?: number } = {}): Promise<{ id: string; number: number }> {
    const resId = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: 1 }])])).rows[0]!.id);
    await asService((c) => c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [resId, f.shopId, JSON.stringify({ customer_email: "buyer@example.com", customer_name: "買い手", shipping_address: {}, shipping_jpy: 0 })]));
    const id = await asService(async (c) => (await c.query<{ id: string }>(CONFIRM_SQL, [resId, f.shopId, JSON.stringify({ payment_provider: "cod" })])).rows[0]!.id);
    await getPool().query("update orders set status = 'pending', payment_status = 'unpaid', paid_at = null, customer_id = $2 where id = $1", [id, opts.customer ?? null]);
    const number = (await getPool().query<{ number: number }>("select number from orders where id = $1", [id])).rows[0]!.number;
    return { id, number };
  }
  const record = (uid: string, id: string, shopId = f.shopId) => asUser(uid, async (c) => (await c.query<{ r: J }>("select order_payment_record($1, $2) as r", [shopId, id])).rows[0]!.r);
  const cancel = (id: string, reason: string | null = null, refunded = false) => asService(async (c) => (await c.query<{ r: J }>("select cancel_order($1, $2, $3, $4) as r", [id, f.shopId, refunded, reason])).rows[0]!.r);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "pay-owner@example.com", slug: "pay-shop", publish: true, stock: 50 });
    other = await createShopFixture({ email: "pay-other@example.com", slug: "pay-other", publish: true });
    const org = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    ordersOnly = await createAuthUser("pay-orders@example.com");
    await getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", [org, ordersOnly]);
    await getPool().query("insert into org_member_shops (org_id, user_id, shop_id, perms) values ($1, $2, $3, '{orders}')", [org, ordersOnly, f.shopId]);
    cid = (await getPool().query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'member@example.com') returning id", [f.shopId])).rows[0]!.id;
    await getPool().query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'p', 'https://plugin.example.com/h', '{order.paid,order.cancelled,order.shipped}')", [f.shopId]);
  });
  afterAll(closePool);

  it("今までの注文は入金済み（paid_at は注文の日時）。受付（pending）は未入金の注文だけ", async () => {
    const res = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: 1 }])])).rows[0]!.id);
    const id = await asService(async (c) => (await c.query<{ id: string }>(CONFIRM_SQL, [res, f.shopId, JSON.stringify({ payment_provider: "stripe", payment_ref: "pi_x" })])).rows[0]!.id);
    expect(await row(id)).toMatchObject({ status: "paid", payment_status: "paid" });
    expect(await expectDbError(() => getPool().query("update orders set status = 'pending' where id = $1", [id]))).toMatch(/orders_pending_unpaid/);
  });

  it("入金の記録: 項目 orders。order.paid（recorded_payment）を 1 回だけ出す。よその店・取り消した注文は断る", async () => {
    const o = await unpaidOrder({ customer: cid });
    expect(await expectDbError(() => record(other.ownerId, o.id))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => record(other.ownerId, o.id, other.shopId))).toMatch(/not_found/);
    const r = await record(ordersOnly, o.id);
    expect(r).toMatchObject({ already: false });
    expect(await row(o.id)).toMatchObject({ status: "paid", payment_status: "paid" });
    expect(await record(ordersOnly, o.id)).toMatchObject({ already: true });
    // 確定（テストの準備で通常の確定を通している）の分を除いた、入金の記録の分
    const paid = (await hooks("order.paid", o.id)).filter((p) => p["recorded_payment"] === true);
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ recorded_payment: true, payment_status: "paid", order_number: o.number });
    expect(paid[0]).not.toHaveProperty("customer_email");
    const c = await unpaidOrder();
    await cancel(c.id);
    expect(await expectDbError(() => record(f.ownerId, c.id))).toMatch(/not_payable/);
  });

  it("運営者の JWT からはお支払いの状態を直接変えられない。受付から発送にはできる（送り状の取り込みも）", async () => {
    const o = await unpaidOrder();
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update orders set payment_status = 'paid' where id = $1", [o.id])))).toMatch(/use_order_payment_record|permission denied/);
    await asUser(f.ownerId, (c) => c.query("update orders set status = 'shipped', shipped_at = now() where id = $1", [o.id]));
    expect(await row(o.id)).toMatchObject({ status: "shipped", payment_status: "unpaid" });
    const o2 = await unpaidOrder();
    const r = await asUser(f.ownerId, async (c) => (await c.query<{ r: J }>("select ship_orders($1, $2::jsonb) as r", [f.shopId, JSON.stringify([{ number: String(o2.number), carrier: "yamato", tracking: "1234-5678-9012" }])])).rows[0]!.r);
    expect(r).toMatchObject({ shipped: 1 });
    expect((await hooks("order.shipped", o2.id))[0]).toMatchObject({ payment_status: "unpaid" });
    // 発送の後に入金されても paid になる
    await record(f.ownerId, o2.id);
    expect(await row(o2.id)).toMatchObject({ status: "shipped", payment_status: "paid" });
  });

  it("取り消し: 未入金の受付・受け取り拒否は返金なしで在庫を戻す。入金済みの発送は取り消せない。拒否は未入金だけ", async () => {
    const before = await stock();
    const a = await unpaidOrder();
    expect(await stock()).toBe(before - 1);
    expect(await cancel(a.id, null, true)).toMatchObject({ status: "cancelled", restocked: true });
    expect(await stock()).toBe(before);
    const b = await unpaidOrder();
    await getPool().query("update orders set status = 'shipped', shipped_at = now() where id = $1", [b.id]);
    expect(await cancel(b.id, "refused")).toMatchObject({ status: "cancelled" });
    expect(await row(b.id)).toMatchObject({ status: "cancelled", cancel_reason: "refused" });
    expect((await hooks("order.cancelled", b.id))[0]).toMatchObject({ reason: "refused", payment_status: "unpaid", refunded: false });
    const c = await unpaidOrder();
    await record(f.ownerId, c.id);
    await getPool().query("update orders set status = 'shipped', shipped_at = now() where id = $1", [c.id]);
    expect(await expectDbError(() => cancel(c.id))).toMatch(/not_cancellable/);
    const d = await unpaidOrder();
    await record(f.ownerId, d.id);
    expect(await expectDbError(() => cancel(d.id, "refused"))).toMatch(/invalid_cancel_reason/);
  });

  it("売上・会員の購入額・ホームは入金済みだけ。未入金の数はホームに出る", async () => {
    await getPool().query("delete from orders where shop_id = $1", [f.shopId]);
    const o = await unpaidOrder({ customer: cid });
    const sales = async () =>
      (await asService(async (c) => (await c.query<{ r: { total: { orders: number } } }>("select sales_summary_for_shop($1, now() - interval '1 day', now() + interval '1 day', 'day') as r", [f.shopId])).rows[0]!.r)).total.orders;
    const spent = async () => (await getPool().query<{ orders_count: number }>("select orders_count from customers where id = $1", [cid])).rows[0]!.orders_count;
    const home = async () => asUser(f.ownerId, async (c) => (await c.query<{ r: { orders: J; sales: J } }>("select shop_home($1) as r", [f.shopId])).rows[0]!.r);
    expect(await sales()).toBe(0);
    expect(await spent()).toBe(0);
    expect((await home()).orders).toMatchObject({ to_ship: 1, unpaid: 1 });
    expect(Number((await home()).sales["orders"])).toBe(0);
    await record(f.ownerId, o.id);
    expect(await sales()).toBe(1);
    expect(await spent()).toBe(1);
    expect((await home()).orders).toMatchObject({ to_ship: 1, unpaid: 0 });
  });

  it("個人情報のマスキングは、発送した未入金の注文を残す。注文照会・会員の注文にお支払いの状態", async () => {
    const o = await unpaidOrder();
    await getPool().query("update orders set status = 'shipped', shipped_at = now() - interval '400 days' where id = $1", [o.id]);
    await asService((c) => c.query("select mask_shipped_orders(180)"));
    expect((await getPool().query<{ customer_email: string | null }>("select customer_email from orders where id = $1", [o.id])).rows[0]!.customer_email).toBe("buyer@example.com");
    await record(f.ownerId, o.id);
    await asService((c) => c.query("select mask_shipped_orders(180)"));
    expect((await getPool().query<{ customer_email: string | null }>("select customer_email from orders where id = $1", [o.id])).rows[0]!.customer_email).toBeNull();
    const view = (await getPool().query<{ v: J }>("select banto_order_view(o) as v from orders o where id = $1", [o.id])).rows[0]!.v;
    expect(view).toMatchObject({ payment_status: "paid" });
  });

  it("新しい注文の入金日時・発送の後の入金で会員の購入額・入金の記録の監査ログと order.paid の項目", async () => {
    const res = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: 1 }])])).rows[0]!.id);
    const paidId = await asService(async (c) => (await c.query<{ id: string }>(CONFIRM_SQL, [res, f.shopId, JSON.stringify({ payment_provider: "stripe", payment_ref: "pi_new" })])).rows[0]!.id);
    expect((await row(paidId))["paid_at"]).toBeTruthy();
    const o = await unpaidOrder({ customer: cid });
    await getPool().query("update orders set status = 'shipped', shipped_at = now() where id = $1", [o.id]);
    const count = async () => (await getPool().query<{ orders_count: number }>("select orders_count from customers where id = $1", [cid])).rows[0]!.orders_count;
    const before = await count();
    await record(f.ownerId, o.id);
    expect(await count()).toBe(before + 1);
    const audit = (await getPool().query<{ action: string }>("select action from audit_log where target_id = $1", [o.id])).rows.map((r) => r.action);
    expect(audit).toContain("order.payment_recorded");
    const paid = (await hooks("order.paid", o.id)).find((p) => p["recorded_payment"] === true)!;
    expect(paid).toMatchObject({ subtotal_jpy: expect.any(Number), shipping_jpy: 0, discount_jpy: 0 });
    expect((paid["items"] as J[])[0]).toMatchObject({ sku_id: f.skuId, product_id: f.productId, discount_jpy: 0 });
  });

  it("受け取り拒否は発送した未入金の注文だけ（受付のあいだは理由なしで取り消す）", async () => {
    const o = await unpaidOrder();
    expect(await expectDbError(() => cancel(o.id, "refused"))).toMatch(/invalid_cancel_reason/);
  });

  it("復元: お支払いの状態・入金日時・取り消しの理由を戻す（受付の注文も入る）", async () => {
    const empty = await createShopFixture({ email: "pay-restore@example.com", slug: "pay-restore" });
    await getPool().query("delete from products where shop_id = $1", [empty.shopId]);
    const data = {
      orders: [
        { id: "11111111-1111-4111-8111-111111111111", number: 1001, status: "pending", payment_status: "unpaid", total_jpy: 1000, created_at: "2026-01-01T00:00:00Z" },
        { id: "11111111-1111-4111-8111-111111111112", number: 1002, status: "cancelled", payment_status: "unpaid", cancel_reason: "refused", total_jpy: 1000, created_at: "2026-01-02T00:00:00Z" },
        { id: "11111111-1111-4111-8111-111111111113", number: 1003, status: "shipped", total_jpy: 1000, created_at: "2026-01-03T00:00:00Z" },
      ],
    };
    await asService((c) => c.query("select restore_shop_data($1, $2::jsonb)", [empty.shopId, JSON.stringify(data)]));
    const rows = (await getPool().query<J>("select number, status::text as status, payment_status, paid_at is not null as has_paid_at, cancel_reason from orders where shop_id = $1 order by number", [empty.shopId])).rows;
    expect(rows).toEqual([
      { number: 1001, status: "pending", payment_status: "unpaid", has_paid_at: false, cancel_reason: null },
      { number: 1002, status: "cancelled", payment_status: "unpaid", has_paid_at: false, cancel_reason: "refused" },
      { number: 1003, status: "shipped", payment_status: "paid", has_paid_at: true, cancel_reason: null },
    ]);
  });

  it("AI 用 API: 入金の記録（orders:write）・注文に payment_status と paid_at", async () => {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    await asUser(f.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, '{orders:read,orders:write}')", [f.shopId, f.ownerId, sha(raw), raw.slice(0, 12)]));
    const o = await unpaidOrder();
    const r = await asService(async (c) => (await c.query<{ r: J }>("select api_order_payment_record($1, $2) as r", [sha(raw), o.id])).rows[0]!.r);
    expect(r).toMatchObject({ status: "paid", payment_status: "paid" });
    expect(r["paid_at"]).toBeTruthy();
  });
});
