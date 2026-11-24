import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { webhookBody } from "./body";
import { PrivilegedRpcError, createPrivilegedDb } from "../../db/privileged";
import { AmazonPayError, CHARGE_ID_RE, amazonPayFromConfig, type AmazonPayCharge } from "../../plugins/amazon_pay";
import { AMAZON_PAY_PROVIDER, confirmAmazonPayCharge } from "../../payments/amazon-pay";
import { clientIp, type Ctx } from "../common";
import { rateLimiter } from "../../adapters/rate-limit";
import { snsTopicArn, verifySnsMessage, type SnsTopic } from "../../payments/sns";
import type { ConfigAdapter } from "../../adapters/types";

/**
 * Amazon Pay の IPN（即時支払い通知）。取りこぼしの保険（ふだんは戻りで確定する。src/payments/amazon-pay.ts）。
 *
 * 通知は Amazon SNS の封筒で届く。受け付けるのは次をすべて満たすものだけで、どれかが欠けたら Amazon Pay の API を呼ぶ前に 403:
 *   1. SNS の署名が合う（src/payments/sns.ts）
 *   2. TopicArn が運営者の許したもの（デプロイの設定 AMAZON_PAY_IPN_TOPIC_ARNS（ARN そのもの）か AMAZON_PAY_IPN_TOPIC_ACCOUNTS
 *      （AWS のアカウント ID）、どちらもカンマ区切り）。署名が合うだけでは「どこかの SNS のトピックから送られた」ことしか分からず、
 *      だれでも自分のトピックで署名つきの通知を作れるため。Amazon Pay の IPN を送るトピックの ARN は公式に一覧が無いので、Banto は
 *      決め打ちしない。設定があれば、署名を確かめる前（証明書を取りに行く前）に TopicArn で断る。設定が無いときは、
 *      ログに出すためだけに署名を確かめ（isolate ごとに 1 分 30 通まで）、確かめた TopicArn をログに出して断る
 *      （isolate ごとに 1 分 5 行まで。運営者がそれを設定に写す）。
 *   3. MerchantID がこのデプロイの加盟店（AMAZON_PAY_MERCHANT_ID）と同じ
 * 通った通知でも中身は信じない: 書いてある Charge を API で引き直し、売上が確定（Captured）していれば Charge Permission の
 * merchantMetadata（Banto が署名したボタンの中身に入れた予約 ID とショップ ID）で予約を確定する。
 * IPN は取りこぼしの保険で、ふだんの確定は戻り（src/payments/amazon-pay.ts）。IPN を受け付けない設定でも戻りで確定する。
 * SNS の購読の確認（SubscriptionConfirmation / UnsubscribeConfirmation）は、確かめたうえで何もしない（SubscribeURL は開かない）。
 * 冪等の鍵は Charge ID（戻りの確定と同じ）。処理に失敗したら 5xx で再送させる（Amazon Pay は 5xx のときだけ再送する）。
 */
export const amazonPayWebhook = new Hono<AppEnv>();

const ID_RE = /^[A-Za-z0-9-]{8,100}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 1 つの送り元からの通知の数（1 分）。署名の確かめ（証明書の取得・RSA の検証）を外から使い切らせない。超えた分は Amazon が再送する */
const IPN_PER_MINUTE = 120;
/**
 * 送り元が分からない構成（Node で IP のヘッダの設定が無い）のデプロイ全体の数（1 分）。署名とトピックを確かめた後の通知だけを数える
 * （確かめる前に数えると、だれかが偽の通知を送り続けるだけで本物の通知まで断ってしまう。確かめる手間は RSA の検証 1 回と、覚えた証明書）
 */
export const IPN_PER_MINUTE_ALL = 600;
/** Amazon Pay に無かった Charge を覚えておく秒数（同じ ID に続けて API を呼ばない） */
const UNKNOWN_CHARGE_TTL = 600;
/** トピックを許す設定が無いあいだ、ログに出すためだけに署名を確かめる数（1 分）。その間の通知はどれも断る */
export const IPN_UNCONFIGURED_PER_MINUTE = 30;
/** 許していない TopicArn のログの行数（isolate ごとに 1 分） */
export const IPN_TOPIC_LOG_PER_MINUTE = 5;
const ACCOUNT_RE = /^\d{12}$/;
const topicLog = { start: 0, count: 0 };
let warnedAccounts = false;

