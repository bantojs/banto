/**
 * お支払いの状態（0156、メンテナの決定 2026-11-18、docs/hooks.md「注文の状態」）。
 * orders.status は届けの状態（pending = 受付・未発送 → shipped）、orders.payment_status（paid / unpaid）がお支払いの状態。
 * 今までの注文はすべて paid。未入金の注文（代金引換など）は発送の後に入金されることもある。判定の正は DB（cancel_order・order_payment_record）
 */

export const PAYMENT_STATUS_MIGRATION = "0156_order_payment_status";

export interface OrderPaymentState {
  status: string;
  payment_status?: string | null;
}

/** 未入金か（0156 より前の DB の行には列が無いので、入金済みとみなす） */
export const unpaid = (o: OrderPaymentState): boolean => o.payment_status === "unpaid";

/** 発送にできるか（受付のまま。お支払い済み（paid）か未入金の受付（pending）） */
export const shippable = (o: OrderPaymentState): boolean => o.status === "paid" || o.status === "pending";

/** 取り消せるか（受付のあいだと、未入金で発送した後 = 受け取り拒否） */
export const cancellable = (o: OrderPaymentState): boolean => shippable(o) || (o.status === "shipped" && unpaid(o));

/** 入金を記録できるか（未入金の受付・発送の後） */
export const payable = (o: OrderPaymentState): boolean => unpaid(o) && (o.status === "pending" || o.status === "shipped");

/** 売上・領収書の対象か（お支払い済みで、取り消していない） */
export const paidAndActive = (o: OrderPaymentState): boolean => (o.status === "paid" || o.status === "shipped") && !unpaid(o);
