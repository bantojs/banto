import type { Theme } from "./types";
import { defaultTheme } from "./default";

/** 同梱テーマ。管理画面から切り替えられるのはここにあるものだけ（ARCHITECTURE.md「テーマ」） */
export const themes: Record<string, Theme> = { default: defaultTheme };

export function resolveTheme(settings: Record<string, unknown>): Theme {
  const name = typeof settings["theme"] === "string" ? settings["theme"] : "default";
  return themes[name] ?? defaultTheme;
}

export type { Theme } from "./types";