function listSetting(cfg: ConfigAdapter, name: string): string[] {
  return (cfg.get(name) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** 許すトピックの設定（ARN そのものと AWS のアカウント ID）。アカウント ID の形が違うものは使わず、1 度だけ知らせる */
export function ipnTopicAllowlist(cfg: ConfigAdapter): { arns: string[]; accounts: string[] } {
  const arns = listSetting(cfg, "AMAZON_PAY_IPN_TOPIC_ARNS");
  const raw = listSetting(cfg, "AMAZON_PAY_IPN_TOPIC_ACCOUNTS");
  const accounts = raw.filter((a) => ACCOUNT_RE.test(a));
  if (accounts.length !== raw.length && !warnedAccounts) {
    warnedAccounts = true;
    console.warn("[banto] amazon-pay ipn: AMAZON_PAY_IPN_TOPIC_ACCOUNTS has entries that are not 12-digit AWS account IDs; they are ignored");
  }
  return { arns, accounts };
}

/** TopicArn を受け付けてよいか（デプロイの設定の ARN そのものか、AWS のアカウント ID） */
export function ipnTopicAllowed(topic: SnsTopic, list: { arns: string[]; accounts: string[] }): boolean {
  return list.arns.includes(topic.arn) || list.accounts.includes(topic.account);
}

/** 許していない TopicArn をログに出す（isolate ごとに 1 分 IPN_TOPIC_LOG_PER_MINUTE 行まで） */
export function logTopicNotAllowed(arn: string, now = Date.now()): boolean {
  if (now - topicLog.start >= 60_000) {
    topicLog.start = now;
    topicLog.count = 0;
  }
  if (topicLog.count >= IPN_TOPIC_LOG_PER_MINUTE) return false;
  topicLog.count++;
  console.warn(`[banto] amazon-pay ipn: TopicArn not allowed: ${arn} (set AMAZON_PAY_IPN_TOPIC_ARNS or AMAZON_PAY_IPN_TOPIC_ACCOUNTS to accept it)`);
  return true;
}

amazonPayWebhook.post("/", async (c: Ctx) => {
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  const client = amazonPayFromConfig(cfg, c.get("deps").fetch);
  if (!client || !url || !serviceRoleKey) return c.json({ error: "not_configured" }, 503);

  // 送り元ごとに数える（送り元が分からない構成では、署名とトピックを確かめた後にデプロイ全体で数える）
  const from = clientIp(c);
  if (from && !(await rateLimiter(c.get("adapters")).hit(`amazon-pay-ipn:${from}`, IPN_PER_MINUTE, 60))) return c.json({ error: "too_many_requests" }, 429);
  const body = await webhookBody(c);
  if ("res" in body) return body.res;
  const text = body.text;
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return c.json({ error: "invalid_payload" }, 400);
  }
  const cache = c.get("adapters").cache;
  // トピックは署名を確かめる前に見る（許していないトピックの通知のために証明書を取りに行かない）
  const topic = envelope && typeof envelope === "object" ? snsTopicArn((envelope as Record<string, unknown>)["TopicArn"]) : null;
  if (!topic) return c.json({ error: "invalid_signature" }, 403);
  const allow = ipnTopicAllowlist(cfg);
  const configured = allow.arns.length > 0 || allow.accounts.length > 0;
  if (configured && !ipnTopicAllowed(topic, allow)) return c.json({ error: "topic_not_allowed" }, 403);
  // 設定が無いあいだは、ログに出すためだけに確かめる（数を絞る）
  if (!configured && !(await rateLimiter(c.get("adapters")).hit("amazon-pay-ipn:unconfigured", IPN_UNCONFIGURED_PER_MINUTE, 60))) return c.json({ error: "too_many_requests" }, 429);
  const verified = await verifySnsMessage(envelope, { fetch: c.get("deps").fetch, cache });
  if (!verified.ok) return c.json({ error: "invalid_signature" }, 403);
  if (!configured) {
    logTopicNotAllowed(topic.arn);
    return c.json({ error: "topic_not_allowed" }, 403);
  }
  if (!from && !(await rateLimiter(c.get("adapters")).hit("amazon-pay-ipn:*", IPN_PER_MINUTE_ALL, 60))) return c.json({ error: "too_many_requests" }, 429);
  if (verified.envelope["Type"] !== "Notification") return c.json({ received: true, ignored: String(verified.envelope["Type"]) });
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(String(verified.envelope["Message"])) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_payload" }, 400);
  }
  if (!message || typeof message !== "object") return c.json({ error: "invalid_payload" }, 400);
  // このデプロイの加盟店の通知だけ（MerchantID が無い・違うものは何もしない）
  const merchant = message["MerchantID"] ?? message["merchantID"];
  if (merchant !== client.merchantId) return c.json({ received: true, ignored: "merchant" });
  if (message["ObjectType"] !== "CHARGE") return c.json({ received: true, ignored: String(message["ObjectType"] ?? "") });
  const chargeId = message["ObjectId"];
  if (typeof chargeId !== "string" || !CHARGE_ID_RE.test(chargeId)) return c.json({ error: "invalid_payload" }, 400);

  // 済んだ Charge の通知（再送・戻りで確定済み）は、Amazon Pay の API を呼ぶ前に終える
  const db = createPrivilegedDb({ url, serviceRoleKey, fetch: c.get("deps").fetch });
  if ((await db.webhookEventSeen(AMAZON_PAY_PROVIDER, chargeId))) return c.json({ received: true, duplicate: true });
  // 少し前に Amazon Pay に無かった Charge は、もう一度 API を呼ばない（受け取っていないと答えて、Amazon に後で再送させる）
  const unknownKey = `amazon-pay-ipn:unknown:${chargeId}`;
  if (cache && (await cache.get<boolean>(unknownKey))) return c.json({ error: "charge_not_found" }, 503);

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
    // 無い Charge: 許したトピックから届いた通知なので、Amazon Pay の側でまだ見えないだけかもしれない。受け取らずに 503 で
    // 再送させ（Amazon Pay は 1 時間ごとに最大 3 時間まで再送する）、続けて API を呼ばないよう 10 分覚える
    if (e instanceof AmazonPayError && e.status === 404) {
      if (cache) await cache.set(unknownKey, true, UNKNOWN_CHARGE_TTL);
      return c.json({ error: "charge_not_found" }, 503);
    }
    throw e;
  }
  // 形だけ確かめる（予約がそのショップのものかは DB の confirm_reservation が確かめる）
  const idLike = /^[0-9A-Za-z-]{1,64}$/;
  if (!reservationId || !shopId || !idLike.test(reservationId) || !idLike.test(shopId)) return c.json({ received: true, ignored: "no_reservation" });

  let r: Awaited<ReturnType<typeof confirmAmazonPayCharge>>;
  try {
    r = await confirmAmazonPayCharge({ db, client, chargeId, reservationId, shopId, charge });
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
