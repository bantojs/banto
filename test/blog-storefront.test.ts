import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { forgetThemes } from "../src/themes/liquid/cache";
import { articleSummary } from "../src/blog";

/** ブログ（同梱モジュール blog、0081、docs/blog.md）: /blogs/<ブログ>・/blogs/<ブログ>/<記事>・feed.atom を既定のテーマと Liquid のテーマで描く */
const DOMAIN = "https://shop.example.jp";
const VERSION = "11111111-2222-4333-8444-555555555555";
afterEach(forgetThemes);

function setup(opts: { modules?: Record<string, boolean>; liquid?: Record<string, string> } = {}) {
  forgetThemes();
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "ブログのお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: opts.modules ?? { blog: true } } });
  const blog = sb.addBlog(shop.id, { handle: "news", title: "お知らせ", nav: "header", description: "お店のお知らせです。" });
  const day = (d: number) => new Date(Date.UTC(2026, 9, d)).toISOString();
  for (let i = 1; i <= 14; i++) sb.addArticle(shop.id, blog.id, { handle: `post-${i}`, title: `記事 ${i}`, body: `## 見出し\n\n本文 ${i} です。<b>x</b>`, tags: i % 2 ? ["セール"] : ["新作"], published_at: day(i) });
  sb.addArticle(shop.id, blog.id, { handle: "future", title: "未来", published_at: new Date(Date.now() + 86400_000).toISOString() });
  sb.addArticle(shop.id, blog.id, { handle: "draft", title: "下書き", published: false, published_at: null });
  const storage = new MemoryStorage(`${BASE}/media`);
  if (opts.liquid) {
    sb.sitePlan = "paid";
    const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
    row["domain"] = "shop.example.jp";
    row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
    void storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files: opts.liquid, assets: [] })).buffer as ArrayBuffer, "application/json");
  }
  const app = appWith(sb, {}, storage, new FakeStripe());
  return { sb, shop, blog, b: new Browser(app, opts.liquid ? DOMAIN : BASE) };
}

describe("ブログのお店の画面（既定のテーマ）", () => {
  it("一覧は新しい順に 12 件、次のページ、タグで絞る。予約・下書きは出ない。メニューにブログ", async () => {
    const { b } = setup();
    const html = await (await b.get("/my-shop/blogs/news")).text();
    const titles = [...html.matchAll(/<h2>(記事 \d+)<\/h2>/g)].map((m) => m[1]);
    expect(titles).toHaveLength(12);
    expect(titles[0]).toBe("記事 14");
    expect(html).not.toContain("未来");
    expect(html).not.toContain("下書き");
    expect(html).toContain('href="/my-shop/blogs/news?page=2"');
    expect(html).toContain('<a href="/my-shop/blogs/news" style="margin-right:1rem">お知らせ</a>');
    expect(html).toContain('type="application/atom+xml"');
    const p2 = await (await b.get("/my-shop/blogs/news?page=2")).text();
    expect([...p2.matchAll(/<h2>(記事 \d+)<\/h2>/g)].map((m) => m[1])).toEqual(["記事 2", "記事 1"]);
    const tagged = await (await b.get(`/my-shop/blogs/news?tag=${encodeURIComponent("新作")}`)).text();
    expect([...tagged.matchAll(/<h2>(記事 \d+)<\/h2>/g)].every((m) => Number(m[1]!.split(" ")[1]) % 2 === 0)).toBe(true);
    expect(tagged).toContain('name="robots" content="noindex');
  });

  it("記事は本文を HTML にし（生の HTML は文字）、無い記事・予約・モジュールが OFF は 404", async () => {
    const { b } = setup();
    const html = await (await b.get("/my-shop/blogs/news/post-3")).text();
    expect(html).toContain("<h1>記事 3</h1>");
    expect(html).toContain("<h2>見出し</h2>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect((await b.get("/my-shop/blogs/news/future")).status).toBe(404);
    expect((await b.get("/my-shop/blogs/news/nope")).status).toBe(404);
    expect((await b.get("/my-shop/blogs/none")).status).toBe(404);
    const off = setup({ modules: {} });
    expect((await off.b.get("/my-shop/blogs/news")).status).toBe(404);
  });

  it("Atom のフィードとサイトマップ", async () => {
    const { b } = setup();
    const res = await b.get("/my-shop/blogs/news/feed.atom");
    expect(res.headers.get("content-type")).toContain("application/atom+xml");
    const xml = await res.text();
    expect(xml.match(/<entry>/g)).toHaveLength(14);
    expect(xml).toContain(`<link href="${BASE}/my-shop/blogs/news/post-14"/>`);
    expect(xml).not.toContain("future");
    const map = await (await b.get("/sitemap-pages.xml")).text();
    expect(map).toContain(`${BASE}/my-shop/blogs/news</loc>`);
    expect(map).toContain(`${BASE}/my-shop/blogs/news/post-1</loc>`);
  });

  it("紹介は抜粋か本文の頭の文字", () => {
    expect(articleSummary({ excerpt: "抜粋", body: "本文" })).toBe("抜粋");
    expect(articleSummary({ body: "## 見出し\n\n**太字**と[リンク](/x)。\n\n::: products\n\n![画像](/media/a.webp)" })).toBe("見出し 太字とリンク。");
  });
});

describe("ブログのお店の画面（Liquid のテーマ）", () => {
  const files = {
    "layout/theme.liquid": "<!doctype html><html><head>{{ content_for_header }}</head><body><nav>{% for l in linklists.main-menu.links %}<a class=\"m\" href=\"{{ l.url }}\">{{ l.title }}</a>{% endfor %}</nav>{{ content_for_layout }}</body></html>",
    "templates/blog.liquid": '<section class="blog" data-t="{{ template }}"><h1>{{ blog.title }}</h1>{% for a in blog.articles %}<a class="a" href="{{ a.url }}">{{ a.title }}|{{ a.excerpt }}|{{ a.tags | join: "," }}</a>{% endfor %}{% if paginate.next %}<a class="next" href="{{ paginate.next.url }}">次</a>{% endif %}</section>',
    "templates/article.liquid": '<article data-t="{{ template }}"><a href="{{ blog.url }}">{{ blog.title }}</a><h1>{{ article.title }}</h1>{{ article.content }}</article>',
  };

  it("templates/blog と templates/article で描き、メニューにブログを足す", async () => {
    const { b } = setup({ liquid: files });
    const list = await (await b.get("/blogs/news")).text();
    expect(list).toContain('<section class="blog" data-t="blog"><h1>お知らせ</h1><a class="a" href="/blogs/news/post-14">記事 14|見出し 本文 14 です。&lt;b&gt;x&lt;/b&gt;|新作</a>');
    expect(list).toContain('<a class="next" href="/blogs/news?page=2">次</a>');
    expect(list).toContain('<a class="m" href="/blogs/news">お知らせ</a>');
    const art = await (await b.get("/blogs/news/post-2")).text();
    expect(art).toContain('<article data-t="article"><a href="/blogs/news">お知らせ</a><h1>記事 2</h1><h2>見出し</h2>');
  });
});
