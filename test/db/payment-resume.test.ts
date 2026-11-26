import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONFIRM_SQL, asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const h = (t: string) => createHash("sha256").update(t).digest("hex");

/** 0180_payment_resume: KOMOJU のお支払いに戻る（予約に決済ページの ID、照会・会員の予約で引く、会員ページの一覧） */
describe.skipIf(!dbAvailable)("お支払いに戻る（0180_payment_resume）", () => {
  let f: Fixture;
  let customer: string;
  const q = <T>(sql: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(sql, args)).rows[0]!.r);
  const reserve = (quote: string, customerId: string | null = null) =>
    q<string>("select reserve_stock($1, $2::jsonb, 3600, $3, $4, null, $5) as r", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: 2 }]), quote, h(`${quote}@example.com`), customerId]);
  const setSession = (rid: string, id: string, expected: string | null, shop = f.shopId) =>
    q<boolean>("select reservation_set_payment_session($1, $2, $3::jsonb, $4) as r", [rid, shop, JSON.stringify({ provider: "komoju", id, types: ["bank_transfer"] }), expected]);
  const byQuote = (quote: string, shop = f.shopId) => q<Record<string, unknown> | null>("select reservation_payment_get($1, $2, null, null, null) as r", [shop, quote]);
  const byMember = (rid: string, cid: string, epoch: number) => q<Record<string, unknown> | null>("select reservation_payment_get($1, null, $2, $3, $4) as r", [f.shopId, rid, cid, epoch]);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "pr@example.com", slug: "pr-shop", publish: true, stock: 20 });
    customer = (await getPool().query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'member@example.com') returning id", [f.shopId])).rows[0]!.id;
  });
  afterAll(closePool);

  it("決済ページの ID は未確定の予約に、前の値と同じときだけ入れ替わる（二度押しで 2 つを生かさない）", async () => {
    const rid = await reserve("quote-pr-0001");
    expect(await setSession(rid, "sess_a", "sess_x")).toBe(false);
    expect(await setSession(rid, "sess_a", null)).toBe(true);
    // 二度押し: 同じ前の値から 2 回入れ替えようとしても、通るのは 1 回だけ
    expect(await setSession(rid, "sess_b", "sess_a")).toBe(true);
    expect(await setSession(rid, "sess_c", "sess_a")).toBe(false);
    // 他のショップの予約には入れられない
    const other = await createShopFixture({ email: "pr2@example.com", slug: "pr-other", publish: true, stock: 5 });
    expect(await setSession(rid, "sess_d", "sess_b", other.shopId)).toBe(false);
    // 形の違う値は入らない（provider と ID の形）
    expect(await expectDbError(() => asService((c) => c.query("select reservation_set_payment_session($1, $2, $3::jsonb, $4)", [rid, f.shopId, JSON.stringify({ provider: "stripe", id: "cs_1" }), "sess_b"])))).toMatch(/check constraint/);
    expect(await expectDbError(() => asService((c) => c.query("select reservation_set_payment_session($1, $2, $3::jsonb, $4)", [rid, f.shopId, JSON.stringify({ provider: "komoju", id: "a b" }), "sess_b"])))).toMatch(/check constraint/);
    // 解放した予約には入れない
    await asService((c) => c.query("select release_reservation($1, $2)", [rid, f.shopId]));
    expect(await setSession(rid, "sess_e", "sess_b")).toBe(false);
  });

  it("照会の quote で引く。金額は確定の判定と同じ式、状態は予約と注文から。checkout_status の resumable", async () => {
    const rid = await reserve("quote-pr-0002");
    expect(await q("select checkout_status($1, $2) as r", [f.shopId, "quote-pr-0002"])).toMatchObject({ status: "pending", resumable: false });
    await setSession(rid, "sess_q2", null);
    expect(await q("select checkout_status($1, $2) as r", [f.shopId, "quote-pr-0002"])).toMatchObject({ status: "pending", resumable: true });
    const price = (await getPool().query<{ p: number }>("select price_jpy as p from skus where id = $1", [f.skuId])).rows[0]!.p;
    await getPool().query("update reservations set shipping_jpy = 500, fee_jpy = 220, discount_jpy = 100 where id = $1", [rid]);
    const r = await byQuote("quote-pr-0002");
    expect(r).toMatchObject({ reservation_id: rid, status: "pending", quote_id: "quote-pr-0002", payment_session: { provider: "komoju", id: "sess_q2", types: ["bank_transfer"] }, total_jpy: price * 2 + 500 - 100 + 220 });
    expect(JSON.stringify(r)).not.toMatch(/@example\.com/);
    // 確定したら confirmed（照会の resumable も外れる）
    await asService((c) => c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [rid, f.shopId, JSON.stringify({ customer_email: "b@example.com", customer_name: "山田", shipping_address: { state: "東京都" }, shipping_jpy: 500, fee_jpy: 220 })]));
    await getPool().query("update reservations set discount_jpy = 0, fee_jpy = 0 where id = $1", [rid]);
    await asService((c) => c.query(CONFIRM_SQL, [rid, f.shopId, JSON.stringify({ payment_provider: "komoju", payment_ref: "pay_1", amount_paid_jpy: price * 2 + 500, currency: "JPY" })]));
    expect(await byQuote("quote-pr-0002")).toMatchObject({ status: "confirmed" });
    expect(await q("select checkout_status($1, $2) as r", [f.shopId, "quote-pr-0002"])).toMatchObject({ status: "confirmed" });
    expect(await byQuote("quote-nope-000")).toBeNull();
  });

  it("会員の予約 id で引くのは本人・今の世代だけ。会員ページの一覧（member_get の pending_payments）", async () => {
    const rid = await reserve("quote-pr-0003", customer);
    const plain = await reserve("quote-pr-0004", customer);
    // 会員の予約（レジは attach_reservation_customer で customer_id を入れる）
    await getPool().query("update reservations set customer_id = $1 where id = any($2::uuid[])", [customer, [rid, plain]]);
    await setSession(rid, "sess_m1", null);
    const epoch = (await getPool().query<{ e: number }>("select session_epoch as e from customers where id = $1", [customer])).rows[0]!.e;
    expect(await byMember(rid, customer, epoch)).toMatchObject({ reservation_id: rid, status: "pending" });
    expect(await byMember(rid, customer, epoch + 1)).toBeNull();
    const stranger = (await getPool().query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'other@example.com') returning id", [f.shopId])).rows[0]!.id;
    expect(await byMember(rid, stranger, 0)).toBeNull();
    const rec = await q<{ pending_payments: { reservation_id: string; items: { name: string; qty: number }[]; total_jpy: number }[] }>("select member_get($1, $2, $3, true) as r", [f.shopId, customer, epoch]);
    // 決済ページの無い予約（Stripe など）は出さない
    expect(rec.pending_payments.map((p) => p.reservation_id)).toEqual([rid]);
    expect(rec.pending_payments[0]!.items).toEqual([{ name: expect.any(String), qty: 2 }]);
    expect(plain).toBeTruthy();
    // 期限が過ぎた・解放した予約は出さない
    await getPool().query("update reservations set expires_at = now() - interval '1 minute' where id = $1", [rid]);
    expect((await q<{ pending_payments: unknown[] }>("select member_get($1, $2, $3, true) as r", [f.shopId, customer, epoch])).pending_payments).toEqual([]);
    expect(await q("select checkout_status($1, $2) as r", [f.shopId, "quote-pr-0003"])).toMatchObject({ resumable: false });
    // 注文を読まないとき（ログインの確かめ）は空
    expect((await q<{ pending_payments: unknown[] }>("select member_get($1, $2, $3, false) as r", [f.shopId, customer, epoch])).pending_payments).toEqual([]);
  });

  it("service_role 専用（anon・運営者からは呼べない）", async () => {
    for (const sql of [
      "select reservation_payment_get($1, 'quote-pr-0002', null, null, null)",
      "select reservation_set_payment_session(gen_random_uuid(), $1, '{\"provider\":\"komoju\",\"id\":\"x\"}'::jsonb, null)",
    ]) {
      expect(await expectDbError(() => asAnon((c) => c.query(sql, [f.shopId])))).toMatch(/permission denied/);
      expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query(sql, [f.shopId])))).toMatch(/permission denied/);
    }
  });
});
