/**
 * テーマを束ねたファイル（版ごとに 1 つ、StorageAdapter の themes/<shop_id>/<版の id>/bundle.json）。docs/themes.md
 *
 * 1 ページで読むのはこの 1 つだけにする（ファイルごとに読むと 1 ページで数十回。Workers の無料プランのサブリクエストは 50 回まで）。
 * 資産（CSS・JS・画像・フォント）は同じ場所の assets/ に別に置き、ショップのドメインから配る（管理画面と同じオリジンで配らない）。
 */
import { createThemeEngine, ThemeError, type EngineOptions, type ThemeFiles } from "./engine";

export const THEME_BUNDLE_FORMAT = 1;

export interface ThemeBundle {
  format: typeof THEME_BUNDLE_FORMAT;
  /** テンプレート・設定・翻訳。鍵は置き場の相対パス（"layout/theme.liquid"・"config/settings_schema.json"・"locales/ja.json" …） */
  files: Record<string, string>;
  /** 資産の名前（"assets/" を除いたもの。中身は別に置く） */
  assets: string[];
}

export const THEME_BUNDLE_LIMITS = {
  /** 束ねたファイルの大きさ（文字） */
  bundleChars: 3 * 1024 * 1024,
  /** テンプレート・設定・翻訳のファイルの数 */
  files: 600,
  /** 1 つのファイルの大きさ（文字） */
  fileChars: 512 * 1024,
  /** 資産の数と 1 つの大きさ（バイト） */
  assets: 400,
  assetBytes: 5 * 1024 * 1024,
} as const;

const FILE_PATH = /^(?:(layout|templates|sections|snippets|blocks)\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\.liquid|(templates|sections|config|locales)\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\.json)$/;
/** 資産として受け付ける拡張子と Content-Type。HTML・SVG は受け付けない（ショップのドメインでスクリプトとして開けてしまうため） */
export const THEME_ASSET_TYPES: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};
const ASSET_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}$/;

export function assetType(name: string): string | null {
  if (!ASSET_NAME.test(name) || name.includes("..")) return null;
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return THEME_ASSET_TYPES[ext] ?? null;
}

export interface BundleCheck {
  ok: boolean;
  /** 運営者に見せる誤り（ファイル名と理由だけ） */
  errors: string[];
  bundle?: ThemeBundle;
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * 取り込むテーマを確かめる: 形・名前・数・大きさ、必須のファイル、JSON が読めるか、すべての Liquid が解析できるか（知らないフィルターも止まる）。
 * extend は描画のときと同じフィルター・タグ（Shopify の名前）を渡す
 */
export function checkThemeBundle(raw: unknown, engineOpts: EngineOptions = {}): BundleCheck {
  const errors: string[] = [];
  if (!isObject(raw) || raw["format"] !== THEME_BUNDLE_FORMAT || !isObject(raw["files"]) || !Array.isArray(raw["assets"])) {
    return { ok: false, errors: ["theme bundle: invalid format"] };
  }
  const files: Record<string, string> = {};
  let total = 0;
  for (const [path, src] of Object.entries(raw["files"])) {
    if (!FILE_PATH.test(path) || path.includes("..")) {
      errors.push(`${path}: unsupported file name`);
      continue;
    }
    if (typeof src !== "string") {
      errors.push(`${path}: not text`);
      continue;
    }
    if (src.length > THEME_BUNDLE_LIMITS.fileChars) errors.push(`${path}: too large`);
    total += src.length + path.length;
    files[path] = src;
  }
  const count = Object.keys(files).length;
  if (count > THEME_BUNDLE_LIMITS.files) errors.push(`too many files (${count} > ${THEME_BUNDLE_LIMITS.files})`);
  if (total > THEME_BUNDLE_LIMITS.bundleChars) errors.push(`theme too large (${total} > ${THEME_BUNDLE_LIMITS.bundleChars})`);
  if (!("layout/theme.liquid" in files)) errors.push("layout/theme.liquid: required");
  if (!("templates/index.liquid" in files) && !("templates/index.json" in files)) errors.push("templates/index.liquid or templates/index.json: required");

  const assets: string[] = [];
  for (const a of raw["assets"]) {
    if (typeof a !== "string" || !assetType(a)) {
      errors.push(`assets/${String(a)}: unsupported asset`);
      continue;
    }
    if (!assets.includes(a)) assets.push(a);
  }
  if (assets.length > THEME_BUNDLE_LIMITS.assets) errors.push(`too many assets (${assets.length} > ${THEME_BUNDLE_LIMITS.assets})`);

  for (const [path, src] of Object.entries(files)) {
    if (!path.endsWith(".json")) continue;
    try {
      JSON.parse(stripJsonComments(src));
    } catch {
      errors.push(`${path}: invalid JSON`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const engine = createThemeEngine(files as ThemeFiles, engineOpts);
  for (const path of Object.keys(files)) {
    if (!path.endsWith(".liquid")) continue;
    const name = path.startsWith("snippets/") ? path.slice(9, -7) : path.slice(0, -7);
    try {
      engine.liquid.parse(files[path]!, name);
    } catch (e) {
      errors.push(`${path}: ${e instanceof ThemeError ? e.message : e instanceof Error ? e.message.split("\n")[0]!.slice(0, 200) : String(e)}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], bundle: { format: THEME_BUNDLE_FORMAT, files, assets } };
}

/** Shopify のテーマの JSON は先頭に「/* … *\/」の注釈を置くことがある。そこだけを外す（文字列の中は触らない） */
export function stripJsonComments(src: string): string {
  return src.replace(/^﻿?\s*\/\*[\s\S]*?\*\/\s*/, "");
}
