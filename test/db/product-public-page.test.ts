import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, closePool, createShopFixture, dbAvailable, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0164: ゲストの商品ページを 1 回で読む product_public_page。今までの 3 往復（product_public_get → 画像・SKU → product_public_stock・
 * product_public_member_prices）と同じ中身を返すことを、匿名の経路で同じ値を組み立てて比べる
 */
describe.skipIf(!dbAvailable)("ゲストの商品ページを 1 回で（0164）", () => {
  let f: Fixture;
  type Page = { product: Record<string, unknown>; images: Record<string, unknown>[]; skus: Record<string, unknown>[] } | null;
  const page = (slug: string, shopId = f.shopId) => asAnon(async (c) => (await c.query<{ r: Page }>("select product_public_page($1, $2) as r", [shopId, slug])).rows[0]!.r);
  const slugOf = async (id: string) => (await getPool().query<{ slug: string }>("select slug from products where id = $1", [id])).rows[0]!.slug;

  /** 今までの 3 往復と同じ読み取り（匿名） */
  const before = (slug: string) =>
    asAnon(async (c) => {
      const product = (await c.query<{ r: Record<string, unknown> | null }>("select product_public_get($1, $2) as r", [f.shopId, slug])).rows[0]!.r;
      if (!product) return null;
      // PostgREST と同じく JSON の形で受け取る（時刻の書き方をそろえる）
      const images = (await c.query<{ r: Record<string, unknown> }>("select to_jsonb(i) as r from product_images i where product_id = $1 order by sort_order, created_at, id", [product["id"]])).rows.map((x) => x.r);
      const skus = (await c.query<{ r: Record<string, unknown> }>("select to_jsonb(k) as r from skus k where product_id = $1 order by created_at, id", [product["id"]])).rows.map((x) => x.r);
      const ids = skus.map((k) => k["id"]);
      const stock = new Map((await c.query<{ sku_id: string; available: number }>("select * from product_public_stock($1, $2)", [f.shopId, ids])).rows.map((r) => [r.sku_id, r.available]));
      const member = new Map((await c.query<{ sku_id: string; member_price_jpy: number }>("select * from product_public_member_prices($1, $2)", [f.shopId, ids])).rows.map((r) => [r.sku_id, r.member_price_jpy]));
      return {
        product,
        images,
        skus: skus.map((k) => ({ ...k, available: stock.get(String(k["id"])) ?? 0, ...(member.has(String(k["id"])) ? { member_price_jpy: member.get(String(k["id"])) } : {}) })),
      };
    });

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "pp-owner@example.com", slug: "pp-shop", publish: true, stock: 150 });
    const owner = (sql: string, params: unknown[]) => asUser(f.ownerId, (c) => c.query(sql, params));
    await owner("insert into skus (shop_id, product_id, code, price_jpy) values ($1, $2, 'PP-2', 2000)", [f.shopId, f.productId]);
    await owner("insert into product_images (shop_id, product_id, storage_key, sort_order) values ($1, $2, 'p/b.webp', 2), ($1, $2, 'p/a.webp', 1)", [f.shopId, f.productId]);
  });
  afterAll(closePool);

  it("商品・画像・SKU（在庫は 0〜99 に頭打ち）を、今までの読み取りと同じ中身で返す", async () => {
    const slug = await slugOf(f.productId);
    const got = await page(slug);
    expect(got).toEqual(await before(slug));
    expect(got!.images.map((i) => i["storage_key"])).toEqual(["p/a.webp", "p/b.webp"]);
    expect(got!.skus.map((k) => k["available"])).toEqual([99, 0]);
    expect(got!.product).not.toHaveProperty("search_keywords");
  });

  it("ゲストに見せる会員価格は同梱モジュール audiences が ON のときだけ（今までと同じ）", async () => {
    const slug = await slugOf(f.productId);
    const aud = (await getPool().query<{ id: string }>("insert into audiences (shop_id, name, condition) values ($1, '会員', '{\"member\":true}'::jsonb) returning id", [f.shopId])).rows[0]!.id;
    await asUser(f.ownerId, (c) => c.query("insert into price_rules (shop_id, name, audience_id, sku_ids, price_jpy) values ($1, '会員価格', $2, $3, 1)", [f.shopId, aud, [f.skuId]]));
    expect((await page(slug))!.skus.some((k) => "member_price_jpy" in k)).toBe(false);
    await getPool().query("update shops set settings = settings || '{\"modules\":{\"audiences\":true}}'::jsonb where id = $1", [f.shopId]);
    const got = await page(slug);
    expect(got!.skus.find((k) => k["id"] === f.skuId)!["member_price_jpy"]).toBe(1);
    expect(got).toEqual(await before(slug));
  });

  it("見せない商品・非公開のショップ・無い商品は null（product_public_get と同じ）", async () => {
    const slug = await slugOf(f.productId);
    await getPool().query("update products set published = false where id = $1", [f.productId]);
    expect(await page(slug)).toBeNull();
    await getPool().query("update products set published = true where id = $1", [f.productId]);
    const aud = (await getPool().query<{ id: string }>("select id from audiences where shop_id = $1 limit 1", [f.shopId])).rows[0]!.id;
    await getPool().query("update products set audience_id = $1, audience_mode = 'hide' where id = $2", [aud, f.productId]);
    expect(await page(slug)).toBeNull();
    await getPool().query("update products set audience_mode = 'buy' where id = $1", [f.productId]);
    expect(await page(slug)).not.toBeNull();
    expect(await page("no-such")).toBeNull();
    const hidden = await createShopFixture({ email: "pp-hidden@example.com", slug: "pp-hidden", publish: false });
    expect(await page(await slugOf(hidden.productId), hidden.shopId)).toBeNull();
  });
});
