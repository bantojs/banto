/**
 * テーマの版の置き場の読み書き（docs/themes.md）。管理画面の「デザイン」（src/routes/admin/design.tsx）と
 * AI 用 API（theme:write、src/api/service.ts）の両方がここを通る。だれがしてよいか・版の状態は DB の関数（0071・0072）が決める。
 *
 * 置き場: themes/<ショップ>/<版>/bundle.json（テンプレート・設定・翻訳を束ねたもの）と themes/<ショップ>/<版>/assets/<名前>
 */
import type { StorageAdapter } from "../../adapters/types";
import { assetType, checkThemeBundle, stripJsonComments, THEME_BUNDLE_LIMITS, type ThemeBundle } from "./bundle";
import { extendShopify } from "./shopify";

/** AI 用 API でテーマを扱う（theme:write / theme:publish、0072） */
export const THEME_API_MIGRATION = "0072_theme_api";

export const themeBundleKey = (shopId: string, versionId: string): string => `themes/${shopId}/${versionId}/bundle.json`;
export const themeAssetKey = (shopId: string, versionId: string, name: string): string => `themes/${shopId}/${versionId}/assets/${name}`;
export const THEME_VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 束ねたテーマを送る本文の大きさの上限（JSON にすると文字が増えるので、束ねたファイルの上限の 2 倍） */
export const THEME_UPLOAD_MAX_BYTES = THEME_BUNDLE_LIMITS.bundleChars * 2;

/** テーマの情報（settings_schema.json の theme_info）。画面に出すだけ */
export function themeManifest(bundle: ThemeBundle): Record<string, string> {
  try {
    const schema = JSON.parse(stripJsonComments(bundle.files["config/settings_schema.json"] ?? "[]")) as unknown;
    const info = Array.isArray(schema) ? schema.find((x) => x && typeof x === "object" && (x as Record<string, unknown>)["name"] === "theme_info") : null;
    if (!info || typeof info !== "object") return {};
    const pick = (k: string) => (typeof (info as Record<string, unknown>)[k] === "string" ? String((info as Record<string, unknown>)[k]).slice(0, 100) : undefined);
    return Object.fromEntries(Object.entries({ theme_name: pick("theme_name"), theme_version: pick("theme_version"), theme_author: pick("theme_author") }).filter(([, v]) => v !== undefined)) as Record<string, string>;
  } catch {
    return {};
  }
}

export interface PreparedThemeVersion {
  id: string;
  bundle: ThemeBundle;
  text: string;
  sizeBytes: number;
  fileCount: number;
  manifest: Record<string, string>;
}

/** 送られた束ねたテーマを検査する（すべてのテンプレートを解析する）。誤りはファイルの名前と理由 */
export function prepareThemeVersion(raw: unknown): { ok: true; version: PreparedThemeVersion } | { ok: false; errors: string[] } {
  const check = checkThemeBundle(raw, { extend: extendShopify });
  if (!check.ok || !check.bundle) return { ok: false, errors: check.errors };
  const bundle = check.bundle;
  const text = JSON.stringify(bundle);
  return {
    ok: true,
    version: { id: crypto.randomUUID(), bundle, text, sizeBytes: Math.max(1, text.length), fileCount: Object.keys(bundle.files).length + bundle.assets.length, manifest: themeManifest(bundle) },
  };
}

/** 束ねたファイルを置く（版の行を足す前に。行を足せなかったら removeThemeBundle で消す） */
export async function storeThemeBundle(storage: StorageAdapter, shopId: string, v: PreparedThemeVersion): Promise<void> {
  await storage.put(themeBundleKey(shopId, v.id), new TextEncoder().encode(v.text).buffer as ArrayBuffer, "application/json");
}

export async function removeThemeBundle(storage: StorageAdapter, shopId: string, versionId: string): Promise<void> {
  await storage.delete(themeBundleKey(shopId, versionId)).catch(() => {});
}

export async function readThemeBundle(storage: StorageAdapter, shopId: string, versionId: string): Promise<ThemeBundle | null> {
  const obj = await storage.get(themeBundleKey(shopId, versionId));
  if (!obj) return null;
  try {
    return JSON.parse(await new Response(obj.body).text()) as ThemeBundle;
  } catch {
    return null;
  }
}

export type AssetPutResult = { ok: true } | { ok: false; reason: "type" | "not_listed" | "too_large" };

/**
 * 資産を 1 つ置く。束ねたファイルに名前があり、決まった種類で、上限の大きさまで。
 * 呼ぶ前に、そのショップの版で置き終えていない（complete でない）ことを DB で確かめる
 */
export async function putThemeAsset(storage: StorageAdapter, shopId: string, versionId: string, name: string, body: ArrayBuffer): Promise<AssetPutResult> {
  const type = assetType(name);
  if (!type) return { ok: false, reason: "type" };
  if (body.byteLength > THEME_BUNDLE_LIMITS.assetBytes) return { ok: false, reason: "too_large" };
  const bundle = await readThemeBundle(storage, shopId, versionId);
  if (!bundle || !bundle.assets.includes(name)) return { ok: false, reason: "not_listed" };
  await storage.put(themeAssetKey(shopId, versionId, name), body, type);
  return { ok: true };
}

/** 置き終えたか: 束ねたファイルの資産がすべて置き場にあるか。無いものの名前（すべてあれば null）。束ねたファイルが無ければ undefined */
export async function missingThemeAsset(storage: StorageAdapter, shopId: string, versionId: string): Promise<string | null | undefined> {
  const bundle = await readThemeBundle(storage, shopId, versionId);
  if (!bundle) return undefined;
  for (const a of bundle.assets) {
    const obj = await storage.get(themeAssetKey(shopId, versionId, a));
    if (!obj) return a;
    await obj.body.cancel().catch(() => {});
  }
  return null;
}

/** 版のファイルを消す（DB の行を消した後に。prefix は theme_version_delete / api_theme_delete の戻り値） */
export async function deleteThemeFiles(storage: StorageAdapter, prefix: string, bundle: ThemeBundle | null): Promise<void> {
  for (const a of bundle?.assets ?? []) if (assetType(a)) await storage.delete(`${prefix}assets/${a}`).catch(() => {});
  await storage.delete(`${prefix}bundle.json`).catch(() => {});
}
