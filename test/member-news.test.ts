import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, MemoryStorage, appWith, memberMail } from "./helpers";
import { memberNewsHref, parseNewsReadBody } from "../src/modules/member-news";

/** 会員へのお知らせ（同梱モジュール member_news、0155、docs/member-news.md）。DB の規則（見える範囲・会員の条件・上限）は test/db/member-news.test.ts */
let dispose = () => {};
afterEach(() => dispose());

function setup(opts: { on?: boolean } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "s", name: "お知らせのお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { members_enabled: true, contact_email: "shop@example.com", modules: { member_news: opts.on ?? true } } });
  const mail = memberMail(sb, shop.id);
  dispose = mail.dispose;
  const app = appWith(sb, { RESEND_API_KEY: "re_test" }, new MemoryStorage(`${BASE}/media`), new FakeStripe());
  return { sb, shop, mail, app, b: new Browser(app, BASE) };
}

async function login(b: Browser, mail: ReturnType<typeof memberMail>, email = "hanako@example.com") {
  await b.post("/s/account/login", { email });
  const res = await b.post("/s/account/code", { code: mail.code(email) });
  expect(res.headers.get("location")).toBe("/s/account");
}

async function issue(sb: FakeSupabase, shopId: string, scopes: string[], endpointId: string | null = null) {
  const { generateApiToken, hashApiToken, tokenPrefix } = await import("../src/api/tokens");
  const owner = sb.tables.shops.find((s) => s["id"] === shopId)!["owner_id"];
  const raw = generateApiToken();
  sb.tables.api_tokens.push({ id: `tok-${sb.tables.api_tokens.length + 1}`, shop_id: shopId, owner_id: owner, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, endpoint_id: endpointId, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
  return raw;
}

describe("部品", () => {
  it("リンク: https はそのまま、/ で始まるパスはお店の中。ほかは出さない", () => {
    expect(memberNewsHref("/s", "https://example.com/x")).toBe("https://example.com/x");
    expect(memberNewsHref("/s", "/products/tee")).toBe("/s/products/tee");
    expect(memberNewsHref("", "/products/tee")).toBe("/products/tee");
    expect(memberNewsHref("/s", "/")).toBe("/s");
    expect(memberNewsHref("", "/")).toBe("/");
    expect(memberNewsHref("/s", "//evil.example")).toBeNull();
    expect(memberNewsHref("/s", "javascript:alert(1)")).toBeNull();
    expect(memberNewsHref("/s", null)).toBeNull();
  });
  it("既読の本文: ids は id の形で 50 件まで、無ければすべて", () => {
    expect(parseNewsReadBody({})).toEqual({ ids: null });
    expect(parseNewsReadBody({ ids: ["8f1b2c3d-1111-4222-8333-944445555666"] })).toEqual({ ids: ["8f1b2c3d-1111-4222-8333-944445555666"] });
    expect(parseNewsReadBody({ ids: ["x"] })).toBeNull();
    expect(parseNewsReadBody({ ids: "x" })).toBeNull();
  });
});

describe("管理画面（全員向け）", () => {
  it("書く・直す・リンクの形が違えば書いた文を残して理由を出す・消す", async () => {
    const { sb, shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/member-news`;
    expect(await (await admin.get(base)).text()).toContain("会員へのお知らせ");
    const bad = await admin.post(base, { title: "セールのお知らせ", body: "週末だけ", url: "javascript:alert(1)" });
    expect(bad.status).toBe(400);
    const html = await bad.text();
    expect(html).toContain("リンクは https:// で始まる URL か");
    expect(html).toContain("セールのお知らせ");
    expect((await admin.post(base, { title: "セールのお知らせ", body: "週末だけ", url: "/products" })).status).toBe(302);
    const id = String(sb.tables.member_news[0]!["id"]);
    expect(sb.tables.member_news[0]).toMatchObject({ customer_id: null, title: "セールのお知らせ", url: "/products" });
    await admin.post(base, { id, title: "セールは日曜まで", body: "", url: "" });
    expect(sb.tables.member_news[0]).toMatchObject({ title: "セールは日曜まで", url: null });
    await admin.post(`${base}/${id}/delete`, {});
    expect(sb.tables.member_news).toHaveLength(0);
  });

  it("モジュールが OFF なら 404", async () => {
    const { shop, app } = setup({ on: false });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect((await admin.get(`/admin/shops/${shop.id}/modules/member-news`)).status).toBe(404);
  });
});

describe("会員ページとヘッドレス", () => {
  it("会員ページ: 全員向けと本人あてを新しい順に、未読に印。すべて既読にする。ほかの人あては出さない", async () => {
    const { sb, shop, mail, b } = setup();
    await login(b, mail);
    const me = sb.tables.customers.find((c) => c["email"] === "hanako@example.com")!;
    sb.tables.member_news.push(
      { id: "n1", shop_id: shop.id, customer_id: null, title: "全員へ", body: "本文", url: "/products", starts_at: "2026-01-01T00:00:00Z", ends_at: null },
      { id: "n2", shop_id: shop.id, customer_id: me["id"], title: "あなたへ", body: "", url: "https://example.com/x", starts_at: "2026-02-01T00:00:00Z", ends_at: null },
      { id: "n3", shop_id: shop.id, customer_id: "someone-else", title: "ほかの人へ", body: "", url: null, starts_at: "2026-03-01T00:00:00Z", ends_at: null },
      { id: "n4", shop_id: shop.id, customer_id: null, title: "終わった", body: "", url: null, starts_at: "2026-01-01T00:00:00Z", ends_at: "2026-01-02T00:00:00Z" },
    );
    const html = await (await b.get("/s/account")).text();
    expect(html).toContain("未読 2 件");
    expect(html.indexOf("あなたへ")).toBeLessThan(html.indexOf("全員へ"));
    expect(html).toContain('href="/s/products"');
    expect(html).toContain('href="https://example.com/x"');
    expect(html).not.toContain("ほかの人へ");
    expect(html).not.toContain("終わった");
    expect((await b.post("/s/account/news/read", {})).headers.get("location")).toBe("/s/account#news");
    const after = await (await b.get("/s/account")).text();
    expect(after).not.toContain("未読");
    expect(after).not.toContain("すべて既読にする");
  });

  it("モジュールが OFF なら欄を出さず、既読の口も 404", async () => {
    const { mail, b } = setup({ on: false });
    await login(b, mail);
    expect(await (await b.get("/s/account")).text()).not.toContain('id="news"');
    expect((await b.post("/s/account/news/read", {})).status).toBe(404);
  });

  it("ヘッドレス: 会員トークンで一覧・既読（ids で選ぶ・すべて）", async () => {
    const { sb, shop, mail, app } = setup();
    const start = await app.request(`${BASE}/api/shops/s/members/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "taro@example.com" }) });
    const { challenge_id } = (await start.json()) as { challenge_id: string };
    const ver = await app.request(`${BASE}/api/shops/s/members/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge_id, code: mail.code("taro@example.com") }) });
    const { access_token } = (await ver.json()) as { access_token: string };
    const h = { authorization: `Bearer ${access_token}`, "content-type": "application/json" };
    const a = "8f1b2c3d-1111-4222-8333-944445555661";
    const bId = "8f1b2c3d-1111-4222-8333-944445555662";
    sb.tables.member_news.push(
      { id: a, shop_id: shop.id, customer_id: null, title: "A", body: "", url: null, starts_at: "2026-01-01T00:00:00Z", ends_at: null },
      { id: bId, shop_id: shop.id, customer_id: null, title: "B", body: "", url: null, starts_at: "2026-01-02T00:00:00Z", ends_at: null },
    );
    const list = async () => (await (await app.request(`${BASE}/api/shops/s/members/news`, { headers: h })).json()) as { items: { id: string; read: boolean }[]; unread: number };
    expect(await list()).toMatchObject({ unread: 2, items: [{ id: bId }, { id: a }] });
    expect(await (await app.request(`${BASE}/api/shops/s/members/news/read`, { method: "POST", headers: h, body: JSON.stringify({ ids: [a] }) })).json()).toEqual({ ok: true, read: 1 });
    expect((await list()).unread).toBe(1);
    expect((await app.request(`${BASE}/api/shops/s/members/news/read`, { method: "POST", headers: h, body: JSON.stringify({ ids: ["x"] }) })).status).toBe(400);
    expect(await (await app.request(`${BASE}/api/shops/s/members/news/read`, { method: "POST", headers: h, body: "{}" })).json()).toEqual({ ok: true, read: 1 });
    expect((await app.request(`${BASE}/api/shops/s/members/news`)).status).toBe(401);
  });
});

describe("AI 用 API（member_news:write）", () => {
  const call = async (app: ReturnType<typeof appWith>, tok: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`${BASE}/api/v1${path}`, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> & { items?: { id: string; title: string }[] } };
  };

  it("1 人あてを置く・一覧・消す。プラグインのトークンと運営者のトークンは、互いのものに触れない", async () => {
    const { sb, shop, app } = setup();
    sb.tables.customers.push({ id: "cust-1", shop_id: shop.id, email: "a@example.com", session_epoch: 0 });
    sb.tables.hook_endpoints.push({ id: "ep-ma", shop_id: shop.id, name: "MA", url: "https://ma.example.com/hook", events: [], enabled: true, settings: {}, manifest: null, created_at: "" });
    const plugin = await issue(sb, shop.id, ["member_news:write"], "ep-ma");
    const op = await issue(sb, shop.id, ["member_news:write"]);
    const made = await call(app, plugin, "POST", "/member-news", { customer_id: "cust-1", title: "お取り置きが届きました", url: "/account" });
    expect(made.status).toBe(201);
    expect(sb.tables.member_news[0]).toMatchObject({ customer_id: "cust-1", endpoint_id: "ep-ma" });
    expect((await call(app, plugin, "GET", "/member-news")).json.items!.map((x) => x.title)).toEqual(["お取り置きが届きました"]);
    expect((await call(app, op, "GET", "/member-news")).json.items).toEqual([]);
    expect((await call(app, op, "DELETE", `/member-news/${String(made.json["id"])}`)).status).toBe(404);
    expect((await call(app, plugin, "DELETE", `/member-news/${String(made.json["id"])}`)).json).toEqual({ deleted: true });
    expect((await call(app, plugin, "POST", "/member-news", { customer_id: "nobody", title: "x" })).status).toBe(400);
  });

  it("スコープが無ければ 401、モジュールが OFF なら 409", async () => {
    const off = setup({ on: false });
    expect((await call(off.app, await issue(off.sb, off.shop.id, ["member_news:write"]), "GET", "/member-news")).status).toBe(409);
    const on = setup();
    expect((await call(on.app, await issue(on.sb, on.shop.id, ["dialogs:write"]), "GET", "/member-news")).status).toBe(401);
  });
});

describe("Liquid のテーマ（templates/customers/account）", () => {
  it("customer.news・news_unread_count・news_read_url。リンクはお店の中のパスに。\\ を含むリンクは出さない", async () => {
    const { forgetThemes } = await import("../src/themes/liquid/cache");
    forgetThemes();
    const VERSION = "11111111-2222-4333-8444-555555555556";
    const sb = new FakeSupabase();
    sb.sitePlan = "paid";
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "s", name: "お知らせのお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { members_enabled: true, contact_email: "shop@example.com", modules: { member_news: true } } });
    const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
    row["domain"] = "shop.example.jp";
    row["theme_public"] = { id: VERSION, storage_key: `themes/${shop.id}/${VERSION}/bundle.json`, settings: {} };
    const files = {
      "layout/theme.liquid": "<html><head>{{ content_for_header }}</head><body>{{ content_for_layout }}</body></html>",
      "templates/index.liquid": "<h1>top</h1>",
      "templates/customers/account.liquid": `<p class="unread">{{ customer.news_unread_count }}</p><p class="read-url">{{ customer.news_read_url }}</p>{% for n in customer.news %}<a class="n" data-read="{{ n.read }}" href="{{ n.url }}">{{ n.title }}</a><span class="d">{{ n.date_on }}</span>{% endfor %}`,
    };
    const storage = new MemoryStorage(`${BASE}/media`);
    await storage.put(`themes/${shop.id}/${VERSION}/bundle.json`, new TextEncoder().encode(JSON.stringify({ format: 1, files, assets: [] })).buffer as ArrayBuffer, "application/json");
    const mail = memberMail(sb, shop.id);
    dispose = mail.dispose;
    const b = new Browser(appWith(sb, { RESEND_API_KEY: "re_test" }, storage, new FakeStripe()), "https://shop.example.jp");
    await b.post("/account/login", { email: "hanako@example.com" });
    await b.post("/account/code", { code: mail.code("hanako@example.com") });
    sb.tables.member_news.push(
      { id: "n1", shop_id: shop.id, customer_id: null, title: "<b>セール</b>", body: "", url: "/products", starts_at: "2026-01-01T00:00:00Z", ends_at: null },
      { id: "n2", shop_id: shop.id, customer_id: null, title: "あやしい", body: "", url: "/\\evil.example/", starts_at: "2025-12-01T00:00:00Z", ends_at: null },
    );
    const html = await (await b.get("/account")).text();
    expect(html).toContain('<p class="unread">2</p>');
    expect(html).toContain('<p class="read-url">/account/news/read</p>');
    expect(html).toContain('<a class="n" data-read="false" href="/products">&lt;b&gt;セール&lt;/b&gt;</a><span class="d">2026-01-01</span>');
    expect(html).toContain('<a class="n" data-read="false" href="">あやしい</a>');
    expect(memberNewsHref("", "/\\evil.example/")).toBeNull();
  });
});
