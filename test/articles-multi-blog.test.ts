import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith, memberLogin, memberMail } from "./helpers";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";
import { forgetThemes } from "../src/themes/liquid/cache";
import { articleBlockBlogs, articleBlockSpansBlogs, articlesLine, parseArticlesLine } from "../src/pages/blocks";

/** ブログをまたぐ「記事を並べる」（0140、docs/pages.md「記事を並べる」） */

const GOLD = "11111111-1111-4111-8111-111111111111";
let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
  forgetThemes();
});

function setup(opts: { applied?: string[]; fields?: { news?: unknown[]; staff?: unknown[] } } = {}) {
  const sb = new FakeSupabase(opts.applied ? { appliedMigrations: opts.applied } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "S",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    settings: { members_enabled: true, modules: { blog: true, pages: true, audiences: true }, customer_fields: [{ key: "rank", label: "ランク", type: "select", options: ["gold"] }] },
  });
  sb.tables.audiences.push({ id: GOLD, shop_id: shop.id, name: "ゴールド", condition: { all: [{ member: true }, { attr: "rank", in: ["gold"] }] } });
  const news = sb.addBlog(shop.id, { handle: "news", title: "お知らせ", sort_order: 0, article_order: "manual", ...(opts.fields?.news ? { article_fields: opts.fields.news } : {}) });
  const staff = sb.addBlog(shop.id, { handle: "staff", title: "スタッフ", sort_order: 1, ...(opts.fields?.staff ? { article_fields: opts.fields.staff } : {}) });
  const other = sb.addBlog(shop.id, { handle: "other", title: "ほか", sort_order: 2 });
  const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 0, m)).toISOString();
  // 新しい順: s2(5) → o1(4) → n2(3) → s1(2) → n1(1)。題の順: a n1 / b s1 / c n2 / d s2 / e o1
  sb.addArticle(shop.id, news.id, { handle: "n1", title: "a 知らせ1", published_at: at(1), fields: { day: "2026-12-03" } });
  sb.addArticle(shop.id, staff.id, { handle: "s1", title: "b スタッフ1", published_at: at(2), fields: { day: "2026-12-01" } });
  sb.addArticle(shop.id, news.id, { handle: "n2", title: "c 知らせ2", published_at: at(3), tags: ["sale"], fields: { day: "2026-12-02" } });
  sb.addArticle(shop.id, other.id, { handle: "o1", title: "e ほか1", published_at: at(4) });
  sb.addArticle(shop.id, staff.id, { handle: "s2", title: "d スタッフ2", published_at: at(5), tags: ["sale"] });
  sb.addArticle(shop.id, staff.id, { handle: "vip", title: "f VIP", published_at: at(6), audience_id: GOLD });
  sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: shop.id, email: "gold@example.com", session_epoch: 0, attributes: { rank: "gold" } });
  // 本文の HTML は isolate の中でページの id と更新日時ごとに覚えるので、テストごとに別の id にする
  const page = (body: string) => sb.addPage(shop.id, { id: crypto.randomUUID(), handle: "p", title: "P", body, published: true });
  const mail = memberMail(sb, shop.id);
  dispose = mail.dispose;
  return { sb, shop, page, mail, app: () => appWith(sb, { RESEND_API_KEY: "re_test" }, new MemoryStorage(`${BASE}/media`)) };
}

/** 既定のカードの題とリンク */
const cards = (html: string) => [...html.matchAll(/<li class="card banto-articles__item"><a href="([^"]+)"[\s\S]*?font-weight:600">([^<]+)</g)].map((m) => `${m[2]}@${m[1]}`);
const titles = (html: string) => cards(html).map((x) => x.split("@")[0]);

describe("書き方", () => {
  it("blog= はカンマでつないだ名前（重なりを除く、20 個まで）か *。今までの 1 つの書き方はそのまま", () => {
    expect(parseArticlesLine("::: articles blog=news")?.blog).toBe("news");
    expect(parseArticlesLine("::: articles blog=news,staff,news")?.blog).toBe("news,staff");
    expect(parseArticlesLine("::: articles blog=*")?.blog).toBe("*");
    // ショップのブログの上限（20）と同じだけ書ける
    const twenty = Array.from({ length: 20 }, (_, i) => `blog-with-a-long-handle-${i}`).join(",");
    expect(parseArticlesLine(`::: articles blog=${twenty}`)?.blog).toBe(twenty);
    expect(parseArticlesLine(`::: articles blog=${Array.from({ length: 21 }, (_, i) => `b${i}`).join(",")}`)).toBeNull();
    expect(parseArticlesLine("::: articles blog=news,")).toBeNull();
    expect(parseArticlesLine("::: articles blog=News")).toBeNull();
    expect(articleBlockBlogs({ blog: "news,staff" })).toEqual(["news", "staff"]);
    expect(articleBlockBlogs({ blog: "*" })).toBe("*");
    expect(articleBlockSpansBlogs({ blog: "news" })).toBe(false);
    expect(articleBlockSpansBlogs({ blog: "*" })).toBe(true);
    expect(articlesLine({ blog: "news,staff", tag: null, sort: null, limit: 3, layout: "grid", style: null })).toBe("::: articles blog=news,staff limit=3 layout=grid");
  });
});

