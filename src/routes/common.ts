import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../app";
import { t } from "../i18n";
import { createDbClient } from "../db/client";
import type { MigrationStateDeps } from "../db/migration-state";
import { canonicalIp, relayIps } from "../commerce/checkout";
import { STOREFRONT_CACHE_TTL } from "../storefront/data";
import { privilegedFor } from "./payment-deps";
export { RELAY_LIMITS_MIGRATION } from "../commerce/checkout";

export type Ctx = Context<AppEnv>;

/**
 * フォーム POST の CSRF 対策。Cookie は SameSite=Lax だが、念のため Origin / Sec-Fetch-Site も見る。
 * Origin が付いていて自分と違えば 403（`null`（sandbox の iframe・data: 由来）も違うとみなす。ホスティングで他人のサイトと兄弟サブドメインに並ぶと
 * Lax の Cookie が same-site の POST に付くため。監査 L-1）。Sec-Fetch-Site は Origin の有無にかかわらず、cross-site / same-site なら 403。
 */
export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === "POST" || c.req.method === "PUT" || c.req.method === "DELETE" || c.req.method === "PATCH") {
    const origin = c.req.header("origin");
    if (origin !== undefined && !originIsSelf(c, origin)) {
      return c.text(t("error.csrf"), 403);
    }
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") {
      return c.text(t("error.csrf"), 403);
    }
  }
  await next();
};

/**
 * Origin が自分か。リクエストの URL のオリジンと同じか、ホストが同じ（TLS を終端するリバースプロキシの後ろでは
 * ブラウザの Origin は https、サーバーが見る URL は http になる）か、PUBLIC_BASE_URL のオリジンと同じなら自分
 */
function originIsSelf(c: Ctx, origin: string): boolean {
  const self = new URL(c.req.url);
  if (origin === self.origin) return true;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (o.host === self.host && (o.protocol === "https:" || o.protocol === "http:")) return true;
  const configured = c.get("adapters").config.get("PUBLIC_BASE_URL");
  if (!configured) return false;
  try {
    return new URL(configured).origin === o.origin;
  } catch {
    return false;
  }
}

export async function formFields(c: Ctx): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
  return out;
}

/** ルートパラメータ。Context を AppEnv で明示注釈した handler では string | undefined になるので string に寄せる */
export function param(c: Ctx, name: string): string {
  return c.req.param(name) ?? "";
}

/**
 * 利用者の IP（回数の制限に使う）。どのヘッダーを信用するかはランタイムで違うので設定で決める:
 * 既定は Cloudflare の CF-Connecting-IP。Node でリバースプロキシの後ろに置くなら CLIENT_IP_HEADER=x-forwarded-for。
 * 取れなければ null（IP ごとの上限は掛けず、メールアドレスごとの上限だけになる）
 */
export function clientIp(c: Ctx): string | null {
  const cfg = c.get("adapters").config;
  const name = (cfg.get("CLIENT_IP_HEADER") || "cf-connecting-ip").toLowerCase();
  const v = c.req.header(name);
  if (!v) return null;
  const parts = v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  // X-Forwarded-For は中継を通るたびに末尾に足される。先頭は依頼側が自由に書けるので、信頼するプロキシの段数ぶん末尾から数える
  // （TRUSTED_PROXY_HOPS、既定 1 = 直前のプロキシが足した値）。Cloudflare の CF-Connecting-IP は常に 1 つ
  const hopsRaw = cfg.get("TRUSTED_PROXY_HOPS");
  const hops = hopsRaw && /^[1-9][0-9]?$/.test(hopsRaw) ? Number(hopsRaw) : 1;
  const pick = parts[Math.max(0, parts.length - hops)]!;
  return pick.length <= 64 ? pick : null;
}

/** 信頼する中継元が購入者の IP を申告するヘッダー（0033、docs/headless.md「サーバー側で中継するとき」） */
export const RELAY_IP_HEADER = "x-banto-client-ip";

/**
 * 信頼する中継元の IP（settings.headless.relay_ips）。公開の settings には無い（0034。連携側のサーバーの素の IP なので）ため
 * service_role で読み、ショップ行と同じ時間だけキャッシュする。service_role が無い・読めないときは空（= 中継元なし）
 */
