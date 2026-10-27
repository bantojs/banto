/**
 * お問い合わせのメール（同梱モジュール inquiries、0061）。Worker がその場で送る（送り手は src/mail/send.ts）。
 * **本文は載せない**: お知らせとチケットへのリンクだけ（人間の決定 2026-10-27、docs/knowledge/14-inquiries.md）。
 * やり取りの中身が送り手の事業者や転送先の受信箱に残らないように。メールへの返信は受けない（受信の仕組みを持たない）。
 */
import { t, tf } from "../../i18n";
import { renderMailHtml } from "../../mail/html";

export interface InquiryMailShop {
  id: string;
  name: string;
  slug: string;
  domain?: string | null;
  settings?: Record<string, unknown> | null;
}

export type CustomerMailKind = "verify" | "created" | "reply" | "link";

interface Built {
  subject: string;
  text: string;
  html: string;
}

/** お客様へ: 確認のリンク / 受け付けた / 返事があった / リンクの送り直し */
export function buildCustomerMail(kind: CustomerMailKind, shop: InquiryMailShop, number: number, link: string): Built {
  const vars = { shop: shop.name, number, link };
  const intro = tf(`inq.mail_${kind}_intro`, vars);
  return {
    subject: tf(`inq.mail_${kind}_subject`, vars),
    text: `${intro}\n\n${tf("inq.mail_number", vars)}\n${link}\n\n${t("inq.mail_no_reply")}\n${kind === "verify" ? `${t("inq.mail_not_you")}\n` : ""}\n${shop.name}`,
    html: renderMailHtml(shop, {
      heading: t(`inq.mail_${kind}_heading`),
      paragraphs: [intro, tf("inq.mail_number", vars)],
      button: { label: t("inq.mail_button"), url: link },
      note: `${t("inq.mail_no_reply")}${kind === "verify" ? ` ${t("inq.mail_not_you")}` : ""}`,
    }),
  };
}

/** 運営者へ: 新しい問い合わせ（アドレスが確かめられたとき）/ お客様から返事があった。中身は管理画面で読む */
export function buildShopNotice(kind: "new" | "reply", shop: InquiryMailShop, inquiry: { number: number; category?: string }, adminUrl: string): Built {
  const vars = { shop: shop.name, number: inquiry.number, link: adminUrl, category: inquiry.category ? t(`inq.category_${inquiry.category}` as Parameters<typeof t>[0]) : "" };
  const intro = tf(`inq.notice_${kind}_intro`, vars);
  return {
    subject: tf(`inq.notice_${kind}_subject`, vars),
    text: `${intro}\n\n${adminUrl}\n`,
    html: renderMailHtml(shop, { heading: tf(`inq.notice_${kind}_subject`, vars), paragraphs: [intro], button: { label: t("inq.notice_button"), url: adminUrl } }),
  };
}
