import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, WEBHOOK_SECRET, appWith, checkout, externalHosts } from "./helpers";
import { endpointSecret, signHookPayload, verifyHookSignature } from "../src/hooks/signing";
import { parseManifest, settingsFromForm } from "../src/hooks/manifest";
import { deliverPendingHooks } from "../src/hooks/deliver";
import { createPrivilegedDb } from "../src/db/privileged";
import { registerJobs } from "../src/jobs";
import { memoryAdapters } from "./helpers";
import { bundledPluginUrl } from "../src/plugins";

afterEach(() => externalHosts.clear());

describe("hooks 署名", () => {
  it("送信先のシークレットは SESSION_SECRET と id から決定的に導出される", async () => {
    const a = await endpointSecret("s1", "ep-1");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await endpointSecret("s1", "ep-1")).toBe(a);
    expect(await endpointSecret("s1", "ep-2")).not.toBe(a);
    expect(await endpointSecret("s2", "ep-1")).not.toBe(a);
  });

  it("署名と検証（プラグイン側のサンプル実装）", async () => {
    const now = 1_700_000_000;
    const header = await signHookPayload("sec", '{"a":1}', now);
    expect(await verifyHookSignature("sec", '{"a":1}', header, { now })).toBe(true);
    expect(await verifyHookSignature("sec", '{"a":2}', header, { now })).toBe(false);
    expect(await verifyHookSignature("other", '{"a":1}', header, { now })).toBe(false);
    expect(await verifyHookSignature("sec", '{"a":1}', header, { now: now + 1000 })).toBe(false);
    expect(await verifyHookSignature("sec", '{"a":1}', undefined)).toBe(false);
  });
});

describe("マニフェスト", () => {
  it("不正な項目を落とし、シークレット型は受け付けない", () => {
    const m = parseManifest({
      name: "LINE 通知",
      version: "1.0.0",
      events: ["order.paid", "DROP", "inventory.low"],
      settings: [
        { key: "to", label: "送信先 ID", type: "text", required: true },
        { key: "token", label: "トークン", type: "secret" },
        { key: "Bad Key", type: "text" },
        { key: "verbose", type: "boolean" },
        { key: "lang", type: "select", options: [{ value: "ja", label: "日本語" }, { value: "en" }] },
      ],
      admin_url: "http://insecure.example/admin",
    });
    expect(m).toEqual({
      name: "LINE 通知",
      version: "1.0.0",
      events: ["order.paid", "inventory.low"],
      settings: [
        { key: "to", label: "送信先 ID", type: "text", required: true },
        { key: "verbose", label: "verbose", type: "boolean" },
        { key: "lang", label: "lang", type: "select", options: [{ value: "ja", label: "日本語" }, { value: "en", label: "en" }] },
      ],
    });
    expect(parseManifest({ events: [] })).toBeNull();
    expect(parseManifest("x")).toBeNull();
    expect(settingsFromForm(m, { setting_to: "U123", setting_verbose: "on", setting_lang: "xx" })).toEqual({ to: "U123", verbose: true, lang: "ja" });
  });
});

function setup() {
  const sb = new FakeSupabase();
  const stripe = new FakeStripe();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", stripe_account_id: "acct_connected" });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", price_jpy: 3000, available: 5 });
  const app = appWith(sb, {}, undefined, stripe);
  return { sb, stripe, shop, tee, sku, app };
}

