/**
 * 検索の語の分け方と短い語の決まり（0161）の答え合わせの表。src/storefront/search-words.ts（Worker）と DB の banto_product_list を同じ表で縛る。
 * tooShort はタグ・カテゴリー・ブランドで絞っていないときに断るか（3 文字以上の語が 1 つも無い）
 */
export const SEARCH_WORDS_CASES: { name: string; q: string; words: string[]; tooShort: boolean }[] = [
  { name: "1 語", q: "きれいめ", words: ["きれいめ"], tooShort: false },
  { name: "半角の空白で 2 語", q: "きれいめ プレミアムバリュー", words: ["きれいめ", "プレミアムバリュー"], tooShort: false },
  { name: "全角の空白・タブ・改行も区切る", q: "麻　シャツ\tLINEN\nshirt", words: ["麻", "シャツ", "linen", "shirt"], tooShort: false },
  { name: "前後と続く空白は無視", q: "   シャツ    黒  ", words: ["シャツ", "黒"], tooShort: false },
  { name: "小文字にして重なりを除く", q: "Linen linen LINEN", words: ["linen"], tooShort: false },
  { name: "5 語まで（6 語目からは捨てる）", q: "aaa bbb ccc ddd eee fff", words: ["aaa", "bbb", "ccc", "ddd", "eee"], tooShort: false },
  { name: "短い語だけ", q: "麻 黒", words: ["麻", "黒"], tooShort: true },
  { name: "3 文字の語が 1 つあれば短い語も", q: "麻 シャツ", words: ["麻", "シャツ"], tooShort: false },
  { name: "2 文字の語どうし", q: "麻 白い", words: ["麻", "白い"], tooShort: true },
  { name: "先頭の全角の空白も区切り", q: "\u3000\u3000ニット", words: ["ニット"], tooShort: false },
  { name: "3 文字以上の語があれば短い語を足してよい", q: "黒 カーディガン", words: ["黒", "カーディガン"], tooShort: false },
  { name: "1 語で 2 文字", q: "re", words: ["re"], tooShort: true },
  { name: "1 語で 3 文字", q: "red", words: ["red"], tooShort: false },
  { name: "空白だけ", q: " 　 ", words: [], tooShort: false },
  { name: "空", q: "", words: [], tooShort: false },
  { name: "記号もそのまま 1 語", q: "100% wool_mix", words: ["100%", "wool_mix"], tooShort: false },
];
