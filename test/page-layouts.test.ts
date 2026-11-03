import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith, followPreview } from "./helpers";
import { composeLayout, pageLayoutsOf } from "../src/content/layouts";
import { forgetThemes } from "../src/themes/liquid/cache";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";

/** ひな形の割り当て（0101、src/content/layouts.ts、docs/pages.md「ひな形の割り当て」）: お店のトップと記事 */

const VERSION = "11111111-2222-4333-8444-555555555555";
const ARTICLE_TPL = ["::: current part=title", "", "::: current part=excerpt", "", "::: date", "", "::: current part=content", "", "::: current part=tags", "", "::: current part=prev-next", "", "ひな形の締め"].join("\n");

afterEach(() => forgetThemes());

function setup(opts: { liquid?: Record<string, string>; applied?: string[] } = {}) {
  forgetThemes();
  const sb = new FakeSupabase(opts.applied ? { appliedMigrations: opts.applied } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "テストの店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { pages: true, blog: true } } });
  sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const top = sb.addPage(shop.id, { handle: "top", title: "トップ", body: "## ようこそ\n\nいらっしゃいませ" });
  const tpl = sb.addPage(shop.id, { handle: "article-tpl", title: "記事のひな形", body: ARTICLE_TPL, template_suffix: "bare" });
  const blog = sb.addBlog(shop.id, { handle: "news", title: "お知らせ" });
  sb.addArticle(shop.id, blog.id, { handle: "first", title: "最初の記事", body: "一つ目", published_at: "2026-01-01T00:00:00Z" });
  sb.addArticle(shop.id, blog.id, { handle: "second", title: "二つ目の記事", body: "## 本文の見出し\n\n二つ目の本文", excerpt: "抜粋です", tags: ["新作"], published_at: "2026-02-01T00:00:00Z" });
  sb.addArticle(shop.id, blog.id, { handle: "third", title: "三つ目の記事", body: "三つ目", published_at: "2026-03-01T00:00:00Z" });
  const storage = new MemoryStorage(`${BASE}/media`);
  if (opts.liquid) {
    sb.sitePlan = "paid";
    const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
    row["domain"] = "shop.example.jp";
    row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
    void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files: opts.liquid, assets: [] })).buffer as ArrayBuffer, "application/json");
  }
  const app = appWith(sb, {}, storage);
  const settings = () => sb.tables.shops.find((x) => x["id"] === shop.id)!["settings"] as Record<string, unknown>;
  return { sb, shop, app, top, tpl, blog, settings, base: `/admin/shops/${shop.id}/modules/pages` };
}

describe("ひな形に記事を差し込む", () => {
  it("いちばん外側の本文の部品だけに差し込む（囲みの中なら差し込まない）", () => {
    expect(composeLayout("前\n\n::: current part=content\n\n後", "記事").body).toBe("前\n\n\n記事\n\n\n後");
    const nested = ":::: group\n::: current part=content\n::::";
    expect(composeLayout(nested, "記事")).toEqual({ body: nested, inserted: false });
    expect(composeLayout(":::: group\nx\n::::\n\n::: current part=content", "記事").inserted).toBe(true);
    expect(pageLayoutsOf({ page_layouts: { home: "bad", articles: { x: "y" }, product: 1 } })).toEqual({ home: null, articles: {}, product: null, productCategories: {} });
  });
});

describe("管理画面", () => {
  it("トップと記事のひな形を割り当てる。よそのページは断る。0101 が無ければ出さない", async () => {
    const { app, base, top, tpl, blog, settings } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect(await (await b.get(base)).text()).toContain(`href="${base}/layouts"`);
    const form = await (await b.get(`${base}/layouts`)).text();
    expect(form).toContain(`name="article_${blog.id}"`);
    expect((await b.post(`${base}/layouts`, { home: top.id, [`article_${blog.id}`]: tpl.id })).status).toBe(302);
    expect(settings()["page_layouts"]).toEqual({ home: top.id, articles: { [blog.id]: tpl.id } });
    expect((await b.post(`${base}/layouts`, { home: "00000000-0000-4000-8000-000000000000" })).status).toBe(400);
    const old = setup({ applied: BUNDLED_MIGRATIONS.filter((m) => m !== "0101_page_layouts") });
    const b2 = await Browser.loggedIn(old.app, "owner@example.com", "password-123");
    expect(await (await b2.get(old.base)).text()).not.toContain("/layouts");
    expect((await b2.get(`${old.base}/layouts`)).status).toBe(404);
  });
});

