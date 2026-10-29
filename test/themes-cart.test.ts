import { beforeEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";
import { checkThemeBundle } from "../src/themes/liquid/bundle";
import { extendShopify } from "../src/themes/liquid/shopify";
import { addsFrom, changeFrom, updatesFrom } from "../src/cart/shopify-form";

/** カートのページ・AJAX のカート・検索・テーマのブロック・フォーム（テーマの段階 3 の B、docs/themes.md） */
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";

const files: Record<string, string> = {
  "layout/theme.liquid": `<html><head>{{ content_for_header }}</head><body><header class="cart-count">{{ cart.item_count }}{% for i in cart.items %}<span class="mini">{{ i.product_title }}</span>{% endfor %}</header><main>{{ content_for_layout }}</main></body></html>`,
  "templates/index.json": JSON.stringify({
    sections: {
      main: {
        type: "group",
        blocks: { a: { type: "text", settings: { text: "A" } }, b: { type: "row", blocks: { c: { type: "text", settings: { text: "C" } } }, block_order: ["c"] }, s: { type: "text", static: true, settings: { text: "固定" } } },
        block_order: ["a", "b"],
      },
    },
    order: ["main"],
  }),
  "templates/product.liquid": `{% form 'product', product %}<button>入れる</button>{% endform %}{% form 'contact' %}<input name="contact[email]">{% endform %}{% form 'customer_login' %}<input name="customer[email]">{% endform %}`,
  "templates/cart.liquid": `{% if cart.empty %}<p class="empty">空です</p>{% else %}{% form 'cart', cart %}{% for item in cart.items %}<div class="line" data-key="{{ item.key }}">{{ item.title }} × <input name="updates[]" value="{{ item.quantity }}"> {{ item.final_line_price | money }} <a href="{{ item.url_to_remove }}">削除</a></div>{% endfor %}<p class="total">{{ cart.total_price | money }}</p><button name="checkout">購入手続きへ</button>{% endform %}{% endif %}{% if cart_error %}<p class="err">{{ cart_error }}</p>{% endif %}`,
  "templates/search.liquid": `<h1>{{ search.terms }}</h1><p class="count">{{ search.results_count }}</p>{% for r in search.results %}<a class="hit" href="{{ r.url }}">{{ r.title }}</a>{% endfor %}<form action="{{ routes.search_url }}"><input name="q"></form>`,
  "sections/group.liquid": `<div class="g">{% content_for 'blocks' %}{% content_for 'block', type: 'text', id: 's' %}{% content_for 'block', type: 'text', id: 'none' %}</div>{% schema %}{"name": "群", "blocks": [{"type": "@theme"}]}{% endschema %}`,
  "blocks/text.liquid": `<p {{ block.shopify_attributes }}>{{ block.settings.text }}</p>{% schema %}{"name": "文字", "settings": [{"id": "text", "type": "text", "default": "既定"}]}{% endschema %}`,
  "blocks/row.liquid": `<div class="row">{% content_for 'blocks' %}</div>{% schema %}{"name": "行", "blocks": [{"type": "@theme"}]}{% endschema %}`,
};

function setup(opts: { liquid?: boolean } = {}) {
  forgetThemes();
  const sb = new FakeSupabase();
  sb.sitePlan = "paid";
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "s", name: "カートのお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { inquiries: true }, members_enabled: true }, stripe_account_id: "acct_connected" });
  const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
  row["domain"] = "shop.example.jp";
  if (opts.liquid !== false) row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
  const p = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const s1 = sb.addSku(shop.id, p.id, { code: "TEE-S", name: "S", price_jpy: 1200, available: 5 });
  const s2 = sb.addSku(shop.id, p.id, { code: "TEE-M", name: "M", price_jpy: 1500, available: 5 });
  sb.addProduct(shop.id, { slug: "mug", name: "マグカップ", published: true });
  const storage = new MemoryStorage(`${BASE}/media`);
  void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files, assets: [] })).buffer as ArrayBuffer, "application/json");
  const app = appWith(sb, {}, storage, new FakeStripe());
  return { sb, shop, app, s1, s2, b: new Browser(app, DOMAIN) };
}

