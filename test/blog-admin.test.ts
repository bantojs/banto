import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { BLOG_MIGRATION, parseTags } from "../src/blog";

/** ブログの管理画面（同梱モジュール blog、0081）。扱えるのは content の項目の人。記事の編集の画面はページと同じ */
function setup(opts: { enabled?: boolean } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: opts.enabled === false ? {} : { modules: { blog: true } } });
  const app = appWith(sb, {}, new MemoryStorage(`${BASE}/media`));
  return { sb, shop, app, base: `/admin/shops/${shop.id}/modules/blog` };
}

async function staff(sb: FakeSupabase, app: ReturnType<typeof appWith>, shop: { id: string }, email: string, perms: string[]) {
  const u = sb.addUser(email, "password-123");
  const org = String(sb.tables.shops.find((s) => s["id"] === shop.id)!["org_id"]);
  sb.orgMembers.push({ org_id: org, user_id: u.id, role: "member", created_at: new Date().toISOString() });
  sb.orgMemberShops.push({ org_id: org, user_id: u.id, shop_id: shop.id, perms });
  return Browser.loggedIn(app, email, "password-123");
}

const article = { title: "Spring Sale", handle: "", body: "## 春の\\n\\nセールです。", tags: "セール、 新作, セール", excerpt: "春のお知らせ", author: "店長", published_at: "", image_url: "", seo_title: "", seo_description: "", template_suffix: "" };

describe("ブログの管理画面", () => {
  it("モジュールの一覧に出て ON にでき、0081 が当たるまでは出ない。タブは content の人に出る", async () => {
    const { sb, app, shop } = setup({ enabled: false });
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect(await (await owner.get(`/admin/shops/${shop.id}/modules`)).text()).toContain('data-module="blog"');
    await owner.post(`/admin/shops/${shop.id}/modules/blog/enabled`, { enabled: "on" });
    const writer = await staff(sb, app, shop, "w@example.com", ["content"]);
    expect(await (await writer.get(`/admin/shops/${shop.id}/modules/blog`)).text()).toContain(`href="/admin/shops/${shop.id}/modules/blog"`);
    const catalog = await staff(sb, app, shop, "c@example.com", ["catalog"]);
    expect((await catalog.get(`/admin/shops/${shop.id}/modules/blog`)).status).toBe(404);
    sb.appliedMigrations = sb.appliedMigrations.filter((v) => v !== BLOG_MIGRATION);
    const fresh = await Browser.loggedIn(appWith(sb), "owner@example.com", "password-123");
    expect(await (await fresh.get(`/admin/shops/${shop.id}/modules`)).text()).not.toContain('data-module="blog"');
  });

  it("ブログを作り、記事を書いて公開・予約・タグ・抜粋。編集の画面はページと同じ（ブロック・メディア・リビジョン）", async () => {
    const { sb, app, base } = setup();
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const made = await owner.post(base, { title: "お知らせ", handle: "news", nav: "header", sort_order: "0" });
    const blog = sb.tables.blogs[0]!;
    expect(made.headers.get("location")).toBe(`${base}/${String(blog["id"])}?flash=created`);
    expect((await owner.post(base, { title: "x", handle: "news" })).status).toBe(409);
    const at = `${base}/${String(blog["id"])}/articles`;
    const blank = await (await owner.get(`${at}/new`)).text();
    expect(blank).toContain("/blogs/news/");
    expect(blank).toContain('name="tags"');
    expect(blank).toContain('data-list="' + base + '/media"');
    await owner.post(at, { ...article, action: "publish" });
    const a = sb.tables.articles[0]!;
    expect(a).toMatchObject({ handle: "spring-sale", published: true, tags: ["セール", "新作"], excerpt: "春のお知らせ", author: "店長" });
    expect(a["published_at"]).toBeTruthy();
    // 予約: 未来の日時なら一覧の予約のタブ
    await owner.post(at, { ...article, title: "Later", action: "publish", published_at: "2099-01-01T09:00" });
    expect(await (await owner.get(`${base}/${String(blog["id"])}?status=scheduled`)).text()).toContain("Later");
    // 直すとリビジョン、戻す
    const id = String(a["id"]);
    await owner.post(`${at}/${id}`, { ...article, handle: "spring-sale", published: "on", action: "update", title: "春のセール" });
    expect(sb.tables.article_revisions).toHaveLength(1);
    await owner.post(`${at}/${id}/revisions/${String(sb.tables.article_revisions[0]!["id"])}/restore`, {});
    expect(a["title"]).toBe("Spring Sale");
    // ゴミ箱 → 戻す → 完全に削除はゴミ箱の中だけ
    await owner.post(`${at}/${id}/delete`, {});
    expect(sb.tables.articles).toHaveLength(2);
    await owner.post(`${at}/${id}/trash`, {});
    await owner.post(`${at}/${id}/delete`, {});
    expect(sb.tables.articles).toHaveLength(1);
    // 記事の名前 feed は使えない
    expect((await owner.post(at, { ...article, handle: "feed", action: "draft" })).status).toBe(400);
  });

  it("ブログの設定を直し、消すと記事も消える。ほかのショップのブログは開けない", async () => {
    const { sb, app, base, shop } = setup();
    const blog = sb.addBlog(shop.id, { handle: "news", title: "お知らせ" });
    sb.addArticle(shop.id, blog.id);
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    await owner.post(`${base}/${blog.id}/settings`, { title: "読みもの", handle: "journal", nav: "footer", sort_order: "1", description: "日々のこと" });
    expect(blog).toMatchObject({ title: "読みもの", handle: "journal", nav: "footer", description: "日々のこと" });
    const otherOwner = sb.addUser("o2@example.com", "password-123", { owner: true });
    const other = sb.addShop(otherOwner.id, { slug: "o2", name: "O", settings: { modules: { blog: true } } });
    const otherBlog = sb.addBlog(other.id);
    expect((await owner.get(`${base}/${otherBlog.id}`)).status).toBe(404);
    await owner.post(`${base}/${blog.id}/delete`, {});
    expect(sb.tables.blogs.filter((b) => b["shop_id"] === shop.id)).toHaveLength(0);
    expect(sb.tables.articles.filter((x) => x["shop_id"] === shop.id)).toHaveLength(0);
  });

  it("タグの読み方", () => {
    expect(parseTags("新作、セール, 新作 ,, 春")).toEqual(["新作", "セール", "春"]);
  });
});
