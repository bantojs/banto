import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0133_customer_stats_note: 会員の購入の集計の列（注文の表のトリガーだけが直す）と社内メモ（customer_set_note だけが書く）
 */
describe.skipIf(!dbAvailable)("会員の購入の集計と社内メモ（0133）", () => {
  let a: Fixture;
  let b: Fixture;
  let member: string;
  const stats = async (id: string) =>
    (await getPool().query<{ orders_count: number; total_spent_jpy: string; last_order_at: Date | null; updated_at: Date }>("select orders_count, total_spent_jpy, last_order_at, updated_at from customers where id = $1", [id])).rows[0]!;
  let seq = 2000;
  const order = (shopId: string, customerId: string | null, total: number, status = "paid", at = new Date().toISOString()) =>
    getPool()
      .query<{ id: string }>("insert into orders (shop_id, number, status, total_jpy, shipping_jpy, customer_email, customer_name, customer_id, created_at) values ($1, $2, $3, $4, 0, 'm@example.com', 'm', $5, $6) returning id", [shopId, ++seq, status, total, customerId, at])
      .then((r) => r.rows[0]!.id);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "cs-a@example.com", slug: "cs-a", publish: true });
    b = await createShopFixture({ email: "cs-b@example.com", slug: "cs-b", publish: true });
    member = (await getPool().query<{ id: string }>("insert into customers (shop_id, email, name) values ($1, 'm@example.com', '会員') returning id", [a.shopId])).rows[0]!.id;
  });
  afterAll(closePool);

  it("支払い済み・発送済みの注文だけを数え、キャンセル・返金・結び付けの変更・削除で直る。集計だけが変わっても updated_at は動かない", async () => {
    const before = await stats(member);
    expect(before).toMatchObject({ orders_count: 0, total_spent_jpy: "0", last_order_at: null });
    const o1 = await order(a.shopId, member, 3000, "paid", "2026-11-01T00:00:00Z");
    const o2 = await order(a.shopId, member, 5000, "shipped", "2026-11-03T00:00:00Z");
    await order(a.shopId, member, 9999, "cancelled", "2026-11-05T00:00:00Z");
    let s = await stats(member);
    expect(s).toMatchObject({ orders_count: 2, total_spent_jpy: "8000" });
    expect(s.last_order_at!.toISOString()).toBe("2026-11-03T00:00:00.000Z");
    expect(s.updated_at.getTime()).toBe(before.updated_at.getTime());
    await getPool().query("update orders set status = 'refunded' where id = $1", [o2]);
    s = await stats(member);
    expect(s).toMatchObject({ orders_count: 1, total_spent_jpy: "3000" });
    expect(s.last_order_at!.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    // 結び付けを外す・別の会員へ（両方の会員が直る）
    const other = (await getPool().query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'o@example.com') returning id", [a.shopId])).rows[0]!.id;
    await getPool().query("update orders set customer_id = $2 where id = $1", [o1, other]);
    expect(await stats(member)).toMatchObject({ orders_count: 0, total_spent_jpy: "0", last_order_at: null });
    expect(await stats(other)).toMatchObject({ orders_count: 1, total_spent_jpy: "3000" });
    await getPool().query("delete from orders where id = $1", [o1]);
    expect(await stats(other)).toMatchObject({ orders_count: 0 });
  });

  it("会員の行を後から作っても（復元・取り込み）、結び付いた注文から数える", async () => {
    const id = "00000000-0000-4000-a000-00000000c0de";
    // 注文が先に会員の id を持つ（orders.customer_id に外部キーは無い。復元は注文を先に入れる）
    await order(a.shopId, id, 700, "paid");
    await order(a.shopId, id, 50, "cancelled");
    await getPool().query("insert into customers (id, shop_id, email) values ($1, $2, 'late@example.com')", [id, a.shopId]);
    expect(await stats(id)).toMatchObject({ orders_count: 1, total_spent_jpy: "700" });
  });

  it("社内メモ: customers の項目の人だけが customer_set_note で書く（2,000 字まで、空は消す）。直接は書けない。他人のショップは不可", async () => {
    const save = (uid: string, shopId: string, note: string | null) => asUser(uid, (c) => c.query("select customer_set_note($1, $2, $3)", [shopId, member, note]));
    await save(a.ownerId, a.shopId, "  ギフト包装をよく頼む\r\nサイズ交換あり ");
    expect((await getPool().query("select note from customers where id = $1", [member])).rows[0].note).toBe("ギフト包装をよく頼む\nサイズ交換あり");
    expect(await expectDbError(() => save(a.ownerId, a.shopId, "あ".repeat(2001)))).toMatch(/note_too_long/);
    expect(await expectDbError(() => save(b.ownerId, a.shopId, "x"))).toMatch(/shop_not_found/);
    // 直接の更新は RLS で 0 行（更新のポリシーが無い）
    expect((await asUser(a.ownerId, (c) => c.query("update customers set note = 'x' where id = $1", [member]))).rowCount).toBe(0);
    expect(await expectDbError(() => asAnon((c) => c.query("select customer_set_note($1, $2, 'x')", [a.shopId, member])))).toMatch(/permission denied/);
    // 運営者は読める
    expect((await asUser(a.ownerId, (c) => c.query("select note, orders_count from customers where id = $1", [member]))).rows[0].note).toContain("ギフト");
    // 項目 customers の無いメンバーは書けない
    const staff = await createAuthUser("cs-staff@example.com");
    const org = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [a.shopId])).rows[0]!.org_id;
    await getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", [org, staff]);
    await getPool().query("insert into org_member_shops (org_id, user_id, shop_id, perms) values ($1, $2, $3, '{orders}')", [org, staff, a.shopId]);
    expect(await expectDbError(() => save(staff, a.shopId, "x"))).toMatch(/shop_not_found/);
    await save(a.ownerId, a.shopId, "");
    expect((await getPool().query("select note from customers where id = $1", [member])).rows[0].note).toBeNull();
  });

  it("個人情報のマスクで社内メモは消え、購入の集計は残る。メモの変更では customer.updated の hooks を出さない", async () => {
    await asUser(a.ownerId, (c) => c.query("select customer_set_note($1, $2, 'メモ')", [a.shopId, member]));
    const hooks = async () => Number((await getPool().query("select count(*) from hook_deliveries where event = 'customer.updated'")).rows[0].count);
    await getPool().query("insert into hook_endpoints (shop_id, name, url, events, enabled) values ($1, 'h', 'https://hooks.example.com/x', '{customer.updated}', true)", [a.shopId]);
    const n = await hooks();
    await asUser(a.ownerId, (c) => c.query("select customer_set_note($1, $2, 'メモ 2')", [a.shopId, member]));
    await order(a.shopId, member, 100, "paid");
    expect(await hooks()).toBe(n);
    const counted = (await stats(member)).orders_count;
    await asUser(a.ownerId, (c) => c.query("select mask_customer($1, 'm@example.com')", [a.shopId]));
    const row = (await getPool().query("select note, orders_count from customers where id = $1", [member])).rows[0];
    expect(row).toEqual({ note: null, orders_count: counted });
  });

  it("復元で社内メモを戻す（service_role だけ）", async () => {
    const r = await asService(async (c) => (await c.query("select restore_customer_master($1, $2) as r", [a.shopId, JSON.stringify({ customers: [{ id: member, note: "戻したメモ" }] })])).rows[0].r);
    expect(r).toEqual({ customer_master: 1 });
    expect((await getPool().query("select note from customers where id = $1", [member])).rows[0].note).toBe("戻したメモ");
  });
});
