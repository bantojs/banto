/**
 * 領収書（適格簡易請求書）。同梱モジュール receipt（docs/tax.md）。ブラウザで印刷・PDF 保存する 1 枚の HTML。
 * 載せるもの（インボイス制度の適格簡易請求書の記載事項）: 発行事業者の名称と登録番号、取引年月日、取引の内容（軽減税率の対象には ※）、
 * 税率ごとに区分した対価の額（税込）と消費税額。登録番号が無ければ「領収書」として出す（適格簡易請求書とは書かない）。
 * 税の計算は src/commerce/tax.ts の orderTaxBreakdown だけ。データ取得はしない。
 */
import { raw } from "hono/html";
import { t, tf } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { orderTaxBreakdown } from "../../commerce/tax";
import { yen } from "../../routes/common";

export interface ReceiptOrder {
  number: number;
  status: string;
  created_at: string;
  total_jpy: number;
  shipping_jpy?: number | null;
  discount_jpy?: number | null;
  shipping_tax_rate?: number | string | null;
  tax_rounding?: string | null;
  discounts?: { code: string; name: string; amount_jpy: number }[];
  items: { name: string; sku?: string | null; qty: number; unit_price_jpy: number; tax_rate?: number | string | null; discount_jpy?: number | null }[];
}

export interface ReceiptSettings {
  issuer: string;
  invoice_number: string | null;
  proviso: string;
}

export const RECEIPT_MODULE = "receipt";

/** 領収書を出せる注文（支払い済み）。キャンセル・返金済みには出さない */
export const RECEIPT_STATUSES = ["paid", "shipped"];

export const INVOICE_NUMBER_RE = /^T[0-9]{13}$/;

export function receiptSettings(shop: { name: string; settings?: Record<string, unknown> | null }): ReceiptSettings {
  const r = (shop.settings ?? {})["receipt"];
  const o = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const num = str(o["invoice_number"]);
  return { issuer: str(o["issuer"]) || shop.name, invoice_number: INVOICE_NUMBER_RE.test(num) ? num : null, proviso: str(o["proviso"]) || t("receipt.proviso_default") };
}

const css = `body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic",Meiryo,sans-serif;color:#111;margin:0;background:#f4f5f7}
.sheet{max-width:720px;margin:24px auto;background:#fff;padding:40px 48px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
h1{text-align:center;letter-spacing:.4em;margin:0 0 4px;font-size:28px}.sub{text-align:center;color:#555;margin:0 0 24px;font-size:13px}
.to{font-size:20px;border-bottom:1px solid #111;padding-bottom:4px;margin:16px 0}.amount{font-size:26px;font-weight:bold;border:2px solid #111;padding:8px 16px;display:inline-block;margin:8px 0}
table{width:100%;border-collapse:collapse;margin:16px 0;font-size:14px}th,td{border-bottom:1px solid #ddd;padding:6px 4px;text-align:left}td.n,th.n{text-align:right}
.meta{display:flex;justify-content:space-between;gap:16px;font-size:14px}.issuer{text-align:right;font-size:14px;margin-top:24px}.muted{color:#666;font-size:12px}
.tools{max-width:720px;margin:16px auto;padding:0 8px}.tools form{display:inline}
@media print{body{background:#fff}.sheet{box-shadow:none;margin:0;padding:0}.tools{display:none}}`;

