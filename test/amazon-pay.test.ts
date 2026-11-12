import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, externalHosts, memoryAdapters, quoteFrom } from "./helpers";
import { bundledPluginUrl } from "../src/plugins";
import { AMAZON_PAY_ALGORITHM, amazonPayPath, amzDate, createAmazonPayClient, parseJpy, pemToPkcs8, pkcs1ToPkcs8, signedHeaders } from "../src/plugins/amazon_pay";
import { buttonPayload, openAmazonPayTicket, sealAmazonPayTicket } from "../src/payments/amazon-pay";
import { refundPayment } from "../src/orders/cancel";

afterEach(() => externalHosts.clear());

const enc = new TextEncoder();
let PEM = "";
let PUBLIC: CryptoKey;

function toPem(der: ArrayBuffer, label: string): string {
  let s = "";
  for (const b of new Uint8Array(der)) s += String.fromCharCode(b);
  const body = btoa(s).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

async function sha256Hex(s: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function verify(signatureB64: string, signed: string): Promise<boolean> {
  const sig = Uint8Array.from(atob(signatureB64), (ch) => ch.charCodeAt(0));
  const stringToSign = `${AMAZON_PAY_ALGORITHM}\n${await sha256Hex(signed)}`;
  return crypto.subtle.verify({ name: "RSA-PSS", saltLength: 32 }, PUBLIC, sig, enc.encode(stringToSign));
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  PEM = toPem((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer, "PRIVATE KEY");
  PUBLIC = pair.publicKey;
});

describe("Amazon Pay の署名（AMZN-PAY-RSASSA-PSS-V2）", () => {
  it("正規化した要求に RSA-PSS（salt 32）で署名し、Authorization を組む", async () => {
    const now = new Date("2026-11-08T01:02:03.456Z");
    const body = JSON.stringify({ chargeAmount: { amount: "1000", currencyCode: "JPY" } });
    const h = await signedHeaders({ privateKeyPem: PEM, publicKeyId: "SANDBOX-ABC", sandbox: false }, { method: "POST", path: "/v2/checkoutSessions/abc-123/complete", body, idempotencyKey: "k1", now });
    expect(amzDate(now)).toBe("20261108T010203Z");
    expect(h["x-amz-pay-region"]).toBe("jp");
    expect(h["x-amz-pay-host"]).toBe("pay-api.amazon.jp");
    const m = /^AMZN-PAY-RSASSA-PSS-V2 PublicKeyId=SANDBOX-ABC, SignedHeaders=([a-z;-]+), Signature=(\S+)$/.exec(h["authorization"]!);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("accept;content-type;x-amz-pay-date;x-amz-pay-host;x-amz-pay-idempotency-key;x-amz-pay-region");
    const canonical = [
      "POST",
      "/v2/checkoutSessions/abc-123/complete",
      "",
      "accept:application/json\ncontent-type:application/json\nx-amz-pay-date:20261108T010203Z\nx-amz-pay-host:pay-api.amazon.jp\nx-amz-pay-idempotency-key:k1\nx-amz-pay-region:jp\n",
      m![1]!,
      await sha256Hex(body),
    ].join("\n");
    expect(await verify(m![2]!, canonical)).toBe(true);
    expect(await verify(m![2]!, canonical.replace("010203Z", "010204Z"))).toBe(false);
  });

  it("鍵 ID に環境の接頭辞があればパスに環境を入れない。無ければ live / sandbox", () => {
    expect(amazonPayPath({ publicKeyId: "LIVE-X", sandbox: true }, "/charges/1")).toBe("/v2/charges/1");
    expect(amazonPayPath({ publicKeyId: "SANDBOX-X", sandbox: false }, "/charges/1")).toBe("/v2/charges/1");
    expect(amazonPayPath({ publicKeyId: "AHEGSJCM3L2S637RBGABLAFW", sandbox: false }, "/charges/1")).toBe("/live/v2/charges/1");
    expect(amazonPayPath({ publicKeyId: "AHEGSJCM3L2S637RBGABLAFW", sandbox: true }, "/charges/1")).toBe("/sandbox/v2/charges/1");
  });

  it("PEM: Cloudflare の画面で \\n の文字になった改行も読み、PKCS#1 は PKCS#8 に包む", async () => {
    const flat = PEM.replace(/\n/g, "\\n");
    expect(pemToPkcs8(flat)).toEqual(pemToPkcs8(PEM));
    // PKCS#8 の中の PKCS#1 を取り出して包み直すと同じになる（先頭 26 バイトが包み）
    const pkcs8 = pemToPkcs8(PEM);
    expect(Array.from(pkcs1ToPkcs8(pkcs8.slice(26)))).toEqual(Array.from(pkcs8));
    expect(() => pemToPkcs8("not a key")).toThrow();
  });

  it("円の金額", () => {
    expect(parseJpy({ amount: "1000", currencyCode: "JPY" })).toBe(1000);
    expect(parseJpy({ amount: "1000.00", currencyCode: "JPY" })).toBe(1000);
    expect(parseJpy({ amount: "10.5", currencyCode: "JPY" })).toBeNull();
    expect(parseJpy({ amount: "1000", currencyCode: "USD" })).toBeNull();
    expect(parseJpy(null)).toBeNull();
  });

  it("券: ショップごとの署名・期限", async () => {
    const t = await sealAmazonPayTicket("s", { shopId: "shop-1", reservationId: "r1", amountJpy: 3000, successUrl: "https://a/ok", cancelUrl: "https://a/ng" });
    expect(await openAmazonPayTicket("s", t, "shop-1")).toMatchObject({ reservationId: "r1", amountJpy: 3000 });
    expect(await openAmazonPayTicket("s", t, "shop-2")).toBeNull();
    expect(await openAmazonPayTicket("other", t, "shop-1")).toBeNull();
    expect(await openAmazonPayTicket("s", t, "shop-1", Date.now() + 25 * 3600_000)).toBeNull();
  });
});

/** 偽の Amazon Pay（Checkout Session・Charge・Charge Permission・Refund） */
class FakeAmazonPay {
  sessions = new Map<string, { state: string; reservationId: string; shopId: string; amount: string; chargeId: string | null; declineOnComplete?: boolean }>();
  charges = new Map<string, { state: string; permissionId: string; amount: string; refunded: string }>();
  permissions = new Map<string, { reservationId: string; shopId: string }>();
  refunds: { chargeId: string; amount: string; key: string | null }[] = [];
  completes = 0;
  calls: string[] = [];

  /** ボタンを押して Amazon の画面で支払いを選んだところ（Checkout Session ができる） */
  open(payloadJSON: string): string {
    const p = JSON.parse(payloadJSON) as { merchantMetadata: { merchantReferenceId: string; customInformation: string }; paymentDetails: { chargeAmount: { amount: string } } };
    const id = `cs-${this.sessions.size + 1}-aaaaaaaa`;
    this.sessions.set(id, { state: "Open", reservationId: p.merchantMetadata.merchantReferenceId, shopId: p.merchantMetadata.customInformation, amount: p.paymentDetails.chargeAmount.amount, chargeId: null });
    return id;
  }

  handler = async (req: Request): Promise<Response> => {
    expect(req.headers.get("authorization")).toMatch(/^AMZN-PAY-RSASSA-PSS-V2 PublicKeyId=SANDBOX-KEY, /);
    const u = new URL(req.url);
    this.calls.push(`${req.method} ${u.pathname}`);
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    let m = /^\/v2\/checkoutSessions\/([^/]+)(\/complete)?$/.exec(u.pathname);
    if (m) {
      const s = this.sessions.get(m[1]!);
      if (!s) return json(404, { reasonCode: "ResourceNotFound" });
      if (m[2]) {
        this.completes++;
        if (s.state !== "Open") return json(422, { reasonCode: "InvalidCheckoutSessionStatus" });
        if (s.declineOnComplete) {
          s.state = "Canceled";
          return json(422, { reasonCode: "HardDeclined" });
        }
        const body = (await req.json()) as { chargeAmount: { amount: string } };
        if (body.chargeAmount.amount !== s.amount) return json(409, { reasonCode: "AmountMismatch" });
        const chargeId = `ch-${this.charges.size + 1}-bbbbbbbb`;
        const permissionId = `cp-${this.charges.size + 1}-cccccccc`;
        this.charges.set(chargeId, { state: "Captured", permissionId, amount: s.amount, refunded: "0" });
        this.permissions.set(permissionId, { reservationId: s.reservationId, shopId: s.shopId });
        s.state = "Completed";
        s.chargeId = chargeId;
      }
      return json(200, { checkoutSessionId: m[1], statusDetails: { state: s.state }, chargeId: s.chargeId, paymentDetails: { chargeAmount: { amount: s.amount, currencyCode: "JPY" } }, merchantMetadata: { merchantReferenceId: s.reservationId, customInformation: s.shopId } });
    }
    m = /^\/v2\/charges\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const ch = this.charges.get(m[1]!);
      if (!ch) return json(404, { reasonCode: "ResourceNotFound" });
      return json(200, { chargeId: m[1], chargePermissionId: ch.permissionId, chargeAmount: { amount: ch.amount, currencyCode: "JPY" }, captureAmount: { amount: ch.amount, currencyCode: "JPY" }, refundedAmount: { amount: ch.refunded, currencyCode: "JPY" }, statusDetails: { state: ch.state } });
    }
    m = /^\/v2\/chargePermissions\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const p = this.permissions.get(m[1]!);
      if (!p) return json(404, { reasonCode: "ResourceNotFound" });
      return json(200, { chargePermissionId: m[1], merchantMetadata: { merchantReferenceId: p.reservationId, customInformation: p.shopId } });
    }
    if (u.pathname === "/v2/refunds" && req.method === "POST") {
      const body = (await req.json()) as { chargeId: string; refundAmount: { amount: string } };
      this.refunds.push({ chargeId: body.chargeId, amount: body.refundAmount.amount, key: req.headers.get("x-amz-pay-idempotency-key") });
      return json(201, { refundId: `rf-${this.refunds.length}`, statusDetails: { state: "RefundInitiated" } });
    }
    return json(404, {});
  };
}

