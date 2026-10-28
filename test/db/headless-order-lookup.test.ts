import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

type J = Record<string, unknown>;

/**
 * 0066_headless_order_lookup: 注文照会・領収書をヘッドレスで。会員の注文（member_order）・ゲストの注文照会（lookup_order の形が変わらない）・
 * 注文メールの材料（order_contact の member と order_page_url）・公開の settings の order_page_url を確かめる。
 */
describe.skipIf(!dbAvailable)("ヘッドレスの注文照会（0066）", () => {
  let a: Fixture;
  let memberId: string;
  let otherMember: string;
  let memberOrder: string;
  let guestOrder: string;

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "ol-a@example.com", slug: "ol-a", publish: true, stock: 5 });
    const pool = getPool();
    memberId = (await pool.query<{ id: string }>("insert into customers (shop_id, email, name) values ($1, 'm@example.com', '会員') returning id", [a.shopId])).rows[0]!.id;
    otherMember = (await pool.query<{ id: string }>("insert into customers (shop_id, email, name) values ($1, 'o@example.com', '別の会員') returning id", [a.shopId])).rows[0]!.id;
    memberOrder = (await pool.query<{ id: string }>("insert into orders (shop_id, number, status, total_jpy, shipping_jpy, customer_email, customer_name, shipping_address, customer_id, payment_provider, payment_ref) values ($1, 1001, 'paid', 3500, 500, 'order@example.com', '会員', '{\"state\":\"東京都\",\"line1\":\"千代田1-1\"}', $2, 'stripe', 'pi_m') returning id", [a.shopId, memberId])).rows[0]!.id;
    guestOrder = (await pool.query<{ id: string }>("insert into orders (shop_id, number, status, total_jpy, shipping_jpy, customer_email, customer_name, shipping_address, payment_provider, payment_ref) values ($1, 1002, 'paid', 3000, 0, 'guest@example.com', 'ゲスト', '{\"state\":\"大阪府\"}', 'stripe', 'pi_g') returning id", [a.shopId])).rows[0]!.id;
    await pool.query("insert into order_items (shop_id, order_id, sku_id, qty, unit_price_jpy) values ($1, $2, $3, 1, 3000)", [a.shopId, memberOrder, a.skuId]);
    await pool.query("insert into order_items (shop_id, order_id, sku_id, qty, unit_price_jpy) values ($1, $2, $3, 1, 3000)", [a.shopId, guestOrder, a.skuId]);
  });
  afterAll(closePool);

  const memberGet = (customer: string, epoch: number, number: number) =>
    asService(async (c) => (await c.query<{ r: J | null }>("select member_order($1, $2, $3, $4) as r", [a.shopId, customer, epoch, number])).rows[0]!.r);

  it("会員の注文: その会員の注文だけ。世代が違えば null。住所もアドレスも返さない", async () => {
    const r = await memberGet(memberId, 0, 1001);
    expect(r).toMatchObject({ number: 1001, status: "paid", total_jpy: 3500, items: [{ qty: 1, unit_price_jpy: 3000 }] });
    expect(JSON.stringify(r)).not.toContain("千代田");
    expect(JSON.stringify(r)).not.toContain("order@example.com");
    expect(await memberGet(otherMember, 0, 1001)).toBeNull();
    expect(await memberGet(memberId, 0, 1002)).toBeNull();
    expect(await memberGet(memberId, 1, 1001)).toBeNull();
    expect(await expectDbError(() => asAnon((c) => c.query("select member_order($1, $2, 0, 1001)", [a.shopId, memberId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select member_order($1, $2, 0, 1001)", [a.shopId, memberId])))).toMatch(/permission denied/);
  });

  it("ゲストの注文照会（lookup_order）: 形は今までどおり。会員の注文と同じ中身で、アドレスが違えば null", async () => {
    const guest = await asAnon(async (c) => (await c.query<{ r: J | null }>("select lookup_order($1, 1002, ' GUEST@example.com ') as r", [a.shopId])).rows[0]!.r);
    expect(guest).toMatchObject({ number: 1002, status: "paid", total_jpy: 3000, discounts: [], tracking: null });
    expect(Object.keys(guest!).sort()).toEqual(["created_at", "discount_jpy", "discounts", "items", "number", "payment_provider", "shipped_at", "shipping_jpy", "shipping_tax_rate", "status", "tax_rounding", "total_jpy", "tracking"]);
    expect(JSON.stringify(guest)).not.toContain("大阪府");
    expect(await asAnon(async (c) => (await c.query("select lookup_order($1, 1002, 'x@example.com') as r", [a.shopId])).rows[0].r)).toBeNull();
    const member = await memberGet(memberId, 0, 1001);
    expect(Object.keys(member!).sort()).toEqual(Object.keys(guest!).sort());
  });

  it("注文メールの材料: 会員の注文か・注文照会のページ・許可リスト。公開の settings にも注文照会のページが出る", async () => {
    await getPool().query(`update shops set settings = settings || '{"headless":{"return_origins":["https://wp.example.com"],"order_page_url":"https://wp.example.com/order-status","relay_ips":["203.0.113.1"]}}'::jsonb where id = $1`, [a.shopId]);
    const contact = (oid: string) => asService(async (c) => (await c.query<{ r: { member: boolean; shop: J } }>("select order_contact($1, $2) as r", [oid, a.shopId])).rows[0]!.r);
    const m = await contact(memberOrder);
    expect(m.member).toBe(true);
    expect(m.shop).toMatchObject({ order_page_url: "https://wp.example.com/order-status", return_origins: ["https://wp.example.com"] });
    expect((await contact(guestOrder)).member).toBe(false);
    const pub = await asAnon(async (c) => (await c.query<{ r: { settings: { headless: J } } }>("select shop_public_get('ol-a', null) as r")).rows[0]!.r);
    expect(pub.settings.headless).toEqual({ return_origins: ["https://wp.example.com"], order_page_url: "https://wp.example.com/order-status" });
  });
});
