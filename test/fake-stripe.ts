/** テスト用の Stripe 代替（Checkout Session / Connect OAuth / Refund の最小実装） */
import { signStripePayload, type StripeEvent } from "../src/payments/stripe";

export class FakeStripe {
  readonly sessions = new Map<string, { account: string | null; params: URLSearchParams; status: string; payment_status: string; payment_intent: string }>();
  readonly refunds: { account: string | null; payment_intent: string; idempotencyKey: string | null }[] = [];
  readonly deauthorized: string[] = [];
  /** 作られたクーポン（id → 額・名前・アカウント） */
  readonly coupons = new Map<string, { account: string | null; amount_off: number; name: string }>();
  readonly calls: string[] = [];
  failCheckout = false;
  failRefund = false;
  private seq = 0;

  constructor(
    readonly secretKey = "sk_test_platform",
    readonly clientId = "ca_test_client",
  ) {}

  readonly fetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    this.calls.push(`${req.method} ${u.host}${u.pathname}`);
    if (req.headers.get("authorization") !== `Bearer ${this.secretKey}`) return json({ error: { message: "Invalid API Key", type: "invalid_request_error" } }, 401);
    const body = new URLSearchParams(await req.text());

    if (u.host === "connect.stripe.com") {
      if (u.pathname === "/oauth/token") {
        if (body.get("code") !== "ac_valid") return json({ error: "invalid_grant", error_description: "Authorization code does not exist" }, 400);
        return json({ stripe_user_id: "acct_connected", access_token: "sk_should_not_be_stored" });
      }
      if (u.pathname === "/oauth/deauthorize") {
        this.deauthorized.push(body.get("stripe_user_id") ?? "");
        return json({ stripe_user_id: body.get("stripe_user_id") });
      }
    }
    if (u.host === "api.stripe.com") {
      const account = req.headers.get("stripe-account"); // null = 自分のアカウント（API キー方式）
      if (u.pathname === "/v1/checkout/sessions" && req.method === "POST") {
        if (this.failCheckout) return json({ error: { message: "boom", type: "api_error" } }, 500);
        const id = `cs_test_${++this.seq}`;
        this.sessions.set(id, { account, params: body, status: "open", payment_status: "unpaid", payment_intent: `pi_${this.seq}` });
        return json({ id, url: `https://checkout.stripe.com/c/pay/${id}`, status: "open", payment_status: "unpaid", metadata: metadataOf(body) });
      }
      if (u.pathname === "/v1/coupons" && req.method === "POST") {
        const id = body.get("id") ?? `co_${++this.seq}`;
        if (this.coupons.has(id)) return json({ error: { message: "Coupon already exists.", code: "resource_already_exists", type: "invalid_request_error" } }, 400);
        if (body.get("currency") !== "jpy" || body.get("duration") !== "once") return json({ error: { message: "bad coupon" } }, 400);
        this.coupons.set(id, { account, amount_off: Number(body.get("amount_off")), name: body.get("name") ?? "" });
        return json({ id, amount_off: Number(body.get("amount_off")) });
      }
      const m = u.pathname.match(/^\/v1\/checkout\/sessions\/(.+)$/);
      if (m && req.method === "GET") {
        const s = this.sessions.get(m[1]!);
        if (!s) return json({ error: { message: "No such checkout.session", code: "resource_missing" } }, 404);
        return json({ id: m[1], url: null, status: s.status, payment_status: s.payment_status, metadata: metadataOf(s.params) });
      }
      if (u.pathname === "/v1/refunds" && req.method === "POST") {
        if (this.failRefund) return json({ error: { message: "charge_already_refunded", type: "invalid_request_error" } }, 400);
        this.refunds.push({ account, payment_intent: body.get("payment_intent") ?? "", idempotencyKey: req.headers.get("idempotency-key") });
        return json({ id: `re_${++this.seq}`, status: "succeeded" });
      }
    }
    return json({ error: { message: `unhandled ${req.method} ${u.pathname}` } }, 404);
  };

  /** checkout.session.completed などのイベント JSON を組み立てる */
  event(sessionId: string, type: string, extra: Partial<Record<string, unknown>> = {}): StripeEvent {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown session ${sessionId}`);
    const paid = type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded";
    return {
      id: `evt_${++this.seq}`,
      type,
      ...(s.account ? { account: s.account } : {}),
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: sessionId,
          object: "checkout.session",
          status: paid ? "complete" : "expired",
          payment_status: paid ? "paid" : "unpaid",
          payment_intent: s.payment_intent,
          amount_total: this.amountTotal(s.params),
          client_reference_id: s.params.get("client_reference_id"),
          metadata: metadataOf(s.params),
          customer_details: { email: "buyer@example.com", name: "山田 太郎", phone: "+819012345678" },
          collected_information: {
            shipping_details: { name: "山田 太郎", address: { country: "JP", postal_code: "100-0001", state: "東京都", city: "千代田区", line1: "千代田1-1", line2: null } },
          },
          ...extra,
        },
      },
    };
  }

  /** 決済ページの合計（明細 - クーポン）。Stripe が受け取る額 */
  amountTotal(params: URLSearchParams): number {
    let total = 0;
    for (let i = 0; params.has(`line_items[${i}][quantity]`); i++) total += Number(params.get(`line_items[${i}][price_data][unit_amount]`)) * Number(params.get(`line_items[${i}][quantity]`));
    const coupon = params.get("discounts[0][coupon]");
    return Math.max(0, total - (coupon ? (this.coupons.get(coupon)?.amount_off ?? 0) : 0));
  }

  /** 署名付きで Webhook を送る */
  async deliver(app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }, baseUrl: string, event: StripeEvent, secret: string, opts: { timestamp?: number; badSignature?: boolean } = {}) {
    const payload = JSON.stringify(event);
    const sig = opts.badSignature ? "t=1,v1=deadbeef" : await signStripePayload(payload, secret, opts.timestamp);
    return app.request(`${baseUrl}/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body: payload });
  }
}

function metadataOf(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of params) {
    const m = k.match(/^metadata\[(.+)\]$/);
    if (m) out[m[1]!] = v;
  }
  return out;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
