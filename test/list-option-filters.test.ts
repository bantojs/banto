import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { LIST_OPTIONS_MIGRATION } from "../src/storefront/list-filter";
import { productsUrl } from "../src/storefront/urls";
import { forgetThemes } from "../src/themes/liquid/cache";

/** 一覧の絞り込みの段 2（SKU の選択肢で、在庫のあるものに絞る、0153）。DB の判定は test/db/product-option-stock.test.ts */

const VERSION = "11111111-2222-4333-8444-555555555555";

function setup(theme?: Record<string, string>) {
  if (theme) forgetThemes();
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  sb.tables.shops.find((x) => x["id"] === shop.id)!["option_names"] = { color: "カラー", size: "サイズ" };
  const add = (slug: string, variants: { code: string; options: Record<string, string>; available: number }[]) => {
    const p = sb.addProduct(shop.id, { id: crypto.randomUUID(), slug, name: slug.toUpperCase(), published: true });
    for (const v of variants) sb.addSku(shop.id, p.id, { code: v.code, price_jpy: 1000, available: v.available, options: v.options });
  };
  add("shirt", [{ code: "S-R-S", options: { color: "red", size: "S" }, available: 0 }, { code: "S-R-M", options: { color: "red", size: "M" }, available: 2 }, { code: "S-B-S", options: { color: "blue", size: "S" }, available: 1 }]);
  add("cap", [{ code: "C-R", options: { color: "red" }, available: 0 }]);
  add("bag", [{ code: "B-B", options: { color: "blue" }, available: 3 }]);
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
  return { status: r.status, body: (await r.json()) as { products?: { slug: string }[]; options?: { key: string; value: string; count: number }[]; error?: string; field?: string } };
};
const slugs = (b: { products?: { slug: string }[] }) => (b.products ?? []).map((p) => p.slug).sort();

describe("URL", () => {
  it("?filter.v.option.<key>= をくり返す（Shopify と同じ名前）", () => {
    expect(productsUrl("/s", { options: { color: ["red", "blue"], size: ["M"] } })).toBe("/s/products?filter.v.option.color=red&filter.v.option.color=blue&filter.v.option.size=M");
  });
});

describe("お店の画面", () => {
  it("在庫のある選択肢だけで絞る。札は鍵ごと（表示名・件数）、押すと足し、選んでいる札で外す。組み合わせは検索エンジンに載せない", async () => {
    const s = setup();
    const b = new Browser(s.app, BASE);
    const html = await (await b.get("/my-shop/products?filter.v.option.color=red")).text();
    expect(html).toContain("SHIRT");
    expect(html).not.toContain("CAP");
    expect(html).not.toContain("BAG");
    expect(html).toContain("noindex");
    expect(html).toContain('data-option="color"');
    expect(html).toContain("カラー:");
    // red は選んでいる（外すリンク）、blue は足すリンク
    expect(html).toMatch(/href="\/my-shop\/products"[^>]*class="active" aria-pressed="true">red/);
    expect(html).toContain('href="/my-shop/products?filter.v.option.color=red&amp;filter.v.option.color=blue"');
  });

  it("0153 を当てる前は選択肢で絞らず、札を出さない（お店の画面は止めない）", async () => {
    const s = setup();
    s.sb.appliedMigrations = s.sb.appliedMigrations.filter((m) => m !== LIST_OPTIONS_MIGRATION);
    const res = await new Browser(s.app, BASE).get("/my-shop/products?filter.v.option.color=red");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("BAG");
    expect(html).not.toContain('data-option="color"');
  });
});

describe("公開 API", () => {
  it("filter.v.option.<key>・件数の options。鍵が多すぎ・読めない鍵は 400、0153 の前は 409", async () => {
    const s = setup();
    const r = await api(s.app, "?filter.v.option.color=blue&filter.v.option.size=S");
    expect(slugs(r.body)).toEqual(["shirt"]);
    expect(r.body.options).toEqual(expect.arrayContaining([{ key: "color", value: "blue", count: 2 }, { key: "color", value: "red", count: 1 }]));
    expect(await api(s.app, "?filter.v.option.a=1&filter.v.option.b=1&filter.v.option.c=1&filter.v.option.d=1")).toMatchObject({ status: 400, body: { field: "filter.v.option" } });
    expect(await api(s.app, "?filter.v.option.Bad!=1")).toMatchObject({ status: 400 });
    const old = setup();
    old.sb.appliedMigrations = old.sb.appliedMigrations.filter((m) => m !== LIST_OPTIONS_MIGRATION);
    expect(await api(old.app, "?filter.v.option.color=red")).toMatchObject({ status: 409, body: { error: "migration_required" } });
  });
});

describe("テーマ（Liquid）", () => {
  it("collection.filters に選択肢ごとの list（表示名・件数・足す / 外す URL。ほかの鍵と価格は保つ）", async () => {
    const s = setup({
      "layout/theme.liquid": "<html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>",
      "templates/index.liquid": "top",
      "templates/collection.liquid": `{% for f in collection.filters %}{% if f.type == 'list' %}<div class="f" data-p="{{ f.param_name }}">{{ f.label }}{% for v in f.values %}<a class="v{% if v.active %} on{% endif %}" data-add="{{ v.url_to_add }}" data-remove="{{ v.url_to_remove }}">{{ v.label }}({{ v.count }})</a>{% endfor %}</div>{% endif %}{% endfor %}`,
    });
    const html = await (await new Browser(s.app, "https://shop.example.jp").get("/products?filter.v.option.color=blue&filter.v.option.size=S&filter.v.price.lte=5000")).text();
    expect(html).toContain('<div class="f" data-p="filter.v.option.color">カラー');
    expect(html).toContain('<div class="f" data-p="filter.v.option.size">サイズ');
    // blue は選んでいる: 外すと size と価格は残る
    expect(html).toMatch(/<a class="v on" data-add="[^"]*" data-remove="\/products\?filter\.v\.price\.lte=5000&amp;filter\.v\.option\.size=S">blue\(2\)<\/a>/);
    // red を足すと color は blue と red
    expect(html).toContain('data-add="/products?filter.v.price.lte=5000&amp;filter.v.option.color=blue&amp;filter.v.option.color=red&amp;filter.v.option.size=S"');
  });
});
