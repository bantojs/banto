import { describe, expect, it } from "vitest";
import { createThemeEngine } from "../src/themes/liquid/engine";
import { checkThemeBundle } from "../src/themes/liquid/bundle";
import { extendShopify, withRenderEnv, type RenderEnv } from "../src/themes/liquid/shopify";

/** Shopify と同じ名前のフィルター・タグ（docs/themes.md）。中身は Banto のデータで作る */
function render(src: string, scope: Record<string, unknown> = {}, locales: Record<string, unknown> = {}) {
  const engine = createThemeEngine({}, { extend: extendShopify, timezone: "Asia/Tokyo" });
  const env: RenderEnv = { engine, versionId: "v1", shopOrigin: "https://shop.example.jp", shopPath: "", mediaBaseUrl: "https://m.example", locales, schemas: new Map(), globals: {}, paginate: null, preview: false, errors: [] };
  return withRenderEnv(env, () => engine.renderString(src, scope));
}

describe("Shopify の名前のフィルター", () => {
  it("金額は最小の単位の 100 倍（¥1,200 = 120000）", () => {
    expect(render("{{ 120000 | money }}|{{ 120000 | money_with_currency }}|{{ 120000 | money_without_currency }}|{{ -5000 | money }}|{{ 0 | money }}")).toBe("¥1,200|¥1,200 JPY|1,200|-¥50|¥0");
  });

  it("画像: 幅 400 以下はサムネイル、それより大きければ本画像。image_tag は大きさと代わりの文字", () => {
    const img = { key: "a.webp", thumb_key: "a.t.webp", width: 1600, height: 1200, alt: '"x"' };
    expect(render("{{ img | image_url: width: 400 }}|{{ img | image_url: width: 800 }}|{{ img | img_url: '300x' }}", { img })).toBe("https://m.example/a.t.webp|https://m.example/a.webp|https://m.example/a.t.webp");
    expect(render("{{ img | image_url: width: 400 | image_tag: class: 'c', loading: 'eager' }}", { img })).toBe('<img src="https://m.example/a.t.webp" alt="&quot;x&quot;" width="400" height="300" loading="eager" class="c">');
    expect(render("{{ product | image_url: width: 100 }}", { product: { featured_image: img } })).toBe("https://m.example/a.t.webp");
    expect(render("{{ nope | image_url }}")).toBe("");
  });

  it("資産の URL はショップのドメインの /_theme/<版>/assets/。タグはエスケープ", () => {
    expect(render("{{ 'a b.css' | asset_url }}")).toBe("https://shop.example.jp/_theme/v1/assets/a%20b.css");
    expect(render("{{ 'x.css' | asset_url | stylesheet_tag }}{{ 'x.js' | asset_url | script_tag }}")).toBe('<link rel="stylesheet" href="https://shop.example.jp/_theme/v1/assets/x.css" media="all"><script src="https://shop.example.jp/_theme/v1/assets/x.js"></script>');
  });

  it("翻訳: 鍵・差し込み・数・_html の鍵だけ HTML。無い鍵は translation missing", () => {
    const loc = { a: { hello: "こんにちは {{ name }}", items: { one: "{{ count }} 点", other: "{{ count }} 点（複数）" }, note_html: "<b>{{ x }}</b>" } };
    expect(render("{{ 'a.hello' | t: name: n }}", { n: "<i>" }, loc)).toBe("こんにちは &lt;i&gt;");
    expect(render("{{ 'a.items' | t: count: 1 }}/{{ 'a.items' | t: count: 3 }}", {}, loc)).toBe("1 点/3 点（複数）");
    expect(render("{{ 'a.note_html' | t: x: v }}", { v: "<script>" }, loc)).toBe("<b>&lt;script&gt;</b>");
    expect(render("{{ 'a.none' | t }}", {}, loc)).toBe("translation missing: a.none");
  });

  it("json は <script> から抜けられない（< > & を逃がす）。handleize・pluralize・link_to", () => {
    expect(render("{{ x | json }}", { x: { a: "</script><b>&" } })).toBe('{"a":"\\u003c/script\\u003e\\u003cb\\u003e\\u0026"}');
    expect(render("{{ 'Tシャツ 100% Cotton!' | handleize }}")).toBe("tシャツ-100-cotton");
    expect(render("{{ 1 | pluralize: 'item', 'items' }} {{ 2 | pluralize: 'item', 'items' }}")).toBe("item items");
    expect(render("{{ '<b>' | link_to: '/p?a=1&b=2', 't\"' }}")).toBe('<a href="/p?a=1&amp;b=2" title="t&quot;">&lt;b&gt;</a>');
  });
});

describe("Shopify の名前のタグ", () => {
  it("style・stylesheet・javascript・schema（中身は出さない）・layout none", () => {
    expect(render("{% style %}a{color:{{ c }}}{% endstyle %}", { c: "red" })).toBe("<style>a{color:red}</style>");
    expect(render("{% stylesheet %}.a{}{% endstylesheet %}{% javascript %}var a=1;{% endjavascript %}")).toBe("<style>.a{}</style><script>var a=1;</script>");
    expect(render("{% javascript %}</script><script>x{% endjavascript %}")).toBe("");
    expect(render('x{% schema %}{"name": "a"}{% endschema %}y')).toBe("xy");
  });

  it("知らないタグ・Shopify の未対応のタグ（content_for）は解析で止まり、テーマの取り込みで断る", () => {
    const files = { "layout/theme.liquid": "{{ content_for_layout }}", "templates/index.liquid": "{% content_for 'blocks' %}" };
    const r = checkThemeBundle({ format: 1, files, assets: [] }, { extend: extendShopify });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/^templates\/index\.liquid: /);
    expect(checkThemeBundle({ format: 1, files: { ...files, "templates/index.liquid": "{% section 'a' %}{% form 'product', product, id: 'f' %}{% endform %}{% paginate collection.products by 12 %}{% endpaginate %}{{ 1 | money }}" }, assets: [] }, { extend: extendShopify }).errors).toEqual([]);
  });
});
