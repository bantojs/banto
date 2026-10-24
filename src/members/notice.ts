/**
 * パスワードでのログインを会員に知らせる（0016_member_notice、docs/knowledge/10-members-identity.md §16）。
 * 使い回しのパスワードで入られたときに、本人が気づけるようにする。
 * 同じ端末でこの会員が前にログインしていれば送らない（端末の印 = 署名付きの Cookie。中身はショップと会員の HMAC だけ）。
 * 送れなくてもログインは止めない。送信元が返らない（0016 の前・メール通知プラグインが無効）なら送らない。
 */
import { type Mailer, sendMail } from "../mail/send";
import { renderMailHtml } from "../mail/html";
import { t, tf } from "../i18n";
import { formatDateTime } from "../i18n/time";
import { readCookie } from "../util/signed";
import { deviceMark } from "./auth";

export const DEVICE_SECONDS = 400 * 24 * 60 * 60;

export function deviceCookieName(shopId: string): string {
  return `banto_member_dev_${shopId.replace(/[^a-zA-Z0-9]/g, "")}`;
}

/** この端末でこの会員がログインしたことがあるか */
export async function knownDevice(secret: string, shopId: string, customerId: string, cookieHeader: string | undefined): Promise<boolean> {
  const v = readCookie(cookieHeader, deviceCookieName(shopId));
  return Boolean(v) && v === (await deviceMark(secret, shopId, customerId));
}

export interface NoticeDeps {
  /** メールの送り手（createMailer。設定が無ければ null → 送らない） */
  mailer: Mailer | null;
}

export async function sendPasswordLoginNotice(
  deps: NoticeDeps,
  shop: { name: string; settings?: Record<string, unknown> | null },
  m: { from: string; to: string; accountUrl: string; at?: Date },
): Promise<void> {
  if (!deps.mailer || !m.from || !m.to) return;
  const time = formatDateTime((m.at ?? new Date()).toISOString());
  await sendMail(deps.mailer, {
    from: m.from,
    to: m.to,
    subject: tf("member.notice_subject", { shop: shop.name }),
    text: tf("member.notice_body", { shop: shop.name, email: m.to, time, account: m.accountUrl }),
    html: renderMailHtml(shop, {
      heading: t("member.notice_heading"),
      paragraphs: [tf("member.notice_intro", { email: m.to, time }), t("member.notice_advice")],
      button: { label: t("member.notice_button"), url: m.accountUrl },
    }),
  }).catch((e: unknown) => console.error("[banto] password login notice:", e));
}
