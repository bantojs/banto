/**
 * 選択肢の値ごとの見本（0115_option_swatches、メンテナの決定 2026-11-05、docs/storefront.md「選択肢の見本」）。
 * ショップ全体で 1 つの表 shops.option_swatches = { <軸の key>: { <値>: { color } | { image } } }。
 * 「ネイビー」はどの商品でも同じ色。軸の key は 0094 の名前の表のもの、値は SKU の options の値（文字のまま）。
 * 画像は管理画面のブラウザで小さく縮めて置き場の swatches/<ショップ>/ に置く。形は DB の制約（banto_option_swatches_ok）でも確かめる
 */
import { imageUrl } from "../media/images";

export const OPTION_SWATCHES_MIGRATION = "0115_option_swatches";
/** 見本の画像の大きさ（ブラウザで縮める上限。正方形に近い小さな画像） */
export const SWATCH_IMAGE_SIZE = 96;
export const SWATCH_LIMITS = { total: 500, value: 60 } as const;

export interface SwatchImage {
  key: string;
  width: number;
  height: number;
}
export type Swatch = { color: string } | { image: SwatchImage };
export type OptionSwatches = Record<string, Record<string, Swatch>>;

const COLOR = /^#[0-9a-f]{6}$/;
const KEY = /^swatches\/[0-9A-Za-z-]{1,64}\/[a-f0-9]{8,64}\.(webp|png|jpg)$/;
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** 1 つの見本（形が違えば null） */
export function swatchOf(v: unknown): Swatch | null {
  if (!isObject(v)) return null;
  if (typeof v["color"] === "string" && COLOR.test(v["color"])) return { color: v["color"] };
  const img = v["image"];
  if (isObject(img) && typeof img["key"] === "string" && KEY.test(img["key"]) && typeof img["width"] === "number" && typeof img["height"] === "number") {
    return { image: { key: img["key"], width: img["width"], height: img["height"] } };
  }
  return null;
}

/** 表を読む（形の違うものは無いことにする） */
export function optionSwatchesOf(raw: unknown): OptionSwatches {
  const out: OptionSwatches = {};
  if (!isObject(raw)) return out;
  for (const [axis, values] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(axis) || !isObject(values)) continue;
    const m: Record<string, Swatch> = {};
    for (const [value, sw] of Object.entries(values)) {
      const s = swatchOf(sw);
      if (s && value.length >= 1 && value.length <= SWATCH_LIMITS.value) m[value] = s;
    }
    if (Object.keys(m).length > 0) out[axis] = m;
  }
  return out;
}

/** その軸・値の見本（無ければ null） */
export function swatchFor(table: OptionSwatches, axis: string, value: string): Swatch | null {
  return table[axis]?.[value] ?? null;
}

/** 見本を外へ渡す形（Liquid・公開 API・お店の画面のスクリプト）。color は #rrggbb、image は URL と寸法 */
export function swatchView(mediaBaseUrl: string, s: Swatch | null): { color: string | null; image: { src: string; url: string; width: number; height: number } | null } | null {
  if (!s) return null;
  if ("color" in s) return { color: s.color, image: null };
  const src = imageUrl(mediaBaseUrl, s.image.key);
  return { color: null, image: { src, url: src, width: s.image.width, height: s.image.height } };
}

/** 置き場の鍵（swatches/<ショップ>/<乱数>.<拡張子>） */
export const swatchImageKey = (shopId: string, random: string, ext: string) => `swatches/${shopId}/${random}.${ext}`;

/** フォームの色（#RGB・#RRGGBB を小文字の #rrggbb に。違えば null） */
export function colorFromForm(v: string | undefined): string | null {
  const s = (v ?? "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : null;
}
