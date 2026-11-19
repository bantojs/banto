import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, closePool, createShopFixture, dbAvailable, getPool, resetDatabase, type Fixture } from "./harness";

type J = Record<string, unknown>;

/** 0159: 会員の注文のお届け先を既定の住所に写す（無ければいつも、あれば save_address のときだけ）。ゲスト・予約の無い注文は何もしない */
describe.skipIf(!dbAvailable)("会員の住所の保存（0159）", () => {
  let f: Fixture;
  const ship = (line1: string): J => ({ name: "会員 花子", phone: "0312345678", postal_code: "1000001", country: "JP", state: "東京都", city: "千代田区", line1, line2: null, extra: "x" });

  async function newMember(email: string, address: J | null = null, name: string | null = null): Promise<string> {
    return (await getPool().query<{ id: string }>("insert into customers (shop_id, email, name, default_address) values ($1, $2, $3, $4) returning id", [f.shopId, email, name, address ? JSON.stringify(address) : null])).rows[0]!.id;
  }
  async function place(customerId: string | null, line1: string, save = false): Promise<string> {
    const resId = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: 1 }])])).rows[0]!.id);
    await asService((c) =>
      c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [resId, f.shopId, JSON.stringify({ customer_email: "x@example.com", customer_name: "会員 花子", shipping_address: ship(line1), shipping_jpy: 500, ...(save ? { save_address: true } : {}) })]),
    );
    if (customerId) await getPool().query("update reservations set customer_id = $2 where id = $1", [resId, customerId]);
    const price = (await getPool().query<{ p: number }>("select price_jpy as p from skus where id = $1", [f.skuId])).rows[0]!.p;
    return asService(async (c) => (await c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [resId, f.shopId, JSON.stringify({ payment_provider: "stripe", payment_ref: `pi_${resId}`, amount_paid_jpy: price + 500, currency: "jpy" })])).rows[0]!.id);
  }
  const addressOf = async (id: string) => (await getPool().query<{ a: J | null; n: string | null }>("select default_address as a, name as n from customers where id = $1", [id])).rows[0]!;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "addr-owner@example.com", slug: "addr-shop", publish: true, stock: 50 });
  });
  afterAll(closePool);

  it("既定の住所が無い会員: 注文のお届け先を入れる（知っている鍵だけ）。氏名が空なら氏名も", async () => {
    const id = await newMember("first@example.com");
    await place(id, "一丁目 1");
    const got = await addressOf(id);
    expect(got.a).toEqual({ name: "会員 花子", phone: "0312345678", postal_code: "1000001", country: "JP", state: "東京都", city: "千代田区", line1: "一丁目 1", line2: null });
    expect(got.n).toBe("会員 花子");
  });

  it("既定の住所がある会員: save_address のときだけ上書き。氏名は変えない", async () => {
    const id = await newMember("second@example.com", { name: "前", line1: "前の番地" }, "元の名前");
    await place(id, "二丁目 2");
    expect((await addressOf(id)).a).toEqual({ name: "前", line1: "前の番地" });
    await place(id, "三丁目 3", true);
    const got = await addressOf(id);
    expect(got.a).toMatchObject({ line1: "三丁目 3" });
    expect(got.n).toBe("元の名前");
  });

  it("ゲストの注文・予約の無い注文（復元）は何もしない", async () => {
    const id = await newMember("guest-like@example.com");
    await place(null, "四丁目 4");
    expect((await addressOf(id)).a).toBeNull();
    await getPool().query("insert into orders (shop_id, status, total_jpy, number, customer_id, shipping_address) values ($1, 'paid', 0, 99999, $2, $3)", [f.shopId, id, JSON.stringify(ship("復元"))]);
    expect((await addressOf(id)).a).toBeNull();
  });
});
