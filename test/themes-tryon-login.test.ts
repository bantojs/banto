import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, MemoryStorage, appWith, memberMail } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";
import { checkThemeBundle } from "../src/themes/liquid/bundle";
import { extendShopify } from "../src/themes/liquid/shopify";
import { CHECKOUT_CSP } from "../src/routes/storefront/liquid";

/** Liquid のテーマで描くお店で試着（templates/tryon）と会員のログイン（templates/customers/login）。メンテナの決定 2026-11-06 */
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";

const TRYON = `<section class="tryon" data-step="{{ tryon.step }}">
{% if tryon.error %}<p class="err">{{ tryon.error }}</p>{% endif %}
{% case tryon.step %}
{% when 'store' %}{% for st in tryon.stores %}<a class="st" href="{{ st.select_url }}">{{ st.name }} {{ st.today }}</a>{% endfor %}
{% when 'details' %}<h2>{{ tryon.store.name }}</h2>{% for it in tryon.items %}<p class="it">{{ it.product_title }} x{{ it.quantity }}</p>{% endfor %}
{% form 'tryon_details' %}<input name="customer_name" value="{{ tryon.values.customer_name }}"><input name="customer_email"><input name="customer_phone"><button>確認</button>{% endform %}
{% when 'confirm' %}<p class="cf">{{ tryon.values.customer_name }} / {{ tryon.values.customer_email }}</p>{% form 'tryon_submit' %}<button>申し込む</button>{% endform %}<a href="{{ tryon.edit_url }}">直す</a>
{% when 'done' %}<p class="done">受付番号 {{ tryon.number }} {{ tryon.store.name }}</p>
{% endcase %}</section>`;

const LOGIN = `<section class="login" data-step="{{ login.step }}">{% if login.error %}<p class="err">{{ login.error }}</p>{% endif %}
{% case login.step %}
{% when 'email' %}{% form 'customer_login' %}<input name="email" value="{{ login.email }}"><button>コードを送る</button>{% endform %}{% for p in login.providers %}<a class="pv" href="{{ p.url }}">{{ p.name }}</a>{% endfor %}{% if login.password %}{% form 'customer_password_login' %}<input name="email"><input name="password" type="password">{% endform %}{% endif %}
{% when 'code' %}<p class="to">{{ login.email }}</p>{% form 'customer_code' %}<input name="code"><button>ログイン</button>{% endform %}
{% when 'verify' %}<p class="to">{{ login.email }}</p>{% form 'customer_verify' %}<button>ログインする</button>{% endform %}
{% endcase %}</section>`;

const files: Record<string, string> = {
  "layout/theme.liquid": `<html><head>{{ content_for_header }}</head><body><main>{{ content_for_layout }}</main></body></html>`,
  "templates/index.liquid": "<h1>top</h1>",
  "templates/tryon.liquid": TRYON,
  "templates/customers/login.liquid": LOGIN,
};

let dispose = () => {};
afterEach(() => dispose());

function setup(themeFiles: Record<string, string> = files, settings: Record<string, unknown> = {}) {
  forgetThemes();
  const sb = new FakeSupabase();
  sb.sitePlan = "paid";
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "s", name: "試着のお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { members_enabled: true, modules: { store_tryon: true }, contact_email: "shop@example.com", ...settings } });
  const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
  row["domain"] = "shop.example.jp";
  row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 5 });
  const everyDay = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [["10:00", "20:00"]]]));
  const org = String(shop["org_id"]);
  sb.tables.stores.push({ id: "st-1", org_id: org, name: "渋谷店", postal_code: "150-0001", address: "東京都渋谷区1-1", phone: "03-0000-0000", email: null, notify_email: false, hours: everyDay, special_days: [], note: null, active: true, sort_order: 0 });
  sb.tables.shop_stores.push({ shop_id: shop.id, store_id: "st-1", tryon: true, sort_order: 0 });
  const storage = new MemoryStorage(`${BASE}/media`);
  void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files: themeFiles, assets: [] })).buffer as ArrayBuffer, "application/json");
  const mail = memberMail(sb, shop.id);
  dispose = mail.dispose;
  const app = appWith(sb, { RESEND_API_KEY: "re_test" }, storage, new FakeStripe());
  return { sb, shop, sku, mail, b: new Browser(app, DOMAIN) };
}

