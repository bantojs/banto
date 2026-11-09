import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0136_inventory_ops: 在庫の画面の関数。stock_adjust（差で足す・引く、0 を下回らせない・全部か無しか）、
 * stock_count（棚卸し、開いたときの数と違えば何も変えずに知らせる）、inventory_list（品番の順のキーセット）。どれも項目 catalog
 */
describe.skipIf(!dbAvailable)("在庫の画面の関数（0136）", () => {
  let a: Fixture;
  let b: Fixture;
  let sku2: string;
  let shipper: string;
  let stocker: string;
  const rpc = (uid: string, sql: string, args: unknown[]) => asUser(uid, async (c) => (await c.query<{ r: unknown }>(sql, args)).rows[0]!.r);
  const adjust = (uid: string, shopId: string, items: unknown) => rpc(uid, "select stock_adjust($1, $2::jsonb) as r", [shopId, JSON.stringify(items)]);
  const count = (uid: string, shopId: string, items: unknown) => rpc(uid, "select stock_count($1, $2::jsonb) as r", [shopId, JSON.stringify(items)]);
  const list = (uid: string, shopId: string, q: string | null, stock: string | null, after: string | null, limit: number | null) =>
    rpc(uid, "select inventory_list($1, $2, $3, $4, $5) as r", [shopId, q, stock, after, limit]) as Promise<{ code: string; available: number; product_name: string; gtin: string | null }[]>;
  const stockOf = async (skuId: string) => (await getPool().query<{ available: number }>("select available from inventory where sku_id = $1", [skuId])).rows[0]!.available;
  const member = async (email: string, perms: string[]) => {
    const uid = await createAuthUser(email);
    const org = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [a.shopId])).rows[0]!.org_id;
    await getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", [org, uid]);
    await getPool().query("insert into org_member_shops (org_id, user_id, shop_id, perms) values ($1, $2, $3, $4)", [org, uid, a.shopId, perms]);
    return uid;
  };

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "inv-a@example.com", slug: "inv-a", stock: 10 });
    b = await createShopFixture({ email: "inv-b@example.com", slug: "inv-b", stock: 5 });
    sku2 = await asUser(a.ownerId, async (c) => {
      const p = (await c.query<{ id: string }>("insert into products (shop_id, slug, name) values ($1, 'cap', 'キャップ') returning id", [a.shopId])).rows[0]!.id;
      const id = (await c.query<{ id: string }>("insert into skus (shop_id, product_id, code, price_jpy, gtin) values ($1, $2, 'CAP-1', 2000, '4900000000002') returning id", [a.shopId, p])).rows[0]!.id;
      await c.query("select set_stock($1, 3)", [id]);
      return id;
    });
    shipper = await member("inv-ship@example.com", ["orders"]);
    stocker = await member("inv-stock@example.com", ["catalog"]);
  });
  afterAll(closePool);

  it("stock_adjust: 足す・引く。同じ SKU は両方足す。0 を下回るなら、どれも変えない", async () => {
    expect(await adjust(stocker, a.shopId, [{ sku_id: a.skuId, delta: 5 }, { sku_id: sku2, delta: -1 }, { sku_id: a.skuId, delta: 0 }])).toEqual(
      expect.arrayContaining([{ sku_id: a.skuId, available: 15 }, { sku_id: sku2, available: 2 }]),
    );
    expect(await adjust(stocker, a.shopId, [{ sku_id: a.skuId, delta: 1 }, { sku_id: a.skuId, delta: 1 }])).toEqual(expect.arrayContaining([{ sku_id: a.skuId, available: 17 }]));
    expect(await expectDbError(() => adjust(stocker, a.shopId, [{ sku_id: a.skuId, delta: -1 }, { sku_id: sku2, delta: -3 }]))).toMatch(/insufficient_stock:CAP-1/);
    expect(await stockOf(a.skuId)).toBe(17);
    expect(await stockOf(sku2)).toBe(2);
    await adjust(a.ownerId, a.shopId, [{ sku_id: a.skuId, delta: -7 }]);
    expect(await stockOf(a.skuId)).toBe(10);
  });

  it("stock_adjust: 形の違う値・他人の SKU・項目の無い人・anon は断る", async () => {
    for (const bad of [[{ sku_id: a.skuId }], [{ sku_id: a.skuId, delta: 1.5 }], [{ sku_id: a.skuId, delta: "1" }], [{ sku_id: a.skuId, delta: 1000001 }], [{ sku_id: "x", delta: 1 }], {}]) {
      expect(await expectDbError(() => adjust(a.ownerId, a.shopId, bad))).toMatch(/invalid_items/);
    }
    expect(await expectDbError(() => adjust(a.ownerId, a.shopId, [{ sku_id: b.skuId, delta: 1 }]))).toMatch(/sku_not_found/);
    expect(await expectDbError(() => adjust(shipper, a.shopId, [{ sku_id: a.skuId, delta: 1 }]))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => adjust(b.ownerId, a.shopId, [{ sku_id: a.skuId, delta: 1 }]))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => asAnon((c) => c.query("select stock_adjust($1, '[]'::jsonb)", [a.shopId])))).toMatch(/permission denied/);
    expect(await stockOf(b.skuId)).toBe(5);
    expect(await stockOf(a.skuId)).toBe(10);
  });

  it("stock_count: 開いたときの数と同じなら置き換える。違う SKU があれば、どれも変えずに今の数を返す", async () => {
    expect(await count(stocker, a.shopId, [{ sku_id: a.skuId, expected: 10, available: 8 }, { sku_id: sku2, expected: 2, available: 2 }])).toEqual({ ok: true, updated: 1 });
    expect(await stockOf(a.skuId)).toBe(8);
    // 開いてから 1 つ売れた
    await adjust(a.ownerId, a.shopId, [{ sku_id: sku2, delta: -1 }]);
    const r = await count(stocker, a.shopId, [{ sku_id: a.skuId, expected: 8, available: 20 }, { sku_id: sku2, expected: 2, available: 6 }]);
    expect(r).toEqual({ ok: false, conflicts: [{ sku_id: sku2, code: "CAP-1", expected: 2, current: 1, available: 6 }] });
    expect(await stockOf(a.skuId)).toBe(8);
    expect(await stockOf(sku2)).toBe(1);
  });

  it("stock_count: 形の違う値・同じ SKU の重なり・負の数・他人の SKU・項目の無い人は断る", async () => {
    for (const bad of [[{ sku_id: a.skuId, available: 1 }], [{ sku_id: a.skuId, expected: 8, available: -1 }], [{ sku_id: a.skuId, expected: 8, available: 1.5 }], [{ sku_id: a.skuId, expected: 8, available: 1 }, { sku_id: a.skuId, expected: 8, available: 2 }]]) {
      expect(await expectDbError(() => count(a.ownerId, a.shopId, bad))).toMatch(/invalid_items/);
    }
    expect(await expectDbError(() => count(a.ownerId, a.shopId, [{ sku_id: b.skuId, expected: 5, available: 0 }]))).toMatch(/sku_not_found/);
    expect(await expectDbError(() => count(shipper, a.shopId, [{ sku_id: a.skuId, expected: 8, available: 0 }]))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => asAnon((c) => c.query("select stock_count($1, '[]'::jsonb)", [a.shopId])))).toMatch(/permission denied/);
    expect(await stockOf(b.skuId)).toBe(5);
  });

  it("inventory_list: 品番の順・キーワード（品番と JAN は完全一致、商品名と品番は部分一致）・在庫切れ・ページ送り", async () => {
    await count(a.ownerId, a.shopId, [{ sku_id: sku2, expected: 1, available: 0 }]);
    expect((await list(stocker, a.shopId, null, null, null, null)).map((r) => [r.code, r.available])).toEqual([["CAP-1", 0], ["TEE-M", 8]]);
    expect((await list(stocker, a.shopId, "4900000000002", null, null, null)).map((r) => r.code)).toEqual(["CAP-1"]);
    expect((await list(stocker, a.shopId, "シャツ", null, null, null)).map((r) => r.product_name)).toEqual(["Tシャツ"]);
    expect((await list(stocker, a.shopId, "tee", null, null, null)).map((r) => r.code)).toEqual(["TEE-M"]);
    expect((await list(stocker, a.shopId, "%", null, null, null)).length).toBe(0);
    expect((await list(stocker, a.shopId, null, "out", null, null)).map((r) => r.code)).toEqual(["CAP-1"]);
    expect((await list(stocker, a.shopId, null, null, null, 1)).map((r) => r.code)).toEqual(["CAP-1"]);
    expect((await list(stocker, a.shopId, null, null, "CAP-1", 1)).map((r) => r.code)).toEqual(["TEE-M"]);
    expect(await expectDbError(() => list(shipper, a.shopId, null, null, null, null))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => list(b.ownerId, a.shopId, null, null, null, null))).toMatch(/shop_not_found/);
  });
});