const json = async (b: Browser, method: "GET" | "POST", path: string, body?: unknown) => {
  const res = method === "GET" ? await b.get(path) : await b.postJson(path, body ?? {});
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { items?: Record<string, unknown>[] } };
};

describe("カートの書き方の読み替え（shopify-form.ts）", () => {
  it("updates[] は行の順、updates[id] は SKU、change は id か line、add は id か items", () => {
    expect(updatesFrom({ "updates[]": ["2", "0"] }, ["a", "b"])).toEqual([{ skuId: "a", qty: 2 }, { skuId: "b", qty: 0 }]);
    expect(updatesFrom({ "updates[b]": "3", updates: { a: 1 } }, ["a", "b"])).toEqual([{ skuId: "a", qty: 1 }, { skuId: "b", qty: 3 }]);
    expect(updatesFrom({ updates: [1, "x", -1] }, ["a", "b", "c"])).toEqual([{ skuId: "a", qty: 1 }]);
    expect(changeFrom({ line: "2", quantity: "0" }, ["a", "b"])).toEqual({ skuId: "b", qty: 0 });
    expect(changeFrom({ id: "a", quantity: 4 }, ["a"])).toEqual({ skuId: "a", qty: 4 });
    expect(changeFrom({ line: "3", quantity: "1" }, ["a"])).toBeNull();
    expect(addsFrom({ id: "a" })).toEqual([{ skuId: "a", qty: 1 }]);
    expect(addsFrom({ items: [{ id: "a", quantity: 2 }, { id: "b", quantity: 0 }] })).toEqual([{ skuId: "a", qty: 2 }]);
  });
});

