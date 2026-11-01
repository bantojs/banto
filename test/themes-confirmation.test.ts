import { beforeEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, MemoryStorage, appWith, quoteFrom } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";
import { checkThemeBundle } from "../src/themes/liquid/bundle";
import { extendShopify, fillConfirmation, newConfirmationMark, withRenderEnv, type RenderEnv } from "../src/themes/liquid/shopify";
import { createThemeEngine } from "../src/themes/liquid/engine";

/**
 * 最終確認画面（特商法）の {% banto_confirmation %} は「必須」を Banto が守る（docs/themes.md「レジ」）:
 * タグは Banto の HTML を書かず、リクエストごとの乱数の印だけを書く。テーマは印を真似できず、capture で表示を切り出すこともできない。
 * 描いた結果に印が無ければ既定のテーマで描く。取り込みの検査は templates/checkout_confirm 自身（.json なら並べたセクション）に求める
 */
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";

const base: Record<string, string> = {
  "layout/theme.liquid": `<html><head>{{ content_for_header }}</head><body><main>{{ content_for_layout }}</main></body></html>`,
  "templates/index.liquid": "<h1>top</h1>",
  "templates/checkout.liquid": `{% form 'checkout_address' %}<button>確認へ</button>{% endform %}`,
  "templates/checkout_confirm.liquid": `<h1 class="cf">ご注文の確認</h1>{% banto_confirmation %}`,
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

async function reviewHtml(files: Record<string, string>): Promise<{ html: string; b: Browser; stripe: FakeStripe }> {
  const { b, sku, stripe } = setup(files);
  await b.post("/cart/add", { id: sku.id, quantity: "1" });
  const review = await b.post("/checkout/stripe", ADDRESS);
  expect(review.status).toBe(200);
  return { html: await review.text(), b, stripe };
}

describe("{% banto_confirmation %} の必須を Banto が守る", () => {
  beforeEach(forgetThemes);

  it("印はリクエストごとの乱数で、描いた結果の印だけを Banto の表示に差し替える", () => {
    const a = newConfirmationMark();
    const b = newConfirmationMark();
    expect(a).toMatch(/^<!--banto:confirmation:[0-9a-f]{32}-->$/);
    expect(a).not.toBe(b);
    expect(fillConfirmation(`<p>x</p>${a}<p>y</p>`, a, "<form>B</form>")).toBe("<p>x</p><form>B</form><p>y</p>");
    // 印が無ければ null（既定のテーマで描く）。固定の文字列や別のリクエストの印では差し替えない
    expect(fillConfirmation("<p>x</p><!-- banto:confirmation --><!--banto:confirmation:0000-->", a, "B")).toBeNull();
    expect(fillConfirmation(`<p>${b}</p>`, a, "B")).toBeNull();
  });

  it("タグは Banto の HTML を書かず、印はテーマの変数から読めない（最終確認画面の外では何も書かない）", () => {
    const engine = createThemeEngine({}, { extend: extendShopify });
    const src = "[{% banto_confirmation %}][{{ __banto_confirmation }}][{% capture x %}{% banto_confirmation %}{% endcapture %}{{ x | size }}]";
    const envOf = (confirmationMark?: string): RenderEnv => ({ engine, versionId: "v1", shopOrigin: "https://shop.example.jp", shopPath: "", mediaBaseUrl: "https://m.example", locales: {}, schemas: new Map(), staticSections: {}, overrides: {}, globals: {}, paginate: null, preview: false, errors: [], ...(confirmationMark ? { confirmationMark } : {}) });
    expect(withRenderEnv(envOf(), () => engine.renderString(src, {}))).toBe("[][][0]");
    const mark = newConfirmationMark();
    // 最終確認画面では印だけ（Banto の HTML は無く、capture しても印の長さだけ）
    expect(withRenderEnv(envOf(mark), () => engine.renderString(src, {}))).toBe(`[${mark}][][${mark.length}]`);
  });

  it("capture で切り出して自前の確定ボタンを作ったテーマ: 表示（quote）は取り出せず、印の文字列を書いても既定のテーマで描く", async () => {
    const files = {
      ...base,
      "templates/checkout_confirm.liquid": `<!-- banto:confirmation --><h1 class="cf">自前の確認</h1>{% capture x %}{% banto_confirmation %}{% endcapture %}<i class="cap">{{ x | size }}</i>{% assign q = x | split: 'name="quote" value="' | last | split: '"' | first %}<form method="post" action="/checkout/stripe"><input type="hidden" name="quote" value="{{ q }}"><button>buy</button></form>`,
    };
    const { html } = await reviewHtml(files);
    // テーマの画面にならず（印を capture の中に閉じ込めた = 描いた結果に印が無い）、既定のテーマの最終確認画面
    expect(html).not.toContain('<h1 class="cf">');
    expect(html).not.toContain('<i class="cap">');
    expect(html).toContain('<div class="banto-confirmation">');
    expect(html).toContain("特定商取引法に基づく表記");
  });

  it("capture した印をそのまま出したテーマ: 印の場所に Banto の表示が入る（切り出した中に quote は無い）", async () => {
    const files = {
      ...base,
      "templates/checkout_confirm.liquid": `<h1 class="cf">確認</h1>{% capture x %}{% banto_confirmation %}{% endcapture %}<i class="cap">{{ x contains 'quote' }}</i>{{ x }}`,
    };
    const { html, b, stripe } = await reviewHtml(files);
    expect(html).toContain('<h1 class="cf">確認</h1>');
    expect(html).toContain('<i class="cap">false</i>');
    expect(html).toContain('<div class="banto-confirmation">');
    expect(html).toContain("特定商取引法に基づく表記");
    expect(html).not.toMatch(/<!--banto:confirmation:[0-9a-f]{32}-->/);
    const placed = await b.post("/checkout/stripe", { quote: quoteFrom(html) });
    expect([302, 303]).toContain(placed.status);
    expect(stripe.sessions.size).toBe(1);
  });

  it("templates/checkout_confirm.json: 並べたセクションの中の {% banto_confirmation %} で描ける", async () => {
    const files = {
      ...base,
      "templates/checkout_confirm.liquid": "<h1>使わない</h1>",
      "templates/checkout_confirm.json": JSON.stringify({ sections: { main: { type: "confirm" } }, order: ["main"] }),
      "sections/confirm.liquid": `<h1 class="cf">セクションの確認</h1>{% banto_confirmation %}`,
    };
    expect(checkThemeBundle({ format: 1, files, assets: [] }, { extend: extendShopify }).ok).toBe(true);
    const { html } = await reviewHtml(files);
    expect(html).toContain('<h1 class="cf">セクションの確認</h1>');
    expect(html).toContain('<div class="banto-confirmation">');
  });

  it("取り込みの検査: タグは templates/checkout_confirm 自身（.json なら並べたセクション）に要る。snippet や別のテンプレートでは通らない", () => {
    const required = "templates/checkout_confirm: {% banto_confirmation %} is required";
    const check = (files: Record<string, string>) => checkThemeBundle({ format: 1, files, assets: [] }, { extend: extendShopify });
    expect(check(base).ok).toBe(true);
    // snippet にだけ書いた（render で描くかどうかは分からない）
    expect(check({ ...base, "templates/checkout_confirm.liquid": "<h1>確認</h1>{% render 'cf' %}", "snippets/cf.liquid": "{% banto_confirmation %}" }).errors).toContain(required);
    // 別のテンプレートにだけ書いた
    expect(check({ ...base, "templates/checkout_confirm.liquid": "<h1>確認</h1>", "templates/page.liquid": "{% banto_confirmation %}" }).errors).toContain(required);
    // .json が先に描かれる: .liquid に書いてあっても、並べたセクションに無ければ通らない
    const json = JSON.stringify({ sections: { main: { type: "plain" } }, order: ["main"] });
    expect(check({ ...base, "templates/checkout_confirm.json": json, "sections/plain.liquid": "<h1>確認</h1>", "sections/confirm.liquid": "{% banto_confirmation %}" }).errors).toContain(required);
    expect(check({ ...base, "templates/checkout_confirm.json": json, "sections/plain.liquid": "<h1>確認</h1>{%- banto_confirmation -%}" }).ok).toBe(true);
    // レジのテンプレートが無ければ求めない
    expect(check(Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith("templates/checkout")))).ok).toBe(true);
  });
});
