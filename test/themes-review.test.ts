import { beforeEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";
import { checkThemeBundle, type ThemeBundle } from "../src/themes/liquid/bundle";
import { extendShopify } from "../src/themes/liquid/shopify";
import { editorModel, fieldName, settingsFromForm } from "../src/themes/liquid/editor";
import { sealThemePreview } from "../src/themes/liquid/preview";
import { SANDBOXED_PREVIEW_CSP } from "../src/routes/storefront/liquid";

/** テーマの段階 2・3 の見直し（設定の画面・カートの書き方・プレビュー・資産・描く条件） */
const DOMAIN = "https://shop.example.jp";
const LIVE = "11111111-2222-4333-8444-555555555555";
const DRAFT = "22222222-3333-4444-8555-666666666666";
const SECRET = "test-session-secret";

const files: Record<string, string> = {
  "layout/theme.liquid": `<html><head>{{ content_for_header }}</head><body><main>{{ content_for_layout }}</main></body></html>`,
  "templates/index.liquid": `<h1 class="top">{{ settings.headline }}</h1>`,
  "templates/cart.liquid": `{% for item in cart.items %}<div class="line">{{ item.sku }}</div>{% endfor %}`,
  "templates/checkout.liquid": `<h1 class="co">テーマのレジ</h1>{% form 'checkout_address' %}{% endform %}`,
  "config/settings_schema.json": JSON.stringify([{ name: "一般", settings: [{ id: "headline", type: "text", default: "既定の見出し" }] }]),
};

function setup() {
  forgetThemes();
  const sb = new FakeSupabase();
  sb.sitePlan = "paid";
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "s", name: "見直しのお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", stripe_account_id: "acct_connected" });
  const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
  row["domain"] = "shop.example.jp";
  row["theme_public"] = { id: LIVE, storage_key: `themes/${shop.id}/${LIVE}/bundle.json`, settings: {} };
  const storage = new MemoryStorage(`${BASE}/media`);
  const put = (v: string, body: string, type = "application/json", name = "bundle.json") => void storage.put(`themes/${shop.id}/${v}/${name}`, new TextEncoder().encode(body).buffer as ArrayBuffer, type);
  for (const v of [LIVE, DRAFT]) {
    put(v, JSON.stringify({ format: 1, files, assets: ["theme.js"] }));
    put(v, "console.log(1)", "text/javascript", "assets/theme.js");
  }
  sb.tables.theme_versions.push({ id: DRAFT, shop_id: shop.id, name: "下書き", settings: { headline: "保存した見出し" }, complete: true });
  const p = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const old = sb.addProduct(shop.id, { slug: "old", name: "やめた品", published: true });
  const s1 = sb.addSku(shop.id, p.id, { code: "TEE-S", name: "S", price_jpy: 1000, available: 5 });
  const s0 = sb.addSku(shop.id, old.id, { code: "OLD", name: "-", price_jpy: 500, available: 5 });
  const app = appWith(sb, {}, storage, new FakeStripe());
  return { sb, shop, app, storage, s0, s1, oldRow: sb.tables.products.find((x) => x["id"] === old.id)!, b: new Browser(app, DOMAIN) };
}

