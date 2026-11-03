import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, memberLogin, memberMail } from "./helpers";
import { issueTokens } from "../src/members/auth";

/** 会員限定のページ・記事（0100、docs/audiences.md「会員限定のページ・記事」） */

const GOLD = "11111111-1111-4111-8111-111111111111";
let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { members_enabled: true, modules: { audiences: true, pages: true, blog: true }, customer_fields: [{ key: "rank", label: "ランク", type: "select", options: ["gold", "silver"] }] } });
  sb.tables.audiences.push({ id: GOLD, shop_id: shop.id, name: "ゴールド", condition: { all: [{ member: true }, { attr: "rank", in: ["gold"] }] } });
  sb.addPage(shop.id, { handle: "about", title: "店について", body: "誰でも", nav: "header" });
  sb.addPage(shop.id, { handle: "vip", title: "VIPラウンジ", body: "ゴールドだけの案内", nav: "header", audience_id: GOLD });
  sb.addPage(shop.id, { handle: "secret", title: "ひみつ", body: "x", audience_id: GOLD, audience_hide: true });
  const blog = sb.addBlog(shop.id, { handle: "news", title: "お知らせ" });
  sb.addArticle(shop.id, blog.id, { handle: "hello", title: "こんにちは", body: "b" });
  sb.addArticle(shop.id, blog.id, { handle: "vip-news", title: "VIP通信", body: "b", audience_id: GOLD });
  sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: shop.id, email: "gold@example.com", session_epoch: 0, attributes: { rank: "gold" } });
  sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: shop.id, email: "silver@example.com", session_epoch: 0, attributes: { rank: "silver" } });
  const mail = memberMail(sb, shop.id);
  dispose = mail.dispose;
  return { sb, shop, owner, app: appWith(sb, { RESEND_API_KEY: "re_test" }), mail };
}

describe("お店の画面", () => {
  it("ゲスト: 会員限定のページはメニュー・一覧に出ず、URL では「会員の方だけ」（存在も隠すなら 404）。合う会員は読め、合わない会員は 404", async () => {
    const { app, mail } = setup();
    const guest = new Browser(app, BASE);
    const top = await (await guest.get("/my-shop")).text();
    expect(top).toContain("/my-shop/pages/about");
    expect(top).not.toContain("/my-shop/pages/vip");
    const g = await guest.get("/my-shop/pages/vip");
    expect(g.status).toBe(200);
    const gh = await g.text();
    expect(gh).toContain("会員の方だけ");
    expect(gh).not.toContain("ゴールドだけの案内");
    expect((await guest.get("/my-shop/pages/secret")).status).toBe(404);
    expect(await (await guest.get("/my-shop/blogs/news")).text()).not.toContain("VIP通信");
    expect(await (await guest.get("/my-shop/blogs/news/vip-news")).text()).toContain("会員の方だけ");
    const gold = new Browser(app, BASE);
    await memberLogin(gold, mail, "/my-shop", "gold@example.com");
    expect(await (await gold.get("/my-shop/pages/vip")).text()).toContain("ゴールドだけの案内");
    expect(await (await gold.get("/my-shop/blogs/news")).text()).toContain("VIP通信");
    expect((await gold.get("/my-shop/blogs/news/vip-news")).status).toBe(200);
    const silver = new Browser(app, BASE);
    await memberLogin(silver, mail, "/my-shop", "silver@example.com");
    expect((await silver.get("/my-shop/pages/vip")).status).toBe(404);
    expect(await (await silver.get("/my-shop/blogs/news")).text()).not.toContain("VIP通信");
  });
});

describe("ヘッドレス", () => {
  it("会員トークンで会員限定のページ・記事を読める。ゲストは 403 members_only、存在も隠すものは 404", async () => {
    const { app, shop, sb } = setup();
    const goldId = String(sb.tables.customers.find((c) => c["email"] === "gold@example.com")!["id"]);
    const sid = crypto.randomUUID();
    sb.memberSessions.push({ id: sid, shop_id: shop.id, customer_id: goldId, session_epoch: 0, kind: "api", label: null, refresh_gen: 0, rotated_at: null, created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), expires_at: Date.now() + 3600_000, revoked_at: null });
    const tok = (await issueTokens("test-session-secret", shop.id, goldId, 0, { sid, gen: 0, expiresAt: Math.floor(Date.now() / 1000) + 3600 })).access_token;
    const get = (path: string, token?: string) => app.request(`${BASE}/api/shops/my-shop${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect((await get("/pages/vip")).status).toBe(403);
    expect((await get("/pages/secret")).status).toBe(404);
    expect((await get("/pages/vip", tok)).status).toBe(200);
    expect((await get("/blogs/news/articles/vip-news")).status).toBe(403);
    const list = (await (await get("/blogs/news/articles", tok)).json()) as { articles: { handle: string }[] };
    expect(list.articles.map((a) => a.handle)).toContain("vip-news");
    expect((await get("/pages/vip", "bm1.broken")).status).toBe(401);
  });
});

describe("編集の画面", () => {
  it("「会員限定」の欄で条件と存在も隠すを保存する。欄の無い送信では列に触れない", async () => {
    const { app, shop, sb } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const about = sb.tables.pages.find((p) => p["handle"] === "about")!;
    const base = `/admin/shops/${shop.id}/modules/pages/${about["id"]}`;
    const html = await (await b.get(base)).text();
    expect(html).toContain('name="audience_present"');
    expect(html).toContain(`<option value="${GOLD}">ゴールド</option>`);
    await b.post(base, { title: "店について", handle: "about", body: "誰でも", nav: "header", sort_order: "0", published: "on", action: "save", audience_present: "1", audience_id: GOLD, audience_hide: "on" });
    expect(sb.tables.pages.find((p) => p["handle"] === "about")).toMatchObject({ audience_id: GOLD, audience_hide: true });
    await b.post(base, { title: "店について", handle: "about", body: "誰でも", nav: "header", sort_order: "0", published: "on", action: "save" });
    expect(sb.tables.pages.find((p) => p["handle"] === "about")!["audience_id"]).toBe(GOLD);
  });
});
