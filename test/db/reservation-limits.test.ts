import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const h = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * 0029_reservation_limits: 監査（2026-10-18 のコード監査）の H2 / M7。
 * 決済せずに在庫を押さえ続けられない（quote は 1 回限り・同じ人・同じ IP の上限）、Webhook の支払額・通貨を照合する。
 */
describe.skipIf(!dbAvailable)("予約の上限と支払額の照合（0029_reservation_limits）", () => {
  let f: Fixture;
  let store: string;
  const items = (qty: number) => JSON.stringify([{ sku_id: f.skuId, qty }]);
  const reserve = (qty: number, opts: { quote?: string; subject?: string; ip?: string } = {}) =>
    asService(async (c) =>
      (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb, 900, $3, $4, $5) as id", [f.shopId, items(qty), opts.quote ?? null, opts.subject ? h(opts.subject) : null, opts.ip ? h(opts.ip) : null])).rows[0]!.id,
    );
  const release = (id: string) => asService((c) => c.query("select release_reservation($1, $2)", [id, f.shopId]));
  const confirm = (id: string, order: Record<string, unknown>) =>
    asService(async (c) => (await c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [id, f.shopId, JSON.stringify(order)])).rows[0]!.id);
  const available = async () => (await getPool().query<{ available: number }>("select available from inventory where sku_id = $1", [f.skuId])).rows[0]!.available;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "rl@example.com", slug: "rl-shop", publish: true, stock: 100 });
    const orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    store = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into stores (org_id, name) values ($1, '店') returning id", [orgId]))).rows[0]!.id;
    await asUser(f.ownerId, (c) => c.query("insert into shop_stores (shop_id, store_id) values ($1, $2)", [f.shopId, store]));
  });
  afterAll(closePool);

  it("同じ quote で生きた予約は 1 つだけ。解放されたら出し直せる。3 つの引数だけの古い呼び方も動く", async () => {
    const r1 = await reserve(1, { quote: "quote-aaaaaaaa" });
    expect(await expectDbError(() => reserve(1, { quote: "quote-aaaaaaaa" }))).toMatch(/quote_already_used/);
    await release(r1);
    const r2 = await reserve(1, { quote: "quote-aaaaaaaa" });
    await confirm(r2, { payment_provider: "stripe", payment_ref: "pi_q" });
    expect(await expectDbError(() => reserve(1, { quote: "quote-aaaaaaaa" }))).toMatch(/quote_already_used/);
    const legacy = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb, 900) as id", [f.shopId, items(1)])).rows[0]!.id);
    expect(legacy).toMatch(/^[0-9a-f-]{36}$/);
    await release(legacy);
  });

  it("同じ人（メールの HMAC）の未確定の予約は 3 つまで、同じ IP は 20 まで。解放・確定で枠が空く。ショップの設定で変えられる", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await reserve(1, { subject: "buyer@example.com", ip: "198.51.100.7" }));
    expect(await expectDbError(() => reserve(1, { subject: "buyer@example.com", ip: "198.51.100.8" }))).toMatch(/too_many_reservations/);
    await release(ids[0]!);
    const r = await reserve(1, { subject: "buyer@example.com" });
    await confirm(r, { payment_provider: "stripe", payment_ref: "pi_s" });
    expect(await reserve(1, { subject: "buyer@example.com" })).toBeTruthy();
    for (const id of ids.slice(1)) await release(id);
    // IP
    for (let i = 0; i < 20; i++) await reserve(1, { subject: `ip${i}@example.com`, ip: "198.51.100.9" });
    expect(await expectDbError(() => reserve(1, { subject: "ip-last@example.com", ip: "198.51.100.9" }))).toMatch(/too_many_reservations/);
    expect(await reserve(1, { subject: "ip-last@example.com", ip: "198.51.100.10" })).toBeTruthy();
    await getPool().query("update shops set settings = settings || '{\"checkout\": {\"max_pending_per_ip\": \"25\"}}' where id = $1", [f.shopId]);
    expect(await reserve(1, { subject: "ip-more@example.com", ip: "198.51.100.9" })).toBeTruthy();
    await getPool().query("update reservations set status = 'released' where status = 'pending'");
    await getPool().query("update shops set settings = settings - 'checkout' where id = $1", [f.shopId]);
  });

  it("支払額・通貨が Banto の計算と違えば確定しない（在庫も注文も動かない）。額が無い確定（0 円・古い Worker）は今までどおり", async () => {
    const before = await available();
    const r = await reserve(2);
    await asService((c) => c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [r, f.shopId, JSON.stringify({ customer_email: "pay@example.com", shipping_jpy: 500 })]));
    // 3000 × 2 + 500 = 6500
    expect(await expectDbError(() => confirm(r, { payment_provider: "stripe", payment_ref: "pi_m", amount_paid_jpy: 50 }))).toMatch(/amount_mismatch/);
    expect(await expectDbError(() => confirm(r, { payment_provider: "stripe", payment_ref: "pi_m", amount_paid_jpy: 6500, currency: "usd" }))).toMatch(/amount_mismatch/);
    expect((await getPool().query("select count(*)::int as n from orders where reservation_id = $1", [r])).rows[0].n).toBe(0);
    expect(await available()).toBe(before - 2);
    const id = await confirm(r, { payment_provider: "stripe", payment_ref: "pi_m", amount_paid_jpy: 6500, currency: "JPY" });
    expect((await getPool().query("select total_jpy, amount_paid_jpy from orders where id = $1", [id])).rows[0]).toEqual({ total_jpy: 6500, amount_paid_jpy: 6500 });
    const r2 = await reserve(1);
    expect(await confirm(r2, { payment_provider: "komoju", payment_ref: "k_1" })).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("お店で試着: 同じ人の開いている申し込みは 3 つまで、同じ IP は 10 まで（p_customer.ip_hash）", async () => {
    const req = (email: string, ip?: string) =>
      asService(async (c) => (await c.query<{ r: { id: string } }>("select tryon_request($1, $2, $3::jsonb, $4::jsonb) as r", [f.shopId, store, items(1), JSON.stringify({ customer_email: email, ...(ip ? { ip_hash: h(ip) } : {}) })])).rows[0]!.r);
    for (let i = 0; i < 3; i++) await req("Try@example.com", "198.51.100.20");
    expect(await expectDbError(() => req("try@example.com"))).toMatch(/too_many_requests/);
    await getPool().query("update tryon_requests set status = 'cancelled' where customer_email = 'try@example.com'");
    expect(await req("try@example.com")).toBeTruthy();
    for (let i = 0; i < 10; i++) await req(`t${i}@example.com`, "198.51.100.21");
    expect(await expectDbError(() => req("t-last@example.com", "198.51.100.21"))).toMatch(/too_many_requests/);
    expect(await req("t-last@example.com", "198.51.100.22")).toBeTruthy();
  });
});
