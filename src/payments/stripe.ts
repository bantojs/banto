/**
 * Stripe（Connect Standard）の REST クライアント。SDK は使わず fetch だけで叩く（バンドルを小さく保ち、
 * ランタイムに依存しない）。保持するのは接続済みアカウント ID のみ（CLAUDE.md §1-5）。
 * カード情報は Stripe Checkout（ホスト型ページ）で完結する（§1-6）。
 */

export interface StripeClientOptions {
  secretKey: string;
  /** Connect（OAuth）を使うときだけ必要 */
  clientId?: string;
  /**
   * Stripe の「組織（Organization）」単位で発行した API キーを使うときの対象アカウント（acct_...）。
   * 組織キーは Stripe-Context ヘッダで対象アカウントを指定しないと 400 になる。アカウント内で発行したキーなら不要。
   */
  context?: string;
  fetch?: typeof fetch;
  apiBase?: string;
  connectBase?: string;
}

export class StripeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly type?: string,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

export interface CheckoutLineItem {
  name: string;
  unitAmountJpy: number;
  quantity: number;
}

export interface CreateCheckoutParams {
  lineItems: CheckoutLineItem[];
  successUrl: string;
  cancelUrl: string;
  reservationId: string;
  shopId: string;
  /** epoch 秒。Stripe の下限は作成から 30 分後 */
  expiresAt: number;
  allowedCountries?: string[];
  /** Banto 側で配送先を集めた場合は false にし、customerEmail を渡す */
  collectShippingAddress?: boolean;
  customerEmail?: string;
  /** Banto が判定した値引き（ensureCoupon で作った Stripe のクーポン ID）。決済ページと領収メールに「割引」として出る */
  couponId?: string;
}

export interface CheckoutSession {
  id: string;
  url: string | null;
  status: string;
  payment_status: string;
  payment_intent: string | null;
  client_reference_id: string | null;
  metadata: Record<string, string>;
  customer_details?: { email?: string | null; name?: string | null; phone?: string | null } | null;
  shipping_details?: { name?: string | null; address?: Record<string, string | null> | null } | null;
  collected_information?: { shipping_details?: { name?: string | null; address?: Record<string, string | null> | null } | null } | null;
  amount_total?: number | null;
  currency?: string | null;
}

export interface StripeEvent {
  id: string;
  type: string;
  /** Connect: イベント元の接続済みアカウント */
  account?: string;
  created: number;
  data: { object: Record<string, unknown> };
}

/** ネストしたオブジェクトを Stripe の form-encoding（a[b][0][c]=v）に変換する */
export function formEncode(params: Record<string, unknown>, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object" && item !== null) formEncode(item as Record<string, unknown>, `${key}[${i}]`, out);
        else out.append(`${key}[${i}]`, String(item));
      });
    } else if (typeof v === "object") {
      formEncode(v as Record<string, unknown>, key, out);
    } else {
      out.append(key, String(v));
    }
  }
  return out;
}

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Stripe-Signature ヘッダの検証（v1 = HMAC-SHA256(`${t}.${payload}`)）。
 * 正しければ true。tolerance 秒より古いタイムスタンプは拒否（リプレイ防止）。
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | undefined,
  secret: string,
  opts: { toleranceSeconds?: number; now?: number } = {},
): Promise<boolean> {
  if (!header) return false;
  const parts = new Map<string, string[]>();
  for (const kv of header.split(",")) {
    const [k, v] = kv.trim().split("=", 2);
    if (!k || v === undefined) continue;
    parts.set(k, [...(parts.get(k) ?? []), v]);
  }
  const t = parts.get("t")?.[0];
  const sigs = parts.get("v1") ?? [];
  if (!t || sigs.length === 0 || !/^\d+$/.test(t)) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? 300;
  if (Math.abs(now - Number(t)) > tolerance) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`)));
  return sigs.some((s) => timingSafeEqual(s, expected));
}

/** テスト・ローカル用: Stripe と同じ形式で署名ヘッダを作る */
export async function signStripePayload(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${payload}`)));
  return `t=${timestamp},v1=${sig}`;
}

export interface StripeClient {
  /** 運営者を Stripe の接続画面へ送る URL */
  oauthAuthorizeUrl(params: { redirectUri: string; state: string }): string;
  /** 認可コードを接続済みアカウント ID に交換する */
  oauthToken(code: string): Promise<{ stripe_user_id: string }>;
  deauthorize(accountId: string): Promise<void>;
  /** accountId が null なら自分のアカウント（API キー方式）、あれば接続済みアカウントへの直接課金（Connect） */
  createCheckoutSession(accountId: string | null, params: CreateCheckoutParams): Promise<CheckoutSession>;
  retrieveCheckoutSession(accountId: string | null, sessionId: string): Promise<CheckoutSession>;
  /**
   * 値引きの額のクーポン（1 回限り、定額）を用意して ID を返す。判定と金額は Banto が持ち、Stripe には表示と合計の計算だけを任せる。
   * 同じ額・同じ表示名なら同じ ID を使い回す（Stripe 側にクーポンが溜まり続けないように）
   */
  ensureCoupon(accountId: string | null, amountJpy: number, name: string): Promise<string>;
  /** idempotencyKey を渡すと Stripe 側で二重返金を防ぐ */
  refundPaymentIntent(accountId: string | null, paymentIntentId: string, idempotencyKey?: string): Promise<{ id: string; status: string }>;
}

