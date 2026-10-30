import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";

/** ショップのページ（同梱モジュール pages、0079、docs/pages.md）: /pages/<handle> を既定のテーマと Liquid のテーマで描く */
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";

afterEach(forgetThemes);

function setup(opts: { modules?: Record<string, boolean>; storefront?: Record<string, unknown>; liquid?: Record<string, string> } = {}) {
  forgetThemes();
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "ページのお店",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    settings: { modules: opts.modules ?? { pages: true }, ...(opts.storefront ? { storefront: opts.storefront } : {}) },
  });
  sb.addPage(shop.id, { handle: "about", title: "私たちについて", body: "## 店のこと\n\n**手しごと**の店です。<script>alert(1)</script>\n\n[送料](/shipping)", nav: "header", seo_description: "店の紹介" });
  sb.addPage(shop.id, { handle: "faq", title: "よくある質問", body: "- 質問 1", nav: "footer", template_suffix: "faq" });
  sb.addPage(shop.id, { handle: "draft", title: "下書き", published: false });
  const storage = new MemoryStorage(`${BASE}/media`);
  if (opts.liquid) {
    sb.sitePlan = "paid";
    const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
    row["domain"] = "shop.example.jp";
    row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
    void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files: opts.liquid, assets: [] })).buffer as ArrayBuffer, "application/json");
  }
  const app = appWith(sb, {}, storage, new FakeStripe());
  return { sb, shop, b: new Browser(app, opts.liquid ? DOMAIN : BASE) };
}

describe("ショップのページ（既定のテーマ）", () => {
  it("本文を決まった書式で HTML にして描く。生の HTML は文字のまま。canonical と説明", async () => {
    const { b } = setup();
    const res = await b.get("/my-shop/pages/about");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>私たちについて</h1>");
    expect(html).toContain("<h3>店のこと</h3>");
    expect(html).toContain("<strong>手しごと</strong>の店です。&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('<a href="/shipping">送料</a>');
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain(`<link rel="canonical" href="${BASE}/my-shop/pages/about"`);
    expect(html).toContain('content="店の紹介"');
  });

  it("メニューに出すページはヘッダーとフッターに。下書き・無いページ・モジュールが OFF なら 404", async () => {
    const { b } = setup();
    const top = await (await b.get("/my-shop")).text();
    expect(top).toContain('<a href="/my-shop/pages/about"');
    expect(top).toContain('<a href="/my-shop/pages/faq">よくある質問</a>');
    expect((await b.get("/my-shop/pages/draft")).status).toBe(404);
    expect((await b.get("/my-shop/pages/nope")).status).toBe(404);
    expect((await b.get("/my-shop/pages/Bad_Handle")).status).toBe(404);
    const off = setup({ modules: {} });
    expect((await off.b.get("/my-shop/pages/about")).status).toBe(404);
    expect(await (await off.b.get("/my-shop")).text()).not.toContain("/pages/about");
  });

  it("サイトマップに公開中のページを載せる（モジュールが ON のショップだけ）", async () => {
    const { b } = setup();
    const xml = await (await b.get("/sitemap-pages.xml")).text();
    expect(xml).toContain(`<loc>${BASE}/my-shop/pages/about</loc>`);
    expect(xml).toContain(`<loc>${BASE}/my-shop/pages/faq</loc>`);
    expect(xml).not.toContain("/pages/draft");
    expect(await (await setup({ modules: {} }).b.get("/sitemap-pages.xml")).text()).not.toContain("/pages/");
  });

  it("お店の画面の使い方が checkout のショップでは外のサイトへ回す", async () => {
    const { b } = setup({ storefront: { mode: "checkout", site_url: "https://wp.example/" } });
    const res = await b.get("/my-shop/pages/about");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://wp.example/");
  });
});

describe("ショップのページ（Liquid のテーマ）", () => {
  const files: Record<string, string> = {
    "layout/theme.liquid": `<html><head>{{ content_for_header }}</head><body><nav>{% for l in linklists['main-menu'].links %}<a class="m{% if l.active %} on{% endif %}" href="{{ l.url }}">{{ l.title }}</a>{% endfor %}</nav><main>{{ content_for_layout }}</main><footer>{% for l in linklists.footer.links %}<a class="f" href="{{ l.url }}">{{ l.title }}</a>{% endfor %}</footer></body></html>`,
    "templates/index.liquid": "<h1>top</h1>",
    "templates/page.liquid": `<article class="pg" data-t="{{ template }}" data-n="{{ template.name }}"><h1>{{ page.title }}</h1>{{ page.content }}</article>`,
    "templates/page.faq.liquid": `<section class="faq" data-t="{{ template }}" data-s="{{ template.suffix }}">{{ page.content }}</section>`,
  };

  it("templates/page で描き、template_suffix があれば templates/page.<suffix>。メニューに足す（今のページは active）", async () => {
    const { b } = setup({ liquid: files });
    const about = await (await b.get("/pages/about")).text();
    expect(about).toContain('<article class="pg" data-t="page" data-n="page"><h1>私たちについて</h1><h3>店のこと</h3>');
    expect(about).toContain('<a class="m on" href="/pages/about">私たちについて</a>');
    expect(about).toContain('<footer><a class="f" href="/pages/faq">よくある質問</a><a class="f" href="/legal">');
    const faq = await (await b.get("/pages/faq")).text();
    expect(faq).toContain('<section class="faq" data-t="page.faq" data-s="faq"><ul><li>質問 1</li></ul></section>');
  });

  it("選んだテンプレートがテーマに無ければ templates/page で描く", async () => {
    const { b } = setup({ liquid: Object.fromEntries(Object.entries(files).filter(([k]) => k !== "templates/page.faq.liquid")) });
    expect(await (await b.get("/pages/faq")).text()).toContain('<article class="pg" data-t="page" data-n="page"><h1>よくある質問</h1>');
  });
});
