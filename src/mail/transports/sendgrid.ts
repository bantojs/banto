/** SendGrid（v3 Mail Send API）。成功は 202 */
import { parseAddress } from "../message";
import { type Mail, MailError, type Mailer } from "../types";

export const SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send";

const addr = (s: string) => {
  const a = parseAddress(s);
  return a.name ? { email: a.email, name: a.name } : { email: a.email };
};

export function sendgridMailer(doFetch: typeof fetch, apiKey: string): Mailer {
  return {
    name: "sendgrid",
    async send(mail: Mail) {
      let res: Response;
      try {
        res = await doFetch(SENDGRID_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            personalizations: [{ to: [addr(mail.to)], ...(mail.bcc?.length ? { bcc: mail.bcc.map(addr) } : {}) }],
            from: addr(mail.from),
            ...(mail.replyTo ? { reply_to: addr(mail.replyTo) } : {}),
            subject: mail.subject,
            content: [{ type: "text/plain", value: mail.text }, ...(mail.html ? [{ type: "text/html", value: mail.html }] : [])],
          }),
        });
      } catch (e) {
        throw new MailError(0, `SendGrid: ${(e as Error).message}`);
      }
      if (!res.ok) throw new MailError(res.status, `SendGrid ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    },
  };
}
