import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

type Result = { line: number; status: string; code?: string | null; error?: string; members?: number; active?: boolean; campaign_id?: string | null };

/**
 * 0043_coupon_import: クーポンの CSV 取り込み（import_coupons）。
 * 確認だけでは書かない・既にあるものは作らない・会員でない人がいれば作らない・商品やカテゴリーはこのショップのものだけ・権限。
 */
describe.skipIf(!dbAvailable)("クーポンの CSV 取り込み（0043）", () => {
  let a: Fixture;
  let b: Fixture;
  let productSlug: string;

  const run = (f: Fixture, rows: unknown[], dryRun: boolean) =>
    asUser(f.ownerId, async (c) => (await c.query<{ r: Result[] }>("select import_coupons($1, $2::jsonb, $3) as r", [f.shopId, JSON.stringify(rows), dryRun])).rows[0]!.r);
  const row = (line: number, values: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ line, values, conditions: {}, product_slugs: [], exclude_product_slugs: [], category_slugs: [], exclude_category_slugs: [], member_emails: [], ...extra });

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "ci-a@example.com", slug: "ci-a", publish: true, stock: 5 });
    b = await createShopFixture({ email: "ci-b@example.com", slug: "ci-b", publish: true, stock: 5 });
    for (const s of [a, b]) await getPool().query(`update shops set settings = settings || '{"modules":{"coupons":true}}'::jsonb where id = $1`, [s.shopId]);
    productSlug = (await getPool().query<{ slug: string }>("select slug from products where id = $1", [a.productId])).rows[0]!.slug;
    await getPool().query("insert into categories (shop_id, slug, name) values ($1, 'sale', 'セール')", [a.shopId]);
    await getPool().query("insert into categories (shop_id, slug, name) values ($1, 'b-cat', 'B')", [b.shopId]);
    for (const e of ["vip1@example.com", "VIP2@example.com"]) await getPool().query("insert into customers (shop_id, email, name) values ($1, $2, '会員')", [a.shopId, e]);
    await getPool().query("insert into customers (shop_id, email, name) values ($1, 'other-shop@example.com', '他店')", [b.shopId]);
  });
  afterAll(closePool);

  it("確認（dry run）では何も作らず、作るときは条件を id に直して作る", async () => {
    const rows = [
      row(2, { name: "秋", code: "aut10", kind: "percent", value: 10, ends_at: "2026-12-31T14:59:00Z", usage_limit: 50 }, { product_slugs: [productSlug], category_slugs: ["SALE"], conditions: { tags: ["冬"], min_subtotal_jpy: 3000 } }),
    ];
    const check = await run(a, rows, true);
    expect(check).toEqual([expect.objectContaining({ line: 2, status: "ok", code: "AUT10" })]);
    expect((await getPool().query("select 1 from coupon_campaigns where shop_id = $1", [a.shopId])).rowCount).toBe(0);

    const done = await run(a, rows, false);
    expect(done[0]).toMatchObject({ status: "created", code: "AUT10", active: true });
    const c = (await getPool().query<{ conditions: Record<string, unknown>; usage_limit: number }>("select conditions, usage_limit from coupon_campaigns where shop_id = $1 and code = 'AUT10'", [a.shopId])).rows[0]!;
    const sale = (await getPool().query<{ id: string }>("select id from categories where shop_id = $1 and slug = 'sale'", [a.shopId])).rows[0]!.id;
    expect(c.conditions).toEqual({ product_ids: [a.productId], category_ids: [sale], tags: ["冬"], min_subtotal_jpy: 3000 });
    expect(c.usage_limit).toBe(50);
    // もう一度流しても重複しない
    expect((await run(a, rows, false))[0]).toMatchObject({ status: "existing" });
  });

  it("member_emails: 全員が会員なら、共通のコードを作らずに会員ごとに発行。1 人でも会員でなければ作らない", async () => {
    const bad = await run(a, [row(3, { name: "VIP", code: "VIP500", kind: "fixed", value: 500 }, { member_emails: ["vip1@example.com", "other-shop@example.com", "nobody@example.com"] })], false);
    expect(bad[0]).toMatchObject({ status: "error" });
    expect(bad[0]!.error).toMatch(/^not_members: nobody@example.com, other-shop@example.com \(2\)/);
    expect((await getPool().query("select 1 from coupon_campaigns where shop_id = $1 and external_ref = 'csv:VIP500'", [a.shopId])).rowCount).toBe(0);

    const ok = await run(a, [row(3, { name: "VIP", code: "VIP500", kind: "fixed", value: 500 }, { member_emails: ["vip1@example.com", "vip2@example.com"] })], false);
    expect(ok[0]).toMatchObject({ status: "created", code: null, members: 2 });
    const camp = (await getPool().query<{ id: string; code: string | null; external_ref: string }>("select id, code, external_ref from coupon_campaigns where shop_id = $1 and external_ref = 'csv:VIP500'", [a.shopId])).rows[0]!;
    expect(camp.code).toBeNull();
    const grants = await getPool().query<{ customer_id: string | null }>("select customer_id from coupon_grants where campaign_id = $1", [camp.id]);
    expect(grants.rows).toHaveLength(2);
    expect(grants.rows.every((g) => g.customer_id !== null)).toBe(true);
    // 同じ ref はもう作らない
    expect((await run(a, [row(3, { name: "VIP", code: "VIP500", kind: "fixed", value: 500 }, { member_emails: ["vip1@example.com"] })], false))[0]).toMatchObject({ status: "existing" });
  });

  it("行ごとに検査する: 値の形・知らない商品やカテゴリー（他のショップのものを含む）・ファイル内の重複", async () => {
    const r = await run(
      a,
      [
        row(2, { name: "x", code: "BADV", kind: "percent", value: 150 }),
        row(3, { name: "x", code: "NOPROD", kind: "fixed", value: 100 }, { product_slugs: ["nope"] }),
        row(4, { name: "x", code: "BCAT", kind: "fixed", value: 100 }, { category_slugs: ["b-cat"] }),
        row(5, { name: "x", code: "DUP", kind: "fixed", value: 100 }),
        row(6, { name: "x", code: "DUP", kind: "fixed", value: 200 }),
        row(7, { name: "x", code: "BADK", kind: "bogo", value: 1 }),
        row(8, { name: "x", code: "BADD", kind: "fixed", value: 100, starts_at: "2026-12-01T00:00:00Z", ends_at: "2026-11-01T00:00:00Z" }),
      ],
      true,
    );
    expect(r.map((x) => [x.line, x.status, x.error?.split(":")[0] ?? null])).toEqual([
      [2, "error", "invalid_value"],
      [3, "error", "unknown_products"],
      [4, "error", "unknown_categories"],
      [5, "ok", null],
      [6, "existing", null],
      [7, "error", "invalid_kind"],
      [8, "error", "invalid_ends_at"],
    ]);
  });

  it("権限: 他人のショップ・モジュールが OFF・anon は呼べない", async () => {
    expect(await expectDbError(() => run({ ...b, shopId: a.shopId }, [], true))).toMatch(/shop_not_found/);
    await getPool().query(`update shops set settings = settings || '{"modules":{"coupons":false}}'::jsonb where id = $1`, [b.shopId]);
    expect(await expectDbError(() => run(b, [], true))).toMatch(/module_disabled/);
    expect(await expectDbError(() => asAnon((c) => c.query("select import_coupons($1, '[]'::jsonb, true)", [a.shopId])))).toMatch(/permission denied/);
  });
});