describe("設定の画面（editor.ts）", () => {
  it("id が __proto__ のブロック・セクションは画面に出さず、送られても Object.prototype に書かない。取り込みでも断る", () => {
    const bundle: ThemeBundle = {
      format: 1,
      assets: [],
      files: {
        "layout/theme.liquid": "{{ content_for_layout }}",
        "sections/main.liquid": `{% schema %}{"name":"主","blocks":[{"type":"x","settings":[{"id":"t","type":"text"}]}]}{% endschema %}`,
        "templates/index.json": `{"sections":{"main":{"type":"main","blocks":{"__proto__":{"type":"x"},"ok":{"type":"x"}},"block_order":["__proto__","ok"]},"__proto__":{"type":"main"}},"order":["main","__proto__"]}`,
      },
    };
    const m = editorModel(bundle, null, "ja");
    expect(m.sections.map((s) => s.id)).toEqual(["main"]);
    expect(m.sections[0]!.blocks.map((b) => b.id)).toEqual(["ok"]);
    const r = settingsFromForm(m, { "b|templates/index|main|__proto__|polluted": "PWNED", [fieldName.block("templates/index", "main", "ok", "t")]: "x" }, { global: {}, sections: m.sections });
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(checkThemeBundle(bundle, { extend: extendShopify }).errors).toContain('templates/index.json: the key "__proto__" is not allowed');
  });

  it("触っていない欄は変えない: 画面で直せない値（shopify://）はそのまま、空の文字の欄は上書きを作らない", () => {
    const bundle: ThemeBundle = {
      format: 1,
      assets: ["logo.png"],
      files: {
        "layout/theme.liquid": "{{ content_for_layout }}",
        "sections/hero.liquid": `{% schema %}{"name":"大","settings":[{"id":"link","type":"url"},{"id":"logo","type":"image_picker"},{"id":"sub","type":"text"}]}{% endschema %}`,
        "templates/index.json": JSON.stringify({ sections: { hero: { type: "hero", settings: { link: "shopify://collections/all", logo: "shopify://shop_images/logo.png" } } }, order: ["hero"] }),
      },
    };
    const m = editorModel(bundle, null, "ja");
    const f = (id: string) => fieldName.section("templates/index", "hero", id);
    const sent = { [f("link")]: "shopify://collections/all", [f("logo")]: "shopify://shop_images/logo.png", [f("sub")]: "" };
    expect(settingsFromForm(m, sent, { global: {}, sections: m.sections })).toEqual({ ok: true, settings: {} });
    // 変えた欄だけ検査して置く（画像を外す・資産の画像を選ぶ）
    expect(settingsFromForm(m, { ...sent, [f("logo")]: "logo.png" }, { global: {}, sections: m.sections })).toEqual({ ok: true, settings: { __sections: { "templates/index": { hero: { settings: { logo: "asset:logo.png" } } } } } });
    expect(settingsFromForm(m, { ...sent, [f("link")]: "javascript:alert(1)" }, { global: {}, sections: m.sections }).ok).toBe(false);
  });

  it("一部だけ訳した翻訳のファイルでも、訳していない鍵は既定の文言のまま", () => {
    const bundle: ThemeBundle = {
      format: 1,
      assets: [],
      files: {
        "layout/theme.liquid": "{{ content_for_layout }}",
        "config/settings_schema.json": JSON.stringify([{ name: "t:g.name", settings: [{ id: "a", type: "text", label: "t:g.a" }, { id: "b", type: "text", label: "t:g.b" }] }]),
        "locales/en.default.schema.json": JSON.stringify({ g: { name: "General", a: "Alpha", b: "Beta" } }),
        "locales/ja.schema.json": JSON.stringify({ g: { a: "アルファ" } }),
      },
    };
    const m = editorModel(bundle, null, "ja");
    expect(m.global[0]!.name).toBe("General");
    expect(m.global[0]!.settings.map((s) => s.label)).toEqual(["アルファ", "Beta"]);
  });
});

