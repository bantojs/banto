import { createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import type { RawConnection, SocketAdapter } from "../src/adapters/types";
import { nodeSockets } from "../src/adapters/node/socket";
import { createMailer, MailError, mailTransportMissing, mailTransportName, sendMail } from "../src/mail/send";
import { buildMimeMessage, encodeHeaderText, parseAddress } from "../src/mail/message";
import { dotStuff } from "../src/mail/smtp-client";
import { SENDGRID_API_URL } from "../src/mail/transports/sendgrid";
import { memoryAdapters } from "./helpers";

const MAIL = { from: "マイショップ <order@example.com>", to: "山田 太郎 <buyer@example.com>", subject: "【マイショップ】ご注文ありがとうございます（注文番号 1001）", text: "本文\n.行頭のドット\n", html: "<p>本文</p>" };

const captured = () => {
  const calls: { url: string; headers: Headers; body: string }[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, headers: req.headers, body: await req.text() });
    return new Response(JSON.stringify({ id: "x" }), { status: 202 });
  };
  return { calls, doFetch };
};

describe("メールの送り手の選択（MAIL_TRANSPORT）", () => {
  it("既定は resend。知らない値は null。送り手ごとに足りない設定を出す", () => {
    expect(mailTransportName(memoryAdapters({}).config)).toBe("resend");
    expect(mailTransportName(memoryAdapters({ MAIL_TRANSPORT: "SES" }).config)).toBe("ses");
    expect(mailTransportName(memoryAdapters({ MAIL_TRANSPORT: "pigeon" }).config)).toBeNull();
    expect(mailTransportMissing(memoryAdapters({}).config)).toEqual(["RESEND_API_KEY"]);
    expect(mailTransportMissing(memoryAdapters({ MAIL_TRANSPORT: "pigeon" }).config)).toEqual(["MAIL_TRANSPORT"]);
    expect(mailTransportMissing(memoryAdapters({ MAIL_TRANSPORT: "smtp" }).config)).toEqual(["SMTP_HOST"]);
    expect(mailTransportMissing(memoryAdapters({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "mail.example.jp" }).config)).toEqual([]);
    expect(mailTransportMissing(memoryAdapters({ MAIL_TRANSPORT: "ses", SES_REGION: "ap-northeast-1" }).config)).toEqual(["SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY"]);
    expect(createMailer(memoryAdapters({ MAIL_TRANSPORT: "sendgrid" }), fetch)).toBeNull();
    // SMTP は生の TCP の無いランタイムでは作れない
    expect(createMailer(memoryAdapters({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "mail.example.jp" }), fetch)).toBeNull();
    expect(createMailer({ ...memoryAdapters({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "mail.example.jp" }), socket: nodeSockets }, fetch)?.name).toBe("smtp");
  });

  it("送り手が無ければ sendMail は MailError(0)", async () => {
    const e = await sendMail(null, { ...MAIL }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MailError);
    expect((e as MailError).status).toBe(0);
  });

  it("Resend: bcc・reply_to・Idempotency-Key を付ける。失敗は MailError(状態)", async () => {
    const { calls, doFetch } = captured();
    const mailer = createMailer(memoryAdapters({ RESEND_API_KEY: "re_x" }), doFetch)!;
    expect(mailer.name).toBe("resend");
    await sendMail(mailer, { ...MAIL, bcc: ["shop@example.com"], replyTo: "shop@example.com", idempotencyKey: "banto-1" });
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer re_x");
    expect(calls[0]!.headers.get("idempotency-key")).toBe("banto-1");
    expect(JSON.parse(calls[0]!.body)).toEqual({ from: MAIL.from, to: [MAIL.to], bcc: ["shop@example.com"], reply_to: "shop@example.com", subject: MAIL.subject, text: MAIL.text, html: MAIL.html });
    const failing = createMailer(memoryAdapters({ RESEND_API_KEY: "re_x" }), async () => new Response("nope", { status: 422 }))!;
    const e = await sendMail(failing, MAIL).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MailError);
    expect((e as MailError).status).toBe(422);
    expect((e as MailError).message).toMatch(/^Resend 422: nope/);
  });

  it("SendGrid: v3 の形（personalizations / from の分解 / content）", async () => {
    const { calls, doFetch } = captured();
    const mailer = createMailer(memoryAdapters({ MAIL_TRANSPORT: "sendgrid", SENDGRID_API_KEY: "SG.x" }), doFetch)!;
    await sendMail(mailer, { ...MAIL, bcc: ["shop@example.com"], replyTo: "お店 <shop@example.com>" });
    expect(calls[0]!.url).toBe(SENDGRID_API_URL);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer SG.x");
    expect(JSON.parse(calls[0]!.body)).toEqual({
      personalizations: [{ to: [{ email: "buyer@example.com", name: "山田 太郎" }], bcc: [{ email: "shop@example.com" }] }],
      from: { email: "order@example.com", name: "マイショップ" },
      reply_to: { email: "shop@example.com", name: "お店" },
      subject: MAIL.subject,
      content: [
        { type: "text/plain", value: MAIL.text },
        { type: "text/html", value: MAIL.html },
      ],
    });
  });

  it("Amazon SES: SESv2 の SendEmail に SigV4（service=ses）で署名して送る", async () => {
    const { calls, doFetch } = captured();
    const mailer = createMailer(memoryAdapters({ MAIL_TRANSPORT: "ses", SES_REGION: "ap-northeast-1", SES_ACCESS_KEY_ID: "AKIAEXAMPLE", SES_SECRET_ACCESS_KEY: "secret" }), doFetch)!;
    await sendMail(mailer, { ...MAIL, bcc: ["shop@example.com"], replyTo: "shop@example.com" });
    expect(calls[0]!.url).toBe("https://email.ap-northeast-1.amazonaws.com/v2/email/outbound-emails");
    const auth = calls[0]!.headers.get("authorization")!;
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/ap-northeast-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(calls[0]!.headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);
    expect(JSON.parse(calls[0]!.body)).toEqual({
      FromEmailAddress: MAIL.from,
      Destination: { ToAddresses: [MAIL.to], BccAddresses: ["shop@example.com"] },
      ReplyToAddresses: ["shop@example.com"],
      Content: { Simple: { Subject: { Data: MAIL.subject, Charset: "UTF-8" }, Body: { Text: { Data: MAIL.text, Charset: "UTF-8" }, Html: { Data: MAIL.html, Charset: "UTF-8" } } } },
    });
    // 端点は差し替えられる（VPC エンドポイント・テスト）
    const custom = createMailer(memoryAdapters({ MAIL_TRANSPORT: "ses", SES_REGION: "us-east-1", SES_ACCESS_KEY_ID: "a", SES_SECRET_ACCESS_KEY: "b", SES_ENDPOINT: "https://ses.local/" }), doFetch)!;
    await sendMail(custom, MAIL);
    expect(calls[1]!.url).toBe("https://ses.local/v2/email/outbound-emails");
  });
});