export function renderReceipt(p: { shopName: string; settings: ReceiptSettings; shopSettings: Record<string, unknown> | null | undefined; order: ReceiptOrder; addressee: string; issuedAt: Date; nameForm: { action: string; method: "get" | "post"; hidden: Record<string, string> } }): string {
  const { order, settings } = p;
  const tax = orderTaxBreakdown({ ...order, items: order.items }, p.shopSettings);
  const std = Number(order.shipping_tax_rate ?? NaN);
  const isReduced = (r: number | string | null | undefined) => r !== null && r !== undefined && r !== "" && Number(r) > 0 && Number.isFinite(std) && Number(r) < std;
  const anyReduced = order.items.some((i) => isReduced(i.tax_rate));
  const title = settings.invoice_number ? t("receipt.title_invoice") : t("receipt.title");
  const html = (
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{`${t("receipt.title")} #${order.number} · ${p.shopName}`}</title>
        <style>{raw(css)}</style>
      </head>
      <body>
        <div class="tools">
          <form method={p.nameForm.method} action={p.nameForm.action}>
            {Object.entries(p.nameForm.hidden).map(([k, v]) => (
              <input type="hidden" name={k} value={v} />
            ))}
            <label>
              {t("receipt.addressee_label")} <input type="text" name="name" value={p.addressee} maxlength={100} />
            </label>{" "}
            <button type="submit">{t("receipt.update")}</button>
          </form>{" "}
          <button type="button" onclick="window.print()">
            {t("receipt.print")}
          </button>
        </div>
        <div class="sheet">
          <h1>{t("receipt.title")}</h1>
          <p class="sub">{title}</p>
          <div class="meta">
            <div class="to">{tf("receipt.to", { name: p.addressee || "　　　　　　　　" })}</div>
            <div>
              <div>{tf("receipt.issued", { date: formatDateTime(p.issuedAt.toISOString(), { dateOnly: true }) })}</div>
              <div>{tf("receipt.order_number", { number: order.number })}</div>
              <div>{tf("receipt.order_date", { date: formatDateTime(order.created_at, { dateOnly: true }) })}</div>
            </div>
          </div>
          <div class="amount">{tf("receipt.amount", { amount: yen(order.total_jpy) })}</div>
          <p>{tf("receipt.proviso", { proviso: settings.proviso })}</p>
          <table>
            <thead>
              <tr>
                <th>{t("receipt.item")}</th>
                <th class="n">{t("receipt.unit_price")}</th>
                <th class="n">{t("receipt.qty")}</th>
                <th class="n">{t("receipt.line_total")}</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((i) => (
                <tr>
                  <td>
                    {i.name}
                    {i.sku ? ` / ${i.sku}` : ""}
                    {isReduced(i.tax_rate) ? ` ${t("tax.reduced_mark")}` : ""}
                  </td>
                  <td class="n">{yen(i.unit_price_jpy)}</td>
                  <td class="n">{i.qty}</td>
                  <td class="n">{yen(i.unit_price_jpy * i.qty)}</td>
                </tr>
              ))}
              {order.shipping_jpy ? (
                <tr>
                  <td colspan={3}>{t("receipt.shipping")}</td>
                  <td class="n">{yen(order.shipping_jpy)}</td>
                </tr>
              ) : null}
              {(order.discounts ?? []).map((d) => (
                <tr>
                  <td colspan={3}>{tf("receipt.discount", { code: d.code })}</td>
                  <td class="n">−{yen(d.amount_jpy)}</td>
                </tr>
              ))}
              <tr>
                <th colspan={3}>{t("receipt.total")}</th>
                <th class="n">{yen(order.total_jpy)}</th>
              </tr>
            </tbody>
          </table>
          <table>
            <thead>
              <tr>
                <th>{t("receipt.tax_rate")}</th>
                <th class="n">{t("receipt.tax_amount_base")}</th>
                <th class="n">{t("receipt.tax_amount")}</th>
              </tr>
            </thead>
            <tbody>
              {tax.map((g) => (
                <tr>
                  <td>{g.rate > 0 ? tf("receipt.rate", { rate: g.rate }) : t("tax.class_exempt")}</td>
                  <td class="n">{yen(g.amount_jpy)}</td>
                  <td class="n">{g.rate > 0 ? yen(g.tax_jpy) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {anyReduced ? <p class="muted">{t("tax.reduced_legend")}</p> : null}
          <div class="issuer">
            <div>{settings.issuer}</div>
            {settings.invoice_number ? <div>{tf("receipt.invoice_number", { number: settings.invoice_number })}</div> : null}
          </div>
        </div>
      </body>
    </html>
  );
  return `<!doctype html>${html}`;
}
