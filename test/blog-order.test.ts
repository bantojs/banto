import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";
import { parseArticlesLine, articlesLine } from "../src/pages/blocks";

/** ブログの記事の並び順とフィード（0116、docs/blog.md「並び順とフィード」） */
function setup(opts: { applied?: string[] } = {}) {
  const sb = new FakeSupabase(opts.applied ? { appliedMigrations: opts.applied } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { blog: true, pages: true } } });
  const blog = sb.addBlog(shop.id, { handle: "staff", title: "スタッフ" });
  const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 0, m)).toISOString();
  // 公開した順: sato → kato → amada（新しい順は amada・kato・sato）。題の順は「あ 佐藤」「い 加藤」「う 天田」
  const sato = sb.addArticle(shop.id, blog.id, { handle: "sato", title: "あ 佐藤", published_at: at(1) });
  const kato = sb.addArticle(shop.id, blog.id, { handle: "kato", title: "い 加藤", published_at: at(2) });
  const amada = sb.addArticle(shop.id, blog.id, { handle: "amada", title: "う 天田", published_at: at(3) });
  const app = appWith(sb, {}, new MemoryStorage(`${BASE}/media`));
  return { sb, shop, blog, app, ids: { sato: sato.id, kato: kato.id, amada: amada.id }, base: `/admin/shops/${shop.id}/modules/blog` };
}

const order = (html: string) => [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);

