/**
 * 注文のキャンセル = 決済事業者で返金 → cancel_order（在庫を戻し、refunded / cancelled に）。
 * 管理画面と AI 用 API の両方がここを使う。返金に失敗したら注文は変えない（運営者に見せる）。
 */
import type { PrivilegedDb } from "../db/privileged";
import { createStripeClient } from "../payments/stripe";
import { createKomojuClient } from "../plugins/komoju";
import type { ConfigAdapter } from "../adapters/types";
import { type MigrationStateDeps } from "../db/migration-state";

/** orders.payment_account（0090）の API キー方式の印（Connect の接続先ではなく運営者自身のアカウントで決済した） */
export const PLATFORM_PAYMENT_ACCOUNT = "platform";

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

/**
 * 返金のみ（成功したら true、返金対象が無ければ false）。
 * payment_account（0090）: 注文に残した決済の口座。Connect のアカウント ID ならその口座で、"platform"（API キー方式）なら自分のアカウントで返金する
 * （接続先を変えた後の旧注文も、決済した口座で返金できる）。null（0090 より前の注文・DB）なら今までどおりショップの接続先と設定で決める
 */
export async function refundPayment(
  info: { payment_provider: string | null; payment_ref: string | null; payment_account?: string | null },
  opts: { config: ConfigAdapter; fetch: typeof fetch; stripeAccountId: string | null; idempotencyKey: string },
): Promise<boolean> {
  if (!info.payment_ref) return false;
  if (info.payment_provider === "stripe") {
    const secretKey = opts.config.get("STRIPE_SECRET_KEY");
    if (!secretKey) throw new CancelError("refund_failed", "STRIPE_SECRET_KEY is not configured");
    // Connect の注文は接続済みアカウントで、API キー方式は自分のアカウントで返金する
    const recorded = info.payment_account ?? null;
    const account = recorded ? (recorded === PLATFORM_PAYMENT_ACCOUNT ? null : recorded) : opts.stripeAccountId && opts.config.get("STRIPE_CLIENT_ID") ? opts.stripeAccountId : null;
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
  opts: { config: ConfigAdapter; fetch: typeof fetch; stripeAccountId: string | null; migrationState?: MigrationStateDeps | null },
): Promise<CancelResult> {
  const info = await db.orderPaymentInfo(orderId, shopId);
  if (!info) throw new CancelError("not_found", "order not found");
  if (info.status === "cancelled" || info.status === "refunded") return { status: info.status, already: true, refunded: info.status === "refunded" };
  if (info.status !== "paid") throw new CancelError("not_cancellable", `order is ${info.status}`);
  // 0090 が当たっていれば、決済した口座を注文から読む（列は 0090 から）
  const payment_account = await db.orderPaymentAccount(orderId, shopId);
  let refunded = false;
  try {
    refunded = await refundPayment({ ...info, payment_account }, { ...opts, idempotencyKey: `cancel-${orderId}` });
  } catch (e) {
    if (e instanceof CancelError) throw e;
    throw new CancelError("refund_failed", e instanceof Error ? e.message : String(e));
  }
  const r = await db.cancelOrder(orderId, shopId, refunded);
  return { status: r.status as "cancelled" | "refunded", already: r.already, refunded };
}
