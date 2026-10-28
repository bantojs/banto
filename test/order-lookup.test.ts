import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, memberLogin, memberMail } from "./helpers";
import { buildOrderEmail } from "../src/plugins/email_resend";
import { openOrderToken } from "../src/orders/lookup";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";

/**
 * 注文照会・領収書をヘッドレスで（0066、docs/headless.md「注文照会・領収書」）。
 * Banto は JSON を返すだけ。会員の注文は会員トークン、ゲストの注文は番号とメールアドレス。
 * 注文メールのリンクは注文照会のページ（連携サイト、無ければ Banto）に ?banto_order=（会員なら &banto_member=1）
 */
let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

function setup(settings: Record<string, unknown> = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c",
    settings: { members_enabled: true, modules: { receipt: true }, receipt: { issuer: "マイショップ株式会社", invoice_number: "T1234567890123" }, tax_rate: 10, headless: { return_origins: ["https://wp.example.com"] }, ...settings },
  });
  const food = sb.addProduct(shop.id, { slug: "tea", name: "お茶", published: true, tax_class: "reduced" });
  const tea = sb.addSku(shop.id, food.id, { code: "TEA", price_jpy: 1080, available: 10 });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const teeSku = sb.addSku(shop.id, tee.id, { code: "TEE-M", price_jpy: 3300, available: 10 });
  sb.tables.orders.push({ id: "order-g", shop_id: shop.id, number: 1001, status: "paid", total_jpy: 4380, shipping_jpy: 0, shipping_tax_rate: 10, customer_email: "guest@example.com", customer_name: "ゲスト", shipping_address: { state: "大阪府" }, created_at: "2026-10-20T00:00:00Z" });
  sb.tables.order_items.push({ id: "oi-1", shop_id: shop.id, order_id: "order-g", sku_id: tea.id, qty: 1, unit_price_jpy: 1080, tax_rate: 8 });
  sb.tables.order_items.push({ id: "oi-2", shop_id: shop.id, order_id: "order-g", sku_id: teeSku.id, qty: 1, unit_price_jpy: 3300, tax_rate: 10 });
  const mail = memberMail(sb, shop.id);
  dispose = mail.dispose;
  const app = appWith(sb, { RESEND_API_KEY: "re_test" });
  const call = async (path: string, body?: unknown, token?: string) => {
    const res = await app.request(`${BASE}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin: "https://wp.example.com", "cf-connecting-ip": "203.0.113.9", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, headers: res.headers, json: (await res.json()) as Record<string, unknown> };
  };
  return { sb, shop, mail, app, call, teeSku };
}

/** 会員になってトークンを受け取り、その会員の注文を 1 件足す */
async function memberWithOrder(s: ReturnType<typeof setup>, email = "member@example.com") {
  const r = await s.call("/api/shops/my-shop/members/login", { email });
  const v = await s.call("/api/shops/my-shop/members/verify", { challenge_id: r.json["challenge_id"], code: s.mail.code(email) });
  const cid = String(s.sb.tables.customers.find((c) => c["email"] === email)!["id"]);
  s.sb.tables.orders.push({ id: "order-m", shop_id: s.shop.id, number: 1002, status: "shipped", total_jpy: 3300, shipping_jpy: 0, shipping_tax_rate: 10, customer_email: email, customer_id: cid, shipping_address: { state: "東京都" }, created_at: "2026-10-21T00:00:00Z", tracking_carrier: "yamato", tracking_number: "123456789012" });
  s.sb.tables.order_items.push({ id: "oi-3", shop_id: s.shop.id, order_id: "order-m", sku_id: s.teeSku.id, qty: 1, unit_price_jpy: 3300, tax_rate: 10 });
  return { access: String(v.json["access_token"]), cid };
}

describe("ゲストの注文照会・領収書の API", () => {
  it("番号とメールアドレスが合えば注文と注文トークン。住所は返さず、違えばどちらが違ったかも言わない", async () => {
    const { call, shop } = setup();
    const r = await call("/api/shops/my-shop/orders/lookup", { number: 1001, email: " GUEST@example.com " });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.json).toMatchObject({ order: { number: 1001, status: "paid", total_jpy: 4380, items: [{ name: "お茶", qty: 1 }, { name: "Tシャツ", qty: 1 }] }, receipt_available: true });
    expect(JSON.stringify(r.json)).not.toContain("大阪府");
    expect(await openOrderToken("test-session-secret", shop.id, String(r.json["order_token"]))).toEqual({ number: 1001, email: "guest@example.com" });
    expect(await call("/api/shops/my-shop/orders/lookup", { number: 1001, email: "other@example.com" })).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect(await call("/api/shops/my-shop/orders/lookup", { number: 9999, email: "guest@example.com" })).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect(await call("/api/shops/my-shop/orders/lookup", { number: "abc", email: "guest@example.com" })).toMatchObject({ status: 400, json: { error: "invalid_request" } });
    expect((await call("/api/shops/nope/orders/lookup", { number: 1001, email: "guest@example.com" })).status).toBe(404);
  });

  it("領収書は注文トークンで JSON（記載事項と税率ごとの内訳だけ）。宛名・体裁は連携サイト", async () => {
    const { call, sb } = setup();
    const token = String((await call("/api/shops/my-shop/orders/lookup", { number: 1001, email: "guest@example.com" })).json["order_token"]);
    const r = await call("/api/shops/my-shop/orders/receipt", { order_token: token });
    expect(r.status).toBe(200);
    expect(r.json["receipt"]).toMatchObject({
      kind: "qualified_simplified_invoice", issuer: "マイショップ株式会社", invoice_number: "T1234567890123", proviso: "お品代", number: 1001, total_jpy: 4380,
      items: [{ name: "お茶", reduced: true, line_total_jpy: 1080 }, { name: "Tシャツ", reduced: false, line_total_jpy: 3300 }],
      tax: [{ rate: 10, amount_jpy: 3300, tax_jpy: 300 }, { rate: 8, amount_jpy: 1080, tax_jpy: 80 }],
    });
    expect(await call("/api/shops/my-shop/orders/receipt", { order_token: `${token}x` })).toMatchObject({ status: 400, json: { error: "invalid_order_token" } });
    // 支払い済みでない注文には出さない
    sb.tables.orders[0]!["status"] = "refunded";
    expect(await call("/api/shops/my-shop/orders/receipt", { order_token: token })).toMatchObject({ status: 409, json: { error: "receipt_not_available" } });
    expect((await call("/api/shops/my-shop/orders/lookup", { number: 1001, email: "guest@example.com" })).json["receipt_available"]).toBe(false);
  });

  it("領収書のモジュールが OFF なら領収書は出さない（照会はできる）", async () => {
    const { call } = setup({ modules: {} });
    const r = await call("/api/shops/my-shop/orders/lookup", { number: 1001, email: "guest@example.com" });
    expect(r.json["receipt_available"]).toBe(false);
    expect(await call("/api/shops/my-shop/orders/receipt", { order_token: r.json["order_token"] })).toMatchObject({ status: 404, json: { error: "receipt_disabled" } });
  });
});

describe("注文照会の回数の上限（0067）", () => {
  it("外れた照会が同じ IP から 20 回を超えると 429。合った照会は数えない。同梱テーマの画面も同じ", async () => {
    const { call, app, sb } = setup();
    for (let i = 0; i < 3; i++) expect((await call("/api/shops/my-shop/orders/lookup", { number: 1001, email: "guest@example.com" })).status).toBe(200);
    for (let i = 0; i < 20; i++) expect((await call("/api/shops/my-shop/orders/lookup", { number: 1001, email: `x${i}@example.com` })).status).toBe(404);
    expect(sb.orderLookupFailures).toHaveLength(20);
    expect(sb.orderLookupFailures[0]!.ip).toMatch(/^[0-9a-f]{64}$/);
    expect(await call("/api/shops/my-shop/orders/lookup", { number: 1001, email: "guest@example.com" })).toMatchObject({ status: 429, json: { error: "too_many_requests" } });
    const res = await app.request(`${BASE}/my-shop/orders/lookup`, { method: "POST", headers: { origin: BASE, "cf-connecting-ip": "203.0.113.9", "content-type": "application/x-www-form-urlencoded" }, body: "number=1001&email=guest%40example.com" });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("照会の回数が多すぎます");
  });

  it("0067 が当たる前は今までどおり anon の lookup_order（上限なし）", async () => {
    const sb = new FakeSupabase({ appliedMigrations: BUNDLED_MIGRATIONS.filter((v) => v !== "0067_order_lookup_limits") });
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    sb.tables.orders.push({ id: "o1", shop_id: shop.id, number: 1001, status: "paid", total_jpy: 1000, shipping_jpy: 0, customer_email: "guest@example.com", created_at: "2026-10-20T00:00:00Z" });
    const app = appWith(sb);
    const post = (email: string) => app.request(`${BASE}/api/shops/my-shop/orders/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ number: 1001, email }) });
    for (let i = 0; i < 25; i++) expect((await post(`x${i}@example.com`)).status).toBe(404);
    expect((await post("guest@example.com")).status).toBe(200);
    expect(sb.orderLookupFailures).toHaveLength(0);
  });
});

