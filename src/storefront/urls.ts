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
