import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { categoryDescriptionHtml, categoryImageOf } from "../src/products/category-media";

/** カテゴリーの説明と画像（0113、docs/storefront.md「カテゴリーの画像と説明」） */
function webp(w: number, h: number): Uint8Array<ArrayBuffer> {
  const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
  return new Uint8Array([..."RIFF"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [..."WEBPVP8X"].map((c) => c.charCodeAt(0)), [10, 0, 0, 0, 0, 0, 0, 0], le24(w - 1), le24(h - 1)));
}

function setup(opts: { applied?: string[] } = {}) {
  const sb = new FakeSupabase(opts.applied ? { appliedMigrations: opts.applied } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { pages: true } } });
  const tops = sb.addCategory(shop.id, { id: crypto.randomUUID(), slug: "tops", name: "トップス" });
  const bags = sb.addCategory(shop.id, { id: crypto.randomUUID(), slug: "bags", name: "バッグ", sort_order: 1 });
  const p = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true, category_id: tops.id });
  sb.addSku(shop.id, p.id, { code: "TEE-M", price_jpy: 3000, available: 3 });
  const storage = new MemoryStorage(`${BASE}/media`);
  const app = appWith(sb, {}, storage);
  const row = (id: string) => sb.tables.categories.find((c) => c["id"] === id)!;
  return { sb, shop, tops, bags, storage, app, row, base: `/admin/shops/${shop.id}/categories` };
}

