/** Resend（HTTP API）。Idempotency-Key を受け付ける唯一の送り手 */
import { type Mail, MailError, type Mailer } from "../types";

export const RESEND_API_URL = "https://api.resend.com/emails";

export function resendMailer(doFetch: typeof fetch, apiKey: string): Mailer {
  return {
    name: "resend",
    async send(mail: Mail) {
      let res: Response;
      try {
        res = await doFetch(RESEND_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...(mail.idempotencyKey ? { "Idempotency-Key": mail.idempotencyKey } : {}) },
          body: JSON.stringify({
            from: mail.from,
            to: [mail.to],
            ...(mail.bcc?.length ? { bcc: mail.bcc } : {}),
            ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
            subject: mail.subject,
            text: mail.text,
            ...(mail.html ? { html: mail.html } : {}),
          }),
        });
      } catch (e) {
        throw new MailError(0, `Resend: ${(e as Error).message}`);
      }
      if (!res.ok) throw new MailError(res.status, `Resend ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    },
  };
}
