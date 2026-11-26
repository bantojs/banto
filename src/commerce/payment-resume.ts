/**
 * KOMOJU のお支払いに戻る（0180、メンテナの決定 2026-11-26、docs/plugins.md「KOMOJU のお支払いに戻る」）。
 *
 * KOMOJU の決済ページ（Session）から手続きをせずに戻ったお客様が、完了画面・会員ページ（とヘッドレス）からお支払いに戻る・取りやめる。
 * どの入口もここを通る（判定を 1 か所に）。予約に残すのは決済ページの ID と種類だけで、URL・状態は押されたときに KOMOJU の API で引き直す。
 *
 *   - 決済ページがまだ手続き前（pending）で期限内 → そのページへ戻す
 *   - 手続き済み（コンビニ・銀行振込のお支払い待ち = 支払いが authorized）→ 「案内のメールでお支払いください」
 *   - 期限切れ（決済ページは最長 24 時間、予約は既定 72 時間）・取り消し済み → 同じ予約・同じ金額・同じ種類で作り直し、
 *     予約の ID を前の値と同じときだけ入れ替える（二度押しで 2 つの決済ページを生かさない。負けたら作ったほうを取り消す）
 *   - 取りやめる → KOMOJU の支払い（お支払い待ち）か決済ページを先に取り消し、取り消せたときだけ在庫を戻す（後から払えないように）
 *
 * 金額は予約から DB が計算する（banto_reservation_total、confirm_reservation が比べる額と同じ式）。決済ページの metadata の予約が
 * 違えば使わない（予約に入れた ID を信じすぎない）。
 */
import type { KomojuClient, KomojuSession } from "../plugins/komoju";
import { KomojuError } from "../plugins/komoju";
import type { PrivilegedDb, ReservationPayment } from "../db/privileged";
import { openJson, sealJson } from "../util/signed";
import { getTimeZone } from "../i18n/time";
import { getLocale } from "../i18n";

export type ResumeOutcome =
  /** 決済ページへ */
  | { kind: "redirect"; url: string }
  /** 手続き済み（お支払い待ち）。KOMOJU のメールの案内で払ってもらう */
  | { kind: "awaiting" }
  /** 支払いは済んでいて、確定（Webhook）を待っている */
  | { kind: "paid" }
  | { kind: "confirmed" }
  | { kind: "released" }
  /** 戻れない（決済ページが無い・予約の期限切れ・KOMOJU が使えない） */
  | { kind: "unavailable" };

export interface ResumeDeps {
  privileged: PrivilegedDb;
  komoju: KomojuClient | null;
  now?: number;
}

const DONE = new Set(["completed", "complete"]);
/** 支払いが付いていて、まだ取り消せる（お支払い待ち） */
const AWAITING = new Set(["pending", "authorized"]);

function sessionUsable(sess: KomojuSession, r: ReservationPayment): boolean {
  const rid = sess.metadata?.["reservation_id"];
  return !rid || rid === r.reservation_id;
}

function base(r: ReservationPayment, now: number): ResumeOutcome | null {
  if (r.status === "confirmed") return { kind: "confirmed" };
  if (r.status !== "pending") return { kind: "released" };
  if (!r.payment_session || Date.parse(r.expires_at) <= now) return { kind: "unavailable" };
  return null;
}

/** 手続き済みの決済ページ（支払いの状態で分ける） */
function afterSubmit(sess: KomojuSession): ResumeOutcome {
  const st = sess.payment?.status ?? "";
  return st === "captured" ? { kind: "paid" } : { kind: "awaiting" };
}

/** 作り直す決済ページに残す最短の時間（これより予約の残りが短ければ作り直さない） */
const MIN_FRESH_SECONDS = 10 * 60;

/**
 * お支払いに戻る。returnUrl は作り直すときの戻り先（完了画面。照会トークンは呼び出し側が新しく付ける）
 */
