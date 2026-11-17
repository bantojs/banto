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

/** ショップのトップの絶対 URL（末尾の / なし）。ページはこの後ろに /products/<商品> などを足す */
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

// ---------- お店の画面の商品の URL（メンテナの決定 2026-11-05、docs/storefront.md「URL」） ----------
// すべての商品は /products、商品の詳細は /products/<商品>、カテゴリーの一覧は /categories/<カテゴリー>。
// タグ・検索の語・並べ方・ページ送りは、どの一覧にも ?tag= ?q= ?sort= ?after= で付ける。shopPath はドメインの上なら ""、無ければ /<スラッグ>。
// URL はここでだけ組む（テーマ・本文のブロック・パンくず・サイトマップ・メール・構造化データが同じものを使う）

/** 一覧の条件（タグ・検索の語・ページ送りの位置） */
export interface ListQuery {
  tag?: string | null | undefined;
  /** 選んだタグ（?tag= をくり返す。すべてを持つ商品。0150）。あれば tag より先 */
  tags?: readonly string[] | null | undefined;
  /** 価格の上下限（?filter.v.price.gte= / lte=、円。0150、src/storefront/list-filter.ts） */
  priceMin?: number | null | undefined;
  priceMax?: number | null | undefined;
  q?: string | null | undefined;
  after?: string | null | undefined;
  /** 並べ方（src/storefront/list-sort.ts。既定の new は渡さない） */
  sort?: string | null | undefined;
}

const enc = encodeURIComponent;
const withQuery = (path: string, o: Record<string, string | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const qs = p.toString();
  return qs ? `${path}?${qs}` : path;
};

/** 商品の詳細。sku を渡すとその SKU を選んだ状態（?sku=<品番>） */
export function productUrl(shopPath: string, slug: string, extra: Record<string, string | null | undefined> = {}): string {
  return withQuery(`${shopPath}/products/${enc(slug)}`, extra);
}

/** 一覧のクエリ（タグ・価格・検索の語・並べ方・ページの位置の順） */
const withListQuery = (path: string, q: ListQuery) => {
  const p = new URLSearchParams();
  for (const t of q.tags && q.tags.length > 0 ? q.tags : q.tag ? [q.tag] : []) p.append("tag", t);
  if (q.priceMin !== null && q.priceMin !== undefined) p.set("filter.v.price.gte", String(q.priceMin));
  if (q.priceMax !== null && q.priceMax !== undefined) p.set("filter.v.price.lte", String(q.priceMax));
  for (const [k, v] of [["q", q.q], ["sort", q.sort], ["after", q.after]] as const) if (v) p.set(k, v);
  const qs = p.toString();
  return qs ? `${path}?${qs}` : path;
};

/** すべての商品の一覧 */
export function productsUrl(shopPath: string, q: ListQuery = {}): string {
  return withListQuery(`${shopPath}/products`, q);
}

/** カテゴリーの一覧（子のカテゴリーの商品も含む） */
export function categoryUrl(shopPath: string, slug: string, q: ListQuery = {}): string {
  return withListQuery(`${shopPath}/categories/${enc(slug)}`, q);
}

/** 一覧（カテゴリーがあればカテゴリーの一覧、無ければすべての商品） */
export function listUrl(shopPath: string, o: ListQuery & { category?: string | null | undefined }): string {
  return o.category ? categoryUrl(shopPath, o.category, o) : productsUrl(shopPath, o);
}
