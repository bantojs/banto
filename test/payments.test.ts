import { describe, expect, it } from "vitest";
import { formEncode, signStripePayload, verifyStripeSignature } from "../src/payments/stripe";
import { orderInputFromSession } from "../src/routes/webhooks/stripe";

describe("Stripe 署名検証", () => {
  const secret = "whsec_abc";
  const payload = '{"id":"evt_1","type":"checkout.session.completed"}';

  it("正しい署名を受け入れ、改ざん・別 secret・古いタイムスタンプを拒否する", async () => {
    const now = 1_700_000_000;
    const header = await signStripePayload(payload, secret, now);
    expect(await verifyStripeSignature(payload, header, secret, { now })).toBe(true);
    expect(await verifyStripeSignature(payload + " ", header, secret, { now })).toBe(false);
    expect(await verifyStripeSignature(payload, header, "whsec_other", { now })).toBe(false);
    expect(await verifyStripeSignature(payload, header, secret, { now: now + 600 })).toBe(false);
    expect(await verifyStripeSignature(payload, header, secret, { now: now + 100 })).toBe(true);
    expect(await verifyStripeSignature(payload, undefined, secret, { now })).toBe(false);
    expect(await verifyStripeSignature(payload, "t=abc,v1=zz", secret, { now })).toBe(false);
    expect(await verifyStripeSignature(payload, "v1=zz", secret, { now })).toBe(false);
  });

  it("複数の v1 署名のうち1つが合えば受け入れる（鍵ローテーション）", async () => {
    const now = 1_700_000_000;
    const header = await signStripePayload(payload, secret, now);
    const [t, v1] = header.split(",");
    expect(await verifyStripeSignature(payload, `${t},v1=0000,${v1}`, secret, { now })).toBe(true);
  });
});

describe("formEncode", () => {
  it("ネストと配列を Stripe 形式にする", () => {
    const q = formEncode({
      mode: "payment",
      line_items: [{ quantity: 2, price_data: { currency: "jpy", unit_amount: 3000, product_data: { name: "Tシャツ" } } }],
      metadata: { reservation_id: "r1" },
      shipping_address_collection: { allowed_countries: ["JP"] },
      skip: undefined,
    });
    expect(q.get("mode")).toBe("payment");
    expect(q.get("line_items[0][quantity]")).toBe("2");
    expect(q.get("line_items[0][price_data][unit_amount]")).toBe("3000");
    expect(q.get("line_items[0][price_data][product_data][name]")).toBe("Tシャツ");
    expect(q.get("metadata[reservation_id]")).toBe("r1");
    expect(q.get("shipping_address_collection[allowed_countries][0]")).toBe("JP");
    expect(q.has("skip")).toBe(false);
  });
});

describe("orderInputFromSession", () => {
  it("Checkout Session から注文の個人情報を組み立てる", () => {
    const input = orderInputFromSession({
      id: "cs_1",
      url: null,
      status: "complete",
      payment_status: "paid",
      payment_intent: "pi_1",
      client_reference_id: "r1",
      metadata: {},
      customer_details: { email: "a@example.com", name: "山田", phone: "+81" },
      collected_information: { shipping_details: { name: "山田 太郎", address: { country: "JP", postal_code: "100-0001", state: "東京都", city: "千代田区", line1: "1-1", line2: null } } },
    });
    expect(input).toEqual({
      customer_email: "a@example.com",
      customer_name: "山田",
      shipping_address: { name: "山田 太郎", phone: "+81", postal_code: "100-0001", country: "JP", state: "東京都", city: "千代田区", line1: "1-1", line2: null },
      payment_provider: "stripe",
      payment_ref: "pi_1",
      // amount_total が無いセッション（古いイベント）では照合しない
      amount_paid_jpy: null,
      currency: null,
    });
  });
});

describe("Stripe-Context（組織 API キー）", () => {
  it("STRIPE_CONTEXT があればすべての Stripe API 呼び出しに Stripe-Context ヘッダを付ける", async () => {
    const seen: (string | null)[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push(new Headers(init?.headers).get("stripe-context"));
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/v1/checkout/sessions/")) return new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/x", payment_status: "paid" }));
      return new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/x" }));
    };
    const { createStripeClient } = await import("../src/payments/stripe");
    const withCtx = createStripeClient({ secretKey: "sk_test_1", context: "acct_123", fetch: fetchImpl });
    await withCtx.createCheckoutSession(null, { lineItems: [{ name: "x", unitAmountJpy: 100, quantity: 1 }], successUrl: "https://s/ok", cancelUrl: "https://s/cancel", reservationId: "r", shopId: "s", expiresAt: 1, collectShippingAddress: false });
    await withCtx.retrieveCheckoutSession(null, "cs_1");
    await withCtx.refundPaymentIntent(null, "pi_1");
    expect(seen).toEqual(["acct_123", "acct_123", "acct_123"]);
    const without = createStripeClient({ secretKey: "sk_test_1", fetch: fetchImpl });
    await without.retrieveCheckoutSession(null, "cs_1");
    expect(seen.at(-1)).toBeNull();
  });
});
