import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createShopFixture, dbAvailable, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0075_product_updated_skus: SKU・商品の画像・在庫（人が変えたとき）を変えても product.updated を積む。
 * まだ送っていない同じ商品の知らせがあれば積まない（まとめて変えても 1 商品 1 通）
 */
describe.skipIf(!dbAvailable)("SKU・画像・在庫の product.updated（0075）", () => {
  let f: Fixture;

  const pending = async () =>
    (await getPool().query<{ product_id: string; slug: string }>("select payload->>'product_id' as product_id, payload->>'slug' as slug from hook_deliveries where event = 'product.updated' and status = 'pending'")).rows;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "pu@example.com", slug: "pu", publish: true, stock: 5 });
    await asUser(f.ownerId, (c) =>
      c.query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'wp', 'https://wp.example/hook', $2)", [f.shopId, ["product.updated", "inventory.low"]]),
    );
  });
  beforeEach(() => getPool().query("delete from hook_deliveries"));
  afterAll(closePool);

  it("SKU の価格を変えると積む。続けて変えても、まだ送っていなければ 1 通のまま", async () => {
    await asUser(f.ownerId, (c) => c.query("update skus set price_jpy = price_jpy + 100 where id = $1", [f.skuId]));
    await asUser(f.ownerId, (c) => c.query("update skus set price_jpy = price_jpy + 100 where id = $1", [f.skuId]));
    const rows = await pending();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.product_id).toBe(f.productId);
    // 送った（attempts が進んだ）後の変更は、また積む
    await getPool().query("update hook_deliveries set attempts = 1");
    await asUser(f.ownerId, (c) => c.query("update skus set price_jpy = price_jpy + 1 where id = $1", [f.skuId]));
    expect(await pending()).toHaveLength(2);
  });

  it("商品の画像の追加・削除でも積む", async () => {
    const id = await asUser(f.ownerId, async (c) => (await c.query<{ id: string }>("insert into product_images (shop_id, product_id, storage_key, sort_order) values ($1, $2, 'p/x.webp', 0) returning id", [f.shopId, f.productId])).rows[0]!.id);
    expect(await pending()).toHaveLength(1);
    await getPool().query("delete from hook_deliveries");
    await asUser(f.ownerId, (c) => c.query("delete from product_images where id = $1", [id]));
    expect(await pending()).toHaveLength(1);
  });

  it("在庫は人が変えたとき（set_stock）だけ。購入の予約（service_role）では積まない", async () => {
    await asUser(f.ownerId, (c) => c.query("select set_stock($1, 9)", [f.skuId]));
    expect(await pending()).toHaveLength(1);
    await getPool().query("delete from hook_deliveries");
    await asService((c) => c.query("select reserve_stock($1, $2::jsonb, 900)", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: 1 }])]));
    expect(await pending()).toHaveLength(0);
  });

  it("管理画面の商品の保存（enqueue_hook）と SKU の変更が重なっても 1 通", async () => {
    await asUser(f.ownerId, (c) => c.query("update skus set price_jpy = price_jpy + 1 where id = $1", [f.skuId]));
    const n = await asUser(f.ownerId, async (c) => (await c.query<{ n: number }>("select enqueue_hook($1::uuid, 'product.updated', jsonb_build_object('product_id', $2::text, 'shop_id', $3::text)) as n", [f.shopId, f.productId, f.shopId])).rows[0]!.n);
    expect(n).toBe(0);
    expect(await pending()).toHaveLength(1);
    // ほかのイベントは今までどおり重ねて積む
    const m = await asService(async (c) => (await c.query<{ n: number }>("select enqueue_hook($1, 'inventory.low', '{}'::jsonb) as n", [f.shopId])).rows[0]!.n);
    expect(m).toBe(1);
  });
});
