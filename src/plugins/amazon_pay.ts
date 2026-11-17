/**
 * Amazon Pay 決済（API v2、日本・円・PayOnly）。メンテナの決定 2026-11-08、docs/plugins.md「Amazon Pay」。
 *
 * 流れ（Amazon Pay の決済ページはホスト型。カード情報は扱わない。CLAUDE.md §1-6）:
 *   最終確認 → 在庫予約 → Banto の中継ページ（ここだけ Amazon の checkout.js を読む。レジの CSP は変えない）
 *   → Amazon Pay の画面（checkoutMode: ProcessOrder）→ 戻り（checkoutResultReturnUrl）
 *   → Banto が Amazon Pay の API で状態と金額を引き直し、CompleteCheckoutSession → Charge が Captured なら確定
 * 戻りの URL の値は合図にしか使わない（どの予約かは Banto の署名、支払ったかは API の答え）。IPN は取りこぼしの保険で、
 * 届いた通知の中身は信じずに API で Charge を引き直す（src/routes/webhooks/amazon-pay.ts）。
 *
 * 必要な設定: AMAZON_PAY_PRIVATE_KEY（Secret。PEM）、AMAZON_PAY_PUBLIC_KEY_ID / AMAZON_PAY_MERCHANT_ID / AMAZON_PAY_STORE_ID（変数）、
 * 任意で AMAZON_PAY_SANDBOX=true。DB には何も置かない（CLAUDE.md §1-5）。SDK なし（WebCrypto の RSA-PSS で署名する）。
 * 有効化は hooks の送信先行（イベント購読なし）で表す。
 */
import type { BundledPlugin } from "./types";
import type { ConfigAdapter } from "../adapters/types";

export const AMAZON_PAY_HOST = "pay-api.amazon.jp";
export const AMAZON_PAY_REGION = "jp";
export const AMAZON_PAY_ALGORITHM = "AMZN-PAY-RSASSA-PSS-V2";
/** 中継ページで読む Amazon の部品（日本も同じ URL） */
export const AMAZON_PAY_SCRIPT_URL = "https://static-fe.payments-amazon.com/checkout.js";

export const AMAZON_PAY_CONFIG_KEYS = ["AMAZON_PAY_PRIVATE_KEY", "AMAZON_PAY_PUBLIC_KEY_ID", "AMAZON_PAY_MERCHANT_ID", "AMAZON_PAY_STORE_ID"] as const;

export const amazonPay: BundledPlugin = {
  id: "amazon_pay",
  manifest: {
    name: "Amazon Pay",
    version: "1.0.0",
    description: "Amazon アカウントに登録済みの支払い方法で払えるようにします（Amazon Pay のホスト型の画面）。お届け先は Banto で入力します。Stripe・KOMOJU と併用できます。",
    events: [],
    settings: [],
  },
  requiredSecrets: [...AMAZON_PAY_CONFIG_KEYS],
  secretFormats: {
    AMAZON_PAY_PRIVATE_KEY: { pattern: /-----BEGIN (RSA )?PRIVATE KEY-----/, hint: "Amazon Pay の Seller Central で作った秘密鍵（-----BEGIN PRIVATE KEY----- で始まる .pem の中身）" },
  },
  webhook: {
    path: "/webhooks/amazon-pay",
    events: ["CHARGE"],
    where: "Seller Central → 設定 → インテグレーションセントラル → 即時支払い通知（IPN）の設定 → 加盟店 URL（本番とテストは別々に設定）",
  },
};

export class AmazonPayError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly reasonCode: string | null,
  ) {
    super(message);
    this.name = "AmazonPayError";
  }
}

export interface AmazonPayAmount {
  amount: string;
  currencyCode: string;
}

export interface AmazonPayCheckoutSession {
  checkoutSessionId: string;
  statusDetails?: { state?: string; reasonCode?: string | null } | null;
  chargeId?: string | null;
  chargePermissionId?: string | null;
  paymentDetails?: { chargeAmount?: AmazonPayAmount | null } | null;
  merchantMetadata?: { merchantReferenceId?: string | null; customInformation?: string | null } | null;
}

export interface AmazonPayCharge {
  chargeId: string;
  chargePermissionId?: string | null;
  chargeAmount?: AmazonPayAmount | null;
  captureAmount?: AmazonPayAmount | null;
  refundedAmount?: AmazonPayAmount | null;
  statusDetails?: { state?: string; reasonCode?: string | null } | null;
}

export interface AmazonPayChargePermission {
  chargePermissionId: string;
  merchantMetadata?: { merchantReferenceId?: string | null; customInformation?: string | null } | null;
}

export interface AmazonPayRefund {
  refundId: string;
  statusDetails?: { state?: string } | null;
}

export interface AmazonPayCredentials {
  privateKeyPem: string;
  publicKeyId: string;
  /** 鍵 ID に環境の接頭辞（LIVE- / SANDBOX-）が無いときの環境 */
  sandbox: boolean;
}

