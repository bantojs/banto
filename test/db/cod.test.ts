import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";
import { COD_FEE_CASES } from "../fixtures/cod-fee-cases";

type J = Record<string, unknown>;

/**
 * 0157_mod_cod: 代金引換。確定は「Webhook のみ」の例外で、confirm_reservation がその場で受付（pending・未入金）の注文を作り、
 * order.created だけを出す（order.paid は入金の記録のとき、0156）。手数料・上限・会員だけ・モジュールの ON は DB が引き直す
 */
describe.skipIf(!dbAvailable)("代金引換（0157）", () => {
  let f: Fixture;
  let price: number;
  let cid: string;
  const setSettings = (s: J) => getPool().query("update shops set settings = settings || $2::jsonb where id = $1", [f.shopId, JSON.stringify(s)]);
  const stock = async () => (await getPool().query<{ available: number }>("select available from inventory where sku_id = $1", [f.skuId])).rows[0]!.available;

  async function reserve(opts: { qty?: number; shipping?: number; fee?: number; customer?: string } = {}): Promise<string> {
    const resId = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: opts.qty ?? 1 }])])).rows[0]!.id);
    await asService((c) =>
      c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [resId, f.shopId, JSON.stringify({ customer_email: "buyer@example.com", customer_name: "買い手", shipping_address: {}, shipping_jpy: opts.shipping ?? 500, ...(opts.fee !== undefined ? { fee_jpy: opts.fee } : {}) })]),
    );
    if (opts.customer) await getPool().query("update reservations set customer_id = $2 where id = $1", [resId, opts.customer]);
    return resId;
  }
  const confirm = (resId: string, order: J) => asService(async (c) => (await c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [resId, f.shopId, JSON.stringify({ currency: "jpy", ...order })])).rows[0]!.id);
  const cod = (resId: string) => confirm(resId, { payment_provider: "cod", payment_ref: `cod-${resId}`, amount_paid_jpy: 0 });

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "cod-owner@example.com", slug: "cod-shop", publish: true, stock: 50 });
    price = (await getPool().query<{ price_jpy: number }>("select price_jpy from skus where id = $1", [f.skuId])).rows[0]!.price_jpy;
    cid = (await getPool().query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'member@example.com') returning id", [f.shopId])).rows[0]!.id;
    await getPool().query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'p', 'https://plugin.example.com/h', '{order.created,order.paid}')", [f.shopId]);
  });
  afterAll(closePool);

  it("手数料の決まり: banto_cod_fee は答え合わせの表（TS の codFee と同じ）どおり。service_role 以外は呼べない", async () => {
    for (const k of COD_FEE_CASES) {
      const got = (await getPool().query<{ fee: number | null }>("select banto_cod_fee($1::jsonb, $2) as fee", [JSON.stringify(k.settings), k.amount])).rows[0]!.fee;
      expect([k.name, got]).toEqual([k.name, k.fee]);
    }
    expect(await expectDbError(() => asAnon((c) => c.query("select banto_cod_fee('{}'::jsonb, 1)")))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select banto_cod_max_total('{}'::jsonb)")))).toMatch(/permission denied/);
  });

  it("モジュールが OFF なら確定しない（予約はそのまま）", async () => {
    await setSettings({ modules: { cod: false }, cod: { fee_jpy: 330 } });
    const r = await reserve({ fee: 330 });
    expect(await expectDbError(() => cod(r))).toMatch(/cod_unavailable/);
    expect((await getPool().query<{ status: string }>("select status from reservations where id = $1", [r])).rows[0]!.status).toBe("pending");
  });

  it("受付（未入金）で確定: 合計に手数料、受け取った額は空、order.created だけ（order.paid は出さない）", async () => {
    await setSettings({ modules: { cod: true }, cod: { fee_type: "flat", fee_jpy: 330 } });
    const before = await stock();
    const r = await reserve({ qty: 2, fee: 330 });
    const id = await cod(r);
    expect(await stock()).toBe(before - 2);
    const o = (await getPool().query<J>("select status::text as status, payment_status, paid_at, fee_jpy, total_jpy, amount_paid_jpy, payment_provider from orders where id = $1", [id])).rows[0]!;
    expect(o).toMatchObject({ status: "pending", payment_status: "unpaid", paid_at: null, fee_jpy: 330, total_jpy: price * 2 + 500 + 330, amount_paid_jpy: null, payment_provider: "cod" });
    const created = (await getPool().query<{ payload: J }>("select payload from hook_deliveries where event = 'order.created' and payload->>'order_id' = $1", [id])).rows.map((x) => x.payload);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ status: "pending", payment_status: "unpaid", fee_jpy: 330, total_jpy: price * 2 + 830 });
    expect((await getPool().query("select 1 from hook_deliveries where event = 'order.paid' and payload->>'order_id' = $1", [id])).rowCount).toBe(0);
    // 冪等: 同じ予約は同じ注文
    expect(await cod(r)).toBe(id);
    // 入金の記録で入金済み、order.paid（recorded_payment）
    const rec = await asUser(f.ownerId, async (c) => (await c.query<{ r: J }>("select order_payment_record($1, $2) as r", [f.shopId, id])).rows[0]!.r);
    expect(rec).toMatchObject({ already: false });
    const paid = (await getPool().query<{ payload: J }>("select payload from hook_deliveries where event = 'order.paid' and payload->>'order_id' = $1", [id])).rows.map((x) => x.payload);
    expect(paid[0]).toMatchObject({ recorded_payment: true, fee_jpy: 330 });
    // 注文照会・API の材料にも手数料
    const view = (await getPool().query<{ v: J }>("select banto_order_view(o) as v from orders o where id = $1", [id])).rows[0]!.v;
    expect(view).toMatchObject({ fee_jpy: 330 });
    const contact = await asService(async (c) => (await c.query<{ r: J }>("select order_contact($1, $2) as r", [id, f.shopId])).rows[0]!.r);
    expect(contact).toMatchObject({ fee_jpy: 330, payment_status: "paid" });
  });

  it("手数料が決まりと違う・ほかの支払い方法に手数料・受け取った額が 0 でない、は確定しない", async () => {
    await setSettings({ modules: { cod: true }, cod: { fee_type: "flat", fee_jpy: 330 } });
    const a = await reserve({ fee: 300 });
    expect(await expectDbError(() => cod(a))).toMatch(/amount_mismatch/);
    const b = await reserve({ fee: 330 });
    expect(await expectDbError(() => confirm(b, { payment_provider: "stripe", payment_ref: "pi_1", amount_paid_jpy: price + 500 + 330 }))).toMatch(/amount_mismatch/);
    const c = await reserve({ fee: 330 });
    expect(await expectDbError(() => confirm(c, { payment_provider: "cod", amount_paid_jpy: price + 830 }))).toMatch(/amount_mismatch/);
    expect(await expectDbError(() => reserve({ fee: -1 }))).toMatch(/invalid_fee/);
  });

  it("段に当たらない・上限を超える・会員だけ（ゲスト）は確定しない。会員なら確定する", async () => {
    await setSettings({ modules: { cod: true }, cod: { fee_type: "tiers", fee_tiers: [{ upto: price + 500, fee: 330 }] } });
    const over = await reserve({ qty: 2, fee: 330 });
    expect(await expectDbError(() => cod(over))).toMatch(/cod_unavailable/);
    await setSettings({ cod: { fee_jpy: 330, max_total_jpy: price + 500 + 329 } });
    const max = await reserve({ fee: 330 });
    expect(await expectDbError(() => cod(max))).toMatch(/cod_unavailable/);
    await setSettings({ cod: { fee_jpy: 330, members_only: true } });
    const guest = await reserve({ fee: 330 });
    expect(await expectDbError(() => cod(guest))).toMatch(/cod_unavailable/);
    const member = await reserve({ fee: 330, customer: cid });
    expect(await cod(member)).toBeTruthy();
  });

  it("同梱のメール・LINE の送信先は order.created を購読する（今ある送信先にも足した）。設定の鍵 cod とモジュールは項目 settings", async () => {
    const perm = (await getPool().query<{ m: string; k: string }>("select banto_shop_settings_perm('modules', 'cod') as m, banto_shop_settings_perm('cod', null) as k")).rows[0]!;
    // 表に無い鍵は null（settings の項目だけでよい）
    expect(perm).toEqual({ m: null, k: null });
    const fn = (await getPool().query<{ src: string }>("select prosrc as src from pg_proc where proname = 'confirm_reservation'")).rows[0]!.src;
    expect(fn).toContain("cod_unavailable");
  });
});
