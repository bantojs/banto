import { beforeEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, MemoryStorage, appWith } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";

/** お店の画面を Liquid のテーマで描く（docs/themes.md）。テーマは Shopify と同じ書き方の小さなもの（このテストのために書いた） */
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";

const theme = (over: Record<string, string> = {}) => ({
  format: 1,
  assets: ["theme.css", "app.js"],
  files: {
    "layout/theme.liquid": `<!doctype html><html><head><title>{{ page_title }} | {{ shop.name }}</title>{{ content_for_header }}{{ 'theme.css' | asset_url | stylesheet_tag }}</head><body style="--accent: {{ settings.accent }}"><nav>{% for link in linklists['main-menu'].links %}<a href="{{ link.url }}">{{ link.title }}</a>{% endfor %}</nav><main>{{ content_for_layout }}</main><footer>{% for link in linklists.footer.links %}<a href="{{ link.url }}">{{ link.title }}</a>{% endfor %}</footer></body></html>`,
    "templates/index.json": JSON.stringify({ sections: { main: { type: "main-collection", settings: { heading: "おすすめ" } } }, order: ["main"] }),
    "templates/collection.liquid": `<h1>{{ collection.title }}</h1>{% section 'main-collection' %}`,
    "templates/product.liquid": `<h1>{{ product.title }}</h1><div class="desc">{{ product.description }}</div>{% form 'product', product, id: 'product-form' %}<select name="id">{% for v in product.variants %}<option value="{{ v.id }}"{% if v.id == product.selected_or_first_available_variant.id %} selected{% endif %}>{{ v.title }} {{ v.price | money }}</option>{% endfor %}</select><input name="quantity" value="1"><button>{{ 'products.add_to_cart' | t }}</button>{% endform %}`,
    "templates/404.liquid": `<h1>{{ 'general.404' | t }}</h1>`,
    "sections/main-collection.liquid": `<h2>{{ section.settings.heading }}</h2>{% paginate collection.products by 48 %}<ul>{% for product in collection.products %}{% render 'card', product: product %}{% endfor %}</ul>{% if paginate.next %}<a class="next" href="{{ paginate.next.url }}">次</a>{% endif %}{% endpaginate %}{% schema %}{"name": "一覧", "settings": [{"id": "heading", "type": "text", "default": "商品"}, {"id": "columns", "type": "range", "default": 3}]}{% endschema %}`,
    "snippets/card.liquid": `<li class="card"><a href="{{ product.url }}">{% if product.featured_image %}{{ product.featured_image | image_url: width: 400 | image_tag }}{% endif %}<span>{{ product.title }}</span> <b>{{ product.price | money }}</b></a></li>`,
    "locales/ja.json": JSON.stringify({ products: { add_to_cart: "カートに入れる" }, general: { "404": "見つかりません" } }),
    "config/settings_schema.json": JSON.stringify([{ name: "theme_info" }, { name: "色", settings: [{ id: "accent", type: "color", default: "#123456" }] }]),
    ...over,
  },
});

function setup(opts: { plan?: "free" | "paid"; bundle?: unknown; settings?: Record<string, unknown> } = {}) {
  forgetThemes();
  const sb = new FakeSupabase();
  sb.sitePlan = opts.plan ?? "paid";
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "s", name: "テストのお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
  row["domain"] = "shop.example.jp";
  row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: opts.settings ?? {} };
  const cat = sb.addCategory(shop.id, { slug: "tops", name: "トップス" });
  const p = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ <b>", published: true, description: "綿 100%\n洗えます", category_id: cat.id });
  const s1 = sb.addSku(shop.id, p.id, { code: "TEE-S", name: "S", price_jpy: 1200, available: 3, options: { サイズ: "S" } });
  sb.addSku(shop.id, p.id, { code: "TEE-M", name: "M", price_jpy: 1500, available: 0, options: { サイズ: "M" } });
  sb.tables.product_images.push({ id: "img1", shop_id: shop.id, product_id: p.id, storage_key: "img/tee.webp", thumb_key: "img/tee.t.webp", width: 1600, height: 1200, sort_order: 0, options: {}, created_at: "2026-10-01T00:00:00Z" });
  const storage = new MemoryStorage(`${BASE}/media`);
  void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify(opts.bundle ?? theme())).buffer as ArrayBuffer, "application/json");
  void storage.put(`themes/${shop.id}/${VERSION}/assets/theme.css`, new TextEncoder().encode("body{}").buffer as ArrayBuffer, "text/css");
  const app = appWith(sb, {}, storage);
  const get = async (url: string) => {
    const res = await app.request(url);
    return { status: res.status, html: await res.text(), res };
  };
  return { sb, shop, p, s1, app, get, storage };
}

