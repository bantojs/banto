import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    // 会員の注文の一覧（会員ページ・ヘッドレス）に手数料と支払い方法
    const epoch = (await getPool().query<{ e: number }>("select session_epoch as e from customers where id = $1", [cid])).rows[0]!.e;
    const got = await asService(async (c) => (await c.query<{ r: { orders: J[] } }>("select member_get($1, $2, $3, true) as r", [f.shopId, cid, epoch])).rows[0]!.r);
    expect(got.orders[0]).toMatchObject({ fee_jpy: 330, payment_provider: "cod", payment_status: "unpaid" });
  });

  it("同じ人・同じ IP の未入金の代金引換の注文は上限まで（入金済み・取り消しは数えない）", async () => {
    await setSettings({ modules: { cod: true }, cod: { fee_type: "flat", fee_jpy: 330 }, checkout: { max_cod_unpaid_per_customer: 2, max_cod_unpaid_per_ip: 3 } });
    const subj = "a".repeat(64);
    const ip = "b".repeat(64);
    const mark = (r: string, s: string | null, i: string | null) => getPool().query("update reservations set subject_hash = $2, ip_hash = $3 where id = $1", [r, s, i]);
    const one = await reserve({ fee: 330 });
    await mark(one, subj, ip);
    const first = await cod(one);
    const two = await reserve({ fee: 330 });
    await mark(two, subj, ip);
    await cod(two);
    const three = await reserve({ fee: 330 });
    await mark(three, subj, ip);
    expect(await expectDbError(() => cod(three))).toMatch(/too_many_reservations/);
    // 入金を記録した注文は数えない
    await asUser(f.ownerId, (c) => c.query("select order_payment_record($1, $2)", [f.shopId, first]));
    expect(await cod(three)).toBeTruthy();
    // 同じ IP のほかの人: IP の上限（3。未入金はこの IP で 2 件）
    const other = await reserve({ fee: 330 });
    await mark(other, "c".repeat(64), ip);
    await cod(other);
    const fourth = await reserve({ fee: 330 });
    await mark(fourth, "d".repeat(64), ip);
    expect(await expectDbError(() => cod(fourth))).toMatch(/too_many_reservations/);
    await setSettings({ checkout: {} });
  });

  it("クーポンの条件の支払い方法に cod を受け付ける（0158。AI 用 API と同じ検査）", async () => {
    const run = (cond: J) =>
      asUser(f.ownerId, async (c) => (await c.query<{ r: { conditions: J } }>("select to_jsonb(banto_api_coupon_apply($1, null::coupon_campaigns, $2::jsonb)) as r", [f.shopId, JSON.stringify({ name: "x", kind: "percent", value: 10, conditions: cond })])).rows[0]!.r);
    const got = await asService(async (c) => (await c.query<{ r: { conditions: J } }>("select to_jsonb(banto_api_coupon_apply($1, null::coupon_campaigns, $2::jsonb)) as r", [f.shopId, JSON.stringify({ name: "x", kind: "percent", value: 10, conditions: { payment_methods: ["cod", "stripe"] } })])).rows[0]!.r);
    expect([...(got.conditions["payment_methods"] as string[])].sort()).toEqual(["cod", "stripe"]);
    expect(await expectDbError(() => asService((c) => c.query("select banto_api_coupon_apply($1, null::coupon_campaigns, $2::jsonb)", [f.shopId, JSON.stringify({ conditions: { payment_methods: ["cod:x"] } })])))).toMatch(/invalid_conditions_payment_methods/);
    // 直接は呼べない（AI 用 API・CSV の取り込みの中から使う）
    expect(await expectDbError(() => run({ payment_methods: ["cod"] }))).toMatch(/permission denied/);
  });

  it("同梱のメール・LINE の送信先は order.created を購読する（今ある送信先にも足した）。設定の鍵 cod とモジュールは項目 settings", async () => {
    const perm = (await getPool().query<{ m: string; k: string }>("select banto_shop_settings_perm('modules', 'cod') as m, banto_shop_settings_perm('cod', null) as k")).rows[0]!;
    // 表に無い鍵は null（settings の項目だけでよい）
    expect(perm).toEqual({ m: null, k: null });
    const fn = (await getPool().query<{ src: string }>("select prosrc as src from pg_proc where proname = 'confirm_reservation'")).rows[0]!.src;
    expect(fn).toContain("cod_unavailable");
    // 0157 の前に作られた同梱の送信先（order.created を購読していない）に足す。ほかの送信先・足し済みは変えない
    const sql = readFileSync(join(import.meta.dirname, "..", "..", "supabase", "migrations", "0157_mod_cod.sql"), "utf8");
    const update = sql.slice(sql.indexOf("update hook_endpoints set events"), sql.indexOf("insert into banto_migrations"));
    const add = (url: string, events: string[]) => getPool().query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'x', $2, $3) returning id", [f.shopId, url, events]).then((r) => r.rows[0]!.id);
    const mail = await add("https://banto.invalid/plugins/email_resend", ["order.paid", "order.shipped"]);
    const line = await add("https://banto.invalid/plugins/line_notify", ["order.created", "order.paid"]);
    const other = await add("https://plugin.example.com/other", ["order.paid"]);
    await getPool().query(update);
    await getPool().query(update);
    const ev = async (id: string) => (await getPool().query<{ events: string[] }>("select events from hook_endpoints where id = $1", [id])).rows[0]!.events;
    expect(await ev(mail)).toEqual(["order.paid", "order.shipped", "order.created"]);
    expect(await ev(line)).toEqual(["order.created", "order.paid"]);
    expect(await ev(other)).toEqual(["order.paid"]);
  });
});
