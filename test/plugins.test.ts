import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, appWith, checkout, externalHosts, memoryAdapters, confirmAddress, quoteFrom } from "./helpers";
import { bundledPluginUrl } from "../src/plugins";
import { deliverPendingHooks } from "../src/hooks/deliver";
import { createPrivilegedDb } from "../src/db/privileged";
import { signKomojuPayload } from "../src/plugins/komoju";

afterEach(() => externalHosts.clear());

const SECRETS = { LINE_CHANNEL_ACCESS_TOKEN: "line-token", KOMOJU_SECRET_KEY: "sk_komoju", KOMOJU_WEBHOOK_SECRET: "whsec_komoju" };

function setup(overrides: Record<string, string | undefined> = {}) {
  const sb = new FakeSupabase();
  const stripe = new FakeStripe();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", stripe_account_id: "acct_connected" });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", price_jpy: 3000, available: 5 });
  const app = appWith(sb, { ...SECRETS, ...overrides }, undefined, stripe);
  return { sb, stripe, shop, tee, sku, app };
}

function routedFetch(sb: FakeSupabase): typeof fetch {
  return (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [prefix, h] of externalHosts) if (url.startsWith(prefix)) return Promise.resolve(h(new Request(input, init)));
    return sb.fetch(input, init);
  };
}

