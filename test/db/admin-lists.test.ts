import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0059_admin_lists: 管理画面の部分一致の検索（admin_search_ids）と発行したクーポンの数（coupon_grant_counts）。
 * RLS の外で動くので、権限（項目）を確かめること・他のショップの行を返さないこと・LIKE の特別な文字を字のまま探すことを確かめる。
 */
describe.skipIf(!dbAvailable)("管理画面の検索（0059）", () => {
  let a: Fixture;
  let b: Fixture;
  const search = (uid: string, shopId: string, kind: string, q: string, filters: Record<string, string> = {}, after: [string, string] | null = null, limit = 50) =>
    asUser(uid, async (c) => (await c.query<{ r: string[] }>("select admin_search_ids($1, $2, $3, $4, $5, $6, $7) as r", [shopId, kind, q, JSON.stringify(filters), after?.[0] ?? null, after?.[1] ?? null, limit])).rows[0]!.r);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "al-a@example.com", slug: "al-a", publish: true });
    b = await createShopFixture({ email: "al-b@example.com", slug: "al-b", publish: true });
    const pool = getPool();
    await pool.query("insert into products (shop_id, slug, name, published, created_at) select $1, 'x-' || g, case when g = 3 then '100%_綿 シャツ' else '綿シャツ ' || g end, g % 2 = 0, now() - (g || ' minutes')::interval from generate_series(1, 30) g", [a.shopId]);
    await pool.query("insert into products (shop_id, slug, name, published) values ($1, 'other', '綿シャツ', true)", [b.shopId]);
    await pool.query(
      "insert into orders (shop_id, number, status, total_jpy, shipping_jpy, customer_email, customer_name, payment_provider, payment_ref) values ($1, 1001, 'paid', 100, 0, 'yamada@example.com', '山田', 'stripe', 'pi_abc'), ($1, 1002, 'shipped', 100, 0, 'sato@example.com', '佐藤', 'stripe', 'pi_def')",
      [a.shopId],
    );
    await pool.query("insert into customers (shop_id, email, name, attributes, marketing_consent) values ($1, 'gold@example.com', '金', '{\"rank\":\"Gold\"}', true), ($1, 'silver@example.com', '銀', '{\"rank\":\"Silver\"}', null)", [a.shopId]);
  });
  afterAll(closePool);

  it("商品: 名前・スラッグの部分一致、公開の状態、新しい順のキーセット。他のショップの行は返さない", async () => {
    const all = await search(a.ownerId, a.shopId, "products", "綿");
    expect(all).toHaveLength(30);
    const pub = await search(a.ownerId, a.shopId, "products", "綿", { state: "published" });
    expect(pub).toHaveLength(15);
    const first = await search(a.ownerId, a.shopId, "products", "綿", {}, null, 10);
    const row = (await getPool().query("select created_at, id from products where id = $1", [first[9]])).rows[0];
    const next = await search(a.ownerId, a.shopId, "products", "綿", {}, [row.created_at.toISOString(), row.id], 50);
    expect(next).toHaveLength(20);
    expect(new Set([...first, ...next]).size).toBe(30);
    expect(await search(a.ownerId, a.shopId, "products", "100%_")).toHaveLength(1);
    expect(await search(a.ownerId, a.shopId, "products", "%")).toHaveLength(1);
    expect(await search(a.ownerId, a.shopId, "products", "x-1")).toHaveLength(11);
  });

  it("注文: 番号・決済の参照は完全一致、メール・氏名は部分一致、状態", async () => {
    expect(await search(a.ownerId, a.shopId, "orders", "1001")).toHaveLength(1);
    expect(await search(a.ownerId, a.shopId, "orders", "pi_abc")).toHaveLength(1);
    expect(await search(a.ownerId, a.shopId, "orders", "pi_")).toHaveLength(0);
    expect(await search(a.ownerId, a.shopId, "orders", "EXAMPLE.com")).toHaveLength(2);
    expect(await search(a.ownerId, a.shopId, "orders", "example", { status: "shipped" })).toHaveLength(1);
  });

  it("会員: メール・氏名・独自項目の値（部分一致）と案内メールの同意", async () => {
    expect(await search(a.ownerId, a.shopId, "customers", "GOLD")).toHaveLength(1);
    expect(await search(a.ownerId, a.shopId, "customers", "", { field: "rank", value: "il" })).toHaveLength(1);
    expect(await search(a.ownerId, a.shopId, "customers", "example", { consent: "none" })).toHaveLength(1);
    expect(await search(a.ownerId, a.shopId, "customers", "", { field: "rank'; drop table customers; --", value: "x" })).toHaveLength(2);
  });

  it("権限: 他人のショップ・項目の無いメンバーは forbidden。種類は決まったものだけ", async () => {
    expect(await expectDbError(() => search(b.ownerId, a.shopId, "products", "綿"))).toMatch(/forbidden/);
    const stranger = await createAuthUser("al-x@example.com");
    expect(await expectDbError(() => search(stranger, a.shopId, "customers", "gold"))).toMatch(/forbidden/);
    expect(await expectDbError(() => search(a.ownerId, a.shopId, "shops", "x"))).toMatch(/invalid_kind/);
  });

  it("発行したクーポンの数は marketing の項目だけ", async () => {
    const pool = getPool();
    const camp = (await pool.query<{ id: string }>("insert into coupon_campaigns (shop_id, name, code, kind, value) values ($1, 'c', 'CNT', 'fixed', 100) returning id", [a.shopId])).rows[0]!.id;
    await pool.query("insert into coupon_grants (shop_id, campaign_id, code, status) select $1, $2, 'CG-' || g, case when g <= 2 then 'used' else 'available' end from generate_series(1, 5) g", [a.shopId, camp]);
    const counts = (uid: string) => asUser(uid, async (c) => (await c.query("select coupon_grant_counts($1, $2) as r", [a.shopId, camp])).rows[0]!.r);
    expect(await counts(a.ownerId)).toEqual({ available: 3, held: 0, used: 2, revoked: 0 });
    expect(await counts(b.ownerId)).toBeNull();
  });
});
