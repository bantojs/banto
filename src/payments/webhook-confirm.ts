/**
 * 決済の Webhook から注文を確定する流れ（Stripe・KOMOJU・Amazon Pay で共通。Amazon Pay は戻りと IPN の両方がここを通る）。
 *
 * - 処理に成功したイベントだけ record_webhook_event に記録し、失敗は例外（500）で決済事業者に再送させる
 * - 記録済みのイベント（webhook_event_seen、0128）は何もしない。再配信（Stripe の再送・KOMOJU は署名に時刻が無い）で、
 *   返金して済みにした決済が、在庫が戻った後に注文になることがないように
 * - 確定できないとき（解放後の在庫切れ・同じ quote で出し直した予約・クーポンの先着枠・支払額の不一致）は、
 *   返金すると決めたことを先に DB に残し（reservation_mark_refunded。その予約は二度と確定しない）、返金して記録する。
 *   返金の前に落ちて再送されたら、DB が reservation_refunded（detail = 決めたときのイベント）を返すので、同じイベントなら返金をやり直す
 *   （冪等キーはイベント ID）。別のイベントなら返金せず記録だけする
 */
import { PrivilegedRpcError, type OrderInput, type PrivilegedDb } from "../db/privileged";

export interface WebhookConfirmArgs {
  db: PrivilegedDb;
  provider: "stripe" | "komoju" | "amazon_pay";
  eventId: string;
  reservationId: string;
  shopId: string;
  order: OrderInput;
  /** 返金（冪等キーはイベント ID）。返金できなければ例外 → 500 で再送させる（決済済み・注文なし・返金なしで静かに終わらせない） */
  refund: () => Promise<boolean>;
  /**
   * イベントごとに別の支払いになる決済（Amazon Pay: 冪等の鍵が Charge ID）で、このイベントの支払いの参照。
   * Stripe・KOMOJU の「別のイベント」は同じ支払いの別の通知なので何もしないが、こちらは別のお金が動いているので、
   * 予約がほかの支払いで確定・返金済みならこの支払いを返金する（支払い済み・注文なし・返金なしにしない）
   */
  separatePaymentRef?: string;
  /**
   * 確定済みの予約に別の支払いが届いたときだけ返金する、この支払いの参照（KOMOJU、0180）。
   * 0180 から 1 つの予約に決済ページを作り直すことがあり、万一前のページでも払われたら 2 回目を返す。
   * 返金・解放の側の扱いは今までどおり（同じ支払いの別の通知で二重に返金しない）
   */
  confirmedPaymentRef?: string;
}

export type WebhookConfirmResult = { received: true; order_id?: string; refunded?: boolean; ignored?: string };

export async function confirmFromWebhook(a: WebhookConfirmArgs): Promise<WebhookConfirmResult> {
  const record = () => a.db.recordWebhookEvent(a.provider, a.eventId);
  try {
    const orderId = await a.db.confirmReservation(a.reservationId, a.shopId, a.order);
    const ownRef = a.separatePaymentRef ?? a.confirmedPaymentRef;
    if (ownRef) {
      // 確定済みの予約は同じ注文 id を返す。注文がほかの支払いで確定していたら、この支払いは 2 回目なので返す
      const paid = await a.db.reservationPayment(a.reservationId, a.shopId);
      if (paid.paymentRef && paid.paymentRef !== ownRef) {
        console.error(`[banto] ${a.provider} ${a.eventId}: reservation ${a.reservationId} is already paid by ${paid.paymentRef}; refunding this payment`);
        const refunded = await a.refund();
        await record();
        return { received: true, refunded, ignored: "paid_elsewhere" };
      }
    }
    await record();
    return { received: true, order_id: orderId };
  } catch (e) {
    if (!(e instanceof PrivilegedRpcError)) throw e;
    const mismatch = e.is("amount_mismatch");
    if (mismatch || e.is("insufficient_stock_after_release") || e.is("quote_superseded") || e.is("coupon_exhausted_after_release")) {
      // TTL 切れで在庫が他の人に渡った / 解放の後に同じ quote で出し直した予約が生きている / クーポンの先着枠が埋まった（0090）/
      // 支払額・通貨が Banto の計算と違う（0029）。どれも確定できないので返金して、イベントは済みにする
      if (mismatch) console.error(`[banto] ${a.provider} webhook ${a.eventId}: amount mismatch for reservation ${a.reservationId} (${e.details ?? ""})`);
      const marked = await a.db.reservationMarkRefunded(a.reservationId, a.shopId, a.provider, a.eventId);
      if (marked === "other_event") {
        // 別のイベントで返金すると決めた予約。同じ支払いの別の通知なら二重に返金しない。別の支払いならその支払いを返す
        console.error(`[banto] ${a.provider} webhook ${a.eventId}: reservation ${a.reservationId} is already refunded by another event`);
        const refunded = a.separatePaymentRef ? await a.refund() : undefined;
        await record();
        return { received: true, ...(refunded !== undefined ? { refunded } : {}), ignored: "reservation_refunded" };
      }
      const refunded = await a.refund();
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
      const refunded = a.separatePaymentRef ? await a.refund() : undefined;
      await record();
      return { received: true, ...(refunded !== undefined ? { refunded } : {}), ignored: "reservation_refunded" };
    }
    if (e.is("reservation_not_found")) {
      await record();
      return { received: true, ignored: "reservation_not_found" };
    }
    throw e; // 500 → 決済事業者が再送する
  }
}
