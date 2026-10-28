/**
 * テーマのプレビューの券（docs/themes.md）。管理画面の「デザイン」と AI 用 API（theme:write）が作り、お店の画面（src/routes/storefront/liquid.ts）が開く。
 * ショップと版を結び、30 分で切れる。開いた端末では Cookie で続く
 */
import { openJson, sealJson } from "../../util/signed";
import { shopOrigin, type ShopUrlParts } from "../../storefront/urls";

/** プレビューの券（管理画面の「デザイン」が作る。ショップと版を結び、30 分で切れる） */
export const THEME_PREVIEW_SECONDS = 30 * 60;
export const PREVIEW_COOKIE = "banto_theme_preview";
/** 券の鍵はプレビュー専用にする（サイトの秘密で署名するほかの値と取り違えさせない） */
const previewKey = (secret: string): string => `${secret}:theme_preview`;

export function sealThemePreview(secret: string, shopId: string, versionId: string, now = Date.now()): Promise<string> {
  return sealJson(previewKey(secret), { k: "theme_preview", s: shopId, v: versionId, exp: Math.floor(now / 1000) + THEME_PREVIEW_SECONDS });
}

export async function openThemePreview(secret: string, token: string | undefined, shopId: string): Promise<string | null> {
  const v = (await openJson(previewKey(secret), token)) as { k?: unknown; s?: unknown; v?: unknown; exp?: unknown } | null;
  if (!v || v.k !== "theme_preview" || v.s !== shopId || typeof v.v !== "string" || !/^[0-9a-f-]{36}$/.test(v.v) || typeof v.exp !== "number" || v.exp * 1000 < Date.now()) return null;
  return v.v;
}

/** ショップのドメインでプレビューを開くリンク */
export async function themePreviewUrl(publicBase: string, shop: ShopUrlParts, shopId: string, versionId: string, secret: string): Promise<string> {
  const token = await sealThemePreview(secret, shopId, versionId);
  return `${shopOrigin(publicBase, shop)}/?preview_theme=${versionId}&preview_token=${encodeURIComponent(token)}`;
}
