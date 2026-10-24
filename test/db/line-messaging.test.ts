import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

describe.skipIf(!dbAvailable)("LINE の Messaging API（0021_line_messaging）", () => {
  let f: Fixture;
  let other: Fixture;
  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "l@example.com", slug: "l-shop", publish: true });
    other = await createShopFixture({ email: "m@example.com", slug: "m-shop", publish: true });
  });
  afterAll(closePool);

  const box = "v1.aaaa.bbbb";

  it("運営者が保存・削除する。暗号文の列は運営者にも読めない。読むのは service_role だけ。他人のショップには書けない", async () => {
    await asUser(f.ownerId, (c) => c.query("select shop_secret_save($1, 'line_messaging', $2)", [f.shopId, box]));
    expect((await asUser(f.ownerId, (c) => c.query("select shop_id, purpose from shop_secret_boxes"))).rows).toHaveLength(1);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select secret_box from shop_secret_boxes")))).toMatch(/permission denied/);
    expect((await asService(async (c) => (await c.query<{ r: string }>("select shop_secret($1, 'line_messaging') as r", [f.shopId])).rows[0]!.r))).toBe(box);
    expect(await expectDbError(() => asUser(other.ownerId, (c) => c.query("select shop_secret_save($1, 'line_messaging', $2)", [f.shopId, box])))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select shop_secret_save($1, 'line_messaging', 'not-a-box')", [f.shopId])))).toMatch(/check constraint|secret_box/);
    expect(await expectDbError(() => asAnon((c) => c.query("select shop_secret($1, 'line_messaging')", [f.shopId])))).toMatch(/permission denied|service_role only/);
    await asUser(f.ownerId, (c) => c.query("select shop_secret_save($1, 'line_messaging', null)", [f.shopId]));
    expect((await getPool().query("select count(*)::int as n from shop_secret_boxes")).rows[0].n).toBe(0);
  });

  it("order_line_recipient: LINE と結びついた会員の注文だけ。住所・氏名は返さない", async () => {
    const pool = getPool();
    const cust = (await pool.query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'b@example.com') returning id", [f.shopId])).rows[0]!.id;
    const o1 = (await pool.query<{ id: string }>("insert into orders (shop_id, total_jpy, customer_id, customer_name, number) values ($1, 3000, $2, '山田', 7001) returning id", [f.shopId, cust])).rows[0]!.id;
    const get = (id: string) => asService(async (c) => (await c.query<{ r: Record<string, unknown> | null }>("select order_line_recipient($1, $2) as r", [id, f.shopId])).rows[0]!.r);
    expect(await get(o1)).toBeNull();
    await pool.query("insert into member_identities (shop_id, provider, subject, customer_id) values ($1, 'line', 'Uabc', $2)", [f.shopId, cust]);
    const r = await get(o1);
    expect(r).toMatchObject({ line_user_id: "Uabc", number: 7001, total_jpy: 3000 });
    expect(JSON.stringify(r)).not.toContain("山田");
  });
});
