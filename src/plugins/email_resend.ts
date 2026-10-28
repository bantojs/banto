/**
 * メール通知: 注文確認・発送通知を購入者に送り、任意で運営者にも控えを送る。
 * 送り手はデプロイ全体の設定 MAIL_TRANSPORT（Resend / SMTP / SendGrid / Amazon SES。src/mail/send.ts、docs/email.md）。
 * id は歴史的に email_resend（hook_endpoints の URL に入っているので変えない）。送信元は認証済みのドメインのアドレス。
 * 購入者の連絡先は hooks のペイロードに載せない設計なので、order_contact RPC（service_role）で取りに行く。
 */
import type { BundledPlugin, PluginContext } from "./types";
import { createMailer, mailTransportMissing, type Mailer, sendMail } from "../mail/send";
import { shopHome } from "../storefront/urls";
import { orderTaxBreakdown } from "../commerce/tax";
import { trackingOf, trackingUrl } from "../orders/tracking";
import { orderLink } from "../orders/lookup";
import { buildTryonMails, type TryonContact } from "../modules/store-tryon/mail";

export { RESEND_API_URL } from "../mail/transports/resend";

interface Contact {
  order_id: string;
  number: number;
  status: string;
  created_at: string;
  total_jpy: number;
  shipping_jpy: number;
  /** 値引き（0010_coupons） */
  discount_jpy?: number;
  discounts?: { code: string; name: string; amount_jpy: number }[];
  payment_provider: string | null;
  customer_email: string | null;
  customer_name: string | null;
  shipping_address: Record<string, unknown> | null;
  /** 0017 の税率・端数の扱い（0022 から載る。無ければ標準税率として扱う） */
  shipping_tax_rate?: number | string | null;
  tax_rounding?: string | null;
  /** お問い合わせ番号（0022） */
  tracking?: { carrier: string; number: string } | null;
  /** 会員の注文か（0066） */
  member?: boolean;
  /** order_page_url・return_origins は 0066 から（注文照会のページを連携サイトに向けたとき） */
  shop: { name: string; slug: string; domain?: string | null; contact_email: string | null; return_policy: string | null; tax?: Record<string, unknown> | null; order_page_url?: string | null; return_origins?: string[] | null };
  items: { name: string | null; sku: string | null; qty: number; unit_price_jpy: number; tax_rate?: number | string | null; discount_jpy?: number | null }[];
}

const CARRIER_NAMES: Record<string, string> = { yamato: "ヤマト運輸", sagawa: "佐川急便", japanpost: "日本郵便" };

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

function addressLines(a: Record<string, unknown> | null): string {
  if (!a) return "";
  return ["postal_code", "state", "city", "line1", "line2", "name", "phone"]
    .map((k) => a[k])
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join("\n");
}

/**
 * 「ご注文の状況」のリンク（0066）。注文照会のページを連携サイトに向けていればそこへ、無ければ Banto の注文照会の画面へ。
 * どちらも ?banto_order=<番号>（会員の注文なら &banto_member=1）を付ける。秘密は載せない（会員はログイン、ゲストはメールアドレスで開く）
 */
function orderPageLink(c: Contact, publicBaseUrl: string | undefined): string | null {
  const page = c.shop.order_page_url;
  // 保存のときに確かめているが、許可リストから外れたサイトには向けない
  if (typeof page === "string" && page.startsWith("https://") && URL.canParse(page) && (c.shop.return_origins ?? []).includes(new URL(page).origin)) return orderLink(page, c.number, c.member === true);
  if (!publicBaseUrl && !c.shop.domain) return null;
  const banto = `${shopHome(publicBaseUrl ?? "", c.shop)}/orders/lookup`;
  return URL.canParse(banto) ? orderLink(banto, c.number, c.member === true) : banto;
}

export function buildOrderEmail(kind: "paid" | "shipped", c: Contact, publicBaseUrl: string | undefined): { subject: string; text: string } {
  const lines = c.items.map((i) => `・${i.name ?? ""}${i.sku ? ` / ${i.sku}` : ""} × ${i.qty}  ${yen(i.unit_price_jpy * i.qty)}`).join("\n");
  const discount = c.discount_jpy ?? 0;
  const subtotal = c.total_jpy - c.shipping_jpy + discount;
  const discountLines = discount > 0 ? `${(c.discounts ?? []).map((d) => `値引き（${d.code}）: -${yen(d.amount_jpy)}`).join("\n") || `値引き: -${yen(discount)}`}\n` : "";
  const lookup = orderPageLink(c, publicBaseUrl);
  const head = `${c.customer_name ?? "お客"} 様\n\n`;
  // 税率ごとの対象額と消費税額（計算は src/commerce/tax.ts だけ）
  const tax = orderTaxBreakdown(c, c.shop.tax ?? {})
    .map((g) => (g.rate > 0 ? `（${g.rate}%対象 ${yen(g.amount_jpy)}　内消費税 ${yen(g.tax_jpy)}）` : `（非課税・不課税 ${yen(g.amount_jpy)}）`))
    .join("\n");
  const tr = trackingOf(c.tracking);
  const trUrl = tr ? trackingUrl(tr.carrier, tr.number) : null;
  const tracking = tr ? `\nお問い合わせ番号: ${CARRIER_NAMES[tr.carrier] ?? ""}${CARRIER_NAMES[tr.carrier] ? " " : ""}${tr.number}\n${trUrl ? `配送状況: ${trUrl}\n` : ""}` : "";
  const detail = `注文番号: ${c.number}\n\n${lines}\n\n商品合計: ${yen(subtotal)}\n送料: ${yen(c.shipping_jpy)}\n${discountLines}合計（税込）: ${yen(c.total_jpy)}\n${tax ? `${tax}\n` : ""}\nお届け先:\n${addressLines(c.shipping_address)}\n`;
  const foot = `${lookup ? `\nご注文の状況はこちらで確認できます: ${lookup}\n` : ""}${c.shop.contact_email ? `\nお問い合わせ: ${c.shop.contact_email}\n` : ""}\n${c.shop.name}`;
  if (kind === "shipped") {
    return { subject: `【${c.shop.name}】商品を発送しました（注文番号 ${c.number}）`, text: `${head}ご注文の商品を発送しました。到着までしばらくお待ちください。\n${tracking}\n${detail}${foot}` };
  }
  return { subject: `【${c.shop.name}】ご注文ありがとうございます（注文番号 ${c.number}）`, text: `${head}ご注文を承りました。内容をご確認ください。\n\n${detail}${c.shop.return_policy ? `\n返品について:\n${c.shop.return_policy}\n` : ""}${foot}` };
}

