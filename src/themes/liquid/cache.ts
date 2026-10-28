/**
 * 公開中のテーマ（とプレビューの版）を isolate のメモリに置く。束ねたファイルを読むのは版ごとに 1 回、解析は使うファイルだけ・その場で。
 * 解析した結果は元の文字の 9 倍ほどのメモリを使う（Dawn ほどの大きさのテーマで 7〜8 MiB）ので、版の数と元の大きさで古いものから捨てる。
 * 版の id は中身ごとに新しく作るので、同じ id の中身は変わらない（覚えたままでよい。設定の値は shop_public_get から毎回渡す）
 */
import type { StorageAdapter } from "../../adapters/types";
import { createThemeEngine, ThemeError, type EngineOptions, type ThemeEngine } from "./engine";
import { THEME_BUNDLE_FORMAT, type ThemeBundle } from "./bundle";

export const THEME_CACHE_LIMITS = { versions: 8, chars: 12 * 1024 * 1024 } as const;

export interface LoadedTheme {
  id: string;
  bundle: ThemeBundle;
  engine: ThemeEngine;
  chars: number;
}

const loaded = new Map<string, LoadedTheme>();
const loading = new Map<string, Promise<LoadedTheme | null>>();

/** テスト用: 覚えたテーマを捨てる */
export function forgetThemes(): void {
  loaded.clear();
  loading.clear();
}

function remember(t: LoadedTheme): void {
  loaded.delete(t.id);
  loaded.set(t.id, t);
  let chars = 0;
  for (const v of loaded.values()) chars += v.chars;
  for (const [id, v] of loaded) {
    if (loaded.size <= THEME_CACHE_LIMITS.versions && chars <= THEME_CACHE_LIMITS.chars) break;
    if (id === t.id) continue;
    loaded.delete(id);
    chars -= v.chars;
  }
}

/**
 * 版のテーマを読む（無ければ null）。同じ版を同時に読みに行かない。
 * 置き場の中身が壊れていたら ThemeError（呼び出し側は既定のテーマで描く）
 */
export async function loadTheme(storage: StorageAdapter, theme: { id: string; storage_key: string }, engineOpts: EngineOptions = {}): Promise<LoadedTheme | null> {
  const hit = loaded.get(theme.id);
  if (hit) {
    remember(hit);
    return hit;
  }
  let p = loading.get(theme.id);
  if (!p) {
    p = (async () => {
      const obj = await storage.get(theme.storage_key);
      if (!obj) return null;
      const text = await new Response(obj.body).text();
      let bundle: ThemeBundle;
      try {
        bundle = JSON.parse(text) as ThemeBundle;
      } catch {
        throw new ThemeError(`theme bundle is broken: ${theme.id}`, "parse");
      }
      if (!bundle || bundle.format !== THEME_BUNDLE_FORMAT || typeof bundle.files !== "object") throw new ThemeError(`theme bundle is broken: ${theme.id}`, "parse");
      const t: LoadedTheme = { id: theme.id, bundle, engine: createThemeEngine(bundle.files, engineOpts), chars: text.length };
      remember(t);
      return t;
    })().finally(() => loading.delete(theme.id));
    loading.set(theme.id, p);
  }
  return p;
}
