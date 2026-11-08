/**
 * Amazon Pay の流れ（中継ページ・戻り・IPN で共通）。クライアントは src/plugins/amazon_pay.ts。
 *
 * 確定の決まり（メンテナの決定 2026-11-08、docs/knowledge/02-decisions.md）:
 *   Amazon Pay は「戻ってきたときにサーバーから CompleteCheckoutSession を呼ぶ」作りなので、戻りで確定してよい。ただし
 *   戻りの URL の値（amazonCheckoutSessionId）は合図にしか使わず、どの予約か・いくらかは Banto の券（署名）、
 *   支払ったかは Amazon Pay の API の答え（Checkout Session と Charge を引き直す）で決める。IPN は取りこぼしの保険（同じ関数を通る）。
 *   冪等の鍵は Charge ID（戻りと IPN のどちらが先でも 1 回だけ確定・返金する）。
 */
import { openJson, sealJson } from "../util/signed";
import { confirmFromWebhook, type WebhookConfirmResult } from "./webhook-confirm";
import type { PrivilegedDb } from "../db/privileged";
import { AmazonPayError, parseJpy, type AmazonPayCharge, type AmazonPayClient, type AmazonPayCheckoutSession } from "../plugins/amazon_pay";

export const AMAZON_PAY_PROVIDER = "amazon_pay";
/** 券の期限（Checkout Session は開いてから 24 時間で取り消される。それより長くは要らない） */
export const AMAZON_PAY_TICKET_SECONDS = 24 * 60 * 60;
/** Amazon Pay の戻りの URL は 1024 文字まで */
export const AMAZON_PAY_URL_MAX = 1024;

/** 中継ページ・戻り・取り消しの券: どの予約を・いくらで・どこへ戻すか（ショップごとに署名） */
export interface AmazonPayTicket {
  shopId: string;
  reservationId: string;
  amountJpy: number;
  successUrl: string;
  cancelUrl: string;
  expiresAt: number;
}

export async function sealAmazonPayTicket(secret: string, t: Omit<AmazonPayTicket, "expiresAt">, now = Date.now()): Promise<string> {
  return sealJson(secret, { k: "apay", s: t.shopId, r: t.reservationId, a: t.amountJpy, ok: t.successUrl, ng: t.cancelUrl, e: Math.floor(now / 1000) + AMAZON_PAY_TICKET_SECONDS });
}

export async function openAmazonPayTicket(secret: string, token: string | undefined, shopId: string, now = Date.now()): Promise<AmazonPayTicket | null> {
  const raw = (await openJson(secret, token)) as Record<string, unknown> | null;
  if (!raw || raw["k"] !== "apay" || raw["s"] !== shopId) return null;
  const { r, a, ok, ng, e } = raw;
  if (typeof r !== "string" || typeof a !== "number" || !Number.isInteger(a) || a <= 0 || typeof ok !== "string" || typeof ng !== "string" || typeof e !== "number") return null;
  if (e < Math.floor(now / 1000)) return null;
  return { shopId, reservationId: r, amountJpy: a, successUrl: ok, cancelUrl: ng, expiresAt: e };
}

/** 中継ページの支払いボタンに渡す Checkout Session の中身（checkoutMode: ProcessOrder = Amazon の画面で支払いまで済ませて戻る） */
export function buttonPayload(p: { storeId: string; ticket: AmazonPayTicket; returnUrl: string; cancelUrl: string; storeName: string }): string {
  return JSON.stringify({
    webCheckoutDetails: { checkoutResultReturnUrl: p.returnUrl, checkoutCancelUrl: p.cancelUrl, checkoutMode: "ProcessOrder" },
    storeId: p.storeId,
    chargePermissionType: "OneTime",
    paymentDetails: { paymentIntent: "AuthorizeWithCapture", chargeAmount: { amount: String(p.ticket.amountJpy), currencyCode: "JPY" }, presentmentCurrency: "JPY" },
    // どの予約か（IPN で Charge Permission から引く）。購入者の情報は載せない
    merchantMetadata: { merchantReferenceId: p.ticket.reservationId, merchantStoreName: [...p.storeName].slice(0, 50).join(""), customInformation: p.ticket.shopId },
  });
}

