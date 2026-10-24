/**
 * 管理画面セッション: Supabase Auth のトークンを AES-GCM で封をして Cookie に載せる（0030。それまでは HMAC の署名だけで、
 * Cookie が漏れると 30 日有効な refresh_token がそのまま読めた）。鍵はサイトの秘密から導出する（src/members/secret-box.ts と同じ仕組み）。
 * SESSION_SECRET は Workers Secret（ウィザードが生成を案内）。
 */
import { randomToken } from "../util/signed";
import { openSecret, sealSecret } from "../members/secret-box";

export interface SessionData {
  access_token: string;
  refresh_token: string;
  /** epoch 秒 */
  expires_at: number;
  user_id: string;
  email?: string;
  /** 運営者のセッションの世代（0030。ログアウトで上がり、古い Cookie は使えなくなる）。0030 より前の DB では無い */
  epoch?: number;
  /**
   * 二段階認証の途中（0054）。challenge: パスワードは済んだが 6 桁がまだ / enroll: 組織が必須にしたのにまだ登録していない。
   * このあいだ管理画面は /admin/mfa だけ（DB 側も banto_pre_request が aal1 の JWT を止める）
   */
  mfa?: "challenge" | "enroll";
}

const COOKIE_SCOPE = "admin";
const COOKIE_PURPOSE = "session";

export const SESSION_COOKIE = "banto_admin";

const derivedCache = new Map<string, string>();

/**
 * セッション/署名用の秘密。SESSION_SECRET が設定されていればそれ、無ければ SUPABASE_SERVICE_ROLE_KEY から導出する
 * （運営者が貼る Secret を1つに減らすため）。service_role キーを変えると、セッションと hooks の署名シークレットも変わる。
 */
export async function resolveSessionSecret(config: { get(name: string): string | undefined }): Promise<string | undefined> {
  const explicit = config.get("SESSION_SECRET");
  if (explicit) return explicit;
  const serviceRole = config.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRole) return undefined;
  const hit = derivedCache.get(serviceRole);
  if (hit) return hit;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(serviceRole), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("banto:session-secret:v1"));
  const derived = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
  derivedCache.set(serviceRole, derived);
  return derived;
}

export function sealSession(secret: string, data: SessionData): Promise<string> {
  return sealSecret(secret, COOKIE_SCOPE, COOKIE_PURPOSE, JSON.stringify(data));
}

/** 開けなければ null（別の秘密・改ざん・古い形式）。期限切れは呼び出し側で refresh する */
export async function openSession(secret: string, cookie: string | undefined): Promise<SessionData | null> {
  if (!cookie) return null;
  const text = await openSecret(secret, COOKIE_SCOPE, COOKIE_PURPOSE, cookie);
  if (text === null) return null;
  let data: Partial<SessionData>;
  try {
    data = JSON.parse(text) as Partial<SessionData>;
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || typeof data.user_id !== "string") return null;
  if (typeof data.expires_at !== "number") return null;
  if (data.epoch !== undefined && typeof data.epoch !== "number") return null;
  return data as SessionData;
}

/** SESSION_SECRET の生成（ウィザードが表示する） */
export function generateSecret(bytes = 32): string {
  return randomToken(bytes);
}

export function sessionCookieHeader(value: string, opts: { secure: boolean; maxAgeSeconds?: number }): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/admin",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${opts.maxAgeSeconds ?? 60 * 60 * 24 * 30}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0`;
}
