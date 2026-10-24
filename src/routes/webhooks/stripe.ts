import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { createPrivilegedDb, PrivilegedRpcError, type OrderInput } from "../../db/privileged";
import { createStripeClient, verifyStripeSignature, type CheckoutSession, type StripeEvent } from "../../payments/stripe";
import type { Ctx } from "../common";

/**
 * Stripe Webhook（Connect: 接続済みアカウントのイベント）。
 *   checkout.session.completed / async_payment_succeeded → confirm_reservation（注文確定）
 *   checkout.session.expired  / async_payment_failed     → release_reservation（在庫を戻す）
 * 処理に成功したイベントだけ record_webhook_event に記録する（失敗時は 500 を返して Stripe に再送させる）。
 */
export const stripeWebhook = new Hono<AppEnv>();

const CONFIRM_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);
const RELEASE_EVENTS = new Set(["checkout.session.expired", "checkout.session.async_payment_failed"]);

export function orderInputFromSession(session: CheckoutSession): OrderInput {
  const shipping = session.collected_information?.shipping_details ?? session.shipping_details ?? null;
  const address = shipping?.address ?? null;
  return {
    customer_email: session.customer_details?.email ?? null,
    customer_name: session.customer_details?.name ?? shipping?.name ?? null,
    shipping_address: address
      ? {
          name: shipping?.name ?? null,
          phone: session.customer_details?.phone ?? null,
          postal_code: address["postal_code"] ?? null,
          country: address["country"] ?? null,
          state: address["state"] ?? null,
          city: address["city"] ?? null,
          line1: address["line1"] ?? null,
          line2: address["line2"] ?? null,
        }
      : null,
    payment_provider: "stripe",
    payment_ref: typeof session.payment_intent === "string" ? session.payment_intent : session.id,
    // 照合用（Banto の計算と違えば confirm_reservation が amount_mismatch で確定しない、0029）
    amount_paid_jpy: typeof session.amount_total === "number" ? session.amount_total : null,
    currency: typeof session.currency === "string" ? session.currency : null,
  };
}

stripeWebhook.post("/", async (c: Ctx) => {
  const cfg = c.get("adapters").config;
  const webhookSecret = cfg.get("STRIPE_WEBHOOK_SECRET");
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!webhookSecret || !url || !serviceRoleKey) return c.json({ error: "not_configured" }, 503);

  const payload = await c.req.text();
  if (!(await verifyStripeSignature(payload, c.req.header("stripe-signature"), webhookSecret))) {
    return c.json({ error: "invalid_signature" }, 400);
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return c.json({ error: "invalid_payload" }, 400);
  }
  if (typeof event.id !== "string" || typeof event.type !== "string") return c.json({ error: "invalid_payload" }, 400);

  const db = createPrivilegedDb({ url, serviceRoleKey, fetch: c.get("deps").fetch });

  if (!CONFIRM_EVENTS.has(event.type) && !RELEASE_EVENTS.has(event.type)) {
    return c.json({ received: true, ignored: event.type });
  }

  const session = event.data.object as unknown as CheckoutSession;
  const reservationId = session.metadata?.["reservation_id"] ?? session.client_reference_id ?? null;
  const shopId = session.metadata?.["shop_id"] ?? null;
  if (!reservationId || !shopId) return c.json({ received: true, ignored: "no_reservation" });

  // Connect のイベントは、そのショップの接続先アカウントからのものだけ受け付ける（別の接続済みアカウントが metadata を真似ても確定しない。監査 M7）
  if (typeof event.account === "string") {
    const expected = await db.shopStripeAccount(shopId);
    if (expected !== event.account) {
      await db.recordWebhookEvent("stripe", event.id);
      return c.json({ received: true, ignored: "wrong_account" });
    }
  }

  if (RELEASE_EVENTS.has(event.type)) {
    const released = await db.releaseReservation(reservationId, shopId);
    await db.recordWebhookEvent("stripe", event.id);
    return c.json({ received: true, released });
  }

  // 確定系。completed でも async 決済（コンビニ等）は未払いのことがあるので payment_status を見る
  if (session.payment_status !== "paid") return c.json({ received: true, ignored: "unpaid" });

  // 決済済みなのに確定できないとき（解放後の在庫切れ・支払額の不一致）は返金する（冪等キー = イベント ID）。
  // 返金できなければ例外 → 500 で Stripe に再送させる（決済済み・注文なし・返金なしで静かに終わらせない。監査 L-4）
  const refund = async (): Promise<boolean> => {
    const secretKey = cfg.get("STRIPE_SECRET_KEY");
    const paymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : null;
    if (!secretKey || !paymentIntent) {
      throw new Error(`stripe webhook ${event.id}: cannot refund ${session.id} (secret key or payment_intent missing); not recording so Stripe retries`);
    }
    const stripe = createStripeClient({ secretKey, context: cfg.get("STRIPE_CONTEXT"), fetch: c.get("deps").fetch });
    // Connect のイベントには account が付く。API キー方式（自分のアカウント）なら null
    await stripe.refundPaymentIntent(event.account ?? null, paymentIntent, `refund-${event.id}`);
    return true;
  };

  try {
    const orderId = await db.confirmReservation(reservationId, shopId, orderInputFromSession(session));
    await db.recordWebhookEvent("stripe", event.id);
    return c.json({ received: true, order_id: orderId });
  } catch (e) {
    if (e instanceof PrivilegedRpcError && e.is("insufficient_stock_after_release")) {
      // TTL 切れで在庫が他の人に渡ってしまった
      const refunded = await refund();
      await db.recordWebhookEvent("stripe", event.id);
      return c.json({ received: true, refunded });
    }
    if (e instanceof PrivilegedRpcError && e.is("amount_mismatch")) {
      // 支払額・通貨が Banto の計算と違う（0029）。確定せず返金し、在庫を戻す
      console.error(`[banto] stripe webhook ${event.id}: amount mismatch for reservation ${reservationId} (${e.details ?? ""})`);
      const refunded = await refund();
      await db.releaseReservation(reservationId, shopId).catch(() => false);
      await db.recordWebhookEvent("stripe", event.id);
      return c.json({ received: true, refunded, ignored: "amount_mismatch" });
    }
    if (e instanceof PrivilegedRpcError && e.is("reservation_not_found")) {
      await db.recordWebhookEvent("stripe", event.id);
      return c.json({ received: true, ignored: "reservation_not_found" });
    }
    throw e; // 500 → Stripe が再送する
  }
});
