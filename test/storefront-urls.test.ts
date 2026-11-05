import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";
import { categoryUrl, listUrl, productUrl, productsUrl } from "../src/storefront/urls";

/**
 * お店の画面の商品の URL（メンテナの決定 2026-11-05、docs/storefront.md「URL」）:
 * すべての商品 /products、詳細 /products/<商品>、カテゴリーの一覧 /categories/<カテゴリー>。?tag= ?q= ?after= はどの一覧にも
 */
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";
afterEach(() => forgetThemes());

function setup(opts: { liquid?: Record<string, string>; home?: boolean } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "テストの店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { pages: true } } });
  const tops = sb.addCategory(shop.id, { id: crypto.randomUUID(), slug: "tops", name: "トップス" });
  const bags = sb.addCategory(shop.id, { id: crypto.randomUUID(), slug: "bags", name: "バッグ", sort_order: 1 });
  for (const [slug, name, cat, tags] of [["tee", "Tシャツ", tops.id, ["夏"]], ["knit", "ニット", tops.id, ["冬"]], ["tote", "トートバッグ", bags.id, ["夏"]]] as const) {
    const p = sb.addProduct(shop.id, { slug, name, published: true, category_id: cat, tags: [...tags] });
    sb.addSku(shop.id, p.id, { code: slug, price_jpy: 3000, available: 3 });
  }
  if (opts.home) {
    const top = sb.addPage(shop.id, { handle: "top", title: "トップ", body: "## ようこそ", updated_at: new Date(Date.UTC(2020, 0, 1) + Math.floor(Math.random() * 1e10)).toISOString() });
    (sb.tables.shops.find((x) => x["id"] === shop.id)!["settings"] as Record<string, unknown>)["page_layouts"] = { home: top.id };
  }
  const storage = new MemoryStorage(`${BASE}/media`);
  if (opts.liquid) {
    sb.sitePlan = "paid";
    const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
    row["domain"] = "shop.example.jp";
    row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
    void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files: opts.liquid, assets: [] })).buffer as ArrayBuffer, "application/json");
  }
  const app = appWith(sb, {}, storage);
  return { sb, shop, app, b: new Browser(app, opts.liquid ? DOMAIN : BASE) };
}

describe("URL の組み立て", () => {
  it("商品・すべての商品・カテゴリー・条件", () => {
    expect(productUrl("/s", "tee")).toBe("/s/products/tee");
    expect(productUrl("", "tee", { sku: "TEE-M", added: null })).toBe("/products/tee?sku=TEE-M");
    expect(productsUrl("")).toBe("/products");
    expect(productsUrl("/s", { tag: "夏", q: "シャツ", after: "c1" })).toBe("/s/products?tag=%E5%A4%8F&q=%E3%82%B7%E3%83%A3%E3%83%84&after=c1");
    expect(categoryUrl("", "tops", { tag: "夏" })).toBe("/categories/tops?tag=%E5%A4%8F");
    expect(listUrl("/s", { category: "tops" })).toBe("/s/categories/tops");
    expect(listUrl("/s", { category: null, q: "x" })).toBe("/s/products?q=x");
  });
});

