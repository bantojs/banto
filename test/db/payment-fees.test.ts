import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";
import { PAYMENT_FEE_CASES } from "../fixtures/payment-fee-cases";
import { COD_FEE_CASES } from "../fixtures/cod-fee-cases";

type J = Record<string, unknown>;

/**
 * 0170_payment_fees: 支払い方法の手数料（KOMOJU の種類ごと）。決まりの読み方は banto_fee_rule 1 つ（代引きと共通）。
 * 手数料は値引きの後に reservation_payment_fee_check が確かめ（fee_checked）、確定はそれと KOMOJU が知らせた種類を見る
 */
describe.skipIf(!dbAvailable)("支払い方法の手数料（0170）", () => {
  let f: Fixture;
  let price: number;
  const setSettings = (s: J) => getPool().query("update shops set settings = settings || $2::jsonb where id = $1", [f.shopId, JSON.stringify(s)]);

  async function reserve(opts: { fee?: number; method?: string | null } = {}): Promise<string> {
    const resId = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: 1 }])])).rows[0]!.id);
    await asService((c) =>
      c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [
        resId,
        f.shopId,
        JSON.stringify({ customer_email: "buyer@example.com", customer_name: "買い手", shipping_address: {}, shipping_jpy: 500, ...(opts.fee ? { fee_jpy: opts.fee } : {}), ...(opts.method ? { payment_method: opts.method } : {}) }),
      ]),
    );
    return resId;
  }
  const check = (resId: string) => asService(async (c) => (await c.query<{ fee: number }>("select reservation_payment_fee_check($1, $2) as fee", [resId, f.shopId])).rows[0]!.fee);
  const confirm = (resId: string, order: J) => asService(async (c) => (await c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [resId, f.shopId, JSON.stringify({ currency: "jpy", payment_ref: `pay_${resId}`, ...order })])).rows[0]!.id);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "pf-owner@example.com", slug: "pf-shop", publish: true, stock: 50 });
    price = (await getPool().query<{ price_jpy: number }>("select price_jpy from skus where id = $1", [f.skuId])).rows[0]!.price_jpy;
  });
  afterAll(closePool);

  it("決まりの読み方: banto_payment_fee と banto_cod_fee は答え合わせの表どおり（TS と同じ）。anon・authenticated は呼べない", async () => {
    for (const k of PAYMENT_FEE_CASES) {
      const got = (await getPool().query<{ fee: number | null }>("select banto_payment_fee($1::jsonb, $2, $3) as fee", [JSON.stringify(k.settings), `komoju:${k.type}`, k.amount])).rows[0]!.fee;
      expect([k.name, got]).toEqual([k.name, k.fee]);
    }
    for (const k of COD_FEE_CASES) {
      const got = (await getPool().query<{ fee: number | null }>("select banto_cod_fee($1::jsonb, $2) as fee", [JSON.stringify(k.settings), k.amount])).rows[0]!.fee;
      expect([k.name, got]).toEqual([k.name, k.fee]);
    }
    // KOMOJU 以外・種類なしは 0
    expect((await getPool().query<{ fee: number }>("select banto_payment_fee($1::jsonb, 'komoju', 5000) as fee", [JSON.stringify({ payment_fees: { konbini: { fee_jpy: 220 } } })])).rows[0]!.fee).toBe(0);
    expect(await expectDbError(() => asAnon((c) => c.query("select banto_payment_fee('{}'::jsonb, 'komoju:konbini', 1)")))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select banto_fee_rule('{}'::jsonb, 1)")))).toMatch(/permission denied/);
    const r = await reserve({ method: "komoju:konbini" });
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select reservation_payment_fee_check($1, $2)", [r, f.shopId])))).toMatch(/permission denied/);
  });

  it("確かめ: 値引きの後の金額でショップの決まりと同じなら fee_checked、違えば amount_mismatch・種類が無ければ断る", async () => {
    await setSettings({ payment_fees: { konbini: { fee_type: "flat", fee_jpy: 220 }, bank_transfer: { fee_type: "tiers", fee_tiers: [{ upto: 1, fee: 1 }] } } });
    const ok = await reserve({ fee: 220, method: "komoju:konbini" });
    expect(await check(ok)).toBe(220);
    expect((await getPool().query<{ fee_checked: boolean; payment_method: string; customer: J }>("select fee_checked, payment_method, customer from reservations where id = $1", [ok])).rows[0]).toMatchObject({
      fee_checked: true,
      payment_method: "komoju:konbini",
    });
    // payment_method は予約の customer には残さない
    expect((await getPool().query<{ customer: J }>("select customer from reservations where id = $1", [ok])).rows[0]!.customer).not.toHaveProperty("payment_method");
    const wrong = await reserve({ fee: 110, method: "komoju:konbini" });
    expect(await expectDbError(() => check(wrong))).toMatch(/amount_mismatch/);
    const noTier = await reserve({ fee: 1, method: "komoju:bank_transfer" });
    expect(await expectDbError(() => check(noTier))).toMatch(/amount_mismatch/);
    const none = await reserve({ fee: 220 });
    expect(await expectDbError(() => check(none))).toMatch(/amount_mismatch/);
    expect(await expectDbError(() => reserve({ method: "Komoju:x" }))).toMatch(/invalid_payment_method|check/);
  });

  it("確定: 確かめた予約だけ手数料つきで確定し、合計と受け取った額に手数料。確かめのあとで決まりを変えても確定する", async () => {
    await setSettings({ payment_fees: { konbini: { fee_type: "flat", fee_jpy: 220 } } });
    const total = price + 500 + 220;
    // 確かめていない予約は確定しない（返金）
    const unchecked = await reserve({ fee: 220, method: "komoju:konbini" });
    expect(await expectDbError(() => confirm(unchecked, { payment_provider: "komoju", amount_paid_jpy: total }))).toMatch(/amount_mismatch/);
    const r = await reserve({ fee: 220, method: "komoju:konbini" });
    await check(r);
    // あいだに決まりを変えた（コンビニ払いは支払いまで日数がかかる）
    await setSettings({ payment_fees: { konbini: { fee_type: "flat", fee_jpy: 330 } } });
    // Stripe では手数料つきの予約を確定しない
    expect(await expectDbError(() => confirm(r, { payment_provider: "stripe", amount_paid_jpy: total }))).toMatch(/amount_mismatch/);
    // 受け取った額が手数料を含まなければ確定しない
    expect(await expectDbError(() => confirm(r, { payment_provider: "komoju", amount_paid_jpy: total - 220, payment_type: "konbini" }))).toMatch(/amount_mismatch/);
    const id = await confirm(r, { payment_provider: "komoju", amount_paid_jpy: total, payment_type: "konbini" });
    const o = (await getPool().query<J>("select fee_jpy, total_jpy, amount_paid_jpy, payment_status, status::text as status from orders where id = $1", [id])).rows[0]!;
    expect(o).toMatchObject({ fee_jpy: 220, total_jpy: total, amount_paid_jpy: total, payment_status: "paid", status: "paid" });
  });

  it("確定: KOMOJU が知らせた種類が選んだ種類と違えば確定しない（手数料が 0 の種類でも）。知らせが無ければ決済ページの絞り込みに任せる", async () => {
    await setSettings({ payment_fees: { konbini: { fee_type: "flat", fee_jpy: 220 }, paypay: { fee_jpy: 0 } } });
    const r = await reserve({ fee: 220, method: "komoju:konbini" });
    await check(r);
    expect(await expectDbError(() => confirm(r, { payment_provider: "komoju", amount_paid_jpy: price + 720, payment_type: "paypay" }))).toMatch(/amount_mismatch/);
    const free = await reserve({ method: "komoju:paypay" });
    await check(free);
    expect(await expectDbError(() => confirm(free, { payment_provider: "komoju", amount_paid_jpy: price + 500, payment_type: "konbini" }))).toMatch(/amount_mismatch/);
    expect(await confirm(free, { payment_provider: "komoju", amount_paid_jpy: price + 500 })).toMatch(/^[0-9a-f-]{36}$/);
    // 種類を選ばない今までの KOMOJU の予約は変わらない
    const plain = await reserve({ method: "komoju" });
    expect(await confirm(plain, { payment_provider: "komoju", amount_paid_jpy: price + 500, payment_type: "konbini" })).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("手数料が 0 の種類でも、種類を選んだ予約は確かめてから（Worker の古い設定で 0 と計算したあいだに手数料を足したとき）", async () => {
    await setSettings({ payment_fees: { konbini: { fee_type: "flat", fee_jpy: 220 }, paypay: { fee_type: "flat", fee_jpy: 0 } } });
    // 確かめずに確定 → 断る
    const r1 = await reserve({ method: "komoju:paypay" });
    expect(await expectDbError(() => confirm(r1, { payment_provider: "komoju", amount_paid_jpy: price + 500 }))).toMatch(/amount_mismatch/);
    // 決まりが 0 → 220 に変わった後、Worker が 0 で作った予約は確かめで止まる
    await setSettings({ payment_fees: { konbini: { fee_type: "flat", fee_jpy: 220 }, paypay: { fee_type: "flat", fee_jpy: 220 } } });
    const r2 = await reserve({ method: "komoju:paypay" });
    expect(await expectDbError(() => check(r2))).toMatch(/amount_mismatch/);
    expect(await expectDbError(() => confirm(r2, { payment_provider: "komoju", amount_paid_jpy: price + 500 }))).toMatch(/amount_mismatch/);
  });

  it("お客様の画面の settings に payment_fees が載る（レジが手数料を出す）", async () => {
    await setSettings({ payment_fees: { konbini: { fee_jpy: 220 } } });
    const shop = await asAnon(async (c) => (await c.query<{ s: J }>("select shop_public_get($1) as s", ["pf-shop"])).rows[0]!.s);
    expect((shop["settings"] as J)["payment_fees"]).toEqual({ konbini: { fee_jpy: 220 } });
  });
});
