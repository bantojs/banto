import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { markdownToHtml } from "../src/pages/markdown";
import { parseShopBlock, shopBlockLine } from "../src/pages/shop-blocks";
import { parseProductsLine, productsLine } from "../src/pages/blocks";
import { productFieldsLiquid } from "../src/themes/liquid/objects";

/** 本文のブロックの足し（メンテナの決定 2026-11-05、テーマ作りからの相談）: 目次・店舗・似た商品・商品の独自項目 */

describe("目次 ::: toc", () => {
  const md = ["::: toc title=\"この記事の目次\"", "", "# はじめに", "", "本文", "", "### 小さな話", "", "## 着こなし", "", "### 冬", "", "### 春 <b>x</b>", "", "#### 深い見出し"].join("\n");

  it("見出しに id を振り、見出しと小見出しを入れ子で並べる（深い見出しは入れない）", () => {
    const html = markdownToHtml(md, {});
    expect(html).toContain('<h2 id="h-1">はじめに</h2>');
    expect(html).toContain('<h3 id="h-2">小さな話</h3>');
    expect(html).toContain('<nav class="banto-toc" aria-label="この記事の目次"><p class="banto-toc__title">この記事の目次</p><ol><li><a href="#h-1">はじめに</a><ol><li><a href="#h-2">小さな話</a></li></ol></li><li><a href="#h-3">着こなし</a><ol><li><a href="#h-4">冬</a></li><li><a href="#h-5">春 &lt;b&gt;x&lt;/b&gt;</a></li></ol></li></ol></nav>');
    expect(html).not.toContain('href="#h-6"');
  });

  it("levels=2 は見出しだけ。見出しが無ければ何も出さない。編集の画面は id を振らない", () => {
    const html = markdownToHtml(md.replace("::: toc", "::: toc levels=2"), {});
    expect(html).toContain('<ol><li><a href="#h-1">はじめに</a></li><li><a href="#h-3">着こなし</a></li></ol>');
    expect(markdownToHtml("::: toc\n\n本文だけ", {})).not.toContain('<nav class="banto-toc"');
    expect(markdownToHtml(md, { editor: true })).not.toContain('id="h-1"');
    expect(shopBlockLine(parseShopBlock('::: toc levels=2 title="目次"')!)).toBe('::: toc levels=2 title="目次"');
    expect(shopBlockLine(parseShopBlock("::: toc levels=9")!)).toBe("::: toc");
  });
});

function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c",
    settings: { modules: { pages: true, store_tryon: true }, product_fields: [{ key: "staff_note", label: "スタッフのひとこと", type: "textarea" }, { key: "cost", label: "原価", type: "number", public: false }] },
  });
  const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
  const org = String(row["org_id"]);
  const open = { "0": [["10:00", "20:00"]], "1": [["10:00", "20:00"]], "2": [["10:00", "20:00"]], "3": [["10:00", "20:00"]], "4": [["10:00", "20:00"]], "5": [["10:00", "20:00"]], "6": [["10:00", "20:00"]] };
  sb.tables.stores.push({ id: "st-1", org_id: org, name: "渋谷店", postal_code: "150-0001", address: "東京都渋谷区1-1", phone: "03-0000-0000", hours: open, special_days: [], note: null, active: true, sort_order: 0 });
  sb.tables.stores.push({ id: "st-2", org_id: org, name: "倉庫", hours: {}, special_days: [], note: null, active: true, sort_order: 1 });
  sb.tables.shop_stores.push({ shop_id: shop.id, store_id: "st-1", tryon: true, sort_order: 0 });
  sb.tables.shop_stores.push({ shop_id: shop.id, store_id: "st-2", tryon: false, sort_order: 1 });
  const tops = { id: crypto.randomUUID(), shop_id: shop.id, slug: "tops", name: "トップス", parent_id: null, sort_order: 0 };
  const bags = { id: crypto.randomUUID(), shop_id: shop.id, slug: "bags", name: "バッグ", parent_id: null, sort_order: 1 };
  sb.tables.categories.push(tops, bags);
  const add = (slug: string, name: string, cat: string, tags: string[], extra: Record<string, unknown> = {}) => {
    const p = sb.addProduct(shop.id, { slug, name, published: true, category_id: cat, tags, ...extra });
    sb.addSku(shop.id, String(p["id"]), { code: slug, name: "F", price_jpy: 1000, available: 1 });
    return p;
  };
  add("coat", "コート", tops.id, ["冬"], { attributes: { staff_note: "軽くて暖かい\n2 行目", cost: 500 } });
  add("knit", "ニット", tops.id, []);
  add("tote", "トート", bags.id, ["冬"]);
  add("cap", "キャップ", bags.id, []);
  return { sb, shop, app: appWith(sb, {}, new MemoryStorage(`${BASE}/media`)) };
}

