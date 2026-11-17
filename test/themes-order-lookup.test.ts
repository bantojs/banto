import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith, memberLogin, memberMail } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";
import { checkThemeBundle } from "../src/themes/liquid/bundle";
import { extendShopify } from "../src/themes/liquid/shopify";
import { CHECKOUT_CSP } from "../src/routes/storefront/liquid";

/** Liquid のテーマで描く注文照会（templates/order_lookup）。メンテナの決定 2026-11-17 */
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";

const LOOKUP = `<section class="lookup" data-member="{{ lookup.member }}">
{% if lookup.error %}<p class="err">{{ lookup.error }}</p>{% endif %}
{% unless lookup.member %}{% form 'order_lookup' %}<input name="number" value="{{ lookup.values.number }}"><input name="email" value="{{ lookup.values.email }}"><button>照会</button>{% endform %}{% endunless %}
{% if lookup.order %}{% assign o = lookup.order %}<h2 class="no">{{ o.name }} {{ o.status_label }}</h2>
{% for li in o.line_items %}<p class="li">{{ li.title }} / {{ li.variant_title }} x{{ li.quantity }} {{ li.line_price | money }}</p>{% endfor %}
<p class="ship">{{ o.shipping_price | money }}</p><p class="total">{{ o.total_price | money }}</p>
{% if o.tracking %}<a class="tr" href="{{ o.tracking.url }}">{{ o.tracking.carrier_label }} {{ o.tracking.number }}</a>{% endif %}
{% if lookup.receipt %}{% form 'order_receipt' %}<input name="name"><button>領収書</button>{% endform %}{% endif %}
{% if lookup.inquiry %}{% form 'order_inquiry' %}<button>問い合わせ</button>{% endform %}{% endif %}
{% if lookup.receipt_url %}<a class="rc" href="{{ lookup.receipt_url }}">領収書</a>{% endif %}
{% endif %}</section>`;

const files: Record<string, string> = {
  "layout/theme.liquid": `<html><head>{{ content_for_header }}</head><body><main>{{ content_for_layout }}</main></body></html>`,
  "templates/index.liquid": "<h1>top</h1>",
  "templates/order_lookup.liquid": LOOKUP,
};

let dispose = () => {};
afterEach(() => dispose());

function setup(themeFiles: Record<string, string> = files) {
  forgetThemes();
  const sb = new FakeSupabase();
  sb.sitePlan = "paid";
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "s", name: "照会のお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { members_enabled: true, modules: { receipt: true, inquiries: true }, contact_email: "shop@example.com" } });
  const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
  row["domain"] = "shop.example.jp";
  row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 5 });
  const customer = { id: "cus-1", shop_id: shop.id, email: "hanako@example.com", name: "花子", session_epoch: 0 };
  sb.tables.orders.push({ id: "o-1", shop_id: shop.id, number: 1001, status: "shipped", customer_email: "buyer@example.com", total_jpy: 6800, shipping_jpy: 800, created_at: "2026-11-01T00:00:00Z", shipped_at: "2026-11-02T00:00:00Z", tracking_carrier: "sagawa", tracking_number: "400011112222", customer_id: null });
  sb.tables.order_items.push({ id: "oi-1", order_id: "o-1", shop_id: shop.id, sku_id: sku.id, qty: 2, unit_price_jpy: 3000 });
  const storage = new MemoryStorage(`${BASE}/media`);
  void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files: themeFiles, assets: [] })).buffer as ArrayBuffer, "application/json");
  const mail = memberMail(sb, shop.id);
  dispose = mail.dispose;
  const app = appWith(sb, { RESEND_API_KEY: "re_test" }, storage);
  return { sb, shop, sku, mail, customer, b: new Browser(app, DOMAIN) };
}

describe("テーマで描く注文照会（templates/order_lookup）", () => {
  it("テーマの検査を通る（templates/order_lookup は知っているテンプレート）", () => {
    expect(checkThemeBundle({ format: 1, files, assets: [] }, { extend: extendShopify }).ok).toBe(true);
  });

  it("番号とメールアドレスで開く。中身（品目・送料・合計・配送の照会）と、領収書・問い合わせのフォームに Banto が隠しの値を入れる。CSP と覚えさせない", async () => {
    const { b } = setup();
    const empty = await b.get("/orders/lookup");
    expect(empty.headers.get("content-security-policy")).toBe(CHECKOUT_CSP);
    const form = await empty.text();
    expect(form).toContain('class="lookup"');
    expect(form).toContain('action="/orders/lookup"');
    const res = await b.post("/orders/lookup", { number: "1001", email: "Buyer@example.com" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(CHECKOUT_CSP);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const html = await res.text();
    expect(html).toContain('<h2 class="no">#1001 発送済み</h2>');
    expect(html).toContain("Tシャツ / M x2 ¥6,000");
    expect(html).toContain('<p class="ship">¥800</p>');
    expect(html).toContain('<p class="total">¥6,800</p>');
    expect(html).toContain("佐川急便 400011112222");
    // 領収書: 番号とアドレスは Banto が隠しの値で入れる
    expect(html).toMatch(/<form[^>]*action="\/orders\/receipt"[\s\S]*?name="number" value="1001"[\s\S]*?name="email" value="Buyer@example.com"/);
    // 問い合わせ: 注文の券を隠しの値で
    expect(html).toMatch(/<form[^>]*action="\/inquiries\/new"[\s\S]*?name="o" value="[^"]+"/);
  });

  it("見つからない・形の違いはテーマの error で、状態のコードは今までどおり", async () => {
    const { b } = setup();
    const nf = await b.post("/orders/lookup", { number: "1001", email: "other@example.com" });
    expect(nf.status).toBe(404);
    expect(await nf.text()).toContain('<p class="err">');
    expect((await b.post("/orders/lookup", { number: "abc", email: "x@example.com" })).status).toBe(400);
  });

  it("テーマに templates/order_lookup が無ければ既定のテーマ", async () => {
    const { b } = setup({ ...files, "templates/order_lookup.liquid": undefined as unknown as string });
    const html = await (await b.post("/orders/lookup", { number: "1001", email: "buyer@example.com" })).text();
    expect(html).not.toContain('class="lookup"');
    expect(html).toContain("1001");
  });

  it("ログイン中の会員の自分の注文（注文メールのリンク）: 番号とアドレスの欄は出さず、領収書はリンク", async () => {
    const { sb, b, mail, shop } = setup();
    await memberLogin(b, mail, "", "hanako@example.com");
    const cid = String(sb.tables.customers.find((x) => x["shop_id"] === shop.id && x["email"] === "hanako@example.com")!["id"]);
    Object.assign(sb.tables.orders[0]!, { customer_id: cid, customer_email: "hanako@example.com" });
    const html = await (await b.get("/orders/lookup?banto_order=1001&banto_member=1")).text();
    expect(html).toContain('data-member="true"');
    expect(html).not.toContain('action="/orders/lookup"');
    expect(html).toContain('<a class="rc" href="/account/orders/1001/receipt">');
  });
});
