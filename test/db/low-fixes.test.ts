import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** 0031_low_fixes: 監査（2026-10-18 のコード監査）§3 の Low のうち v0.1.0 の前に直す分 */
describe.skipIf(!dbAvailable)("Low 群の修正（0031_low_fixes）", () => {
  let f: Fixture;
  let orgId: string;
  let settingsStaff: string;
  let customersStaff: string;
  const stock = async () => (await getPool().query<{ available: number }>("select available from inventory where sku_id = $1", [f.skuId])).rows[0]!.available;
  const cancel = (id: string) => asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select cancel_order($1, $2, false) as r", [id, f.shopId])).rows[0]!.r);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "lf-owner@example.com", slug: "lf-shop", publish: true, stock: 10 });
    orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    settingsStaff = await createAuthUser("lf-settings@example.com");
    customersStaff = await createAuthUser("lf-customers@example.com");
    for (const [uid, email, perms] of [
      [settingsStaff, "lf-settings@example.com", ["settings"]],
      [customersStaff, "lf-customers@example.com", ["customers"]],
    ] as const) {
      await asUser(f.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, email, JSON.stringify([{ shop_id: f.shopId, perms }]), sha(email)]));
      await withRole("authenticated", { sub: uid, email }, (c) => c.query("select org_invitation_accept($1)", [sha(email)]));
    }
  });
  afterAll(closePool);

  it("cancel_order: 取り込んだ注文（external_ref）と復元した注文（予約なし）は在庫を戻さない。Banto で確定した注文は戻す", async () => {
    const imported = (await getPool().query<{ id: string }>("insert into orders (shop_id, total_jpy, number, external_ref, customer_email) values ($1, 3000, 5001, 'woo-1', 'w@example.com') returning id", [f.shopId])).rows[0]!.id;
    await getPool().query("insert into order_items (shop_id, order_id, sku_id, qty, unit_price_jpy) values ($1, $2, $3, 2, 3000)", [f.shopId, imported, f.skuId]);
    const restored = (await getPool().query<{ id: string }>("insert into orders (shop_id, total_jpy, number, customer_email) values ($1, 3000, 5002, 'r@example.com') returning id", [f.shopId])).rows[0]!.id;
    await getPool().query("insert into order_items (shop_id, order_id, sku_id, qty, unit_price_jpy) values ($1, $2, $3, 2, 3000)", [f.shopId, restored, f.skuId]);
    const before = await stock();
    expect(await cancel(imported)).toMatchObject({ status: "cancelled", restocked: false });
    expect(await cancel(restored)).toMatchObject({ status: "cancelled", restocked: false });
    expect(await stock()).toBe(before);
    // Banto で予約して確定した注文は戻る
    const res = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: 2 }])])).rows[0]!.id);
    const confirmed = await asService(async (c) => (await c.query<{ id: string }>("select confirm_reservation($1, $2, '{\"payment_provider\":\"stripe\",\"payment_ref\":\"pi_x\"}'::jsonb) as id", [res, f.shopId])).rows[0]!.id);
    expect(await stock()).toBe(before - 2);
    expect(await cancel(confirmed)).toMatchObject({ status: "cancelled", restocked: true });
    expect(await stock()).toBe(before);
  });

  it("mask_shipped_orders: キャンセル・返金済みの注文も同じ日数で消す。mask_customer: 試着の申し込みも消す", async () => {
    let seq = 6000;
    // updated_at は更新トリガーが now() にするので、日付を作るあいだだけトリガーを止める（superuser）
    await getPool().query("alter table orders disable trigger orders_updated_at");
    const mk = async (status: string, email: string, days: number) => {
      const id = (await getPool().query<{ id: string }>("insert into orders (shop_id, total_jpy, number, customer_email, customer_name, shipping_address) values ($1, 100, $3, $2, '名前', '{}') returning id", [f.shopId, email, ++seq])).rows[0]!.id;
      await getPool().query("update orders set status = $2::order_status, shipped_at = case when $2::text = 'shipped' then now() - make_interval(days => $3::integer) end, updated_at = now() - make_interval(days => $3::integer) where id = $1", [id, status, days]);
      return id;
    };
    const oldCancelled = await mk("cancelled", "oc@example.com", 200);
    const oldRefunded = await mk("refunded", "or@example.com", 200);
    const recentCancelled = await mk("cancelled", "rc@example.com", 10);
    const oldPaid = await mk("paid", "op@example.com", 200); // 未発送は消さない
    await getPool().query("alter table orders enable trigger orders_updated_at");
    const n = await asService(async (c) => (await c.query<{ n: number }>("select mask_shipped_orders() as n")).rows[0]!.n);
    expect(n).toBeGreaterThanOrEqual(2);
    const emails = Object.fromEntries((await getPool().query<{ id: string; customer_email: string | null }>("select id, customer_email from orders where id = any($1)", [[oldCancelled, oldRefunded, recentCancelled, oldPaid]])).rows.map((r) => [r.id, r.customer_email]));
    expect(emails).toEqual({ [oldCancelled]: null, [oldRefunded]: null, [recentCancelled]: "rc@example.com", [oldPaid]: "op@example.com" });

    const store = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into stores (org_id, name) values ($1, '店') returning id", [orgId]))).rows[0]!.id;
    await asUser(f.ownerId, (c) => c.query("insert into shop_stores (shop_id, store_id) values ($1, $2)", [f.shopId, store]));
    await asService((c) => c.query("select tryon_request($1, $2, $3::jsonb, $4::jsonb)", [f.shopId, store, JSON.stringify([{ sku_id: f.skuId, qty: 1 }]), JSON.stringify({ customer_email: "Del@example.com", customer_name: "山田", customer_phone: "0312345678", note: "memo" })]));
    await mk("paid", "del@example.com", 1);
    const masked = await asUser(f.ownerId, async (c) => (await c.query<{ n: number }>("select mask_customer($1, 'del@example.com') as n", [f.shopId])).rows[0]!.n);
    expect(masked).toBe(2);
    expect((await getPool().query("select customer_email, customer_name, customer_phone, note from tryon_requests where shop_id = $1", [f.shopId])).rows[0]).toEqual({ customer_email: null, customer_name: "[masked]", customer_phone: null, note: null });
  });

  it("shops: settings の項目では slug / domain / order_seq / tryon_seq を変えられない（name や settings は変えられる）。owner は変えられる", async () => {
    expect((await asUser(settingsStaff, (c) => c.query("update shops set name = 'renamed' where id = $1 returning id", [f.shopId]))).rows).toHaveLength(1);
    expect((await asUser(settingsStaff, (c) => c.query("update shops set settings = settings || '{\"notice\":\"hi\"}' where id = $1 returning id", [f.shopId]))).rows).toHaveLength(1);
    for (const sql of ["update shops set order_seq = 1 where id = $1", "update shops set tryon_seq = 5 where id = $1", "update shops set domain = 'evil.example' where id = $1", "update shops set slug = 'taken' where id = $1"]) {
      expect(await expectDbError(() => asUser(settingsStaff, (c) => c.query(sql, [f.shopId]))), sql).toMatch(/admin_required/);
    }
    expect((await asUser(f.ownerId, (c) => c.query("update shops set domain = 'shop.example.jp' where id = $1 returning domain", [f.shopId]))).rows[0]).toEqual({ domain: "shop.example.jp" });
  });

  it("member_set_email: customers の項目では変えられない。owner / admin だけ", async () => {
    const cid = (await getPool().query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'm@example.com') returning id", [f.shopId])).rows[0]!.id;
    expect(await expectDbError(() => asUser(customersStaff, (c) => c.query("select member_set_email($1, $2, 'taken@example.com')", [f.shopId, cid])))).toMatch(/shop_not_found/);
    expect(await asUser(f.ownerId, async (c) => (await c.query<{ r: Record<string, unknown> }>("select member_set_email($1, $2, 'new@example.com') as r", [f.shopId, cid])).rows[0]!.r)).toEqual({ old_email: "m@example.com", new_email: "new@example.com" });
    // 一覧と削除は customers の項目のまま
    expect((await asUser(customersStaff, (c) => c.query("select email from customers where shop_id = $1", [f.shopId]))).rows).toEqual([{ email: "new@example.com" }]);
  });

  it("hook_endpoints: 同梱プラグインの行はショップごとに 1 つ（重複は消され、2 つ目は入らない）", async () => {
    const url = "https://banto.invalid/plugins/email_resend";
    await asUser(f.ownerId, (c) => c.query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'mail', $2, '{order.paid}')", [f.shopId, url]));
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'mail2', $2, '{order.paid}')", [f.shopId, url])))).toMatch(/duplicate key/);
    // 外部の URL は同じでも 2 つ登録できる（制約は同梱だけ）
    await asUser(f.ownerId, (c) => c.query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'a', 'https://crm.example/h', '{}'), ($1, 'b', 'https://crm.example/h', '{}')", [f.shopId]));
  });
});