describe("連携（管理画面）", () => {
  it("マニフェスト取得 → 登録 → 設定保存 → テスト送信 → 削除", async () => {
    const { sb, shop, app } = setup();
    const received: { headers: Headers; body: string }[] = [];
    externalHosts.set("https://plugin.example/", async (req) => {
      if (req.method === "GET") return new Response(JSON.stringify({ name: "CRM 連携", events: ["order.paid"], settings: [{ key: "list", label: "リスト名", type: "text" }] }), { status: 200 });
      received.push({ headers: req.headers, body: await req.text() });
      return new Response("ok", { status: 200 });
    });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");

    let html = await (await b.get(`/admin/shops/${shop.id}/hooks`)).text();
    expect(html).toContain("送信先はまだありません");

    let res = await b.post(`/admin/shops/${shop.id}/hooks/new`, { url: "ftp://x" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/hooks?flash=invalid_url`);
    // 同梱プラグインの内部 URL は外部の送信先として登録できない（通知が二重に届く。0031）
    res = await b.post(`/admin/shops/${shop.id}/hooks/new`, { url: "https://banto.invalid/plugins/email_resend" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/hooks?flash=invalid_url`);

    res = await b.post(`/admin/shops/${shop.id}/hooks/new`, { url: "https://plugin.example/banto" });
    expect(res.status).toBe(200);
    html = await res.text();
    expect(html).toContain("マニフェストを読み込みました");
    expect(html).toContain("CRM 連携");
    expect(html).toContain('name="setting_list"');
    expect(html).toMatch(/value="order.paid" checked/);

    res = await b.post(`/admin/shops/${shop.id}/hooks`, { url: "https://plugin.example/banto", name: "CRM 連携", events: "order.paid", setting_list: "VIP", enabled: "on" });
    const ep = sb.tables.hook_endpoints[0]!;
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/hooks/${ep["id"]}?flash=saved`);
    expect(ep).toMatchObject({ shop_id: shop.id, url: "https://plugin.example/banto", events: ["order.paid"], enabled: true, settings: { list: "VIP" } });
    expect((ep["manifest"] as { name: string }).name).toBe("CRM 連携");

    html = await (await b.get(`/admin/shops/${shop.id}/hooks/${ep["id"]}`)).text();
    const secret = await endpointSecret("test-session-secret", ep["id"] as string);
    expect(html).toContain(secret);
    expect(html).toContain('value="VIP"');

    // テスト送信は署名付きで同期 POST
    res = await b.post(`/admin/shops/${shop.id}/hooks/${ep["id"]}/test`, {});
    expect(res.headers.get("location")).toContain("flash=test_ok");
    expect(received).toHaveLength(1);
    const ping = received[0]!;
    expect(ping.headers.get("x-banto-event")).toBe("banto.ping");
    expect(await verifyHookSignature(secret, ping.body, ping.headers.get("x-banto-signature") ?? undefined)).toBe(true);
    expect(JSON.parse(ping.body)).toMatchObject({ event: "banto.ping", shop_id: shop.id, settings: { list: "VIP" } });

    // 無効化
    res = await b.post(`/admin/shops/${shop.id}/hooks/${ep["id"]}`, { url: "https://plugin.example/banto", name: "CRM 連携", events: "order.paid", setting_list: "VIP2" });
    expect(ep).toMatchObject({ enabled: false, settings: { list: "VIP2" } });

    res = await b.post(`/admin/shops/${shop.id}/hooks/${ep["id"]}/delete`, {});
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/hooks?flash=deleted`);
    expect(sb.tables.hook_endpoints).toHaveLength(0);
  });

  it("他人のショップの送信先には触れない", async () => {
    const { sb, app } = setup();
    const other = sb.addUser("other@example.com", "password-456", { owner: true });
    const otherShop = sb.addShop(other.id, { slug: "other" });
    sb.tables.hook_endpoints.push({ id: "ep-x", shop_id: otherShop.id, name: "x", url: "https://x.example", events: [], enabled: true, manifest: null, settings: {}, created_at: "" });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect((await b.get(`/admin/shops/${otherShop.id}/hooks`)).status).toBe(404);
    expect((await b.post(`/admin/shops/${otherShop.id}/hooks/ep-x/delete`, {})).status).toBe(404);
    expect(sb.tables.hook_endpoints).toHaveLength(1);
  });
});

