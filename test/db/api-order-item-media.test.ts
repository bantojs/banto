import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { asService, asUser, closePool, createShopFixture, dbAvailable, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0174_api_order_item_media: AI 用 API の注文の明細に SKU の選択肢（軸の順・ショップの表示名）と画像の候補。
 * 候補は 1 件の注文の応答だけ（一覧には付けない）。1 枚目を選んで URL にするのは Worker（test/order-item-media.test.ts）
 * 0175_api_tryon_item_media: お店で試着の明細にも同じ作りで足す
 */
describe.skipIf(!dbAvailable)("AI 用 API の注文の明細の選択肢と画像（0174）", () => {
  let f: Fixture;
  let orderId: string;
  let productId: string;
  let skuRed: string;
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  async function issue(scopes: string[]) {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    await asUser(f.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [f.shopId, f.ownerId, sha(raw), raw.slice(0, 12), scopes]));
    return sha(raw);
  }
  const get = (tok: string, id: string) => asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select api_order_get($1, $2) as r", [tok, id])).rows[0]!.r);
  const list = (tok: string) => asService(async (c) => (await c.query<{ r: { items: Record<string, unknown>[] } }>("select api_orders_list($1) as r", [tok])).rows[0]!.r);
  const itemsOf = (o: Record<string, unknown>) => o["items"] as Record<string, unknown>[];

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "oim-owner@example.com", slug: "oim-shop", publish: true });
    const pool = getPool();
    await pool.query(`update shops set option_names = '{"color":"カラー"}'::jsonb where id = $1`, [f.shopId]);
    // 軸はサイズ → カラーの順（SKU の options の鍵の順とは別に、軸の順で返す）
    productId = (await pool.query<{ id: string }>(
      `insert into products (shop_id, slug, name, published, option_axes) values ($1, 'shirt', 'シャツ', true, '[{"key":"size"},{"key":"color"}]'::jsonb) returning id`,
      [f.shopId],
    )).rows[0]!.id;
    skuRed = (await pool.query<{ id: string }>(
      `insert into skus (shop_id, product_id, code, price_jpy, options) values ($1, $2, 'SH-RED-M', 5000, '{"color":"赤","size":"M"}'::jsonb) returning id`,
      [f.shopId, productId],
    )).rows[0]!.id;
    const key = (n: string) => `shops/${f.shopId}/products/${productId}/${n}.webp`;
    await pool.query(
      `insert into product_images (shop_id, product_id, storage_key, thumb_key, width, height, sort_order, options) values
         ($1, $2, $3, null, 1600, 1600, 0, '{}'::jsonb),
         ($1, $2, $4, $5, 1600, 2000, 1, '{"color":"赤"}'::jsonb),
         ($1, $2, $6, null, 1600, 2000, 2, '{"color":"青"}'::jsonb)`,
      [f.shopId, productId, key("all"), key("red"), key("red.thumb"), key("blue")],
    );
    orderId = (await pool.query<{ id: string }>(
      "insert into orders (shop_id, number, status, total_jpy, shipping_jpy, customer_email, customer_name, payment_provider, payment_ref) values ($1, 1001, 'paid', 8000, 0, 'a@example.com', '山田', 'stripe', 'pi_a') returning id",
      [f.shopId],
    )).rows[0]!.id;
    await pool.query("insert into order_items (shop_id, order_id, sku_id, qty, unit_price_jpy) values ($1, $2, $3, 1, 5000), ($1, $2, $4, 1, 3000)", [f.shopId, orderId, skuRed, f.skuId]);
  });
  afterAll(closePool);

  it("orders:read で、明細の options が軸の順・ショップの表示名（無ければ key）で返る。選択肢の無い SKU は []", async () => {
    const tok = await issue(["orders:read"]);
    const items = itemsOf(await get(tok, orderId));
    const red = items.find((i) => i["sku_id"] === skuRed)!;
    expect(red["options"]).toEqual([{ key: "size", name: "size", value: "M" }, { key: "color", name: "カラー", value: "赤" }]);
    const plain = items.find((i) => i["sku_id"] === f.skuId)!;
    expect(plain["options"]).toEqual([]);
    // 今までの値はそのまま
    for (const k of ["sku_id", "sku_code", "sku_name", "product_id", "product_name", "qty", "unit_price_jpy", "discount_jpy"]) expect(red).toHaveProperty(k);
  });

  it("1 件の注文には画像の候補（並べ順・options・鍵・大きさ）が付く。画像の無い商品は []", async () => {
    const tok = await issue(["orders:read"]);
    const items = itemsOf(await get(tok, orderId));
    const c = items.find((i) => i["sku_id"] === skuRed)!["image_candidates"] as Record<string, unknown>[];
    expect(c.map((x) => x["options"])).toEqual([{}, { color: "赤" }, { color: "青" }]);
    expect(c[1]).toMatchObject({ storage_key: `shops/${f.shopId}/products/${productId}/red.webp`, thumb_key: `shops/${f.shopId}/products/${productId}/red.thumb.webp`, width: 1600, height: 2000 });
    expect(items.find((i) => i["sku_id"] === f.skuId)!["image_candidates"]).toEqual([]);
  });

  it("注文の一覧には options だけ（画像の候補は付けない）", async () => {
    const tok = await issue(["orders:read"]);
    const o = (await list(tok)).items.find((x) => x["id"] === orderId)!;
    const red = itemsOf(o).find((i) => i["sku_id"] === skuRed)!;
    expect(red["options"]).toHaveLength(2);
    expect(red).not.toHaveProperty("image_candidates");
  });

  it("候補つきの形も旧い形も anon・authenticated からは呼べない。旗の無い形は候補を付けない", async () => {
    const pool = getPool();
    for (const role of ["anon", "authenticated"]) {
      for (const sig of ["orders, boolean, boolean, boolean, boolean", "orders, boolean, boolean, boolean", "orders, boolean"]) {
        const r = await pool.query<{ ok: boolean }>(`select has_function_privilege($1, 'api_order_json(${sig})', 'execute') as ok`, [role]);
        expect(r.rows[0]!.ok).toBe(false);
      }
    }
    const r = await pool.query<{ j: { items: Record<string, unknown>[] } }>("select api_order_json(o, false, false, false) as j from orders o where o.id = $1", [orderId]);
    expect(r.rows[0]!.j.items.every((i) => !("image_candidates" in i) && Array.isArray(i["options"]))).toBe(true);
  });

  it("お店で試着（0175）: 明細に options、1 件の申し込み（取得・状態の変更）だけ画像の候補。一覧は options だけ。旗の無い形は候補なし", async () => {
    const pool = getPool();
    const orgId = (await pool.query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    const store = (await pool.query<{ id: string }>("insert into stores (org_id, name) values ($1, '本店') returning id", [orgId])).rows[0]!.id;
    const req = (await pool.query<{ id: string }>(
      "insert into tryon_requests (shop_id, store_id, number, customer_email, customer_name) values ($1, $2, 7, 't@example.com', '試着') returning id",
      [f.shopId, store],
    )).rows[0]!.id;
    await pool.query("insert into tryon_items (shop_id, request_id, sku_id, qty, unit_price_jpy) values ($1, $2, $3, 1, 5000), ($1, $2, $4, 1, 3000)", [f.shopId, req, skuRed, f.skuId]);
    const tok = await issue(["orders:read", "orders:write"]);
    const one = await asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select api_tryon_request_get($1, 7) as r", [tok])).rows[0]!.r);
    const red = itemsOf(one).find((i) => i["sku_id"] === skuRed)!;
    expect(red["options"]).toEqual([{ key: "size", name: "size", value: "M" }, { key: "color", name: "カラー", value: "赤" }]);
    expect((red["image_candidates"] as Record<string, unknown>[]).map((x) => x["options"])).toEqual([{}, { color: "赤" }, { color: "青" }]);
    expect(itemsOf(one).find((i) => i["sku_id"] === f.skuId)!["options"]).toEqual([]);
    const upd = await asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select api_tryon_request_update($1, 7, 'sent') as r", [tok])).rows[0]!.r);
    expect(itemsOf(upd).find((i) => i["sku_id"] === skuRed)).toHaveProperty("image_candidates");
    const lst = await asService(async (c) => (await c.query<{ r: { items: Record<string, unknown>[] } }>("select api_tryon_requests_list($1) as r", [tok])).rows[0]!.r);
    const lred = itemsOf(lst.items[0]!).find((i) => i["sku_id"] === skuRed)!;
    expect(lred["options"]).toHaveLength(2);
    expect(lred).not.toHaveProperty("image_candidates");
    // 取り消してから在庫を戻す応答にも候補が付く
    await asService((c) => c.query("select api_tryon_request_update($1, 7, 'cancelled')", [tok]));
    const rst = await asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select api_tryon_request_restock($1, 7) as r", [tok])).rows[0]!.r);
    expect(itemsOf(rst).find((i) => i["sku_id"] === skuRed)).toHaveProperty("image_candidates");
    // 旗の無い形（4 つの引数）は候補を付けない
    const plain = (await pool.query<{ j: Record<string, unknown> }>("select api_tryon_json(r, false, false, false) as j from tryon_requests r where r.id = $1", [req])).rows[0]!.j;
    expect(itemsOf(plain).every((i) => !("image_candidates" in i) && Array.isArray(i["options"]))).toBe(true);
    for (const role of ["anon", "authenticated", "service_role"]) {
      const r = await pool.query<{ ok: boolean }>("select has_function_privilege($1, 'api_tryon_json(tryon_requests, boolean, boolean, boolean, boolean)', 'execute') as ok", [role]);
      expect(r.rows[0]!.ok).toBe(false);
    }
  });

  it("商品を非公開にしても、画像を消しても崩れない", async () => {
    const pool = getPool();
    await pool.query("update products set published = false where id = $1", [productId]);
    await pool.query("delete from product_images where product_id = $1", [productId]);
    const tok = await issue(["orders:read"]);
    const red = itemsOf(await get(tok, orderId)).find((i) => i["sku_id"] === skuRed)!;
    expect(red["options"]).toHaveLength(2);
    expect(red["image_candidates"]).toEqual([]);
  });
});
