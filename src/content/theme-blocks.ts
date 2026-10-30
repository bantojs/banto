/**
 * テーマが編集の画面に足すもの（メンテナの決定 2026-10-30、docs/themes.md「パターンとブロックのスタイル」）:
 *
 * - **パターン**（config/banto_patterns.json）: 今あるブロックの組み合わせに名前を付けたもの。本文は Banto の決まった書式なので、
 *   テーマを替えても本文は崩れない（パターンは入れるときの型で、入れた後は普通のブロック）
 * - **ブロックのスタイル**（config/banto_block_styles.json）: ブロックの種類ごとの見た目の選択肢。本文には style=<名前> が残り、
 *   class banto-style-<名前> で描く。見た目はテーマの CSS が決め、テーマを替えたら既定の見た目に戻るだけ
 *
 * どちらもテーマを取り込むときに形を確かめる（checkThemeBundle）。Banto の既定のパターンもここに置く（テーマが無くても使える）
 */
import { t, type MessageKey } from "../i18n";

export const PATTERNS_FILE = "config/banto_patterns.json";
export const STYLES_FILE = "config/banto_block_styles.json";
export const PATTERN_LIMITS = { count: 40, body: 20000, title: 60, description: 160 } as const;
export const STYLE_LIMITS = { perKind: 12, label: 40 } as const;
/** スタイルを付けられるブロック */
export const STYLABLE = ["group", "columns", "column", "cover", "media", "gallery", "accordion", "button", "products", "articles"] as const;

export interface EditorPattern {
  name: string;
  title: string;
  description: string;
  /** "theme"（公開中のテーマ）か "banto"（既定） */
  source: "theme" | "banto";
}
export interface PatternBody extends EditorPattern {
  body: string;
}
export type BlockStyles = Partial<Record<(typeof STYLABLE)[number], { name: string; label: string }[]>>;

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const STYLE = /^[a-z0-9][a-z0-9-]{0,29}$/;
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** 文言は文字か、言語ごとの文字（{"ja": "…", "en": "…"}。今の言語が無ければ最初のもの） */
function text(v: unknown, locale: string, max: number): string | null {
  const s = typeof v === "string" ? v : isObject(v) ? (typeof v[locale] === "string" ? v[locale] : Object.values(v).find((x) => typeof x === "string")) : null;
  if (typeof s !== "string") return null;
  const out = s.replace(/[\u0000-\u001f]/g, " ").trim();
  return out && out.length <= max ? out : null;
}

export function parsePatterns(src: string | undefined, locale = "ja"): { patterns: PatternBody[]; errors: string[] } {
  if (src === undefined) return { patterns: [], errors: [] };
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(src);
  } catch {
    return { patterns: [], errors: [`${PATTERNS_FILE}: invalid JSON`] };
  }
  const list = isObject(raw) && Array.isArray(raw["patterns"]) ? raw["patterns"] : Array.isArray(raw) ? raw : null;
  if (!list) return { patterns: [], errors: [`${PATTERNS_FILE}: expected {"patterns": [...]}`] };
  if (list.length > PATTERN_LIMITS.count) errors.push(`${PATTERNS_FILE}: too many patterns (${list.length} > ${PATTERN_LIMITS.count})`);
  const patterns: PatternBody[] = [];
  list.slice(0, PATTERN_LIMITS.count).forEach((p, i) => {
    const at = `${PATTERNS_FILE}: patterns[${i}]`;
    if (!isObject(p)) return errors.push(`${at}: not an object`);
    const name = typeof p["name"] === "string" && NAME.test(p["name"]) ? p["name"] : null;
    const title = text(p["title"], locale, PATTERN_LIMITS.title);
    const body = typeof p["body"] === "string" && p["body"].length <= PATTERN_LIMITS.body ? p["body"] : null;
    if (!name) return errors.push(`${at}.name: lowercase letters, digits and hyphens (up to 40)`);
    if (!title) return errors.push(`${at}.title: required (up to ${PATTERN_LIMITS.title} characters)`);
    if (body === null || !body.trim()) return errors.push(`${at}.body: required (up to ${PATTERN_LIMITS.body} characters)`);
    if (patterns.some((x) => x.name === name)) return errors.push(`${at}.name: duplicated "${name}"`);
    patterns.push({ name, title, description: text(p["description"], locale, PATTERN_LIMITS.description) ?? "", body, source: "theme" });
  });
  return { patterns, errors };
}

