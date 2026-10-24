/**
 * SMTP（レンタルサーバーや VPS の自前のメールサーバー、各社の SMTP リレー）。
 * 接続は SocketAdapter。Cloudflare は外向きの 25 番を塞いでいるので 587（STARTTLS、既定）か 465（TLS）を使う。
 * 平文（SMTP_TLS=off）は同じホストや閉じた網の中のサーバーにだけ使う（認証情報がそのまま流れる）。
 */
import type { SocketAdapter } from "../../adapters/types";
import { buildMimeMessage } from "../message";
import { type Mail, MailError, type Mailer } from "../types";
import { SmtpError, smtpSend, type SmtpOptions } from "../smtp-client";

export function smtpMailer(sockets: SocketAdapter, o: SmtpOptions): Mailer {
  return {
    name: "smtp",
    async send(mail: Mail) {
      const msg = buildMimeMessage(mail);
      try {
        await smtpSend(sockets, o, { from: msg.envelopeFrom, recipients: msg.recipients, data: msg.data });
      } catch (e) {
        if (e instanceof SmtpError) throw new MailError(e.code, `SMTP ${e.message}`);
        throw new MailError(0, `SMTP: ${(e as Error).message}`);
      }
    },
  };
}
