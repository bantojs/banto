/**
 * メールの送り手（docs/email.md）。デプロイ全体で 1 つを MAIL_TRANSPORT で選ぶ: resend（既定）/ smtp / sendgrid / ses。
 * 送信元はショップごと（同梱のメール通知プラグインの設定）、秘密は Workers Secret（CLAUDE.md §1-5）。
 *
 * 2 系統の送信がどちらもここを通る:
 *   - その場で送るメール（会員のログインのコード、招待、お知らせ）。送れないと会員が入れないので hooks の配信（Cron・再送）に載せられない（10-members-identity.md §7）
 *   - 注文の通知のような非同期のメール（hooks の同梱プラグイン src/plugins/email_resend.ts）
 */
import type { Adapters, ConfigAdapter } from "../adapters/types";
import { resendMailer } from "./transports/resend";
import { sendgridMailer } from "./transports/sendgrid";
import { sesMailer } from "./transports/ses";
import { smtpMailer } from "./transports/smtp";
import { type Mail, MailError, MAIL_TRANSPORTS, type MailTransportName, type Mailer } from "./types";

export { type Mail, MailError, MAIL_TRANSPORTS, type MailTransportName, type Mailer } from "./types";

/** 送り手ごとに要る設定の名前（管理画面が未設定を警告する）。SMTP_USER / SMTP_PASS は任意（認証の無いリレー） */
const REQUIRED: Record<MailTransportName, string[]> = {
  resend: ["RESEND_API_KEY"],
  smtp: ["SMTP_HOST"],
  sendgrid: ["SENDGRID_API_KEY"],
  ses: ["SES_REGION", "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY"],
};

/** MAIL_TRANSPORT の値（無ければ resend）。知らない値は null */
export function mailTransportName(config: ConfigAdapter): MailTransportName | null {
  const v = (config.get("MAIL_TRANSPORT") ?? "resend").toLowerCase();
  return (MAIL_TRANSPORTS as readonly string[]).includes(v) ? (v as MailTransportName) : null;
}

/** 選んだ送り手に足りない設定の名前（MAIL_TRANSPORT が知らない値ならそれ自体） */
export function mailTransportMissing(config: ConfigAdapter): string[] {
  const name = mailTransportName(config);
  if (!name) return ["MAIL_TRANSPORT"];
  return REQUIRED[name].filter((n) => !config.get(n));
}

function smtpOptions(config: ConfigAdapter) {
  const tlsRaw = (config.get("SMTP_TLS") ?? "starttls").toLowerCase();
  const tls: "on" | "starttls" | "off" = tlsRaw === "on" || tlsRaw === "tls" ? "on" : tlsRaw === "off" || tlsRaw === "none" ? "off" : "starttls";
  const port = Number(config.get("SMTP_PORT") ?? (tls === "on" ? 465 : 587));
  const base = config.get("PUBLIC_BASE_URL");
  let ehloName = "banto";
  if (base) {
    try {
      ehloName = new URL(base).hostname || ehloName;
    } catch {
      // そのまま
    }
  }
  return { host: config.secret("SMTP_HOST"), port: Number.isFinite(port) && port > 0 ? port : 587, tls, user: config.get("SMTP_USER"), pass: config.get("SMTP_PASS"), ehloName };
}

/**
 * 設定から送り手を作る。選んだ送り手の設定が足りなければ null（呼び出し側は「メールの設定が済んでいない」として扱う）。
 * SMTP はランタイムの生の TCP（adapters.socket）が要る。
 */
export function createMailer(adapters: Pick<Adapters, "config" | "socket">, doFetch: typeof fetch): Mailer | null {
  const config = adapters.config;
  const name = mailTransportName(config);
  if (!name || mailTransportMissing(config).length > 0) return null;
  switch (name) {
    case "resend":
      return resendMailer(doFetch, config.secret("RESEND_API_KEY"));
    case "sendgrid":
      return sendgridMailer(doFetch, config.secret("SENDGRID_API_KEY"));
    case "ses":
      return sesMailer(doFetch, { region: config.secret("SES_REGION"), accessKeyId: config.secret("SES_ACCESS_KEY_ID"), secretAccessKey: config.secret("SES_SECRET_ACCESS_KEY"), endpoint: config.get("SES_ENDPOINT") });
    case "smtp":
      if (!adapters.socket) return null;
      return smtpMailer(adapters.socket, smtpOptions(config));
  }
}

/** 送る。送り手が無ければ MailError(0)（会員のログインは「設定が済んでいない」と出す） */
export async function sendMail(mailer: Mailer | null, mail: Mail): Promise<void> {
  if (!mailer) throw new MailError(0, "mail transport is not configured (MAIL_TRANSPORT, docs/email.md)");
  await mailer.send(mail);
}
