/**
 * 決済の Webhook から注文を確定する流れ（Stripe と KOMOJU で共通）。
 *
 * - 処理に成功したイベントだけ record_webhook_event に記録し、失敗は例外（500）で決済事業者に再送させる
 * - 記録済みのイベント（webhook_event_seen、0128）は何もしない。再配信（Stripe の再送・KOMOJU は署名に時刻が無い）で、
 *   返金して済みにした決済が、在庫が戻った後に注文になることがないように
 * - 確定できないとき（解放後の在庫切れ・同じ quote で出し直した予約・クーポンの先着枠・支払額の不一致）は、
 *   返金すると決めたことを先に DB に残し（reservation_mark_refunded。その予約は二度と確定しない）、返金して記録する。
 *   返金の前に落ちて再送されたら、DB が reservation_refunded（detail = 決めたときのイベント）を返すので、同じイベントなら返金をやり直す
 *   （冪等キーはイベント ID）。別のイベントなら返金せず記録だけする
 * - 0128 が当たるまで（guard = false）は今までどおり「成功したら記録」だけ
 */
import { PrivilegedRpcError, type OrderInput, type PrivilegedDb } from "../db/privileged";

export interface WebhookConfirmArgs {
  db: PrivilegedDb;
  provider: "stripe" | "komoju";
  eventId: string;
  reservationId: string;
  shopId: string;
  order: OrderInput;
  /** 返金（冪等キーはイベント ID）。返金できなければ例外 → 500 で再送させる（決済済み・注文なし・返金なしで静かに終わらせない） */
  refund: () => Promise<boolean>;
  /** 0128_webhook_replay が当たっているか */
  guard: boolean;
}

export type WebhookConfirmResult = { received: true; order_id?: string; refunded?: boolean; ignored?: string };

export async function confirmFromWebhook(a: WebhookConfirmArgs): Promise<WebhookConfirmResult> {
  const record = () => a.db.recordWebhookEvent(a.provider, a.eventId);
  try {
    const orderId = await a.db.confirmReservation(a.reservationId, a.shopId, a.order);
    await record();
    return { received: true, order_id: orderId };
  } catch (e) {
    if (!(e instanceof PrivilegedRpcError)) throw e;
    const mismatch = e.is("amount_mismatch");
    if (mismatch || e.is("insufficient_stock_after_release") || e.is("quote_superseded") || e.is("coupon_exhausted_after_release")) {
      // TTL 切れで在庫が他の人に渡った / 解放の後に同じ quote で出し直した予約が生きている / クーポンの先着枠が埋まった（0090）/
      // 支払額・通貨が Banto の計算と違う（0029）。どれも確定できないので返金して、イベントは済みにする
      if (mismatch) console.error(`[banto] ${a.provider} webhook ${a.eventId}: amount mismatch for reservation ${a.reservationId} (${e.details ?? ""})`);
      if (a.guard) {
        const marked = await a.db.reservationMarkRefunded(a.reservationId, a.shopId, a.provider, a.eventId);
        if (marked === "other_event") {
          // 別のイベントで返金すると決めた予約。二重に返金しない
          console.error(`[banto] ${a.provider} webhook ${a.eventId}: reservation ${a.reservationId} is already refunded by another event`);
          await record();
          return { received: true, ignored: "reservation_refunded" };
        }
      }
      const refunded = await a.refund();
      // 0128 の前の DB: 生きている予約の在庫を戻す（0128 からは reservation_mark_refunded が戻す）
      if (!a.guard && mismatch) await a.db.releaseReservation(a.reservationId, a.shopId).catch(() => false);
      await record();
      return mismatch ? { received: true, refunded, ignored: "amount_mismatch" } : { received: true, refunded };
    }
    if (e.is("reservation_refunded")) {
      // 返金すると決めた予約（0128）。同じイベントの再送（返金の前に落ちた）なら返金をやり直し、別のイベントなら何もしない
      if (e.details === `${a.provider}:${a.eventId}`) {
        const refunded = await a.refund();
        await record();
        return { received: true, refunded };
      }
      await record();
      return { received: true, ignored: "reservation_refunded" };
    }
    if (e.is("reservation_not_found")) {
      await record();
      return { received: true, ignored: "reservation_not_found" };
    }
    throw e; // 500 → 決済事業者が再送する
  }
}