describe("同梱プラグイン（管理画面）", () => {
  it("一覧・Secret 不足の警告・有効化 → 設定 → 無効化", async () => {
    const { sb, shop, app } = setup({ LINE_CHANNEL_ACCESS_TOKEN: undefined });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    let html = await (await b.get(`/admin/shops/${shop.id}/plugins`)).text();
    expect(html).toContain("LINE 通知");
    expect(html).toContain("KOMOJU 決済");
    // LINE のトークンはショップごとの設定（0021）でもよいので Secret 不足の警告は出さず、設定の画面へのリンクを出す
    expect(html).not.toContain("npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN");
    expect(html).toContain(`/admin/shops/${shop.id}/line-messaging`);
    expect(html).toContain("npx wrangler secret put RESEND_API_KEY");
    expect(html).not.toContain("npx wrangler secret put KOMOJU_SECRET_KEY");

    let res = await b.post(`/admin/shops/${shop.id}/plugins/line_notify/enable`, {});
    const ep = sb.tables.hook_endpoints[0]!;
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/hooks/${ep["id"]}?flash=saved`);
    expect(ep).toMatchObject({ url: bundledPluginUrl("line_notify"), events: ["order.paid", "order.cancelled", "inventory.low"], enabled: true, name: "LINE 通知" });

    html = await (await b.get(`/admin/shops/${shop.id}/hooks/${ep["id"]}`)).text();
    expect(html).toContain("同梱プラグイン");
    expect(html).toContain('name="setting_to"');
    expect(html).not.toContain("署名シークレット");
    expect(html).not.toContain("banto.ping");

    res = await b.post(`/admin/shops/${shop.id}/hooks/${ep["id"]}`, { url: "https://evil.example", name: "LINE 通知", events: "order.paid", setting_to: "U123", enabled: "on" });
    expect(ep).toMatchObject({ url: bundledPluginUrl("line_notify"), settings: { to: "U123" }, events: ["order.paid"] });

    html = await (await b.get(`/admin/shops/${shop.id}/plugins`)).text();
    expect(html).toContain("設定を開く");

    // 無効化 → 一覧では無効、再度有効化は同じ行を使う
    await b.post(`/admin/shops/${shop.id}/hooks/${ep["id"]}`, { url: ep["url"] as string, name: "LINE 通知", events: "order.paid", setting_to: "U123" });
    expect(ep["enabled"]).toBe(false);
    res = await b.post(`/admin/shops/${shop.id}/plugins/line_notify/enable`, {});
    expect(sb.tables.hook_endpoints).toHaveLength(1);
    expect(ep["enabled"]).toBe(true);
    expect((await b.post(`/admin/shops/${shop.id}/plugins/nope/enable`, {})).status).toBe(404);
  });
});

describe("LINE 通知", () => {
  it("order.paid / inventory.low を LINE に push する。トークンが無ければ失敗として記録", async () => {
    const { sb, shop, sku, app, stripe } = setup();
    sb.tables.hook_endpoints.push({ id: "ep-line", shop_id: shop.id, name: "LINE 通知", url: bundledPluginUrl("line_notify"), events: ["order.paid", "inventory.low"], enabled: true, manifest: null, settings: { to: "U123" }, created_at: "" });
    const pushes: { auth: string | null; body: Record<string, unknown>; retryKey: string | null }[] = [];
    externalHosts.set("https://api.line.me/", async (req) => {
      pushes.push({ auth: req.headers.get("authorization"), body: (await req.json()) as Record<string, unknown>, retryKey: req.headers.get("x-line-retry-key") });
      return new Response("{}", { status: 200 });
    });
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "3" });
    await checkout(b, "/my-shop");
    const [sessionId] = [...stripe.sessions.keys()];
    await stripe.deliver(app, BASE, stripe.event(sessionId!, "checkout.session.completed"), "whsec_test");

    const fetchImpl = routedFetch(sb);
    const db = createPrivilegedDb({ url: sb.url, serviceRoleKey: sb.serviceRoleKey, fetch: fetchImpl });
    const config = memoryAdapters({ ...SECRETS }).config;
    const r = await deliverPendingHooks({ db, sessionSecret: "test-session-secret", fetch: fetchImpl, config });
    expect(r).toEqual({ claimed: 2, delivered: 2, failed: 0 });
    expect(pushes).toHaveLength(2);
    expect(pushes[0]!.auth).toBe("Bearer line-token");
    expect(pushes.every((p) => p.body["to"] === "U123")).toBe(true);
    const texts = pushes.map((p) => (p.body["messages"] as { text: string }[])[0]!.text).sort();
    expect(texts[0]).toContain("在庫が残りわずか");
    expect(texts[1]).toContain("新しい注文");
    expect(texts[1]).toContain("¥9,000（3 点）");
    expect(texts.join()).not.toContain("buyer@example.com");
    expect(pushes.map((p) => p.retryKey)).toEqual(sb.tables.hook_deliveries.map((d) => d["id"]));

    // トークン無し → 失敗（再送対象）
    sb.enqueue(shop.id, "order.paid", { order_id: "o", total_jpy: 1, items: [] });
    const noToken = memoryAdapters({ KOMOJU_SECRET_KEY: "x" }).config;
    const r2 = await deliverPendingHooks({ db, sessionSecret: "test-session-secret", fetch: fetchImpl, config: noToken });
    expect(r2).toEqual({ claimed: 1, delivered: 0, failed: 1 });
    expect(sb.tables.hook_deliveries.at(-1)).toMatchObject({ status: "pending", last_error: "line_notify: チャネルアクセストークンが未設定" });

    // 送信先未設定も失敗
    sb.tables.hook_endpoints[0]!["settings"] = {};
    sb.enqueue(shop.id, "order.paid", { order_id: "o", total_jpy: 1, items: [] });
    const r3 = await deliverPendingHooks({ db, sessionSecret: "test-session-secret", fetch: fetchImpl, config });
    expect(r3.failed).toBe(1);
    expect(String(sb.tables.hook_deliveries.at(-1)!["last_error"])).toContain("送信先ユーザー ID が未設定");
  });
});

describe("KOMOJU 決済", () => {
  function enableKomoju(sb: FakeSupabase, shopId: string, settings: Record<string, string> = {}) {
    sb.tables.hook_endpoints.push({ id: "ep-komoju", shop_id: shopId, name: "KOMOJU 決済", url: bundledPluginUrl("komoju"), events: [], enabled: true, manifest: null, settings, created_at: "" });
  }
  const address = { customer_name: "小森 花子", customer_email: "hanako@example.com", phone: "0312345678", postal_code: "100-0001", state: "東京都", city: "千代田区", line1: "千代田1-1", line2: "" };

  it("支払い方法の条件のクーポン（0044）: Stripe では断り、KOMOJU の決済ページは設定とクーポンが許す種類だけにする", async () => {
    const { sb, shop, sku, app } = setup();
    enableKomoju(sb, shop.id, { payment_types: "konbini, bank_transfer, paypay" });
    sb.tables.shops[0]!["settings"] = { ...(sb.tables.shops[0]!["settings"] as object), modules: { coupons: true } };
    sb.tables.coupon_campaigns.push({ id: "camp-pm", shop_id: shop.id, name: "PayPay か振込なら 500 円引き", code: "PM500", kind: "fixed", value: 500, active: true, combinable: false, audience: "public", conditions: { payment_methods: ["komoju:paypay", "komoju:bank_transfer", "komoju:credit_card"] }, created_at: "" });
    const sessions: Record<string, unknown>[] = [];
    externalHosts.set("https://komoju.com/", async (req) => {
      sessions.push((await req.json()) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: "ses_1", session_url: "https://komoju.com/sessions/ses_1", status: "pending" }), { status: 200 });
    });
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    await b.post("/my-shop/cart/coupon", { code: "PM500" });
    // カート: 支払い方法がまだなので仮に通す
    expect(await (await b.get("/my-shop/cart")).text()).toContain("PM500");
    // Stripe を選ぶと確認画面で断る
    await b.post("/my-shop/checkout", { provider: "stripe" });
    let review = await (await b.post("/my-shop/checkout/stripe", address)).text();
    expect(review).toContain("選んだお支払い方法ではご利用いただけません");
    // KOMOJU なら値引きし、決済ページは設定（konbini・bank_transfer・paypay）とクーポン（paypay・bank_transfer・credit_card）の重なりだけ
    await b.post("/my-shop/checkout", { provider: "komoju" });
    review = await (await b.post("/my-shop/checkout/komoju", address)).text();
    expect(review).not.toContain("選んだお支払い方法ではご利用いただけません");
    const res = await b.post("/my-shop/checkout/komoju", { quote: quoteFrom(review) });
    expect(res.headers.get("location")).toBe("https://komoju.com/sessions/ses_1");
    expect(sessions[0]).toMatchObject({ amount: 2500, payment_types: ["bank_transfer", "paypay"] });
  });

  it("お届け先入力 → 在庫予約 → セッション転送 → Webhook で注文確定（住所付き）", async () => {
    const { sb, shop, sku, app } = setup();
    enableKomoju(sb, shop.id, { payment_types: "konbini, bank_transfer", reservation_hours: "48" });
    const sessions: { auth: string | null; body: Record<string, unknown> }[] = [];
    const refunds: string[] = [];
    externalHosts.set("https://komoju.com/", async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/api/v1/sessions") {
        sessions.push({ auth: req.headers.get("authorization"), body: (await req.json()) as Record<string, unknown> });
        return new Response(JSON.stringify({ id: `ses_${sessions.length}`, session_url: `https://komoju.com/sessions/ses_${sessions.length}`, status: "pending" }), { status: 200 });
      }
      if (/\/api\/v1\/payments\/.+\/refund$/.test(u.pathname)) {
        refunds.push(req.headers.get("idempotency-key") ?? "");
        return new Response(JSON.stringify({ id: "ref_1", status: "refunded" }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "2" });
    let html = await (await b.get("/my-shop/cart")).text();
    expect(html).toContain("カードで支払う（Stripe）");
    expect(html).toContain("コンビニ・銀行振込など（KOMOJU）");

    let res = await b.post("/my-shop/checkout", { provider: "komoju" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('action="/my-shop/checkout/komoju"');
    expect(await (await b.post("/my-shop/checkout", { provider: "stripe" })).text()).toContain('action="/my-shop/checkout/stripe"');

    res = await b.post("/my-shop/checkout/komoju", { ...address, customer_email: "bad" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("入力内容を確認してください");
    expect(sb.tables.reservations).toHaveLength(0);

    res = await b.post("/my-shop/checkout/komoju", address);
    expect(res.status).toBe(200);
    // 最終確認画面: 支払時期の案内が KOMOJU 用になっている
    const review = await res.text();
    expect(review).toContain("ご注文内容の確認");
    expect(review).toContain("期限までにお支払いください");
    expect(sb.tables.reservations).toHaveLength(0);
    res = await b.post("/my-shop/checkout/komoju", { quote: quoteFrom(review) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://komoju.com/sessions/ses_1");
    const reservation = sb.tables.reservations[0]!;
    expect(reservation["customer"]).toMatchObject({ customer_email: "hanako@example.com", shipping_address: { postal_code: "100-0001", line1: "千代田1-1", phone: "0312345678", line2: null } });
    expect(new Date(reservation["expires_at"] as string).getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);
    expect(sb.tables.inventory[0]!["available"]).toBe(3);
    expect(sessions[0]!.auth).toBe(`Basic ${btoa("sk_komoju:")}`);
    expect(sessions[0]!.body).toMatchObject({
      amount: 6000,
      currency: "JPY",
      return_url: expect.stringMatching(new RegExp(`^${BASE}/my-shop/checkout/done\\?s=[A-Za-z0-9_.-]+$`)),
      external_order_num: reservation["id"],
      metadata: { reservation_id: reservation["id"], shop_id: shop.id },
      payment_types: ["konbini", "bank_transfer"],
      email: "hanako@example.com",
    });

    // Webhook: 署名不正 → 400
    const event = { id: "evt_k1", type: "payment.captured", data: { id: "pay_1", status: "captured", amount: 6000, currency: "JPY", external_order_num: reservation["id"], metadata: { reservation_id: reservation["id"], shop_id: shop.id }, customer_email: "hanako@example.com" } };
    const payload = JSON.stringify(event);
    let wh = await app.request(`${BASE}/webhooks/komoju`, { method: "POST", headers: { "content-type": "application/json", "x-komoju-signature": "deadbeef" }, body: payload });
    expect(wh.status).toBe(400);
    wh = await app.request(`${BASE}/webhooks/komoju`, { method: "POST", headers: { "content-type": "application/json", "x-komoju-signature": await signKomojuPayload(payload, "whsec_komoju") }, body: payload });
    expect(wh.status).toBe(200);
    expect(sb.tables.orders).toHaveLength(1);
    expect(sb.tables.orders[0]).toMatchObject({ payment_provider: "komoju", payment_ref: "pay_1", customer_email: "hanako@example.com", customer_name: "小森 花子", total_jpy: 6000 });
    expect(sb.tables.orders[0]!["shipping_address"]).toMatchObject({ postal_code: "100-0001", city: "千代田区" });
    expect(reservation["customer"]).toBeNull();

    // 再送は冪等
    wh = await app.request(`${BASE}/webhooks/komoju`, { method: "POST", headers: { "x-komoju-signature": await signKomojuPayload(payload, "whsec_komoju") }, body: payload });
    expect(sb.tables.orders).toHaveLength(1);

    // 期限切れ → 解放
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    await confirmAddress(b, "/my-shop", "komoju", address);
    const res2 = sb.tables.reservations[1]!;
    const expired = JSON.stringify({ id: "evt_k2", type: "payment.expired", data: { id: "pay_2", status: "expired", amount: 3000, currency: "JPY", metadata: { reservation_id: res2["id"], shop_id: shop.id } } });
    wh = await app.request(`${BASE}/webhooks/komoju`, { method: "POST", headers: { "x-komoju-signature": await signKomojuPayload(expired, "whsec_komoju") }, body: expired });
    expect(await wh.json()).toMatchObject({ released: true });
    expect(res2).toMatchObject({ status: "released", customer: null });
    expect(sb.tables.inventory[0]!["available"]).toBe(3);

    // 解放後に在庫が無くなってから captured → 返金
    sb.tables.inventory[0]!["available"] = 0;
    const late = JSON.stringify({ id: "evt_k3", type: "payment.captured", data: { id: "pay_2", status: "captured", amount: 3000, currency: "JPY", metadata: { reservation_id: res2["id"], shop_id: shop.id } } });
    wh = await app.request(`${BASE}/webhooks/komoju`, { method: "POST", headers: { "x-komoju-signature": await signKomojuPayload(late, "whsec_komoju") }, body: late });
    expect(await wh.json()).toMatchObject({ refunded: true });
    expect(refunds).toEqual(["refund-evt_k3"]);
  });

  it("Secret が無い・プラグイン無効なら KOMOJU の選択肢は出ず、直接 POST しても弾く", async () => {
    const { sb, shop, sku, app } = setup({ KOMOJU_SECRET_KEY: undefined });
    enableKomoju(sb, shop.id);
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    const html = await (await b.get("/my-shop/cart")).text();
    expect(html).not.toContain("KOMOJU");
    expect((await b.post("/my-shop/checkout", { provider: "komoju" })).headers.get("location")).toBe("/my-shop/cart");
    expect((await b.post("/my-shop/checkout/komoju", address)).headers.get("location")).toBe("/my-shop/cart");
    expect(sb.tables.reservations).toHaveLength(0);

    const { sb: sb2, sku: sku2, app: app2 } = setup();
    const b2 = new Browser(app2);
    await b2.post("/my-shop/cart/add", { sku_id: sku2.id, qty: "1" });
    expect(await (await b2.get("/my-shop/cart")).text()).not.toContain("KOMOJU");
    expect(sb2.tables.reservations).toHaveLength(0);
  });

  it("セッション作成に失敗したら予約を即時解放する", async () => {
    const { sb, shop, sku, app } = setup();
    enableKomoju(sb, shop.id);
    externalHosts.set("https://komoju.com/", async () => new Response(JSON.stringify({ error: { message: "bad" } }), { status: 422 }));
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    const res = await confirmAddress(b, "/my-shop", "komoju", address);
    expect(res.headers.get("location")).toBe("/my-shop/cart?error=payment");
    expect(sb.tables.reservations[0]).toMatchObject({ status: "released", customer: null });
    expect(sb.tables.inventory[0]!["available"]).toBe(5);
  });
});

describe("プラグイン画面の Secret 形式チェック", () => {
  it("Stripe のシークレットキーに whsec_ を貼っていれば取り違えを指摘する", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("o@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "s", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    const app = appWith(sb, { STRIPE_SECRET_KEY: "whsec_abc", STRIPE_WEBHOOK_SECRET: "whsec_def" });
    const b = await Browser.loggedIn(app, "o@example.com", "password-123");
    const html = await (await b.get(`/admin/shops/${shop.id}/plugins`)).text();
    expect(html).toContain("Secret の値の形が違うようです");
    expect(html).toContain("STRIPE_SECRET_KEY");
    expect(html).not.toContain("whsec_abc");
    // 決済事業者側に登録する Webhook の URL と購読イベントが出る
    expect(html).toContain(`${BASE}/webhooks/stripe`);
    expect(html).toContain("checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.expired, checkout.session.async_payment_failed");
    expect(html).toContain(`${BASE}/webhooks/komoju`);

    const ok = appWith(sb, { STRIPE_SECRET_KEY: "sk_test_123", STRIPE_WEBHOOK_SECRET: "whsec_def" });
    const b2 = await Browser.loggedIn(ok, "o@example.com", "password-123");
    expect(await (await b2.get(`/admin/shops/${shop.id}/plugins`)).text()).not.toContain("Secret の値の形が違うようです");
  });
});

describe("イベントを受け取らない同梱プラグイン（Stripe / KOMOJU）", () => {
  it("設定画面にイベント欄が無く、保存しても購読は空。誤って積まれた配信は再送せず完了扱い", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("o@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "s", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    sb.tables.hook_endpoints.push({ id: "ep-stripe", shop_id: shop.id, name: "Stripe 決済（カード）", url: bundledPluginUrl("stripe"), events: ["order.paid"], enabled: true, manifest: null, settings: {}, created_at: "" });
    const app = appWith(sb, { STRIPE_SECRET_KEY: "sk_test_1", STRIPE_WEBHOOK_SECRET: "whsec_1" });
    const b = await Browser.loggedIn(app, "o@example.com", "password-123");
    const html = await (await b.get(`/admin/shops/${shop.id}/hooks/ep-stripe`)).text();
    expect(html).toContain("Banto のイベントは購読しません");
    expect(html).not.toContain('name="events"');
    // 保存すると購読が空になる（以後は積まれない）
    await b.post(`/admin/shops/${shop.id}/hooks/ep-stripe`, { name: "Stripe 決済（カード）", url: bundledPluginUrl("stripe"), enabled: "on", events: "order.paid" });
    expect(sb.tables.hook_endpoints.find((e) => e["id"] === "ep-stripe")!["events"]).toEqual([]);

    // すでに積まれていた配信は、失敗ではなく完了（204）になる
    sb.tables.hook_deliveries.push({ id: "d-1", shop_id: shop.id, endpoint_id: "ep-stripe", event: "order.paid", payload: {}, status: "pending", attempts: 0, last_status: null, last_error: null, created_at: "2026-01-01T00:00:00Z", next_attempt_at: "2026-01-01T00:00:00Z" });
    const adapters = memoryAdapters({ SUPABASE_URL: sb.url, SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey, SESSION_SECRET: "test-session-secret" });
    const db = createPrivilegedDb({ url: sb.url, serviceRoleKey: sb.serviceRoleKey, fetch: sb.fetch });
    const r = await deliverPendingHooks({ db, sessionSecret: "test-session-secret", fetch: sb.fetch, config: adapters.config });
    expect(r.delivered).toBe(1);
    expect(sb.tables.hook_deliveries[0]).toMatchObject({ status: "delivered", last_status: 204, last_error: null });
  });
});
