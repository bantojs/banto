/**
 * Liquid のテーマで 1 ページを組み立てる（docs/themes.md）。
 *
 * templates/<種類>.json（セクションの並び）か templates/<種類>.liquid を描き、レイアウト（layout/theme.liquid、
 * {% layout %} か JSON の layout で替えられる）に content_for_layout として入れる。
 * SEO に要るもの（canonical・検索エンジンに載せない印・構造化データ）は本体が content_for_header に入れ、
 * テーマが content_for_header を書き忘れても </head> の前に入れる（テーマ任せにしない）。
 */
import { SafeHtml, ThemeError } from "./engine";
import { stripJsonComments } from "./bundle";
import type { LoadedTheme } from "./cache";
import { readSectionSchemas, renderSectionGroup, withRenderEnv, type Paginate, type RenderEnv, type SectionData, type SectionSchema } from "./shopify";

export type ThemeTemplate = "index" | "collection" | "product" | "404";

interface Prepared {
  schemas: Map<string, SectionSchema>;
  locales: Record<string, unknown>;
  groups: Record<string, unknown>;
  templates: Map<string, { json: Group & { layout?: string | false } } | { liquid: true }>;
  settingsDefaults: Record<string, unknown>;
}
type Group = { sections?: Record<string, SectionData>; order?: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const prepared = new WeakMap<LoadedTheme, Prepared>();

function readJson(src: string | undefined): unknown {
  if (src === undefined) return undefined;
  try {
    return JSON.parse(stripJsonComments(src));
  } catch {
    return undefined;
  }
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  return out;
}

/** 版ごとに一度だけ: セクションの宣言・翻訳・セクションのまとまり・テンプレートの形・設定の既定値 */
function prepare(t: LoadedTheme, locale: string): Prepared {
  const hit = prepared.get(t);
  if (hit) return hit;
  const files = t.bundle.files;
  // 翻訳: 既定のファイル（*.default.json）に、デプロイの言語のファイルを重ねる
  let locales: Record<string, unknown> = {};
  for (const [path, src] of Object.entries(files)) {
    if (/^locales\/[A-Za-z-]+\.default\.json$/.test(path)) {
      const v = readJson(src);
      if (isObject(v)) locales = deepMerge(locales, v);
    }
  }
  for (const name of [`locales/${locale}.default.json`, `locales/${locale}.json`]) {
    const v = readJson(files[name]);
    if (isObject(v)) locales = deepMerge(locales, v);
  }
  const groups: Record<string, unknown> = {};
  const templates: Prepared["templates"] = new Map();
  for (const [path, src] of Object.entries(files)) {
    const g = /^sections\/([A-Za-z0-9_.-]+)\.json$/.exec(path);
    if (g) {
      const v = readJson(src);
      if (isObject(v)) groups[g[1]!] = v;
    }
    const tj = /^templates\/([A-Za-z0-9_.-]+)\.json$/.exec(path);
    if (tj) {
      const v = readJson(src);
      if (isObject(v)) templates.set(tj[1]!, { json: v as Group & { layout?: string | false } });
    }
    const tl = /^templates\/([A-Za-z0-9_.-]+)\.liquid$/.exec(path);
    if (tl && !templates.has(tl[1]!)) templates.set(tl[1]!, { liquid: true });
  }
  // 設定の既定値: config/settings_schema.json の default、その上に config/settings_data.json の current
  const settingsDefaults: Record<string, unknown> = {};
  const schema = readJson(files["config/settings_schema.json"]);
  if (Array.isArray(schema)) for (const group of schema) if (isObject(group) && Array.isArray(group["settings"])) for (const s of group["settings"]) if (isObject(s) && typeof s["id"] === "string" && s["default"] !== undefined) settingsDefaults[s["id"]] = s["default"];
  const data = readJson(files["config/settings_data.json"]);
  const current = isObject(data) ? (typeof data["current"] === "string" && isObject(data["presets"]) ? (data["presets"] as Record<string, unknown>)[data["current"]] : data["current"]) : undefined;
  if (isObject(current)) for (const [k, v] of Object.entries(current)) if (k !== "sections" && k !== "content_for_index" && k !== "blocks") settingsDefaults[k] = v;
  const p: Prepared = { schemas: readSectionSchemas(files), locales, groups, templates, settingsDefaults };
  prepared.set(t, p);
  return p;
}

/** テーマにその種類のテンプレートがあるか（無ければ既定のテーマで描く） */
export function themeHasTemplate(t: LoadedTheme, template: ThemeTemplate, locale = "ja"): boolean {
  return prepare(t, locale).templates.has(template);
}

/** テーマの設定（宣言の既定値 + 運営者が選んだ値） */
export function themeSettings(t: LoadedTheme, saved: Record<string, unknown> | null | undefined, locale = "ja"): Record<string, unknown> {
  return { ...prepare(t, locale).settingsDefaults, ...(saved ?? {}) };
}

export interface ThemePageInput {
  template: ThemeTemplate;
  /** テーマに渡す値（shop・settings・product・collection・routes・request …） */
  globals: Record<string, unknown>;
  /** content_for_header に入れる HTML（本体が作る。canonical など） */
  head: string;
  paginate?: Paginate | null;
  shopOrigin: string;
  shopPath: string;
  mediaBaseUrl: string;
  preview?: boolean;
  locale?: string;
}

const HEAD_MARK = "<!-- banto:head -->";

/** 1 ページを描く。テンプレートが無ければ null。上限・テンプレートの誤りは ThemeError（呼び出し側は既定のテーマで描く） */
export function renderThemePage(t: LoadedTheme, input: ThemePageInput): { html: string; errors: string[] } | null {
  const p = prepare(t, input.locale ?? "ja");
  const tpl = p.templates.get(input.template);
  if (!tpl) return null;
  const head = `${HEAD_MARK}${input.head}`;
  const globals = { ...input.globals, template: { name: input.template, suffix: null, directory: null }, __groups: p.groups };
  const env: RenderEnv = {
    engine: t.engine,
    versionId: t.id,
    shopOrigin: input.shopOrigin,
    shopPath: input.shopPath,
    mediaBaseUrl: input.mediaBaseUrl,
    locales: p.locales,
    schemas: p.schemas,
    globals,
    paginate: input.paginate ?? null,
    preview: Boolean(input.preview),
    errors: [],
  };
  const html = withRenderEnv(env, () => {
    let content: string;
    if ("json" in tpl) {
      content = renderSectionGroup(tpl.json);
      if (tpl.json.layout === false) env.layout = null;
      else if (typeof tpl.json.layout === "string") env.layout = tpl.json.layout;
    } else {
      content = t.engine.render(`templates/${input.template}`, globals);
    }
    if (env.layout === null) return content;
    const layout = `layout/${env.layout ?? "theme"}`;
    if (!t.engine.has(layout)) throw new ThemeError(`template not found: ${layout}`, "missing");
    return t.engine.render(layout, { ...globals, content_for_layout: new SafeHtml(content), content_for_header: new SafeHtml(head) });
  });
  if (html.includes(HEAD_MARK)) return { html, errors: env.errors };
  // テーマが content_for_header を書かなかった: </head> の前（無ければ先頭）に入れる
  const i = html.search(/<\/head>/i);
  return { html: i < 0 ? head + html : html.slice(0, i) + head + html.slice(i), errors: env.errors };
}
