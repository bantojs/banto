/**
 * 商品のタグ。正規化のルールは SQL 側（0007_tags.sql の banto_normalize_tags / banto_valid_tags）と同じ:
 * 前後の空白を除く、カンマと改行を取り除く、1 個 40 文字まで、空と重複を捨てる、20 個まで。
 */
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;

export function normalizeTags(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[,、\n]/) : [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const tag = v.replace(/[,\r\n]/g, "").trim().slice(0, MAX_TAG_LENGTH);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** 商品のタグ（列が無い古い行・不正な値は空として扱う） */
export function tagsOf(product: { tags?: unknown }): string[] {
  return Array.isArray(product.tags) ? product.tags.filter((t): t is string => typeof t === "string") : [];
}

/** 一覧に出ているタグと件数（多い順、同数なら文字コード順。ランタイムの照合規則に左右されないように）。絞り込み UI 用 */
export function tagCounts(products: { tags?: unknown }[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const p of products) for (const t of tagsOf(p)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}