describe("カートの書き方", () => {
  beforeEach(forgetThemes);

  it("行の位置（line・updates[]）は画面に出ている行で数える（公開をやめた品の行を数えない）", async () => {
    const { b, s0, s1, oldRow } = setup();
    await b.post("/cart/add", { id: s0.id, quantity: "1" });
    await b.post("/cart/add", { id: s1.id, quantity: "1" });
    oldRow["published"] = false;
    const cart = await (await b.postJson("/cart/change.js", { line: 1, quantity: 3 })).json() as { items: { sku: string; quantity: number }[] };
    expect(cart.items.map((i) => `${i.sku}x${i.quantity}`)).toEqual(["TEE-Sx3"]);
    await b.postRaw("/cart", "updates%5B%5D=0", "application/x-www-form-urlencoded");
    expect(((await (await b.get("/cart.js")).json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("/cart/update に checkout を付けたら、変えた後のカートで配送先の画面を描く。空にしたら進まない", async () => {
    const { b, s1 } = setup();
    await b.post("/cart/add", { id: s1.id, quantity: "1" });
    const res = await b.post("/cart/update", { [`updates[${s1.id}]`]: "3", checkout: "" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("テーマのレジ");
    expect(((await (await b.get("/cart.js")).json()) as { item_count: number }).item_count).toBe(3);
    const empty = await b.post("/cart/update", { [`updates[${s1.id}]`]: "0", checkout: "" });
    expect(empty.status).toBe(302);
    expect(empty.headers.get("location")).toBe("/cart?error=stock");
  });

  it("Dawn と同じく .js の付かない /cart/add・/cart/change に JSON を求めて送っても JSON で返す", async () => {
    const { b, s1 } = setup();
    const add = await b.post("/cart/add", { id: s1.id, quantity: "2" }, { headers: { accept: "application/javascript" } });
    expect(add.status).toBe(200);
    expect(await add.json()).toMatchObject({ id: s1.id, quantity: 2 });
    const ch = await b.postJson("/cart/change", { id: s1.id, quantity: 1 });
    expect(ch.status).toBe(200);
    expect(await ch.json()).toMatchObject({ item_count: 1 });
    // フォームの送信は今までどおり転送
    expect((await b.post("/cart/add", { id: s1.id, quantity: "1" })).status).toBe(302);
  });
});

describe("プレビューと資産", () => {
  beforeEach(forgetThemes);

  it("AI 用 API の券のプレビューはお店のオリジンから切り離す（sandbox）。レジはテーマで描かない。保存した設定の値は効く", async () => {
    const { b, shop, s1 } = setup();
    const token = await sealThemePreview(SECRET, shop.id, DRAFT, "api");
    const res = await b.get(`/?preview_theme=${DRAFT}&preview_token=${encodeURIComponent(token)}`);
    expect(res.headers.get("content-security-policy")).toBe(SANDBOXED_PREVIEW_CSP);
    expect(await res.text()).toContain('<h1 class="top">保存した見出し</h1>');
    await b.post("/cart/add", { id: s1.id, quantity: "1" });
    const co = await b.post("/checkout", { provider: "stripe" });
    const html = await co.text();
    expect(html).not.toContain("テーマのレジ");
    expect(html).toContain('name="postal_code"');
  });

  it("管理画面の券のプレビューは切り離さない（レジもテーマで確かめられる）", async () => {
    const { b, shop, s1 } = setup();
    const token = await sealThemePreview(SECRET, shop.id, DRAFT, "admin");
    const res = await b.get(`/?preview_theme=${DRAFT}&preview_token=${encodeURIComponent(token)}`);
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(await res.text()).toContain("保存した見出し");
    await b.post("/cart/add", { id: s1.id, quantity: "1" });
    expect(await (await b.post("/checkout", { provider: "stripe" })).text()).toContain("テーマのレジ");
  });

  it("資産: 公開中の版だけ長く覚えさせる。公開していない版は覚えさせない", async () => {
    const { b } = setup();
    expect((await b.get(`/_theme/${LIVE}/assets/theme.js`)).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const draft = await b.get(`/_theme/${DRAFT}/assets/theme.js`);
    expect(draft.headers.get("cache-control")).toBe("private, no-store");
    expect(draft.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });

  it("plan_limits.theme_versions が 0 なら、公開中の版も描かない", async () => {
    const { sb, b, storage } = setup();
    expect(await (await b.get("/")).text()).toContain('class="top"');
    sb.siteSettings = { ...sb.siteSettings, plan_limits: { theme_versions: 0 } };
    // 描く条件は isolate で覚えるので、新しい isolate として開き直す
    const fresh = new Browser(appWith(sb, {}, storage, new FakeStripe()), DOMAIN);
    expect(await (await fresh.get("/")).text()).not.toContain('class="top"');
  });
});