describe("お店の画面を Liquid のテーマで描く", () => {
  beforeEach(forgetThemes);

  it("トップ: JSON のテンプレートのセクション・部品・ページ送り・メニュー・設定の既定値・金額。商品名はエスケープ", async () => {
    const { get } = setup();
    const { status, html } = await get(`${DOMAIN}/`);
    expect(status).toBe(200);
    expect(html).toContain("<title>テストのお店 | テストのお店</title>");
    expect(html).toContain('<div id="section-main" class="theme-section"><h2>おすすめ</h2>');
    expect(html).toContain("<span>Tシャツ &lt;b&gt;</span> <b>¥1,200</b>");
    expect(html).toContain(`<img src="${BASE}/media/img/tee.t.webp" alt="Tシャツ &lt;b&gt;" width="400" height="300" loading="lazy">`);
    expect(html).toContain('href="/p/tee"');
    expect(html).toContain('<a href="/?category=tops">トップス</a>');
    expect(html).toContain('<a href="/legal">特定商取引法に基づく表記</a>');
    expect(html).toContain("--accent: #123456");
    expect(html).toContain(`<link rel="canonical" href="${DOMAIN}">`);
    expect(html).toContain(`<link rel="stylesheet" href="${DOMAIN}/_theme/${VERSION}/assets/theme.css" media="all">`);
  });

  it("運営者が選んだ設定の値が既定値より優先される", async () => {
    const { html } = await (setup({ settings: { accent: "#c33" } })).get(`${DOMAIN}/`);
    expect(html).toContain("--accent: #c33");
  });

  it("カテゴリーは templates/collection（{% section %} はスキーマの既定値）", async () => {
    const { html } = await setup().get(`${DOMAIN}/?category=tops`);
    expect(html).toContain("<h1>トップス</h1>");
    expect(html).toContain('<div id="section-main-collection" class="theme-section"><h2>商品</h2>');
    expect(html).toContain(`<link rel="canonical" href="${DOMAIN}?category=tops">`);
  });

  it("商品: バリエーション（SKU）・カートのフォーム（Shopify の名前 id / quantity）・翻訳・説明（エスケープして改行）・構造化データ", async () => {
    const { get, s1 } = setup();
    const { html } = await get(`${DOMAIN}/p/tee`);
    expect(html).toContain("<h1>Tシャツ &lt;b&gt;</h1>");
    expect(html).toContain('<div class="desc">綿 100%<br>洗えます</div>');
    expect(html).toContain('<form method="post" action="/cart/add" accept-charset="UTF-8" id="product-form"><input type="hidden" name="form_type" value="product">');
    expect(html).toContain(`<option value="${s1.id}" selected>S ¥1,200</option>`);
    expect(html).toContain("M ¥1,500</option>");
    expect(html).toContain("<button>カートに入れる</button>");
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).toContain('"@type":"Product"');
  });

  it("Shopify の名前のフォーム（id / quantity）でカートに入る", async () => {
    const { app, s1 } = setup();
    const res = await app.request(`${DOMAIN}/cart/add`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: DOMAIN }, body: new URLSearchParams({ id: s1.id, quantity: "2", form_type: "product" }) });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/p/tee?added=1&sku=TEE-S&qty=2");
    expect(res.headers.get("set-cookie")).toContain("Path=/");
  });

  it("request.path・template はショップのドメインの道（スラッグなし）。ページ送りの番号は件数から", async () => {
    const { get, sb, shop } = setup({
      bundle: theme({
        "templates/collection.liquid": `[{{ request.path }}|{{ template }}|{% if template == 'collection' %}C{% endif %}|{{ template.name }}]{% section 'main-collection' %}`,
        "sections/main-collection.liquid": `{% paginate collection.products by 48 %}<p class="pages">{{ paginate.pages }}|{{ paginate.current_page }}|{% for part in paginate.parts %}{{ part.title }}{% endfor %}</p>{% endpaginate %}`,
      }),
    });
    const cat = sb.tables.categories[0]!;
    for (let i = 0; i < 50; i++) sb.addProduct(shop.id, { slug: `x${i}`, name: `X${i}`, published: true, category_id: cat["id"] });
    const { html } = await get(`${DOMAIN}/?category=tops`);
    expect(html).toContain("[/|collection|C|collection]");
    // 51 件・48 件ずつ → 2 ページ。Banto は位置で進むので、番号の部品は今のページと「次」だけ
    expect(html).toContain('<p class="pages">2|1|1»</p>');
  });

  it("静的なセクションは settings_data.json の current.sections の値とブロックを使う。richtext の設定は HTML のまま、text はエスケープ", async () => {
    const { html } = await setup({
      bundle: theme({
        "templates/index.json": JSON.stringify({ sections: { top: { type: "top" } }, order: ["top"] }),
        "sections/top.liquid": `{% section 'banner' %}`,
        "sections/banner.liquid": `<h2>{{ section.settings.heading }}</h2><div class="rt">{{ section.settings.body }}</div>{% for b in section.blocks %}<i>{{ b.settings.label }}</i>{% endfor %}{{ section.index }}{% schema %}{"settings": [{"id": "heading", "type": "text", "default": "既定"}, {"id": "body", "type": "richtext", "default": "<p>既定</p>"}], "blocks": [{"type": "item", "settings": [{"id": "label", "type": "text"}]}]}{% endschema %}`,
        "config/settings_data.json": JSON.stringify({ current: { sections: { banner: { type: "banner", settings: { heading: "<b>見出し</b>", body: "<p>本文</p>" }, blocks: { a: { type: "item", settings: { label: "一" } }, b: { type: "item", settings: { label: "二" } } }, block_order: ["a", "b", "a"] } } } }),
      }),
    }).get(`${DOMAIN}/`);
    expect(html).toContain("<h2>&lt;b&gt;見出し&lt;/b&gt;</h2>");
    expect(html).toContain('<div class="rt"><p>本文</p></div>');
    expect(html).toContain("<i>一</i><i>二</i>1");
  });

  it("JSON のテンプレートのセクション・ブロックの数には上限がある（同じものを並べても 1 回）", async () => {
    const sections: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) sections[`s${i}`] = { type: "one" };
    const { html } = await setup({
      bundle: theme({
        "templates/index.json": JSON.stringify({ sections, order: [...Object.keys(sections), "s0", "s0"] }),
        "sections/one.liquid": `<u>{{ section.id }}</u>`,
      }),
    }).get(`${DOMAIN}/`);
    expect(html.match(/<u>/g)).toHaveLength(25);
  });

  it("options_with_values の選ばれた値は軸ごとに合う（SKU の options の並びに左右されない）", async () => {
    const { html } = await setup({
      bundle: theme({ "templates/product.liquid": `{% for o in product.options_with_values %}[{{ o.name }}={{ o.selected_value }}:{{ o.values | join: ',' }}]{% endfor %}` }),
    }).get(`${DOMAIN}/p/tee?sku=TEE-M`);
    expect(html).toContain("[サイズ=M:S,M]");
  });

  it("見つからないページはテーマの 404（メニューも出る。canonical はスラッグなし）", async () => {
    const { html } = await setup().get(`${DOMAIN}/p/none`);
    expect(html).toContain('<a href="/?category=tops">トップス</a>');
    expect(html).not.toContain("/s/p/none");
  });

  it("見つからないページはテーマの 404", async () => {
    const { status, html } = await setup().get(`${DOMAIN}/p/none`);
    expect(status).toBe(404);
    expect(html).toContain("<h1>見つかりません</h1>");
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it("描かない: Banto の URL（独自ドメインでない）・無料プラン。既定のテーマ（TSX）で描く", async () => {
    const onBanto = await setup().get(`${BASE}/s`);
    // 独自ドメインのあるショップは Banto の URL からショップのドメインへ転送する
    expect(onBanto.status).toBe(302);
    const free = await setup({ plan: "free" }).get(`${DOMAIN}/`);
    expect(free.status).toBe(200);
    expect(free.html).not.toContain("theme-section");
  });

  it("テーマが壊れている・上限を超えた・その種類のテンプレートが無いときは既定のテーマで描く（お店を止めない）", async () => {
    const broken = await setup({ bundle: "{not json" }).get(`${DOMAIN}/`);
    expect(broken.status).toBe(200);
    expect(broken.html).not.toContain("theme-section");
    const loop = theme({ "templates/index.liquid": "{% for a in (1..5000) %}{% for b in (1..5000) %}.{% endfor %}{% endfor %}" });
    delete (loop.files as Record<string, string>)["templates/index.json"];
    const heavy = await setup({ bundle: loop }).get(`${DOMAIN}/`);
    expect(heavy.status).toBe(200);
    expect(heavy.html).not.toContain("....");
    const noProduct = theme();
    delete (noProduct.files as Record<string, string>)["templates/product.liquid"];
    const fallback = await setup({ bundle: noProduct }).get(`${DOMAIN}/p/tee`);
    expect(fallback.status).toBe(200);
    expect(fallback.html).not.toContain("theme-section");
    expect(fallback.html).toContain("Tシャツ");
  });

  it("セクションの誤りはそのセクションだけを空にする（ページは描く）", async () => {
    const { html, status } = await setup({ bundle: theme({ "sections/main-collection.liquid": "{% render 'missing' %}" }) }).get(`${DOMAIN}/`);
    expect(status).toBe(200);
    expect(html).toContain("<main></main>");
  });

  it("テーマが content_for_header を書かなくても、canonical などは </head> の前に入る", async () => {
    const { html } = await setup({ bundle: theme({ "layout/theme.liquid": "<html><head><title>x</title></head><body>{{ content_for_layout }}</body></html>" }) }).get(`${DOMAIN}/`);
    expect(html).toMatch(/<title>x<\/title><!-- banto:head --><link rel="canonical"[^>]*><\/head>/);
  });

  it("資産はショップのドメインでだけ配る（決まった種類だけ）。テーマの束ねたファイルは配らない", async () => {
    const { get, shop } = setup();
    const css = await get(`${DOMAIN}/_theme/${VERSION}/assets/theme.css`);
    expect(css.status).toBe(200);
    expect(css.res.headers.get("content-type")).toMatch(/^text\/css/);
    expect(css.res.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await get(`${BASE}/s/_theme/${VERSION}/assets/theme.css`)).status).not.toBe(200);
    expect((await get(`${DOMAIN}/_theme/${VERSION}/assets/x.svg`)).status).toBe(404);
    expect((await get(`${DOMAIN}/_theme/${VERSION}/assets/bundle.json`)).status).toBe(404);
    expect((await get(`${DOMAIN}/media/themes/${shop.id}/${VERSION}/bundle.json`)).status).toBe(404);
  });
});
