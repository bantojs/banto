import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { webhookBody } from "./body";
import { PrivilegedRpcError, createPrivilegedDb } from "../../db/privileged";
import { replayGuard } from "./stripe";
import { AmazonPayError, CHARGE_ID_RE, amazonPayFromConfig, type AmazonPayCharge } from "../../plugins/amazon_pay";
import { AMAZON_PAY_PROVIDER, confirmAmazonPayCharge } from "../../payments/amazon-pay";
import { clientIp, type Ctx } from "../common";
import { rateLimiter } from "../../adapters/rate-limit";

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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 1 つの送り元からの通知の数（1 分）。署名を確かめない入口なので、通知ごとの Amazon Pay の API の呼び出しを外から使い切らせない。超えた分は Amazon が再送する */
const IPN_PER_MINUTE = 120;

amazonPayWebhook.post("/", async (c: Ctx) => {
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  const client = amazonPayFromConfig(cfg, c.get("deps").fetch);
  if (!client || !url || !serviceRoleKey) return c.json({ error: "not_configured" }, 503);

  // 送り元が分からない構成（Node で IP のヘッダの設定が無い）では数えない: 全員が 1 つの鍵になり、だれかが上限まで送ると本物の通知まで断ってしまう
  const from = clientIp(c);
  if (from && !(await rateLimiter(c.get("adapters")).hit(`amazon-pay-ipn:${from}`, IPN_PER_MINUTE, 60))) return c.json({ error: "too_many_requests" }, 429);
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

  // 済んだ Charge の通知（再送・戻りで確定済み）は、Amazon Pay の API を呼ぶ前に終える
  const db = createPrivilegedDb({ url, serviceRoleKey, fetch: c.get("deps").fetch });
  const guard = await replayGuard(c, url);
  if (guard && (await db.webhookEventSeen(AMAZON_PAY_PROVIDER, chargeId))) return c.json({ received: true, duplicate: true });

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

  let r: Awaited<ReturnType<typeof confirmAmazonPayCharge>>;
  try {
    r = await confirmAmazonPayCharge({ db, client, chargeId, reservationId, shopId, guard, charge });
  } catch (e) {
    // Banto が予約の欄に入れるのは UUID だけ。同じ加盟店をほかの仕組みでも使っていて、UUID でない値が入った Charge は DB が型の誤りで断る。
    // 500 にすると Amazon が再送し続けるので、Banto の予約ではないものとして終える。UUID の形の予約（Banto のもの）の中で起きた誤りは
    // 飲み込まない（支払い済み・注文なしを静かに残さない）
    if (!(UUID_RE.test(reservationId) && UUID_RE.test(shopId)) && e instanceof PrivilegedRpcError && e.is("invalid input syntax for type uuid")) {
      return c.json({ received: true, ignored: "no_reservation" });
    }
    throw e;
  }
  if (r.kind === "duplicate") return c.json({ received: true, duplicate: true });
  if (r.kind === "confirmed") return c.json(r.result);
  return c.json({ received: true, ignored: r.kind });
});