describe("カテゴリーの説明と画像", () => {
  it("説明はエスケープして改行を <br>。画像の鍵は categories/ の形だけ", () => {
    expect(categoryDescriptionHtml("a<b>\r\nc ")).toBe("a&lt;b&gt;<br>c");
    expect(categoryDescriptionHtml("  ")).toBe("");
    expect(categoryImageOf({ image: { key: "categories/s/0123456789abcdef.webp", width: 1, height: 1 } })).toEqual({ key: "categories/s/0123456789abcdef.webp", width: 1, height: 1 });
    expect(categoryImageOf({ image: { key: "products/s/0123456789abcdef.webp", width: 1, height: 1 } })).toBeNull();
    expect(categoryImageOf({ image: { key: "categories/s/0123456789abcdef.webp" } as never })).toBeNull();
  });

  it("管理画面: 画像を置いて説明を保存し、置き換えると前の画像を消す。外すこともできる", async () => {
    const { app, base, tops, row, storage } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = await (await b.get(base)).text();
    expect(page).toContain(`action="${base}/${tops.id}/media"`);
    expect(page).toContain("data-category-media");
    let res = await b.postMultipart(`${base}/${tops.id}/media`, { description: "  秋冬の羽織り\n軽いもの ", image: new File([webp(1600, 900)], "x.webp", { type: "image/webp" }) });
    expect(res.status).toBe(302);
    const first = (row(tops.id)["image"] as { key: string }).key;
    expect(first).toMatch(/^categories\/shop-\d+\/[a-f0-9]+\.webp$/);
    expect(row(tops.id)["image"]).toMatchObject({ width: 1600, height: 900 });
    expect(row(tops.id)["description"]).toBe("秋冬の羽織り\n軽いもの");
    expect(storage.objects.has(first)).toBe(true);
    // 画像でないものは断る（行は変えない）
    res = await b.postMultipart(`${base}/${tops.id}/media`, { description: "x", image: new File([new Uint8Array([1, 2, 3])], "x.webp", { type: "image/webp" }) });
    expect(res.headers.get("location")).toContain("flash=image_invalid");
    expect(row(tops.id)["description"]).toBe("秋冬の羽織り\n軽いもの");
    // 置き換え
    await b.postMultipart(`${base}/${tops.id}/media`, { description: "", image: new File([webp(800, 600)], "y.webp", { type: "image/webp" }) });
    const second = (row(tops.id)["image"] as { key: string }).key;
    expect(second).not.toBe(first);
    expect(storage.objects.has(first)).toBe(false);
    expect(row(tops.id)["description"]).toBeNull();
    // 外す
    await b.postMultipart(`${base}/${tops.id}/media`, { description: "", image_remove: "on" });
    expect(row(tops.id)["image"]).toBeNull();
    expect(storage.objects.has(second)).toBe(false);
  });

  it("管理画面: 0113 が当たる前は欄を出さない", async () => {
    const { app, base, sb, tops } = setup();
    sb.appliedMigrations = sb.appliedMigrations.filter((v) => v !== "0113_category_media");
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect(await (await b.get(base)).text()).not.toContain(`${tops.id}/media`);
  });

  it("お店の画面: カテゴリーの一覧の上に画像と説明、説明は検索エンジン向けの説明にも。格子のブロックに画像", async () => {
    const { app, sb, shop, tops, row } = setup();
    Object.assign(row(tops.id), { description: "秋冬の<羽織り>\n軽いもの", image: { key: `categories/${shop.id}/0123456789abcdef.webp`, width: 1600, height: 900 } });
    const html = await (await new Browser(app, BASE).get("/my-shop/categories/tops")).text();
    expect(html).toContain('<div class="category-intro"><img class="category-image" src="');
    expect(html).toContain("0123456789abcdef.webp");
    expect(html).toContain('<div class="category-description">秋冬の&lt;羽織り&gt;<br>軽いもの</div>');
    expect(html).toMatch(/<meta name="description" content="秋冬の&lt;羽織り&gt; 軽いもの"/);
    // 画像も説明も無いカテゴリーは何も足さない
    expect(await (await new Browser(app, BASE).get("/my-shop/categories/bags")).text()).not.toContain('<div class="category-intro">');
    sb.addPage(shop.id, { handle: "cats", title: "カテゴリー", body: "::: categories layout=grid\n\n::: categories" });
    const page = await (await new Browser(app, BASE).get("/my-shop/pages/cats")).text();
    expect(page).toMatch(/<ul class="banto-categories banto-categories--grid"><li><a href="\/my-shop\/categories\/tops"><img class="banto-categories__image" src="[^"]+0123456789abcdef\.webp" width="1600" height="900"/);
    // 一覧の形には画像を出さない
    expect(page.match(/banto-categories__image" src/g)).toHaveLength(1);
  });

  it("Liquid: collection.description・collection.image と、説明を page_description（検索エンジン向けの説明）に", async () => {
    const { sb, shop, tops, row, storage } = setup();
    Object.assign(row(tops.id), { description: "秋冬の<羽織り>\n軽いもの", image: { key: `categories/${shop.id}/0123456789abcdef.webp`, width: 1600, height: 900 } });
    const VERSION = "11111111-2222-4333-8444-555555555555";
    sb.sitePlan = "paid";
    const s = sb.tables.shops.find((x) => x["id"] === shop.id)!;
    s["domain"] = "shop.example.jp";
    s["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
    const files = {
      "layout/theme.liquid": `<html><head><meta name="description" content="{{ page_description }}">{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>`,
      "templates/collection.liquid": `<div class="d">{{ collection.description }}</div><img src="{{ collection.image.src }}" width="{{ collection.image.width }}"><i>{{ collections.tops.description }}</i>`,
    };
    await storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files, assets: [] })).buffer as ArrayBuffer, "application/json");
    const html = await (await new Browser(appWith(sb, {}, storage), "https://shop.example.jp").get("/categories/tops")).text();
    expect(html).toContain('<meta name="description" content="秋冬の&lt;羽織り&gt; 軽いもの">');
    expect(html).toContain('<div class="d">秋冬の&lt;羽織り&gt;<br>軽いもの</div>');
    expect(html).toMatch(/<img src="[^"]+0123456789abcdef\.webp" width="1600">/);
    expect(html).toContain("<i>秋冬の&lt;羽織り&gt;<br>軽いもの</i>");
  });
});
