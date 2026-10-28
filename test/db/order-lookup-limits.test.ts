import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0067_order_lookup_limits: ゲストの注文照会の回数の上限。lookup_order は anon から外れ、service_role の order_lookup が
 * 外れた照会を IP・注文ごとに数える（合った照会は数えない）
 */
describe.skipIf(!dbAvailable)("注文照会の回数の上限（0067）", () => {
  let a: Fixture;
  const ipA = "a".repeat(64);
  const ipB = "b".repeat(64);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "ll-a@example.com", slug: "ll-a", publish: true, stock: 5 });
    const pool = getPool();
    await pool.query("insert into orders (shop_id, number, status, total_jpy, shipping_jpy, customer_email, customer_name, shipping_address, payment_provider, payment_ref) values ($1, 1001, 'paid', 3000, 0, 'guest@example.com', 'ゲスト', '{}', 'stripe', 'pi_1')", [a.shopId]);
    await pool.query("insert into orders (shop_id, number, status, total_jpy, shipping_jpy, customer_email, customer_name, shipping_address, payment_provider, payment_ref) values ($1, 1002, 'paid', 3000, 0, 'other@example.com', 'ゲスト', '{}', 'stripe', 'pi_2')", [a.shopId]);
  });
  afterAll(closePool);

  const lookup = (number: number, email: string, ip: string | null) =>
    asService(async (c) => (await c.query<{ r: Record<string, unknown> | null }>("select order_lookup($1, $2, $3, $4) as r", [a.shopId, number, email, ip])).rows[0]!.r);

  it("anon・authenticated は lookup_order も order_lookup も呼べない", async () => {
    expect(await expectDbError(() => asAnon((c) => c.query("select lookup_order($1, 1001, 'guest@example.com')", [a.shopId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select lookup_order($1, 1001, 'guest@example.com')", [a.shopId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asAnon((c) => c.query("select order_lookup($1, 1001, 'guest@example.com', null)", [a.shopId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asAnon((c) => c.query("select * from order_lookup_failures")))).toMatch(/permission denied/);
  });

  it("合った照会は数えない。外れは同じ IP から 20 回で止まり、別の IP は通る。ショップの設定で変えられる", async () => {
    for (let i = 0; i < 25; i++) expect(await lookup(1001, "guest@example.com", ipA)).toMatchObject({ number: 1001 });
    for (let i = 0; i < 20; i++) expect(await lookup(1001, `x${i}@example.com`, ipA)).toBeNull();
    expect(await expectDbError(() => lookup(1001, "guest@example.com", ipA))).toMatch(/too_many_requests/);
    expect(await lookup(1001, "guest@example.com", ipB)).toMatchObject({ number: 1001 });
    await getPool().query(`update shops set settings = settings || '{"order_lookup":{"per_ip_per_hour":"30"}}'::jsonb where id = $1`, [a.shopId]);
    expect(await lookup(1001, "guest@example.com", ipA)).toMatchObject({ number: 1001 });
  });

  it("同じ注文への外れは IP を変えても 1 時間 50 回で止まる（ほかの注文は通る）", async () => {
    await getPool().query("delete from order_lookup_failures");
    for (let i = 0; i < 50; i++) expect(await lookup(1002, `y${i}@example.com`, i.toString(16).padStart(64, "0"))).toBeNull();
    expect(await expectDbError(() => lookup(1002, "other@example.com", ipB))).toMatch(/too_many_requests/);
    expect(await lookup(1001, "guest@example.com", ipB)).toMatchObject({ number: 1001 });
    // 1 時間を過ぎた外れは数えない
    await getPool().query("update order_lookup_failures set created_at = now() - interval '2 hours'");
    expect(await lookup(1002, "other@example.com", ipB)).toMatchObject({ number: 1002 });
  });
});
