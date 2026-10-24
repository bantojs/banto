/** メールの形と送り手のインターフェース（送り手の実装は src/mail/transports/、選択は src/mail/send.ts） */
export interface Mail {
  from: string;
  to: string;
  bcc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  /** 同じメールを二度送らないための鍵（hooks の再送）。受け付ける送り手（Resend）だけが使う */
  idempotencyKey?: string;
}

export class MailError extends Error {
  constructor(
    /** HTTP の状態か SMTP の応答コード。0 はつながらない・設定が無い */
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MailError";
  }
}

export type MailTransportName = "resend" | "smtp" | "sendgrid" | "ses";
export const MAIL_TRANSPORTS: readonly MailTransportName[] = ["resend", "smtp", "sendgrid", "ses"];

export interface Mailer {
  readonly name: MailTransportName;
  send(mail: Mail): Promise<void>;
}
