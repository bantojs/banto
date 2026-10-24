import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, WEBHOOK_SECRET, appWith, checkout, quoteFrom } from "./helpers";
import { cartCookieName } from "../src/cart/cart";

function setup(opts: { connected?: boolean; stripeConfigured?: boolean } = {}) {
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
  });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const teeM = sb.addSku(shop.id, tee.id, { code: "TEE-M", name: "M", price_jpy: 3000, available: 5 });
  const app = appWith(sb, {}, undefined, (opts.stripeConfigured ?? true) ? stripe : undefined);
  return { sb, stripe, shop, tee, teeM, app, b: new Browser(app) };
}

const stock = (sb: FakeSupabase, skuId: string) => sb.tables.inventory.find((i) => i["sku_id"] === skuId)!["available"];

describe("チェックアウト（Step 6）", () => {
  it("在庫を予約して Stripe Checkout へ転送し、Webhook で注文が確定する", async () => {
    const { sb, stripe, shop, teeM, app, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "2" });

    // 1. 購入手続きへ → 配送先入力画面
    const step1 = await b.post("/my-shop/checkout", { provider: "stripe" });
    expect(step1.status).toBe(200);
    expect(await step1.text()).toContain('action="/my-shop/checkout/stripe"');
    // 2. 配送先を送ると最終確認画面（まだ在庫は予約しない）
    const review = await b.post("/my-shop/checkout/stripe", ADDRESS);
    expect(review.status).toBe(200);
    const reviewHtml = await review.text();
    for (const text of ["ご注文内容の確認", "Tシャツ", "¥3,000", "¥6,000", "お支払い時期", "お届け時期", "ご注文の取消し・返品について", "山田 太郎", "注文を確定する"]) expect(reviewHtml).toContain(text);
    expect(sb.tables.reservations).toHaveLength(0);
    // 3. 「注文を確定する」で在庫を予約して Stripe へ
    const res = await b.post("/my-shop/checkout/stripe", { quote: quoteFrom(reviewHtml) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
    expect(sb.tables.reservations[0]!["customer"]).toMatchObject({ customer_email: "buyer@example.com", shipping_address: { state: "東京都", postal_code: "100-0001" } });
    // 在庫は予約で減っている
    expect(stock(sb, teeM.id)).toBe(3);
    const reservation = sb.tables.reservations[0]!;
    expect(reservation["status"]).toBe("pending");

    // Checkout Session の中身
    const [sessionId, session] = [...stripe.sessions.entries()][0]!;
    expect(session.account).toBe("acct_connected");
    const p = session.params;
    expect(p.get("mode")).toBe("payment");
    expect(p.get("line_items[0][price_data][currency]")).toBe("jpy");
    expect(p.get("line_items[0][price_data][unit_amount]")).toBe("3000");
    expect(p.get("line_items[0][price_data][product_data][name]")).toBe("Tシャツ / M");
    expect(p.get("line_items[0][quantity]")).toBe("2");
    expect(p.get("metadata[reservation_id]")).toBe(reservation["id"]);
    expect(p.get("metadata[shop_id]")).toBe(shop.id);
    expect(p.get("success_url")).toMatch(new RegExp(`^${BASE}/my-shop/checkout/done\\?s=[A-Za-z0-9_.-]+$`));
    expect(p.get("cancel_url")).toBe(`${BASE}/my-shop/cart`);
    expect(Number(p.get("expires_at"))).toBeGreaterThan(Date.now() / 1000 + 29 * 60);
    expect(p.get("shipping_address_collection[allowed_countries][0]")).toBeNull();
    expect(p.get("customer_email")).toBe("buyer@example.com");

    // 戻り先ページでカートが消える。注文はまだ無い（Webhook のみで確定）。照会トークン付きなら「確認中」と自動更新（0035）
    const donePath = p.get("success_url")!.slice(BASE.length);
    const done = await b.get(donePath);
    expect(done.status).toBe(200);
    const doneHtml = await done.text();
    expect(doneHtml).toContain("ご注文ありがとうございます");
    expect(doneHtml).toContain("お支払いの確認中です");
    expect(doneHtml).toContain('<meta http-equiv="refresh" content="4"');
    // トークンなしで開いた（古いブックマーク等）なら今までどおりの表示
    const plain = await (await b.get("/my-shop/checkout/done")).text();
    expect(plain).toContain("決済が完了すると、ショップから注文確認のご連絡をお送りします。");
    expect(plain).not.toContain('http-equiv="refresh"');
    expect(b.cookies.get(cartCookieName(shop.id))).toBeDefined();
    expect(await (await b.get("/my-shop/cart")).text()).toContain("カートは空です");
    expect(sb.tables.orders).toHaveLength(0);

    // Webhook: 署名不正 → 400、処理されない
    const event = stripe.event(sessionId, "checkout.session.completed");
    let wh = await stripe.deliver(app, BASE, event, WEBHOOK_SECRET, { badSignature: true });
    expect(wh.status).toBe(400);
    expect(sb.tables.orders).toHaveLength(0);

    // 正しい署名 → 注文確定
    wh = await stripe.deliver(app, BASE, event, WEBHOOK_SECRET);
    expect(wh.status).toBe(200);
    const body = (await wh.json()) as { order_id: string };
    expect(sb.tables.orders).toHaveLength(1);
    // 確定した後は完了画面に注文番号が出て、自動更新は止まる
    const confirmedHtml = await (await b.get(donePath)).text();
    expect(confirmedHtml).toContain(`ご注文番号は ${sb.tables.orders[0]!["number"]} です`);
    expect(confirmedHtml).not.toContain('http-equiv="refresh"');
    const order = sb.tables.orders[0]!;
    expect(order["id"]).toBe(body.order_id);
    expect(order).toMatchObject({ shop_id: shop.id, status: "paid", total_jpy: 6000, customer_email: "buyer@example.com", payment_provider: "stripe", payment_ref: session.payment_intent });
    expect(order["shipping_address"]).toMatchObject({ postal_code: "100-0001", line1: "千代田1-1", phone: "0312345678" });
    expect(order["number"]).toBe(1001);
    expect(sb.tables.order_items).toHaveLength(1);
    expect(reservation["status"]).toBe("confirmed");
    expect(stock(sb, teeM.id)).toBe(3);

    // 同じイベントの再送 → 冪等（注文は増えない）
    wh = await stripe.deliver(app, BASE, event, WEBHOOK_SECRET);
    expect(wh.status).toBe(200);
    expect(sb.tables.orders).toHaveLength(1);

    // 管理画面の注文一覧・詳細
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    let html = await (await admin.get(`/admin/shops/${shop.id}/orders`)).text();
    expect(html).toContain("山田 太郎");
    expect(html).toContain("¥6,000");
    expect(html).toContain("支払い済み");
    html = await (await admin.get(`/admin/shops/${shop.id}/orders/${order["id"]}`)).text();
    expect(html).toContain("TEE-M");
    expect(html).toContain("100-0001");
    expect(html).toContain("発送済みにする");

    // 発送済みにする
    let r = await admin.post(`/admin/shops/${shop.id}/orders/${order["id"]}/status`, { status: "shipped" });
    expect(r.headers.get("location")).toContain("flash=saved");
    expect(order["status"]).toBe("shipped");
    expect(order["shipped_at"]).toBeTruthy();

    // 個人情報のマスク
    r = await admin.post(`/admin/shops/${shop.id}/orders/${order["id"]}/mask`, {});
    expect(r.headers.get("location")).toContain("flash=masked");
    expect(order).toMatchObject({ customer_email: null, customer_name: "[masked]", shipping_address: null });
  });

  it("決済セッションの期限切れ Webhook で在庫が戻る", async () => {
    const { sb, stripe, teeM, app, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    await checkout(b, "/my-shop");
    expect(stock(sb, teeM.id)).toBe(4);
    const [sessionId] = [...stripe.sessions.keys()];
    const wh = await stripe.deliver(app, BASE, stripe.event(sessionId!, "checkout.session.expired"), WEBHOOK_SECRET);
    expect(wh.status).toBe(200);
    expect(await wh.json()).toMatchObject({ released: true });
    expect(stock(sb, teeM.id)).toBe(5);
    expect(sb.tables.reservations[0]!["status"]).toBe("released");
    expect(sb.tables.orders).toHaveLength(0);
  });

  it("予約が解放された後に決済完了し、在庫が無ければ返金する", async () => {
    const { sb, stripe, teeM, app, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "2" });
    await checkout(b, "/my-shop");
    const [sessionId] = [...stripe.sessions.keys()];
    // Cron 相当で解放され、他の人が在庫を買い占めた
    sb.tables.reservations[0]!["status"] = "released";
    sb.tables.inventory[0]!["available"] = 1;
    const wh = await stripe.deliver(app, BASE, stripe.event(sessionId!, "checkout.session.completed"), WEBHOOK_SECRET);
    expect(wh.status).toBe(200);
    expect(await wh.json()).toMatchObject({ refunded: true });
    expect(stripe.refunds).toEqual([{ account: "acct_connected", payment_intent: "pi_1", idempotencyKey: expect.stringMatching(/^refund-evt_/) }]);
    expect(sb.tables.orders).toHaveLength(0);
    expect(stock(sb, teeM.id)).toBe(1);
  });

  it("解放後でも在庫があれば再度確保して確定する", async () => {
    const { sb, stripe, teeM, app, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "2" });
    await checkout(b, "/my-shop");
    const [sessionId] = [...stripe.sessions.keys()];
    sb.tables.reservations[0]!["status"] = "released";
    sb.tables.inventory[0]!["available"] = 5;
    const wh = await stripe.deliver(app, BASE, stripe.event(sessionId!, "checkout.session.completed"), WEBHOOK_SECRET);
    expect(wh.status).toBe(200);
    expect(sb.tables.orders).toHaveLength(1);
    expect(stock(sb, teeM.id)).toBe(3);
    expect(stripe.refunds).toHaveLength(0);
  });

  it("未払いの completed（コンビニ決済等）は無視し、async_payment_succeeded で確定する", async () => {
    const { sb, stripe, teeM, app, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    await checkout(b, "/my-shop");
    const [sessionId] = [...stripe.sessions.keys()];
    let wh = await stripe.deliver(app, BASE, stripe.event(sessionId!, "checkout.session.completed", { payment_status: "unpaid" }), WEBHOOK_SECRET);
    expect(await wh.json()).toMatchObject({ ignored: "unpaid" });
    expect(sb.tables.orders).toHaveLength(0);
    wh = await stripe.deliver(app, BASE, stripe.event(sessionId!, "checkout.session.async_payment_succeeded"), WEBHOOK_SECRET);
    expect(sb.tables.orders).toHaveLength(1);
  });

  it("在庫不足・Stripe 障害・未設定のときはカートに戻し、予約を残さない", async () => {
    const { sb, stripe, teeM, b } = setup();
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "2" });

    // 他の購入で在庫が減った（カート表示後に）
    sb.tables.inventory[0]!["available"] = 1;
    let res = await checkout(b, "/my-shop");
    expect(res.headers.get("location")).toBe("/my-shop/cart?error=stock");
    expect(sb.tables.reservations).toHaveLength(0);
    sb.tables.inventory[0]!["available"] = 5;

    // Stripe がエラー → 予約を即時解放
    stripe.failCheckout = true;
    res = await checkout(b, "/my-shop");
    expect(res.headers.get("location")).toBe("/my-shop/cart?error=payment");
    expect(sb.tables.reservations[0]!["status"]).toBe("released");
    expect(stock(sb, teeM.id)).toBe(5);
    stripe.failCheckout = false;
  });

  it("Stripe 未接続のショップは購入手続きに進めない", async () => {
    const { teeM, b, sb } = setup({ connected: false });
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    const res = await checkout(b, "/my-shop");
    expect(res.headers.get("location")).toBe("/my-shop/cart");
    expect(sb.tables.reservations).toHaveLength(0);
  });

  it("STRIPE_* が未設定なら決済手段として出ず、直接 POST してもカートに戻る", async () => {
    const { teeM, b, sb } = setup({ stripeConfigured: false });
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    expect(await (await b.get("/my-shop/cart")).text()).toContain("現在決済を受け付けていません");
    const res = await checkout(b, "/my-shop");
    expect(res.headers.get("location")).toBe("/my-shop/cart");
    expect(sb.tables.reservations).toHaveLength(0);
  });

  it("API キー方式: 同梱プラグイン「Stripe 決済」を有効にすると、Connect なしで自分のアカウントに Checkout を作る", async () => {
    const { sb, stripe, shop, teeM, app, b } = setup({ connected: false });
    sb.tables.hook_endpoints.push({ id: "ep-stripe", shop_id: shop.id, name: "Stripe 決済（カード）", url: "https://banto.invalid/plugins/stripe", events: [], enabled: true, manifest: null, settings: {}, created_at: "" });
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    expect(await (await b.get("/my-shop/cart")).text()).toContain('action="/my-shop/checkout"');
    const res = await checkout(b, "/my-shop");
    expect(res.status).toBe(303);
    const [sessionId, session] = [...stripe.sessions.entries()][0]!;
    expect(session.account).toBeNull(); // Stripe-Account ヘッダなし = 自分のアカウント
    expect(session.params.get("metadata[shop_id]")).toBe(shop.id);

    // Webhook（自分のアカウントのイベントなので account が無い）で確定
    const event = stripe.event(sessionId, "checkout.session.completed");
    expect(event.account).toBeUndefined();
    const wh = await stripe.deliver(app, BASE, event, WEBHOOK_SECRET);
    expect(wh.status).toBe(200);
    expect(sb.tables.orders).toHaveLength(1);
    expect(sb.tables.orders[0]).toMatchObject({ payment_provider: "stripe", total_jpy: 3000 });

    // 解放後に在庫が無い → account なしで返金
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    await checkout(b, "/my-shop");
    const [sid2] = [...stripe.sessions.keys()].slice(-1);
    sb.tables.reservations[1]!["status"] = "released";
    sb.tables.inventory[0]!["available"] = 0;
    await stripe.deliver(app, BASE, stripe.event(sid2!, "checkout.session.completed"), WEBHOOK_SECRET);
    expect(stripe.refunds).toEqual([{ account: null, payment_intent: expect.stringMatching(/^pi_/), idempotencyKey: expect.stringMatching(/^refund-/) }]);

    // 管理画面のショップ設定は API キー方式が有効と表示し、Connect は折りたたみ
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await admin.get(`/admin/shops/${shop.id}`)).text();
    expect(html).toContain("有効（API キー方式）");
    expect(html).toContain("上級者向け: Stripe Connect");
  });

  it("接続済みアカウント + STRIPE_CLIENT_ID があれば Connect が優先される", async () => {
    const { sb, stripe, shop, teeM, b } = setup();
    sb.tables.hook_endpoints.push({ id: "ep-stripe", shop_id: shop.id, name: "Stripe", url: "https://banto.invalid/plugins/stripe", events: [], enabled: true, manifest: null, settings: {}, created_at: "" });
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    await checkout(b, "/my-shop");
    expect([...stripe.sessions.values()][0]!.account).toBe("acct_connected");
  });

  it("Webhook: 秘密未設定は 503、関係ないイベントは無視", async () => {
    const { stripe, app, teeM, b, sb } = setup();
    await b.post("/my-shop/cart/add", { sku_id: teeM.id, qty: "1" });
    await checkout(b, "/my-shop");
    const [sessionId] = [...stripe.sessions.keys()];
    const wh = await stripe.deliver(app, BASE, stripe.event(sessionId!, "payment_intent.created"), WEBHOOK_SECRET);
    expect(await wh.json()).toMatchObject({ ignored: "payment_intent.created" });

    const noSecret = appWith(sb, { STRIPE_WEBHOOK_SECRET: undefined }, undefined, stripe);
    const r = await stripe.deliver(noSecret, BASE, stripe.event(sessionId!, "checkout.session.completed"), WEBHOOK_SECRET);
    expect(r.status).toBe(503);
  });
});