describe("配信ワーカー", () => {
  it("注文確定・発送・商品更新でキューに積まれ、Cron が署名付きで配信し、失敗は再送・5回で諦める", async () => {
    const { sb, stripe, shop, sku, tee, app } = setup();
    sb.tables.hook_endpoints.push({ id: "ep-1", shop_id: shop.id, name: "crm", url: "https://crm.example/hook", events: ["order.paid", "order.shipped", "product.updated", "inventory.low"], enabled: true, manifest: null, settings: { list: "VIP" }, created_at: "" });
    const got: { event: string; body: Record<string, unknown>; sig: string | null }[] = [];
    let mode: "ok" | "fail" = "ok";
    externalHosts.set("https://crm.example/", async (req) => {
      const body = await req.text();
      got.push({ event: req.headers.get("x-banto-event")!, body: JSON.parse(body), sig: req.headers.get("x-banto-signature") });
      return new Response(mode === "ok" ? "ok" : "nope", { status: mode === "ok" ? 200 : 503 });
    });

    // 購入 → Webhook で確定
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "3" });
    await checkout(b, "/my-shop");
    const [sessionId] = [...stripe.sessions.keys()];
    await stripe.deliver(app, BASE, stripe.event(sessionId!, "checkout.session.completed"), WEBHOOK_SECRET);
    expect(sb.tables.hook_deliveries.map((d) => d["event"]).sort()).toEqual(["inventory.low", "order.paid"]);

    // 発送・商品更新
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const order = sb.tables.orders[0]!;
    await admin.post(`/admin/shops/${shop.id}/orders/${order["id"]}/status`, { status: "shipped" });
    await admin.post(`/admin/shops/${shop.id}/products/${tee.id}`, { name: "Tシャツ改", slug: "tee", published: "on" });
    expect(sb.tables.hook_deliveries.map((d) => d["event"]).sort()).toEqual(["inventory.low", "order.paid", "order.shipped", "product.updated"]);

    // Cron 相当: registerJobs → runAll
    const adapters = memoryAdapters({ SUPABASE_URL: sb.url, SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey, SESSION_SECRET: "test-session-secret" });
    const jobs = new Map<string, () => Promise<void>>();
    adapters.scheduler = { register: (n, j) => void jobs.set(n, j), runAll: async () => { for (const j of jobs.values()) await j(); } };
    const fetchImpl: typeof fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      for (const [prefix, h] of externalHosts) if (url.startsWith(prefix)) return Promise.resolve(h(new Request(input, init)));
      return sb.fetch(input, init);
    };
    registerJobs(adapters, { fetch: fetchImpl });
    expect([...jobs.keys()]).toContain("deliver_hooks");
    await adapters.scheduler.runAll();

    expect(got.map((g) => g.event).sort()).toEqual(["inventory.low", "order.paid", "order.shipped", "product.updated"]);
    const paid = got.find((g) => g.event === "order.paid")!;
    expect(paid.body).toMatchObject({ event: "order.paid", shop_id: shop.id, attempt: 1, data: { order_id: order["id"], total_jpy: 9000 } });
    expect(JSON.stringify(paid.body)).not.toContain("buyer@example.com");
    const secret = await endpointSecret("test-session-secret", "ep-1");
    expect(await verifyHookSignature(secret, JSON.stringify(paid.body), paid.sig ?? undefined)).toBe(true);
    expect(sb.tables.hook_deliveries.every((d) => d["status"] === "delivered")).toBe(true);

    // 管理画面の配信履歴
    const html = await (await admin.get(`/admin/shops/${shop.id}/hooks`)).text();
    expect(html).toContain("配信済み");
    expect(html).toContain("order.paid");

    // 失敗 → バックオフ → 5回で failed
    mode = "fail";
    const db = createPrivilegedDb({ url: sb.url, serviceRoleKey: sb.serviceRoleKey, fetch: fetchImpl });
    sb.enqueue(shop.id, "product.updated", { product_id: tee.id });
    const d = sb.tables.hook_deliveries.at(-1)!;
    for (let i = 1; i <= 5; i++) {
      d["next_attempt_at"] = new Date(0).toISOString();
      const r = await deliverPendingHooks({ db, sessionSecret: "test-session-secret", fetch: fetchImpl });
      expect(r).toEqual({ claimed: 1, delivered: 0, failed: 1 });
      expect(d["attempts"]).toBe(i);
      expect(d["last_status"]).toBe(503);
      expect(d["last_error"]).toBe("nope");
    }
    expect(d["status"]).toBe("failed");
    d["next_attempt_at"] = new Date(0).toISOString();
    expect(await deliverPendingHooks({ db, sessionSecret: "test-session-secret", fetch: fetchImpl })).toEqual({ claimed: 0, delivered: 0, failed: 0 });

    // ネットワークエラー・タイムアウトも失敗として記録
    externalHosts.set("https://crm.example/", () => {
      throw new TypeError("fetch failed");
    });
    sb.enqueue(shop.id, "product.updated", { product_id: tee.id });
    const r = await deliverPendingHooks({ db, sessionSecret: "test-session-secret", fetch: fetchImpl });
    expect(r.failed).toBe(1);
    expect(sb.tables.hook_deliveries.at(-1)).toMatchObject({ status: "pending", attempts: 1, last_status: null, last_error: "fetch failed" });
  });
});

