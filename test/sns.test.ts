import { beforeAll, describe, expect, it } from "vitest";
import type { CacheAdapter } from "../src/adapters/types";
import { SNS_MAX_AGE_MS, certSpki, pemCertToDer, snsCertUrlOk, snsStringToSign, snsTopicArn, verifySnsMessage } from "../src/payments/sns";
import { SNS_CERT_URL, minimalCertPem, snsSigner, type SnsSigner } from "./sns-fixture";

/** Amazon SNS のメッセージの署名（src/payments/sns.ts） */
let S: SnsSigner;
beforeAll(async () => {
  S = await snsSigner();
});

function memCache(): CacheAdapter {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
  };
}

function certFetch(counter: { n: number }, status = 200): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    counter.n++;
    if (String(input) !== SNS_CERT_URL) return new Response("no", { status: 404 });
    return new Response(status === 200 ? S.pem : "no", { status });
  }) as typeof fetch;
}

const msg = { MerchantID: "M123", ObjectType: "CHARGE", ObjectId: "ch-1-bbbbbbbb" };

describe("SNS の署名", () => {
  it("署名の版 2（SHA256withRSA）と 1（SHA1withRSA）を確かめる", async () => {
    const n = { n: 0 };
    for (const version of ["2", "1"] as const) {
      const r = await verifySnsMessage(JSON.parse(await S.envelope(msg, { version })), { fetch: certFetch(n) });
      expect(r.ok).toBe(true);
    }
  });

  it("中身を書き換えた・署名が無い・版が知らないものは断る", async () => {
    const n = { n: 0 };
    const tampered = await S.envelope(msg, { tamper: (m) => void (m["Message"] = JSON.stringify({ ...msg, ObjectId: "ch-2-cccccccc" })) });
    expect(await verifySnsMessage(JSON.parse(tampered), { fetch: certFetch(n) })).toEqual({ ok: false, reason: "signature" });
    const noSig = await S.envelope(msg, { tamper: (m) => void delete m["Signature"] });
    expect(await verifySnsMessage(JSON.parse(noSig), { fetch: certFetch(n) })).toEqual({ ok: false, reason: "malformed" });
    const v3 = await S.envelope(msg, { tamper: (m) => void (m["SignatureVersion"] = "3") });
    expect(await verifySnsMessage(JSON.parse(v3), { fetch: certFetch(n) })).toEqual({ ok: false, reason: "version" });
    // 署名を別の版で読ませても合わない
    const asV1 = await S.envelope(msg, { tamper: (m) => void (m["SignatureVersion"] = "1") });
    expect(await verifySnsMessage(JSON.parse(asV1), { fetch: certFetch(n) })).toEqual({ ok: false, reason: "signature" });
    expect(await verifySnsMessage("x", { fetch: certFetch(n) })).toEqual({ ok: false, reason: "malformed" });
    expect(await verifySnsMessage({ Message: "x" }, { fetch: certFetch(n) })).toEqual({ ok: false, reason: "malformed" });
  });

  it("証明書の URL は https・Amazon の SNS のホスト・.pem だけ（取りに行く前に断る）", async () => {
    const n = { n: 0 };
    for (const url of [
      "http://sns.ap-northeast-1.amazonaws.com/x.pem",
      "https://sns.ap-northeast-1.amazonaws.com.evil.example/x.pem",
      "https://evil.example/sns.ap-northeast-1.amazonaws.com.pem",
      "https://sns.ap-northeast-1.amazonaws.com/x.txt",
      "https://user@sns.ap-northeast-1.amazonaws.com/x.pem",
      "https://sns.ap-northeast-1.amazonaws.com:8443/x.pem",
      // S3 のバケットの形（sns という名前のバケット）
      "https://sns.s3.amazonaws.com/x.pem",
      "https://sns.s3-us-west-2.amazonaws.com/x.pem",
      "https://sns.s3.us-west-2.amazonaws.com/x.pem",
      // クエリ・フラグメント
      "https://sns.ap-northeast-1.amazonaws.com/x.pem?a=b",
      "https://sns.ap-northeast-1.amazonaws.com/x.pem?",
      "https://sns.ap-northeast-1.amazonaws.com/x.pem#f",
    ]) {
      expect(snsCertUrlOk(url)).toBe(false);
      const env = await S.envelope(msg, { overrides: { SigningCertURL: url } });
      expect(await verifySnsMessage(JSON.parse(env), { fetch: certFetch(n) })).toEqual({ ok: false, reason: "cert_url" });
    }
    expect(n.n).toBe(0);
    expect(snsCertUrlOk(SNS_CERT_URL)).toBe(true);
    expect(snsCertUrlOk("https://sns.us-gov-west-1.amazonaws.com/x.pem")).toBe(true);
    expect(snsCertUrlOk("https://sns.us-east-1.amazonaws.com/SimpleNotificationService-a86cb10b4e1f29c941702d737128f7b6.pem")).toBe(true);
  });

  it("TopicArn を分ける", () => {
    expect(snsTopicArn("arn:aws:sns:us-east-1:291180941288:A3BXB0YN3XH17HAEMGQX8TKDO54")).toEqual({ region: "us-east-1", account: "291180941288", name: "A3BXB0YN3XH17HAEMGQX8TKDO54", arn: "arn:aws:sns:us-east-1:291180941288:A3BXB0YN3XH17HAEMGQX8TKDO54" });
    for (const bad of ["arn:aws-cn:sns:cn-north-1:291180941288:x", "arn:aws-us-gov:sns:us-gov-west-1:291180941288:x", "arn:aws:sns:us-east-1:291180941288:t.fifo", "arn:aws:sns:us-east-1:2911809412:x", "arn:aws:sqs:us-east-1:291180941288:x", "arn:aws:sns:s3:291180941288:x", "arn:aws:sns:us-east-1:291180941288:", "x", 1, null]) expect(snsTopicArn(bad)).toBeNull();
  });

  it("証明書の応答: リダイレクト・大きすぎる・読めないものは断り、1 分は取りに行き直さない", async () => {
    const make = (res: () => Response) => {
      const n = { n: 0 };
      const f = (async () => {
        n.n++;
        return res();
      }) as unknown as typeof fetch;
      return { n, f };
    };
    for (const res of [
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/x.pem" } }),
      () => new Response("x".repeat(17 * 1024), { status: 200 }),
      () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 20; i++) c.enqueue(new Uint8Array(1024)); c.close(); } }), { status: 200 }),
      () => new Response("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n", { status: 200 }),
    ]) {
      const { n, f } = make(res);
      const cache = memCache();
      const env = JSON.parse(await S.envelope(msg));
      expect(await verifySnsMessage(env, { fetch: f, cache })).toEqual({ ok: false, reason: "cert" });
      expect(await verifySnsMessage(env, { fetch: f, cache })).toEqual({ ok: false, reason: "cert" });
      expect(n.n).toBe(1);
    }
  });

  it("証明書はオリジンとパスで取りに行く（クエリは送らない）", async () => {
    const urls: string[] = [];
    const f = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(S.pem, { status: 200 });
    }) as typeof fetch;
    expect((await verifySnsMessage(JSON.parse(await S.envelope(msg)), { fetch: f })).ok).toBe(true);
    expect(urls).toEqual([SNS_CERT_URL]);
  });

  it("TopicArn が aws の SNS のトピックでない・証明書のリージョンがトピックと違うものは断る", async () => {
    const n = { n: 0 };
    for (const TopicArn of [undefined, "x", "arn:aws-cn:sns:cn-north-1:000000000000:t", "arn:aws:sns:ap-northeast-1:000000000000:t.fifo"]) {
      const env = await S.envelope(msg, { overrides: { TopicArn: "arn:aws:sns:ap-northeast-1:000000000000:t" }, tamper: (m) => void (TopicArn === undefined ? delete m["TopicArn"] : (m["TopicArn"] = TopicArn)) });
      expect(await verifySnsMessage(JSON.parse(env), { fetch: certFetch(n) })).toMatchObject({ ok: false });
    }
    const other = await S.envelope(msg, { overrides: { TopicArn: "arn:aws:sns:us-east-1:000000000000:t" } });
    expect(await verifySnsMessage(JSON.parse(other), { fetch: certFetch(n) })).toEqual({ ok: false, reason: "cert_url" });
    expect(n.n).toBe(0);
  });

  it("古すぎる・先すぎる Timestamp は断る", async () => {
    const n = { n: 0 };
    const now = Date.now();
    const old = await S.envelope(msg, { overrides: { Timestamp: new Date(now - SNS_MAX_AGE_MS - 60_000).toISOString() } });
    expect(await verifySnsMessage(JSON.parse(old), { fetch: certFetch(n), now })).toEqual({ ok: false, reason: "timestamp" });
    const future = await S.envelope(msg, { overrides: { Timestamp: new Date(now + 3600_000).toISOString() } });
    expect(await verifySnsMessage(JSON.parse(future), { fetch: certFetch(n), now })).toEqual({ ok: false, reason: "timestamp" });
    const recent = await S.envelope(msg, { overrides: { Timestamp: new Date(now - 3600_000).toISOString() } });
    expect((await verifySnsMessage(JSON.parse(recent), { fetch: certFetch(n), now })).ok).toBe(true);
  });

  it("証明書は URL ごとに覚える。取れない証明書は断る", async () => {
    const n = { n: 0 };
    const cache = memCache();
    for (let i = 0; i < 3; i++) expect((await verifySnsMessage(JSON.parse(await S.envelope(msg)), { fetch: certFetch(n), cache })).ok).toBe(true);
    expect(n.n).toBe(1);
    const failing = { n: 0 };
    expect(await verifySnsMessage(JSON.parse(await S.envelope(msg)), { fetch: certFetch(failing, 404) })).toEqual({ ok: false, reason: "cert" });
  });

  it("購読の確認の封筒も決まった鍵で確かめる", async () => {
    const n = { n: 0 };
    const env = await S.envelope("You have chosen to subscribe", { overrides: { Type: "SubscriptionConfirmation", SubscribeURL: "https://sns.ap-northeast-1.amazonaws.com/?Action=ConfirmSubscription", Token: "t" } });
    expect((await verifySnsMessage(JSON.parse(env), { fetch: certFetch(n) })).ok).toBe(true);
    expect(snsStringToSign({ Type: "SubscriptionConfirmation", Message: "m", MessageId: "i", Timestamp: "t", TopicArn: "a" })).toBeNull();
    // Notification の Subject は、あるときだけ入る
    expect(snsStringToSign({ Type: "Notification", Message: "m", MessageId: "i", Subject: "s", Timestamp: "t", TopicArn: "a" })).toBe("Message\nm\nMessageId\ni\nSubject\ns\nTimestamp\nt\nTopicArn\na\nType\nNotification\n");
  });

  it("証明書の中の公開鍵を取り出す（version の有無どちらも）", async () => {
    const spki = certSpki(pemCertToDer(S.pem));
    expect(spki[0]).toBe(0x30);
    const again = minimalCertPem(spki, false);
    expect(Array.from(certSpki(pemCertToDer(again)))).toEqual(Array.from(spki));
    expect(() => certSpki(new Uint8Array([0x30, 0x03, 0x02, 0x01]))).toThrow();
    // 途中で切れた DER・長さの形の誤り（長い形の長さが本文より長い・長さのバイト数 0）
    const der = pemCertToDer(S.pem);
    expect(der[1]! & 0x80).toBe(0x80);
    for (const cut of [10, 100, der.length - 1]) expect(() => certSpki(der.slice(0, cut))).toThrow();
    expect(() => certSpki(new Uint8Array([0x30, 0x84, 0xff, 0xff, 0xff, 0xff, 0x00]))).toThrow();
    expect(() => certSpki(new Uint8Array([0x30, 0x80, 0x00]))).toThrow();
    expect(() => pemCertToDer("nope")).toThrow();
  });
});