export type ChargeOutcome =
  | { kind: "confirmed"; result: WebhookConfirmResult }
  | { kind: "duplicate" }
  /** 承認・売上の確定を待っている（Amazon Pay から IPN が来たら確定する） */
  | { kind: "pending" }
  /** 断られた・取り消された（お金は動いていない） */
  | { kind: "failed"; state: string };

/**
 * Charge を Amazon Pay から引き直し、売上が確定（Captured）していれば予約を確定する。確定できなければ返金する（webhook-confirm.ts）。
 * 金額は Amazon Pay が売り上げた額をそのまま渡す（予約の合計と違えば DB が amount_mismatch で断り、返金になる）
 */
export async function confirmAmazonPayCharge(a: { db: PrivilegedDb; client: AmazonPayClient; chargeId: string; reservationId: string; shopId: string; guard: boolean; charge?: AmazonPayCharge }): Promise<ChargeOutcome> {
  // 引いたばかりの Charge があればそれを使う（IPN）。無ければ引く
  const charge = a.charge?.chargeId === a.chargeId ? a.charge : await a.client.getCharge(a.chargeId);
  const state = charge.statusDetails?.state ?? "";
  if (state === "Declined" || state === "Canceled") return { kind: "failed", state };
  if (state !== "Captured") return { kind: "pending" };
  if (a.guard && (await a.db.webhookEventSeen(AMAZON_PAY_PROVIDER, a.chargeId))) return { kind: "duplicate" };
  const captured = parseJpy(charge.captureAmount) ?? parseJpy(charge.chargeAmount);
  const refund = async (): Promise<boolean> => {
    // 返金できなければ例外 → 呼び出し側が 500 / やり直しの画面にする（決済済み・注文なし・返金なしで静かに終わらせない）
    if (captured === null || captured <= 0) throw new Error(`amazon pay ${a.chargeId}: cannot refund (unknown captured amount)`);
    await a.client.createRefund(a.chargeId, captured, `refund-${a.chargeId}`);
    return true;
  };
  const result = await confirmFromWebhook({
    db: a.db,
    provider: AMAZON_PAY_PROVIDER,
    eventId: a.chargeId,
    reservationId: a.reservationId,
    shopId: a.shopId,
    order: {
      customer_email: null,
      payment_provider: AMAZON_PAY_PROVIDER,
      payment_ref: a.chargeId,
      amount_paid_jpy: captured,
      currency: String(charge.captureAmount?.currencyCode ?? charge.chargeAmount?.currencyCode ?? ""),
      payment_account: AMAZON_PAY_PROVIDER,
    },
    refund,
    guard: a.guard,
  });
  return { kind: "confirmed", result };
}

export type ReturnOutcome =
  /** 確定した・確定を待っている → 完了画面（券の successUrl） */
  | { kind: "success" }
  /** 支払われなかった（予約は戻した）→ カート（券の cancelUrl） */
  | { kind: "cancelled" }
  /** 券と Checkout Session が合わない（別の予約・金額）。何もしない */
  | { kind: "mismatch" }
  /** Amazon Pay か DB が一時的に答えない。同じ URL を開き直せばやり直せる */
  | { kind: "retry" };