const AMAZON_VARS = () => ({ AMAZON_PAY_PRIVATE_KEY: PEM, AMAZON_PAY_PUBLIC_KEY_ID: "SANDBOX-KEY", AMAZON_PAY_MERCHANT_ID: "M123", AMAZON_PAY_STORE_ID: "amzn1.application-oa2-client.test" });

function setup(overrides: Record<string, string | undefined> = {}, opts: { enable?: boolean } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", price_jpy: 3000, available: 5 });
  if (opts.enable !== false) sb.tables.hook_endpoints.push({ id: "ep-amazon", shop_id: shop.id, name: "Amazon Pay", url: bundledPluginUrl("amazon_pay"), events: [], enabled: true, manifest: null, settings: {}, created_at: "" });
  const app = appWith(sb, { ...AMAZON_VARS(), ...overrides });
  const amazon = new FakeAmazonPay();
  externalHosts.set("https://pay-api.amazon.jp/", amazon.handler);
  return { sb, shop, sku, app, amazon };
}

const address = { customer_name: "小森 花子", customer_email: "hanako@example.com", phone: "0312345678", postal_code: "100-0001", state: "東京都", city: "千代田区", line1: "千代田1-1", line2: "" };

async function startCheckout(b: Browser, skuId: string, qty = "2") {
  // 中継ページ（no-referrer）の後は、カートの画面から買い物を続ける
  await b.get("/my-shop/cart");
  await b.post("/my-shop/cart/add", { sku_id: skuId, qty });
  const review = await b.post("/my-shop/checkout/amazon_pay", address);
  if (review.status !== 200) throw new Error(`${review.status} ${(await review.text()).slice(0, 300)}`);
  const html = await review.text();
  const res = await b.post("/my-shop/checkout/amazon_pay", { quote: quoteFrom(html) });
  expect(res.status).toBe(303);
  const start = res.headers.get("location")!;
  return { review: html, start };
}

