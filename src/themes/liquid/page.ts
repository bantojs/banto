/**
 * Liquid のテーマで 1 ページを組み立てる（docs/themes.md）。
 *
 * templates/<種類>.json（セクションの並び）か templates/<種類>.liquid を描き、レイアウト（layout/theme.liquid、
 * {% layout %} か JSON の layout で替えられる）に content_for_layout として入れる。
 * SEO に要るもの（canonical・検索エンジンに載せない印・構造化データ）は本体が content_for_header に入れ、
 * テーマが content_for_header を書き忘れても </head> の前に入れる（テーマ任せにしない）。
 */
import { Drop } from "liquidjs/dist/liquid.browser.mjs";
import { getLocale } from "../../i18n";
import { SafeHtml, ThemeError } from "./engine";
import { stripJsonComments } from "./bundle";
import type { LoadedTheme } from "./cache";
import { layoutGroup, readSectionSchemas, renderSection, renderSectionGroup, settingsWith, staticSection, withOverride, withRenderEnv, SECTIONS_PER_REQUEST, type SectionLayouts, type Paginate, type RenderEnv, type SectionData, type SectionOverrides, type SectionSchema, type SettingSchema } from "./shopify";
import { globalSettingsOf } from "./editor";

/** page.<suffix> はショップのページ（同梱モジュール pages、0079）が選んだテンプレート（templates/page.<suffix>.json） */
export type ThemeTemplate = "index" | "collection" | "product" | "404" | "cart" | "search" | "checkout" | "checkout_confirm" | "checkout_done" | "page" | `page.${string}` | "customers/account";

interface Prepared {
  schemas: Map<string, SectionSchema>;
  blockSchemas: Map<string, SectionSchema>;
  locales: Record<string, unknown>;
  groups: Record<string, unknown>;
  templates: Map<string, { json: Group & { layout?: string | false } } | { liquid: true }>;
  settingsDefaults: Record<string, unknown>;
  settingsSchema: SettingSchema[];
  staticSections: Record<string, SectionData>;
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
    const tj = /^templates\/((?:customers\/)?[A-Za-z0-9_.-]+)\.json$/.exec(path);
    if (tj) {
      const v = readJson(src);
      if (isObject(v)) templates.set(tj[1]!, { json: v as Group & { layout?: string | false } });
    }
    const tl = /^templates\/((?:customers\/)?[A-Za-z0-9_.-]+)\.liquid$/.exec(path);
    if (tl && !templates.has(tl[1]!)) templates.set(tl[1]!, { liquid: true });
  }
  // 設定の既定値: config/settings_schema.json の default、その上に config/settings_data.json の current
  const settingsDefaults: Record<string, unknown> = {};
  const settingsSchema: SettingSchema[] = [];
  const schema = readJson(files["config/settings_schema.json"]);
  if (Array.isArray(schema)) for (const group of schema) if (isObject(group) && Array.isArray(group["settings"])) for (const s of group["settings"]) if (isObject(s) && typeof s["id"] === "string") settingsSchema.push(s as SettingSchema);
  const data = readJson(files["config/settings_data.json"]);
  const current = isObject(data) ? (typeof data["current"] === "string" && isObject(data["presets"]) ? (data["presets"] as Record<string, unknown>)[data["current"]] : data["current"]) : undefined;
  let staticSections: Record<string, SectionData> = {};
  if (isObject(current)) {
    for (const [k, v] of Object.entries(current)) if (k !== "sections" && k !== "content_for_index" && k !== "blocks") settingsDefaults[k] = v;
    if (isObject(current["sections"])) staticSections = current["sections"] as Record<string, SectionData>;
  }
  const p: Prepared = { schemas: readSectionSchemas(files), blockSchemas: readSectionSchemas(files, "blocks"), locales, groups, templates, settingsDefaults, settingsSchema, staticSections };
  prepared.set(t, p);
  return p;
}

/** テーマにその種類のテンプレートがあるか（無ければ既定のテーマで描く） */
export function themeHasTemplate(t: LoadedTheme, template: ThemeTemplate, locale: string = getLocale()): boolean {
  return prepare(t, locale).templates.has(template);
}

/** テーマの設定（宣言の既定値 + settings_data.json + 運営者が選んだ値。HTML の種類は SafeHtml） */
export function themeSettings(t: LoadedTheme, saved: Record<string, unknown> | null | undefined, locale: string = getLocale()): Record<string, unknown> {
  const p = prepare(t, locale);
  return settingsWith(p.settingsSchema, { ...p.settingsDefaults, ...globalSettingsOf(saved) });
}

/**
 * template（Shopify では文字列のように比べる: template == 'product'、template.name）。
 * page.about のように別のテンプレートを選んだときは name が page・suffix が about で、文字列としては page.about
 */
class TemplateDrop extends Drop {
  readonly name: string;
  readonly suffix: string | null;
  readonly directory = null;
  constructor(readonly full: string) {
    super();
    const dot = full.indexOf(".");
    this.name = dot < 0 ? full : full.slice(0, dot);
    this.suffix = dot < 0 ? null : full.slice(dot + 1);
  }
  override valueOf(): string {
    return this.full;
  }
  override toString(): string {
    return this.full;
  }
  toJSON(): string {
    return this.full;
  }
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
  /** 運営者が管理画面で変えたセクション・ブロックの値（editor.ts の sectionOverridesOf） */
  overrides?: SectionOverrides;
  /** 運営者が管理画面で変えたセクションの並び（editor.ts の sectionLayoutsOf） */
  layouts?: SectionLayouts;
}