describe("Stripe Connect（管理画面）", () => {
  it("接続 → コールバック → 解除", async () => {
    const { sb, stripe, shop, app } = setup({ connected: false });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");

    let html = await (await admin.get(`/admin/shops/${shop.id}`)).text();
    expect(html).toContain("未接続");
    expect(html).toContain(`/admin/shops/${shop.id}/stripe/connect`);
    expect(html).toContain(`${BASE}/webhooks/stripe`);

    const go = await admin.get(`/admin/shops/${shop.id}/stripe/connect`);
    expect(go.status).toBe(302);
    const authorize = new URL(go.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe("https://connect.stripe.com/oauth/authorize");
    expect(authorize.searchParams.get("client_id")).toBe(stripe.clientId);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${BASE}/admin/stripe/callback`);
    const state = authorize.searchParams.get("state")!;

    // 改ざんした state は拒否
    let cb = await admin.get(`/admin/stripe/callback?code=ac_valid&state=${state}x`);
    expect(cb.headers.get("location")).toBe("/admin?flash=stripe_state_invalid");
    expect(sb.shops[0]!.stripe_account_id).toBeNull();

    // 無効なコード
    cb = await admin.get(`/admin/stripe/callback?code=ac_bad&state=${state}`);
    expect(cb.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=stripe_failed`);

    // ユーザーが拒否した
    cb = await admin.get(`/admin/stripe/callback?error=access_denied&state=${state}`);
    expect(cb.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=stripe_failed`);

    // 成功
    cb = await admin.get(`/admin/stripe/callback?code=ac_valid&state=${state}`);
    expect(cb.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=stripe_connected`);
    expect(sb.shops[0]!.stripe_account_id).toBe("acct_connected");
    html = await (await admin.get(`/admin/shops/${shop.id}?flash=stripe_connected`)).text();
    expect(html).toContain("接続済み");
    expect(html).toContain("acct_connected");
    expect(html).not.toContain("sk_should_not_be_stored");

    // 解除
    const off = await admin.post(`/admin/shops/${shop.id}/stripe/disconnect`, {});
    expect(off.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=stripe_disconnected`);
    expect(sb.shops[0]!.stripe_account_id).toBeNull();
    expect(stripe.deauthorized).toEqual(["acct_connected"]);
  });

  it("STRIPE_* 未設定なら接続できず案内を出す", async () => {
    const { shop, app } = setup({ connected: false, stripeConfigured: false });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await admin.get(`/admin/shops/${shop.id}`)).text();
    expect(html).toContain("Connect を使うには STRIPE_CLIENT_ID と STRIPE_SECRET_KEY の Secret が必要");
    const go = await admin.get(`/admin/shops/${shop.id}/stripe/connect`);
    expect(go.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=stripe_not_configured`);
  });
});
