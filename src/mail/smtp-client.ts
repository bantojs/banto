/**
 * 小さな SMTP クライアント（RFC 5321。送信にだけ使う）。接続は SocketAdapter（Workers: cloudflare:sockets、Node: node:net / node:tls）。
 * 手順: 接続 → EHLO → （STARTTLS → EHLO）→ AUTH（PLAIN か LOGIN）→ MAIL FROM → RCPT TO → DATA → QUIT。
 * 応答は 1 つずつ待つ（PIPELINING は使わない）。各応答に期限を置き、サーバーが黙ったら切る。
 */
import type { RawConnection, SocketAdapter } from "../adapters/types";
import { base64Utf8 } from "./message";

export interface SmtpOptions {
  host: string;
  port: number;
  /** on: 最初から TLS（465）。starttls: EHLO のあと STARTTLS（587、サーバーが出さなければ失敗）。off: 平文のまま */
  tls: "on" | "starttls" | "off";
  user?: string;
  pass?: string;
  /** EHLO に名乗る名前（公開 URL のホスト名） */
  ehloName: string;
  /** 応答を待つ上限（ミリ秒） */
  timeoutMs?: number;
}

export class SmtpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "SmtpError";
  }
}

interface Reply {
  code: number;
  lines: string[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

class Session {
  private buffer = "";
  constructor(
    private conn: RawConnection,
    private readonly timeoutMs: number,
  ) {}

  /** 1 つの応答（複数行なら最後の "NNN " の行まで）を読む */
  async reply(): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      const nl = this.buffer.indexOf("\r\n");
      if (nl >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 2);
        const m = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!m) throw new SmtpError(0, `unexpected reply: ${line.slice(0, 100)}`);
        lines.push(m[3]!);
        if (m[2] === " ") return { code: Number(m[1]), lines };
        continue;
      }
      const chunk = await this.readWithTimeout();
      if (chunk === null) throw new SmtpError(0, "connection closed by server");
      this.buffer += dec.decode(chunk, { stream: true });
    }
  }

  private readWithTimeout(): Promise<Uint8Array | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SmtpError(0, "timeout waiting for server")), this.timeoutMs);
    });
    return Promise.race([this.conn.read(), timeout]).finally(() => clearTimeout(timer));
  }

  async send(line: string): Promise<void> {
    // 1 コマンド 1 行。引数に改行が混ざると別のコマンドになる（送信元・宛先の注入）。ここで止める（最後の砦。2026-10-25 の監査）
    if (/[\r\n]/.test(line)) throw new SmtpError(0, "line contains CR/LF");
    await this.conn.write(enc.encode(`${line}\r\n`));
  }

  async command(line: string, expect: number[], label = line.split(" ")[0]!): Promise<Reply> {
    await this.send(line);
    const r = await this.reply();
    if (!expect.includes(r.code)) throw new SmtpError(r.code, `${label}: ${r.code} ${r.lines.join(" ").slice(0, 200)}`);
    return r;
  }

  async startTls(): Promise<void> {
    this.buffer = "";
    this.conn = await this.conn.startTls();
  }

  async writeRaw(data: Uint8Array): Promise<void> {
    await this.conn.write(data);
  }

  async close(): Promise<void> {
    await this.conn.close().catch(() => undefined);
  }
}

function parseEhlo(r: Reply): { starttls: boolean; auth: string[] } {
  const ext = r.lines.slice(1).map((l) => l.trim().toUpperCase());
  const auth = ext.find((l) => l.startsWith("AUTH ") || l.startsWith("AUTH="));
  return { starttls: ext.includes("STARTTLS"), auth: auth ? auth.slice(5).split(/[\s=]+/).filter(Boolean) : [] };
}

/** DATA の本文: 行頭の "." を重ね、最後に CRLF.CRLF */
export function dotStuff(data: string): string {
  const body = data.replace(/\r?\n/g, "\r\n").replace(/(^|\r\n)\./g, "$1..");
  return `${body}${body.endsWith("\r\n") ? "" : "\r\n"}.\r\n`;
}

export async function smtpSend(sockets: SocketAdapter, o: SmtpOptions, msg: { from: string; recipients: string[]; data: string }): Promise<void> {
  const conn = await sockets.connect(o.host, o.port, o.tls);
  const s = new Session(conn, o.timeoutMs ?? 20_000);
  try {
    const greeting = await s.reply();
    if (greeting.code !== 220) throw new SmtpError(greeting.code, `greeting: ${greeting.code} ${greeting.lines.join(" ").slice(0, 200)}`);
    let ehlo = parseEhlo(await s.command(`EHLO ${o.ehloName}`, [250]));
    if (o.tls === "starttls") {
      if (!ehlo.starttls) throw new SmtpError(0, "server does not offer STARTTLS (set SMTP_TLS=on for port 465, or SMTP_TLS=off only for a server on the same host)");
      await s.command("STARTTLS", [220]);
      await s.startTls();
      ehlo = parseEhlo(await s.command(`EHLO ${o.ehloName}`, [250]));
    }
    if (o.user) {
      const pass = o.pass ?? "";
      if (ehlo.auth.includes("LOGIN") && !ehlo.auth.includes("PLAIN")) {
        await s.command("AUTH LOGIN", [334], "AUTH");
        await s.command(base64Utf8(o.user), [334], "AUTH");
        await s.command(base64Utf8(pass), [235], "AUTH");
      } else {
        await s.command(`AUTH PLAIN ${base64Utf8(`\0${o.user}\0${pass}`)}`, [235], "AUTH");
      }
    }
    await s.command(`MAIL FROM:<${msg.from}>`, [250]);
    for (const rcpt of msg.recipients) await s.command(`RCPT TO:<${rcpt}>`, [250, 251]);
    await s.command("DATA", [354]);
    await s.writeRaw(enc.encode(dotStuff(msg.data)));
    const done = await s.reply();
    if (done.code !== 250) throw new SmtpError(done.code, `DATA: ${done.code} ${done.lines.join(" ").slice(0, 200)}`);
    // 送り終えたあとの QUIT の応答は待つが、ここでの失敗はもう送信の失敗ではない
    await s.command("QUIT", [221]).catch(() => undefined);
  } finally {
    await s.close();
  }
}
