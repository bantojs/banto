import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, appWith } from "./helpers";
import { PAGES_PUBLISHING_MIGRATION } from "../src/pages";

/** ヘッドレスの公開 API: ページ（0079）とブログ・記事（0081）。docs/headless.md「ページ・ブログ」 */
function setup(modules: Record<string, boolean> = { pages: true, blog: true }) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "読みもののお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules, storefront: "off", external_site_url: "https://www.example.jp" } });
  const p = sb.addProduct(shop.id, { slug: "tee", name: "T シャツ", published: true, tags: ["new"] });
  sb.addSku(shop.id, p.id, { code: "TEE", price_jpy: 3000, available: 3 });
  sb.addPage(shop.id, { handle: "about", title: "私たちについて", nav: "footer", sort_order: 2, image_url: "/media/pages/x/eye.webp", body: "## ようこそ\n\n![外観](https://admin.example.workers.dev/media/pages/x/a.webp)\n\n::: products tag=new limit=4\n\n[送料](/shipping)" });
  sb.addPage(shop.id, { handle: "faq", title: "よくある質問", sort_order: 1, body: "本文" });
  sb.addPage(shop.id, { handle: "draft", title: "下書き", published: false });
  const blog = sb.addBlog(shop.id, { handle: "news", title: "お知らせ", description: "お店のお知らせ" });
  for (let i = 1; i <= 13; i++) sb.addArticle(shop.id, blog.id, { handle: `post-${i}`, title: `記事 ${i}`, body: `本文 ${i}`, tags: i % 2 ? ["セール"] : [], published_at: new Date(Date.UTC(2026, 9, i)).toISOString() });
  sb.addArticle(shop.id, blog.id, { handle: "future", title: "未来", published_at: new Date(Date.now() + 86400_000).toISOString() });
  const app = appWith(sb);
  const get = async (path: string) => {
    const res = await app.request(`${BASE}/api/shops/my-shop${path}`, { headers: { origin: "https://www.example.jp" } });
    return { status: res.status, cors: res.headers.get("access-control-allow-origin"), json: (await res.json()) as Record<string, unknown> };
  };
  return { sb, shop, get };
}

describe("ヘッドレスの公開 API: ページ・ブログ", () => {
  it("ページの一覧（公開中だけ・並び順・本文なし）と 1 つ（書式と HTML）。お店の画面を使わないショップでも読める", async () => {
    const { get } = setup();
    const list = await get("/pages");
    expect(list.status).toBe(200);
    expect(list.cors).toBe("*");
    const pages = list.json["pages"] as Record<string, unknown>[];
    expect(pages.map((p) => p["handle"])).toEqual(["faq", "about"]);
    expect(pages[1]).toMatchObject({ title: "私たちについて", nav: "footer", url: `${BASE}/my-shop/pages/about`, image_url: `${BASE}/media/pages/x/eye.webp` });
    expect(pages[1]).not.toHaveProperty("body");

    const one = await get("/pages/about");
    const page = one.json["page"] as Record<string, string>;
    expect(page["body"]).toContain("::: products tag=new");
    // 画像はこの Banto の絶対 URL、商品のカードはショップの絶対 URL、本文のリンクは書いたまま
    expect(page["html"]).toContain(`<img src="${BASE}/media/pages/x/a.webp"`);
    expect(page["html"]).toContain(`href="${BASE}/my-shop/p/tee"`);
    expect(page["html"]).toContain("T シャツ");
    expect(page["html"]).toContain('<a href="/shipping">送料</a>');
    expect(page["html"]).not.toContain("<!--banto:products");
    expect((await get("/pages/draft")).status).toBe(404);
    expect((await get("/pages/nothing")).status).toBe(404);
  });

  it("ブログの一覧、記事の一覧（新しい順に 12 本・次のページ・タグ・予約は出ない）、記事 1 つ", async () => {
    const { get } = setup();
    expect(((await get("/blogs")).json["blogs"] as Record<string, unknown>[]).map((b) => b["handle"])).toEqual(["news"]);
    const first = await get("/blogs/news/articles");
    const items = first.json["articles"] as Record<string, unknown>[];
    expect(items).toHaveLength(12);
    expect(items[0]).toMatchObject({ handle: "post-13", url: `${BASE}/my-shop/blogs/news/post-13`, summary: "本文 13" });
    expect(first.json).toMatchObject({ page: 1, per_page: 12, has_next: true, blog: { handle: "news", description: "お店のお知らせ" } });
    const second = await get("/blogs/news/articles?page=2");
    expect((second.json["articles"] as Record<string, unknown>[]).map((a) => a["handle"])).toEqual(["post-1"]);
    expect(second.json["has_next"]).toBe(false);
    expect(((await get("/blogs/news/articles?tag=セール")).json["articles"] as unknown[]).length).toBe(7);
    const art = await get("/blogs/news/articles/post-3");
    expect(art.json["article"]).toMatchObject({ handle: "post-3", body: "本文 3", html: "<p>本文 3</p>" });
    expect((await get("/blogs/news/articles/future")).status).toBe(404);
    expect((await get("/blogs/none/articles")).status).toBe(404);
  });

  it("モジュールが OFF なら 404。0080 を当てる前でもページの一覧を読める", async () => {
    const off = setup({});
    expect((await off.get("/pages")).status).toBe(404);
    expect((await off.get("/blogs")).status).toBe(404);
    expect((await off.get("/blogs/news/articles/post-1")).status).toBe(404);
    const old = setup({ pages: true });
    old.sb.appliedMigrations = old.sb.appliedMigrations.filter((v) => v !== PAGES_PUBLISHING_MIGRATION);
    const r = await old.get("/pages");
    expect(r.status).toBe(200);
    expect((r.json["pages"] as Record<string, unknown>[]).map((p) => p["handle"])).toEqual(["faq", "about"]);
  });
});