describe("テーマで描くお店で試着（templates/tryon）", () => {
  beforeEach(forgetThemes);

  it("取り込める", () => {
    expect(checkThemeBundle({ format: 1, files, assets: [] }, { extend: extendShopify }).ok).toBe(true);
  });

  it("店舗 → 連絡先 → 確認 → 申し込み → 受付。確かめた値は Banto が隠しの値で入れる。連絡先の画面には CSP", async () => {
    const { sb, sku, b } = setup();
    await b.post("/cart/add", { sku_id: sku.id, qty: "2" });
    const list = await b.get("/tryon");
    const listHtml = await list.text();
    expect(listHtml).toContain('data-step="store"');
    expect(listHtml).toContain('<a class="st" href="/tryon?store=st-1">渋谷店 本日の営業 10:00〜20:00</a>');
    expect(list.headers.get("content-security-policy")).toBe(CHECKOUT_CSP);

    const details = await (await b.get("/tryon?store=st-1")).text();
    expect(details).toContain("<h2>渋谷店</h2>");
    expect(details).toContain('<p class="it">Tシャツ x2</p>');
    expect(details).toContain('<form method="post" action="/tryon/confirm" accept-charset="UTF-8"><input type="hidden" name="form_type" value="tryon_details"><input type="hidden" name="store" value="st-1">');

    const form = { form_type: "tryon_details", store: "st-1", customer_name: "山田 <花子>", customer_email: "Hanako@example.com", customer_phone: "090-1111-2222" };
    const bad = await b.post("/tryon/confirm", { ...form, customer_email: "bad" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('<p class="err">');
    const confirm = await (await b.post("/tryon/confirm", form)).text();
    expect(confirm).toContain('<p class="cf">山田 &lt;花子&gt; / hanako@example.com</p>');
    expect(confirm).toContain('<input type="hidden" name="customer_name" value="山田 &lt;花子&gt;">');
    expect(confirm).toContain('<input type="hidden" name="customer_email" value="hanako@example.com">');
    expect(confirm).toContain('action="/tryon/submit"');

    const res = await b.post("/tryon/submit", { store: "st-1", customer_name: "山田 花子", customer_email: "Hanako@example.com", customer_phone: "090-1111-2222", note: "" });
    expect(res.headers.get("location")).toBe("/tryon/done?n=1&store=st-1");
    expect(sb.tables.tryon_requests[0]).toMatchObject({ number: 1, status: "requested", store_id: "st-1" });
    expect(await (await b.get("/tryon/done?n=1&store=st-1")).text()).toContain('<p class="done">受付番号 1 渋谷店</p>');
  });

  it("テーマに templates/tryon が無ければ既定のテーマ", async () => {
    const { sku, b } = setup({ "layout/theme.liquid": files["layout/theme.liquid"]!, "templates/index.liquid": "<h1>top</h1>" });
    await b.post("/cart/add", { sku_id: sku.id, qty: "1" });
    const html = await (await b.get("/tryon")).text();
    expect(html).not.toContain('data-step="store"');
    expect(html).toContain("渋谷店");
  });
});

describe("テーマで描く会員のログイン（templates/customers/login）", () => {
  beforeEach(forgetThemes);

  it("アドレス → コード → ログイン。ほかの方法のリンク・パスワードの欄。CSP を付ける", async () => {
    const { b, mail } = setup(files, { members_password: true });
    const login = await b.get("/account/login");
    const html = await login.text();
    expect(html).toContain('data-step="email"');
    expect(html).toContain('<form method="post" action="/account/login" accept-charset="UTF-8"><input type="hidden" name="form_type" value="customer_login">');
    expect(html).toContain('action="/account/password-login"');
    expect(login.headers.get("content-security-policy")).toBe(CHECKOUT_CSP);
    expect(login.headers.get("cache-control")).toContain("no-store");

    await b.post("/account/login", { email: "hanako@example.com" });
    const code = await (await b.get("/account/code")).text();
    expect(code).toContain('<p class="to">hanako@example.com</p>');
    expect(code).toContain('action="/account/code"');
    expect((await b.post("/account/code", { code: "000000" })).headers.get("location")).toBe("/account/code?error=failed");
    expect(await (await b.get("/account/code?error=failed")).text()).toContain('<p class="err">');
    const ok = await b.post("/account/code", { code: mail.code("hanako@example.com") });
    expect(ok.headers.get("location")).toBe("/account");
  });

  it("メールのリンクの確かめ: 券は Banto が隠しの値で入れ、ボタンの POST でログインする", async () => {
    const { b, mail } = setup();
    await b.post("/account/login", { email: "taro@example.com" });
    const link = mail.link("taro@example.com");
    const u = new URL(link);
    const verify = await (await b.get(`/account/verify${u.search}`)).text();
    expect(verify).toContain('data-step="verify"');
    expect(verify).toContain(`<input type="hidden" name="c" value="${u.searchParams.get("c")}"><input type="hidden" name="t" value="${u.searchParams.get("t")}">`);
    const res = await b.post("/account/verify", { c: u.searchParams.get("c")!, t: u.searchParams.get("t")! });
    expect(res.headers.get("location")).toBe("/account");
  });
});
