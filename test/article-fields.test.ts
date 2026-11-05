import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";
import { fieldContains, fieldsFromForm, formatArticleFieldRows, parseArticleFieldRows } from "../src/blog/fields";
import { parseArticlesLine, articlesLine, parseProductsLine, productsLine } from "../src/pages/blocks";

/** 記事の独自の項目（0117、src/blog/fields.ts・src/content/article-fields.ts、docs/blog.md「記事の項目」） */

describe("定義の欄と値の形", () => {
  const blogs = [{ id: "11111111-1111-4111-8111-111111111111", handle: "staff" }];
  it("「キー | 表示名 | 種類 | 補足」を読み書きする（s でいくつも、記事は指すブログの URL の名前）", () => {
    const text = ["height | 身長 | number", "store | 店舗 | store", "mood | 雰囲気 | select | きれいめ/カジュアル", "author | 書いた人 | article | staff", "items | 着用アイテム | products"].join("\n");
    const { defs, error } = parseArticleFieldRows(text, blogs);
    expect(error).toBeNull();
    expect(defs).toEqual([
      { key: "height", label: "身長", type: "number" },
      { key: "store", label: "店舗", type: "store" },
      { key: "mood", label: "雰囲気", type: "select", options: ["きれいめ", "カジュアル"] },
      { key: "author", label: "書いた人", type: "article", blog: blogs[0]!.id },
      { key: "items", label: "着用アイテム", type: "product", multiple: true },
    ]);
    expect(formatArticleFieldRows(defs, blogs)).toBe(text);
    expect(parseArticleFieldRows("author | 書いた人 | article | nope", blogs).error).toBe("author | 書いた人 | article | nope");
    expect(parseArticleFieldRows("Bad | x | text", blogs).error).toBe("Bad | x | text");
  });

  it("フォームの値・絞り込みの形", () => {
    const defs = parseArticleFieldRows("items | 着用アイテム | products\nauthor | 書いた人 | article | staff\nheight | 身長 | number", blogs).defs;
    expect(fieldsFromForm(defs, { field_items: "Coat, knit、coat, ??", field_author: "amada", field_height: "158" })).toEqual({ items: ["coat", "knit"], author: "amada", height: "158" });
    expect(fieldContains(defs[0]!, "coat")).toEqual({ items: ["coat"] });
    expect(fieldContains(defs[1]!, "amada")).toEqual({ author: "amada" });
    expect(fieldContains(defs[2]!, "158")).toEqual({ height: 158 });
    expect(fieldContains(defs[2]!, "x")).toBeNull();
  });

  it("書式: ::: articles field:<key>=<値> と ::: products from=@field:<key>", () => {
    const a = parseArticlesLine('::: articles blog=styling field:author=@article limit=3')!;
    expect(a.field).toEqual({ key: "author", value: "@article" });
    expect(articlesLine(a)).toBe("::: articles blog=styling field:author=@article limit=3 layout=grid");
    expect(parseArticlesLine('::: articles blog=styling field:mood="きれい め"')!.field).toEqual({ key: "mood", value: "きれい め" });
    const p = parseProductsLine("::: products from=@field:items layout=scroll")!;
    expect(p.from).toBe("items");
    expect(productsLine(p)).toBe("::: products from=@field:items layout=scroll");
    expect(parseProductsLine("::: products from=items")).toBeNull();
  });
});

