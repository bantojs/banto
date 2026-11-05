import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";
import { markdownToHtml } from "../src/pages/markdown";
import { appBlocksOf, appLine, fillAppBlocks, parseAppLine } from "../src/pages/blocks";
import { parseManifest } from "../src/hooks/manifest";
import { pageEditorClient } from "../src/content/editor-client";

/** 外部プラグインが提案するブロック（`::: app`、0086、docs/app-data.md §6） */
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";
afterEach(forgetThemes);

describe("「::: app」の書式", () => {
  it("連携とブロックの名前・product・設定の値・style を読み、形が違えば文字のまま", () => {
    expect(parseAppLine("::: app reviews stars product=tee layout=summary limit=5 style=card")).toEqual({ app: "reviews", block: "stars", product: "tee", settings: { layout: "summary", limit: "5" }, style: "card" });
    for (const bad of [
      "::: app reviews stars",
      "::: app Reviews stars product=tee",
      "::: app reviews stars product=Tee",
      '::: app reviews stars product=tee note="x y"',
      "::: app reviews stars product=tee x=<b>",
      "::: app reviews stars product=tee Bad=1",
      "::: app reviews product=tee",
    ])
      expect(parseAppLine(bad), bad).toBeNull();
    expect(appLine({ app: "reviews", block: "stars", product: "tee", settings: { limit: "5" }, style: null })).toBe("::: app reviews stars product=tee limit=5");
    expect(appBlocksOf("::: app a b product=x\n::: app a b product=y\n::: app a b product=z").map((b) => b.product)).toEqual(["x", "y"]);
  });

  it("変換は印（2 つまで）と目印の class。本文の文字からは印を作れない。編集の形から同じ書式に戻る", () => {
    const md = "::: app reviews stars product=tee layout=list limit=3\n\n::: app size-guide size-table product=tee\n\n::: app x y product=tee";
    const html = markdownToHtml(md);
    expect(html).toContain('<div class="banto-app banto-app--reviews-stars" data-banto-block="app" data-app="reviews" data-block="stars" data-product="tee" data-settings="{&quot;layout&quot;:&quot;list&quot;,&quot;limit&quot;:&quot;3&quot;}"><!--banto:app:0--></div>');
    expect(html.match(/<!--banto:app:\d-->/g)).toEqual(["<!--banto:app:0-->", "<!--banto:app:1-->"]);
    expect(fillAppBlocks(html, ["<p>A</p>"])).not.toContain("<!--banto");
    expect(markdownToHtml("<!--banto:app:0-->")).toBe("<p>&lt;!--banto:app:0--&gt;</p>");
    // 編集の形（説明の箱）→ 書式
    const { toMarkdown } = pageEditorClient();
    const editor = markdownToHtml(md, { editor: true, appLabel: () => "箱" });
    expect(markdownToHtml(toMarkdown(parse(editor) as never), {})).toBe(html);
  });
});

describe("マニフェストの blocks", () => {
  it("決まった形だけ受ける（id・kind・設定の欄は数と選択肢だけ、product / style は使えない）", () => {
    const m = parseManifest({
      name: "レビュー",
      blocks: [
        { id: "stars", label: "星", kind: "reviews.v1", fields: [{ key: "tone", label: "色", type: "select", options: [{ value: "gold", label: "金" }, { value: "<x>" }], default: "gold" }, { key: "product", type: "number" }, { key: "n", type: "number", min: 1, max: 9, default: 3 }, { key: "t", type: "text" }] },
        { id: "Bad", kind: "reviews.v1" },
        { id: "table", kind: "qa.v1" },
        { id: "size-table", label: "サイズ表", kind: "custom.v1", description: "採寸" },
        { id: "stars", kind: "custom.v1" },
      ],
    })!;
    expect(m.blocks).toEqual([
      { id: "stars", label: "星", kind: "reviews.v1", fields: [{ key: "tone", label: "色", type: "select", options: [{ value: "gold", label: "金" }], default: "gold" }, { key: "n", label: "n", type: "number", min: 1, max: 9, default: "3" }] },
      { id: "size-table", label: "サイズ表", kind: "custom.v1", description: "採寸", fields: [] },
    ]);
    expect(parseManifest({ name: "x" })).not.toHaveProperty("blocks");
  });
});