describe("Workers の fetch 呼び出し（Illegal invocation 対策）", () => {
  it("Cron の配信と同梱プラグインは、素の fetch を渡されてもプロパティ経由で呼ばない", async () => {
    // Workers の fetch は this がオブジェクトだと "Illegal invocation" を投げる。それを再現する fetch を渡す
    const calls: string[] = [];
    const strictFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.startsWith("https://api.resend.com/")) return Promise.resolve(new Response(JSON.stringify({ id: "em_1" }), { status: 200 }));
      for (const [prefix, handler] of externalHosts) if (url.startsWith(prefix)) return Promise.resolve(handler(new Request(input, init)));
      return sb.fetch(input, init);
    } as typeof fetch;

    const sb = new FakeSupabase();
    const owner = sb.addUser("o@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "s", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { contact_email: "shop@example.com" } });
    sb.tables.hook_endpoints.push({ id: "ep-mail", shop_id: shop.id, name: "メール通知", url: bundledPluginUrl("email_resend"), events: ["order.paid"], enabled: true, manifest: null, settings: { from: "S <order@example.com>" }, created_at: "" });
    sb.tables.hook_endpoints.push({ id: "ep-ext", shop_id: shop.id, name: "crm", url: "https://crm.example/hook", events: ["order.paid"], enabled: true, manifest: null, settings: {}, created_at: "" });
    sb.tables.orders.push({ id: "order-1", shop_id: shop.id, number: 1001, status: "paid", total_jpy: 100, shipping_jpy: 0, customer_email: "a@example.com", customer_name: "A", shipping_address: {}, payment_provider: "stripe", payment_ref: "pi", shipped_at: null, created_at: "2026-01-01T00:00:00Z" });
    externalHosts.set("https://crm.example/", async () => new Response("ok"));
    const adapters = memoryAdapters({ SUPABASE_URL: sb.url, SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey, SESSION_SECRET: "test-session-secret", RESEND_API_KEY: "re_test" });
    const jobs = new Map<string, () => Promise<void>>();
    adapters.scheduler = { register: (n, j) => void jobs.set(n, j), runAll: async () => { for (const j of jobs.values()) await j(); } };
    const db = createPrivilegedDb({ url: sb.url, serviceRoleKey: sb.serviceRoleKey, fetch: strictFetch });
    await db.enqueueHook(shop.id, "order.paid", { order_id: "order-1", order_number: 1001, shop_id: shop.id, total_jpy: 100, items: [] });

    registerJobs(adapters, { fetch: strictFetch });
    await adapters.scheduler.runAll();
    const statuses = sb.tables.hook_deliveries.map((d) => [d["endpoint_id"], d["status"], d["last_error"]]);
    expect(statuses).toEqual(expect.arrayContaining([["ep-mail", "delivered", null], ["ep-ext", "delivered", null]]));
    expect(calls.some((u) => u.startsWith("https://api.resend.com/"))).toBe(true);
  });
});
