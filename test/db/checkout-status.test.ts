import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const h = (t: string) => createHash("sha256").update(t).digest("hex");

/** 0035_checkout_status: 戻り先の画面が quote の識別子で「確定したか・注文番号」を引く */
describe.skipIf(!dbAvailable)("注文の状態の照会（0035_checkout_status）", () => {
  let f: Fixture;
  const status = (quote: string) => asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select checkout_status($1, $2) as r", [f.shopId, quote])).rows[0]!.r);
  const reserve = (quote: string) =>
    asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb, 900, $3, $4, null) as id", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: 1 }]), quote, h("buyer@example.com")])).rows[0]!.id);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "cs@example.com", slug: "cs-shop", publish: true, stock: 10 });
  });
  afterAll(closePool);

  it("予約中は pending、確定したら confirmed と注文番号・合計、解放されたら released。知らない quote は not_found。個人情報は返さない", async () => {
    expect(await status("quote-nope-00")).toEqual({ status: "not_found", order: null, expires_at: null });
    const r1 = await reserve("quote-one-0001");
    expect(await status("quote-one-0001")).toMatchObject({ status: "pending", order: null, expires_at: expect.any(String) });
    await asService((c) => c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [r1, f.shopId, JSON.stringify({ customer_email: "buyer@example.com", customer_name: "山田", shipping_address: { state: "東京都" } })]));
    await asService((c) => c.query("select confirm_reservation($1, $2, $3::jsonb)", [r1, f.shopId, JSON.stringify({ payment_provider: "stripe", payment_ref: "pi_1" })]));
    const confirmed = await status("quote-one-0001");
    expect(confirmed).toMatchObject({ status: "confirmed", order: { number: 1001, status: "paid", total_jpy: expect.any(Number), payment_provider: "stripe", created_at: expect.any(String) } });
    expect(JSON.stringify(confirmed)).not.toMatch(/buyer@example.com|山田|東京都/);
    const r2 = await reserve("quote-two-0002");
    await asService((c) => c.query("select release_reservation($1, $2)", [r2, f.shopId]));
    expect(await status("quote-two-0002")).toMatchObject({ status: "released", order: null });
    // 他のショップの quote は見えない（ショップ id で引く）
    const other = await createShopFixture({ email: "cs2@example.com", slug: "cs-other", publish: true, stock: 10 });
    expect(await asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select checkout_status($1, $2) as r", [other.shopId, "quote-one-0001"])).rows[0]!.r)).toMatchObject({ status: "not_found" });
  });

  it("service_role 専用（anon・運営者からは呼べない）", async () => {
    expect(await expectDbError(() => asAnon((c) => c.query("select checkout_status($1, 'quote-one-0001')", [f.shopId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select checkout_status($1, 'quote-one-0001')", [f.shopId])))).toMatch(/permission denied/);
    // 使っている関数の引数の形を変えないこと（reserve_stock の 6 引数版）
    expect((await getPool().query("select count(*)::int as n from reservations where quote_id is not null")).rows[0]!.n).toBeGreaterThanOrEqual(2);
  });
});
