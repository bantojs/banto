/**
 * お店の画面の使い方（shops.settings.storefront、0041）。docs/storefront.md
 *   full     すべて Banto の画面（既定）
 *   checkout 商品の一覧と詳細は外のサイト（WordPress・Instagram など）。カート・購入・会員は Banto の画面
 *   off      Banto の画面を使わない（チェックアウト API で外のサイトが全部作る）
 * 使わない画面を開かれたら、外のサイトへ転送する（302。設定を戻せばすぐ戻るように、恒久の転送にはしない）。
 * どのモードでも残す画面（system）: 法務・送料・注文照会と領収書・決済後の完了画面・会員のログインのリンクとコード・商品フィード。
 * メールのリンク・決済事業者の戻り先・特商法の表示がこれらを指すため。
 */

export const STOREFRONT_MODES = ["full", "checkout", "off"] as const;
export type StorefrontMode = (typeof STOREFRONT_MODES)[number];

export interface StorefrontSettings {
  mode: StorefrontMode;
  /** 使わない画面の転送先（https）。無ければ 404 */
  siteUrl: string | null;
  /** 商品ページの転送先（{slug} を置き換える）。無ければ siteUrl */
  productUrl: string | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** https の絶対 URL だけ（転送先に javascript: などを入れさせない） */
export function safeHttpsUrl(v: unknown, opts: { template?: boolean } = {}): string | null {
  if (typeof v !== "string" || v.length > 500) return null;
  const s = v.trim();
  try {
    const u = new URL(opts.template ? s.replace(/\{slug\}/g, "x") : s);
    if (u.protocol !== "https:" || u.username || u.password) return null;
  } catch {
    return null;
  }
  if (opts.template && !s.includes("{slug}")) return null;
  return s;
}

export function storefrontSettings(settings: Record<string, unknown> | null | undefined): StorefrontSettings {
  const sf = isObject(settings?.["storefront"]) ? (settings!["storefront"] as Record<string, unknown>) : {};
  const mode = (STOREFRONT_MODES as readonly string[]).includes(String(sf["mode"])) ? (sf["mode"] as StorefrontMode) : "full";
  return { mode, siteUrl: safeHttpsUrl(sf["site_url"]), productUrl: safeHttpsUrl(sf["product_url"], { template: true }) };
}

export type PageKind = "catalog" | "shopping" | "system";

/** /:shop より後ろのパス（"" / "/p/tee" / "/cart" …）の種類 */
export function pageKind(rest: string): PageKind {
  const r = rest.replace(/\/+$/, "");
  if (r === "" || r.startsWith("/p/")) return "catalog";
  if (/^\/(legal|privacy|returns|shipping)$/.test(r)) return "system";
  if (/^\/orders\/(lookup|receipt)$/.test(r)) return "system";
  if (r === "/checkout/done" || r === "/feed/products.xml" || /^\/sitemap-products-[0-9]+\.xml$/.test(r)) return "system";
  if (/^\/account\/(verify|code)$/.test(r)) return "system";
  return "shopping";
}

/**
 * その画面を出すか。出さないなら転送先（無ければ "not_found"）。
 * 商品ページは productUrl の {slug} を置き換えた URL へ。
 */
export function blockedTarget(s: StorefrontSettings, rest: string): string | "not_found" | null {
  const kind = pageKind(rest);
  if (kind === "system" || s.mode === "full") return null;
  if (s.mode === "checkout" && kind !== "catalog") return null;
  const product = /^\/p\/([^/]+)\/?$/.exec(rest)?.[1];
  if (product && s.productUrl) return s.productUrl.replace(/\{slug\}/g, encodeURIComponent(decodeURIComponent(product)));
  return s.siteUrl ?? "not_found";
}

/** 外から見た商品ページの URL（商品フィードなど）。full か productUrl が無ければ null（Banto の商品ページ） */
export function externalProductUrl(settings: Record<string, unknown> | null | undefined, slug: string): string | null {
  const s = storefrontSettings(settings);
  if (s.mode === "full" || !s.productUrl) return null;
  return s.productUrl.replace(/\{slug\}/g, encodeURIComponent(slug));
}