describe("並び順", () => {
  it("一覧はブログの並び順に従う（新しい順・題の順・手で並べる）。新しい記事は手で並べた最後", async () => {
    const { sb, blog, app } = setup();
    const b = new Browser(app, BASE);
    expect(order(await (await b.get("/my-shop/blogs/staff")).text())).toEqual(["う 天田", "い 加藤", "あ 佐藤"]);
    const row = sb.tables.blogs.find((x) => x["id"] === blog.id)!;
    row["article_order"] = "title";
    expect(order(await (await new Browser(appWith(sb), BASE).get("/my-shop/blogs/staff")).text())).toEqual(["あ 佐藤", "い 加藤", "う 天田"]);
    row["article_order"] = "manual";
    // 今の position は作った順（1・2・3）。新しい記事は 4
    const fresh = sb.addArticle(String(row["shop_id"]), blog.id, { handle: "new", title: "え 新人" });
    expect(fresh["position"]).toBe(4);
    expect(order(await (await new Browser(appWith(sb), BASE).get("/my-shop/blogs/staff")).text())).toEqual(["あ 佐藤", "い 加藤", "う 天田", "え 新人"]);
  });

  it("::: articles は既定でブログの並び順、sort= で上書き", async () => {
    const { sb, shop, blog } = setup();
    sb.tables.blogs.find((x) => x["id"] === blog.id)!["article_order"] = "manual";
    sb.addPage(shop.id, { handle: "about", title: "About", body: "::: articles blog=staff limit=3 layout=list\n\n::: articles blog=staff limit=3 layout=list sort=new", published: true });
    const html = await (await new Browser(appWith(sb), BASE).get("/my-shop/pages/about")).text();
    const titles = [...html.matchAll(/font-weight:600">([^<]+)</g)].map((m) => m[1]);
    expect(titles).toEqual(["あ 佐藤", "い 加藤", "う 天田", "う 天田", "い 加藤", "あ 佐藤"]);
  });

  it("書き方: sort は new・title・manual だけ。書かなければ行にも出さない", () => {
    expect(parseArticlesLine("::: articles blog=staff sort=manual")?.sort).toBe("manual");
    expect(parseArticlesLine("::: articles blog=staff")?.sort).toBeNull();
    expect(parseArticlesLine("::: articles blog=staff sort=random")).toBeNull();
    expect(articlesLine({ blog: "staff", tag: null, sort: "title", limit: 3, layout: "grid", style: null })).toBe("::: articles blog=staff limit=3 layout=grid sort=title");
    expect(articlesLine({ blog: "staff", tag: null, sort: null, limit: 3, layout: "grid", style: null })).toBe("::: articles blog=staff limit=3 layout=grid");
  });

  it("フィードはブログの並び順によらず新しい順", async () => {
    const { sb, blog, app } = setup();
    sb.tables.blogs.find((x) => x["id"] === blog.id)!["article_order"] = "title";
    const xml = await (await new Browser(app, BASE).get("/my-shop/blogs/staff/feed.atom")).text();
    expect([...xml.matchAll(/<title>([^<]+)<\/title>\n    <link/g)].map((m) => m[1])).toEqual(["う 天田", "い 加藤", "あ 佐藤"]);
  });
});

describe("フィードを出さない", () => {
  it("feed.atom は 404、一覧と記事の画面にフィードのリンクを出さない。ヘッドレスの feed_url は null", async () => {
    const { sb, blog, app } = setup();
    const b = new Browser(app, BASE);
    expect(await (await b.get("/my-shop/blogs/staff")).text()).toContain("feed.atom");
    sb.tables.blogs.find((x) => x["id"] === blog.id)!["feed"] = false;
    const b2 = new Browser(appWith(sb), BASE);
    expect((await b2.get("/my-shop/blogs/staff/feed.atom")).status).toBe(404);
    expect(await (await b2.get("/my-shop/blogs/staff")).text()).not.toContain("feed.atom");
    expect(await (await b2.get("/my-shop/blogs/staff/amada")).text()).not.toContain("feed.atom");
    const api = (await (await b2.get("/api/shops/my-shop/blogs")).json()) as { blogs: { article_order: string; feed_url: string | null }[] };
    expect(api.blogs[0]).toMatchObject({ article_order: "new", feed_url: null });
  });
});

describe("管理画面", () => {
  it("ブログの設定で並び順とフィードを変える。手で並べる順を一覧で保存し、変えなければ「変わっていません」", async () => {
    const { sb, blog, app, ids, base } = setup();
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const settings = await (await owner.get(`${base}/${blog.id}/settings`)).text();
    expect(settings).toContain('name="article_order"');
    let res = await owner.post(`${base}/${blog.id}/settings`, { title: "スタッフ", handle: "staff", nav: "none", sort_order: "0", order_fields: "1", article_order: "manual" });
    expect(res.status).toBe(302);
    const row = sb.tables.blogs.find((x) => x["id"] === blog.id)!;
    expect(row).toMatchObject({ article_order: "manual", feed: false });
    // 欄の無いフォームからはフィードを変えない
    row["feed"] = true;
    await owner.post(`${base}/${blog.id}/settings`, { title: "スタッフ", handle: "staff", nav: "none", sort_order: "0" });
    expect(row).toMatchObject({ article_order: "manual", feed: true });
    const list = await (await owner.get(`${base}/${blog.id}`)).text();
    expect(list).toContain(`name="pos_${ids.sato}"`);
    expect(list.indexOf(`pos_${ids.sato}`)).toBeLessThan(list.indexOf(`pos_${ids.amada}`));
    const form = { [`prev_${ids.sato}`]: "1", [`pos_${ids.sato}`]: "3", [`prev_${ids.kato}`]: "2", [`pos_${ids.kato}`]: "2", [`prev_${ids.amada}`]: "3", [`pos_${ids.amada}`]: "1" };
    res = await owner.post(`${base}/${blog.id}/positions`, form);
    expect(res.headers.get("location")).toContain("flash=order_saved");
    expect(order(await (await new Browser(app, BASE).get("/my-shop/blogs/staff")).text())).toEqual(["う 天田", "い 加藤", "あ 佐藤"]);
    res = await owner.post(`${base}/${blog.id}/positions`, { [`prev_${ids.sato}`]: "3", [`pos_${ids.sato}`]: "3" });
    expect(res.headers.get("location")).toContain("flash=order_unchanged");
    res = await owner.post(`${base}/${blog.id}/positions`, { [`prev_${ids.sato}`]: "3", [`pos_${ids.sato}`]: "0" });
    expect(res.headers.get("location")).toContain("flash=order_invalid");
  });

  it("0116 の前: 欄を出さず、一覧は新しい順のまま（::: articles の sort= も効かない）", async () => {
    const { sb, shop, blog, app, base } = setup({ applied: BUNDLED_MIGRATIONS.filter((v) => v !== "0116_blog_order") });
    expect(sb.tables.blogs[0]).not.toHaveProperty("article_order");
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect(await (await owner.get(`${base}/${blog.id}/settings`)).text()).not.toContain('name="article_order"');
    expect(await (await owner.get(base)).text()).not.toContain('name="article_order"');
    sb.addPage(shop.id, { handle: "about", title: "About", body: "::: articles blog=staff limit=3 layout=list sort=title", published: true });
    const html = await (await new Browser(app, BASE).get("/my-shop/pages/about")).text();
    expect([...html.matchAll(/font-weight:600">([^<]+)</g)].map((m) => m[1])).toEqual(["う 天田", "い 加藤", "あ 佐藤"]);
    expect(order(await (await new Browser(app, BASE).get("/my-shop/blogs/staff")).text())).toEqual(["う 天田", "い 加藤", "あ 佐藤"]);
  });
});

describe("::: articles tag=@product（商品詳細のひな形）", () => {
  function productSetup() {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { blog: true, pages: true } } });
    const blog = sb.addBlog(shop.id, { handle: "styling", title: "着こなし" });
    for (const slug of ["coat", "knit"]) {
      const p = sb.addProduct(shop.id, { slug, name: slug, published: true });
      sb.addSku(shop.id, String(p["id"]), { code: slug, name: "F", price_jpy: 1000, available: 1 });
    }
    sb.addArticle(shop.id, blog.id, { handle: "a1", title: "コートの着こなし", tags: ["coat", "冬"] });
    sb.addArticle(shop.id, blog.id, { handle: "a2", title: "ニットの着こなし", tags: ["knit"] });
    sb.addArticle(shop.id, blog.id, { handle: "a3", title: "両方の着こなし", tags: ["coat", "knit"] });
    const tpl = sb.addPage(shop.id, { handle: "product-tpl", title: "ひな形", body: "::: current part=title\n\n::: articles blog=styling tag=@product limit=6 layout=list" });
    (sb.tables.shops.find((x) => x["id"] === shop.id)!["settings"] as Record<string, unknown>)["page_layouts"] = { product: tpl.id };
    sb.addPage(shop.id, { handle: "about", title: "About", body: "::: articles blog=styling tag=@product limit=6 layout=list", published: true });
    return { sb, app: appWith(sb, {}, new MemoryStorage(`${BASE}/media`)) };
  }
  const titles = (html: string) => [...html.matchAll(/font-weight:600">([^<]+)</g)].map((m) => m[1]);

  it("商品の画面では、その商品の URL の名前のタグの記事だけ。商品の画面の外では何も並べない", async () => {
    const { app } = productSetup();
    const b = new Browser(app, BASE);
    expect(titles(await (await b.get("/my-shop/products/coat")).text()).sort()).toEqual(["コートの着こなし", "両方の着こなし"].sort());
    expect(titles(await (await b.get("/my-shop/products/knit")).text()).sort()).toEqual(["ニットの着こなし", "両方の着こなし"].sort());
    expect(titles(await (await b.get("/my-shop/pages/about")).text())).toEqual([]);
  });

  it("書き方: @product はタグとしてそのまま読む（置き換えるのは描くとき）", () => {
    expect(parseArticlesLine("::: articles blog=styling tag=@product")?.tag).toBe("@product");
  });
});