export const emailResend: BundledPlugin = {
  id: "email_resend",
  manifest: {
    name: "メール通知",
    version: "1.1.0",
    description: "注文確認と発送通知のメールを購入者に送ります（送り手は Resend / SMTP / SendGrid / Amazon SES から MAIL_TRANSPORT で選びます）。運営者にも控えを送れます。お店で試着の受付・取り置きのお知らせ（お客様と店舗）も送ります。会員のログインのメールもこの送信元から送ります。",
    events: ["order.paid", "order.shipped", "tryon.requested", "tryon.updated"],
    settings: [
      { key: "from", label: "送信元（例: マイショップ <order@example.com>）", type: "text", required: true, description: "送り手で認証済みのドメインのアドレスにしてください" },
      { key: "bcc_owner", label: "運営者にも控えを送る（ショップ設定の連絡先メールアドレス宛）", type: "boolean" },
    ],
  },
  requiredSecrets: (config) => mailTransportMissing(config),
  secretFormats: { RESEND_API_KEY: { pattern: /^re_/, hint: "re_ で始まる API キー（Resend → API Keys）" }, SENDGRID_API_KEY: { pattern: /^SG\./, hint: "SG. で始まる API キー（SendGrid → Settings → API Keys）" } },
  async handle(ctx: PluginContext) {
    const { event, data } = ctx.envelope;
    if (event !== "order.paid" && event !== "order.shipped" && event !== "tryon.requested" && event !== "tryon.updated") return;
    const from = typeof ctx.settings["from"] === "string" ? ctx.settings["from"].trim() : "";
    if (!from) throw new Error("email_resend: 送信元が未設定");
    const mailer = createMailer({ config: ctx.config, socket: ctx.socket }, ctx.fetch);
    if (!mailer) throw new Error(`email_resend: メールの送り手の設定が足りません（${mailTransportMissing(ctx.config).join(", ") || "SMTP はこのランタイムで使えません"}）`);
    if (event.startsWith("tryon.")) return sendTryon(ctx, mailer, from);
    const orderId = String(data["order_id"] ?? "");
    const contact = (await ctx.privileged.orderContact(orderId, ctx.envelope.shop_id)) as unknown as Contact;
    if (!contact.customer_email) return; // 連絡先が無い（マスク済み等）注文には送らない
    const mail = buildOrderEmail(event === "order.paid" ? "paid" : "shipped", contact, ctx.config.get("PUBLIC_BASE_URL"));
    const bcc = ctx.settings["bcc_owner"] === true && contact.shop.contact_email ? [contact.shop.contact_email] : [];
    await sendMail(mailer, {
      from,
      to: contact.customer_email,
      ...(bcc.length ? { bcc } : {}),
      ...(contact.shop.contact_email ? { replyTo: contact.shop.contact_email } : {}),
      subject: mail.subject,
      text: mail.text,
      idempotencyKey: `banto-${ctx.envelope.id}`,
    });
  },
};

/** お店で試着（0025）: お客様と店舗へ。宛先ごとに Idempotency-Key を分ける */
async function sendTryon(ctx: PluginContext, mailer: Mailer, from: string): Promise<void> {
  const { event, data, shop_id, id } = ctx.envelope;
  const requestId = typeof data["request_id"] === "string" ? data["request_id"] : "";
  if (!requestId) return;
  if (event === "tryon.updated" && !["ready", "cancelled"].includes(String(data["status"]))) return;
  const contact = (await ctx.privileged.tryonContact(requestId, shop_id)) as unknown as TryonContact;
  const bcc = ctx.settings["bcc_owner"] === true && contact.shop.contact_email ? [contact.shop.contact_email] : [];
  for (const m of buildTryonMails(event, contact, ctx.config.get("PUBLIC_BASE_URL"))) {
    await sendMail(mailer, {
      from,
      to: m.to,
      ...(m.key === "customer" && bcc.length ? { bcc } : {}),
      ...(contact.shop.contact_email ? { replyTo: contact.shop.contact_email } : {}),
      subject: m.subject,
      text: m.text,
      idempotencyKey: `banto-${id}-${m.key}`,
    });
  }
}