describe("会員の注文の API", () => {
  it("会員トークンでその会員の注文だけ。ゲストの注文・他人の注文は not_found", async () => {
    const s = setup();
    const { access } = await memberWithOrder(s);
    let r = await s.call("/api/shops/my-shop/members/orders/1002", undefined, access);
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("https://wp.example.com");
    expect(r.json).toMatchObject({ order: { number: 1002, status: "shipped", tracking: { carrier: "yamato", number: "123456789012" } }, receipt_available: true });
    expect(JSON.stringify(r.json)).not.toContain("東京都");
    expect(JSON.stringify(r.json)).not.toContain("member@example.com");
    expect(await s.call("/api/shops/my-shop/members/orders/1001", undefined, access)).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect((await s.call("/api/shops/my-shop/members/orders/1002")).status).toBe(401);
    r = await s.call("/api/shops/my-shop/members/orders/1002/receipt", undefined, access);
    expect(r.status).toBe(200);
    expect(r.json["receipt"]).toMatchObject({ number: 1002, total_jpy: 3300, tax: [{ rate: 10, amount_jpy: 3300, tax_jpy: 300 }] });
  });
});

describe("注文メールのリンク", () => {
  const contact = (shop: Record<string, unknown>, member: boolean) => ({
    order_id: "o", number: 1001, status: "paid", created_at: "2026-10-20T00:00:00Z", total_jpy: 3300, shipping_jpy: 0, payment_provider: "stripe", customer_email: "a@example.com", customer_name: "山田", shipping_address: null,
    items: [{ name: "Tシャツ", sku: "M", qty: 1, unit_price_jpy: 3300 }], member,
    shop: { name: "マイショップ", slug: "my-shop", contact_email: null, return_policy: null, ...shop },
  });

  it("注文照会のページを連携サイトに向けていればそこへ。会員の注文なら banto_member=1。秘密は載せない", () => {
    const page = { order_page_url: "https://wp.example.com/order-status/?lang=ja", return_origins: ["https://wp.example.com"] };
    expect(buildOrderEmail("paid", contact(page, true), BASE).text).toContain("https://wp.example.com/order-status/?lang=ja&banto_order=1001&banto_member=1");
    const guest = buildOrderEmail("paid", contact(page, false), BASE).text;
    expect(guest).toContain("https://wp.example.com/order-status/?lang=ja&banto_order=1001\n");
    expect(guest).not.toContain("a@example.com");
    // 許可リストから外れたサイトには向けない（Banto の注文照会）
    expect(buildOrderEmail("paid", contact({ ...page, return_origins: [] }, false), BASE).text).toContain(`${BASE}/my-shop/orders/lookup?banto_order=1001`);
    expect(buildOrderEmail("shipped", contact({}, true), BASE).text).toContain(`${BASE}/my-shop/orders/lookup?banto_order=1001&banto_member=1`);
  });
});

