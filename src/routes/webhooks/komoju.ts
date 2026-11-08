import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { createPrivilegedDb } from "../../db/privileged";
import { confirmFromWebhook } from "../../payments/webhook-confirm";
import { migrated } from "../../db/migration-state";
import { REPLAY_GUARD_MIGRATION } from "./stripe";
import { createKomojuClient, verifyKomojuSignature, type KomojuEvent } from "../../plugins/komoju";
import { migrationStateFor, type Ctx } from "../common";

/**
 * KOMOJU Webhook。X-Komoju-Signature（HMAC-SHA256 hex）を検証し、
 *   payment.captured → confirm_reservation（購入者情報は予約に一時保持したものを使う）
 *   payment.expired / payment.cancelled → release_reservation
 * 処理に成功したイベントだけ記録し、失敗は 500 で再送させる。記録済みのイベントの再配信は何もしない（0128。src/payments/webhook-confirm.ts）。
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
  // 処理が済んだ（記録済みの）イベントの再配信は何もしない（0128。KOMOJU の署名には時刻が無いので、捕まえた本文はいつでも再送できる）
  const ms = migrationStateFor(c, url);
  const guard = ms ? await migrated(ms, REPLAY_GUARD_MIGRATION) : false;
  if (guard && (await db.webhookEventSeen("komoju", event.id))) return c.json({ received: true, duplicate: true });

  if (RELEASE.has(event.type)) {
    // 決済ページの期限切れだけがカゴ落ち（会員の予約なら checkout.abandoned を積む、0105）。支払いの失敗・取り消しは数えない
    const released = event.type === "payment.expired" ? await db.releaseReservationAbandoned(reservationId, shopId) : await db.releaseReservation(reservationId, shopId);
    await db.recordWebhookEvent("komoju", event.id);
    return c.json({ received: true, released });
  }

  const refund = async (): Promise<boolean> => {
    const secretKey = cfg.get("KOMOJU_SECRET_KEY");
    // 返金できなければ例外 → 500 で KOMOJU に再送させる（決済済み・注文なし・返金なしで静かに終わらせない）
    if (!secretKey) throw new Error(`komoju webhook ${event.id}: cannot refund ${payment.id} (secret key missing); not recording so KOMOJU retries`);
    await createKomojuClient({ secretKey, fetch: c.get("deps").fetch }).refundPayment(payment.id, `refund-${event.id}`);
    return true;
  };
  const order = {
    customer_email: payment.customer_email ?? null,
    payment_provider: "komoju",
    payment_ref: payment.id,
    amount_paid_jpy: typeof payment.amount === "number" ? payment.amount : null,
    currency: typeof payment.currency === "string" ? payment.currency : null,
    // 決済した口座（0090）。KOMOJU は API キー方式だけ
    payment_account: "komoju",
  };
  return c.json(await confirmFromWebhook({ db, provider: "komoju", eventId: event.id, reservationId, shopId, order, refund, guard }));
});