function relayConfig(html: string): { merchantId: string; publicKeyId: string; payload: string; signature: string; sandbox: boolean } {
  const m = /<script type="application\/json" id="banto-amazon-pay">([^<]+)<\/script>/.exec(html);
  if (!m) throw new Error("relay config not found");
  return JSON.parse(m[1]!) as ReturnType<typeof relayConfig>;
}

describe("Amazon Pay（同梱プラグイン amazon_pay）", () => {
  it("カート → 最終確認 → 中継ページ（署名したボタン）→ Amazon Pay → 戻りで Complete → 注文が確定する", async () => {
    const { sb, shop, sku, app, amazon } = setup();
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "2" });
    const cart = await (await b.get("/my-shop/cart")).text();
    expect(cart).toContain("Amazon Pay で支払う");
    expect(cart).toContain('value="amazon_pay"');
    const addr = await b.post("/my-shop/checkout", { provider: "amazon_pay" });
    expect(await addr.text()).toContain('action="/my-shop/checkout/amazon_pay"');

    const review = await b.post("/my-shop/checkout/amazon_pay", address);
    const reviewHtml = await review.text();
    expect(reviewHtml).toContain("Amazon Pay（Amazon アカウントに登録済みの支払い方法）");
    expect(reviewHtml).toContain("Amazon Pay の画面でお支払い手続きを完了した時点で決済されます。");
    const placed = await b.post("/my-shop/checkout/amazon_pay", { quote: quoteFrom(reviewHtml) });
    expect(placed.status).toBe(303);
    const start = placed.headers.get("location")!;
    expect(start).toMatch(new RegExp(`^${BASE}/my-shop/checkout/amazon-pay/start\\?t=`));
    const reservation = sb.tables.reservations[0]!;
    expect(sb.tables.inventory[0]!["available"]).toBe(3);
    // 中継ページを作る前に Amazon Pay へは何も送らない
    expect(amazon.calls).toEqual([]);

    const relay = await b.get(start.slice(BASE.length));
    expect(relay.status).toBe(200);
    const csp = relay.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self' https://static-fe.payments-amazon.com");
    expect(csp).not.toContain("unsafe-inline");
    expect(relay.headers.get("referrer-policy")).toBe("no-referrer");
    const relayHtml = await relay.text();
    expect(relayHtml).toContain('<script src="https://static-fe.payments-amazon.com/checkout.js"></script>');
    expect(relayHtml).toContain("6,000円");
    const cfg = relayConfig(relayHtml);
    expect(cfg).toMatchObject({ merchantId: "M123", publicKeyId: "SANDBOX-KEY", sandbox: false });
    // ボタンの中身: ProcessOrder・金額・予約・戻り先。署名は中身そのものに対して
    const payload = JSON.parse(cfg.payload) as Record<string, Record<string, unknown>>;
    expect(payload["webCheckoutDetails"]).toMatchObject({ checkoutMode: "ProcessOrder", checkoutResultReturnUrl: expect.stringMatching(new RegExp(`^${BASE}/my-shop/checkout/amazon-pay/return\\?t=`)), checkoutCancelUrl: expect.stringMatching(/\/checkout\/amazon-pay\/cancel\?t=/) });
    expect(payload["paymentDetails"]).toEqual({ paymentIntent: "AuthorizeWithCapture", chargeAmount: { amount: "6000", currencyCode: "JPY" }, presentmentCurrency: "JPY" });
    expect(payload["merchantMetadata"]).toEqual({ merchantReferenceId: reservation["id"], merchantStoreName: "マイショップ", customInformation: shop.id });
    expect(payload["storeId"]).toBe("amzn1.application-oa2-client.test");
    expect(JSON.stringify(payload)).not.toContain("hanako");
    expect(await verify(cfg.signature, cfg.payload)).toBe(true);
    const relayJs = await b.get("/my-shop/checkout/amazon-pay/relay.js");
    expect(relayJs.headers.get("content-type")).toContain("javascript");
    expect(await relayJs.text()).toContain("amazon.Pay.renderButton");

    // Amazon Pay の画面で支払って戻る（amazonCheckoutSessionId が付く）
    const sid = amazon.open(cfg.payload);
    const returnUrl = String(payload["webCheckoutDetails"]!["checkoutResultReturnUrl"]);
    const back = await b.get(`${returnUrl.slice(BASE.length)}&amazonCheckoutSessionId=${sid}`);
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toMatch(new RegExp(`^${BASE}/my-shop/checkout/done\\?s=`));
    expect(sb.tables.orders).toHaveLength(1);
    expect(sb.tables.orders[0]).toMatchObject({ payment_provider: "amazon_pay", payment_ref: "ch-1-bbbbbbbb", customer_email: "hanako@example.com", total_jpy: 6000 });
    expect(amazon.completes).toBe(1);

    // 戻りを開き直しても二重にならない（Complete は呼ばない）
    await b.get(`${returnUrl.slice(BASE.length)}&amazonCheckoutSessionId=${sid}`);
    expect(sb.tables.orders).toHaveLength(1);
    expect(amazon.completes).toBe(1);

    // IPN が後から来ても二重にならない
    const ipn = JSON.stringify({ Type: "Notification", Message: JSON.stringify({ MerchantID: "M123", ObjectType: "CHARGE", ObjectId: "ch-1-bbbbbbbb", NotificationType: "STATE_CHANGE", NotificationId: "n1" }) });
    const wh = await app.request(`${BASE}/webhooks/amazon-pay`, { method: "POST", headers: { "content-type": "text/plain" }, body: ipn });
    expect(wh.status).toBe(200);
    expect(sb.tables.orders).toHaveLength(1);
    expect(amazon.refunds).toEqual([]);
  });

  it("戻りの値は合図だけ: 別の予約の Checkout Session・知らない ID では何もしない", async () => {
    const { sb, sku, app, amazon } = setup();
    const b = new Browser(app);
    const { start } = await startCheckout(b, sku.id);
    const cfg = relayConfig(await (await b.get(start.slice(BASE.length))).text());
    const payload = JSON.parse(cfg.payload) as { webCheckoutDetails: { checkoutResultReturnUrl: string } };
    // 別の予約（別の人）の Checkout Session を付けて戻る
    const other = amazon.open(JSON.stringify({ merchantMetadata: { merchantReferenceId: "00000000-0000-0000-0000-000000000000", customInformation: "x" }, paymentDetails: { chargeAmount: { amount: "6000" } } }));
    let back = await b.get(`${payload.webCheckoutDetails.checkoutResultReturnUrl.slice(BASE.length)}&amazonCheckoutSessionId=${other}`);
    expect(back.headers.get("location")).toBe(`${BASE}/my-shop/cart?error=unpaid`);
    back = await b.get(`${payload.webCheckoutDetails.checkoutResultReturnUrl.slice(BASE.length)}&amazonCheckoutSessionId=nope-0000-unknown`);
    expect(back.headers.get("location")).toBe(`${BASE}/my-shop/cart?error=unpaid`);
    expect(amazon.completes).toBe(0);
    expect(sb.tables.orders).toHaveLength(0);
    // 券を書き換えたら期限切れの画面
    const forged = await b.get(`/my-shop/checkout/amazon-pay/return?t=forged&amazonCheckoutSessionId=${other}`);
    expect(forged.status).toBe(400);
    expect(sb.tables.reservations[0]!["status"]).toBe("pending");
  });

  it("Amazon Pay で断られた → 予約を戻してカートへ。Amazon の画面で戻る → 予約を戻す", async () => {
    const { sb, sku, app, amazon } = setup();
    const b = new Browser(app);
    const { start } = await startCheckout(b, sku.id);
    const cfg = relayConfig(await (await b.get(start.slice(BASE.length))).text());
    const payload = JSON.parse(cfg.payload) as { webCheckoutDetails: { checkoutResultReturnUrl: string; checkoutCancelUrl: string } };
    const sid = amazon.open(cfg.payload);
    amazon.sessions.get(sid)!.declineOnComplete = true;
    const back = await b.get(`${payload.webCheckoutDetails.checkoutResultReturnUrl.slice(BASE.length)}&amazonCheckoutSessionId=${sid}`);
    expect(back.headers.get("location")).toBe(`${BASE}/my-shop/cart?error=unpaid`);
    expect(sb.tables.reservations[0]!["status"]).toBe("released");
    expect(sb.tables.inventory[0]!["available"]).toBe(5);
    expect(sb.tables.orders).toHaveLength(0);
    expect(await (await b.get("/my-shop/cart?error=unpaid")).text()).toContain("お支払いが完了しませんでした");

    // もう一度 → Amazon の画面で「戻る」
    const second = await startCheckout(b, sku.id, "1");
    const cfg2 = relayConfig(await (await b.get(second.start.slice(BASE.length))).text());
    const p2 = JSON.parse(cfg2.payload) as { webCheckoutDetails: { checkoutCancelUrl: string } };
    const cancel = await b.get(p2.webCheckoutDetails.checkoutCancelUrl.slice(BASE.length));
    expect(cancel.headers.get("location")).toBe(`${BASE}/my-shop/cart`);
    expect(sb.tables.reservations[1]!["status"]).toBe("released");
  });

  it("戻りが届かなくても IPN で確定する。解放後に在庫が無ければ返金する", async () => {
    const { sb, shop, sku, app, amazon } = setup();
    const b = new Browser(app);
    const { start } = await startCheckout(b, sku.id);
    const cfg = relayConfig(await (await b.get(start.slice(BASE.length))).text());
    const reservation = sb.tables.reservations[0]!;
    // 支払いは済んだが（Complete まで済んだ）、ブラウザが戻らなかった
    const sid = amazon.open(cfg.payload);
    const s = amazon.sessions.get(sid)!;
    amazon.charges.set("ch-9-dddddddd", { state: "Captured", permissionId: "cp-9-eeeeeeee", amount: s.amount, refunded: "0" });
    amazon.permissions.set("cp-9-eeeeeeee", { reservationId: s.reservationId, shopId: s.shopId });
    const ipn = (id: string, merchant = "M123") => JSON.stringify({ Type: "Notification", Message: JSON.stringify({ MerchantID: merchant, ObjectType: "CHARGE", ObjectId: id, NotificationType: "STATE_CHANGE", NotificationId: `n-${id}` }) });
    // 別の加盟店・知らない Charge・CHARGE 以外は何もしない
    expect(await (await app.request(`${BASE}/webhooks/amazon-pay`, { method: "POST", body: ipn("ch-9-dddddddd", "OTHER") })).json()).toMatchObject({ ignored: "merchant" });
    expect(await (await app.request(`${BASE}/webhooks/amazon-pay`, { method: "POST", body: ipn("ch-0-00000000") })).json()).toMatchObject({ ignored: "not_found" });
    expect(await (await app.request(`${BASE}/webhooks/amazon-pay`, { method: "POST", body: "not json" })).status).toBe(400);
    // 本文の上限（256 KiB）を超える通知は、中身も Charge も見ずに 413（前は 64K 文字を読み切ってから 400）
    const huge = await app.request(`${BASE}/webhooks/amazon-pay`, { method: "POST", body: ipn("ch-9-dddddddd") + " ".repeat(256 * 1024) });
    expect(huge.status).toBe(413);
    expect(sb.tables.orders).toHaveLength(0);

    let wh = await app.request(`${BASE}/webhooks/amazon-pay`, { method: "POST", headers: { "content-type": "text/plain" }, body: ipn("ch-9-dddddddd") });
    expect(await wh.json()).toEqual({ received: true, order_id: expect.any(String) });
    expect(sb.tables.orders).toHaveLength(1);
    expect(sb.tables.orders[0]).toMatchObject({ payment_provider: "amazon_pay", payment_ref: "ch-9-dddddddd", total_jpy: 6000, shop_id: shop.id, reservation_id: reservation["id"] });

    // 2 件目: 予約が TTL で戻り、在庫が無くなってから支払いが届く → 返金（冪等キーは Charge ID）
    const next = await startCheckout(b, sku.id, "1");
    const cfg2 = relayConfig(await (await b.get(next.start.slice(BASE.length))).text());
    const sid2 = amazon.open(cfg2.payload);
    const s2 = amazon.sessions.get(sid2)!;
    const r2 = sb.tables.reservations[1]!;
    await sb.fetch(`${sb.url}/rest/v1/rpc/release_reservation`, { method: "POST", headers: { apikey: sb.serviceRoleKey, authorization: `Bearer ${sb.serviceRoleKey}`, "content-type": "application/json" }, body: JSON.stringify({ p_reservation_id: r2["id"], p_shop_id: shop.id }) });
    expect(r2["status"]).toBe("released");
    sb.tables.inventory[0]!["available"] = 0;
    amazon.charges.set("ch-8-ffffffff", { state: "Captured", permissionId: "cp-8-gggggggg", amount: s2.amount, refunded: "0" });
    amazon.permissions.set("cp-8-gggggggg", { reservationId: s2.reservationId, shopId: s2.shopId });
    wh = await app.request(`${BASE}/webhooks/amazon-pay`, { method: "POST", body: ipn("ch-8-ffffffff") });
    expect(await wh.json()).toMatchObject({ refunded: true });
    // 戻らなかったのでカートは前の 2 点が残ったまま（+1 点 = 9,000 円）
    expect(amazon.refunds).toEqual([{ chargeId: "ch-8-ffffffff", amount: "9000", key: "refund-ch-8-ffffffff" }]);
    expect(sb.tables.orders).toHaveLength(1);
  });

  it("キャンセルの返金: 売り上げた額から返金済みを引いた額を、冪等キー付きで返す", async () => {
    const amazon = new FakeAmazonPay();
    externalHosts.set("https://pay-api.amazon.jp/", amazon.handler);
    amazon.charges.set("ch-1-bbbbbbbb", { state: "Captured", permissionId: "cp", amount: "6000", refunded: "0" });
    const config = memoryAdapters(AMAZON_VARS()).config;
    const fetchVia: typeof fetch = (input, init) => Promise.resolve(amazon.handler(new Request(input, init)));
    expect(await refundPayment({ payment_provider: "amazon_pay", payment_ref: "ch-1-bbbbbbbb" }, { config, fetch: fetchVia, stripeAccountId: null, idempotencyKey: "cancel-o1" })).toBe(true);
    expect(amazon.refunds).toEqual([{ chargeId: "ch-1-bbbbbbbb", amount: "6000", key: "cancel-o1" }]);
    // 設定が無ければ返金できない（注文は変えない）
    await expect(refundPayment({ payment_provider: "amazon_pay", payment_ref: "ch-1-bbbbbbbb" }, { config: memoryAdapters({}).config, fetch: fetchVia, stripeAccountId: null, idempotencyKey: "k" })).rejects.toThrow(/Amazon Pay is not configured/);
  });

  it("設定が足りない・プラグインが無効なら選択肢に出さず、直接 POST しても弾く", async () => {
    const { sb, sku, app } = setup({ AMAZON_PAY_STORE_ID: undefined });
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    expect(await (await b.get("/my-shop/cart")).text()).not.toContain("Amazon Pay");
    expect((await b.post("/my-shop/checkout/amazon_pay", address)).headers.get("location")).toBe("/my-shop/cart");
    expect(sb.tables.reservations).toHaveLength(0);

    const off = setup({}, { enable: false });
    const b2 = new Browser(off.app);
    await b2.post("/my-shop/cart/add", { sku_id: off.sku.id, qty: "1" });
    expect(await (await b2.get("/my-shop/cart")).text()).not.toContain("Amazon Pay");
    expect((await b2.post("/my-shop/checkout/amazon_pay", address)).headers.get("location")).toBe("/my-shop/cart");
  });

  it("ヘッドレス: quote → checkout で中継ページの URL を payment_url に返す", async () => {
    const { sku, app } = setup();
    const api = (path: string, body: unknown) => app.request(`${BASE}/api/shops/my-shop${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const cart = (await (await api("/cart", { op: "add", sku_id: sku.id, qty: 1 })).json()) as { cart: string; payments?: Record<string, boolean> };
    const q = (await (await api("/checkout/quote", { cart: cart.cart, provider: "amazon_pay", address })).json()) as { quote: string; confirmation: { payment: { provider: string } } };
    expect(q.confirmation.payment.provider).toBe("amazon_pay");
    const placed = (await (await api("/checkout", { quote: q.quote })).json()) as { payment_url: string };
    expect(placed.payment_url).toMatch(new RegExp(`^${BASE}/my-shop/checkout/amazon-pay/start\\?t=`));
  });

  it("ボタンの中身: 店名は 50 文字まで", () => {
    const p = JSON.parse(buttonPayload({ storeId: "s", ticket: { shopId: "a", reservationId: "r", amountJpy: 1, successUrl: "", cancelUrl: "", expiresAt: 0 }, returnUrl: "r", cancelUrl: "c", storeName: "あ".repeat(60) })) as { merchantMetadata: { merchantStoreName: string } };
    expect([...p.merchantMetadata.merchantStoreName]).toHaveLength(50);
  });

  it("クライアント: 失敗は理由のコード付きの例外", async () => {
    const client = createAmazonPayClient({ privateKeyPem: PEM, publicKeyId: "SANDBOX-KEY", sandbox: false, fetch: async () => new Response(JSON.stringify({ reasonCode: "InvalidChargeStatus", message: "no" }), { status: 422 }) });
    await expect(client.createRefund("ch-1", 100, "k")).rejects.toMatchObject({ status: 422, reasonCode: "InvalidChargeStatus" });
  });
});
