/**
 * 注文の印（タグ）と社内のメモ（0106_order_tags、メンテナの決定 2026-11-04、docs/ai-access.md §13）。
 * 決まり（20 個まで・1 つ 40 字まで・カンマと制御文字は不可・重なりを消す、メモは 2,000 字まで）の正は DB の banto_order_tags_norm と列の CHECK。
 * ここは画面の入力（カンマか改行で区切った文字）を並びに直すだけ。
 */
export const ORDER_TAGS_MAX = 20;
export const ORDER_TAG_MAX_CHARS = 40;
export const ORDER_NOTE_MAX_CHARS = 2000;

/** 「要確認, ギフト」や改行で区切った入力を並びにする（空を捨て、重なりを消す。形の検査は DB） */
export function parseOrderTags(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[,、\n]/)) {
    const v = part.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** 行の tags を読む（0106 の前の行・壊れた値は空） */
export const orderTagsOf = (row: { tags?: unknown }): string[] => (Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === "string") : []);
