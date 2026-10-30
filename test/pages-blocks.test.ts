import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";
import { markdownToHtml } from "../src/pages/markdown";
import { fillProductBlocks, parseButtonLine, parseProductsLine, productBlocksOf, productsLine } from "../src/pages/blocks";

/** ページの本文のブロック（::: products・::: button、src/pages/blocks.ts、docs/pages.md） */
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";
afterEach(forgetThemes);

describe("ブロックの書式", () => {
  it("「::: products」を読み、形が違えば文字のまま", () => {
    expect(parseProductsLine("::: products category=tops tag=\"冬 物\" limit=12 layout=scroll sort=price_asc")).toEqual({ category: "tops", tag: "冬 物", limit: 12, layout: "scroll", sort: "price_asc" });
    expect(parseProductsLine("::: products")).toEqual({ category: null, tag: null, limit: 8, layout: "grid", sort: "new" });
    for (const bad of ["::: products limit=25", "::: products limit=0", "::: products layout=list", "::: products sort=random", "::: products category=Tops", "::: product"]) expect(parseProductsLine(bad), bad).toBeNull();
    expect(productsLine({ category: "tops", tag: "冬 物", limit: 12, layout: "scroll", sort: "price_asc" })).toBe('::: products category=tops tag="冬 物" limit=12 layout=scroll sort=price_asc');
    expect(parseButtonLine("::: button [詳しく見る](/p/coat)")).toEqual({ text: "詳しく見る", url: "/p/coat" });
  });

  it("変換は商品の場所に印（3 つまで）、ボタンは決まった形。危ない URL のボタンと形の違う行は文字", () => {
    const body = ["前の段落", "::: products tag=a", "::: products", "::: products", "::: products", "::: button [見る](/p/x)", "::: button [x](javascript:alert(1))", "::: products limit=99"].join("\n");
    const html = markdownToHtml(body);
    expect(html).toContain('<p>前の段落</p>\n<div class="banto-products banto-products--grid" data-banto-block="products" data-category="" data-tag="a" data-limit="8" data-layout="grid" data-sort="new"><!--banto:products:0--></div>');
    expect(html.match(/<!--banto:products:\d-->/g)).toEqual(["<!--banto:products:0-->", "<!--banto:products:1-->", "<!--banto:products:2-->"]);
    expect(html).toContain('<p class="banto-button"><a class="banto-button__link" href="/p/x">見る</a></p>');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("::: products limit=99");
    expect(productBlocksOf(body)).toHaveLength(3);
    expect(fillProductBlocks(html, ["<ul>A</ul>"])).toContain('data-tag="a" data-limit="8" data-layout="grid" data-sort="new"><ul>A</ul></div>');
    expect(fillProductBlocks(html, ["<ul>A</ul>"])).not.toContain("<!--banto");
    // 本文の文字からは印を作れない
    expect(markdownToHtml("<!--banto:products:0-->")).toBe("<p>&lt;!--banto:products:0--&gt;</p>");
  });

});

function setup(opts: { liquid?: Record<string, string> } = {}) {
  forgetThemes();
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { pages: true } } });
  const cat = sb.addCategory(shop.id, { slug: "tops", name: "トップス" });
  for (const [slug, name, price, tags, category] of [
    ["coat", "コート", 30000, ["冬物"], cat.id],
    ["knit", "ニット", 9000, ["冬物"], cat.id],
    ["tee", "T シャツ", 3000, [], null],
  ] as const) {
    const p = sb.addProduct(shop.id, { slug, name, published: true, tags: [...tags], category_id: category });
    sb.addSku(shop.id, p.id, { code: slug, price_jpy: price, available: 3 });
  }
  sb.addPage(shop.id, { handle: "winter", title: "冬の特集", body: "冬のおすすめです。\n\n::: products category=tops tag=冬物 limit=2 layout=scroll sort=price_desc\n\n::: button [すべて見る](/my-shop)" });
  const storage = new MemoryStorage(`${BASE}/media`);
  if (opts.liquid) {
    sb.sitePlan = "paid";
    const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
    row["domain"] = "shop.example.jp";
    row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
    void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files: opts.liquid, assets: [] })).buffer as ArrayBuffer, "application/json");
  }
  const app = appWith(sb, {}, storage, new FakeStripe());
  return { sb, b: new Browser(app, opts.liquid ? DOMAIN : BASE) };
}

describe("お店の画面の商品のブロック", () => {
  it("既定のテーマ: 公開中の商品をカテゴリー・タグ・並び順・数で選び、既定のカードで並べる", async () => {
    const { b } = setup();
    const html = await (await b.get("/my-shop/pages/winter")).text();
    expect(html).toContain('data-layout="scroll"');
    expect(html).toMatch(/<ul class="banto-products__list grid" style="display:flex;[^"]*overflow-x:auto/);
    const names = [...html.matchAll(/<div class="body"><div>([^<]+)<\/div>/g)].map((m) => m[1]);
    expect(names).toEqual(["コート", "ニット"]);
    expect(html).toContain('href="/my-shop/p/coat"');
    expect(html).toContain("¥30,000");
    expect(html).toContain('<a class="banto-button__link" href="/my-shop">すべて見る</a>');
    expect(html).not.toContain("<!--banto");
  });

  const theme = {
    "layout/theme.liquid": "<!doctype html><html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>",
    "templates/page.liquid": "<article>{{ page.content }}</article>",
  };

  it("Liquid のテーマ: snippets/page-products があれば products と block を渡して描く", async () => {
    const { b } = setup({ liquid: { ...theme, "snippets/page-products.liquid": '<div class="mine" data-layout="{{ block.layout }}" data-limit="{{ block.limit }}">{% for p in products %}<a href="{{ p.url }}">{{ p.title }} {{ p.price | money }}</a>{% endfor %}</div>' } });
    const html = await (await b.get("/pages/winter")).text();
    expect(html).toContain('<div class="mine" data-layout="scroll" data-limit="2"><a href="/p/coat">コート');
    expect(html).toContain('<a href="/p/knit">ニット');
    expect(html).not.toContain("banto-products__list");
  });

  it("Liquid のテーマ: snippet が無ければ既定のカード", async () => {
    const { b } = setup({ liquid: theme });
    const html = await (await b.get("/pages/winter")).text();
    expect(html).toContain('<ul class="banto-products__list grid"');
    expect(html).toContain('href="/p/coat"');
  });
});
