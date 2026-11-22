/**
 * Google の ID トークンの署名を確かめる（RS256、Google の公開鍵 JWKS）。WebCrypto だけ・ライブラリなし。
 *
 * トークンはトークンのエンドポイントから HTTPS で直接・クライアントシークレットで受け取るので、OpenID Connect Core 3.1.3.7 では
 * 署名の検証を省いてもよいが、取得の経路が変わっても弱くならないよう多層防御として確かめる（2026-11-22）。
 *
 * - 見出しの alg は RS256 だけ（none・HS256 などは断る）。kid で鍵を選ぶ。crit は受けない。
 * - 鍵は Cache-Control の max-age（60 秒〜1 日、無ければ 1 時間）まで CacheAdapter に覚える。
 *   知らない kid なら 1 回だけ取り直す（Google が鍵を回した直後）。それでも無ければ断る。
 * - iss・aud・nonce・期限・iat などの中身の確かめは providers.ts（LINE と共通の判定）。
 */
import type { CacheAdapter } from "../../adapters/types";
import { fromB64url } from "../../util/signed";

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const CACHE_KEY = "oauth:google:jwks";
const TTL_DEFAULT = 3600;
const TTL_MIN = 60;
const TTL_MAX = 86400;

interface RsaJwk {
  kid: string;
  n: string;
  e: string;
}

export class IdTokenError extends Error {}

/** Cache-Control の max-age（秒）。無ければ既定、範囲の外は寄せる */
export function jwksTtl(cacheControl: string | null): number {
  const m = /(?:^|[,\s])max-age=(\d+)/i.exec(cacheControl ?? "");
  const n = m ? Number(m[1]) : TTL_DEFAULT;
  return Math.min(Math.max(Number.isFinite(n) ? n : TTL_DEFAULT, TTL_MIN), TTL_MAX);
}

/** JWKS の本文 → 署名に使える RSA の鍵（RS256・sig のものだけ） */
export function rsaKeysOf(body: unknown): RsaJwk[] {
  const keys = body && typeof body === "object" ? (body as { keys?: unknown }).keys : null;
  if (!Array.isArray(keys)) return [];
  const out: RsaJwk[] = [];
  for (const k of keys) {
    if (!k || typeof k !== "object") continue;
    const j = k as Record<string, unknown>;
    if (j["kty"] !== "RSA" || typeof j["kid"] !== "string" || typeof j["n"] !== "string" || typeof j["e"] !== "string") continue;
    if (j["use"] !== undefined && j["use"] !== "sig") continue;
    if (j["alg"] !== undefined && j["alg"] !== "RS256") continue;
    out.push({ kid: j["kid"], n: j["n"], e: j["e"] });
  }
  return out;
}

async function fetchKeys(doFetch: typeof fetch, cache: CacheAdapter | undefined): Promise<RsaJwk[]> {
  // 通信の失敗（名前の解決・TLS・切断）もログインの失敗として扱う（500 にしない）
  let res: Response;
  try {
    res = await doFetch(GOOGLE_JWKS_URL, { headers: { accept: "application/json" } });
  } catch {
    throw new IdTokenError("jwks fetch");
  }
  if (!res.ok) throw new IdTokenError(`jwks HTTP ${res.status}`);
  const keys = rsaKeysOf(await res.json().catch(() => null));
  if (keys.length === 0) throw new IdTokenError("jwks empty");
  if (cache) await cache.set(CACHE_KEY, keys, jwksTtl(res.headers.get("cache-control")));
  return keys;
}

function decodeJson(part: string | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(new TextDecoder().decode(fromB64url(part ?? ""))) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // 下で断る
  }
  throw new IdTokenError("malformed");
}

/**
 * ID トークンの署名を確かめ、中身（クレーム）を返す。署名・見出しが合わなければ IdTokenError。
 * 中身の値（iss・aud・nonce・期限）はここでは見ない（呼び出し側）
 */
export async function verifyGoogleIdToken(idToken: string, doFetch: typeof fetch, cache?: CacheAdapter): Promise<Record<string, unknown>> {
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new IdTokenError("malformed");
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJson(h);
  if (header["alg"] !== "RS256") throw new IdTokenError("alg");
  if (typeof header["kid"] !== "string" || header["kid"] === "") throw new IdTokenError("kid");
  if (header["crit"] !== undefined) throw new IdTokenError("crit");
  const kid = header["kid"];

  const cached = cache ? await cache.get<RsaJwk[]>(CACHE_KEY) : null;
  let keys = (cached ?? []).filter((k) => k.kid === kid);
  // 知らない kid: 覚えた鍵を使っていたなら 1 回だけ取り直す（Google が鍵を回した直後）
  if (keys.length === 0) keys = (await fetchKeys(doFetch, cache)).filter((k) => k.kid === kid);
  if (keys.length === 0) throw new IdTokenError("unknown kid");

  // 同じ kid の鍵が複数あってもどれかで合えばよい（ふつうは 1 つ）
  let ok = false;
  for (const key of keys.slice(0, 3)) {
    try {
      const pub = await crypto.subtle.importKey("jwk", { kty: "RSA", n: key.n, e: key.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, fromB64url(s), new TextEncoder().encode(`${h}.${p}`));
    } catch {
      ok = false;
    }
    if (ok) break;
  }
  if (!ok) throw new IdTokenError("signature");
  return decodeJson(p);
}
