import { ja, type MessageKey } from "./ja";
import { en } from "./en";

export type Locale = "ja" | "en";
export const LOCALES: readonly Locale[] = ["ja", "en"];
const dictionaries: Record<Locale, Record<MessageKey, string>> = { ja, en };

/**
 * 現在のロケール。デプロイ単位で BANTO_LOCALE から決まり、app.ts のミドルウェアが毎リクエスト設定する。
 * 同じデプロイ内では常に同じ値になるので、リクエストをまたいで競合しない（リクエストごとの切り替えは持たない）。
 */
let currentLocale: Locale = "ja";

export function isLocale(s: string | undefined | null): s is Locale {
  return s === "ja" || s === "en";
}

export function setLocale(locale: string | undefined | null): Locale {
  currentLocale = isLocale(locale) ? locale : "ja";
  return currentLocale;
}

export function getLocale(): Locale {
  return currentLocale;
}

/** 文言取得。未知のキーはキーそのものを返す（落とさない） */
export function t(key: MessageKey, locale: Locale = currentLocale): string {
  return dictionaries[locale][key] ?? dictionaries.ja[key] ?? key;
}

/** 文言に値を埋める（{name} を置き換える）。値は文字列のまま入るので、HTML に出すときは JSX がエスケープする */
export function tf(key: MessageKey, vars: Record<string, string | number>, locale: Locale = currentLocale): string {
  return t(key, locale).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export type { MessageKey };
