import { beforeEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";

/** Section Rendering API（?sections=・?section_id=）と AJAX のカートの sections、カートの行の画像（docs/themes.md「カート」） */
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";

const files: Record<string, string> = {
  "layout/theme.liquid": `<html><head>{{ content_for_header }}</head><body>{% sections 'header-group' %}<main>{{ content_for_layout }}</main>{% section 'cart-drawer' %}</body></html>`,
  "templates/index.json": JSON.stringify({ sections: { hero: { type: "hero", settings: { heading: "ようこそ" } } }, order: ["hero"] }),
  "templates/cart.liquid": `<p class="cart">{{ cart.item_count }}</p>`,
  "sections/header-group.json": JSON.stringify({ type: "header", name: "ヘッダー", sections: { "cart-icon-bubble": { type: "cart-icon" } }, order: ["cart-icon-bubble"] }),
  "sections/hero.liquid": `<h1>{{ section.settings.heading }}</h1>{% schema %}{"name":"大","settings":[{"id":"heading","type":"text"}]}{% endschema %}`,
  "sections/cart-icon.liquid": `<span class="bubble">{{ cart.item_count }}</span>`,
  "sections/cart-drawer.liquid": `<div id="CartDrawer">{% for item in cart.items %}<div class="item"><img src="{{ item.image | image_url: width: 100 }}">{{ item.product_title }}×{{ item.quantity }}</div>{% endfor %}{{ cart.total_price | money }}</div>`,
};

function setup() {
  forgetThemes();
  const sb = new FakeSupabase();
  sb.sitePlan = "paid";
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "s", name: "引き出しのお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
  row["domain"] = "shop.example.jp";
  row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
  const storage = new MemoryStorage(`${BASE}/media`);
  void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files, assets: [] })).buffer as ArrayBuffer, "application/json");
  const p = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const red = sb.addSku(shop.id, p.id, { code: "TEE-R", name: "赤", price_jpy: 1000, available: 5, options: { color: "赤" } });
  sb.tables.product_images.push(
    { id: "img-all", shop_id: shop.id, product_id: p.id, storage_key: `products/${p.id}/all.webp`, thumb_key: null, width: 800, height: 800, sort_order: 0, options: {}, created_at: "" },
    { id: "img-red", shop_id: shop.id, product_id: p.id, storage_key: `products/${p.id}/red.webp`, thumb_key: null, width: 800, height: 800, sort_order: 1, options: { color: "赤" }, created_at: "" },
  );
  const app = appWith(sb, {}, storage, new FakeStripe());
  return { sb, red, b: new Browser(app, DOMAIN) };
}

describe("Section Rendering API", () => {
  beforeEach(forgetThemes);

  it("?sections= はテンプレート・まとまりの id とセクションのファイルの名前で描き、JSON で返す。無い id は null。包みは shopify-section", async () => {
    const { b } = setup();
    const res = await b.get("/?sections=hero,cart-icon-bubble,cart-drawer,nope");
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const json = (await res.json()) as Record<string, string | null>;
    expect(json["hero"]).toBe('<div id="shopify-section-hero" class="shopify-section"><h1>ようこそ</h1></div>');
    expect(json["cart-icon-bubble"]).toContain('<span class="bubble">0</span>');
    expect(json["cart-drawer"]).toContain('<div id="CartDrawer">');
    expect(json["nope"]).toBeNull();
    const one = await b.get("/?section_id=hero");
    expect(await one.text()).toBe('<div id="shopify-section-hero" class="shopify-section"><h1>ようこそ</h1></div>');
    expect((await b.get("/?section_id=nope")).status).toBe(404);
    // 6 個目からは描かない（Shopify と同じ 5 個まで）
    expect(Object.keys((await (await b.get("/?sections=hero,a,b,c,d,cart-drawer")).json()) as object)).toHaveLength(5);
  });

  it("AJAX のカートに sections を付けると、変えた後のカートで描いたセクションを返す。行には SKU に合う画像", async () => {
    const { b, red } = setup();
    const add = (await (await b.postJson("/cart/add.js", { id: red.id, quantity: 2, sections: "cart-drawer,cart-icon-bubble" })).json()) as { quantity: number; image: { src: string } | null; sections: Record<string, string> };
    expect(add.quantity).toBe(2);
    expect(add.image?.src).toMatch(/red\.webp$/);
    expect(add.sections["cart-icon-bubble"]).toContain('<span class="bubble">2</span>');
    expect(add.sections["cart-drawer"]).toContain("Tシャツ×2");
    expect(add.sections["cart-drawer"]).toMatch(/red\.webp/);
    const ch = (await (await b.postJson("/cart/change.js", { id: red.id, quantity: 1, sections: ["cart-icon-bubble"] })).json()) as { item_count: number; sections: Record<string, string> };
    expect(ch.item_count).toBe(1);
    expect(ch.sections["cart-icon-bubble"]).toContain('<span class="bubble">1</span>');
    // sections を付けなければ今までどおり
    expect("sections" in ((await (await b.get("/cart.js")).json()) as object)).toBe(false);
  });
});
