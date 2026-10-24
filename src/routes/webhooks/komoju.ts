import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { createPrivilegedDb, PrivilegedRpcError } from "../../db/privileged";
import { createKomojuClient, verifyKomojuSignature, type KomojuEvent } from "../../plugins/komoju";
import type { Ctx } from "../common";

/**
 * KOMOJU Webhook。X-Komoju-Signature（HMAC-SHA256 hex）を検証し、
 *   payment.captured → confirm_reservation（購入者情報は予約に一時保持したものを使う）
 *   payment.expired / payment.cancelled → release_reservation
 * 処理に成功したイベントだけ記録し、失敗は 500 で再送させる。
 */
export const komojuWebhook = new Hono<AppEnv>();

const CONFIRM = new Set(["payment.captured"]);
const RELEASE = new Set(["payment.expired", "payment.cancelled"]);

komojuWebhook.post("/", async (c: Ctx) => {
  const cfg = c.get("adapters").config;
  const webhookSecret = cfg.get("KOMOJU_WEBHOOK_SECRET");
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!webhookSecret || !url || !serviceRoleKey) return c.json({ error: "not_configured" }, 503);

  const payload = await c.req.text();
  if (!(await verifyKomojuSignature(payload, c.req.header("x-komoju-signature"), webhookSecret))) {
    return c.json({ error: "invalid_signature" }, 400);
  }
  let event: KomojuEvent;
  try {
    event = JSON.parse(payload) as KomojuEvent;
  } catch {
    return c.json({ error: "invalid_payload" }, 400);
  }
  if (typeof event.id !== "string" || typeof event.type !== "string" || !event.data) return c.json({ error: "invalid_payload" }, 400);
  if (!CONFIRM.has(event.type) && !RELEASE.has(event.type)) return c.json({ received: true, ignored: event.type });

  const payment = event.data;
  const reservationId = payment.metadata?.["reservation_id"] ?? payment.external_order_num ?? null;
  const shopId = payment.metadata?.["shop_id"] ?? null;
  if (!reservationId || !shopId) return c.json({ received: true, ignored: "no_reservation" });

  const db = createPrivilegedDb({ url, serviceRoleKey, fetch: c.get("deps").fetch });

  if (RELEASE.has(event.type)) {
    const released = await db.releaseReservation(reservationId, shopId);
    await db.recordWebhookEvent("komoju", event.id);
    return c.json({ received: true, released });
  }

  try {
    const orderId = await db.confirmReservation(reservationId, shopId, {
      customer_email: payment.customer_email ?? null,
      payment_provider: "komoju",
      payment_ref: payment.id,
      amount_paid_jpy: typeof payment.amount === "number" ? payment.amount : null,
      currency: typeof payment.currency === "string" ? payment.currency : null,
    });
    await db.recordWebhookEvent("komoju", event.id);
    return c.json({ received: true, order_id: orderId });
  } catch (e) {
    const refund = async (): Promise<boolean> => {
      const secretKey = cfg.get("KOMOJU_SECRET_KEY");
      // 返金できなければ例外 → 500 で KOMOJU に再送させる（決済済み・注文なし・返金なしで静かに終わらせない。監査 L-4）
      if (!secretKey) throw new Error(`komoju webhook ${event.id}: cannot refund ${payment.id} (secret key missing); not recording so KOMOJU retries`);
      await createKomojuClient({ secretKey, fetch: c.get("deps").fetch }).refundPayment(payment.id, `refund-${event.id}`);
      return true;
    };
    if (e instanceof PrivilegedRpcError && e.is("insufficient_stock_after_release")) {
      const refunded = await refund();
      await db.recordWebhookEvent("komoju", event.id);
      return c.json({ received: true, refunded });
    }
    if (e instanceof PrivilegedRpcError && e.is("amount_mismatch")) {
      // 支払額・通貨が Banto の計算と違う（0029）。確定せず返金し、在庫を戻す
      console.error(`[banto] komoju webhook ${event.id}: amount mismatch for reservation ${reservationId} (${e.details ?? ""})`);
      const refunded = await refund();
      await db.releaseReservation(reservationId, shopId).catch(() => false);
      await db.recordWebhookEvent("komoju", event.id);
      return c.json({ received: true, refunded, ignored: "amount_mismatch" });
    }
    if (e instanceof PrivilegedRpcError && e.is("reservation_not_found")) {
      await db.recordWebhookEvent("komoju", event.id);
      return c.json({ received: true, ignored: "reservation_not_found" });
    }
    throw e;
  }
});