const HEAD_MARK = "<!-- banto:head -->";

function renderEnvOf(t: LoadedTheme, p: Prepared, input: Omit<ThemePageInput, "head">, globals: Record<string, unknown>): RenderEnv {
  return {
    engine: t.engine,
    versionId: t.id,
    shopOrigin: input.shopOrigin,
    shopPath: input.shopPath,
    mediaBaseUrl: input.mediaBaseUrl,
    locales: p.locales,
    schemas: p.schemas,
    blockSchemas: p.blockSchemas,
    blockStack: [],
    staticSections: p.staticSections,
    overrides: input.overrides ?? {},
    layouts: input.layouts ?? {},
    globals,
    paginate: input.paginate ?? null,
    preview: Boolean(input.preview),
    errors: [],
  };
}

/** 1 ページを描く。テンプレートが無ければ null。上限・テンプレートの誤りは ThemeError（呼び出し側は既定のテーマで描く） */
export function renderThemePage(t: LoadedTheme, input: ThemePageInput): { html: string; errors: string[] } | null {
  const p = prepare(t, input.locale ?? getLocale());
  const tpl = p.templates.get(input.template);
  if (!tpl) return null;
  const head = `${HEAD_MARK}${input.head}`;
  const globals = { ...input.globals, template: new TemplateDrop(input.template), __groups: p.groups };
  const env = renderEnvOf(t, p, input, globals);
  // 1 ページの手数・出力の上限は、テンプレート・セクション・レイアウトで分け合う
  const html = withRenderEnv(env, () => t.engine.page(() => {
    let content: string;
    if ("json" in tpl) {
      content = renderSectionGroup(tpl.json, `templates/${input.template}`);
      if (tpl.json.layout === false) env.layout = null;
      else if (typeof tpl.json.layout === "string") env.layout = tpl.json.layout;
    } else {
      content = t.engine.render(`templates/${input.template}`, globals);
    }
    if (env.layout === null) return content;
    const layout = `layout/${env.layout ?? "theme"}`;
    if (!t.engine.has(layout)) throw new ThemeError(`template not found: ${layout}`, "missing");
    return t.engine.render(layout, { ...globals, content_for_layout: new SafeHtml(content), content_for_header: new SafeHtml(head) });
  }));
  if (html.includes(HEAD_MARK)) return { html, errors: env.errors };
  // テーマが content_for_header を書かなかった: </head> の前（無ければ先頭）に入れる
  const i = html.search(/<\/head>/i);
  return { html: i < 0 ? head + html : html.slice(0, i) + head + html.slice(i), errors: env.errors };
}

/**
 * セクションだけを描く（Shopify の Section Rendering API: ?sections=a,b・?section_id=a、AJAX のカートの sections）。
 * id はそのページのテンプレート（JSON）・セクションのまとまりの中の id か、セクションのファイルの名前（{% section %} と同じく置いたものとして描く）。
 * 1 回に SECTIONS_PER_REQUEST 個まで。見つからない id は null（Shopify と同じ）。描くのはページと同じ値（globals）で、手数の上限も 1 ページ分
 */
export function renderThemeSections(t: LoadedTheme, input: Omit<ThemePageInput, "head">, ids: readonly string[]): Record<string, string | null> {
  const p = prepare(t, input.locale ?? getLocale());
  const globals = { ...input.globals, template: new TemplateDrop(input.template), __groups: p.groups };
  const env = renderEnvOf(t, p, input, globals);
  const tpl = p.templates.get(input.template);
  // 探す順: そのページのテンプレート → セクションのまとまり → セクションのファイル
  // 管理画面の並びを当てた後のもの（外したセクションは探さない・足したセクションは探す）
  const places: { key: string; group: Group }[] = [];
  const laid = (key: string, g: Group) => {
    const r = layoutGroup(g, env.layouts?.[key], p.schemas);
    const sections: Record<string, SectionData> = Object.create(null) as Record<string, SectionData>;
    for (const id of r.order) sections[id] = r.sections[id]!;
    return { key, group: { sections, order: r.order } };
  };
  if (tpl && "json" in tpl) places.push(laid(`templates/${input.template}`, tpl.json));
  for (const [name, g] of Object.entries(p.groups)) if (isObject(g)) places.push(laid(`sections/${name}`, g as Group));
  const out: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  withRenderEnv(env, () =>
    t.engine.page(() => {
      for (const id of [...new Set(ids)].slice(0, SECTIONS_PER_REQUEST)) {
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || id === "__proto__") continue;
        const hit = places.find((x) => isObject(x.group.sections) && Object.hasOwn(x.group.sections, id) && isObject(x.group.sections[id]));
        if (hit) out[id] = renderSection(id, withOverride(hit.group.sections![id]!, env.overrides[hit.key]?.[id]));
        else if (t.engine.has(`sections/${id}`)) out[id] = renderSection(id, withOverride(staticSection(id), env.overrides[`static/${id}`]?.[id]));
        else out[id] = null;
      }
      return "";
    }),
  );
  return out;
}
