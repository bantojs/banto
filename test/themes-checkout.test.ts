import { beforeEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, MemoryStorage, appWith, quoteFrom } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";
import { checkThemeBundle } from "../src/themes/liquid/bundle";
import { extendShopify } from "../src/themes/liquid/shopify";
import { CHECKOUT_CSP } from "../src/routes/storefront/liquid";

/** レジ（配送先・最終確認）を Liquid のテーマで描く（テーマの段階 3 の C、人間の決定 2026-10-28、docs/themes.md「レジ」） */
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";

const base: Record<string, string> = {
  "layout/theme.liquid": `<html><head>{{ content_for_header }}</head><body><main>{{ content_for_layout }}</main></body></html>`,
  "templates/index.liquid": "<h1>top</h1>",
  "templates/checkout.liquid": `<h1 class="co">お届け先</h1><p class="sub">{{ checkout.subtotal_price | money }}</p>{% if checkout.error %}<p class="err">{{ checkout.error }}</p>{% endif %}{% form 'checkout_address' %}<input name="customer_name" value="{{ checkout.values.customer_name }}"><select name="state">{% for p in checkout.prefectures %}<option>{{ p.name }}</option>{% endfor %}</select><button>確認へ</button>{% endform %}`,
  "templates/checkout_confirm.liquid": `<h1 class="cf">ご注文の確認</h1><aside class="sum">{{ checkout.confirmation.total_price | money }}</aside>{% banto_confirmation %}`,
};

function setup(files: Record<string, string> = base) {
  forgetThemes();
  const sb = new FakeSupabase();
  sb.sitePlan = "paid";
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "s", name: "レジのお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", stripe_account_id: "acct_connected" });
  const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
  row["domain"] = "shop.example.jp";
  row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
  const p = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, p.id, { code: "TEE-S", name: "S", price_jpy: 3000, available: 5 });
  const storage = new MemoryStorage(`${BASE}/media`);
  void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files, assets: [] })).buffer as ArrayBuffer, "application/json");
  const stripe = new FakeStripe();
  const app = appWith(sb, {}, storage, stripe);
  return { sb, stripe, sku, b: new Browser(app, DOMAIN) };
}

describe("レジを Liquid のテーマで描く", () => {
  beforeEach(forgetThemes);

  it("配送先: templates/checkout。送り先は決済手段の確認、CSP で外のスクリプトを止める。誤りはテーマの画面で出す", async () => {
    const { b, sku } = setup();
    await b.post("/cart/add", { id: sku.id, quantity: "1" });
    const res = await b.post("/checkout", { provider: "stripe" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(CHECKOUT_CSP);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const html = await res.text();
    expect(html).toContain('<h1 class="co">お届け先</h1><p class="sub">¥3,000</p>');
    expect(html).toContain('<form method="post" action="/checkout/stripe" accept-charset="UTF-8"><input type="hidden" name="form_type" value="checkout_address">');
    expect(html).toContain("<option>北海道</option>");
    const bad = await b.post("/checkout/stripe", { ...ADDRESS, customer_email: "not-an-email" });
    expect(bad.status).toBe(400);
    const badHtml = await bad.text();
    expect(badHtml).toContain('<p class="err">');
    expect(badHtml).toContain(`value="${ADDRESS.customer_name}"`);
  });

  it("最終確認: テーマの外側の中に Banto の表示（特商法の項目・確定のボタン）。確定は今までどおり決済ページへ", async () => {
    const { b, sku, stripe } = setup();
    await b.post("/cart/add", { id: sku.id, quantity: "2" });
    const review = await b.post("/checkout/stripe", ADDRESS);
    expect(review.status).toBe(200);
    expect(review.headers.get("content-security-policy")).toBe(CHECKOUT_CSP);
    const html = await review.text();
    expect(html).toContain('<h1 class="cf">ご注文の確認</h1><aside class="sum">');
    expect(html).toContain('<div class="banto-confirmation">');
    expect(html).toContain("特定商取引法に基づく表記");
    expect(html).not.toContain("<script>");
    const placed = await b.post("/checkout/stripe", { quote: quoteFrom(html) });
    expect([302, 303]).toContain(placed.status);
    expect(placed.headers.get("location")).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(stripe.sessions.size).toBe(1);
  });

  it("{% banto_confirmation %} を描かなかった最終確認画面は使わず、既定のテーマで描く。取り込みでも断る", async () => {
    const files = { ...base, "templates/checkout_confirm.liquid": `<h1 class="cf">確認</h1>{% if false %}{% banto_confirmation %}{% endif %}` };
    const { b, sku } = setup(files);
    await b.post("/cart/add", { id: sku.id, quantity: "1" });
    const html = await (await b.post("/checkout/stripe", ADDRESS)).text();
    expect(html).not.toContain('<h1 class="cf">');
    expect(html).toContain('<div class="banto-confirmation">');
    const missing = checkThemeBundle({ format: 1, files: { ...base, "templates/checkout_confirm.liquid": "<h1>確認</h1>" }, assets: [] }, { extend: extendShopify });
    expect(missing.errors).toContain("templates/checkout_confirm: {% banto_confirmation %} is required");
    expect(checkThemeBundle({ format: 1, files: base, assets: [] }, { extend: extendShopify }).ok).toBe(true);
  });

  it("テーマにレジのテンプレートが無ければ既定のテーマ（CSP も付けない）", async () => {
    const files = Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith("templates/checkout")));
    const { b, sku } = setup(files);
    await b.post("/cart/add", { id: sku.id, quantity: "1" });
    const res = await b.post("/checkout", { provider: "stripe" });
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(await res.text()).toContain('name="postal_code"');
  });
});
