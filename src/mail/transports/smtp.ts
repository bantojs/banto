/**
 * SMTP（レンタルサーバーや VPS の自前のメールサーバー、各社の SMTP リレー）。
 * 接続は SocketAdapter。Cloudflare は外向きの 25 番を塞いでいるので 587（STARTTLS、既定）か 465（TLS）を使う。
 * 平文（SMTP_TLS=off）は同じホストや閉じた網の中のサーバーにだけ使う（認証情報がそのまま流れる）。
 */
import type { SocketAdapter } from "../../adapters/types";
import { buildMimeMessage, MailAddressError } from "../message";
import { type Mail, MailError, type Mailer } from "../types";
import { SmtpError, smtpSend, type SmtpOptions } from "../smtp-client";

export function smtpMailer(sockets: SocketAdapter, o: SmtpOptions): Mailer {
  return {
    name: "smtp",
    async send(mail: Mail) {
      try {
        // 送信元・宛先の形が SMTP に出せないとき（送信元の設定が "名前 <a@b>" でない など）も MailError にする。
        // 呼び出し側（会員のログイン等）は MailError だけを「送れなかった」として扱い、それ以外は 500 になるため
        const msg = buildMimeMessage(mail);
        await smtpSend(sockets, o, { from: msg.envelopeFrom, recipients: msg.recipients, data: msg.data });
      } catch (e) {
        if (e instanceof SmtpError) throw new MailError(e.code, `SMTP ${e.message}`);
        if (e instanceof MailAddressError) throw new MailError(0, `SMTP: ${e.message} (the sender and recipient must look like "Shop <order@example.com>" or "order@example.com"; check the sender in the mail plugin settings, docs/email.md)`);
        throw new MailError(0, `SMTP: ${(e as Error).message}`);
      }
    },
  };
}
