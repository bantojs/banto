/**
 * Amazon SNS のメッセージの署名を確かめる（Amazon Pay の IPN は SNS の封筒で届く）。WebCrypto だけ・ライブラリなし。
 *
 * - 署名の版は 1（SHA1withRSA）と 2（SHA256withRSA）。正規化した文字列は AWS の決まりどおり、種類ごとに決まった鍵を
 *   「鍵\n値\n」で名前の順に並べる（Notification は Subject があるときだけ Subject を入れる）。
 * - 署名の証明書は SigningCertURL から取る。https・ホストが `sns.<リージョン>.amazonaws.com`（リージョンの形のものだけ）・
 *   パスが .pem・クエリとフラグメントなしのものだけ。証明書の信頼は「Amazon の SNS のホストから TLS で取った」ことに置く
 *   （証明書の連鎖は確かめない）。取った証明書の公開鍵（SubjectPublicKeyInfo）は CacheAdapter に 1 日覚える（オリジン + パスごと）。
 *   取れなかった URL は 1 分覚えて続けて取りに行かない。取りに行くのは 5 秒まで・16 KiB まで（読みながら数える）。
 * - 署名が合うことは「どこかの SNS のトピックから送られた」ことしか示さない（だれでも自分のトピックで署名つきの通知を作れる）。
 *   どのトピックから来たものを受けるかは呼び出し側が TopicArn で決める（snsTopicArn）。ここでは TopicArn が AWS の
 *   （aws の区画の）SNS のトピックの形であることと、署名の証明書のホストのリージョンがトピックのリージョンと同じことだけを確かめる。
 * - Timestamp が古すぎる（72 時間より前）・先すぎる（15 分より後）ものは断る。中身は API で引き直して冪等に処理するので、
 *   同じ通知が何度届いても注文は 1 回だけ。時間の幅は再送が届く余地を残しつつ、古い通知の使い回しの幅を区切るためのもの。
 */
import type { CacheAdapter } from "../adapters/types";

export type SnsMessage = Record<string, unknown>;
export type SnsVerifyResult = { ok: true; envelope: SnsMessage } | { ok: false; reason: SnsRejectReason };
export type SnsRejectReason = "malformed" | "type" | "version" | "topic" | "cert_url" | "cert" | "timestamp" | "signature";

/** sns.<リージョン>.amazonaws.com（us-east-1・ap-northeast-1・us-gov-west-1 など。S3 のバケットの形の sns.s3… は当たらない） */
const CERT_HOST_RE = /^sns\.[a-z]{2}(?:-gov|-iso[a-z]?)?-[a-z]+-\d{1,2}\.amazonaws\.com$/;
const CERT_MAX_BYTES = 16 * 1024;
const CERT_TTL_SECONDS = 86400;
const CERT_FAIL_TTL_SECONDS = 60;
const CERT_FETCH_TIMEOUT_MS = 5000;
export const SNS_MAX_AGE_MS = 72 * 3600 * 1000;
const SNS_MAX_SKEW_MS = 15 * 60 * 1000;

const NOTIFICATION_KEYS = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const;
const SUBSCRIPTION_KEYS = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"] as const;

/** 署名する文字列（AWS の決まり）。必要な鍵が欠けていれば null */
export function snsStringToSign(m: SnsMessage): string | null {
  const type = m["Type"];
  const keys = type === "Notification" ? NOTIFICATION_KEYS : type === "SubscriptionConfirmation" || type === "UnsubscribeConfirmation" ? SUBSCRIPTION_KEYS : null;
  if (!keys) return null;
  let out = "";
  for (const k of keys) {
    const v = m[k];
    if (v === undefined || v === null) {
      if (k === "Subject") continue;
      return null;
    }
    if (typeof v !== "string") return null;
    out += `${k}\n${v}\n`;
  }
  return out;
}

/** 証明書の URL が Amazon の SNS のものか（https・ホスト・.pem・利用者情報やポートなし） */
export function snsCertUrlOk(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 512) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    u.port === "" &&
    u.username === "" &&
    u.password === "" &&
    u.search === "" &&
    u.hash === "" &&
    !raw.includes("?") &&
    !raw.includes("#") &&
    CERT_HOST_RE.test(u.hostname) &&
    u.pathname.endsWith(".pem")
  );
}

export interface SnsTopic {
  region: string;
  account: string;
  name: string;
  arn: string;
}

/**
 * TopicArn（arn:aws:sns:<リージョン>:<アカウント>:<名前>）を分ける。形が違えば null。
 * 区画は aws だけ（中国・政府の区画の ARN は受けない）。名前に「.」は入らない（FIFO のトピックの .fifo は来ない想定）
 */
export function snsTopicArn(raw: unknown): SnsTopic | null {
  if (typeof raw !== "string" || raw.length > 300) return null;
  const m = /^arn:aws:sns:([a-z]{2}(?:-gov|-iso[a-z]?)?-[a-z]+-\d{1,2}):(\d{12}):([A-Za-z0-9_-]{1,256})$/.exec(raw);
  return m ? { region: m[1]!, account: m[2]!, name: m[3]!, arn: raw } : null;
}

// ---- DER（X.509 の中から SubjectPublicKeyInfo を取り出すだけの小さな読み手） ----

interface Tlv {
  tag: number;
  /** この要素の先頭（タグの位置） */
  start: number;
  /** 中身の先頭 */
  body: number;
  /** この要素の終わり（次の要素の先頭） */
  end: number;
}

