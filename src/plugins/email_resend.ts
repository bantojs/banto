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
import { buildTryonMails, tryonNoticeKind, type TryonContact } from "../modules/store-tryon/mail";
import { noticeMail, type NoticeTextRow } from "../notices/templates";

interface Contact {
  order_id: string;
  number: number;
  status: string;
  created_at: string;
  total_jpy: number;
  shipping_jpy: number;
  /** 手数料（代引き 0157・支払い方法 0170） */
  fee_jpy?: number;
  /** お支払いの状態（0156。0157 から載る） */
  payment_status?: string;
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

/** 注文のメールの差し込みの値（src/notices/templates.ts。かたまりは前後の改行なし） */
export function orderMailValues(kind: "paid" | "shipped", c: Contact, publicBaseUrl: string | undefined): Record<string, string> {
  const lines = c.items.map((i) => `・${i.name ?? ""}${i.sku ? ` / ${i.sku}` : ""} × ${i.qty}  ${yen(i.unit_price_jpy * i.qty)}`).join("\n");
  const discount = c.discount_jpy ?? 0;
  const fee = c.fee_jpy ?? 0;
  const subtotal = c.total_jpy - c.shipping_jpy - fee + discount;
  // 手数料: 代金引換は代引き手数料（0157）、KOMOJU の種類はお支払い手数料（0170）
  const feeLine = fee > 0 ? `${c.payment_provider === "cod" ? "代引き手数料" : "お支払い手数料"}: ${yen(fee)}\n` : "";
  // 代金引換（0157）: 支払いは配達のとき
  const codLine = c.payment_provider === "cod" ? `\nお支払い方法: 代金引換（商品のお届けのときに ${yen(c.total_jpy)} をお支払いください）\n` : "";
  const discountLines = discount > 0 ? `${(c.discounts ?? []).map((d) => `値引き（${d.code}）: -${yen(d.amount_jpy)}`).join("\n") || `値引き: -${yen(discount)}`}\n` : "";
  const lookup = orderPageLink(c, publicBaseUrl);
  // 税率ごとの対象額と消費税額（計算は src/commerce/tax.ts だけ）
  const tax = orderTaxBreakdown(c, c.shop.tax ?? {})
    .map((g) => (g.rate > 0 ? `（${g.rate}%対象 ${yen(g.amount_jpy)}　内消費税 ${yen(g.tax_jpy)}）` : `（非課税・不課税 ${yen(g.amount_jpy)}）`))
    .join("\n");
  const tr = kind === "shipped" ? trackingOf(c.tracking) : null;
  const trUrl = tr ? trackingUrl(tr.carrier, tr.number) : null;
  const carrier = tr ? (CARRIER_NAMES[tr.carrier] ?? "") : "";
  return {
    shop_name: c.shop.name,
    customer_name: c.customer_name ?? "お客",
    number: String(c.number),
    total: yen(c.total_jpy),
    order_details: `注文番号: ${c.number}\n\n${lines}\n\n商品合計: ${yen(subtotal)}\n送料: ${yen(c.shipping_jpy)}\n${feeLine}${discountLines}合計（税込）: ${yen(c.total_jpy)}\n${tax ? `${tax}\n` : ""}${codLine}\nお届け先:\n${addressLines(c.shipping_address)}`.replace(/\s+$/, ""),
    tracking: tr ? `お問い合わせ番号: ${carrier}${carrier ? " " : ""}${tr.number}${trUrl ? `\n配送状況: ${trUrl}` : ""}` : "",
    return_policy: c.shop.return_policy ? `返品について:\n${c.shop.return_policy}` : "",
    order_link: lookup ? `ご注文の状況はこちらで確認できます: ${lookup}` : "",
    contact: c.shop.contact_email ? `お問い合わせ: ${c.shop.contact_email}` : "",
  };
}

/** 注文のメール。ショップが直した文面（0154）があればそれ、無い・今の決まりに合わなければ既定の文面 */
export function buildOrderEmail(kind: "paid" | "shipped", c: Contact, publicBaseUrl: string | undefined, texts?: readonly NoticeTextRow[] | null): { subject: string; text: string } {
  return noticeMail(kind === "paid" ? "order_paid" : "order_shipped", texts, orderMailValues(kind, c, publicBaseUrl));
}

/** 「注文のメールを送らない（外部プラグインに任せる）」: 受付（代金引換の受付を含む）・入金・発送のメールと運営者への控え */
export function skipOrders(settings: Record<string, unknown>): boolean {
  return settings["skip_orders"] === true;
}

/** 「お店で試着のお客様あてのお知らせを送らない」: お客様あての受付・取り置き・取り消しの知らせ（と運営者への控え）だけ。店舗あては送る */
export function skipTryon(settings: Record<string, unknown>): boolean {
  return settings["skip_tryon"] === true;
}

export const emailResend: BundledPlugin = {
  id: "email_resend",
  manifest: {
    name: "メール通知",
    version: "1.3.0",
    description: "注文確認と発送通知のメールを購入者に送ります（送り手は Resend / SMTP / SendGrid / Amazon SES から MAIL_TRANSPORT で選びます）。運営者にも控えを送れます。お店で試着の受付・取り置きのお知らせ（お客様と店舗）も送ります。会員のログインのメールもこの送信元から送ります。",
    // order.created は代金引換などの未入金の注文の受付のメールだけ（0157）。入金済みの注文の受付は order.paid で送る
    events: ["order.created", "order.paid", "order.shipped", "tryon.requested", "tryon.updated"],
    settings: [
      { key: "from", label: "送信元（例: マイショップ <order@example.com>）", type: "text", required: true, description: "送り手で認証済みのドメインのアドレスにしてください" },
      { key: "bcc_owner", label: "運営者にも控えを送る（ショップ設定の連絡先メールアドレス宛）", type: "boolean", description: "注文のメールを送らない設定のときは、注文の控えも送りません（試着はお客様あてを送らない設定のとき、その控えも送りません）" },
      {
        key: "skip_orders",
        label: "注文のメールを送らない（外部プラグインに任せる。運営者への控えも止まります）",
        type: "boolean",
        description: "受付・入金・発送のメールと運営者への控えを送りません。注文の hooks（order.created・order.paid・order.shipped）は外部プラグインに今までどおり届きます。会員のログインなどのメールは、この送信元から送り続けます",
      },
      {
        key: "skip_tryon",
        label: "お店で試着のお客様あてのお知らせを送らない（店舗あては送ります）",
        type: "boolean",
        description: "お店で試着の受付・取り置き・取り消しのお客様あてのお知らせ（と運営者への控え）を送りません。店舗あてのお知らせは送ります（店舗のアドレスは外部プラグインに渡らないため）。hooks（tryon.requested・tryon.updated）は今までどおり届きます",
      },
    ],
  },
  requiredSecrets: (config) => mailTransportMissing(config),
  secretFormats: { RESEND_API_KEY: { pattern: /^re_/, hint: "re_ で始まる API キー（Resend → API Keys）" }, SENDGRID_API_KEY: { pattern: /^SG\./, hint: "SG. で始まる API キー（SendGrid → Settings → API Keys）" } },
  async handle(ctx: PluginContext) {
    const { event, data } = ctx.envelope;
    if (event !== "order.created" && event !== "order.paid" && event !== "order.shipped" && event !== "tryon.requested" && event !== "tryon.updated") return;
    // 注文の受付: 入金済みの注文は order.paid で送る。order.created で送るのは未入金の注文（代金引換、0157）だけ
    if (event === "order.created" && data["payment_status"] !== "unpaid") return;
    // 注文のメールを外部プラグインに任せる店は、ここでは送らない（hooks はほかの送信先に今までどおり届く）。
    // 試着はお客様あてだけを止め、店舗あては送る（店舗のアドレスは外部プラグインには渡らないため）。sendTryon で分ける。
    // 会員のログイン・招待などのメールの送信元（from、banto_member_mail_from）はこの設定と関係なく使う
    if (!event.startsWith("tryon.") && skipOrders(ctx.settings)) return;
    const from = typeof ctx.settings["from"] === "string" ? ctx.settings["from"].trim() : "";
    if (!from) throw new Error("email_resend: 送信元が未設定");
    const mailer = createMailer({ config: ctx.config, socket: ctx.socket }, ctx.fetch);
    if (!mailer) throw new Error(`email_resend: メールの送り手の設定が足りません（${mailTransportMissing(ctx.config).join(", ") || "SMTP はこのランタイムで使えません"}）`);
    if (event.startsWith("tryon.")) return sendTryon(ctx, mailer, from);
    // 未入金の注文の入金の記録（0156）で出た order.paid には、受付のメールを重ねて送らない（受付のメールは注文のときに送る）
    if (event === "order.paid" && data["recorded_payment"] === true) return;
    const orderId = String(data["order_id"] ?? "");
    const contact = (await ctx.privileged.orderContact(orderId, ctx.envelope.shop_id)) as unknown as Contact;
    if (!contact.customer_email) return; // 連絡先が無い（マスク済み等）注文には送らない
    const received = event === "order.paid" || event === "order.created";
    const kind = received ? "order_paid" : "order_shipped";
    const mail = buildOrderEmail(received ? "paid" : "shipped", contact, ctx.config.get("PUBLIC_BASE_URL"), await ctx.privileged.shopNoticeTexts(ctx.envelope.shop_id, kind));
    const owner = ctx.settings["bcc_owner"] === true && contact.shop.contact_email ? contact.shop.contact_email : null;
    const route = noticeRoute(data);
    if (route === "owner_only") {
      // 「LINE だけ」のお客様（0176）: お客様あては送らず、運営者への控えだけ（お客様の知らせは LINE。届かなければ LINE のプラグインが配り直す）
      if (owner) await sendMail(mailer, { from, to: owner, subject: mail.subject, text: mail.text, idempotencyKey: `banto-${ctx.envelope.id}-owner` });
      return;
    }
    // LINE から配り直された知らせ（route = "customer_only"）は、控えを最初の配信で送ってあるので付けない
    const bcc = route === "all" && owner ? [owner] : [];
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

/**
 * お客様が「LINE だけ」（0176）のときの送り分け。決めるのは hooks を積んだときの DB（payload の notice_line_only）で、ここは読むだけ
 *   - all: 今までどおり（お客様あてと控え）。当てる前の DB の知らせには印が無い
 *   - owner_only: お客様あては送らず、控え（と試着の店舗あて）だけ。お客様の知らせは LINE
 *   - customer_only: LINE で届けられなかったので配り直された知らせ（line_fallback）。お客様あてだけ（控え・店舗あては最初の配信で送ってある）
 */
export function noticeRoute(data: Record<string, unknown>): "all" | "owner_only" | "customer_only" {
  if (data["line_fallback"] === true) return "customer_only";
  return data["notice_line_only"] === true ? "owner_only" : "all";
}

/** お店で試着（0025）: お客様と店舗へ。宛先ごとに Idempotency-Key を分ける */
async function sendTryon(ctx: PluginContext, mailer: Mailer, from: string): Promise<void> {
  const { event, data, shop_id, id } = ctx.envelope;
  const requestId = typeof data["request_id"] === "string" ? data["request_id"] : "";
  if (!requestId) return;
  if (event === "tryon.updated" && !["ready", "cancelled"].includes(String(data["status"]))) return;
  const contact = (await ctx.privileged.tryonContact(requestId, shop_id)) as unknown as TryonContact;
  const owner = ctx.settings["bcc_owner"] === true && contact.shop.contact_email ? contact.shop.contact_email : null;
  const route = noticeRoute(data);
  const bcc = route === "all" && owner ? [owner] : [];
  const opts = data["reminder"] === true ? { reminder: true } : data["extended"] === true ? { extended: true, previousHoldUntil: typeof data["previous_hold_until"] === "string" ? data["previous_hold_until"] : null } : {};
  // お客様あての知らせがあるときだけ文面（0154）を読む
  const skipCustomer = skipTryon(ctx.settings);
  const kind = contact.customer_email && !skipCustomer ? tryonNoticeKind(event, contact.status, opts) : null;
  const texts = kind ? await ctx.privileged.shopNoticeTexts(shop_id, kind) : [];
  for (const m of buildTryonMails(event, contact, ctx.config.get("PUBLIC_BASE_URL"), opts, texts)) {
    // お客様あて（と控え）は外部プラグインに任せる店では送らない。店舗あては送る
    if (skipCustomer && m.key === "customer") continue;
    // LINE から配り直された知らせはお客様あてだけ（店舗あては最初の配信で送ってある）
    if (route === "customer_only" && m.key !== "customer") continue;
    if (route === "owner_only" && m.key === "customer") {
      // 「LINE だけ」のお客様（0176）: お客様あては送らず、控えだけ
      if (owner) await sendMail(mailer, { from, to: owner, subject: m.subject, text: m.text, idempotencyKey: `banto-${id}-owner` });
      continue;
    }
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
