import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";
import { listSortOf, shopifySortName } from "../src/storefront/list-sort";
import { categoryUrl, productsUrl } from "../src/storefront/urls";

/** 一覧の並べ替え（?sort=、Shopify のテーマの ?sort_by=。メンテナの決定 2026-11-06、docs/storefront.md「URL」） */
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";
afterEach(() => forgetThemes());

function setup(liquid?: Record<string, string>) {
  forgetThemes();
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "並べ替えの店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const tops = sb.addCategory(shop.id, { id: crypto.randomUUID(), slug: "tops", name: "トップス" });
  for (const [i, [slug, name, price]] of ([["b-mid", "Bシャツ", 3000], ["c-cheap", "Cシャツ", 1000], ["a-high", "Aシャツ", 9000]] as const).entries()) {
    const p = sb.addProduct(shop.id, { slug, name, published: true, category_id: tops.id, tags: ["夏"], created_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() });
    sb.addSku(shop.id, p.id, { code: slug, price_jpy: price, available: 3 });
  }
  const storage = new MemoryStorage(`${BASE}/media`);
  if (liquid) {
    sb.sitePlan = "paid";
    const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
    row["domain"] = "shop.example.jp";
    row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
    void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files: liquid, assets: [] })).buffer as ArrayBuffer, "application/json");
  }
  const app = appWith(sb, {}, storage);
  return { sb, shop, b: new Browser(app, liquid ? DOMAIN : BASE) };
}
const order = (html: string) => [...html.matchAll(/\/products\/(a-high|b-mid|c-cheap)"/g)].map((m) => m[1]).filter((x, i, a) => a.indexOf(x) === i);

describe("並べ方の読み取りと URL", () => {
  it("?sort= は Banto の名前、?sort_by= は Shopify の名前。既定（新しい順）と知らない値は持たない", () => {
    expect(listSortOf("price_asc")).toBe("price_asc");
    expect(listSortOf(undefined, "price-descending")).toBe("price_desc");
    expect(listSortOf(undefined, "title-ascending")).toBe("name");
    expect(listSortOf("updated")).toBe("updated");
    expect(listSortOf("new")).toBeUndefined();
    expect(listSortOf("bogus", "best-selling")).toBeUndefined();
    expect(shopifySortName(undefined)).toBe("created-descending");
    expect(shopifySortName("price_asc")).toBe("price-ascending");
    expect(productsUrl("/s", { tag: "夏", sort: "price_asc", after: "c1" })).toBe("/s/products?tag=%E5%A4%8F&sort=price_asc&after=c1");
    expect(categoryUrl("", "tops", { sort: "name" })).toBe("/categories/tops?sort=name");
  });
});

describe("既定のテーマ", () => {
  it("安い順・高い順・名前順に並ぶ。並べ替えのリンクは今の条件を保ち、canonical は並べ方を外す", async () => {
    const { b } = setup();
    expect(order(await (await b.get("/my-shop/products")).text())).toEqual(["a-high", "c-cheap", "b-mid"]);
    const asc = await (await b.get("/my-shop/products?sort=price_asc")).text();
    expect(order(asc)).toEqual(["c-cheap", "b-mid", "a-high"]);
    expect(asc).toContain(`rel="canonical" href="${BASE}/my-shop/products"`);
    expect(asc).toContain('href="/my-shop/products?sort=price_desc"');
    expect(asc).toMatch(/<a href="\/my-shop\/products\?sort=price_asc" class="active" aria-current="true">安い順<\/a>/);
    expect(asc).toContain('href="/my-shop/products?tag=%E5%A4%8F&amp;sort=price_asc"'); // タグで絞っても並べ方は保つ
    expect(order(await (await b.get("/my-shop/categories/tops?sort_by=price-descending")).text())).toEqual(["a-high", "b-mid", "c-cheap"]);
    expect(order(await (await b.get("/my-shop/products?sort=name")).text())).toEqual(["a-high", "b-mid", "c-cheap"]);
    // 知らない値は新しい順
    expect(order(await (await b.get("/my-shop/products?sort=bogus")).text())).toEqual(["a-high", "c-cheap", "b-mid"]);
  });
});

describe("Liquid のテーマ", () => {
  it("collection.sort_by・sort_options（Shopify の名前）。?sort_by= で並ぶ", async () => {
    const { b } = setup({
      "layout/theme.liquid": "<html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>",
      "templates/index.liquid": "<h1>top</h1>",
      "templates/collection.liquid": `<p class="sb">{{ collection.sort_by }}</p><select name="sort_by">{% for o in collection.sort_options %}<option value="{{ o.value }}"{% if o.value == collection.sort_by %} selected{% endif %}>{{ o.name }}</option>{% endfor %}</select>{% for p in collection.products %}<a href="{{ p.url }}">{{ p.title }}</a>{% endfor %}`,
    });
    const html = await (await b.get("/products?sort_by=price-ascending")).text();
    expect(html).toContain('<p class="sb">price-ascending</p>');
    expect(html).toContain('<option value="price-ascending" selected>安い順</option>');
    expect(html).toContain('<option value="created-descending">新しい順</option>');
    expect(order(html)).toEqual(["c-cheap", "b-mid", "a-high"]);
  });
});
