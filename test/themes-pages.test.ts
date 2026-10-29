import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, MemoryStorage, appWith, memberLogin, memberMail } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";
import { checkThemeBundle } from "../src/themes/liquid/bundle";
import { extendShopify } from "../src/themes/liquid/shopify";
import { sealThemePreview } from "../src/themes/liquid/preview";
import { CHECKOUT_CSP } from "../src/routes/storefront/liquid";

/** 法務のページ（templates/page）・完了画面（templates/checkout_done）・会員ページ（templates/customers/account） */
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";

const files: Record<string, string> = {
  "layout/theme.liquid": `<html><head>{{ content_for_header }}</head><body><main>{{ content_for_layout }}</main></body></html>`,
  "templates/index.liquid": "<h1>top</h1>",
  "templates/page.liquid": `<article class="pg"><h1>{{ page.title }}</h1>{{ page.content }}</article>`,
  "templates/checkout_done.liquid": `<p class="done">{{ checkout.status }}:{{ checkout.order_number }}:{{ checkout.message }}</p>`,
  "templates/customers/account.liquid": `<h1 class="acct">{{ customer.email }}</h1><p class="n">{{ customer.orders_count }}</p>{% for o in customer.orders %}<a class="o" href="{{ o.url }}">{{ o.name }} {{ o.total_price | money }} {{ o.status_label }}</a>{% endfor %}{% banto_account %}`,
};

let dispose = () => {};
afterEach(() => dispose());

function setup() {
  forgetThemes();
  const sb = new FakeSupabase();
  sb.sitePlan = "paid";
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "s", name: "ページのお店", published: true, legal_notice: "販売業者: 委員長商店\n所在地: 東京都 <b>", privacy_policy: "b", return_policy: "c", settings: { members_enabled: true } });
  const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
  row["domain"] = "shop.example.jp";
  row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
  const storage = new MemoryStorage(`${BASE}/media`);
  void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files, assets: [] })).buffer as ArrayBuffer, "application/json");
  const mail = memberMail(sb, shop.id);
  dispose = mail.dispose;
  const app = appWith(sb, { RESEND_API_KEY: "re_test" }, storage, new FakeStripe());
  return { sb, shop, mail, b: new Browser(app, DOMAIN) };
}

describe("テーマのページを増やす", () => {
  beforeEach(forgetThemes);

  it("取り込める: templates/customers/ の下の会員ページ", () => {
    expect(checkThemeBundle({ format: 1, files, assets: [] }, { extend: extendShopify }).ok).toBe(true);
  });

  it("法務のページは templates/page。page.content は Banto が文面から作る（改行は <br>、HTML はエスケープ）", async () => {
    const { b } = setup();
    const html = await (await b.get("/legal")).text();
    expect(html).toContain('<article class="pg"><h1>特定商取引法に基づく表記</h1><div class="banto-legal">販売業者: 委員長商店<br>所在地: 東京都 &lt;b&gt;</div></article>');
  });

  it("完了画面は templates/checkout_done（照会できないときは unknown と既定の文言）", async () => {
    const { b } = setup();
    const html = await (await b.get("/checkout/done")).text();
    expect(html).toMatch(/<p class="done">unknown::.+<\/p>/);
  });

  it("会員ページは templates/customers/account。注文は Shopify に近い形、管理の部品は {% banto_account %}。CSP を付け、退会はインラインのスクリプトを使わない", async () => {
    const { sb, shop, mail, b } = setup();
    await memberLogin(b, mail, "", "member@example.com");
    const cust = sb.tables.customers.find((x) => x["email"] === "member@example.com")!;
    sb.tables.orders.push({ id: "o-1", shop_id: shop.id, number: 1001, customer_id: cust["id"], customer_email: "member@example.com", status: "paid", total_jpy: 3300, created_at: new Date().toISOString() });
    const res = await b.get("/account");
    expect(res.headers.get("content-security-policy")).toBe(CHECKOUT_CSP);
    const html = await res.text();
    expect(html).toContain('<h1 class="acct">member@example.com</h1>');
    expect(html).toContain('<p class="n">1</p>');
    expect(html).toContain('<a class="o" href="/orders/lookup?banto_order=1001&amp;banto_member=1">#1001 ¥3,300');
    expect(html).toContain('action="/account/logout"');
    expect(html).toContain('name="confirm" value="1" required');
    expect(html).not.toContain("onsubmit=");
  });

  it("切り離したプレビューでは、会員ページをテーマで描かない", async () => {
    const { shop, mail, b } = setup();
    await memberLogin(b, mail, "", "member@example.com");
    const token = await sealThemePreview("test-session-secret", shop.id, VERSION, "api");
    await b.get(`/?preview_theme=${VERSION}&preview_token=${encodeURIComponent(token)}`);
    const html = await (await b.get("/account")).text();
    expect(html).not.toContain('class="acct"');
    expect(html).toContain("onsubmit=");
  });
});