const reviews = {
  rating_avg: 4.5,
  rating_count: 12,
  items: [
    { id: "r1", rating: 5, title: "最高", body: "<b>着心地</b>がよい", author_display: "T さん", created_at: "2026-10-01T00:00:00Z" },
    { id: "r2", rating: 4, body: "ふつう", author_display: "K さん", created_at: "2026-10-02T00:00:00Z" },
  ],
};

function setup(body: string, opts: { liquid?: Record<string, string> } = {}) {
  forgetThemes();
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { pages: true } } });
  const p = sb.addProduct(shop.id, { slug: "tee", name: "T シャツ", published: true });
  sb.addSku(shop.id, p.id, { code: "TEE", price_jpy: 3000, available: 3 });
  sb.tables.hook_endpoints.push({ id: "ep-r", shop_id: shop.id, name: "レビュー", url: "https://r.example/b", events: [], enabled: true, settings: {}, manifest: null, app_handle: "reviews", created_at: "" });
  sb.tables.hook_endpoints.push({ id: "ep-s", shop_id: shop.id, name: "サイズ", url: "https://s.example/b", events: [], enabled: true, settings: {}, manifest: null, app_handle: "size-guide", created_at: "" });
  sb.tables.app_data.push({ shop_id: shop.id, endpoint_id: "ep-r", product_id: p.id, kind: "reviews.v1", key: "", data: reviews, public: true, updated_at: "" });
  sb.tables.app_data.push({ shop_id: shop.id, endpoint_id: "ep-s", product_id: p.id, kind: "custom.v1", key: "size-table", data: { note: "<i>平置き</i>", rows: [{ size: "M", chest: 96 }] }, public: true, updated_at: "" });
  sb.addPage(shop.id, { handle: "voice", title: "お客様の声", body });
  const storage = new MemoryStorage(`${BASE}/media`);
  if (opts.liquid) {
    sb.sitePlan = "paid";
    const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
    row["domain"] = "shop.example.jp";
    row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
    void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files: opts.liquid, assets: [] })).buffer as ArrayBuffer, "application/json");
  }
  const app = appWith(sb, {}, storage, new FakeStripe());
  return { sb, app, b: new Browser(app, opts.liquid ? DOMAIN : BASE) };
}

describe("お店の画面のプラグインのブロック", () => {
  it("既定のテーマ: reviews.v1 は一覧（limit 件）か星と件数。custom.v1 と知らない連携・無い商品は何も出さない", async () => {
    const { b } = setup("前\n\n::: app reviews reviews product=tee limit=1\n\n::: app size-guide size-table product=tee");
    const html = await (await b.get("/my-shop/pages/voice")).text();
    expect(html).toContain('class="banto-app banto-app--reviews-reviews"');
    expect(html).toContain("&lt;b&gt;着心地&lt;/b&gt;がよい");
    expect(html).not.toContain("ふつう");
    expect(html).not.toContain("平置き");
    expect(html).not.toContain("<!--banto");
    const summary = await (await setup("::: app reviews reviews product=tee layout=summary").b.get("/my-shop/pages/voice")).text();
    expect(summary).toContain('<p class="reviews-summary">');
    expect(summary).toContain('href="/my-shop/products/tee#reviews"');
    expect(summary).not.toContain('<ol class="review-list">');
    const none = await (await setup("::: app other reviews product=tee\n\n::: app reviews reviews product=nothing").b.get("/my-shop/pages/voice")).text();
    expect(none).not.toContain('<p class="reviews-summary">');
  });

  const theme = {
    "layout/theme.liquid": "<!doctype html><html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>",
    "templates/page.liquid": "<article>{{ page.content }}</article>",
  };

  it("Liquid: app-<連携>-<ブロック> → app-<ブロック> の順に snippet を探し、block・product・reviews・data を渡す。無ければ既定", async () => {
    const { b } = setup("::: app size-guide size-table product=tee unit=cm\n\n::: app reviews reviews product=tee", {
      liquid: {
        ...theme,
        "snippets/app-size-guide-size-table.liquid": '<div class="sz" data-unit="{{ block.settings.unit }}">{{ product.title }} {{ data["size-table"].note }}{% for r in data["size-table"].rows %}<b>{{ r.size }}:{{ r.chest }}</b>{% endfor %}</div>',
        "snippets/app-reviews.liquid": '<div class="rv">{{ block.app }} {{ reviews.rating }} {{ reviews.rating_count }} {{ reviews.items[0].body }}</div>',
      },
    });
    const html = await (await b.get("/pages/voice")).text();
    expect(html).toContain('<div class="sz" data-unit="cm">T シャツ &lt;i&gt;平置き&lt;/i&gt;<b>M:96</b></div>');
    expect(html).toContain('<div class="rv">reviews 4.5 12 &lt;b&gt;着心地&lt;/b&gt;がよい</div>');
    const plain = await (await setup("::: app reviews reviews product=tee", { liquid: theme }).b.get("/pages/voice")).text();
    expect(plain).toContain('<ol class="review-list">');
  });

  it("ヘッドレスのページの html は既定の見た目", async () => {
    const { app } = setup("::: app reviews reviews product=tee layout=summary");
    const r = (await (await app.request(`${BASE}/api/shops/my-shop/pages/voice`)).json()) as { page: { html: string } };
    expect(r.page.html).toContain('<p class="reviews-summary">');
  });
});