export function createStripeClient(opts: StripeClientOptions): StripeClient {
  const doFetch = opts.fetch ?? fetch;
  const apiBase = opts.apiBase ?? "https://api.stripe.com";
  const connectBase = opts.connectBase ?? "https://connect.stripe.com";

  async function call<T>(url: string, body: URLSearchParams, extra: Record<string, string> = {}): Promise<T> {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Stripe-Version": "2025-08-27.basil",
        ...(opts.context ? { "Stripe-Context": opts.context } : {}),
        ...extra,
      },
      body: body.toString(),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: { message: text } };
    }
    if (!res.ok) {
      const err = (json as { error?: { message?: string; code?: string; type?: string } }).error ?? {};
      throw new StripeError(err.message ?? `Stripe ${res.status}`, res.status, err.code, err.type);
    }
    return json as T;
  }

  async function get<T>(url: string, extra: Record<string, string> = {}): Promise<T> {
    const res = await doFetch(url, {
      headers: { Authorization: `Bearer ${opts.secretKey}`, "Stripe-Version": "2025-08-27.basil", ...(opts.context ? { "Stripe-Context": opts.context } : {}), ...extra },
    });
    const json = (await res.json()) as T & { error?: { message?: string; code?: string; type?: string } };
    if (!res.ok) throw new StripeError(json.error?.message ?? `Stripe ${res.status}`, res.status, json.error?.code, json.error?.type);
    return json;
  }

  const accountHeader = (accountId: string | null): Record<string, string> => (accountId ? { "Stripe-Account": accountId } : {});
  const clientId = () => {
    if (!opts.clientId) throw new StripeError("STRIPE_CLIENT_ID is not configured", 0);
    return opts.clientId;
  };

  return {
    oauthAuthorizeUrl({ redirectUri, state }) {
      const q = new URLSearchParams({
        response_type: "code",
        client_id: clientId(),
        scope: "read_write",
        redirect_uri: redirectUri,
        state,
      });
      return `${connectBase}/oauth/authorize?${q.toString()}`;
    },
    oauthToken: (code) =>
      call<{ stripe_user_id: string }>(`${connectBase}/oauth/token`, new URLSearchParams({ grant_type: "authorization_code", code })),
    async deauthorize(accountId) {
      await call(`${connectBase}/oauth/deauthorize`, new URLSearchParams({ client_id: clientId(), stripe_user_id: accountId }));
    },
    createCheckoutSession(accountId, p) {
      const body = formEncode({
        mode: "payment",
        line_items: p.lineItems.map((li) => ({
          quantity: li.quantity,
          price_data: { currency: "jpy", unit_amount: li.unitAmountJpy, product_data: { name: li.name } },
        })),
        success_url: p.successUrl,
        cancel_url: p.cancelUrl,
        client_reference_id: p.reservationId,
        metadata: { reservation_id: p.reservationId, shop_id: p.shopId },
        expires_at: p.expiresAt,
        ...(p.collectShippingAddress === false
          ? { ...(p.customerEmail ? { customer_email: p.customerEmail } : {}) }
          : { shipping_address_collection: { allowed_countries: p.allowedCountries ?? ["JP"] }, phone_number_collection: { enabled: true } }),
        ...(p.couponId ? { discounts: [{ coupon: p.couponId }] } : {}),
        locale: "ja",
      });
      return call<CheckoutSession>(`${apiBase}/v1/checkout/sessions`, body, accountHeader(accountId));
    },
    async ensureCoupon(accountId, amountJpy, name) {
      const label = name.slice(0, 40);
      let h = 0x811c9dc5;
      for (let i = 0; i < label.length; i++) {
        h ^= label.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      const id = `banto_${amountJpy}_${h.toString(36)}`;
      try {
        await call(`${apiBase}/v1/coupons`, formEncode({ id, amount_off: amountJpy, currency: "jpy", duration: "once", name: label }), accountHeader(accountId));
      } catch (e) {
        // 前に作ったものを使い回す
        if (!(e instanceof StripeError && e.code === "resource_already_exists")) throw e;
      }
      return id;
    },
    retrieveCheckoutSession: (accountId, sessionId) => get<CheckoutSession>(`${apiBase}/v1/checkout/sessions/${sessionId}`, accountHeader(accountId)),
    refundPaymentIntent: (accountId, paymentIntentId, idempotencyKey) =>
      call<{ id: string; status: string }>(`${apiBase}/v1/refunds`, new URLSearchParams({ payment_intent: paymentIntentId }), {
        ...accountHeader(accountId),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      }),
  };
}
