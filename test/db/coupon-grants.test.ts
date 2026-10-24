import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

describe.skipIf(!dbAvailable)("配布型のクーポン（0019_coupon_grants）", () => {
  let f: Fixture;
  let other: Fixture;
  let campaign: string;
  let member: string;
  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "g@example.com", slug: "g-shop", publish: true, stock: 20 });
    other = await createShopFixture({ email: "o@example.com", slug: "o-shop", publish: true });
    campaign = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into coupon_campaigns (shop_id, name, kind, value, grant_valid_days) values ($1, 'お礼', 'fixed', 100, 30) returning id", [f.shopId]))).rows[0]!.id;
    member = (await getPool().query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'm@example.com') returning id", [f.shopId])).rows[0]!.id;
  });
  afterAll(closePool);

  const issue = (owner: string, customers: string[], count: number, shop = f.shopId) =>
    asUser(owner, async (c) => (await c.query<{ r: { issued: number } }>("select coupon_grants_issue($1, $2, $3::uuid[], $4) as r", [shop, campaign, customers, count])).rows[0]!.r);
  const reserve = () => asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: 1 }])])).rows[0]!.id);
  const apply = (res: string, subject: string, grant: { id: string; code: string }) =>
    asService((c) => c.query("select apply_reservation_discounts($1, $2, $3, $4::jsonb)", [res, f.shopId, subject, JSON.stringify({ total_jpy: 100, lines: [{ sku_id: f.skuId, discount_jpy: 100 }], applied: [{ campaign_id: campaign, grant_id: grant.id, code: grant.code, name: "お礼", kind: "fixed", amount_jpy: 100 }] })]));
  const grantRow = async (id: string) => (await getPool().query<{ status: string; reservation_id: string | null }>("select status, reservation_id from coupon_grants where id = $1", [id])).rows[0]!;
  const guest = `e:${"a".repeat(64)}`;

  it("発行: 会員ごとに 1 枚（重ねない）と、コードだけのもの。期限は 30 日。他人のショップには発行できない", async () => {
    expect(await issue(f.ownerId, [member, member], 3)).toEqual({ issued: 4 });
    expect(await issue(f.ownerId, [member], 0)).toEqual({ issued: 0 });
    const rows = (await getPool().query<{ code: string; expires_at: Date; customer_id: string | null }>("select code, expires_at, customer_id from coupon_grants where campaign_id = $1", [campaign])).rows;
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      expect(r.expires_at.getTime() - Date.now()).toBeGreaterThan(29 * 86400_000);
    }
    expect(await expectDbError(() => issue(other.ownerId, [], 1))).toMatch(/shop_not_found/);
    // 運営者は自分の発行済みクーポンを読める。購入者（anon）は読めない
    expect((await asUser(f.ownerId, (c) => c.query("select id from coupon_grants"))).rows).toHaveLength(4);
    expect((await asUser(other.ownerId, (c) => c.query("select id from coupon_grants"))).rows).toHaveLength(0);
    expect((await asAnon((c) => c.query("select id from coupon_grants"))).rows).toHaveLength(0);
  });

  it("coupon_lookup がコードから発行済みのクーポンを返し、member_coupons が会員のものを返す", async () => {
    const g = (await getPool().query<{ code: string }>("select code from coupon_grants where customer_id = $1", [member])).rows[0]!;
    const rows = await asService(async (c) => (await c.query<{ r: Record<string, unknown>[] }>("select coupon_lookup($1, $2::text[], null) as r", [f.shopId, [g.code.toLowerCase()]])).rows[0]!.r);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: campaign, code: g.code, kind: "fixed", value: 100, grant: { status: "available", customer_id: member } });
    const mine = await asService(async (c) => (await c.query<{ r: unknown[] }>("select member_coupons($1, $2, 0) as r", [f.shopId, member])).rows[0]!.r);
    expect(mine).toMatchObject([{ code: g.code, name: "お礼" }]);
    expect(await asService(async (c) => (await c.query("select member_coupons($1, $2, 9) as r", [f.shopId, member])).rows[0].r)).toBeNull();
  });

  it("使い捨てコード: 1 つの予約だけが押さえられる。解放で戻り、確定で使用済み、キャンセルで戻る", async () => {
    const g = (await getPool().query<{ id: string; code: string }>("select id, code from coupon_grants where customer_id is null limit 1")).rows[0]!;
    const r1 = await reserve();
    await apply(r1, guest, g);
    expect(await grantRow(g.id)).toMatchObject({ status: "held", reservation_id: r1 });
    const r2 = await reserve();
    expect(await expectDbError(() => apply(r2, guest, g))).toMatch(/coupon_unavailable/);
    await asService((c) => c.query("select release_reservation($1, $2)", [r2, f.shopId]));
    // 解放で戻る
    await asService((c) => c.query("select release_reservation($1, $2)", [r1, f.shopId]));
    expect(await grantRow(g.id)).toMatchObject({ status: "available", reservation_id: null });
    // 確定で使用済み
    const r3 = await reserve();
    await apply(r3, guest, g);
    const orderId = (await asService((c) => c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [r3, f.shopId, JSON.stringify({ payment_provider: "stripe", payment_ref: "pi_g" })]))).rows[0]!.id;
    expect((await grantRow(g.id)).status).toBe("used");
    // キャンセルで戻る
    await asService((c) => c.query("select cancel_order($1, $2, true)", [orderId, f.shopId]));
    expect((await grantRow(g.id)).status).toBe("available");
  });

  it("会員に発行したものは、その会員の subject だけ。取り消したもの・期限切れは使えない", async () => {
    const g = (await getPool().query<{ id: string; code: string }>("select id, code from coupon_grants where customer_id = $1", [member])).rows[0]!;
    const r1 = await reserve();
    expect(await expectDbError(() => apply(r1, guest, g))).toMatch(/coupon_unavailable/);
    await apply(r1, `c:${member}`, g);
    await asService((c) => c.query("select release_reservation($1, $2)", [r1, f.shopId]));

    const spare = (await getPool().query<{ id: string; code: string }>("select id, code from coupon_grants where customer_id is null and status = 'available' order by created_at desc limit 1")).rows[0]!;
    expect((await asUser(f.ownerId, (c) => c.query<{ r: boolean }>("select coupon_grant_revoke($1, $2) as r", [f.shopId, spare.id]))).rows[0]!.r).toBe(true);
    const r2 = await reserve();
    expect(await expectDbError(() => apply(r2, guest, spare))).toMatch(/coupon_unavailable/);
    await asService((c) => c.query("select release_reservation($1, $2)", [r2, f.shopId]));

    await getPool().query("update coupon_grants set expires_at = now() - interval '1 minute' where id = $1", [g.id]);
    const r3 = await reserve();
    expect(await expectDbError(() => apply(r3, `c:${member}`, g))).toMatch(/coupon_unavailable/);
    await asService((c) => c.query("select release_reservation($1, $2)", [r3, f.shopId]));
  });

  it("購入者・anon は発行の関数を呼べない", async () => {
    expect(await expectDbError(() => asAnon((c) => c.query("select coupon_grants_issue($1, $2, '{}'::uuid[], 1)", [f.shopId, campaign])))).toMatch(/permission denied|shop_not_found/);
    expect(await expectDbError(() => asAnon((c) => c.query("select member_coupons($1, $2, 0)", [f.shopId, member])))).toMatch(/permission denied|service_role only/);
  });
});
