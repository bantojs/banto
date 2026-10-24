/**
 * KOMOJU 決済: コンビニ払い・銀行振込・PayPay 等。KOMOJU のホスト型ページ（Session）へ転送する。
 * 必要な Secret: KOMOJU_SECRET_KEY（sk_...）, KOMOJU_WEBHOOK_SECRET。DB には何も置かない（CLAUDE.md §1-5）。
 * 有効化は hooks の送信先行（イベント購読なし）で表す。
 */
import type { BundledPlugin } from "./types";

export const KOMOJU_API_BASE = "https://komoju.com/api/v1";
/** コンビニ払いは支払いまで日数がかかるため、予約 TTL は長めに取る（設定で変更可） */
export const KOMOJU_DEFAULT_RESERVATION_HOURS = 72;

export const komoju: BundledPlugin = {
  id: "komoju",
  manifest: {
    name: "KOMOJU 決済",
    version: "1.0.0",
    description: "コンビニ払い・銀行振込・PayPay などを KOMOJU のホスト型決済ページで受け付けます。Stripe と併用できます。",
    events: [],
    settings: [
      {
        key: "payment_types",
        label: "受け付ける支払い方法（カンマ区切り。空なら KOMOJU 側の既定）",
        type: "text",
        description: "例: konbini,bank_transfer,paypay",
      },
      { key: "reservation_hours", label: "在庫を確保しておく時間（時間）", type: "text", description: `既定 ${KOMOJU_DEFAULT_RESERVATION_HOURS}` },
    ],
  },
  requiredSecrets: ["KOMOJU_SECRET_KEY", "KOMOJU_WEBHOOK_SECRET"],
  webhook: {
    path: "/webhooks/komoju",
    events: ["payment.captured", "payment.cancelled", "payment.expired"],
    where: "KOMOJU の管理画面 → 設定 → Webhook → 追加。シークレットは自分で決めて KOMOJU_WEBHOOK_SECRET にも同じ値を",
  },
};

export class KomojuError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "KomojuError";
  }
}

export interface KomojuSession {
  id: string;
  session_url: string;
  status: string;
}

export interface KomojuPayment {
  id: string;
  status: string;
  amount: number;
  currency: string;
  external_order_num?: string | null;
  metadata?: Record<string, string> | null;
  session?: string | null;
  customer_email?: string | null;
}

export interface KomojuEvent {
  id: string;
  type: string;
  data: KomojuPayment;
}

export interface KomojuClient {
  createSession(params: {
    amountJpy: number;
    returnUrl: string;
    reservationId: string;
    shopId: string;
    paymentTypes?: string[];
    email?: string;
  }): Promise<KomojuSession>;
  refundPayment(paymentId: string, idempotencyKey: string): Promise<{ id: string; status: string }>;
}

export function createKomojuClient(opts: { secretKey: string; fetch?: typeof fetch; apiBase?: string }): KomojuClient {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.apiBase ?? KOMOJU_API_BASE;
  const auth = `Basic ${btoa(`${opts.secretKey}:`)}`;

  async function post<T>(path: string, body: unknown, extra: Record<string, string> = {}): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json", ...extra },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
      } catch {
        /* keep text */
      }
      throw new KomojuError(`KOMOJU ${res.status}: ${message}`, res.status);
    }
    return JSON.parse(text) as T;
  }

  return {
    createSession: (p) =>
      post<KomojuSession>("/sessions", {
        amount: p.amountJpy,
        currency: "JPY",
        return_url: p.returnUrl,
        default_locale: "ja",
        external_order_num: p.reservationId,
        metadata: { reservation_id: p.reservationId, shop_id: p.shopId },
        ...(p.paymentTypes && p.paymentTypes.length > 0 ? { payment_types: p.paymentTypes } : {}),
        ...(p.email ? { email: p.email } : {}),
      }),
    refundPayment: (paymentId, idempotencyKey) =>
      post<{ id: string; status: string }>(`/payments/${paymentId}/refund`, {}, { "Idempotency-Key": idempotencyKey }),
  };
}

const enc = new TextEncoder();

/** X-Komoju-Signature = hex(HMAC-SHA256(webhook_secret, raw body)) */
export async function verifyKomojuSignature(body: string, header: string | undefined, secret: string): Promise<boolean> {
  if (!header) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body))), (b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.trim().toLowerCase();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export async function signKomojuPayload(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body))), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function parsePaymentTypes(settings: Record<string, string | boolean>): string[] {
  const raw = typeof settings["payment_types"] === "string" ? settings["payment_types"] : "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[a-z_]+$/.test(s));
}

export function reservationSeconds(settings: Record<string, string | boolean>): number {
  const raw = typeof settings["reservation_hours"] === "string" ? Number(settings["reservation_hours"]) : NaN;
  const hours = Number.isFinite(raw) && raw >= 1 && raw <= 24 * 14 ? raw : KOMOJU_DEFAULT_RESERVATION_HOURS;
  return Math.round(hours * 3600);
}
