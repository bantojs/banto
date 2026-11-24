/**
 * 商品の検索の語（0161、メンテナの決定 2026-11-21）。空白（半角・全角・タブ・改行）で語に分け、小文字にして重なりを除き 5 語まで。
 * DB（banto_product_list）は語ごとにすべてを含む商品を探す（AND）。分け方と短い語の決まりは DB と同じ（test/fixtures/search-words-cases.ts）。
 * Worker はここで「探してよいか」を先に決める（DB も同じ決まりで q_too_short を返す）
 */

/** 語の数の上限（6 語目からは捨てる） */
export const SEARCH_WORDS_MAX = 5;
/** pg_trgm のインデックスが効く語の長さ（文字。2 文字以下の語だけでは全件を見る） */
export const SEARCH_WORD_INDEXED_CHARS = 3;
/** 語に分ける前に切る長さ（文字。DB と同じ） */
const SEARCH_Q_MAX_CHARS = 100;

/** 検索の語を語に分ける（小文字・重なりなし・5 語まで） */
export function searchWords(q: string | null | undefined): string[] {
  // 前後の半角の空白だけを除いてから 100 文字で切る（DB の left(btrim(q), 100) と同じ。ほかの空白は区切りとして扱う）
  const head = [...(q ?? "").replace(/^ +| +$/g, "")].slice(0, SEARCH_Q_MAX_CHARS).join("").toLowerCase();
  const out: string[] = [];
  for (const w of head.split(/[ \t\n\r\f\v　]+/)) {
    if (w && !out.includes(w)) out.push(w);
    if (out.length >= SEARCH_WORDS_MAX) break;
  }
  return out;
}

/** DB に渡す検索の語（分けた語を半角の空白でつなぐ。DB が分け直しても同じ語になり、「短すぎる」の判定が Worker とずれない）。語が無ければ null */
export function searchQueryForDb(q: string | null | undefined): string | null {
  const words = searchWords(q);
  return words.length > 0 ? words.join(" ") : null;
}

/**
 * 語が短すぎて、ほかの絞り込み（タグ・カテゴリー・ブランド）が無ければ探さないか。3 文字以上の語が 1 つでもあれば探す
 * （その語でインデックスが効き、短い語はその結果の中で比べるだけ）
 */
export function searchTooShort(q: string | null | undefined): boolean {
  const words = searchWords(q);
  return words.length > 0 && !words.some((w) => [...w].length >= SEARCH_WORD_INDEXED_CHARS);
}