export function parseBlockStyles(src: string | undefined, locale = "ja"): { styles: BlockStyles; errors: string[] } {
  if (src === undefined) return { styles: {}, errors: [] };
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(src);
  } catch {
    return { styles: {}, errors: [`${STYLES_FILE}: invalid JSON`] };
  }
  if (!isObject(raw)) return { styles: {}, errors: [`${STYLES_FILE}: expected {"group": [...], ...}`] };
  const styles: BlockStyles = {};
  for (const [kind, list] of Object.entries(raw)) {
    if (!(STYLABLE as readonly string[]).includes(kind)) {
      errors.push(`${STYLES_FILE}: unknown block "${kind}" (${STYLABLE.join(", ")})`);
      continue;
    }
    if (!Array.isArray(list)) {
      errors.push(`${STYLES_FILE}: ${kind}: expected a list`);
      continue;
    }
    if (list.length > STYLE_LIMITS.perKind) errors.push(`${STYLES_FILE}: ${kind}: too many styles (${list.length} > ${STYLE_LIMITS.perKind})`);
    const out: { name: string; label: string }[] = [];
    list.slice(0, STYLE_LIMITS.perKind).forEach((x, i) => {
      const at = `${STYLES_FILE}: ${kind}[${i}]`;
      if (!isObject(x)) return errors.push(`${at}: not an object`);
      const name = typeof x["name"] === "string" && STYLE.test(x["name"]) ? x["name"] : null;
      const label = text(x["label"], locale, STYLE_LIMITS.label);
      if (!name) return errors.push(`${at}.name: lowercase letters, digits and hyphens (up to 30)`);
      if (!label) return errors.push(`${at}.label: required (up to ${STYLE_LIMITS.label} characters)`);
      if (out.some((y) => y.name === name)) return errors.push(`${at}.name: duplicated "${name}"`);
      out.push({ name, label });
    });
    if (out.length) styles[kind as (typeof STYLABLE)[number]] = out;
  }
  return { styles, errors };
}

/** テーマを取り込むときの検査（checkThemeBundle から）。誤りの文言だけを返す */
export function checkThemeEditorFiles(files: Record<string, string>): string[] {
  return [...parsePatterns(files[PATTERNS_FILE]).errors, ...parseBlockStyles(files[STYLES_FILE]).errors];
}

/** Banto の既定のパターン（どのテーマでも使える。文言は言語ごと） */
export function bantoPatterns(): PatternBody[] {
  const p = (name: string, body: string): PatternBody => ({ name: `banto-${name}`, title: t(`pattern.${name}.title` as MessageKey), description: t(`pattern.${name}.desc` as MessageKey), body, source: "banto" });
  return [
    p("hero", [":::: cover height=l overlay=dark align=center", `## ${t("pattern.hero.heading" as MessageKey)}`, "", t("pattern.hero.text" as MessageKey), "", `::: button [${t("pattern.hero.button" as MessageKey)}](/products)`, "::::"].join("\n")),
    p("features", [
      ":::: columns ratio=1-1-1",
      ...[1, 2, 3].flatMap((n) => ["::: column", `### ${t(`pattern.features.title${n}` as MessageKey)}`, "", t("pattern.features.text" as MessageKey), ":::"]),
      "::::",
    ].join("\n")),
    p("faq", [1, 2, 3].map((n) => [`::: accordion icon=plus title="${t(`pattern.faq.q${n}` as MessageKey)}"`, t("pattern.faq.a" as MessageKey), ":::"].join("\n")).join("\n\n")),
    p("story", [":::: media side=left", `## ${t("pattern.story.heading" as MessageKey)}`, "", t("pattern.story.text" as MessageKey), "::::"].join("\n")),
  ];
}