describe("Liquid のテーマのカート・検索・ブロック", () => {
  beforeEach(forgetThemes);

  it("カートのページ: templates/cart で描く。どのページでも cart.items が読める（ヘッダーのカート）", async () => {
    const { b, s1, s2 } = setup();
    expect(await (await b.get("/cart")).text()).toContain('<p class="empty">空です</p>');
    await b.post("/cart/add", { id: s1.id, quantity: "2" });
    await b.post("/cart/add", { id: s2.id, quantity: "1" });
    const html = await (await b.get("/cart")).text();
    expect(html).toContain(`<div class="line" data-key="${s1.id}">Tシャツ - S × <input name="updates[]" value="2"> ¥2,400 <a href="/cart/change?id=${s1.id}&amp;quantity=0">削除</a></div>`);
    expect(html).toContain('<p class="total">¥3,900</p>');
    expect(html).toContain('<form method="post" action="/cart"');
    expect(html).toContain('<meta name="robots" content="noindex">');
    const home = await (await b.get("/")).text();
    expect(home).toContain('<header class="cart-count">3<span class="mini">Tシャツ</span><span class="mini">Tシャツ</span></header>');
  });

  it("{% form 'cart' %}: updates[] で数を変え、checkout で配送先の画面へ。url_to_remove で外す", async () => {
    const { b, s1, s2 } = setup();
    await b.post("/cart/add", { id: s1.id, quantity: "2" });
    await b.post("/cart/add", { id: s2.id, quantity: "1" });
    const res = await b.postRaw("/cart", "updates%5B%5D=1&updates%5B%5D=3", "application/x-www-form-urlencoded");
    expect(res.status).toBe(302);
    expect(await (await b.get("/cart")).text()).toContain('<p class="total">¥5,700</p>');
    const co = await b.postRaw("/cart", "updates%5B%5D=1&updates%5B%5D=3&checkout=", "application/x-www-form-urlencoded");
    expect(co.status).toBe(200);
    expect(await co.text()).toContain('name="postal_code"');
    await b.get(`/cart/change?id=${s1.id}&quantity=0`);
    expect(await (await b.get("/cart")).text()).not.toContain(`data-key="${s1.id}"`);
  });

  it("AJAX: /cart.js・/cart/add.js・/cart/change.js・/cart/update.js・/cart/clear.js。公開していない SKU は 404", async () => {
    const { b, s1, s2 } = setup();
    expect((await json(b, "GET", "/cart.js")).body).toMatchObject({ item_count: 0, items: [], total_price: 0 });
    const added = await json(b, "POST", "/cart/add.js", { id: s1.id, quantity: 2 });
    expect(added.body).toMatchObject({ id: s1.id, quantity: 2, price: 120000, final_line_price: 240000, product_title: "Tシャツ", variant_title: "S" });
    expect((await json(b, "POST", "/cart/add.js", { items: [{ id: s2.id, quantity: 1 }] })).body.items).toHaveLength(1);
    expect((await json(b, "POST", "/cart/add.js", { id: "99999999-0000-4000-8000-000000000000", quantity: 1 })).status).toBe(404);
    expect((await json(b, "POST", "/cart/change.js", { line: 1, quantity: 5 })).body).toMatchObject({ item_count: 6, total_price: 750000 });
    expect((await json(b, "POST", "/cart/update.js", { updates: { [s2.id]: 0 } })).body).toMatchObject({ item_count: 5 });
    expect((await json(b, "POST", "/cart/change.js", { quantity: 1 })).status).toBe(400);
    expect((await json(b, "POST", "/cart/clear.js")).body).toMatchObject({ item_count: 0 });
    // ほかのサイトからは書けない（csrfGuard）
    const cross = await b.postJson("/cart/add.js", { id: s1.id }, { origin: "https://evil.example" });
    expect(cross.status).toBe(403);
  });

  it("検索: templates/search。既定のテーマでは一覧に結果を並べる。q が無ければ結果なし", async () => {
    const { b } = setup();
    const html = await (await b.get("/search?q=マグカップ")).text();
    expect(html).toContain("<h1>マグカップ</h1>");
    expect(html).toContain('<a class="hit" href="/p/mug">マグカップ</a>');
    expect(html).not.toContain("Tシャツ</a>");
    expect(html).toContain('<form action="/search">');
    expect(await (await b.get("/search")).text()).toContain('<p class="count">0</p>');
    // 2 文字以下の語は探さない（DB を重くさせない。0058）
    expect(await (await b.get("/search?q=マグ")).text()).toContain('<p class="count">0</p>');
    // 既定のテーマ（テーマを公開していないショップ）
    const tsx = await (await setup({ liquid: false }).b.get("/search?q=マグカップ")).text();
    expect(tsx).toContain("マグカップ");
    expect(tsx).not.toContain(">Tシャツ<");
  });

  it("テーマのブロック: content_for 'blocks' は順に（入れ子も）、'block' は決まった場所。値が無ければ宣言の既定値", async () => {
    const { b } = setup();
    const html = await (await b.get("/")).text();
    expect(html).toContain('<div class="g"><p data-block-id="a">A</p><div class="row"><p data-block-id="c">C</p></div><p data-block-id="s">固定</p><p data-block-id="none">既定</p></div>');
  });

  it("フォーム: contact はお問い合わせ、customer_login は会員のログインへ（Shopify の欄の名前のまま受ける）", async () => {
    const { b } = setup();
    const html = await (await b.get("/p/tee")).text();
    expect(html).toContain('<form method="post" action="/inquiries/new" accept-charset="UTF-8"><input type="hidden" name="form_type" value="contact">');
    expect(html).toContain('<form method="post" action="/account/login" accept-charset="UTF-8"><input type="hidden" name="form_type" value="customer_login">');
    const inq = await b.post("/inquiries/new", { "contact[email]": "q@example.com", "contact[body]": "質問です" });
    const page = await inq.text();
    expect(page).toContain('value="q@example.com"');
    expect(page).toContain("質問です");
  });

  it("取り込み: blocks/*.liquid を受け付けて解析する。content_for の誤った形は断る", () => {
    expect(checkThemeBundle({ format: 1, files, assets: [] }, { extend: extendShopify }).ok).toBe(true);
    const bad = checkThemeBundle({ format: 1, files: { ...files, "blocks/x.liquid": "{% content_for 'sections' %}" }, assets: [] }, { extend: extendShopify });
    expect(bad.errors.join()).toMatch(/blocks\/x\.liquid/);
  });
});