describe("メールの文面（RFC 5322 / MIME）", () => {
  it("アドレスの分解とヘッダの encoded-word", () => {
    expect(parseAddress("マイショップ <order@example.com>")).toEqual({ name: "マイショップ", email: "order@example.com" });
    expect(parseAddress('"Shop, Inc." <order@example.com>')).toEqual({ name: "Shop, Inc.", email: "order@example.com" });
    expect(parseAddress("<order@example.com>")).toEqual({ email: "order@example.com" });
    expect(parseAddress("order@example.com")).toEqual({ email: "order@example.com" });
    expect(encodeHeaderText("Hello")).toBe("Hello");
    expect(encodeHeaderText("Shop, Inc.", { phrase: true })).toBe('"Shop, Inc."');
    expect(encodeHeaderText("マイショップ")).toBe("=?UTF-8?B?44Oe44Kk44K344On44OD44OX?=");
    // 長い件名は 75 文字以下の encoded-word に、文字の境目で分ける
    const long = encodeHeaderText("あ".repeat(40));
    for (const w of long.split("\r\n ")) {
      expect(w.length).toBeLessThanOrEqual(75);
      expect(Buffer.from(/\?B\?(.*)\?=$/.exec(w)![1]!, "base64").toString("utf8")).toMatch(/^あ+$/);
    }
    expect(long.split("\r\n ").length).toBe(3);
  });

  it("本文は base64、HTML があれば multipart/alternative。エンベロープは To と Bcc", () => {
    const msg = buildMimeMessage({ ...MAIL, bcc: ["shop@example.com", "buyer@example.com"], replyTo: "shop@example.com" }, { now: new Date("2026-10-23T01:02:03Z"), messageId: "id-1@example.com" });
    expect(msg.envelopeFrom).toBe("order@example.com");
    expect(msg.recipients).toEqual(["buyer@example.com", "shop@example.com"]);
    const cut = msg.data.indexOf("\r\n\r\n");
    const head = msg.data.slice(0, cut);
    const body = msg.data.slice(cut + 4);
    const headers = head.split("\r\n");
    expect(headers).toContain("From: =?UTF-8?B?44Oe44Kk44K344On44OD44OX?= <order@example.com>");
    expect(headers).toContain("To: =?UTF-8?B?5bGx55SwIOWkqumDjg==?= <buyer@example.com>");
    expect(headers).toContain("Reply-To: shop@example.com");
    expect(headers).toContain("Date: Fri, 23 Oct 2026 01:02:03 +0000");
    expect(headers).toContain("Message-ID: <id-1@example.com>");
    expect(headers.some((h) => h.startsWith("Subject: =?UTF-8?B?"))).toBe(true);
    expect(headers.some((h) => h.startsWith('Content-Type: multipart/alternative; boundary="'))).toBe(true);
    expect(headers.some((h) => h.startsWith("Bcc:"))).toBe(false);
    expect(body).toContain("Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" + Buffer.from(MAIL.text).toString("base64"));
    expect(body).toContain("Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" + Buffer.from(MAIL.html).toString("base64"));
    expect(msg.data.endsWith("--\r\n")).toBe(true);
    const plain = buildMimeMessage({ from: "a@example.com", to: "b@example.com", subject: "Hi", text: "x".repeat(100) });
    expect(plain.data).toContain("Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n");
    // base64 は 76 文字で折る
    expect(plain.data.split("\r\n\r\n")[1]!.split("\r\n")[0]!.length).toBe(76);
  });

  it("DATA の本文は行頭のドットを重ね、CRLF . CRLF で終える", () => {
    expect(dotStuff("a\r\n.b\r\n..c")).toBe("a\r\n..b\r\n...c\r\n.\r\n");
    expect(dotStuff(".first\n")).toBe("..first\r\n.\r\n");
  });
});