describe("お店の画面", () => {
  it("トップ: ひな形のページを出す。絞り込み・?all=1 は今までの一覧。非公開になれば今までの一覧", async () => {
    const { app, top, settings, sb } = setup();
    settings()["page_layouts"] = { home: top.id };
    const html = await (await new Browser(app, BASE).get("/my-shop")).text();
    expect(html).toContain("<h2>ようこそ</h2>");
    expect(html).not.toContain("<h1>トップ</h1>");
    expect(html).toContain("<title>テストの店");
    expect(html).not.toContain("Tシャツ");
    expect(await (await new Browser(app, BASE).get("/my-shop?all=1")).text()).toContain("Tシャツ");
    sb.tables.pages.find((p) => p["id"] === top.id)!["published"] = false;
    const app2 = appWith(sb, {}, new MemoryStorage(`${BASE}/media`));
    expect(await (await new Browser(app2, BASE).get("/my-shop")).text()).toContain("Tシャツ");
  });

  it("記事: ひな形の並びで、タイトル・抜粋・日時・本文・タグ・前後の記事を出す（テーマの見出しは出さない）", async () => {
    const { app, tpl, blog, settings } = setup();
    settings()["page_layouts"] = { articles: { [blog.id]: tpl.id } };
    const html = await (await new Browser(app, BASE).get("/my-shop/blogs/news/second")).text();
    // 本文の中だけで並びを確かめる（meta の description にも抜粋が出るので）
    const body = html.slice(html.indexOf("<body"));
    const order = ['<h1 class="banto-current-title">二つ目の記事</h1>', "抜粋です", 'class="banto-date"', "<h2>本文の見出し</h2>", "#新作", "最初の記事", "三つ目の記事", "ひな形の締め"].map((x) => body.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(html).toContain('rel="prev" href="/my-shop/blogs/news/first"');
    expect(html).toContain('rel="next" href="/my-shop/blogs/news/third"');
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).not.toContain("<!--banto:current");
    // ひな形の無いブログ・ページの中の部品は空
    const plain = setup();
    expect(await (await new Browser(plain.app, BASE).get("/my-shop/blogs/news/second")).text()).toContain("<h1>二つ目の記事</h1>");
  });

  it("プレビューもひな形で描く", async () => {
    const { app, tpl, blog, settings } = setup();
    settings()["page_layouts"] = { articles: { [blog.id]: tpl.id } };
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const res = await followPreview(app, await b.post(`/admin/shops/${String(blog["shop_id"])}/modules/blog/${blog.id}/articles`, { title: "下書きの記事", handle: "draft", body: "下書きの本文", action: "preview" }));
    const html = await res.text();
    expect(html).toContain('<h1 class="banto-current-title">下書きの記事</h1>');
    expect(html).toContain("下書きの本文");
    expect(html).toContain("ひな形の締め");
  });

  it("Liquid: ひな形の template_suffix のテンプレートで、記事の見出しで描く。トップは canonical がトップ", async () => {
    const { app, tpl, top, blog, settings } = setup({
      liquid: {
        "layout/theme.liquid": `<html><head>{{ content_for_header }}<title>{{ page_title }}</title></head><body><main>{{ content_for_layout }}</main></body></html>`,
        "templates/index.liquid": "<h1>top</h1>",
        "templates/page.liquid": `<article class="page-default"><h1>{{ page.title }}</h1>{{ page.content }}</article>`,
        "templates/page.bare.liquid": `<article class="page-bare">{{ page.content }}</article>`,
        "templates/article.liquid": `<article class="article">{{ article.content }}</article>`,
      },
    });
    settings()["page_layouts"] = { home: top.id, articles: { [blog.id]: tpl.id } };
    const art = await (await new Browser(app, "https://shop.example.jp").get("/blogs/news/second")).text();
    expect(art).toContain('<article class="page-bare">');
    expect(art).toContain("<title>二つ目の記事");
    expect(art).toContain('<h1 class="banto-current-title">二つ目の記事</h1>');
    expect(art).toContain('rel="canonical" href="https://shop.example.jp/blogs/news/second"');
    const home = await (await new Browser(app, "https://shop.example.jp").get("/")).text();
    // <title> はひな形の SEO のタイトルかショップの名前。テンプレートが出す見出しはページのもの（出したくなければ template_suffix で別のテンプレート）
    expect(home).toContain("<title>テストの店</title>");
    expect(home).toContain('<article class="page-default"><h1>トップ</h1>');
    expect(home).toContain("<h2>ようこそ</h2>");
    expect(home).toContain('rel="canonical" href="https://shop.example.jp"');
  });
});

