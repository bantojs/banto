/**
 * カテゴリーの説明と画像（0113_category_media、docs/storefront.md「カテゴリーの画像と説明」）。
 * - 説明は文字だけ（HTML は書けない）。描くときにエスケープして、改行を <br> にする（商品の説明と同じ）
 * - 画像は管理画面のブラウザで縮小して置き場の categories/<ショップ>/ に置く（サーバーでは画像を処理しない）。
 *   鍵の形は DB の制約（categories_image_check）でも確かめる
 */
import type { CategoryImage, CategoryRow } from "../db/types";

export const CATEGORY_DESCRIPTION_MAX = 2000;
/** 置く画像の横幅（ブラウザで縮小する上限）。カテゴリーの見出しの画像・格子のタイル */
export const CATEGORY_IMAGE_WIDTH = 1600;

const KEY = /^categories\/[0-9A-Za-z-]{1,64}\/[a-f0-9]{8,64}\.(webp|jpg|png|gif|avif)$/;

/** 行の画像（形が違えば null） */
export function categoryImageOf(row: Pick<CategoryRow, "image"> | null | undefined): CategoryImage | null {
  const v = row?.image;
  if (!v || typeof v !== "object") return null;
  const { key, width, height } = v as Partial<CategoryImage>;
  if (typeof key !== "string" || !KEY.test(key) || typeof width !== "number" || typeof height !== "number") return null;
  return { key, width, height };
}

/** 置き場の鍵（categories/<ショップ>/<乱数>.<拡張子>） */
export const categoryImageKey = (shopId: string, random: string, ext: string) => `categories/${shopId}/${random}.${ext}`;

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ESC[ch]!);

/** 説明の HTML（エスケープして改行を <br>）。空なら "" */
export function categoryDescriptionHtml(text: string | null | undefined): string {
  const s = (text ?? "").replace(/\r\n?/g, "\n").trim();
  return s ? esc(s).replace(/\n/g, "<br>") : "";
}

/** 検索エンジン向けの説明（1 行・160 字まで）。空なら null */
export function categoryMetaDescription(text: string | null | undefined): string | null {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, 160) : null;
}

/** フォームの説明を整える（前後の空白を落とし、2,000 字まで。空なら null） */
export function categoryDescriptionFromForm(v: string | undefined): string | null {
  const s = (v ?? "").replace(/\r\n?/g, "\n").trim().slice(0, CATEGORY_DESCRIPTION_MAX);
  return s || null;
}