async function trustedRelayIps(c: Ctx, shopId: string): Promise<string[]> {
  const cache = c.get("adapters").cache;
  const key = `relay:${shopId}`;
  const hit = await cache.get<{ ips: string[] }>(key);
  if (hit) return hit.ips;
  const db = privilegedFor(c);
  let ips: string[] = [];
  try {
    ips = db ? relayIps({ headless: await db.shopHeadless(shopId) }) : [];
  } catch (e) {
    console.error("[banto] relay_ips:", e);
  }
  await cache.set(key, { ips }, STOREFRONT_CACHE_TTL);
  return ips;
}

/** この通信を Banto がどう見ているか（回数の制限に使う IP の決め方。GET /api/v1/relay-check が返す） */
export interface RelayStatus {
  /** Banto に届いた通信の送信元（CF-Connecting-IP）。中継構成では連携側のサーバーの IP */
  ip: string | null;
  /** X-Banto-Client-IP の値（IP の形でなければ null） */
  forwarded_ip: string | null;
  /** 送信元が中継元として宣言されているか */
  trusted_relay: boolean;
  /** 回数の制限に使う IP */
  effective_ip: string | null;
}

/**
 * ショップの画面・API で回数の制限に使う IP。X-Banto-Client-IP が付いていて、送信元が settings.headless.relay_ips の中継元なら
 * 申告された購入者の IP、そうでなければ送信元の IP（宣言していない IP からのヘッダーは無視する。誰でも名乗れるため）。
 * 中継元が申告しなければ中継元の IP のまま数える（= 以前どおりサイト全体で 1 つ。docs/headless.md「サーバー側で中継するとき」）。
 * ヘッダーが無い通信（ブラウザからの直接の通信）では DB を読まない
 */
export async function relayStatus(c: Ctx, shopId: string): Promise<RelayStatus> {
  const ip = clientIp(c);
  const header = (c.req.header(RELAY_IP_HEADER) ?? "").trim();
  const forwarded = header ? canonicalIp(header) : null;
  if (!ip || !header) return { ip, forwarded_ip: forwarded, trusted_relay: false, effective_ip: ip };
  const trusted = (await trustedRelayIps(c, shopId)).includes(canonicalIp(ip) ?? ip);
  return { ip, forwarded_ip: forwarded, trusted_relay: trusted, effective_ip: trusted && forwarded ? forwarded : ip };
}

export async function clientIpFor(c: Ctx, shop: { id: string }): Promise<string | null> {
  return (await relayStatus(c, shop.id)).effective_ip;
}

/**
 * 応答を返した後に続ける処理（知らせのメールなど）。Workers では waitUntil、それ以外（Node・テスト）ではその場で待つ。
 * 失敗はここで握りつぶさない（渡す側で catch しておく）
 */
export async function afterResponse(c: Ctx, work: Promise<unknown>): Promise<void> {
  let ctx: { waitUntil(p: Promise<unknown>): void } | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  if (ctx) ctx.waitUntil(work);
  else await work;
}

/** https で届いたか。TLS を終端するリバースプロキシの後ろ（Node）では URL が http になるので、PUBLIC_BASE_URL が https ならそれに従う */
export function isSecureRequest(c: Ctx): boolean {
  if (new URL(c.req.url).protocol === "https:") return true;
  const configured = c.get("adapters").config.get("PUBLIC_BASE_URL");
  return Boolean(configured && /^https:/i.test(configured));
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function yen(n: number): string {
  return `¥${n.toLocaleString("ja-JP")}`;
}

/** 外から見た URL。PUBLIC_BASE_URL が未設定ならリクエストの origin（Deploy ボタン利用者が設定を省けるように） */
export function publicBaseUrl(c: Ctx): string {
  const configured = c.get("adapters").config.get("PUBLIC_BASE_URL");
  return (configured || new URL(c.req.url).origin).replace(/\/+$/, "");
}

/** 画像 URL の起点。MEDIA_BASE_URL が未設定なら <publicBaseUrl>/media（Worker 自身が配信） */
export function mediaBaseUrl(c: Ctx): string {
  const configured = c.get("adapters").config.get("MEDIA_BASE_URL");
  return (configured || `${publicBaseUrl(c)}/media`).replace(/\/+$/, "");
}

/** migrated() に渡す anon の DbClient とキャッシュ（anon キーが無ければ null = 新しいマイグレーションの機能は出さない） */
export function migrationStateFor(c: Ctx, url: string): MigrationStateDeps | null {
  const anonKey = c.get("adapters").config.get("SUPABASE_ANON_KEY");
  return anonKey ? { db: createDbClient({ url, anonKey, fetch: c.get("deps").fetch }), cache: c.get("adapters").cache } : null;
}