function setup(opts: { applied?: string[] } = {}) {
  const sb = new FakeSupabase(opts.applied ? { appliedMigrations: opts.applied } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { blog: true, pages: true } } });
  const org = String(sb.tables.shops.find((x) => x["id"] === shop.id)!["org_id"]);
  const store = crypto.randomUUID();
  sb.tables.stores.push({ id: store, org_id: org, name: "渋谷店", hours: {}, special_days: [], note: null, active: true, sort_order: 0 });
  sb.tables.shop_stores.push({ shop_id: shop.id, store_id: store, tryon: true, sort_order: 0 });
  for (const [slug, name] of [["coat", "コート"], ["knit", "ニット"]] as const) {
    const p = sb.addProduct(shop.id, { slug, name, published: true });
    sb.addSku(shop.id, String(p["id"]), { code: slug, name: "F", price_jpy: 1000, available: 1 });
  }
  const staff = sb.addBlog(shop.id, { id: crypto.randomUUID(), handle: "staff", title: "スタッフ", article_fields: [{ key: "height", label: "身長", type: "number" }, { key: "store", label: "店舗", type: "store" }] });
  const styling = sb.addBlog(shop.id, { id: crypto.randomUUID(), handle: "styling", title: "着こなし", article_fields: [{ key: "author", label: "書いた人", type: "article", blog: staff.id }, { key: "items", label: "着用アイテム", type: "product", multiple: true }] });
  sb.addArticle(shop.id, staff.id, { id: crypto.randomUUID(), handle: "amada", title: "天田", excerpt: "渋谷店のスタッフです", image_url: "/media/pages/x/amada.webp", fields: { height: 158, store } });
  sb.addArticle(shop.id, staff.id, { id: crypto.randomUUID(), handle: "kato", title: "加藤", fields: { height: 170 } });
  sb.addArticle(shop.id, styling.id, { id: crypto.randomUUID(), handle: "look-1", title: "コートの着こなし", body: "::: products from=@field:items", fields: { author: "amada", items: ["knit", "coat"] } });
  sb.addArticle(shop.id, styling.id, { id: crypto.randomUUID(), handle: "look-2", title: "加藤の着こなし", fields: { author: "kato", items: ["coat"] } });
  return { sb, shop, staff, styling, store, app: appWith(sb, {}, new MemoryStorage(`${BASE}/media`)), base: `/admin/shops/${shop.id}/modules/blog` };
}
const titles = (html: string) => [...html.matchAll(/font-weight:600">([^<]+)</g)].map((m) => m[1]);

describe("お店の画面", () => {
  it("記事の本文の from=@field:items はその記事の着用アイテムを書いた順に", async () => {
    const { app } = setup();
    const html = await (await new Browser(app, BASE).get("/my-shop/blogs/styling/look-1")).text();
    const at = html.indexOf('data-from="items"');
    expect([...html.slice(at).matchAll(/\/my-shop\/products\/(coat|knit)/g)].map((m) => m[1]).slice(0, 2)).toEqual(["knit", "coat"]);
  });

  it("記事のひな形: 書いた人のカード（写真・名前・紹介・リンク）と field の部品、スタッフの記事に「この人の着こなし」", async () => {
    const { sb, shop, staff, styling, app } = setup();
    const tplStyling = sb.addPage(shop.id, { id: crypto.randomUUID(), handle: "tpl-styling", title: "t", body: "::: current part=title\n\n::: current part=content\n\n::: current part=author\n\n::: current part=field:items" });
    const tplStaff = sb.addPage(shop.id, { id: crypto.randomUUID(), handle: "tpl-staff", title: "t", body: "::: current part=title\n\n::: current part=field:height\n\n::: current part=field:store\n\n::: articles blog=styling field:author=@article limit=6 layout=list" });
    (sb.tables.shops.find((x) => x["id"] === shop.id)!["settings"] as Record<string, unknown>)["page_layouts"] = { articles: { [styling.id]: tplStyling.id, [staff.id]: tplStaff.id } };
    const b = new Browser(app, BASE);
    const look = await (await b.get("/my-shop/blogs/styling/look-1")).text();
    expect(look).toContain('<div class="banto-author"><a class="banto-author__photo" href="/my-shop/blogs/staff/amada"><img src="');
    expect(look).toContain('<a class="banto-author__name" href="/my-shop/blogs/staff/amada">天田</a><p class="banto-author__summary">渋谷店のスタッフです</p>');
    expect(look).toContain('<ul class="banto-field banto-field--items banto-field-links"><li><a href="/my-shop/products/knit">ニット</a></li><li><a href="/my-shop/products/coat">コート</a></li></ul>');
    const amada = await (await b.get("/my-shop/blogs/staff/amada")).text();
    expect(amada).toContain('<span class="banto-field banto-field--height">158</span>');
    expect(amada).toContain('<span class="banto-field banto-field--store">渋谷店</span>');
    expect(titles(amada)).toEqual(["コートの着こなし"]);
    expect(titles(await (await b.get("/my-shop/blogs/staff/kato")).text())).toEqual(["加藤の着こなし"]);
  });

  it("商品のひな形の ::: articles field:items=@product はその商品を着た記事", async () => {
    const { sb, shop, app } = setup();
    const tpl = sb.addPage(shop.id, { id: crypto.randomUUID(), handle: "tpl-p", title: "t", body: "::: current part=title\n\n::: articles blog=styling field:items=@product limit=6 layout=list" });
    (sb.tables.shops.find((x) => x["id"] === shop.id)!["settings"] as Record<string, unknown>)["page_layouts"] = { product: tpl.id };
    const b = new Browser(app, BASE);
    expect(titles(await (await b.get("/my-shop/products/coat")).text()).sort()).toEqual(["コートの着こなし", "加藤の着こなし"].sort());
    expect(titles(await (await b.get("/my-shop/products/knit")).text())).toEqual(["コートの着こなし"]);
  });

  it("ヘッドレスの API: 記事に fields、ブログに article_fields", async () => {
    const { app } = setup();
    const b = new Browser(app, BASE);
    const list = (await (await b.get("/api/shops/my-shop/blogs/styling/articles")).json()) as { blog: { article_fields: { key: string }[] }; articles: { handle: string; fields: Record<string, unknown> }[] };
    expect(list.blog.article_fields.map((f) => f.key)).toEqual(["author", "items"]);
    expect(list.articles.find((a) => a.handle === "look-1")!.fields).toEqual({ author: "amada", items: ["knit", "coat"] });
  });
});

describe("管理画面", () => {
  it("ブログの設定で項目を決め、記事の編集で値を入れる。合わない値は保存しない", async () => {
    const { sb, staff, base, store } = setup();
    const app = appWith(sb, {}, new MemoryStorage(`${BASE}/media`));
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect(await (await owner.get(`${base}/${staff.id}/settings`)).text()).toContain("height | 身長 | number");
    let res = await owner.post(`${base}/${staff.id}/fields`, { rows: "height | 身長 | number\nstore | 店舗 | store\nmood | 雰囲気 | select | きれいめ/カジュアル" });
    expect(res.headers.get("location")).toContain("flash=fields_saved");
    expect((sb.tables.blogs.find((x) => x["id"] === staff.id)!["article_fields"] as unknown[]).length).toBe(3);
    res = await owner.post(`${base}/${staff.id}/fields`, { rows: "Bad | x | text" });
    expect(res.status).toBe(400);
    const amada = sb.tables.articles.find((a) => a["handle"] === "amada")!;
    const form = await (await owner.get(`${base}/${staff.id}/articles/${amada["id"]}`)).text();
    expect(form).toContain('name="field_height"');
    expect(form).toContain(`<option value="${store}" selected="">渋谷店</option>`);
    const save = { title: "天田", handle: "amada", body: "", tags: "", excerpt: "", author: "", published_at: "", image_url: "", seo_title: "", seo_description: "", template_suffix: "", action: "update", published: "on" };
    res = await owner.post(`${base}/${staff.id}/articles/${amada["id"]}`, { ...save, field_height: "160", field_store: store, field_mood: "カジュアル" });
    expect(res.status).toBe(302);
    expect(amada["fields"]).toEqual({ height: 160, store, mood: "カジュアル" });
    res = await owner.post(`${base}/${staff.id}/articles/${amada["id"]}`, { ...save, field_mood: "派手" });
    expect(res.status).toBe(400);
    expect(amada["fields"]).toEqual({ height: 160, store, mood: "カジュアル" });
  });

  it("0117 の前: 欄を出さず、記事の保存も fields を送らない", async () => {
    const { sb, staff, base } = setup({ applied: BUNDLED_MIGRATIONS.filter((v) => v !== "0117_article_fields") });
    delete sb.tables.blogs.find((x) => x["id"] === staff.id)!["article_fields"];
    const owner = await Browser.loggedIn(appWith(sb, {}, new MemoryStorage(`${BASE}/media`)), "owner@example.com", "password-123");
    expect(await (await owner.get(`${base}/${staff.id}/settings`)).text()).not.toContain('id="article-fields"');
    const amada = sb.tables.articles.find((a) => a["handle"] === "amada")!;
    expect(await (await owner.get(`${base}/${staff.id}/articles/${amada["id"]}`)).text()).not.toContain('name="field_height"');
  });
});
