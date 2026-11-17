import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0138_product_images_order: 商品の画像の並びを 1 回で書く。その商品の画像ちょうど全部の id を受け取り、0 から振り直す。項目 catalog
 */
describe.skipIf(!dbAvailable)("商品の画像の並び（0138）", () => {
  let a: Fixture;
  let b: Fixture;
  let ids: string[];
  let other: string;
  let shipper: string;
  const order = (uid: string, shopId: string, productId: string, list: string[]) =>
    asUser(uid, async (c) => (await c.query<{ r: number }>("select product_images_order($1, $2, $3::uuid[]) as r", [shopId, productId, list])).rows[0]!.r);
  const sorts = async () => (await getPool().query<{ id: string; sort_order: number }>("select id, sort_order from product_images where product_id = $1 order by sort_order, created_at", [a.productId])).rows;

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "imgo-a@example.com", slug: "imgo-a" });
    b = await createShopFixture({ email: "imgo-b@example.com", slug: "imgo-b" });
    // 番号に隙間と重なりがある（取り込み・削除のあと）
    ids = [];
    for (const [k, s] of [["a", 0], ["b", 3], ["c", 3], ["d", 9]] as const) {
      ids.push((await getPool().query<{ id: string }>("insert into product_images (shop_id, product_id, storage_key, sort_order) values ($1, $2, $3, $4) returning id", [a.shopId, a.productId, `shops/x/${k}.webp`, s])).rows[0]!.id);
    }
    other = (await getPool().query<{ id: string }>("insert into product_images (shop_id, product_id, storage_key, sort_order) values ($1, $2, 'shops/y/z.webp', 0) returning id", [b.shopId, b.productId])).rows[0]!.id;
    shipper = await createAuthUser("imgo-ship@example.com");
    const org = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [a.shopId])).rows[0]!.org_id;
    await getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", [org, shipper]);
    await getPool().query("insert into org_member_shops (org_id, user_id, shop_id, perms) values ($1, $2, $3, $4)", [org, shipper, a.shopId, ["orders"]]);
  });
  afterAll(closePool);

  it("全部の id を並べたい順に受け取り、1 回で 0 から振り直す（変わった行の数を返す）", async () => {
    const want = [ids[0]!, ids[2]!, ids[1]!, ids[3]!];
    expect(await order(a.ownerId, a.shopId, a.productId, want)).toBe(3);
    expect(await sorts()).toEqual(want.map((id, i) => ({ id, sort_order: i })));
    expect(await order(a.ownerId, a.shopId, a.productId, want)).toBe(0);
  });

  it("足りない・余る・重なる・他の商品の画像は断り、何も変えない。項目の無い人・他人・anon も断る", async () => {
    const before = await sorts();
    const cur = before.map((r) => r.id);
    for (const bad of [cur.slice(1), [...cur, other], [cur[0]!, cur[0]!, cur[1]!, cur[2]!], [other, cur[1]!, cur[2]!, cur[3]!]]) {
      expect(await expectDbError(() => order(a.ownerId, a.shopId, a.productId, bad))).toMatch(/invalid_images/);
    }
    expect(await sorts()).toEqual(before);
    expect(await expectDbError(() => order(shipper, a.shopId, a.productId, cur))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => order(b.ownerId, a.shopId, a.productId, cur))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => asAnon((c) => c.query("select product_images_order($1, $2, '{}'::uuid[])", [a.shopId, a.productId])))).toMatch(/permission denied/);
  });
});