describe("同梱テーマの注文照会", () => {
  it("注文照会のページを連携サイトに向けていれば、同じクエリのまま移す", async () => {
    const { app } = setup({ headless: { return_origins: ["https://wp.example.com"], order_page_url: "https://wp.example.com/order-status/" } });
    const b = new Browser(app);
    let res = await b.get("/my-shop/orders/lookup?banto_order=1001&banto_member=1");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://wp.example.com/order-status/?banto_order=1001&banto_member=1");
    res = await b.get("/my-shop/orders/lookup");
    expect(res.headers.get("location")).toBe("https://wp.example.com/order-status/");
  });

  it("ゲストの注文: 番号を埋めた照会の画面（メールアドレスで開く）", async () => {
    const { app } = setup();
    const html = await (await new Browser(app).get("/my-shop/orders/lookup?banto_order=1001")).text();
    expect(html).toContain('name="number" inputmode="numeric" value="1001"');
    expect(html).toContain('name="email"');
  });

  it("会員の注文: ログインしていなければログインへ送り、ログインしたらその注文を出す（番号とメールアドレスの欄は出さない）", async () => {
    const s = setup();
    const b = new Browser(s.app);
    await memberWithOrder(s);
    let res = await b.get("/my-shop/orders/lookup?banto_order=1002&banto_member=1");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/my-shop/account/login");
    await b.post("/my-shop/account/login", { email: "member@example.com" });
    res = await b.post("/my-shop/account/code", { code: s.mail.code("member@example.com") });
    expect(res.headers.get("location")).toBe("/my-shop/account");
    res = await b.get("/my-shop/account");
    expect(res.headers.get("location")).toBe("/my-shop/orders/lookup?banto_order=1002&banto_member=1");
    const html = await (await b.get("/my-shop/orders/lookup?banto_order=1002&banto_member=1")).text();
    expect(html).toContain("1002");
    expect(html).toContain("Tシャツ");
    expect(html).not.toContain('name="email"');
    expect(html).toContain('href="/my-shop/account/orders/1002/receipt"');
    // 一度戻したら、次からは /account をそのまま出す
    expect((await b.get("/my-shop/account")).status).toBe(200);
    // ゲストで買った注文（会員の注文ではない）は、番号とメールアドレスで開く画面
    const guest = await (await b.get("/my-shop/orders/lookup?banto_order=1001&banto_member=1")).text();
    expect(guest).toContain('name="email"');
  });
});

