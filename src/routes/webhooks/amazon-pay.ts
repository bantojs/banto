import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { webhookBody } from "./body";
import { createPrivilegedDb } from "../../db/privileged";
import { migrated } from "../../db/migration-state";
import { REPLAY_GUARD_MIGRATION } from "./stripe";
import { AmazonPayError, CHARGE_ID_RE, amazonPayFromConfig, type AmazonPayCharge } from "../../plugins/amazon_pay";
import { confirmAmazonPayCharge } from "../../payments/amazon-pay";
import { migrationStateFor, type Ctx } from "../common";

/**
 * Amazon Pay の IPN（即時支払い通知）。取りこぼしの保険（ふだんは戻りで確定する。src/payments/amazon-pay.ts）。
 *
 * 通知の中身は信じない: Amazon Pay の指示どおり、書いてある Charge を API で引き直し、売上が確定（Captured）していれば
 * Charge Permission の merchantMetadata（Banto が署名したボタンの中身に入れた予約 ID とショップ ID）で予約を確定する。
 * 偽の通知が来ても、このデプロイの加盟店の本物の Charge しか確定しない（SNS の署名は検証しない）。
 * 冪等の鍵は Charge ID（戻りの確定と同じ）。処理に失敗したら 500 で再送させる。
 */
export const amazonPayWebhook = new Hono<AppEnv>();

const ID_RE = /^[A-Za-z0-9-]{8,100}$/;

amazonPayWebhook.post("/", async (c: Ctx) => {
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  const client = amazonPayFromConfig(cfg, c.get("deps").fetch);
  if (!client || !url || !serviceRoleKey) return c.json({ error: "not_configured" }, 503);

  const body = await webhookBody(c);
  if ("res" in body) return body.res;
  const text = body.text;
  let message: Record<string, unknown>;
  try {
    const envelope = JSON.parse(text) as Record<string, unknown>;
    message = (typeof envelope["Message"] === "string" ? JSON.parse(envelope["Message"]) : envelope) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_payload" }, 400);
  }
  if (!message || typeof message !== "object") return c.json({ error: "invalid_payload" }, 400);
  // 別の加盟店の通知（設定の取り違え）は何もしない
  const merchant = message["MerchantID"] ?? message["merchantID"];
  if (typeof merchant === "string" && merchant !== client.merchantId) return c.json({ received: true, ignored: "merchant" });
  if (message["ObjectType"] !== "CHARGE") return c.json({ received: true, ignored: String(message["ObjectType"] ?? "") });
  const chargeId = message["ObjectId"];
  if (typeof chargeId !== "string" || !CHARGE_ID_RE.test(chargeId)) return c.json({ error: "invalid_payload" }, 400);

  // どの予約か: Charge → Charge Permission の merchantMetadata（ボタンの中身は Banto の署名つき）
  let reservationId: string | null = null;
  let shopId: string | null = null;
  let charge: AmazonPayCharge;
  try {
    charge = await client.getCharge(chargeId);
    if (charge.statusDetails?.state !== "Captured") return c.json({ received: true, ignored: charge.statusDetails?.state ?? "unknown" });
    if (!charge.chargePermissionId || !ID_RE.test(charge.chargePermissionId)) return c.json({ received: true, ignored: "no_charge_permission" });
    const permission = await client.getChargePermission(charge.chargePermissionId);
    reservationId = permission.merchantMetadata?.merchantReferenceId ?? null;
    shopId = permission.merchantMetadata?.customInformation ?? null;
  } catch (e) {
    // 無い Charge（偽の通知・別の環境）は何もしない。それ以外は再送させる
    if (e instanceof AmazonPayError && e.status === 404) return c.json({ received: true, ignored: "not_found" });
    throw e;
  }
  // 形だけ確かめる（予約がそのショップのものかは DB の confirm_reservation が確かめる）
  const idLike = /^[0-9A-Za-z-]{1,64}$/;
  if (!reservationId || !shopId || !idLike.test(reservationId) || !idLike.test(shopId)) return c.json({ received: true, ignored: "no_reservation" });

  const db = createPrivilegedDb({ url, serviceRoleKey, fetch: c.get("deps").fetch });
  const ms = migrationStateFor(c, url);
  const guard = ms ? await migrated(ms, REPLAY_GUARD_MIGRATION) : false;
  const r = await confirmAmazonPayCharge({ db, client, chargeId, reservationId, shopId, guard, charge });
  if (r.kind === "duplicate") return c.json({ received: true, duplicate: true });
  if (r.kind === "confirmed") return c.json(r.result);
  return c.json({ received: true, ignored: r.kind });
});