describe("既定のテーマ", () => {
  it("トップ（ひな形なし）: ショップの名前の見出しとすべての商品。リンクは /products と /categories/…", async () => {
    const { b } = setup();
    const html = await (await b.get("/my-shop")).text();
    expect(html).toContain('<div class="hero"><h1>テストの店</h1>');
    expect(html).toContain('<a href="/my-shop/products" class="active">すべての商品</a>');
    expect(html).toContain('<a href="/my-shop/categories/tops" class="">トップス</a>');
    expect(html).toContain('href="/my-shop/products/tee"');
    expect(html).toContain(`rel="canonical" href="${BASE}/my-shop"`);
  });

  it("/products: 「すべての商品」の見出し・canonical。/categories/<カテゴリー>: そのカテゴリーだけ。無いカテゴリーは 404", async () => {
    const { b } = setup();
    const all = await (await b.get("/my-shop/products")).text();
    expect(all).not.toContain('class="hero"');
    expect(all).toContain("<h1>すべての商品</h1>");
    expect(all).toContain(`rel="canonical" href="${BASE}/my-shop/products"`);
    expect(all).toContain("トートバッグ");
    const tops = await (await b.get("/my-shop/categories/tops")).text();
    expect(tops).toContain("<h1>トップス</h1>");
    expect(tops).toContain(`rel="canonical" href="${BASE}/my-shop/categories/tops"`);
    expect(tops).toContain("ニット");
    expect(tops).not.toContain("トートバッグ");
    expect((await b.get("/my-shop/categories/nope")).status).toBe(404);
  });

  it("?tag= はどの一覧にも。タグのリンクは今のカテゴリーのまま", async () => {
    const { b } = setup();
    const html = await (await b.get("/my-shop/categories/tops?tag=%E5%A4%8F")).text();
    expect(html).toContain("Tシャツ");
    expect(html).not.toContain("ニット</div>");
    expect(html).not.toContain("トートバッグ");
    expect(html).toContain('href="/my-shop/categories/tops?tag=%E5%86%AC"');
    expect(html).toContain(`rel="canonical" href="${BASE}/my-shop/categories/tops?tag=%E5%A4%8F"`);
    const all = await (await b.get("/my-shop/products?tag=%E5%A4%8F")).text();
    expect(all).toContain("トートバッグ");
    expect(all).toContain("Tシャツ");
  });

  it("?q= は検索: 見出し・noindex。短い語はカテゴリー・タグでも絞っていなければ探さない", async () => {
    const { b } = setup();
    const html = await (await b.get("/my-shop/products?q=%E3%83%88%E3%83%BC%E3%83%88")).text();
    expect(html).toContain("<h1>「トート」の検索結果</h1>");
    expect(html).toContain('<meta name="robots" content="noindex"');
    expect(html).toContain("トートバッグ");
    expect(html).not.toContain("ニット</div>");
    expect(await (await b.get("/my-shop/products?q=%E3%83%88")).text()).toContain("3 文字以上で探してください。");
    // カテゴリーの中なら 1 文字でも探す
    const inCat = await (await b.get("/my-shop/categories/tops?q=%E3%83%8B")).text();
    expect(inCat).toContain("ニット");
    expect(inCat).not.toContain("Tシャツ</div>");
  });

  it("前の URL（/p/<商品>・/search・?category=）は使わない", async () => {
    const { b } = setup();
    expect((await b.get("/my-shop/p/tee")).status).toBe(404);
    expect((await b.get("/my-shop/search?q=tee")).status).toBe(404);
    // トップは条件を見ない（すべての商品のまま）
    const top = await (await b.get("/my-shop?category=bags")).text();
    expect(top).toContain("ニット");
  });

  it("トップのひな形があれば / はそのページ、すべての商品は /products のまま", async () => {
    const { b } = setup({ home: true });
    expect(await (await b.get("/my-shop")).text()).toContain("<h2>ようこそ</h2>");
    const all = await (await b.get("/my-shop/products")).text();
    expect(all).toContain("<h1>すべての商品</h1>");
    expect(all).toContain('<a href="/my-shop/products" class="active">すべての商品</a>');
  });

  it("サイトマップに /products とカテゴリーの一覧", async () => {
    const { app } = setup();
    const xml = await (await app.request(`${BASE}/sitemap-pages.xml`)).text();
    expect(xml).toContain(`<loc>${BASE}/my-shop/products</loc>`);
    expect(xml).toContain(`<loc>${BASE}/my-shop/categories/tops</loc>`);
    expect(xml).toContain(`<loc>${BASE}/my-shop/categories/bags</loc>`);
  });
});

describe("Liquid のテーマ", () => {
  const base = {
    "layout/theme.liquid": "<html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>",
    "templates/index.liquid": "<p class=\"t\">index|{{ request.path }}|{{ routes.all_products_collection_url }}|{{ routes.search_url }}</p>",
    "templates/collection.liquid": "<p class=\"t\">collection|{{ request.path }}|{{ collection.url }}|{{ search.terms }}|{{ search.performed }}|{% for p in products %}{{ p.url }} {% endfor %}</p>",
  };

  it("トップは templates/index、/products と /categories/… は templates/collection。collection.url と product.url は新しい形", async () => {
    const { b } = setup({ liquid: base });
    expect(await (await b.get("/")).text()).toContain('<p class="t">index|/|/products|/products</p>');
    expect(await (await b.get("/products")).text()).toContain('<p class="t">collection|/products|/products|||');
    const cat = await (await b.get("/categories/tops")).text();
    expect(cat).toContain("collection|/categories/tops|/categories/tops|||");
    expect(cat).toContain("/products/tee ");
  });

  it("検索の語: templates/search が無ければ collection に search を渡す。あれば search", async () => {
    const { b } = setup({ liquid: base });
    expect(await (await b.get("/products?q=%E3%83%88%E3%83%BC%E3%83%88")).text()).toContain("collection|/products|/products|トート|true|/products/tote ");
    forgetThemes();
    const withSearch = setup({ liquid: { ...base, "templates/search.liquid": '<p class="s">search|{{ search.terms }}|{{ search.results_count }}</p>' } });
    expect(await (await withSearch.b.get("/products?q=%E3%83%88%E3%83%BC%E3%83%88")).text()).toContain('<p class="s">search|トート|1</p>');
  });
});