export interface AmazonPayClient {
  getCheckoutSession(id: string): Promise<AmazonPayCheckoutSession>;
  completeCheckoutSession(id: string, amountJpy: number): Promise<AmazonPayCheckoutSession>;
  getCharge(id: string): Promise<AmazonPayCharge>;
  getChargePermission(id: string): Promise<AmazonPayChargePermission>;
  createRefund(chargeId: string, amountJpy: number, idempotencyKey: string): Promise<AmazonPayRefund>;
  /** 中継ページの支払いボタンに渡す署名（payload の文字列そのものに署名する） */
  signButtonPayload(payload: string): Promise<string>;
}

const enc = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

function b64(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

/** 円の金額の文字列（Amazon Pay は金額を文字列で受け取る。円は整数） */
export function jpyAmount(amountJpy: number): AmazonPayAmount {
  return { amount: String(Math.round(amountJpy)), currencyCode: "JPY" };
}

/** Amazon Pay の円の金額（"1000" / "1000.00"）を整数に。円でない・読めなければ null */
export function parseJpy(a: AmazonPayAmount | null | undefined): number | null {
  if (!a || typeof a.amount !== "string" || String(a.currencyCode).toUpperCase() !== "JPY") return null;
  if (!/^\d{1,9}(\.0{1,2})?$/.test(a.amount.trim())) return null;
  return Number(a.amount.trim().split(".")[0]);
}

// ---------- 秘密鍵（PEM → WebCrypto） ----------

/** DER の長さの欄 */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v >>= 8) out.unshift(v & 0xff);
  return [0x80 | out.length, ...out];
}

/** PKCS#1（BEGIN RSA PRIVATE KEY）を PKCS#8 に包む（WebCrypto は PKCS#8 しか読まない） */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  // AlgorithmIdentifier: SEQUENCE { OID rsaEncryption, NULL }
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const version = [0x02, 0x01, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length)];
  const bodyLen = version.length + algId.length + octet.length + pkcs1.length;
  const head = [0x30, ...derLength(bodyLen), ...version, ...algId, ...octet];
  const out = new Uint8Array(head.length + pkcs1.length);
  out.set(head, 0);
  out.set(pkcs1, head.length);
  return out;
}

