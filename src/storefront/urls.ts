/**
 * ショップの外から見た URL（0015_shop_domain）。
 * 独自ドメイン（shops.domain）があれば https://<ドメイン> がショップのトップ、無ければ <Banto の URL>/<スラッグ>。
 * 会員のログインのリンク・LINE / Google の戻り先・決済後の戻り先・取引メール・canonical はここで組む。
 */
export interface ShopUrlParts {
  slug: string;
  domain?: string | null;
}

/** ショップの origin（独自ドメインがあればそのドメイン、無ければ Banto の URL） */
export function shopOrigin(baseUrl: string, shop: ShopUrlParts): string {
  return shop.domain ? `https://${shop.domain}` : baseUrl.replace(/\/+$/, "");
}

/** ショップのトップの絶対 URL（末尾の / なし）。ページはこの後ろに /p/<商品> などを足す */
export function shopHome(baseUrl: string, shop: ShopUrlParts): string {
  return shop.domain ? `https://${shop.domain}` : `${baseUrl.replace(/\/+$/, "")}/${shop.slug}`;
}

const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_RE = new RegExp(`^(${LABEL}\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`);

/**
 * 管理画面の入力をホスト名にそろえる（https:// や末尾の / は外す）。空なら null（独自ドメインなし）、形が違えば "invalid"。
 * DB の制約（shops_domain_format）と同じ形だけ通す。
 */
export function normalizeDomain(input: string): string | null | "invalid" {
  let v = input.trim().toLowerCase();
  if (v === "") return null;
  v = v.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (v.length > 253 || !DOMAIN_RE.test(v)) return "invalid";
  return v;
}

/** 設定された会員ページ（https の文字列だけ。許可リストは保存のときに確かめている）。無ければ null */
export function memberAccountPage(settings: Record<string, unknown> | null | undefined): string | null {
  const h = (settings ?? {})["headless"];
  const v = h && typeof h === "object" && !Array.isArray(h) ? (h as Record<string, unknown>)["account_page_url"] : null;
  return typeof v === "string" && v.startsWith("https://") ? v : null;
}

/**
 * 会員ページの絶対 URL（会員へのお知らせのメールのリンク）。会員ページを連携サイトに向けていれば（settings.headless.account_page_url、0069。
 * 許可リストのオリジンの https だけ）そこ、無ければ Banto の /account
 */
export function memberAccountUrl(baseUrl: string, shop: ShopUrlParts & { settings?: Record<string, unknown> | null }): string {
  const page = memberAccountPage(shop.settings);
  const h = (shop.settings ?? {})["headless"];
  const list = h && typeof h === "object" && !Array.isArray(h) ? (h as Record<string, unknown>)["return_origins"] : null;
  const origins = Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  // 保存のときに確かめているが、許可リストから外れたサイトには向けない
  if (page && URL.canParse(page) && origins.includes(new URL(page).origin)) return page;
  return `${shopHome(baseUrl, shop)}/account`;
}