function readTlv(b: Uint8Array, at: number, limit: number): Tlv {
  if (at + 2 > limit) throw new Error("der");
  const tag = b[at]!;
  let len = b[at + 1]!;
  let p = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || p + n > limit) throw new Error("der");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p + i]!;
    p += n;
  }
  if (p + len > limit) throw new Error("der");
  return { tag, start: at, body: p, end: p + len };
}

/** X.509 の証明書（DER）→ SubjectPublicKeyInfo（DER）。形が違えば例外 */
export function certSpki(der: Uint8Array): Uint8Array {
  const cert = readTlv(der, 0, der.length);
  if (cert.tag !== 0x30) throw new Error("der");
  const tbs = readTlv(der, cert.body, cert.end);
  if (tbs.tag !== 0x30) throw new Error("der");
  let p = tbs.body;
  let first = readTlv(der, p, tbs.end);
  // [0] version は省かれることがある
  if (first.tag === 0xa0) {
    p = first.end;
    first = readTlv(der, p, tbs.end);
  }
  // serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo
  const expected = [0x02, 0x30, 0x30, 0x30, 0x30, 0x30];
  let el = first;
  for (let i = 0; i < expected.length; i++) {
    if (i > 0) el = readTlv(der, p, tbs.end);
    if (el.tag !== expected[i]) throw new Error("der");
    if (i === expected.length - 1) return der.slice(el.start, el.end);
    p = el.end;
  }
  throw new Error("der");
}

function b64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** PEM（最初の CERTIFICATE）→ DER */
export function pemCertToDer(pem: string): Uint8Array {
  const m = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem);
  if (!m) throw new Error("pem");
  return b64ToBytes(m[1]!.replace(/\s+/g, ""));
}

const CACHE_PREFIX = "sns:cert:";
const FAIL_PREFIX = "sns:certfail:";

/** 本文を上限まで、読みながら数える。超えたら null */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** 証明書の公開鍵（SPKI の base64）。覚えていればそれ、無ければ取りに行く。取れない・読めなければ null */
async function certPublicKey(rawUrl: string, doFetch: typeof fetch, cache: CacheAdapter | undefined): Promise<string | null> {
  const u = new URL(rawUrl);
  const url = u.origin + u.pathname;
  const cached = cache ? await cache.get<string>(CACHE_PREFIX + url) : null;
  if (cached) return cached;
  if (cache && (await cache.get<boolean>(FAIL_PREFIX + url))) return null;
  const fail = async (): Promise<null> => {
    if (cache) await cache.set(FAIL_PREFIX + url, true, CERT_FAIL_TTL_SECONDS);
    return null;
  };
  let res: Response;
  try {
    res = await doFetch(url, { redirect: "manual", signal: AbortSignal.timeout(CERT_FETCH_TIMEOUT_MS) });
  } catch {
    return fail();
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    return fail();
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > CERT_MAX_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    return fail();
  }
  let buf: Uint8Array | null;
  try {
    buf = await readCapped(res, CERT_MAX_BYTES);
  } catch {
    return fail();
  }
  if (!buf) return fail();
  let spki: string;
  try {
    spki = bytesToB64(certSpki(pemCertToDer(new TextDecoder().decode(buf))));
  } catch {
    return fail();
  }
  if (cache) await cache.set(CACHE_PREFIX + url, spki, CERT_TTL_SECONDS);
  return spki;
}

/** SNS の封筒（JSON を開いたもの）の署名と時刻を確かめる */
export async function verifySnsMessage(envelope: unknown, opts: { fetch: typeof fetch; cache?: CacheAdapter; now?: number }): Promise<SnsVerifyResult> {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return { ok: false, reason: "malformed" };
  const m = envelope as SnsMessage;
  const toSign = snsStringToSign(m);
  if (toSign === null) return { ok: false, reason: m["Type"] === undefined ? "malformed" : "type" };
  const version = m["SignatureVersion"];
  if (version !== "1" && version !== "2") return { ok: false, reason: "version" };
  const sig = m["Signature"];
  if (typeof sig !== "string" || sig.length === 0 || sig.length > 4096 || !/^[A-Za-z0-9+/=]+$/.test(sig)) return { ok: false, reason: "malformed" };
  const topic = snsTopicArn(m["TopicArn"]);
  if (!topic) return { ok: false, reason: "topic" };
  if (!snsCertUrlOk(m["SigningCertURL"])) return { ok: false, reason: "cert_url" };
  // 証明書はトピックと同じリージョンの SNS のもの
  if (new URL(m["SigningCertURL"]).hostname !== `sns.${topic.region}.amazonaws.com`) return { ok: false, reason: "cert_url" };

  const ts = Date.parse(String(m["Timestamp"]));
  const now = opts.now ?? Date.now();
  if (!Number.isFinite(ts) || now - ts > SNS_MAX_AGE_MS || ts - now > SNS_MAX_SKEW_MS) return { ok: false, reason: "timestamp" };

  const spki = await certPublicKey(m["SigningCertURL"], opts.fetch, opts.cache);
  if (!spki) return { ok: false, reason: "cert" };
  let ok = false;
  try {
    const pub = await crypto.subtle.importKey("spki", b64ToBytes(spki), { name: "RSASSA-PKCS1-v1_5", hash: version === "1" ? "SHA-1" : "SHA-256" }, false, ["verify"]);
    ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, b64ToBytes(sig), new TextEncoder().encode(toSign));
  } catch {
    ok = false;
  }
  return ok ? { ok: true, envelope: m } : { ok: false, reason: "signature" };
}