describe("編集の画面", () => {
  it("名前のある有効な連携のマニフェストの blocks を data-apps で渡し、ダイアログを出す。ブロックの無いショップには出さない", async () => {
    const { sb, app } = setup("");
    const ep = sb.tables.hook_endpoints.find((e) => e["id"] === "ep-r")!;
    ep["manifest"] = { name: "レビュー", events: [], settings: [], blocks: [{ id: "reviews", label: "レビュー", kind: "reviews.v1", fields: [] }] };
    const page = sb.tables.pages[0]!;
    const shopId = String(page["shop_id"]);
    const login = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await login.get(`/admin/shops/${shopId}/modules/pages/${String(page["id"])}`)).text();
    expect(html).toContain('id="blk-app"');
    const apps = JSON.parse(decode(html.match(/data-apps="([^"]*)"/)![1]!)) as { app: string; blocks: { id: string }[] }[];
    expect(apps).toEqual([{ app: "reviews", name: "レビュー", blocks: [expect.objectContaining({ id: "reviews", kind: "reviews.v1" })] }]);
    ep["enabled"] = false;
    const off = await (await login.get(`/admin/shops/${shopId}/modules/pages/${String(page["id"])}`)).text();
    expect(off).not.toContain('id="blk-app"');
  });
});

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** 最小の DOM（属性・子・文字。属性の値も実体参照を戻す） */
function parse(html: string) {
  type N = { nodeType: number; nodeName: string; childNodes: N[]; textContent: string | null; getAttribute(k: string): string | null };
  const VOID = new Set(["BR", "IMG", "HR"]);
  const mk = (name: string, attrs: Record<string, string>): N => {
    const n: N = { nodeType: 1, nodeName: name, childNodes: [], getAttribute: (k) => attrs[k] ?? null, get textContent() { return n.childNodes.map((c) => c.textContent ?? "").join(""); } } as N;
    return n;
  };
  const root = mk("DIV", {});
  const stack = [root];
  for (const m of html.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g)) {
    const top = stack[stack.length - 1]!;
    if (m[3] !== undefined) {
      top.childNodes.push({ nodeType: 3, nodeName: "#text", childNodes: [], textContent: decode(m[3]), getAttribute: () => null });
      continue;
    }
    const name = m[1]!.toUpperCase();
    if (m[0].startsWith("</")) {
      const i = stack.map((x) => x.nodeName).lastIndexOf(name);
      if (i > 0) stack.length = i;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of m[2]!.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[a[1]!] = decode(a[2]!);
    const n = mk(name, attrs);
    top.childNodes.push(n);
    if (!VOID.has(name)) stack.push(n);
  }
  return root;
}