/** PEM を PKCS#8 の DER に。Cloudflare の画面に貼ると改行が "\n" の文字になることがあるので、それも戻す */
export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const text = pem.replace(/\\n/g, "\n").trim();
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(text);
  if (!m) throw new Error("AMAZON_PAY_PRIVATE_KEY is not a PEM private key");
  const bin = atob(m[2]!.replace(/[^A-Za-z0-9+/=]/g, ""));
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  const pkcs8 = m[1] ? pkcs1ToPkcs8(der) : der;
  const out = new Uint8Array(new ArrayBuffer(pkcs8.length));
  out.set(pkcs8);
  return out;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(pem: string): Promise<CryptoKey> {
  let p = keyCache.get(pem);
  if (!p) {
    p = crypto.subtle.importKey("pkcs8", pemToPkcs8(pem), { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
    p.catch(() => keyCache.delete(pem));
    if (keyCache.size > 4) keyCache.clear();
    keyCache.set(pem, p);
  }
  return p;
}

/** 署名: StringToSign = "AMZN-PAY-RSASSA-PSS-V2\n" + hex(SHA-256(対象))、RSASSA-PSS（SHA-256、salt 32）、Base64 */
export async function amazonPaySign(pem: string, toSign: string): Promise<string> {
  const stringToSign = `${AMAZON_PAY_ALGORITHM}\n${await sha256Hex(toSign)}`;
  const sig = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, await importKey(pem), enc.encode(stringToSign));
  return b64(sig);
}

// ---------- 要求の署名 ----------

/** RFC 3986 の非予約文字のほかを %XY（大文字）に */
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** x-amz-pay-date の形（20190923T231908Z） */
export function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** 鍵 ID に環境の接頭辞があればパスに環境を入れない（Amazon Pay の SDK と同じ） */
export function amazonPayPath(creds: Pick<AmazonPayCredentials, "publicKeyId" | "sandbox">, path: string): string {
  const id = creds.publicKeyId.toUpperCase();
  if (id.startsWith("LIVE") || id.startsWith("SANDBOX")) return `/v2${path}`;
  return `/${creds.sandbox ? "sandbox" : "live"}/v2${path}`;
}

/** 正規化した要求（canonical request）を組んで、署名の見出しを返す */
export async function signedHeaders(
  creds: AmazonPayCredentials,
  req: { method: string; path: string; query?: Record<string, string>; body: string; idempotencyKey?: string; now?: Date },
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "x-amz-pay-date": amzDate(req.now ?? new Date()),
    "x-amz-pay-host": AMAZON_PAY_HOST,
    "x-amz-pay-region": AMAZON_PAY_REGION,
    ...(req.idempotencyKey ? { "x-amz-pay-idempotency-key": req.idempotencyKey } : {}),
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const query = Object.entries(req.query ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join("&");
  const uri = req.path
    .split("/")
    .map((seg) => rfc3986(decodeURIComponent(seg)))
    .join("/");
  const canonical = [req.method.toUpperCase(), uri, query, canonicalHeaders, names.join(";"), await sha256Hex(req.body)].join("\n");
  const signature = await amazonPaySign(creds.privateKeyPem, canonical);
  return { ...headers, authorization: `${AMAZON_PAY_ALGORITHM} PublicKeyId=${creds.publicKeyId}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

export function createAmazonPayClient(opts: AmazonPayCredentials & { fetch?: typeof fetch }): AmazonPayClient {
  const doFetch = opts.fetch ?? fetch;

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const fullPath = amazonPayPath(opts, path);
    const text = body === undefined ? "" : JSON.stringify(body);
    const headers = await signedHeaders(opts, { method, path: fullPath, body: text, ...(idempotencyKey ? { idempotencyKey } : {}) });
    const res = await doFetch(`https://${AMAZON_PAY_HOST}${fullPath}`, { method, headers, ...(body === undefined ? {} : { body: text }) });
    const out = await res.text();
    if (!res.ok) {
      let reason: string | null = null;
      let message = out;
      try {
        const j = JSON.parse(out) as { reasonCode?: string; message?: string };
        reason = typeof j.reasonCode === "string" ? j.reasonCode : null;
        message = j.message ?? out;
      } catch {
        /* keep text */
      }
      throw new AmazonPayError(`Amazon Pay ${res.status} ${reason ?? ""}: ${message}`.slice(0, 500), res.status, reason);
    }
    return JSON.parse(out) as T;
  }

  const seg = (id: string) => encodeURIComponent(id);
  return {
    getCheckoutSession: (id) => call("GET", `/checkoutSessions/${seg(id)}`),
    completeCheckoutSession: (id, amountJpy) => call("POST", `/checkoutSessions/${seg(id)}/complete`, { chargeAmount: jpyAmount(amountJpy) }),
    getCharge: (id) => call("GET", `/charges/${seg(id)}`),
    getChargePermission: (id) => call("GET", `/chargePermissions/${seg(id)}`),
    createRefund: (chargeId, amountJpy, idempotencyKey) => call("POST", "/refunds", { chargeId, refundAmount: jpyAmount(amountJpy) }, idempotencyKey),
    signButtonPayload: (payload) => amazonPaySign(opts.privateKeyPem, payload),
  };
}

/** 設定から。足りなければ null */
export function amazonPayFromConfig(config: Pick<ConfigAdapter, "get">, doFetch?: typeof fetch): (AmazonPayClient & { merchantId: string; storeId: string; publicKeyId: string; sandbox: boolean }) | null {
  const privateKeyPem = config.get("AMAZON_PAY_PRIVATE_KEY");
  const publicKeyId = config.get("AMAZON_PAY_PUBLIC_KEY_ID");
  const merchantId = config.get("AMAZON_PAY_MERCHANT_ID");
  const storeId = config.get("AMAZON_PAY_STORE_ID");
  if (!privateKeyPem || !publicKeyId || !merchantId || !storeId) return null;
  const sandbox = amazonPaySandbox(config);
  return { ...createAmazonPayClient({ privateKeyPem, publicKeyId, sandbox, ...(doFetch ? { fetch: doFetch } : {}) }), merchantId, storeId, publicKeyId, sandbox };
}

/** テスト環境か。鍵 ID の接頭辞が SANDBOX- ならそれに従い、無ければ AMAZON_PAY_SANDBOX */
export function amazonPaySandbox(config: Pick<ConfigAdapter, "get">): boolean {
  const id = (config.get("AMAZON_PAY_PUBLIC_KEY_ID") ?? "").toUpperCase();
  if (id.startsWith("SANDBOX")) return true;
  if (id.startsWith("LIVE")) return false;
  return /^(1|true|yes)$/i.test(config.get("AMAZON_PAY_SANDBOX") ?? "");
}

/** チェックアウトに使えるだけ揃っているか */
export function amazonPayConfigured(config: Pick<ConfigAdapter, "get">): boolean {
  return AMAZON_PAY_CONFIG_KEYS.every((k) => Boolean(config.get(k)));
}

/** Checkout Session の識別子の形（戻りの URL に付く値。API に渡す前に確かめる） */
export const CHECKOUT_SESSION_ID_RE = /^[A-Za-z0-9-]{8,100}$/;
/** Charge の識別子の形（IPN の ObjectId） */
export const CHARGE_ID_RE = /^[A-Za-z0-9-]{8,100}$/;
