/**
 * Amazon SNS のメッセージの署名を確かめる（Amazon Pay の IPN は SNS の封筒で届く）。WebCrypto だけ・ライブラリなし。
 *
 * - 署名の版は 1（SHA1withRSA）と 2（SHA256withRSA）。正規化した文字列は AWS の決まりどおり、種類ごとに決まった鍵を
 *   「鍵\n値\n」で名前の順に並べる（Notification は Subject があるときだけ Subject を入れる）。
 * - 署名の証明書は SigningCertURL から取る。https・ホストが `sns.<リージョン>.amazonaws.com`・パスが .pem のものだけ。
 *   証明書の信頼は「Amazon の SNS のホストから TLS で取った」ことに置く（証明書の連鎖は確かめない）。
 *   取った証明書の公開鍵（SubjectPublicKeyInfo）は CacheAdapter に 1 日覚える（URL ごと）。
 * - Timestamp が古すぎる（72 時間より前）・先すぎる（15 分より後）ものは断る。中身は API で引き直して冪等に処理するので、
 *   同じ通知が何度届いても注文は 1 回だけ。時間の幅は再送が届く余地を残しつつ、古い通知の使い回しの幅を区切るためのもの。
 */
import type { CacheAdapter } from "../adapters/types";

export type SnsMessage = Record<string, unknown>;
export type SnsVerifyResult = { ok: true; envelope: SnsMessage } | { ok: false; reason: SnsRejectReason };
export type SnsRejectReason = "malformed" | "type" | "version" | "cert_url" | "cert" | "timestamp" | "signature";

const CERT_HOST_RE = /^sns\.[a-z0-9-]{1,40}\.amazonaws\.com$/;
const CERT_MAX_BYTES = 16 * 1024;
const CERT_TTL_SECONDS = 86400;
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
  return u.protocol === "https:" && u.port === "" && u.username === "" && u.password === "" && CERT_HOST_RE.test(u.hostname) && u.pathname.endsWith(".pem");
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

/** 証明書の公開鍵（SPKI の base64）。覚えていればそれ、無ければ取りに行く。取れない・読めなければ null */
async function certPublicKey(url: string, doFetch: typeof fetch, cache: CacheAdapter | undefined): Promise<string | null> {
  const key = CACHE_PREFIX + url;
  const cached = cache ? await cache.get<string>(key) : null;
  if (cached) return cached;
  let res: Response;
  try {
    res = await doFetch(url, { redirect: "manual" });
  } catch {
    return null;
  }
  if (res.status !== 200) return null;
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > CERT_MAX_BYTES) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > CERT_MAX_BYTES) return null;
  let spki: string;
  try {
    spki = bytesToB64(certSpki(pemCertToDer(new TextDecoder().decode(buf))));
  } catch {
    return null;
  }
  if (cache) await cache.set(key, spki, CERT_TTL_SECONDS);
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
  if (!snsCertUrlOk(m["SigningCertURL"])) return { ok: false, reason: "cert_url" };

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
