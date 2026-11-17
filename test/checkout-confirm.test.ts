import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, WEBHOOK_SECRET, appWith, checkout, externalHosts, quoteFrom } from "./helpers";
import { bundledPluginUrl } from "../src/plugins";
import { signKomojuPayload } from "../src/plugins/komoju";

/**
 * 注文の確定（0090）: 支払額は整数で、通貨は jpy で必ず渡す（0 円の確定も）。決済した口座（orders.payment_account）を注文に残し、
 * 返金はその口座で行う。解放済みの予約の確定で DB が quote_superseded / coupon_exhausted_after_release を投げたら、
 * 在庫切れ（insufficient_stock_after_release）と同じく返金してイベントを済みにする（500 を繰り返さない）
 */
afterEach(() => externalHosts.clear());

const KOMOJU = { KOMOJU_SECRET_KEY: "sk_komoju", KOMOJU_WEBHOOK_SECRET: "whsec_komoju" };

function setup(opts: { connected?: boolean; komoju?: boolean } = {}) {
  const sb = new FakeSupabase();
  const stripe = new FakeStripe();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "マイショップ",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    stripe_account_id: (opts.connected ?? true) ? "acct_connected" : null,
    settings: { shipping: { mode: "flat", flat_fee_jpy: 0, free_over_jpy: 0, by_prefecture: {} }, modules: { coupons: true } },
  });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const teeM = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 5 });
  if (!(opts.connected ?? true)) sb.tables.hook_endpoints.push({ id: "ep-stripe", shop_id: shop.id, name: "Stripe", url: bundledPluginUrl("stripe"), events: [], enabled: true, manifest: null, settings: {}, created_at: "" });
  if (opts.komoju) sb.tables.hook_endpoints.push({ id: "ep-komoju", shop_id: shop.id, name: "KOMOJU 決済", url: bundledPluginUrl("komoju"), events: [], enabled: true, manifest: null, settings: { payment_types: "konbini" }, created_at: "" });
  const app = appWith(sb, opts.komoju ? KOMOJU : {}, undefined, stripe);
  const campaign = (fields: Record<string, unknown>) => {
    const row = { id: `camp-${sb.tables.coupon_campaigns.length + 1}`, shop_id: shop.id, value: 0, starts_at: null, ends_at: null, usage_limit: null, per_customer_limit: null, combinable: false, audience: "public", conditions: {}, active: true, created_at: new Date().toISOString(), ...fields };
    sb.tables.coupon_campaigns.push(row);
    return row;
  };
  return { sb, stripe, shop, teeM, app, campaign, b: new Browser(app) };
}

const stock = (sb: FakeSupabase, skuId: string) => sb.tables.inventory.find((i) => i["sku_id"] === skuId)!["available"];