export async function resumePayment(deps: ResumeDeps, shopId: string, r: ReservationPayment, returnUrl: string, attempt = 0): Promise<ResumeOutcome> {
  const now = deps.now ?? Date.now();
  const early = base(r, now);
  if (early) return early;
  if (!deps.komoju) return { kind: "unavailable" };
  const ref = r.payment_session!;
  const sess = await deps.komoju.getSession(ref.id);
  if (!sessionUsable(sess, r)) return { kind: "unavailable" };
  if (sess.payment?.status === "captured") return { kind: "paid" };
  if (DONE.has(sess.status)) return afterSubmit(sess);
  // 手続き前（失敗した支払いが付いていても、決済ページが pending なら払い直せる）
  if (sess.status === "pending" && sess.expired !== true && sess.session_url) return { kind: "redirect", url: sess.session_url };
  // 期限切れ・取り消し済み: 同じ予約・同じ金額・同じ種類で作り直す。予約の残りより長く払えるページは作らない
  const left = Math.floor((Date.parse(r.expires_at) - now) / 1000);
  if (r.total_jpy <= 0 || left < MIN_FRESH_SECONDS) return { kind: "unavailable" };
  const fresh = await deps.komoju.createSession({
    amountJpy: r.total_jpy,
    returnUrl,
    reservationId: r.reservation_id,
    shopId,
    ...(ref.types && ref.types.length > 0 ? { paymentTypes: ref.types } : {}),
    expiresInSeconds: left,
  });
  const won = await deps.privileged.reservationSetPaymentSession(r.reservation_id, shopId, { provider: "komoju", id: fresh.id, ...(ref.types ? { types: ref.types } : {}) }, ref.id);
  if (won) return { kind: "redirect", url: fresh.session_url };
  // ほかの押下が先に入れ替えた（か予約が確定・解放された）。作ったほうを取り消し、今の予約で 1 回だけやり直す
  await deps.komoju.cancelSession(fresh.id).catch(() => undefined);
  if (attempt > 0) return { kind: "unavailable" };
  const again = await deps.privileged.reservationPaymentGet(shopId, { quoteId: r.quote_id ?? "" }).catch(() => null);
  return again && again.reservation_id === r.reservation_id ? resumePayment(deps, shopId, again, returnUrl, attempt + 1) : { kind: "unavailable" };
}

export type AbandonOutcome = "released" | "confirmed" | "paid" | "failed";

/**
 * 取りやめる。KOMOJU 側を先に取り消し（後から払えないように）、取り消せたときだけ在庫を戻す。
 * 支払いが済んでいた（captured・取り消せない）なら戻さない（確定は Webhook）
 */
export async function abandonPayment(deps: ResumeDeps, shopId: string, r: ReservationPayment): Promise<AbandonOutcome> {
  if (r.status === "confirmed") return "confirmed";
  if (r.status !== "pending") return "released";
  if (r.payment_session) {
    if (!deps.komoju) return "failed";
    try {
      const sess = await deps.komoju.getSession(r.payment_session.id);
      if (!sessionUsable(sess, r)) return "failed";
      if (sess.payment?.status === "captured") return "paid";
      // お支払い待ちの支払い（コンビニ・銀行振込の番号が出ている）を取り消し、手続き前の決済ページも取り消す
      // （失敗した支払いが付いた pending の決済ページは払い直せるので、支払いの有無にかかわらず取り消す）
      if (sess.payment && AWAITING.has(sess.payment.status)) await deps.komoju.cancelPayment(sess.payment.id);
      if (sess.status === "pending" && sess.expired !== true) await deps.komoju.cancelSession(sess.id);
    } catch (e) {
      // 取り消せない（422 = 手続き・支払いが進んだ）なら戻さない。ほかの失敗も戻さない（払えるまま在庫だけ戻さない）
      if (e instanceof KomojuError && e.status === 422) return "paid";
      console.error("[banto] abandon payment:", e instanceof Error ? e.message : e);
      return "failed";
    }
  }
  await deps.privileged.releaseReservation(r.reservation_id, shopId);
  return "released";
}

/**
 * お支払いのお願い（0181）のリンクの券: どの予約か（ショップごとに署名、期限は予約の期限）。
 * 秘密の中身は無い（開いた先は「お支払いに進む・取りやめる」だけ、お金は動かない）。照会トークン（24 時間）より長く使える
 */
const resumeSecret = (secret: string, shopId: string) => `${secret}|payment-resume|${shopId}`;

export function sealResumeToken(secret: string, shopId: string, reservationId: string, expiresAt: string): Promise<string> {
  return sealJson(resumeSecret(secret, shopId), { t: "resume", r: reservationId, exp: Math.floor(Date.parse(expiresAt) / 1000) });
}

export async function openResumeToken(secret: string, shopId: string, raw: string | undefined, now = Date.now()): Promise<{ reservationId: string } | null> {
  if (!raw || raw.length > 512) return null;
  const v = (await openJson(resumeSecret(secret, shopId), raw)) as { t?: unknown; r?: unknown; exp?: unknown } | null;
  if (!v || v.t !== "resume" || typeof v.r !== "string" || typeof v.exp !== "number" || v.exp * 1000 < now) return null;
  return { reservationId: v.r };
}

/** お支払いの期限の文（お支払いのお願い、0181。運営者の時間帯で「11月28日（金）15:00」） */
export function payUntilLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const en = getLocale() === "en";
  const parts = new Intl.DateTimeFormat(en ? "en-US" : "ja-JP", { timeZone: getTimeZone(), month: en ? "short" : "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return en ? `${get("month")} ${get("day")} (${get("weekday")}) ${get("hour")}:${get("minute")}` : `${get("month")}月${get("day")}日（${get("weekday")}）${get("hour")}:${get("minute")}`;
}

/** お支払いのお願いのリンク（0181）: ショップの画面の /checkout/resume に予約の券 */
export function paymentLinkUrl(shopHomeUrl: string, token: string): string {
  return `${shopHomeUrl}/checkout/resume?t=${encodeURIComponent(token)}`;
}
