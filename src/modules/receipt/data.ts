/**
 * 領収書のデータ（ヘッドレス、0066。docs/headless.md「注文照会・領収書」）。同梱モジュール receipt。
 * 体裁（レイアウト・宛名の欄・印刷）は連携サイトが決める。Banto は記載事項（適格簡易請求書の項目）と、税率ごとの内訳の計算結果だけを渡す。
 * 税の計算は src/commerce/tax.ts の orderTaxBreakdown だけ（同梱テーマの render.tsx と同じ）。
 */
import { orderTaxBreakdown, type TaxGroup } from "../../commerce/tax";
import { RECEIPT_STATUSES, receiptSettings, type ReceiptOrder } from "./render";

export interface ReceiptData {
  /** qualified_simplified_invoice = 適格簡易請求書（登録番号あり）、receipt = 領収書 */
  kind: "qualified_simplified_invoice" | "receipt";
  issuer: string;
  invoice_number: string | null;
  proviso: string;
  issued_at: string;
  number: number;
  order_date: string;
  items: { name: string; sku: string | null; qty: number; unit_price_jpy: number; line_total_jpy: number; reduced: boolean }[];
  shipping_jpy: number;
  discounts: { code: string; name: string; amount_jpy: number }[];
  total_jpy: number;
  tax: TaxGroup[];
}

/** 領収書を出せる注文か（支払い済み・発送済みだけ） */
export const receiptAvailable = (order: { status?: unknown }) => typeof order.status === "string" && RECEIPT_STATUSES.includes(order.status);

export function receiptData(shop: { name: string; settings?: Record<string, unknown> | null }, order: ReceiptOrder, issuedAt: Date): ReceiptData {
  const settings = receiptSettings(shop);
  const std = Number(order.shipping_tax_rate ?? NaN);
  // 軽減税率の対象（0 より大きく標準税率より低い税率）。render.tsx の ※ と同じ判定
  const reduced = (r: number | string | null | undefined) => r !== null && r !== undefined && r !== "" && Number(r) > 0 && Number.isFinite(std) && Number(r) < std;
  return {
    kind: settings.invoice_number ? "qualified_simplified_invoice" : "receipt",
    issuer: settings.issuer,
    invoice_number: settings.invoice_number,
    proviso: settings.proviso,
    issued_at: issuedAt.toISOString(),
    number: order.number,
    order_date: order.created_at,
    items: order.items.map((i) => ({ name: i.name, sku: i.sku ?? null, qty: i.qty, unit_price_jpy: i.unit_price_jpy, line_total_jpy: i.unit_price_jpy * i.qty, reduced: reduced(i.tax_rate) })),
    shipping_jpy: order.shipping_jpy ?? 0,
    discounts: order.discounts ?? [],
    total_jpy: order.total_jpy,
    tax: orderTaxBreakdown(order, shop.settings),
  };
}
