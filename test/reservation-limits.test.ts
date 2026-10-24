import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, WEBHOOK_SECRET, appWith, checkout, memberMail, quoteFrom } from "./helpers";

/**
 * 0029_reservation_limits の Worker 側（2026-10-18 のコード監査のH2 / M7 / M10）。
 * DB の判定そのものは test/db/reservation-limits.test.ts。ここは Worker が材料を渡し、結果を正しく扱うことを確かめる。
 */
function setup(settings: Record<string, unknown> = {}, connected = true, vars: Record<string, string> = {}) {
  const sb = new FakeSupabase();
  const stripe = new FakeStripe();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", stripe_account_id: connected ? "acct_connected" : null, settings });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "T", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", price_jpy: 3000, available: 50 });
  const app = appWith(sb, vars, undefined, stripe);
  return { sb, stripe, shop, sku, app, b: new Browser(app) };
}
const stock = (sb: FakeSupabase, skuId: string) => sb.tables.inventory.find((i) => i["sku_id"] === skuId)!["available"];

describe("在庫予約の上限（0029）", () => {
  it("同じ quote で 2 回目は確定できない（期限切れとして出し直し）。予約には quote・申込者・IP の HMAC が付く", async () => {
    const { sb, sku, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    await b.post("/my-shop/checkout", { provider: "stripe" });
    const review = await b.post("/my-shop/checkout/stripe", ADDRESS);
    const quote = quoteFrom(await review.text());
    const first = await b.post("/my-shop/checkout/stripe", { quote }, { headers: { "cf-connecting-ip": "203.0.113.5" } });
    expect(first.status).toBe(303);
    const res = sb.tables.reservations[0]!;
    expect(res["quote_id"]).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(res["subject_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(res["ip_hash"]).toMatch(/^[0-9a-f]{64}$/);
    const again = await b.post("/my-shop/checkout/stripe", { quote });
    expect(again.headers.get("location")).toBe("/my-shop/cart?error=quote_used");
    expect(sb.tables.reservations).toHaveLength(1);
    expect(stock(sb, sku.id)).toBe(49);
  });

  it("同じ人の未確定の予約が 3 つになったら 4 つ目は断る（案内つき）。支払いが済めばまた予約できる", async () => {
    const { sb, sku, b } = setup();
    for (let i = 0; i < 3; i++) {
      await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
      expect((await checkout(b, "/my-shop")).status).toBe(303);
    }
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    const blocked = await checkout(b, "/my-shop");
    expect(blocked.headers.get("location")).toBe("/my-shop/cart?error=limit");
    expect(await (await b.get("/my-shop/cart?error=limit")).text()).toContain("お支払いが済んでいないご注文が多いため");
    expect(sb.tables.reservations).toHaveLength(3);
    sb.tables.reservations[0]!["status"] = "confirmed";
    expect((await checkout(b, "/my-shop")).status).toBe(303);
  });

  it("ヘッドレス: 同じ quote は 400 invalid_quote、上限は 429 too_many_reservations", async () => {
    const { sb, sku, app } = setup({ headless: { return_origins: ["https://wp.example.com"] } });
    const api = (path: string, body: unknown, ip = "198.51.100.1") =>
      app.request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "https://wp.example.com", "cf-connecting-ip": ip }, body: JSON.stringify(body) });
    const cart = (await (await api("/api/shops/my-shop/cart", { op: "add", sku_id: sku.id, qty: 1 })).json()) as { cart: string };
    const quote = async () => ((await (await api("/api/shops/my-shop/checkout/quote", { cart: cart.cart, provider: "stripe", address: ADDRESS })).json()) as { quote: string }).quote;
    const q1 = await quote();
    expect((await api("/api/shops/my-shop/checkout", { quote: q1 })).status).toBe(200);
    expect(await (await api("/api/shops/my-shop/checkout", { quote: q1 })).json()).toEqual({ error: "invalid_quote" });
    for (let i = 0; i < 2; i++) expect((await api("/api/shops/my-shop/checkout", { quote: await quote() })).status).toBe(200);
    const limited = await api("/api/shops/my-shop/checkout", { quote: await quote() }, "198.51.100.2");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "too_many_reservations" });
    expect(sb.tables.reservations).toHaveLength(3);
  });
});

