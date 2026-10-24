/** Amazon SES（SESv2 の SendEmail を HTTPS + SigV4 で呼ぶ。SDK なし。署名は src/util/sigv4.ts） */
import { sha256Hex, signAwsRequest } from "../../util/sigv4";
import { type Mail, MailError, type Mailer } from "../types";

export interface SesOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 既定は https://email.<region>.amazonaws.com（テストや VPC エンドポイント向けに差し替え可） */
  endpoint?: string;
  now?: () => Date;
}

export function sesEndpoint(region: string): string {
  return `https://email.${region}.amazonaws.com`;
}

export function sesMailer(doFetch: typeof fetch, o: SesOptions): Mailer {
  return {
    name: "ses",
    async send(mail: Mail) {
      const url = new URL(`${(o.endpoint ?? sesEndpoint(o.region)).replace(/\/+$/, "")}/v2/email/outbound-emails`);
      const body = JSON.stringify({
        FromEmailAddress: mail.from,
        Destination: { ToAddresses: [mail.to], ...(mail.bcc?.length ? { BccAddresses: mail.bcc } : {}) },
        ...(mail.replyTo ? { ReplyToAddresses: [mail.replyTo] } : {}),
        Content: {
          Simple: {
            Subject: { Data: mail.subject, Charset: "UTF-8" },
            Body: { Text: { Data: mail.text, Charset: "UTF-8" }, ...(mail.html ? { Html: { Data: mail.html, Charset: "UTF-8" } } : {}) },
          },
        },
      });
      const headers = await signAwsRequest({
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        payloadHash: await sha256Hex(body),
        region: o.region,
        service: "ses",
        accessKeyId: o.accessKeyId,
        secretAccessKey: o.secretAccessKey,
        now: o.now?.() ?? new Date(),
      });
      let res: Response;
      try {
        res = await doFetch(url.toString(), { method: "POST", headers, body });
      } catch (e) {
        throw new MailError(0, `SES: ${(e as Error).message}`);
      }
      if (!res.ok) throw new MailError(res.status, `SES ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    },
  };
}