describe("管理画面の注文照会のページ", () => {
  it("許可リストのサイトの https だけ保存できる。空なら外す", async () => {
    const { app, shop, sb } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = await (await admin.get(`/admin/shops/${shop.id}`)).text();
    expect(page).toContain('name="order_page_url"');
    expect(page).toContain('name="order_lookup_per_ip_per_hour" min="1" max="9999" value="20"');
    let res = await admin.post(`/admin/shops/${shop.id}/headless`, { return_origins: "https://wp.example.com", order_page_url: "https://evil.example.com/x" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=order_page_invalid#headless`);
    res = await admin.post(`/admin/shops/${shop.id}/headless`, { return_origins: "https://wp.example.com", order_page_url: "https://wp.example.com/order-status/" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=headless_saved`);
    const headless = () => (sb.shops[0]!["settings"] as Record<string, Record<string, unknown>>)["headless"]!;
    expect(headless()["order_page_url"]).toBe("https://wp.example.com/order-status/");
    await admin.post(`/admin/shops/${shop.id}/headless`, { return_origins: "https://wp.example.com", order_page_url: "https://wp.example.com/order-status/", order_lookup_per_ip_per_hour: "40" });
    expect((sb.shops[0]!["settings"] as Record<string, unknown>)["order_lookup"]).toEqual({ per_ip_per_hour: 40 });
    // 許可リストから外したサイトのページは外れる
    await admin.post(`/admin/shops/${shop.id}/headless`, { return_origins: "https://shop.example.com", order_page_url: "" });
    expect(headless()["order_page_url"]).toBeUndefined();
  });

  it("0066 が当たっていなければ欄を出さない", async () => {
    const sb = new FakeSupabase({ appliedMigrations: BUNDLED_MIGRATIONS.filter((v) => v !== "0066_headless_order_lookup" && v !== "0067_order_lookup_limits") });
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ" });
    const admin = await Browser.loggedIn(appWith(sb), "owner@example.com", "password-123");
    const page = await (await admin.get(`/admin/shops/${shop.id}`)).text();
    expect(page).not.toContain('name="order_page_url"');
    expect(page).not.toContain('name="order_lookup_per_ip_per_hour"');
  });
});
