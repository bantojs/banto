/**
 * 商品の一覧の絞り込み（段 1、0150、メンテナの決定 2026-11-17、docs/storefront.md「URL」）。
 *   - 複数のタグ: ?tag=a&tag=b（すべてを持つ商品。今までの ?tag= 1 つと互換）。5 つまで、1 つ 50 文字まで
 *   - 価格の上下限: ?filter.v.price.gte= / ?filter.v.price.lte=（円。Shopify のテーマの絞り込みのフォームと同じ名前）
 *   - SKU の選択肢（段 2、0153）: ?filter.v.option.<key>=<値>（くり返すと同じ鍵はどれか、鍵どうしはすべて。在庫のある SKU の選択肢だけ）
 *   - ブランド: ?filter.p.vendor=<ブランド>（Shopify の名前。1 つだけ、くり返しは最初の値。ちょうど同じ名前。件数は 0162、メンテナの決定 2026-11-21）
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
/** 選択肢の絞り込み（0153）の URL の名前の頭。後ろは 0094 の英字の鍵 */
export const OPTION_PARAM_PREFIX = "filter.v.option.";
export const LIST_OPTIONS_MIGRATION = "0153_product_option_stock";
/** ブランドの絞り込みの URL の名前（Shopify の vendor の絞り込みと同じ） */
export const VENDOR_PARAM = "filter.p.vendor";
/** ブランドの長さの上限（products.brand と同じ） */
const VENDOR_CHARS_MAX = 100;
const OPTION_KEY = /^[a-z][a-z0-9_]{0,31}$/;
export const LIST_OPTION_KEYS_MAX = 3;
export const LIST_OPTION_VALUES_MAX = 10;
const PRICE_MAX = 2_147_483_647;

/** 選んでいる絞り込み（タグは選んだ順、重なりなし） */
export interface ListFilter {
  tags: string[];
  priceMin?: number;
  priceMax?: number;
  /** 選択肢（鍵 → 値。0153） */
  options?: Record<string, string[]>;
  /** ブランド（ちょうど同じ名前の商品だけ） */
  vendor?: string;
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

/**
 * URL の選択肢（filter.v.option.<key>）→ 鍵 → 値。読めない鍵は捨て、鍵は 3 つまで・値は 1 つの鍵に 10 まで（文字で 100 まで、重なりなし）。
 * 多すぎるときは捨てる（お店の画面）。公開 API は数えて 400 にする（optionsTooMany）
 */
export function listOptionsOf(query: Record<string, string[]>): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(query)) {
    if (!name.startsWith(OPTION_PARAM_PREFIX)) continue;
    const key = name.slice(OPTION_PARAM_PREFIX.length);
    if (!OPTION_KEY.test(key) || Object.keys(out).length >= LIST_OPTION_KEYS_MAX) continue;
    const vals: string[] = [];
    for (const v of values) {
      const t = [...v.trim()].slice(0, 100).join("");
      if (t && !vals.includes(t)) vals.push(t);
      if (vals.length >= LIST_OPTION_VALUES_MAX) break;
    }
    if (vals.length > 0) out[key] = vals;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 件数の options（鍵 × 値）→ 鍵ごとの候補（表示名つき、鍵は出てきた順） */
export function optionFacetsOf(rows: readonly { key: string; value: string; count: number }[] | undefined, label: (key: string) => string): { key: string; label: string; values: { value: string; count: number }[] }[] {
  const out = new Map<string, { key: string; label: string; values: { value: string; count: number }[] }>();
  for (const r of rows ?? []) {
    const g = out.get(r.key) ?? { key: r.key, label: label(r.key), values: [] };
    g.values.push({ value: r.value, count: r.count });
    out.set(r.key, g);
  }
  return [...out.values()];
}

/** 選択肢の条件が多すぎるか（公開 API は黙って捨てずに 400） */
export function optionsTooMany(query: Record<string, string[]>): boolean {
  const keys = Object.entries(query).filter(([n, v]) => n.startsWith(OPTION_PARAM_PREFIX) && v.some((x) => x.trim() !== ""));
  return keys.length > LIST_OPTION_KEYS_MAX || keys.some(([n, v]) => !OPTION_KEY.test(n.slice(OPTION_PARAM_PREFIX.length)) || new Set(v.map((x) => x.trim()).filter(Boolean)).size > LIST_OPTION_VALUES_MAX);
}

/** URL の filter.p.vendor（くり返し）→ ブランド。最初の空でない値、前後の空白を除いて 100 文字まで（超えたら絞らない） */
export function vendorParamOf(values: readonly string[] | undefined): string | undefined {
  for (const v of values ?? []) {
    const t = v.trim();
    if (!t) continue;
    return [...t].length <= VENDOR_CHARS_MAX ? t : undefined;
  }
  return undefined;
}

/** URL のクエリ（名前 → 値の並び） → 選んでいる絞り込み */
export function listFilterOf(query: Record<string, string[]>): ListFilter {
  const priceMin = priceParamOf(query[PRICE_GTE_PARAM]?.[0]);
  const priceMax = priceParamOf(query[PRICE_LTE_PARAM]?.[0]);
  const options = listOptionsOf(query);
  const vendor = vendorParamOf(query[VENDOR_PARAM]);
  return { tags: listTagsOf(query["tag"] ?? []), ...(priceMin !== undefined ? { priceMin } : {}), ...(priceMax !== undefined ? { priceMax } : {}), ...(options ? { options } : {}), ...(vendor ? { vendor } : {}) };
}

/** 価格で絞っているか */
export function priceFiltered(f: Pick<ListFilter, "priceMin" | "priceMax"> | null | undefined): boolean {
  return f?.priceMin !== undefined || f?.priceMax !== undefined;
}

/** 0150 が要る絞り込みか（タグ 2 つ以上か価格）。タグ 1 つだけなら今までの p_tag で足りる */
export function needsListFilters(f: ListFilter | null | undefined): boolean {
  return (f?.tags.length ?? 0) > 1 || priceFiltered(f);
}

/** 検索エンジンに載せない一覧か（タグ 2 つ以上・価格・選択肢・ブランド。組み合わせの数だけ同じような一覧を作らない） */
export function filterNoindex(f: ListFilter | null | undefined): boolean {
  return needsListFilters(f) || Boolean(f?.options) || Boolean(f?.vendor);
}
