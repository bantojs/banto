import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { listFilterOf, vendorParamOf } from "../src/storefront/list-filter";
import { productsUrl } from "../src/storefront/urls";
import { forgetThemes } from "../src/themes/liquid/cache";

/** 一覧のブランドの絞り込み（?filter.p.vendor=、件数は 0162）。DB の件数は test/db/vendor-facets.test.ts */

const VERSION = "11111111-2222-4333-8444-555555555556";

function setup(theme?: Record<string, string>) {
  if (theme) forgetThemes();
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const add = (slug: string, brand: string | null, tags: string[] = []) => {
    const p = sb.addProduct(shop.id, { id: crypto.randomUUID(), slug, name: slug.toUpperCase(), published: true, brand, tags });
    sb.addSku(shop.id, p.id, { code: slug, price_jpy: 1000, available: 1 });
  };
  add("shirt", "ACME", ["夏"]);
  add("cap", "ACME");
  add("bag", "Beta & Co", ["夏"]);
  add("pin", null);
  const storage = new MemoryStorage(`${BASE}/media`);
  if (theme) {
    sb.sitePlan = "paid";
    const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
    row["domain"] = "shop.example.jp";
    row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
    void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files: theme, assets: [] })).buffer as ArrayBuffer, "application/json");
  }
  return { sb, shop, app: appWith(sb, {}, storage) };
}
const api = async (app: ReturnType<typeof setup>["app"], qs: string) => {
  const r = await app.request(`${BASE}/api/shops/my-shop/products${qs}`);
  return { status: r.status, body: (await r.json()) as { products?: { slug: string }[]; brands?: { brand: string; count: number }[] } };
};
const slugs = (b: { products?: { slug: string }[] }) => (b.products ?? []).map((p) => p.slug).sort();

describe("読み取りと URL", () => {
  it("?filter.p.vendor= は最初の空でない値（前後の空白を除く）。100 文字を超えたら絞らない。URL は Shopify と同じ名前", () => {
    expect(vendorParamOf(["", "  ACME ", "Beta"])).toBe("ACME");
    expect(vendorParamOf(["a".repeat(101)])).toBeUndefined();
    expect(vendorParamOf(undefined)).toBeUndefined();
    expect(listFilterOf({ "filter.p.vendor": ["ACME"], tag: ["夏"] })).toEqual({ tags: ["夏"], vendor: "ACME" });
    expect(productsUrl("/s", { tags: ["夏"], priceMax: 5000, vendor: "Beta & Co", q: "abc" })).toBe("/s/products?tag=%E5%A4%8F&filter.v.price.lte=5000&filter.p.vendor=Beta+%26+Co&q=abc");
  });
});

describe("お店の画面", () => {
  it("ブランドで絞る。札はブランドと件数（多い順）、押すとそのブランドだけ、選んでいる札で外す（タグは保つ）。検索エンジンに載せない", async () => {
    const s = setup();
    const b = new Browser(s.app, BASE);
    const html = await (await b.get("/my-shop/products?filter.p.vendor=ACME&tag=%E5%A4%8F")).text();
    expect(html).toContain("SHIRT");
    expect(html).not.toContain("CAP");
    expect(html).not.toContain("BAG");
    expect(html).toContain("noindex");
    expect(html).toContain('class="tags vendor-filter"');
    expect(html).toContain("ブランド:");
    expect(html).toMatch(/href="\/my-shop\/products\?tag=%E5%A4%8F"[^>]*class="active" aria-pressed="true">ACME <span class="muted">\(2\)/);
    expect(html).toContain('href="/my-shop/products?tag=%E5%A4%8F&amp;filter.p.vendor=Beta+%26+Co"');
    // タグの札もブランドを保つ
    expect(html).toContain('href="/my-shop/products?filter.p.vendor=ACME"');
  });

  it("ブランドだけで絞っていれば短い検索の語も探す", async () => {
    const s = setup();
    const html = await (await new Browser(s.app, BASE).get("/my-shop/products?filter.p.vendor=ACME&q=ca")).text();
    expect(html).toContain("CAP");
    expect(html).not.toContain("SHIRT");
    expect(html).not.toContain("3 文字以上の言葉を含めて探してください。");
  });

  it("0162 を当てる前も絞れる（p_brand は 0058 から）。札は出さない", async () => {
    const s = setup();
    s.sb.appliedMigrations = s.sb.appliedMigrations.filter((m) => m !== "0162_vendor_facets");
    const html = await (await new Browser(s.app, BASE).get("/my-shop/products?filter.p.vendor=ACME")).text();
    expect(html).toContain("CAP");
    expect(html).not.toContain("BAG");
    // 選んでいるブランドは外せるように出す（件数は 0）
    expect(html).toMatch(/class="active" aria-pressed="true">ACME <span class="muted">\(0\)/);
    const plain = await (await new Browser(s.app, BASE).get("/my-shop/products")).text();
    expect(plain).not.toContain("vendor-filter");
  });
});

describe("公開 API", () => {
  it("brands（件数）と、brand と同じ filter.p.vendor", async () => {
    const s = setup();
    const r = await api(s.app, "?filter.p.vendor=Beta%20%26%20Co");
    expect(slugs(r.body)).toEqual(["bag"]);
    expect(r.body.brands).toEqual([{ brand: "ACME", count: 2 }, { brand: "Beta & Co", count: 1 }]);
    expect(slugs((await api(s.app, "?brand=ACME&filter.p.vendor=Beta%20%26%20Co")).body)).toEqual(["cap", "shirt"]);
  });
});

describe("テーマ（Liquid）", () => {
  it("collection.filters にブランドの list（1 つだけ選ぶ: 足すと置き換え、外すとほかの絞り込みは保つ）と collection.all_vendors", async () => {
    const s = setup({
      "layout/theme.liquid": "<html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>",
      "templates/index.liquid": "top",
      "templates/collection.liquid": `{{ collection.all_vendors | join: "|" }}{% for f in collection.filters %}{% if f.type == 'list' %}<div class="f" data-p="{{ f.param_name }}">{{ f.label }}{% for v in f.values %}<a class="v{% if v.active %} on{% endif %}" data-add="{{ v.url_to_add }}" data-remove="{{ v.url_to_remove }}">{{ v.label }}({{ v.count }})</a>{% endfor %}</div>{% endif %}{% endfor %}`,
    });
    const html = await (await new Browser(s.app, "https://shop.example.jp").get("/products?filter.p.vendor=ACME&filter.v.price.lte=5000")).text();
    expect(html).toContain("ACME|Beta &amp; Co");
    expect(html).toContain('<div class="f" data-p="filter.p.vendor">ブランド');
    expect(html).toMatch(/<a class="v on" data-add="[^"]*" data-remove="\/products\?filter\.v\.price\.lte=5000">ACME\(2\)<\/a>/);
    expect(html).toContain('data-add="/products?filter.v.price.lte=5000&amp;filter.p.vendor=Beta+%26+Co"');
  });
});
