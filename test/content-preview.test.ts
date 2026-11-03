import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith, followPreview } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";

/** ページ・記事のプレビュー（src/content/preview.tsx・preview-ticket.ts）: 公開中のショップはお店の画面のオリジンで、本物と同じテーマで描く */

const VERSION = "11111111-2222-4333-8444-555555555555";
const LIQUID = {
  "layout/theme.liquid": `<html><head>{{ content_for_header }}</head><body><header class="liquid-head">{{ shop.name }}</header><main>{{ content_for_layout }}</main></body></html>`,
  "templates/index.liquid": "<h1>top</h1>",
  "templates/page.liquid": `<article class="liquid-page"><h1>{{ page.title }}</h1>{{ page.content }}</article>`,
  "templates/article.liquid": `<article class="liquid-article"><h1>{{ article.title }}</h1>{{ article.content }}</article>`,
};

function setup(opts: { liquid?: boolean; published?: boolean; id?: string } = {}) {
  forgetThemes();
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "テストの店", published: opts.published ?? true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { pages: true, blog: true } }, ...(opts.id ? { id: opts.id } : {}) });
  sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const storage = new MemoryStorage(`${BASE}/media`);
  if (opts.liquid) {
    sb.sitePlan = "paid";
    const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
    row["domain"] = "shop.example.jp";
    row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
    void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files: LIQUID, assets: [] })).buffer as ArrayBuffer, "application/json");
  }
  const app = appWith(sb, {}, storage);
  return { sb, shop, app, pages: `/admin/shops/${shop.id}/modules/pages`, blogs: `/admin/shops/${shop.id}/modules/blog` };
}

const page = { title: "下書きのページ", handle: "draft", body: "## 見出し\n\n::: product slug=tee show=name", nav: "", sort_order: "0", action: "preview" };

describe("ページ・記事のプレビュー", () => {
  it("Liquid のテーマのショップは、独自ドメインの上でそのテーマで描く（保存しない・分析のタグを入れない）", async () => {
    const { sb, app, shop, pages, blogs } = setup({ liquid: true });
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const handoff = await owner.post(pages, page);
    const html0 = await handoff.clone().text();
    expect(html0).toContain('action="https://shop.example.jp/_preview/content"');
    const res = await followPreview(app, handoff);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const html = await res.text();
    expect(html).toContain('<header class="liquid-head">テストの店</header>');
    expect(html).toContain('<article class="liquid-page"><h1>下書きのページ</h1>');
    expect(html).toContain("<h2>見出し</h2>");
    expect(html).toContain("Tシャツ");
    expect(html).toContain("お店の画面と同じテーマで描いています");
    expect(sb.tables.pages).toHaveLength(0);

    const blog = sb.addBlog(shop.id, { handle: "news", title: "お知らせ" });
    const art = await (await followPreview(app, await owner.post(`${blogs}/${blog.id}/articles`, { title: "下書きの記事", handle: "a1", body: "本文です", action: "preview" }))).text();
    expect(art).toContain('<article class="liquid-article"><h1>下書きの記事</h1>');
    expect(art).toContain("本文です");
    expect(sb.tables.articles).toHaveLength(0);
  });

  it("券と下書きが合わなければ描かない（書き換えた下書き・ほかのショップ・券なし）", async () => {
    const { app, pages } = setup();
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const handoff = await owner.post(pages, page);
    const text = await handoff.text();
    const again = () => new Response(text, { headers: { "content-type": "text/html" } });
    expect((await followPreview(app, again())).status).toBe(200);
    expect((await followPreview(app, again(), (f) => (f["draft"] = f["draft"]!.replace("見出し", "書き換え")))).status).toBe(404);
    expect((await followPreview(app, again(), (f) => delete f["token"])).status).toBe(404);
    // 同じ slug でも別のショップ（id が違う）では描かない
    const other = setup({ id: "shop-other" });
    expect((await followPreview(other.app, again())).status).toBe(404);
  });

  it("非公開のショップは管理画面で既定のテーマで描く（送り出さない）", async () => {
    const { app, pages } = setup({ published: false });
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await owner.post(pages, page)).text();
    expect(html).not.toContain("_preview/content");
    expect(html).toContain("<h2>見出し</h2>");
    expect(html).toContain("公開すると");
  });
});