describe("お店の画面", () => {
  it("名前を並べると、そのブログの記事を新しい順に 1 つの並びで。リンクは記事ごとのブログの URL", async () => {
    const { page, app } = setup();
    page("::: articles blog=news,staff limit=4");
    const html = await (await new Browser(app(), BASE).get("/my-shop/pages/p")).text();
    expect(cards(html)).toEqual(["d スタッフ2@/my-shop/blogs/staff/s2", "c 知らせ2@/my-shop/blogs/news/n2", "b スタッフ1@/my-shop/blogs/staff/s1", "a 知らせ1@/my-shop/blogs/news/n1"]);
  });

  it("blog=* はすべてのブログ。tag・sort=title で絞る・並べる。手で並べた順（manual）は新しい順になる", async () => {
    const { page, app } = setup();
    page("::: articles blog=* limit=5\n\n::: articles blog=* sort=title tag=sale limit=5");
    const html = await (await new Browser(app(), BASE).get("/my-shop/pages/p")).text();
    expect(titles(html)).toEqual(["d スタッフ2", "e ほか1", "c 知らせ2", "b スタッフ1", "a 知らせ1", "c 知らせ2", "d スタッフ2"]);
    const { page: page2, app: app2 } = setup();
    page2("::: articles blog=news,staff sort=manual limit=2");
    expect(titles(await (await new Browser(app2(), BASE).get("/my-shop/pages/p")).text())).toEqual(["d スタッフ2", "c 知らせ2"]);
  });

  it("名前が 1 つのブログにしか当たらなければ、そのブログの並び順（ここでは manual）で描く", async () => {
    const { page, app } = setup();
    page("::: articles blog=news,nothing limit=2");
    expect(titles(await (await new Browser(app(), BASE).get("/my-shop/pages/p")).text())).toEqual(["a 知らせ1", "c 知らせ2"]);
  });

  it("会員: 合う会員には会員限定の記事も混ぜる（ゲストには出さない）", async () => {
    const { page, app, mail } = setup();
    page("::: articles blog=news,staff limit=3");
    const a = app();
    expect(titles(await (await new Browser(a, BASE).get("/my-shop/pages/p")).text())).toEqual(["d スタッフ2", "c 知らせ2", "b スタッフ1"]);
    const gold = new Browser(a, BASE);
    await memberLogin(gold, mail, "/my-shop", "gold@example.com");
    expect(titles(await (await gold.get("/my-shop/pages/p")).text())).toEqual(["f VIP", "d スタッフ2", "c 知らせ2"]);
  });

  it("記事の項目: どのブログにも同じキー・同じ種類があれば絞る・日付の順に並べる。片方に無ければ何も並べない", async () => {
    const day = { key: "day", label: "日", type: "date" };
    const { page, app } = setup({ fields: { news: [day], staff: [day] } });
    page("::: articles blog=news,staff sort=field:day limit=5\n\n::: articles blog=news,staff field:day=2026-12-01 limit=5");
    expect(titles(await (await new Browser(app(), BASE).get("/my-shop/pages/p")).text())).toEqual(["b スタッフ1", "c 知らせ2", "a 知らせ1", "d スタッフ2", "b スタッフ1"]);
    const { page: page2, app: app2 } = setup({ fields: { news: [day], staff: [{ key: "day", label: "日", type: "text" }] } });
    page2("::: articles blog=news,staff sort=field:day limit=5\n\n::: articles blog=news,staff field:day=2026-12-01 limit=5");
    expect(titles(await (await new Browser(app2(), BASE).get("/my-shop/pages/p")).text())).toEqual([]);
  });

  it("0140 が当たるまでは、またいだブロックは何も並べない（1 つのブログのブロックは今までどおり）", async () => {
    const { page, app } = setup({ applied: BUNDLED_MIGRATIONS.filter((v) => v < "0140") });
    page("::: articles blog=news,staff limit=3\n\n::: articles blog=staff limit=1");
    expect(titles(await (await new Browser(app(), BASE).get("/my-shop/pages/p")).text())).toEqual(["d スタッフ2"]);
  });

  it("Liquid: snippets/page-articles に blog は空、blogs にまたいだブログ、記事の url は記事ごとのブログ", async () => {
    const { sb, shop, page, app } = setup();
    sb.sitePlan = "paid";
    const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
    row["domain"] = "shop.example.jp";
    const version = "11111111-2222-4333-8444-555555555555";
    row["theme_public"] = { id: version, storage_key: `themes/${shop.id}/${version}/bundle.json`, settings: {} };
    const files = {
      "layout/theme.liquid": "<html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>",
      "templates/index.liquid": "<h1>top</h1>",
      "templates/page.liquid": "<article>{{ page.content }}</article>",
      "snippets/page-articles.liquid": `<p class="pa" data-blog="{{ blog.handle }}" data-blogs="{% for b in blogs %}{{ b.handle }} {% endfor %}">{% for a in articles %}{{ a.url }} {% endfor %}</p>`,
    };
    page("::: articles blog=staff,news limit=2");
    const storage = new MemoryStorage(`${BASE}/media`);
    await storage.put(`themes/${shop.id}/${version}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files, assets: [] })).buffer as ArrayBuffer, "application/json");
    void app;
    const html = await (await new Browser(appWith(sb, {}, storage), "https://shop.example.jp").get("/pages/p")).text();
    expect(html).toContain('<p class="pa" data-blog="" data-blogs="staff news ">/blogs/staff/s2 /blogs/news/n2 </p>');
  });
});