/** 戻り: Checkout Session を引き直して券と照らし、開いていれば Complete、Charge が売上確定なら予約を確定する */
export async function handleAmazonPayReturn(a: { db: PrivilegedDb; client: AmazonPayClient; ticket: AmazonPayTicket; checkoutSessionId: string; guard: boolean }): Promise<ReturnOutcome> {
  const t = a.ticket;
  let session: AmazonPayCheckoutSession;
  try {
    session = await a.client.getCheckoutSession(a.checkoutSessionId);
  } catch (e) {
    if (e instanceof AmazonPayError && e.status === 404) return { kind: "mismatch" };
    console.error("[banto] amazon pay return: get checkout session failed:", e instanceof Error ? e.message : e);
    return { kind: "retry" };
  }
  if (session.merchantMetadata?.merchantReferenceId !== t.reservationId || parseJpy(session.paymentDetails?.chargeAmount) !== t.amountJpy) return { kind: "mismatch" };

  let state = session.statusDetails?.state ?? "";
  let chargeId = session.chargeId ?? null;
  if (state === "Open") {
    try {
      const done = await a.client.completeCheckoutSession(a.checkoutSessionId, t.amountJpy);
      state = done.statusDetails?.state ?? "Completed";
      chargeId = done.chargeId ?? chargeId;
    } catch (e) {
      // 断られた（CheckoutSessionCanceled・HardDeclined など）か、すでに完了・取り消し済み。どちらかは引き直して決める
      if (!(e instanceof AmazonPayError) || e.status >= 500) {
        console.error("[banto] amazon pay return: complete failed:", e instanceof Error ? e.message : e);
        return { kind: "retry" };
      }
      try {
        const again = await a.client.getCheckoutSession(a.checkoutSessionId);
        state = again.statusDetails?.state ?? "";
        chargeId = again.chargeId ?? chargeId;
      } catch {
        return { kind: "retry" };
      }
      if (state === "Open") {
        console.error(`[banto] amazon pay return: complete refused (${e.status} ${e.reasonCode ?? ""}) for reservation ${t.reservationId}`);
        await a.db.releaseReservation(t.reservationId, t.shopId).catch(() => false);
        return { kind: "cancelled" };
      }
    }
  }
  if (state === "Canceled") {
    await a.db.releaseReservation(t.reservationId, t.shopId).catch(() => false);
    return { kind: "cancelled" };
  }
  if (state !== "Completed" || !chargeId) return { kind: "retry" };

  try {
    const r = await confirmAmazonPayCharge({ db: a.db, client: a.client, chargeId, reservationId: t.reservationId, shopId: t.shopId, guard: a.guard });
    if (r.kind === "failed") {
      await a.db.releaseReservation(t.reservationId, t.shopId).catch(() => false);
      return { kind: "cancelled" };
    }
    // 確定・返金して済み・確定待ちはどれも完了画面へ（返金したときは完了画面の照会が「確定しなかった」を出す）
    return { kind: "success" };
  } catch (e) {
    console.error("[banto] amazon pay return: confirm failed:", e instanceof Error ? e.message : e);
    return { kind: "retry" };
  }
}

/**
 * 中継ページのスクリプト（Banto のオリジンから配る。値は同じページの JSON の欄から読む）。
 * Amazon の checkout.js の後に読む。ボタンを押すと Amazon Pay の画面へ移る
 */
export const AMAZON_PAY_RELAY_SCRIPT = `(function(){var el=document.getElementById("banto-amazon-pay");if(!el||!window.amazon||!amazon.Pay)return;var c=JSON.parse(el.textContent||"{}");var o={merchantId:c.merchantId,publicKeyId:c.publicKeyId,ledgerCurrency:"JPY",checkoutLanguage:"ja_JP",productType:"PayOnly",placement:"Checkout",buttonColor:"Gold",createCheckoutSessionConfig:{payloadJSON:c.payload,signature:c.signature,algorithm:"AMZN-PAY-RSASSA-PSS-V2"}};if(c.sandbox)o.sandbox=true;amazon.Pay.renderButton("#banto-amazon-pay-button",o);var w=document.getElementById("banto-amazon-pay-wait");if(w)w.hidden=true;})();`;

/** 中継ページの CSP: スクリプトは Banto と Amazon Pay の部品だけ。ほかの読み込み（Amazon の画面の部品）は止めない。テーマは描かない */
export const AMAZON_PAY_RELAY_CSP = "script-src 'self' https://static-fe.payments-amazon.com https://*.payments-amazon.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
