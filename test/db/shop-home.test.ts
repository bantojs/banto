import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0139_shop_home: ホームの「今やること」を 1 回で数える。見る人の項目にある分だけを返す（無い項目は鍵ごと返さない）
 */
describe.skipIf(!dbAvailable)("ショップのホーム（0139）", () => {
  let a: Fixture;
  let b: Fixture;
  let shipper: string;
  let stocker: string;
  const home = (uid: string, shopId: string) => asUser(uid, async (c) => (await c.query<{ r: Record<string, Record<string, unknown>> }>("select shop_home($1) as r", [shopId])).rows[0]!.r);
  const member = async (email: string, perms: string[]) => {
    const uid = await createAuthUser(email);
    const org = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [a.shopId])).rows[0]!.org_id;
    await getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", [org, uid]);
    await getPool().query("insert into org_member_shops (org_id, user_id, shop_id, perms) values ($1, $2, $3, $4)", [org, uid, a.shopId, perms]);
    return uid;
  };

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "home-a@example.com", slug: "home-a", publish: true, stock: 0 });
    b = await createShopFixture({ email: "home-b@example.com", slug: "home-b" });
    const order = (status: string, total: number, daysAgo: number) =>
      getPool().query("insert into orders (shop_id, status, total_jpy, created_at, number) values ($1, $2, $3, now() - ($4 || ' days')::interval, (select coalesce(max(number), 1000) + 1 from orders where shop_id = $1))", [a.shopId, status, total, daysAgo]);
    await order("paid", 1000, 1);
    await order("paid", 2000, 2);
    await order("shipped", 3000, 3);
    await order("cancelled", 9000, 1);
    await order("shipped", 5000, 40);
    await getPool().query("insert into products (shop_id, slug, name, published) values ($1, 'draft', '下書き', false)", [a.shopId]);
    shipper = await member("home-ship@example.com", ["orders"]);
    stocker = await member("home-cat@example.com", ["catalog"]);
  });
  afterAll(closePool);

  it("owner / admin には全部（発送待ち・30 日の売上・在庫切れ・下書き・開店の準備）", async () => {
    const r = await home(a.ownerId, a.shopId);
    expect(r["orders"]).toEqual({ to_ship: 2 });
    expect(r["sales"]).toEqual({ orders: 3, revenue_jpy: 6000 });
    expect(r["catalog"]).toEqual({ out_of_stock: 1, drafts: 1, products: 2 });
    expect(r["support"]).toEqual({ waiting: 0 });
    expect(r["content"]).toEqual({ scheduled: 0, drafts: 0 });
    expect(r["setup"]).toEqual({ legal: true, product: true, published: true });
  });

  it("項目の無いものは鍵ごと返さない（出荷の担当に売上を出さない）", async () => {
    expect(Object.keys(await home(shipper, a.shopId))).toEqual(["orders"]);
    expect(Object.keys(await home(stocker, a.shopId))).toEqual(["catalog"]);
  });

  it("触れないショップ・anon は断る", async () => {
    expect(await expectDbError(() => home(b.ownerId, a.shopId))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => asAnon((c) => c.query("select shop_home($1)", [a.shopId])))).toMatch(/permission denied/);
  });
});