describe("Webhook の照合（0029）", () => {
  it("Stripe: 支払額が Banto の計算と違えば確定せず返金して在庫を戻す。通貨が jpy でなくても同じ", async () => {
    const { sb, stripe, sku, app, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "2" });
    await checkout(b, "/my-shop");
    const [sessionId] = [...stripe.sessions.keys()];
    let wh = await stripe.deliver(app, BASE, stripe.event(sessionId!, "checkout.session.completed", { amount_total: 50 }), WEBHOOK_SECRET);
    expect(wh.status).toBe(200);
    expect(await wh.json()).toMatchObject({ refunded: true, ignored: "amount_mismatch" });
    expect(stripe.refunds).toEqual([{ account: "acct_connected", payment_intent: "pi_1", idempotencyKey: expect.stringMatching(/^refund-evt_/) }]);
    expect(sb.tables.orders).toHaveLength(0);
    expect(sb.tables.reservations[0]!["status"]).toBe("released");
    expect(stock(sb, sku.id)).toBe(50);
    // 通貨
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    await checkout(b, "/my-shop");
    const [, second] = [...stripe.sessions.keys()];
    wh = await stripe.deliver(app, BASE, stripe.event(second!, "checkout.session.completed", { currency: "usd" }), WEBHOOK_SECRET);
    expect(await wh.json()).toMatchObject({ ignored: "amount_mismatch" });
    expect(sb.tables.orders).toHaveLength(0);
    // 正しい額なら確定する
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    await checkout(b, "/my-shop");
    const [, , third] = [...stripe.sessions.keys()];
    wh = await stripe.deliver(app, BASE, stripe.event(third!, "checkout.session.completed"), WEBHOOK_SECRET);
    expect(await wh.json()).toMatchObject({ order_id: expect.any(String) });
    expect(sb.tables.orders).toHaveLength(1);
  });

  it("返金できないときは記録せず 500 を返し、Stripe に再送させる（決済済み・注文なし・返金なしで終わらせない）", async () => {
    const { sb, stripe, sku, app, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    await checkout(b, "/my-shop");
    const [sessionId] = [...stripe.sessions.keys()];
    const wh = await stripe.deliver(app, BASE, stripe.event(sessionId!, "checkout.session.completed", { amount_total: 50, payment_intent: null }), WEBHOOK_SECRET);
    expect(wh.status).toBe(500);
    expect(sb.tables.orders).toHaveLength(0);
    expect(sb.tables.reservations[0]!["status"]).toBe("pending");
    expect(sb.calls.some((x) => x.includes("record_webhook_event"))).toBe(false);
  });

  it("Stripe Connect: 別の接続済みアカウントからのイベントは無視する（metadata を真似ても確定しない）", async () => {
    const { sb, stripe, sku, app, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    await checkout(b, "/my-shop");
    const [sessionId] = [...stripe.sessions.keys()];
    const wh = await stripe.deliver(app, BASE, { ...stripe.event(sessionId!, "checkout.session.completed"), account: "acct_attacker" }, WEBHOOK_SECRET);
    expect(wh.status).toBe(200);
    expect(await wh.json()).toMatchObject({ ignored: "wrong_account" });
    expect(sb.tables.orders).toHaveLength(0);
    expect(sb.tables.reservations[0]!["status"]).toBe("pending");
    // 本物のアカウントからなら確定する
    await stripe.deliver(app, BASE, stripe.event(sessionId!, "checkout.session.completed"), WEBHOOK_SECRET);
    expect(sb.tables.orders).toHaveLength(1);
  });
});

describe("会員 API の CORS（0029）", () => {
  it("return_origins にある Origin だけに CORS を返す。login はメールを送るので他のサイトからは叩けない", async () => {
    const { sb, shop, app } = setup({ members_enabled: true, headless: { return_origins: ["https://wp.example.com"] } }, true, { RESEND_API_KEY: "re_test" });
    const mail = memberMail(sb, shop.id);
    try {
      const call = (origin: string, method = "POST") =>
        app.request(`${BASE}/api/shops/my-shop/members/login`, {
          method,
          headers: { origin, "content-type": "application/json", ...(method === "OPTIONS" ? { "access-control-request-method": "POST" } : {}) },
          ...(method === "POST" ? { body: JSON.stringify({ email: "m@example.com" }) } : {}),
        });
      let res = await call("https://wp.example.com", "OPTIONS");
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://wp.example.com");
      res = await call("https://evil.example", "OPTIONS");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      res = await call("https://wp.example.com");
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://wp.example.com");
      res = await call("https://evil.example");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      // 公開の API はこれまでどおり *
      res = await app.request(`${BASE}/api/shops/my-shop/products`, { headers: { origin: "https://evil.example" } });
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      mail.dispose();
    }
  });
});
