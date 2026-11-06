import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";
import { cardAttributes, formatFieldDefinitions, parseFieldDefinitions } from "../src/products/fields";

/** 一覧のカードに商品の独自項目を出す（0121、定義で card を付けた公開の項目だけ。メンテナの決定 2026-11-06） */
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";
afterEach(() => forgetThemes());

const FIELDS = [
  { key: "material", label: "素材", type: "text", public: true, card: true },
  { key: "logo", label: "ブランド", type: "image", public: true, card: true },
  { key: "care", label: "お手入れ", type: "text", public: true },
  { key: "cost", label: "原価", type: "number", public: false, card: true },
];

function setup(liquid?: Record<string, string>) {
  forgetThemes();
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "カードの店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { product_fields: FIELDS, modules: { pages: true } } });
  const p = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true, attributes: { material: "綿 <100%>", logo: "/media/fields/x/logo.webp", care: "手洗い", cost: 800 } });
  sb.addSku(shop.id, p.id, { code: "tee", price_jpy: 3000, available: 3 });
  const storage = new MemoryStorage(`${BASE}/media`);
  if (liquid) {
    sb.sitePlan = "paid";
    const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
    row["domain"] = "shop.example.jp";
    row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
    void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files: liquid, assets: [] })).buffer as ArrayBuffer, "application/json");
  }
  const app = appWith(sb, {}, storage);
  return { sb, shop, app, b: new Browser(app, liquid ? DOMAIN : BASE) };
}

describe("定義の印", () => {
  it("「| card」で一覧のカードにも出す。非公開の項目には付かない", () => {
    const defs = parseFieldDefinitions("material | 素材 | text | | card\ncare | お手入れ | text\ncost | 原価 | number | | private card");
    expect(defs.map((f) => [f.key, f.public, f.card ?? false])).toEqual([["material", true, true], ["care", true, false], ["cost", false, false]]);
    expect(parseFieldDefinitions(formatFieldDefinitions(defs))).toEqual(defs);
    expect(cardAttributes(defs, { material: "綿", care: "手洗い", cost: 1 })).toEqual([{ key: "material", label: "素材", type: "text", value: "綿" }]);
  });
});

describe("一覧", () => {
  it("既定のテーマのカードに出す（文字・画像。card の無い項目と非公開は出さない）", async () => {
    const { b } = setup();
    const html = await (await b.get("/my-shop/products")).text();
    expect(html).toContain('<li class="card-field card-field--material"><span class="muted">素材</span> 綿 &lt;100%&gt;</li>');
    expect(html).toContain('<li class="card-field card-field--logo"><img src="/media/fields/x/logo.webp" alt="ブランド" loading="lazy"/></li>');
    expect(html).not.toContain("お手入れ");
    expect(html).not.toContain("原価");
  });

  it("ヘッドレスの一覧の attributes（表示名つき、card の項目だけ）", async () => {
    const { app } = setup();
    const res = (await (await app.request(`${BASE}/api/shops/my-shop/products`)).json()) as { products: { attributes: unknown[] }[] };
    expect(res.products[0]!.attributes).toEqual([
      { key: "material", label: "素材", type: "text", value: "綿 <100%>" },
      { key: "logo", label: "ブランド", type: "image", value: "/media/fields/x/logo.webp" },
    ]);
  });

  it("Liquid: 一覧の product.fields", async () => {
    const { b } = setup({
      "layout/theme.liquid": "<html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>",
      "templates/index.liquid": "<h1>top</h1>",
      "templates/collection.liquid": `{% for p in collection.products %}<p class="f">{{ p.fields.material }}|{{ p.fields.care }}|{{ p.fields.cost }}</p>{% endfor %}`,
    });
    expect(await (await b.get("/products")).text()).toContain('<p class="f">綿 &lt;100%&gt;||</p>');
  });

  it("本文の ::: products のカードにも出る", async () => {
    const { sb, shop, b } = setup();
    sb.addPage(shop.id, { id: crypto.randomUUID(), handle: "pick", title: "P", body: "::: products slugs=tee", published: true });
    expect(await (await b.get("/my-shop/pages/pick")).text()).toContain("card-field--material");
  });
});
