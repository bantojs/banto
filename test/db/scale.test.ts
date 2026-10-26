import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 10 万件の性能（人間の決定 2026-10-26: データは 10 万件で必達、100 万件を目標。docs/knowledge/02-decisions.md）。
 * 実 PostgreSQL だけで回す。商品 10 万件（SKU・画像・在庫つき）とクーポン 10 万枚を作り、お店の画面・公開 API・管理画面・
 * サイトマップ・商品フィード・クーポンの判定の問い合わせが、件数に比例しない時間で返ること（インデックスを使うこと）を確かめる。
 * 時間の上限は CI の遅い機械でも通るよう緩め（普段は数 ms〜数十 ms）。本当に見たいのは実行計画（seq scan にならない）。
 */
const N = 100_000;
const FAST_MS = 400;

describe.skipIf(!dbAvailable)("10 万件の性能（0058〜0060）", () => {
  let shop: Fixture;
  let categories: string[];
  let campaignId: string;
  const timings: Record<string, number> = {};

  /** 3 回流していちばん速い時間（ms）。1 回目はキャッシュが冷えているため */
  async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
    let best = Number.POSITIVE_INFINITY;
    let out: T | undefined;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      out = await run();
      best = Math.min(best, performance.now() - t0);
    }
    timings[label] = Math.round(best);
    return out as T;
  }
  const plan = async (c: pg.PoolClient, sql: string, params: unknown[]) => (await c.query(`explain ${sql}`, params)).rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
  const list = (args: unknown[]) => asAnon(async (c) => (await c.query<{ r: { items: { slug: string }[]; next: unknown; total?: number } }>("select product_public_list($1, $2, $3, $4, $5, $6, $7, $8, $9, null, $10) as r", args)).rows[0]!.r);

  beforeAll(async () => {
    await resetDatabase();
    shop = await createShopFixture({ email: "scale@example.com", slug: "scale", publish: true, stock: 1 });
    const pool = getPool();
    // カテゴリー: 最上位 10 × 子 5
    const tops = (await pool.query<{ id: string }>("insert into categories (shop_id, slug, name) select $1, 'top-' || g, 'トップ' || g from generate_series(0, 9) g returning id", [shop.shopId])).rows.map((r) => r.id);
    const subs: string[] = [];
    for (const [i, top] of tops.entries()) {
      subs.push(...(await pool.query<{ id: string }>("insert into categories (shop_id, slug, name, parent_id) select $1, 'sub-' || $3 || '-' || g, 'サブ' || g, $2 from generate_series(0, 4) g returning id", [shop.shopId, top, i])).rows.map((r) => r.id));
    }
    categories = [...tops, ...subs];
    // 商品 10 万件（1 文。0058 の文単位のトリガーで件数・価格が付く）。名前に日本語と英語、1 割は非公開
    await pool.query(
      `insert into products (shop_id, slug, name, description, published, tags, brand, category_id, created_at)
       select $1, 'p-' || g,
              (array['麦わら帽子','ニット帽','Tシャツ','ワンピース','スニーカー','マグカップ','Wool Cap','Linen Shirt'])[1 + g % 8] || ' ' || g,
              '説明 ' || g || ' 綿 100% のやわらかい生地',
              g % 10 <> 0,
              array['t' || (g % 200), 's' || (g % 7)],
              'brand' || (g % 50),
              ($2::uuid[])[1 + g % 60],
              now() - (g || ' seconds')::interval
         from generate_series(1, $3) g`,
      [shop.shopId, categories, N],
    );
    await pool.query(
      `insert into skus (shop_id, product_id, code, price_jpy)
       select shop_id, id, 'S-' || slug, 100 + (abs(hashtext(slug)) % 50000) from products where shop_id = $1 and slug like 'p-%'`,
      [shop.shopId],
    );
    await pool.query(`insert into product_images (shop_id, product_id, storage_key, sort_order) select shop_id, id, 'products/' || slug || '.webp', 0 from products where shop_id = $1`, [shop.shopId]);
    // クーポン: キャンペーン 1 万件、うち 1 つに配布用のコード 10 万枚
    await pool.query(`update shops set settings = settings || '{"modules":{"coupons":true,"product_feed":true}}'::jsonb where id = $1`, [shop.shopId]);
    await pool.query(`insert into coupon_campaigns (shop_id, name, code, kind, value) select $1, 'c' || g, 'CODE' || g, 'fixed', 100 from generate_series(1, 10000) g`, [shop.shopId]);
    campaignId = (await pool.query<{ id: string }>("select id from coupon_campaigns where shop_id = $1 and code = 'CODE1'", [shop.shopId])).rows[0]!.id;
    await pool.query(`insert into coupon_grants (shop_id, campaign_id, code, status) select $1, $2, 'G-' || g, case when g % 10 = 0 then 'used' else 'available' end from generate_series(1, $3) g`, [shop.shopId, campaignId, N]);
    await pool.query("analyze");
  }, 600_000);

  afterAll(async () => {
    console.log("[scale] 10 万件の所要時間（ms、3 回の最速）:", timings);
    await closePool();
  });

  it("件数の表と価格はトリガーで付いている（作り直した結果と一致）", async () => {
    const pool = getPool();
    const before = (await pool.query("select kind, key, count from product_facets where shop_id = $1 order by 1, 2", [shop.shopId])).rows;
    await pool.query("select banto_product_facets_rebuild($1)", [shop.shopId]);
    const after = (await pool.query("select kind, key, count from product_facets where shop_id = $1 order by 1, 2", [shop.shopId])).rows;
    expect(before).toEqual(after);
    expect((await pool.query("select count(*)::int as n from products where shop_id = $1 and list_price_jpy is null and slug like 'p-%'", [shop.shopId])).rows[0].n).toBe(0);
  });

  it("お店の画面・公開 API の一覧: 並べ替えごとの先頭と深いページ、絞り込み、件数", async () => {
    for (const sort of ["new", "updated", "price_asc", "price_desc", "name"]) {
      const first = await timed(`list:${sort}`, () => list([shop.shopId, sort, 48, null, 0, null, null, null, null, false]));
      expect(first.items).toHaveLength(48);
      // 9 万件目あたりから（キーセット）
      const deep = await asService(async (c) => {
        const key = { new: "created_at", updated: "updated_at", price_asc: "coalesce(list_price_jpy, 2147483647)", price_desc: "coalesce(list_price_jpy, -1)", name: "name" }[sort]!;
        const dir = sort === "price_asc" || sort === "name" ? "asc" : "desc";
        return (await c.query(`select ${key} as k, id from products where shop_id = $1 and published order by ${key} ${dir}, id ${dir} offset 80000 limit 1`, [shop.shopId])).rows[0];
      });
      const page = await timed(`list:${sort}:deep`, () => list([shop.shopId, sort, 48, JSON.stringify({ k: deep.k instanceof Date ? deep.k.toISOString() : deep.k, id: deep.id }), 0, null, null, null, null, false]));
      expect(page.items.length).toBeGreaterThan(0);
    }
    const byTag = await timed("list:tag", () => list([shop.shopId, "new", 48, null, 0, "t7", null, null, null, true]));
    expect(byTag.total).toBe(500);
    const sub = categories[15]!;
    const byCat = await timed("list:category", () => list([shop.shopId, "price_asc", 48, null, 0, null, [sub], null, null, true]));
    expect(byCat.items.length).toBe(48);
    const byBrand = await timed("list:brand", () => list([shop.shopId, "new", 48, null, 0, null, null, "brand3", null, true]));
    expect(byBrand.total).toBe(2000);
    const capped = await timed("list:count_capped", () => list([shop.shopId, "new", 24, null, 0, null, null, null, null, true]));
    expect(capped).toMatchObject({ total: 10000, total_capped: true });
    const search = await timed("list:search_ja", () => list([shop.shopId, "new", 48, null, 0, null, null, null, "麦わら帽子 12", true]));
    expect(search.items.length).toBeGreaterThan(0);
    const searchEn = await timed("list:search_en", () => list([shop.shopId, "new", 48, null, 0, null, null, null, "linen shirt 99", true]));
    expect(searchEn.items.length).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(timings)) if (k.startsWith("list:")) expect(v, k).toBeLessThan(FAST_MS);
    // 2 文字の語はインデックスが効かないので、絞り込み無しでは受け付けない。カテゴリーと一緒なら、そのカテゴリーの中だけを見る
    await expect(list([shop.shopId, "new", 48, null, 0, null, null, null, "帽子", false])).rejects.toThrow(/q_too_short/);
    // categories[16] には g ≡ 16 (mod 60) の商品が入り、そのうち g ≡ 0 (mod 8) が「麦わら帽子」（どれも公開中）
    const short = await timed("list:search_2chars_in_category", () => list([shop.shopId, "new", 48, null, 0, null, [categories[16]!], null, "帽子", false]));
    expect(short.items.length).toBeGreaterThan(0);
    expect(timings["list:search_2chars_in_category"]).toBeLessThan(FAST_MS);
  });

  it("実行計画: 並べ替え・キーセット・検索・タグ・カテゴリーはインデックスを使う", async () => {
    await asService(async (c) => {
      const keyset = await plan(c, "select id from products p where p.shop_id = $1 and p.published and (p.created_at, p.id) < ($2::timestamptz, $3::uuid) order by p.created_at desc, p.id desc limit 49", [shop.shopId, new Date().toISOString(), shop.productId]);
      expect(keyset).toMatch(/Index (Only )?Scan.*products_list_new/);
      const price = await plan(c, "select id from products p where p.shop_id = $1 and p.published and (coalesce(p.list_price_jpy, 2147483647), p.id) > ($2::int, $3::uuid) order by coalesce(p.list_price_jpy, 2147483647), p.id limit 49", [shop.shopId, 25000, shop.productId]);
      expect(price).toMatch(/products_list_price_asc/);
      const search = await plan(c, "select id from products p where p.shop_id = $1 and p.published and banto_product_search_text(p.name, p.brand, p.tags, p.description) like $2 order by p.created_at desc limit 49", [shop.shopId, "%麦わら帽子 12%"]);
      expect(search).toMatch(/products_search_trgm/);
      const tag = await plan(c, "select id from products p where p.shop_id = $1 and p.published and p.tags @> array[$2::text] order by p.created_at desc limit 49", [shop.shopId, "t7"]);
      expect(tag).not.toMatch(/Seq Scan on products/);
    });
  });

  it("タグ・カテゴリーの件数、サイトマップ、商品フィードの 1 ページ", async () => {
    const facets = await timed("facets", () => asAnon(async (c) => (await c.query<{ r: { tags: unknown[]; categories: Record<string, number> } }>("select product_public_facets($1) as r", [shop.shopId])).rows[0]!.r));
    // t0, t10, … t190 は全部非公開の商品（g % 10 = 0）なので出ない: t が 180 + s が 7
    expect(facets.tags).toHaveLength(187);
    // 60 のうち、非公開の商品（g % 10 = 0）しか入っていない子カテゴリーが 5 つ（categories[10, 20, 30, 40, 50]）
    expect(Object.keys(facets.categories)).toHaveLength(55);
    const count = await timed("sitemap:count", () => asAnon(async (c) => (await c.query<{ n: number }>("select product_public_count($1) as n", [shop.shopId])).rows[0]!.n));
    expect(count).toBe(90001);
    const slugs = await timed("sitemap:last_file", () => asAnon(async (c) => (await c.query<{ r: unknown[] }>("select product_public_slugs($1, 90000, 10000) as r", [shop.shopId])).rows[0]!.r));
    expect(slugs).toHaveLength(1);
    const page = await timed("feed:page", () => asAnon(async (c) => (await c.query<{ r: { products: { id: string }[]; skus: unknown[]; images: unknown[] } }>("select product_feed_page($1, null, 1000) as r", [shop.shopId])).rows[0]!.r));
    expect(page.products).toHaveLength(1000);
    expect(page.skus).toHaveLength(1000);
    const next = await timed("feed:page_deep", () => asAnon(async (c) => (await c.query<{ r: { products: unknown[] } }>("select product_feed_page($1, $2, 1000) as r", [shop.shopId, "fffe0000-0000-0000-0000-000000000000"])).rows[0]!.r));
    expect(next.products.length).toBeLessThan(1000);
    for (const k of ["facets", "sitemap:count", "sitemap:last_file", "feed:page", "feed:page_deep"]) expect(timings[k], k).toBeLessThan(k === "feed:page" ? 1500 : FAST_MS);
  });

  it("管理画面（owner の JWT）: 新しい順の 1 ページ・古いほうへのキーセット・名前の部分一致・クーポンの数", async () => {
    const run = (sql: string, params: unknown[]) => asUser(shop.ownerId, async (c) => (await c.query(sql, params)).rows);
    const first = await timed("admin:products", () => run("select id, name, created_at from products where shop_id = $1 order by created_at desc, id desc limit 51", [shop.shopId]));
    expect(first).toHaveLength(51);
    const last = first[50] as { id: string; created_at: Date };
    await timed("admin:products_next", () => run("select id from products where shop_id = $1 and (created_at < $2 or (created_at = $2 and id < $3)) order by created_at desc, id desc limit 51", [shop.shopId, last.created_at, last.id]));
    // 部分一致は RLS の外の検索の関数で id を探し（0059）、行は RLS 越しに読む
    const hits = await timed("admin:products_search", async () => {
      const ids = (await run("select admin_search_ids($1, 'products', $2, '{}', null, null, 51) as r", [shop.shopId, "linen shirt 4242"]))[0]!.r as string[];
      return run("select id, name from products where shop_id = $1 and id = any($2)", [shop.shopId, ids]);
    });
    expect(hits.length).toBeGreaterThan(0);
    const common = await timed("admin:products_search_common", () => run("select admin_search_ids($1, 'products', 'shirt', '{}', null, null, 51) as r", [shop.shopId]));
    expect((common[0]!.r as string[]).length).toBe(51);
    const grants = await timed("admin:grant_counts", () => run("select coupon_grant_counts($1, $2) as r", [shop.shopId, campaignId]));
    expect(grants[0]!.r).toEqual({ available: 90000, held: 0, used: 10000, revoked: 0 });
    await timed("admin:grants_page", () => run("select id, code from coupon_grants where campaign_id = $1 order by created_at desc, id desc limit 51", [campaignId]));
    await timed("admin:campaigns_page", () => run("select id from coupon_campaigns where shop_id = $1 order by created_at desc, id desc limit 51", [shop.shopId]));
    for (const k of ["admin:products", "admin:products_next", "admin:products_search", "admin:products_search_common", "admin:grants_page", "admin:campaigns_page", "admin:grant_counts"]) expect(timings[k], k).toBeLessThan(FAST_MS);
  });

  it("クーポンの判定: キャンペーン 1 万件・コード 10 万枚でも、入力したコードだけを引く", async () => {
    const r = await timed("coupon_lookup", () => asService(async (c) => (await c.query<{ r: unknown[] }>("select coupon_lookup($1, array['CODE9999', 'G-77777'], null, null) as r", [shop.shopId])).rows[0]!.r));
    expect(r).toHaveLength(2);
    expect(timings["coupon_lookup"]).toBeLessThan(FAST_MS);
  });

  it("商品ページとカート: その商品・その SKU の分だけ（ショップの件数に比例しない）", async () => {
    const r = await timed("product_page", () =>
      asAnon(async (c) => {
        const p = (await c.query<{ r: { id: string } }>("select product_public_get($1, 'p-54321') as r", [shop.shopId])).rows[0]!.r;
        const skus = (await c.query<{ id: string }>("select id from skus where product_id = $1", [p.id])).rows;
        return (await c.query("select sku_id, available from inventory where shop_id = $1 and sku_id = any($2)", [shop.shopId, skus.map((s) => s.id)])).rows;
      }),
    );
    expect(r).toHaveLength(1);
    expect(timings["product_page"]).toBeLessThan(FAST_MS);
  });
});
