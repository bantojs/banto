/**
 * メールの文面を RFC 5322 / MIME の形にする（SMTP の送り手が使う。HTTP の送り手は各サービスの JSON に詰めるだけ）。
 * 件名と表示名は UTF-8 の encoded-word（RFC 2047）、本文は base64。ライブラリは使わない。
 */

export interface MailAddress {
  name?: string;
  email: string;
}

/** アドレスの形（空白・改行・< > , ; " ( ) を含まない。SMTP のコマンドとヘッダに出すので厳しく。2026-10-25 の監査） */
const EMAIL_RE = /^[^\s<>@,;"()\\]+@[^\s<>@,;"()\\]+\.[^\s<>@,;"()\\]+$/;

export class MailAddressError extends Error {
  constructor(raw: string) {
    super(`invalid mail address: ${raw.replace(/[\r\n\t]/g, " ").slice(0, 60)}`);
    this.name = "MailAddressError";
  }
}

/** "名前 <a@b>" / "<a@b>" / "a@b" を分ける。名前の引用符は外す。アドレスの形でなければ MailAddressError */
export function parseAddress(raw: string): MailAddress {
  const s = raw.trim();
  const m = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(s);
  if (!m) {
    const email = s.replace(/^<|>$/g, "");
    if (!EMAIL_RE.test(email)) throw new MailAddressError(email);
    return { email };
  }
  if (!EMAIL_RE.test(m[2]!)) throw new MailAddressError(m[2]!);
  let name = m[1]!.trim();
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  if (/[\r\n]/.test(name)) throw new MailAddressError(name);
  return name ? { name, email: m[2]! } : { email: m[2]! };
}

const enc = new TextEncoder();

export function base64Bytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64Utf8(s: string): string {
  return base64Bytes(enc.encode(s));
}

/** 本文の base64（76 文字ごとに改行） */
export function base64Body(s: string): string {
  return base64Utf8(s).replace(/.{76}/g, "$&\r\n").replace(/\r\n$/, "");
}

// 1 つの encoded-word は 75 文字まで（"=?UTF-8?B?" + "?=" で 12 文字）→ 元のバイト列は 45 バイトまで
const WORD_BYTES = 45;

/** ASCII だけなら（必要なら引用符を付けて）そのまま、それ以外は encoded-word（複数に分けるときは文字の境目で） */
export function encodeHeaderText(s: string, opts: { phrase?: boolean } = {}): string {
  if (/^[\x20-\x7e]*$/.test(s)) {
    if (opts.phrase && /[^A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]/.test(s)) return `"${s.replace(/["\\]/g, "\\$&")}"`;
    return s;
  }
  const words: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const ch of s) {
    const n = enc.encode(ch).length;
    if (bytes + n > WORD_BYTES) {
      words.push(`=?UTF-8?B?${base64Utf8(chunk)}?=`);
      chunk = "";
      bytes = 0;
    }
    chunk += ch;
    bytes += n;
  }
  if (chunk) words.push(`=?UTF-8?B?${base64Utf8(chunk)}?=`);
  return words.join("\r\n ");
}

export function formatAddress(a: MailAddress): string {
  return a.name ? `${encodeHeaderText(a.name, { phrase: true })} <${a.email}>` : a.email;
}

export function rfc5322Date(d: Date): string {
  return d.toUTCString().replace(/GMT$/, "+0000");
}

export interface MimeMessage {
  /** エンベロープの送信元（MAIL FROM） */
  envelopeFrom: string;
  /** エンベロープの宛先（RCPT TO。To と Bcc） */
  recipients: string[];
  /** ヘッダと本文（CRLF 区切り。SMTP の DATA に流す前にドットの重ね書きをする） */
  data: string;
}

export function buildMimeMessage(
  m: { from: string; to: string; bcc?: string[]; replyTo?: string; subject: string; text: string; html?: string },
  opts: { now?: Date; messageId?: string } = {},
): MimeMessage {
  const from = parseAddress(m.from);
  const to = parseAddress(m.to);
  const domain = from.email.split("@")[1] || "banto.invalid";
  const id = opts.messageId ?? `${crypto.randomUUID()}@${domain}`;
  const headers: string[] = [
    `From: ${formatAddress(from)}`,
    `To: ${formatAddress(to)}`,
    ...(m.replyTo ? [`Reply-To: ${formatAddress(parseAddress(m.replyTo))}`] : []),
    `Subject: ${encodeHeaderText(m.subject)}`,
    `Date: ${rfc5322Date(opts.now ?? new Date())}`,
    `Message-ID: <${id}>`,
    "MIME-Version: 1.0",
  ];
  let body: string;
  if (m.html) {
    const boundary = `=_banto_${crypto.randomUUID().replace(/-/g, "")}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Body(m.text),
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Body(m.html),
      `--${boundary}--`,
      "",
    ].join("\r\n");
  } else {
    headers.push("Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64");
    body = `${base64Body(m.text)}\r\n`;
  }
  const recipients = [to.email, ...(m.bcc ?? []).map((b) => parseAddress(b).email)].filter((v, i, arr) => arr.indexOf(v) === i);
  return { envelopeFrom: from.email, recipients, data: `${headers.join("\r\n")}\r\n\r\n${body}` };
}
