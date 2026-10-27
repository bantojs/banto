/**
 * AI 用トークン（docs/ai-access.md）。生トークンは発行時に一度だけ表示し、DB には SHA-256 と接頭辞だけを保存する。
 */
import { randomToken } from "../util/signed";

export const TOKEN_PREFIX = "banto_";

export const API_SCOPES = [
  "products:read",
  "products:write",
  "orders:read",
  "orders:pii",
  "orders:write",
  "shop:read",
  "shop:write",
  "stats:read",
  "coupons:read",
  "coupons:write",
  "customers:read",
  "customers:write",
  "inquiries:read",
  "inquiries:write",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** お問い合わせのスコープ（0061 が当たるまで発行できない。src/modules/inquiries の INQUIRIES_MIGRATION と同じ版） */
export const API_INQUIRIES_MIGRATION = "0061_mod_inquiries";
/** AI 用 API でお問い合わせの添付を扱う（返事に添付・お客様の添付を受け取る） */
export const API_INQUIRY_ATTACHMENTS_MIGRATION = "0064_inquiry_api_attachments";
export const SCOPES_0061: readonly ApiScope[] = ["inquiries:read", "inquiries:write"];

/** 既定で選ばれるスコープ（読み取りのみ、個人情報なし） */
export const DEFAULT_SCOPES: readonly ApiScope[] = ["products:read", "orders:read", "shop:read", "stats:read"];

/**
 * スコープに対応する、ショップの権限の項目（0028 の banto_scope_perm と同じ。判定は DB が行い、ここは画面の出し分け用）。
 * 発行者がその項目を持たないスコープは付けられず、項目を外すとそのスコープだけ効かなくなる。shop:read は発行できる人なら誰でも。
 */
export const SCOPE_PERM: Record<ApiScope, "catalog" | "orders" | "customers" | "integrations" | "settings" | "reports" | "marketing" | "support"> = {
  "products:read": "catalog",
  "products:write": "catalog",
  "orders:read": "orders",
  "orders:write": "orders",
  "orders:pii": "customers",
  "shop:read": "integrations",
  "shop:write": "settings",
  "stats:read": "reports",
  "coupons:read": "marketing",
  "coupons:write": "marketing",
  "customers:read": "customers",
  "customers:write": "customers",
  "inquiries:read": "support",
  "inquiries:write": "support",
};

export function isApiScope(s: string): s is ApiScope {
  return (API_SCOPES as readonly string[]).includes(s);
}

export function generateApiToken(): string {
  return `${TOKEN_PREFIX}${randomToken(32)}`;
}

export function looksLikeApiToken(s: string): boolean {
  return /^banto_[A-Za-z0-9_-]{40,50}$/.test(s);
}

export async function hashApiToken(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function tokenPrefix(raw: string): string {
  return raw.slice(0, 12);
}

/** Authorization: Bearer banto_... からトークンを取り出す。形式が違えば null */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  return looksLikeApiToken(m[1]!) ? m[1]! : null;
}
