/**
 * 商品の一覧の絞り込み（段 1、0150、メンテナの決定 2026-11-17、docs/storefront.md「URL」）。
 *   - 複数のタグ: ?tag=a&tag=b（すべてを持つ商品。今までの ?tag= 1 つと互換）。5 つまで、1 つ 50 文字まで
 *   - 価格の上下限: ?filter.v.price.gte= / ?filter.v.price.lte=（円。Shopify のテーマの絞り込みのフォームと同じ名前）
 * 価格は一覧の価格（いちばん安い SKU の価格、products.list_price_jpy）で比べる。判定は DB（banto_product_list）。
 * お店の画面・公開 API・テーマはここの読み取りと URL の組み立てだけを使う
 */

/** 0150 が当たっていれば DB が複数のタグと価格の上下限を受ける */
export const LIST_FILTERS_MIGRATION = "0150_product_list_filters";
export const LIST_TAGS_MAX = 5;
const TAG_CHARS_MAX = 50;
/** 価格の上下限の URL の名前（Shopify の price_range の絞り込みと同じ） */
export const PRICE_GTE_PARAM = "filter.v.price.gte";
export const PRICE_LTE_PARAM = "filter.v.price.lte";
const PRICE_MAX = 2_147_483_647;

/** 選んでいる絞り込み（タグは選んだ順、重なりなし） */
export interface ListFilter {
  tags: string[];
  priceMin?: number;
  priceMax?: number;
}

/** URL の tag の値（くり返し） → 選んだタグ。前後の空白を除き、文字で 50 まで、空と重なりを除いて 5 つまで（6 つ目からは捨てる） */
export function listTagsOf(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const t = [...v.trim()].slice(0, TAG_CHARS_MAX).join("");
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= LIST_TAGS_MAX) break;
  }
  return out;
}

/** 価格の値 → 円の整数（桁区切りのカンマ・小数は受けて切り捨て）。読めない・負の値は undefined（絞らない） */
export function priceParamOf(v: string | null | undefined): number | undefined {
  const s = (v ?? "").replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined;
  return Math.min(Math.floor(Number(s)), PRICE_MAX);
}

/** URL のクエリ → 選んでいる絞り込み */
export function listFilterOf(all: (name: string) => string[] | undefined): ListFilter {
  const priceMin = priceParamOf(all(PRICE_GTE_PARAM)?.[0]);
  const priceMax = priceParamOf(all(PRICE_LTE_PARAM)?.[0]);
  return { tags: listTagsOf(all("tag") ?? []), ...(priceMin !== undefined ? { priceMin } : {}), ...(priceMax !== undefined ? { priceMax } : {}) };
}

/** 価格で絞っているか */
export function priceFiltered(f: Pick<ListFilter, "priceMin" | "priceMax"> | null | undefined): boolean {
  return f?.priceMin !== undefined || f?.priceMax !== undefined;
}

/** 0150 が要る絞り込みか（タグ 2 つ以上か価格）。タグ 1 つだけなら今までの p_tag で足りる */
export function needsListFilters(f: ListFilter | null | undefined): boolean {
  return (f?.tags.length ?? 0) > 1 || priceFiltered(f);
}

/** 検索エンジンに載せない一覧か（タグ 2 つ以上か価格。組み合わせの数だけ同じような一覧を作らない） */
export function filterNoindex(f: ListFilter | null | undefined): boolean {
  return needsListFilters(f);
}
