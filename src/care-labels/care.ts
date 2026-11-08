/**
 * 洗濯表示（同梱モジュール care_labels、0127_mod_care_labels、メンテナの決定 2026-11-08、docs/care-labels.md）。
 * 記号は JIS L 0001:2024 の記号番号で持ち、区分（番号の 1 桁目）ごとに 1 つまで。形の正は DB の制約（banto_care_ok）。
 * 商品に無ければ主カテゴリーから親へたどって近いカテゴリーのものを使う（写さずに表示のときに決める）。
 * 記号の絵は Banto に同梱しない（記号は国によって登録商標）。運営者が入手した公式のデータを記号番号ごとに持ち込む（shops.care_symbols）。
 * 絵の無い記号は意味の文で出す。データ取得はしない（材料はキャッシュ済みのショップ行・カテゴリーと商品の行）
 */
import { t, type MessageKey } from "../i18n";
import { imageUrl } from "../media/images";
import type { CategoryRow } from "../db/types";

export const CARE_MODULE = "care_labels";
export const CARE_MIGRATION = "0127_mod_care_labels";

/** 区分（記号番号の 1 桁目）と、その区分の記号（表示の順。DB の banto_care_codes と同じもの） */
export const CARE_GROUPS: readonly { group: string; codes: readonly string[] }[] = [
  { group: "1", codes: ["190", "170", "160", "161", "150", "151", "140", "141", "142", "130", "131", "132", "110", "111", "100"] },
  { group: "2", codes: ["220", "210", "200"] },
  { group: "3", codes: ["320", "310", "300"] },
  { group: "4", codes: ["440", "445", "430", "435", "420", "425", "410", "415"] },
  { group: "5", codes: ["530", "520", "510", "511", "500"] },
  { group: "6", codes: ["620", "621", "610", "611", "600"] },
  { group: "7", codes: ["710", "711", "712", "700"] },
];
export const CARE_CODES: readonly string[] = CARE_GROUPS.flatMap((g) => g.codes);
const ORDER = new Map(CARE_CODES.map((c, i) => [c, i]));
export const CARE_LIMITS = { notes: 8, note: 40, imageSize: 256 } as const;

export interface Care {
  symbols: string[];
  notes: string[];
}

/** DB の値 → 形（知らない番号・同じ区分の 2 つ目は捨て、表示の順に並べる）。中身が無ければ null */
export function careOf(raw: unknown): Care | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const seen = new Set<string>();
  const symbols = (Array.isArray(o["symbols"]) ? o["symbols"] : [])
    .filter((x): x is string => typeof x === "string" && ORDER.has(x))
    .filter((x) => (seen.has(x[0]!) ? false : (seen.add(x[0]!), true)))
    .sort((a, b) => ORDER.get(a)! - ORDER.get(b)!);
  const notes = (Array.isArray(o["notes"]) ? o["notes"] : []).filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().slice(0, CARE_LIMITS.note)).slice(0, CARE_LIMITS.notes);
  return symbols.length > 0 || notes.length > 0 ? { symbols, notes } : null;
}

/** 商品の洗濯表示（無ければ主カテゴリーから親へたどって近いカテゴリーのもの） */
export function resolveCare(product: { care?: unknown; category_id?: string | null }, categories: readonly Pick<CategoryRow, "id" | "parent_id" | "care">[]): Care | null {
  const own = careOf(product.care);
  if (own) return own;
  const byId = new Map(categories.map((c) => [c.id, c]));
  let cur = product.category_id ? byId.get(product.category_id) : undefined;
  for (let depth = 0; cur && depth < 10; depth++) {
    const c = careOf(cur.care);
    if (c) return c;
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return null;
}

export interface CareSymbolImage {
  key: string;
  width: number;
  height: number;
}

/** 記号の絵の表（shops.care_symbols）。形の違うものは捨てる */
export function careSymbolsOf(raw: unknown): Record<string, CareSymbolImage> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, CareSymbolImage> = {};
  for (const [code, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ORDER.has(code) || !v || typeof v !== "object") continue;
    const x = v as Record<string, unknown>;
    if (typeof x["key"] === "string" && typeof x["width"] === "number" && typeof x["height"] === "number") out[code] = { key: x["key"], width: x["width"], height: x["height"] };
  }
  return out;
}

/** 置き場の鍵（care/<ショップ>/<乱数>.<拡張子>） */
export const careImageKey = (shopId: string, random: string, ext: string) => `care/${shopId}/${random}.${ext}`;

/** 記号の意味の文（読み上げ・絵の無いときの表示）と区分の名前 */
export const careLabel = (code: string): string => t(`care.sym.${code}` as MessageKey);
export const careGroupLabel = (group: string): string => t(`care.group.${group}` as MessageKey);

export interface CareView {
  symbols: { code: string; group: string; label: string; image: { url: string; width: number; height: number } | null }[];
  notes: string[];
}

/** お客様の画面・テーマ・ヘッドレスに渡す形（意味の文と、持ち込んだ絵があればその URL） */
export function careView(care: Care | null, symbols: Record<string, CareSymbolImage>, mediaBaseUrl: string): CareView | null {
  if (!care) return null;
  return {
    symbols: care.symbols.map((code) => {
      const img = symbols[code];
      return { code, group: code[0]!, label: careLabel(code), image: img ? { url: imageUrl(mediaBaseUrl, img.key), width: img.width, height: img.height } : null };
    }),
    notes: care.notes,
  };
}

/** 商品ページの材料: モジュールが OFF なら null */
export function productCareView(on: boolean, product: { care?: unknown; category_id?: string | null }, categories: readonly CategoryRow[], shop: { care_symbols?: unknown }, mediaBaseUrl: string): CareView | null {
  return on ? careView(resolveCare(product, categories), careSymbolsOf(shop.care_symbols), mediaBaseUrl) : null;
}

/** 既定のテーマの見た目（記号の絵か意味の文。絵には意味の文を alt と title に） */
export const CARE_CSS =
  ".banto-care{margin:1.5rem 0}.banto-care__list{list-style:none;padding:0;margin:.5rem 0;display:flex;flex-wrap:wrap;gap:.5rem 1rem}" +
  ".banto-care__item{display:flex;align-items:center;gap:.4rem;font-size:.9em}.banto-care__item img{width:2.5rem;height:auto;flex:none}.banto-care__notes{font-size:.9em;margin:.25rem 0 0;padding-left:1.1rem}";