/** 台本どおりに応答する SMTP サーバーの偽物（生の TCP の代わり）。クライアントが送った行を記録する */
function scriptedSmtp(opts: { starttls?: boolean; auth?: string } = {}) {
  const sent: string[] = [];
  let tlsStarted = false;
  const connection = (greet: boolean): RawConnection => {
    const out: string[] = greet ? ["220 mail.example.jp ESMTP\r\n"] : [];
    let waiting: ((v: Uint8Array | null) => void) | null = null;
    const push = (s: string) => {
      if (waiting) {
        const w = waiting;
        waiting = null;
        w(new TextEncoder().encode(s));
      } else out.push(s);
    };
    let data = false;
    let loginStep = 0;
    return {
      async read() {
        const s = out.shift();
        if (s !== undefined) return new TextEncoder().encode(s);
        return new Promise((resolve) => {
          waiting = resolve;
        });
      },
      async write(chunk) {
        const text = new TextDecoder().decode(chunk);
        if (data) {
          sent.push(text);
          if (text.endsWith("\r\n.\r\n")) {
            data = false;
            push("250 OK queued\r\n");
          }
          return;
        }
        const line = text.replace(/\r\n$/, "");
        sent.push(line);
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO") push(`250-mail.example.jp\r\n250-SIZE 10240000\r\n${opts.starttls && !tlsStarted ? "250-STARTTLS\r\n" : ""}250-8BITMIME\r\n250 AUTH ${opts.auth ?? "PLAIN LOGIN"}\r\n`);
        else if (verb === "STARTTLS") push("220 go ahead\r\n");
        else if (verb === "AUTH") {
          if (line.toUpperCase().startsWith("AUTH LOGIN")) {
            loginStep = 1;
            push("334 VXNlcm5hbWU6\r\n");
          } else push("235 ok\r\n");
        } else if (loginStep === 1) {
          loginStep = 2;
          push("334 UGFzc3dvcmQ6\r\n");
        } else if (loginStep === 2) {
          loginStep = 0;
          push("235 ok\r\n");
        }
        else if (verb === "MAIL" || verb === "RCPT") push("250 OK\r\n");
        else if (verb === "DATA") {
          data = true;
          push("354 go\r\n");
        } else if (verb === "QUIT") push("221 bye\r\n");
        else push("500 ?\r\n");
      },
      async startTls() {
        tlsStarted = true;
        sent.push("<TLS>");
        return connection(false); // TLS のあとに挨拶は来ない
      },
      async close() {
        sent.push("<closed>");
      },
    };
  };
  const connects: { host: string; port: number; tls: string }[] = [];
  const sockets: SocketAdapter = {
    async connect(host, port, tls) {
      connects.push({ host, port, tls });
      return connection(true);
    },
  };
  return { sent, connects, sockets };
}

