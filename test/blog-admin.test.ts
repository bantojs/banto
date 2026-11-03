import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith, followPreview } from "./helpers";
import { parseTags } from "../src/blog";

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
    // ゴミ箱へ。0089 からは運営者の画面に「完全に削除」が無く（Cron の articles_purge_trash が 30 日で消す）、POST しても消えない
    await owner.post(`${at}/${id}/delete`, {});
    expect(sb.tables.articles).toHaveLength(2);
    await owner.post(`${at}/${id}/trash`, {});
    expect(a["deleted_at"]).toBeTruthy();
    expect(await (await owner.get(`${base}/${String(blog["id"])}?status=trash`)).text()).not.toContain(`${at}/${id}/delete`);
    expect((await owner.post(`${at}/${id}/delete`, {})).headers.get("location")).toBe(`${base}/${String(blog["id"])}?status=trash`);
    expect(sb.tables.articles).toHaveLength(2);
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
    // 0089 からは blog_delete（項目 content の人だけ。ほかのショップのブログは消せない）
    expect((await owner.post(`${base}/${otherBlog.id}/delete`, {})).status).toBe(404);
    expect(sb.tables.blogs.filter((b) => b["shop_id"] === other.id)).toHaveLength(1);
    await owner.post(`${base}/${blog.id}/delete`, {});
    expect(sb.calls.some((x) => x.includes("/rest/v1/rpc/blog_delete"))).toBe(true);
    expect(sb.tables.blogs.filter((b) => b["shop_id"] === shop.id)).toHaveLength(0);
    expect(sb.tables.articles.filter((x) => x["shop_id"] === shop.id)).toHaveLength(0);
  });

  it("0089 が当たる前の DB では従来どおり表の delete で消す（ブログ・ゴミ箱の記事）", async () => {
    const sb = new FakeSupabase({ appliedMigrations: [...new FakeSupabase().appliedMigrations].filter((v) => v !== "0089_security_hardening_3") });
    const owner0 = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner0.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { blog: true } } });
    const app = appWith(sb, {}, new MemoryStorage(`${BASE}/media`));
    const base = `/admin/shops/${shop.id}/modules/blog`;
    const blog = sb.addBlog(shop.id, { handle: "news" });
    const a = sb.addArticle(shop.id, blog.id);
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    await owner.post(`${base}/${blog.id}/articles/${a.id}/trash`, {});
    expect(await (await owner.get(`${base}/${blog.id}?status=trash`)).text()).toContain(`${base}/${blog.id}/articles/${a.id}/delete`);
    await owner.post(`${base}/${blog.id}/articles/${a.id}/delete`, {});
    expect(sb.tables.articles).toHaveLength(0);
    await owner.post(`${base}/${blog.id}/delete`, {});
    expect(sb.calls.some((x) => x.includes("/rest/v1/rpc/blog_delete"))).toBe(false);
    expect(sb.tables.blogs).toHaveLength(0);
  });

  it("記事のプレビューもお店の画面と同じテーマで描く（保存しない）", async () => {
    const { sb, app, shop, base } = setup();
    const blog = sb.addBlog(shop.id, { handle: "news", title: "お知らせ" });
    const owner = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const res = await followPreview(app, await owner.post(`${base}/${blog.id}/articles`, { title: "見るだけの記事", handle: "peek", body: "## 中身\n\n::: icon name=truck", action: "preview" }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("お店の画面と同じテーマで描いています");
    expect(html).toContain("見るだけの記事");
    expect(html).toContain("<h2>中身</h2>");
    expect(html).toMatch(/class="banto-icon[^"]*"[^>]*><svg/);
    expect(html).toContain(`href="/my-shop"`);
    expect(sb.tables.articles).toHaveLength(0);
  });

  it("タグの読み方", () => {
    expect(parseTags("新作、セール, 新作 ,, 春")).toEqual(["新作", "セール", "春"]);
  });
});
