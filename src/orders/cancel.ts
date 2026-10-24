/**
 * 注文のキャンセル = 決済事業者で返金 → cancel_order（在庫を戻し、refunded / cancelled に）。
 * 管理画面と AI 用 API の両方がここを使う。返金に失敗したら注文は変えない（運営者に見せる）。
 */
import type { PrivilegedDb } from "../db/privileged";
import { createStripeClient } from "../payments/stripe";
import { createKomojuClient } from "../plugins/komoju";
import type { ConfigAdapter } from "../adapters/types";

export class CancelError extends Error {
  constructor(
    public readonly code: "not_found" | "not_cancellable" | "refund_failed",
    message: string,
  ) {
    super(message);
    this.name = "CancelError";
  }
}

export interface CancelResult {
  status: "cancelled" | "refunded";
  already: boolean;
  refunded: boolean;
}

/** 返金のみ（成功したら true、返金対象が無ければ false） */
export async function refundPayment(
  info: { payment_provider: string | null; payment_ref: string | null },
  opts: { config: ConfigAdapter; fetch: typeof fetch; stripeAccountId: string | null; idempotencyKey: string },
): Promise<boolean> {
  if (!info.payment_ref) return false;
  if (info.payment_provider === "stripe") {
    const secretKey = opts.config.get("STRIPE_SECRET_KEY");
    if (!secretKey) throw new CancelError("refund_failed", "STRIPE_SECRET_KEY is not configured");
    // Connect の注文は接続済みアカウントで、API キー方式は自分のアカウントで返金する
    const account = opts.stripeAccountId && opts.config.get("STRIPE_CLIENT_ID") ? opts.stripeAccountId : null;
    await createStripeClient({ secretKey, clientId: opts.config.get("STRIPE_CLIENT_ID"), context: opts.config.get("STRIPE_CONTEXT"), fetch: opts.fetch }).refundPaymentIntent(account, info.payment_ref, opts.idempotencyKey);
    return true;
  }
  if (info.payment_provider === "komoju") {
    const secretKey = opts.config.get("KOMOJU_SECRET_KEY");
    if (!secretKey) throw new CancelError("refund_failed", "KOMOJU_SECRET_KEY is not configured");
    await createKomojuClient({ secretKey, fetch: opts.fetch }).refundPayment(info.payment_ref, opts.idempotencyKey);
    return true;
  }
  return false;
}

export async function cancelOrderWithRefund(
  db: PrivilegedDb,
  orderId: string,
  shopId: string,
  opts: { config: ConfigAdapter; fetch: typeof fetch; stripeAccountId: string | null },
): Promise<CancelResult> {
  const info = await db.orderPaymentInfo(orderId, shopId);
  if (!info) throw new CancelError("not_found", "order not found");
  if (info.status === "cancelled" || info.status === "refunded") return { status: info.status, already: true, refunded: info.status === "refunded" };
  if (info.status !== "paid") throw new CancelError("not_cancellable", `order is ${info.status}`);
  let refunded = false;
  try {
    refunded = await refundPayment(info, { ...opts, idempotencyKey: `cancel-${orderId}` });
  } catch (e) {
    if (e instanceof CancelError) throw e;
    throw new CancelError("refund_failed", e instanceof Error ? e.message : String(e));
  }
  const r = await db.cancelOrder(orderId, shopId, refunded);
  return { status: r.status as "cancelled" | "refunded", already: r.already, refunded };
}
