import type { Context } from "hono";
import type { AppEnv } from "../../app";
import { createAuthClient, type AuthClient } from "../../auth/supabase";
import { createDbClient, type DbClient } from "../../db/client";
import type { SessionData } from "../../auth/session";
import { param, publicBaseUrl } from "../common";
import { domainTemplateFrom, templateDomain } from "../../storefront/subdomain";

export { csrfGuard, formFields, isSecureRequest, mediaBaseUrl, param, publicBaseUrl, SLUG_RE } from "../common";

export type AdminContext = Context<AppEnv>;

/** 環境変数・Secret の名前（ウィザードの環境チェックで使う）。値は絶対に画面に出さない */
export const REQUIRED_PUBLIC_VARS = ["SUPABASE_URL", "SUPABASE_ANON_KEY"] as const;
/**
 * 新しい導入では SESSION_SECRET も必須（メンテナの決定 2026-10-18、docs/knowledge/02-decisions.md）。
 * 既存の導入で未設定なら service_role キーから導出して動き続ける（src/auth/session.ts）。ダッシュボードが設定を促す。
 */
export const REQUIRED_SECRETS = ["SUPABASE_SERVICE_ROLE_KEY", "SESSION_SECRET"] as const;

export function supabaseConfig(c: AdminContext): { url: string; anonKey: string } | null {
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const anonKey = cfg.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export function sessionSecret(c: AdminContext): string | undefined {
  return c.get("sessionSecret");
}

export function authClient(c: AdminContext): AuthClient | null {
  const cfg = supabaseConfig(c);
  return cfg && createAuthClient({ ...cfg, fetch: c.get("deps").fetch });
}

/** RLS が効く DB クライアント。jwt を渡せば owner、無ければ anon */
export function dbClient(c: AdminContext, userJwt?: string): DbClient | null {
  const cfg = supabaseConfig(c);
  return cfg && createDbClient({ ...cfg, userJwt, fetch: c.get("deps").fetch });
}

/** requireOwner を通ったハンドラで使う */
export function owner(c: AdminContext): { session: SessionData; db: DbClient } {
  const session = c.get("session");
  const db = c.get("db");
  if (!session || !db) throw new Error("owner(): requireOwner middleware missing");
  return { session, db };
}

export function params(c: AdminContext): { shopId: string; productId: string; skuId: string; imageId: string } {
  return {
    shopId: param(c, "shopId"),
    productId: param(c, "productId"),
    skuId: param(c, "skuId"),
    imageId: param(c, "imageId"),
  };
}

/**
 * サブドメインモード（SHOP_DOMAIN_TEMPLATE、src/storefront/subdomain.ts）で、このスラッグのショップに付けるドメイン。
 * ひな形が無ければ null（今までどおりドメインなし）。作れない（ラベルが長すぎる・使えない並び・Banto 自身のホストと重なる）なら "invalid"
 */
export function shopTemplateDomain(c: AdminContext, slug: string): string | null | "invalid" {
  const tpl = domainTemplateFrom(c.get("adapters").config);
  if (!tpl) return null;
  const domain = templateDomain(tpl, slug);
  if (!domain) return "invalid";
  const own = [new URL(c.req.url).hostname, new URL(publicBaseUrl(c)).hostname];
  return own.includes(domain) ? "invalid" : domain;
}
