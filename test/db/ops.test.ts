import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, CUSTOMER_COLUMNS, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

describe.skipIf(!dbAvailable)("運用 RPC（0006_ops）", () => {
  let f: Fixture;
  let other: Fixture;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "owner@example.com", slug: "shop", publish: true, stock: 5 });
    other = await createShopFixture({ email: "other@example.com", slug: "other", publish: true, stock: 5 });
  });
  afterAll(closePool);

  it("ハートビート: service_role だけが記録でき、anon は経過秒数だけ読める。表は anon から見えない", async () => {
    expect(await asAnon(async (c) => (await c.query("select heartbeat_age_seconds('cron') as age")).rows[0]!["age"])).toBeNull();
    expect(await expectDbError(() => asAnon((c) => c.query("select record_heartbeat('cron')")))).toMatch(/permission denied/);
    await asService((c) => c.query("select record_heartbeat('cron')"));
    const age = await asAnon(async (c) => (await c.query<{ age: number }>("select heartbeat_age_seconds('cron') as age")).rows[0]!.age);
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(60);
    // RLS: anon にはポリシーが無いので 0 行（名前も時刻も見えない）
    expect(await asAnon(async (c) => (await c.query("select * from banto_heartbeats")).rows)).toEqual([]);
    // owner は閲覧できる（ダッシュボード用）
    const rows = await asUser(f.ownerId, async (c) => (await c.query("select name from banto_heartbeats")).rows);
    expect(rows).toEqual([{ name: "cron" }]);
  });

  it("restore_shop_data: 空のショップに id を振り直して復元し、注文番号・在庫・件数を返す。空でなければ拒否", async () => {
    // 元ショップに注文を 1 件作る（予約 → 確定）
    const resId = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: 2 }])])).rows[0]!.id);
    await asService((c) => c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [resId, f.shopId, JSON.stringify({ customer_email: "a@example.com", customer_name: "A", shipping_address: { state: "東京都" }, shipping_jpy: 500 })]));
    const orderId = await asService(async (c) => (await c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [resId, f.shopId, JSON.stringify({ payment_provider: "stripe", payment_ref: "pi_1" })])).rows[0]!.id);
    await getPool().query("insert into product_images (shop_id, product_id, storage_key, thumb_key, width, height) values ($1, $2, 'shops/x/a.webp', 'shops/x/a.thumb.webp', 1600, 1200)", [f.shopId, f.productId]);
    await getPool().query("insert into hook_endpoints (shop_id, name, url, events, settings) values ($1, 'crm', 'https://crm.example/hook', '{order.paid}', '{\"to\":\"x\"}')", [f.shopId]);

    // export.json と同じ形（owner として全行を読む）
    const tables = await asUser(f.ownerId, async (c) => {
      const out: Record<string, unknown[]> = {};
      for (const t of ["products", "skus", "inventory", "product_images", "orders", "order_items", "customers", "hook_endpoints"]) {
        out[t] = (await c.query(`select ${t === "customers" ? CUSTOMER_COLUMNS : "*"} from ${t} where shop_id = $1`, [f.shopId])).rows;
      }
      return out;
    });
    expect(tables["orders"]).toHaveLength(1);

    // 復元先の空ショップ
    const dstId = await asUser(f.ownerId, async (c) => (await c.query<{ id: string }>("insert into shops (owner_id, slug, name) values ($1, 'dst', 'Dst') returning id", [f.ownerId])).rows[0]!.id);
    const counts = await asService(async (c) => (await c.query<{ r: Record<string, number> }>("select restore_shop_data($1, $2::jsonb) as r", [dstId, JSON.stringify(tables)])).rows[0]!.r);
    expect(counts).toMatchObject({ products: 1, skus: 1, product_images: 1, orders: 1, order_items: 1, order_items_skipped: 0, customers: 0, customers_skipped: 0, hook_endpoints: 1 });

    const dst = await getPool().query(
      `select p.id as product_id, p.slug, k.code, i.available, o.id as order_id, o.number, o.total_jpy, o.shipping_jpy, o.reservation_id, o.customer_email, s.order_seq
         from products p join skus k on k.product_id = p.id join inventory i on i.sku_id = k.id
         join orders o on o.shop_id = p.shop_id join shops s on s.id = p.shop_id where p.shop_id = $1`,
      [dstId],
    );
    expect(dst.rows).toHaveLength(1);
    const row = dst.rows[0] as Record<string, unknown>;
    expect(row["product_id"]).not.toBe(f.productId);
    expect(row["order_id"]).not.toBe(orderId);
    expect(row).toMatchObject({ slug: "tee", available: 3, number: 1001, total_jpy: 6500, shipping_jpy: 500, reservation_id: null, customer_email: "a@example.com", order_seq: 1001 });
    const items = await getPool().query("select qty, unit_price_jpy from order_items oi join orders o on o.id = oi.order_id where o.shop_id = $1", [dstId]);
    expect(items.rows).toEqual([{ qty: 2, unit_price_jpy: 3000 }]);
    const img = await getPool().query("select storage_key, thumb_key, width from product_images where shop_id = $1", [dstId]);
    expect(img.rows).toEqual([{ storage_key: "shops/x/a.webp", thumb_key: "shops/x/a.thumb.webp", width: 1600 }]);
    // 元は無傷、他人のショップにも影響なし
    expect((await getPool().query("select count(*)::int as n from orders where shop_id = $1", [f.shopId])).rows[0]!["n"]).toBe(1);
    expect((await getPool().query("select count(*)::int as n from products where shop_id = $1", [other.shopId])).rows[0]!["n"]).toBe(1);

    // 空でないショップ・存在しないショップ・壊れた形は拒否。anon / owner からは呼べない
    expect(await expectDbError(() => asService((c) => c.query("select restore_shop_data($1, $2::jsonb)", [dstId, JSON.stringify(tables)])))).toMatch(/shop_not_empty/);
    expect(await expectDbError(() => asService((c) => c.query("select restore_shop_data(gen_random_uuid(), '{}'::jsonb)")))).toMatch(/shop_not_found/);
    const emptyId = await asUser(f.ownerId, async (c) => (await c.query<{ id: string }>("insert into shops (owner_id, slug, name) values ($1, 'empty', 'E') returning id", [f.ownerId])).rows[0]!.id);
    expect(await expectDbError(() => asService((c) => c.query("select restore_shop_data($1, '{\"products\": 1}'::jsonb)", [emptyId])))).toMatch(/invalid_export/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select restore_shop_data($1, '{}'::jsonb)", [emptyId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asAnon((c) => c.query("select restore_shop_data($1, '{}'::jsonb)", [emptyId])))).toMatch(/permission denied/);
  });
});