describe("注文の確定: 支払額・通貨・決済の口座", () => {
  it("0 円の注文はその場で確定する（支払額 0・通貨 jpy を渡す）", async () => {
    const { sb, stripe, teeM, campaign, b } = setup();
    campaign({ name: "全額", code: "ALL", kind: "fixed", value: 100000, combinable: true });
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    await b.post("/my-shop/cart/coupon", { code: "ALL" });
    const html = await (await b.post("/my-shop/checkout/stripe", ADDRESS)).text();
    const res = await b.post("/my-shop/checkout/stripe", { quote: quoteFrom(html) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("free=1");
    expect(stripe.sessions.size).toBe(0);
    expect(sb.tables.orders[0]).toMatchObject({ status: "paid", total_jpy: 0, amount_paid_jpy: 0, payment_provider: "free", payment_account: null });
    expect(stock(sb, teeM.id)).toBe(4);
  });

  it("Stripe Connect の注文は接続先のアカウント、API キー方式は platform の印を payment_account に残す", async () => {
    const connect = setup();
    await connect.b.post("/my-shop/cart/add", { sku_id: connect.teeM.id, qty: "1" });
    await checkout(connect.b, "/my-shop");
    const [sid] = [...connect.stripe.sessions.keys()];
    await connect.stripe.deliver(connect.app, BASE, connect.stripe.event(sid!, "checkout.session.completed"), WEBHOOK_SECRET);
    expect(connect.sb.tables.orders[0]).toMatchObject({ payment_provider: "stripe", payment_account: "acct_connected" });

    const own = setup({ connected: false });
    await own.b.post("/my-shop/cart/add", { sku_id: own.teeM.id, qty: "1" });
    await checkout(own.b, "/my-shop");
    const [sid2] = [...own.stripe.sessions.keys()];
    const event = own.stripe.event(sid2!, "checkout.session.completed");
    expect(event.account).toBeUndefined();
    await own.stripe.deliver(own.app, BASE, event, WEBHOOK_SECRET);
    expect(own.sb.tables.orders[0]).toMatchObject({ payment_provider: "stripe", payment_account: "platform" });
  });

  it("キャンセルの返金は注文に残した口座で行う（接続先を変えた後の旧注文も、決済した口座で返金する）", async () => {
    const { sb, stripe, shop, teeM, app, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    await checkout(b, "/my-shop");
    const [sid] = [...stripe.sessions.keys()];
    await stripe.deliver(app, BASE, stripe.event(sid!, "checkout.session.completed"), WEBHOOK_SECRET);
    const order = sb.tables.orders[0]!;
    expect(order["payment_account"]).toBe("acct_connected");
    // その後、ショップの接続先が変わった
    sb.tables.shops[0]!["stripe_account_id"] = "acct_other";
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const res = await admin.post(`/admin/shops/${shop.id}/orders/${order["id"]}/status`, { status: "cancelled" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/orders/${order["id"]}?flash=refunded`);
    expect(stripe.refunds).toEqual([{ account: "acct_connected", payment_intent: order["payment_ref"], idempotencyKey: `cancel-${order["id"]}` }]);
    expect(order["status"]).toBe("refunded");
  });

  it("API キー方式で決済した注文（platform）は、後から Connect をつないでも自分のアカウントで返金する", async () => {
    const { sb, stripe, shop, teeM, app, b } = setup({ connected: false });
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    await checkout(b, "/my-shop");
    const [sid] = [...stripe.sessions.keys()];
    await stripe.deliver(app, BASE, stripe.event(sid!, "checkout.session.completed"), WEBHOOK_SECRET);
    const order = sb.tables.orders[0]!;
    sb.tables.shops[0]!["stripe_account_id"] = "acct_connected";
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    await admin.post(`/admin/shops/${shop.id}/orders/${order["id"]}/status`, { status: "cancelled" });
    expect(stripe.refunds).toEqual([{ account: null, payment_intent: order["payment_ref"], idempotencyKey: `cancel-${order["id"]}` }]);
  });
});

describe("Webhook: 解放済みの予約を確定できないときは返金して済みにする", () => {
  it("Stripe: 同じ quote で出し直した予約が生きていれば（quote_superseded）返金し、在庫は動かない", async () => {
    const { sb, stripe, teeM, app, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "2" });
    await checkout(b, "/my-shop");
    const [sid] = [...stripe.sessions.keys()];
    const first = sb.tables.reservations[0]!;
    expect(first["quote_id"]).toBeTruthy();
    // TTL 切れで解放され、同じ quote で予約が出し直されて生きている
    first["status"] = "released";
    sb.tables.inventory[0]!["available"] = 5;
    sb.tables.reservations.push({ ...first, id: "res-again", status: "pending" });
    const wh = await stripe.deliver(app, BASE, stripe.event(sid!, "checkout.session.completed"), WEBHOOK_SECRET);
    expect(wh.status).toBe(200);
    expect(await wh.json()).toMatchObject({ refunded: true });
    expect(stripe.refunds).toEqual([{ account: "acct_connected", payment_intent: expect.stringMatching(/^pi_/), idempotencyKey: expect.stringMatching(/^refund-evt_/) }]);
    expect(sb.tables.orders).toHaveLength(0);
    expect(stock(sb, teeM.id)).toBe(5);
    // 再送しても二重に返金しない（イベントは済み）
    expect(sb.webhookEvents.size).toBe(1);
  });

  it("Stripe: 解放後にクーポンの先着枠が埋まっていれば（coupon_exhausted_after_release）返金する", async () => {
    const { sb, stripe, teeM, campaign, app, b } = setup();
    const camp = campaign({ name: "先着 1 名 500 円引き", code: "FIRST", kind: "fixed", value: 500, usage_limit: 1 });
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    await b.post("/my-shop/cart/coupon", { code: "FIRST" });
    await checkout(b, "/my-shop");
    const [sid] = [...stripe.sessions.keys()];
    const res = sb.tables.reservations[0]!;
    const red = sb.tables.coupon_redemptions.find((r) => r["reservation_id"] === res["id"])!;
    expect(red).toMatchObject({ campaign_id: camp.id, status: "held" });
    // TTL 切れで解放され、枠はほかの人が使った
    res["status"] = "released";
    red["status"] = "released";
    sb.tables.inventory[0]!["available"] = 5;
    sb.tables.coupon_redemptions.push({ id: "red-other", shop_id: res["shop_id"], campaign_id: camp.id, reservation_id: "res-other", order_id: "order-other", subject: "e:other", amount_jpy: 500, status: "used", grant_id: null, created_at: new Date().toISOString() });
    const wh = await stripe.deliver(app, BASE, stripe.event(sid!, "checkout.session.completed"), WEBHOOK_SECRET);
    expect(wh.status).toBe(200);
    expect(await wh.json()).toMatchObject({ refunded: true });
    expect(stripe.refunds).toHaveLength(1);
    expect(sb.tables.orders).toHaveLength(0);
    expect(stock(sb, teeM.id)).toBe(5);
    expect(red["status"]).toBe("released");
  });

  it("KOMOJU: quote_superseded でも返金して済みにする", async () => {
    const { sb, teeM, shop, app, b } = setup({ komoju: true });
    const refunds: string[] = [];
    externalHosts.set("https://komoju.com/", async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/api/v1/sessions") return new Response(JSON.stringify({ id: "ses_1", session_url: "https://komoju.com/sessions/ses_1", status: "pending" }), { status: 200 });
      if (/\/api\/v1\/payments\/.+\/refund$/.test(u.pathname)) {
        refunds.push(req.headers.get("idempotency-key") ?? "");
        return new Response(JSON.stringify({ id: "ref_1", status: "refunded" }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    const res = await checkout(b, "/my-shop", "komoju");
    expect(res.headers.get("location")).toBe("https://komoju.com/sessions/ses_1");
    const first = sb.tables.reservations[0]!;
    first["status"] = "released";
    sb.tables.inventory[0]!["available"] = 5;
    sb.tables.reservations.push({ ...first, id: "res-again", status: "pending" });
    const payload = JSON.stringify({ id: "evt_k1", type: "payment.captured", data: { id: "pay_1", status: "captured", amount: 3000, currency: "JPY", metadata: { reservation_id: first["id"], shop_id: shop.id } } });
    const wh = await app.request(`${BASE}/webhooks/komoju`, { method: "POST", headers: { "content-type": "application/json", "x-komoju-signature": await signKomojuPayload(payload, "whsec_komoju") }, body: payload });
    expect(wh.status).toBe(200);
    expect(await wh.json()).toMatchObject({ refunded: true });
    expect(refunds).toEqual(["refund-evt_k1"]);
    expect(sb.tables.orders).toHaveLength(0);
    expect(stock(sb, teeM.id)).toBe(5);
  });

  it("KOMOJU の注文は payment_account に komoju を残す", async () => {
    const { sb, teeM, shop, app, b } = setup({ komoju: true });
    externalHosts.set("https://komoju.com/", async () => new Response(JSON.stringify({ id: "ses_1", session_url: "https://komoju.com/sessions/ses_1", status: "pending" }), { status: 200 }));
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    await checkout(b, "/my-shop", "komoju");
    const first = sb.tables.reservations[0]!;
    const payload = JSON.stringify({ id: "evt_k1", type: "payment.captured", data: { id: "pay_1", status: "captured", amount: 3000, currency: "JPY", metadata: { reservation_id: first["id"], shop_id: shop.id } } });
    await app.request(`${BASE}/webhooks/komoju`, { method: "POST", headers: { "content-type": "application/json", "x-komoju-signature": await signKomojuPayload(payload, "whsec_komoju") }, body: payload });
    expect(sb.tables.orders[0]).toMatchObject({ payment_provider: "komoju", payment_account: "komoju" });
  });
});

describe("Webhook の再配信（0128）: 返金して済みにした決済は、在庫が戻っても注文にならない", () => {
  const komojuHost = (refunds: string[]) =>
    externalHosts.set("https://komoju.com/", async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/api/v1/sessions") return new Response(JSON.stringify({ id: "ses_1", session_url: "https://komoju.com/sessions/ses_1", status: "pending" }), { status: 200 });
      if (/\/api\/v1\/payments\/.+\/refund$/.test(u.pathname)) {
        refunds.push(req.headers.get("idempotency-key") ?? "");
        return new Response(JSON.stringify({ id: "ref_1", status: "refunded" }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });
  const komojuDeliver = (app: ReturnType<typeof appWith>, id: string, reservationId: unknown, shopId: string, amount = 3000) => {
    const payload = JSON.stringify({ id, type: "payment.captured", data: { id: "pay_1", status: "captured", amount, currency: "JPY", metadata: { reservation_id: reservationId, shop_id: shopId } } });
    return signKomojuPayload(payload, "whsec_komoju").then((sig) => app.request(`${BASE}/webhooks/komoju`, { method: "POST", headers: { "content-type": "application/json", "x-komoju-signature": sig }, body: payload }));
  };

  it("Stripe: 解放後の在庫切れで返金したイベントを、在庫が戻った後に再配信しても注文にならず、二重に返金もしない", async () => {
    const { sb, stripe, teeM, app, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "2" });
    await checkout(b, "/my-shop");
    const [sid] = [...stripe.sessions.keys()];
    const res = sb.tables.reservations[0]!;
    // TTL 切れで解放され、在庫は他の人に渡った
    res["status"] = "released";
    sb.tables.inventory[0]!["available"] = 0;
    const ev = stripe.event(sid!, "checkout.session.completed");
    let wh = await stripe.deliver(app, BASE, ev, WEBHOOK_SECRET);
    expect(await wh.json()).toMatchObject({ refunded: true });
    expect(res["status"]).toBe("refunded");
    expect(res["refund_event"]).toBe(`stripe:${ev.id}`);
    // 在庫が戻った後に同じイベントが再配信される
    sb.tables.inventory[0]!["available"] = 5;
    wh = await stripe.deliver(app, BASE, ev, WEBHOOK_SECRET);
    expect(wh.status).toBe(200);
    expect(await wh.json()).toEqual({ received: true, duplicate: true });
    expect(sb.tables.orders).toHaveLength(0);
    expect(stripe.refunds).toHaveLength(1);
    expect(stock(sb, teeM.id)).toBe(5);
    // 記録される前に落ちていたとしても（記録を消して再現）、DB が refunded を覚えているので注文にならない。同じイベントなら返金をやり直す（冪等）
    sb.webhookEvents.clear();
    wh = await stripe.deliver(app, BASE, ev, WEBHOOK_SECRET);
    expect(await wh.json()).toEqual({ received: true, refunded: true });
    expect(sb.tables.orders).toHaveLength(0);
    expect(stripe.refunds).toHaveLength(2);
    expect(stripe.refunds[1]!.idempotencyKey).toBe(stripe.refunds[0]!.idempotencyKey);
    // 別のイベントが同じ予約を確定しようとしても、注文にも返金にもならない
    sb.webhookEvents.clear();
    const other = stripe.event(sid!, "checkout.session.async_payment_succeeded");
    wh = await stripe.deliver(app, BASE, other, WEBHOOK_SECRET);
    expect(await wh.json()).toEqual({ received: true, ignored: "reservation_refunded" });
    expect(sb.tables.orders).toHaveLength(0);
    expect(stripe.refunds).toHaveLength(2);
    expect(stock(sb, teeM.id)).toBe(5);
  });

  it("Stripe: 支払額の不一致は、返金すると決めた時点で在庫を戻し、再配信しても何もしない", async () => {
    const { sb, stripe, teeM, app, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "2" });
    await checkout(b, "/my-shop");
    const [sid] = [...stripe.sessions.keys()];
    expect(stock(sb, teeM.id)).toBe(3);
    const ev = stripe.event(sid!, "checkout.session.completed", { amount_total: 1 });
    let wh = await stripe.deliver(app, BASE, ev, WEBHOOK_SECRET);
    expect(await wh.json()).toMatchObject({ refunded: true, ignored: "amount_mismatch" });
    expect(stock(sb, teeM.id)).toBe(5);
    expect(sb.tables.reservations[0]!["status"]).toBe("refunded");
    wh = await stripe.deliver(app, BASE, ev, WEBHOOK_SECRET);
    expect(await wh.json()).toEqual({ received: true, duplicate: true });
    expect(stripe.refunds).toHaveLength(1);
    expect(sb.tables.orders).toHaveLength(0);
  });

  it("KOMOJU: 署名に時刻が無いので同じ本文をいつでも再送できるが、記録済みなら何もしない。記録の前に落ちていても注文にならない", async () => {
    const { sb, teeM, shop, app, b } = setup({ komoju: true });
    const refunds: string[] = [];
    komojuHost(refunds);
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    await checkout(b, "/my-shop", "komoju");
    const res = sb.tables.reservations[0]!;
    res["status"] = "released";
    sb.tables.inventory[0]!["available"] = 0;
    let wh = await komojuDeliver(app, "evt_k1", res["id"], shop.id);
    expect(await wh.json()).toMatchObject({ refunded: true });
    expect(res["status"]).toBe("refunded");
    sb.tables.inventory[0]!["available"] = 5;
    wh = await komojuDeliver(app, "evt_k1", res["id"], shop.id);
    expect(await wh.json()).toEqual({ received: true, duplicate: true });
    sb.webhookEvents.clear();
    wh = await komojuDeliver(app, "evt_k1", res["id"], shop.id);
    expect(await wh.json()).toEqual({ received: true, refunded: true });
    expect(refunds).toEqual(["refund-evt_k1", "refund-evt_k1"]);
    sb.webhookEvents.clear();
    wh = await komojuDeliver(app, "evt_k2", res["id"], shop.id);
    expect(await wh.json()).toEqual({ received: true, ignored: "reservation_refunded" });
    expect(refunds).toHaveLength(2);
    expect(sb.tables.orders).toHaveLength(0);
    expect(stock(sb, teeM.id)).toBe(5);
  });

  it("0128 が当たるまでは今までどおり（成功したら記録するだけ）", async () => {
    const { sb, stripe, teeM, app, b } = setup();
    sb.appliedMigrations = sb.appliedMigrations.filter((m) => m !== "0128_webhook_replay");
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    await checkout(b, "/my-shop");
    const [sid] = [...stripe.sessions.keys()];
    const wh = await stripe.deliver(app, BASE, stripe.event(sid!, "checkout.session.completed"), WEBHOOK_SECRET);
    expect(await wh.json()).toMatchObject({ order_id: expect.any(String) });
    expect(sb.tables.orders).toHaveLength(1);
  });
});