describe("店舗 ::: stores", () => {
  it("ショップで使う実店舗を並べ、tryon=1 は試着を受ける店舗だけ", async () => {
    const { sb, shop, app } = setup();
    sb.addPage(shop.id, { id: crypto.randomUUID(), handle: "access", title: "店舗", body: "::: stores layout=grid\n\n::: stores tryon=1", published: true });
    const html = await (await new Browser(app, BASE).get("/my-shop/pages/access")).text();
    expect(html).toContain('<ul class="banto-stores banto-stores--grid">');
    expect(html.match(/banto-store__name">渋谷店/g)).toHaveLength(2);
    expect(html.match(/banto-store__name">倉庫/g)).toHaveLength(1);
    expect(html).toContain('<a href="tel:0300000000">03-0000-0000</a>');
    expect(html).toContain("〒150-0001 東京都渋谷区1-1");
    expect(html).toContain('class="banto-store__today"');
  });
});

describe("似た商品 ::: products related=@product", () => {
  it("書式を読み書きする（カテゴリー・タグは持たない）", () => {
    const b = parseProductsLine("::: products related=@product category=x tag=y limit=4");
    expect(b).toMatchObject({ related: true, category: null, tag: null, limit: 4 });
    expect(productsLine(b!)).toBe("::: products related=@product limit=4 layout=grid sort=new");
    expect(parseProductsLine("::: products related=coat")).toBeNull();
  });

  it("商品詳細のひな形では同じ主カテゴリー → 同じタグの商品（その商品は除く）。ふつうのページでは何も出ない", async () => {
    const { sb, shop, app } = setup();
    const tpl = sb.addPage(shop.id, { id: crypto.randomUUID(), handle: "product-tpl", title: "ひな形", body: "::: current part=title\n\n::: products related=@product limit=2" });
    (sb.tables.shops.find((x) => x["id"] === shop.id)!["settings"] as Record<string, unknown>)["page_layouts"] = { product: tpl.id };
    sb.addPage(shop.id, { id: crypto.randomUUID(), handle: "plain", title: "P", body: "::: products related=@product", published: true });
    const b = new Browser(app, BASE);
    const html = await (await b.get("/my-shop/products/coat")).text();
    const names = [...html.slice(html.indexOf('data-related="1"')).matchAll(/\/my-shop\/products\/(knit|tote|cap|coat)/g)].map((m) => m[1]);
    expect(new Set(names)).toEqual(new Set(["knit", "tote"]));
    expect(await (await b.get("/my-shop/pages/plain")).text()).not.toContain("/my-shop/products/knit");
  });
});

describe("商品の独自項目", () => {
  it("::: product show=…,field:<key> は公開の項目だけ（非公開・知らない項目は出さない）", async () => {
    const { sb, shop, app } = setup();
    sb.addPage(shop.id, { id: crypto.randomUUID(), handle: "pick", title: "P", body: "::: product slug=coat show=name,field:staff_note,field:cost,field:nope", published: true });
    const html = await (await new Browser(app, BASE).get("/my-shop/pages/pick")).text();
    expect(html).toContain('<div class="banto-product__field banto-product__field--staff_note"><span class="banto-product__field-label">スタッフのひとこと</span><span class="banto-product__field-value">軽くて暖かい<br>2 行目</span></div>');
    expect(html).not.toContain("原価");
    expect(parseShopBlock("::: product slug=coat show=name,field:1x")?.attrs["show"]).toBeUndefined();
  });

  it("Liquid の product.fields と field_list（公開の項目で値のあるものだけ）", () => {
    const fields = [{ key: "staff_note", label: "ひとこと", type: "text" as const, public: true }, { key: "cost", label: "原価", type: "number" as const, public: false }, { key: "empty", label: "空", type: "text" as const, public: true }];
    expect(productFieldsLiquid({ shopPath: "", mediaBaseUrl: "", productFields: fields }, { staff_note: "軽い", cost: 500, empty: "" })).toEqual({ fields: { staff_note: "軽い" }, field_list: [{ key: "staff_note", label: "ひとこと", type: "text", value: "軽い" }] });
  });
});

describe("見たままの編集 → 書式", () => {
  it("目次・店舗・商品の独自項目のお店のブロックと、似た商品のブロックを書き戻す", async () => {
    const { pageEditorClient } = await import("../src/content/editor-client");
    const { toMarkdown } = pageEditorClient();
    type N = { nodeType: number; nodeName: string; childNodes: N[]; textContent: string; getAttribute?: (k: string) => string | null };
    const el = (name: string, attrs: Record<string, string>): N => ({ nodeType: 1, nodeName: name, childNodes: [], textContent: "", getAttribute: (k) => attrs[k] ?? null });
    const shop = (kind: string, attrs: Record<string, string>) => el("DIV", { "data-banto-block": "shop", "data-kind": kind, "data-attrs": JSON.stringify(attrs) });
    const root: N = { nodeType: 1, nodeName: "DIV", textContent: "", childNodes: [
      shop("toc", { levels: "3", title: "目次" }),
      shop("stores", { tryon: "1", layout: "grid" }),
      shop("product", { slug: "coat", show: "name,field:staff_note" }),
      el("DIV", { "data-banto-block": "products", "data-related": "1", "data-category": "tops", "data-tag": "x", "data-limit": "4", "data-layout": "grid", "data-sort": "new" }),
    ] };
    expect(toMarkdown(root as never)).toBe(['::: toc title="目次"', "", "::: stores tryon=1 layout=grid", "", "::: product slug=coat show=name,field:staff_note", "", "::: products related=@product limit=4 layout=grid sort=new"].join("\n"));
  });
});