describe("SMTP の送り手", () => {
  it("587: EHLO → STARTTLS → EHLO → AUTH PLAIN → MAIL/RCPT/DATA → QUIT。EHLO は公開 URL のホスト名", async () => {
    const fake = scriptedSmtp({ starttls: true });
    const mailer = createMailer({ ...memoryAdapters({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "mail.example.jp", SMTP_USER: "order@example.com", SMTP_PASS: "pw", PUBLIC_BASE_URL: "https://shop.example.jp" }), socket: fake.sockets }, fetch)!;
    await sendMail(mailer, { ...MAIL, bcc: ["shop@example.com"] });
    expect(fake.connects).toEqual([{ host: "mail.example.jp", port: 587, tls: "starttls" }]);
    const verbs = fake.sent.filter((l) => !l.includes("\r\n")).map((l) => l.split(" ").slice(0, 2).join(" "));
    expect(verbs).toEqual(["EHLO shop.example.jp", "STARTTLS", "<TLS>", "EHLO shop.example.jp", "AUTH PLAIN", "MAIL FROM:<order@example.com>", "RCPT TO:<buyer@example.com>", "RCPT TO:<shop@example.com>", "DATA", "QUIT", "<closed>"]);
    expect(fake.sent.find((l) => l.startsWith("AUTH PLAIN "))).toBe(`AUTH PLAIN ${Buffer.from("\0order@example.com\0pw").toString("base64")}`);
    const data = fake.sent.find((l) => l.includes("\r\n\r\n"))!;
    expect(data.endsWith("\r\n.\r\n")).toBe(true);
    expect(data).toContain("From: =?UTF-8?B?44Oe44Kk44K344On44OD44OX?= <order@example.com>");
  });

  it("465（SMTP_TLS=on）は最初から TLS。認証が無ければ AUTH を送らない。LOGIN しか無いサーバーには AUTH LOGIN", async () => {
    const plain = scriptedSmtp();
    await sendMail(createMailer({ ...memoryAdapters({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "mail.example.jp", SMTP_TLS: "on" }), socket: plain.sockets }, fetch)!, MAIL);
    expect(plain.connects).toEqual([{ host: "mail.example.jp", port: 465, tls: "on" }]);
    expect(plain.sent.some((l) => l.startsWith("AUTH"))).toBe(false);
    expect(plain.sent.some((l) => l === "STARTTLS")).toBe(false);

    const login = scriptedSmtp({ auth: "LOGIN" });
    await sendMail(createMailer({ ...memoryAdapters({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "mail.example.jp", SMTP_PORT: "2525", SMTP_TLS: "off", SMTP_USER: "u", SMTP_PASS: "p" }), socket: login.sockets }, fetch)!, MAIL);
    expect(login.connects).toEqual([{ host: "mail.example.jp", port: 2525, tls: "off" }]);
    expect(login.sent.slice(1, 4)).toEqual(["AUTH LOGIN", Buffer.from("u").toString("base64"), Buffer.from("p").toString("base64")]);
  });

  it("STARTTLS を出さないサーバーには平文で続けない。拒否の応答は MailError(コード)", async () => {
    const noTls = scriptedSmtp({ starttls: false });
    const e = await sendMail(createMailer({ ...memoryAdapters({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "mail.example.jp" }), socket: noTls.sockets }, fetch)!, MAIL).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MailError);
    expect((e as MailError).message).toMatch(/does not offer STARTTLS/);
    expect(noTls.sent.some((l) => l.startsWith("MAIL FROM"))).toBe(false);
    expect(noTls.sent.at(-1)).toBe("<closed>");

    const rejecting: SocketAdapter = {
      async connect() {
        const out = ["220 hi\r\n", "250 ok\r\n", "550 5.1.0 sender rejected\r\n"];
        return {
          async read() {
            const s = out.shift();
            return s === undefined ? null : new TextEncoder().encode(s);
          },
          async write() {},
          async startTls() {
            throw new Error("unexpected");
          },
          async close() {},
        };
      },
    };
    const r = await sendMail(createMailer({ ...memoryAdapters({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "h", SMTP_TLS: "off" }), socket: rejecting }, fetch)!, MAIL).catch((x: unknown) => x);
    expect(r).toBeInstanceOf(MailError);
    expect((r as MailError).status).toBe(550);
    expect((r as MailError).message).toMatch(/MAIL: 550 5\.1\.0 sender rejected/);
  });

  it("Node の生の TCP（node:net）で本物のソケットを通して送れる（平文、同じホスト）", async () => {
    const lines: string[] = [];
    let dataMode = false;
    const server = createServer((sock: Socket) => {
      let buf = "";
      sock.write("220 local ESMTP\r\n");
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        for (;;) {
          const nl = buf.indexOf("\r\n");
          if (nl < 0) break;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          if (dataMode) {
            lines.push(line);
            if (line === ".") {
              dataMode = false;
              sock.write("250 queued\r\n");
            }
            continue;
          }
          lines.push(line);
          const verb = line.split(" ")[0]!.toUpperCase();
          if (verb === "EHLO") sock.write("250-local\r\n250 8BITMIME\r\n");
          else if (verb === "MAIL" || verb === "RCPT") sock.write("250 ok\r\n");
          else if (verb === "DATA") {
            dataMode = true;
            sock.write("354 go\r\n");
          } else if (verb === "QUIT") {
            sock.write("221 bye\r\n");
            sock.end();
          } else sock.write("500 ?\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const mailer = createMailer({ ...memoryAdapters({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_TLS: "off" }), socket: nodeSockets }, fetch)!;
      await sendMail(mailer, { from: "a@example.com", to: "b@example.com", subject: "Hi", text: ".dot\nline" });
      expect(lines[0]).toBe("EHLO banto");
      expect(lines).toContain("MAIL FROM:<a@example.com>");
      expect(lines).toContain("RCPT TO:<b@example.com>");
      expect(lines).toContain("Subject: Hi");
      expect(lines.at(-1)).toBe("QUIT");
      // つながらない先は MailError(0)
      const dead = createMailer({ ...memoryAdapters({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: "1", SMTP_TLS: "off" }), socket: nodeSockets }, fetch)!;
      const e = await sendMail(dead, { from: "a@example.com", to: "b@example.com", subject: "x", text: "y" }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(MailError);
      expect((e as MailError).status).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