describe("商品詳細のひな形（0102）", () => {
  const PRODUCT_TPL = ["::: current part=breadcrumb", "", "::: current part=title", "", "::: current part=price", "", "ひな形の案内", "", "::: current part=buy", "", "::: current part=content", "", "::: current part=excerpt"].join("\n");
  function productSetup(liquid?: Record<string, string>) {
    const x = setup(liquid ? { liquid } : {});
    const tops = { id: crypto.randomUUID(), shop_id: x.shop.id, slug: "tops", name: "トップス", parent_id: null, sort_order: 0 };
    const shirts = { id: crypto.randomUUID(), shop_id: x.shop.id, slug: "shirts", name: "シャツ", parent_id: tops.id, sort_order: 0 };
    x.sb.tables.categories.push(tops, shirts);
    const tee = x.sb.tables.products.find((p) => p["slug"] === "tee")!;
    tee["category_id"] = shirts.id;
    tee["description"] = "綿100%のTシャツ";
    x.sb.addSku(x.shop.id, String(tee["id"]), { code: "TEE-M", name: "M", price_jpy: 3000, available: 5 });
    const tpl = x.sb.addPage(x.shop.id, { handle: "product-tpl", title: "商品のひな形", body: PRODUCT_TPL });
    const topsTpl = x.sb.addPage(x.shop.id, { handle: "tops-tpl", title: "トップスのひな形", body: "トップス専用\n\n::: current part=buy" });
    return { ...x, tops, shirts, tpl, topsTpl };
  }

  it("ショップ全体のひな形: 部品の並び・買うフォーム・構造化データ。記事の部品は空", async () => {
    const { app, tpl, settings } = productSetup();
    settings()["page_layouts"] = { product: tpl.id };
    const html = await (await new Browser(app, BASE).get("/my-shop/p/tee")).text();
    const body = html.slice(html.indexOf("<body"));
    const order = ["トップス</a>", "<h1>Tシャツ</h1>", 'class="product-price"', "ひな形の案内", 'action="/my-shop/cart/add"', "綿100%のTシャツ"].map((x) => body.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(html).toContain('"@type":"Product"');
    expect(html).toContain('rel="canonical" href="http://localhost:8787/my-shop/p/tee"');
    expect(html).not.toContain("<!--banto:current");
    // 買える: そのままカートに入る
    const b = new Browser(app, BASE);
    const sku = String(html.match(/<option value="([^"]+)"/)![1]);
    expect((await b.post("/my-shop/cart/add", { sku_id: sku, qty: "1" }, { origin: BASE })).status).toBe(302);
  });

  it("カテゴリーの上書きは主カテゴリーから親へたどって近いもの。見えないページなら今までの画面", async () => {
    const { app, sb, tpl, topsTpl, tops, settings } = productSetup();
    settings()["page_layouts"] = { product: tpl.id, product_categories: { [tops.id]: topsTpl.id } };
    expect(await (await new Browser(app, BASE).get("/my-shop/p/tee")).text()).toContain("トップス専用");
    sb.tables.pages.find((p) => p["id"] === topsTpl.id)!["published"] = false;
    sb.tables.pages.find((p) => p["id"] === tpl.id)!["published"] = false;
    const app2 = appWith(sb, {}, new MemoryStorage(`${BASE}/media`));
    const html = await (await new Browser(app2, BASE).get("/my-shop/p/tee")).text();
    expect(html).not.toContain("トップス専用");
    expect(html).toContain('<div class="product">');
  });

  it("管理画面: 0102 が当たれば商品とカテゴリーの欄を出して保存する。当たる前は出さず、送らない", async () => {
    const { app, base, tpl, topsTpl, tops, settings } = productSetup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const form = await (await b.get(`${base}/layouts`)).text();
    expect(form).toContain('name="product"');
    expect(form).toContain(`name="category_${tops.id}"`);
    expect((await b.post(`${base}/layouts`, { product: tpl.id, [`category_${tops.id}`]: topsTpl.id })).status).toBe(302);
    expect(settings()["page_layouts"]).toEqual({ product: tpl.id, product_categories: { [tops.id]: topsTpl.id } });
    const old = setup({ applied: BUNDLED_MIGRATIONS.filter((m) => m !== "0102_page_layouts_product") });
    const b2 = await Browser.loggedIn(old.app, "owner@example.com", "password-123");
    expect(await (await b2.get(`${old.base}/layouts`)).text()).not.toContain('name="product"');
  });

  it("Liquid: ひな形の中に既定の部品で描き、構造化データと canonical は商品のもの", async () => {
    const { app, tpl, settings } = productSetup({
      "layout/theme.liquid": `<html><head>{{ content_for_header }}<title>{{ page_title }}</title></head><body><main>{{ content_for_layout }}</main></body></html>`,
      "templates/index.liquid": "<h1>top</h1>",
      "templates/page.liquid": `<article class="page-default">{{ page.content }}</article>`,
      "templates/product.liquid": `<div class="liquid-product">{{ product.title }}</div>`,
    });
    settings()["page_layouts"] = { product: tpl.id };
    const html = await (await new Browser(app, "https://shop.example.jp").get("/p/tee")).text();
    expect(html).toContain('<article class="page-default">');
    expect(html).not.toContain("liquid-product");
    expect(html).toContain("<h1>Tシャツ</h1>");
    expect(html).toContain('action="/cart/add"');
    expect(html).toContain('"@type":"Product"');
    expect(html).toContain('rel="canonical" href="https://shop.example.jp/p/tee"');
  });
});
