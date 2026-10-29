/**
 * テーマの設定の値を管理画面で変える（テーマの段階 3、docs/themes.md「設定を変える」）。
 * 束ねたファイルの宣言（config/settings_schema.json とセクションの {% schema %}）から入力の形を作り、送られた値を種類ごとに確かめる。
 * 保存するのは版の settings（theme_versions.settings、0071）だけで、テーマのファイルは変えない（版の中身は変わらない）:
 *   - テーマ全体の設定: settings_schema.json の id をそのまま鍵に
 *   - セクションとブロックの設定: "__sections" の下に「置き場 → セクションの id → { settings, blocks: { ブロックの id → 値 } }」。
 *     置き場は templates/<種類>（JSON のテンプレート）・sections/<まとまり>（セクションのまとまり）・static/<種類>（{% section %} で置いたもの）。
 *     値はテーマのファイルの値と違うものだけを置く
 */
import { stripJsonComments, type ThemeBundle } from "./bundle";
import { readSectionSchemas, type SectionData, type SectionOverrides, type SectionSchema, type SettingSchema } from "./shopify";

export type { SectionOverrides };

export const SECTION_OVERRIDES_KEY = "__sections";


/** 画面で入力できる種類（ほかの種類はテーマのファイルの値のまま） */
export const EDITABLE_SETTING_TYPES = new Set(["text", "textarea", "richtext", "inline_richtext", "html", "url", "video_url", "number", "range", "checkbox", "select", "radio", "color", "color_background", "font_picker", "image_picker"]);
/** 見出し・説明（値を持たない） */
const DISPLAY_TYPES = new Set(["header", "paragraph"]);

/** 値の大きさの上限（文字） */
export const SETTING_VALUE_LIMITS = { short: 500, long: 10_000 } as const;
const LONG_TYPES = new Set(["textarea", "richtext", "html"]);

export interface EditorSetting extends SettingSchema {
  label?: string;
  info?: string;
  content?: string;
  placeholder?: string;
  options?: { value: string; label?: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export interface EditorBlock {
  id: string;
  type: string;
  name: string;
  settings: EditorSetting[];
  values: Record<string, unknown>;
}

export interface EditorSection {
  /** 置き場（templates/index・sections/header-group・static/<種類>） */
  key: string;
  id: string;
  type: string;
  name: string;
  settings: EditorSetting[];
  values: Record<string, unknown>;
  blocks: EditorBlock[];
}

export interface EditorModel {
  global: { name: string; settings: EditorSetting[] }[];
  globalValues: Record<string, unknown>;
  sections: EditorSection[];
  /** 画像の設定に選べるテーマの資産（画像だけ） */
  imageAssets: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function readJson(src: string | undefined): unknown {
  if (src === undefined) return undefined;
  try {
    return JSON.parse(stripJsonComments(src));
  } catch {
    return undefined;
  }
}

function lookup(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const k of path.split(".")) {
    if (!isObject(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** 宣言の文言。"t:..." は翻訳（locales/<言語>.schema.json、無ければ *.default.schema.json）、無ければ id から作る */
function labelOf(v: unknown, schemaLocales: Record<string, unknown>, fallback: string): string {
  if (isObject(v)) v = v["ja"] ?? v["en"] ?? Object.values(v)[0];
  if (typeof v !== "string") return fallback;
  if (v.startsWith("t:")) {
    const hit = lookup(schemaLocales, v.slice(2));
    return typeof hit === "string" ? hit : fallback;
  }
  return v;
}

/** オブジェクトの鍵に使うと Object.prototype に届く名前（テーマのファイルから来る id は鍵に使う前に断る） */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const safeKey = (k: string): boolean => !RESERVED_KEYS.has(k);
const idOk = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id) && id !== SECTION_OVERRIDES_KEY && safeKey(id);
/** 鍵をテーマのファイルや送られたフォームから作る入れ物（プロトタイプを持たない） */
const bag = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) if (safeKey(k)) out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  return out;
}

function editorSettings(list: unknown, loc: Record<string, unknown>): EditorSetting[] {
  if (!Array.isArray(list)) return [];
  const out: EditorSetting[] = [];
  for (const raw of list.slice(0, 200)) {
    if (!isObject(raw) || typeof raw["type"] !== "string") continue;
    const type = raw["type"];
    if (!DISPLAY_TYPES.has(type) && !(EDITABLE_SETTING_TYPES.has(type) && idOk(raw["id"]))) continue;
    const s: EditorSetting = { type, ...(idOk(raw["id"]) ? { id: raw["id"] } : {}), ...(raw["default"] !== undefined ? { default: raw["default"] } : {}) };
    s.label = labelOf(raw["label"], loc, typeof raw["id"] === "string" ? raw["id"] : "");
    if (raw["info"] !== undefined) s.info = labelOf(raw["info"], loc, "");
    if (raw["content"] !== undefined) s.content = labelOf(raw["content"], loc, "");
    if (raw["placeholder"] !== undefined) s.placeholder = labelOf(raw["placeholder"], loc, "");
    if (Array.isArray(raw["options"])) {
      s.options = raw["options"]
        .filter((o): o is Record<string, unknown> => isObject(o) && (typeof o["value"] === "string" || typeof o["value"] === "number"))
        .slice(0, 100)
        .map((o) => ({ value: String(o["value"]), label: labelOf(o["label"], loc, String(o["value"])) }));
    }
    for (const k of ["min", "max", "step"] as const) if (typeof raw[k] === "number" && Number.isFinite(raw[k])) s[k] = raw[k] as number;
    if (typeof raw["unit"] === "string") s.unit = labelOf(raw["unit"], loc, "");
    out.push(s);
  }
  return out;
}

/** 束ねたファイルから、画面に出す入力の形を作る（版ごとに 1 回、画面を開いたときだけ） */
export function editorModel(bundle: ThemeBundle, saved: Record<string, unknown> | null | undefined, locale: string): EditorModel {
  const files = bundle.files;
  let loc: Record<string, unknown> = {};
  for (const name of Object.keys(files)) {
    if (!/^locales\/[A-Za-z-]+\.default\.schema\.json$/.test(name)) continue;
    const v = readJson(files[name]);
    if (isObject(v)) loc = deepMerge(loc, v);
  }
  // 一部だけ訳したファイルでも、訳していない鍵は既定の文言のまま（描く側の page.ts と同じ重ね方）
  const own = readJson(files[`locales/${locale}.schema.json`]);
  if (isObject(own)) loc = deepMerge(loc, own);

  const global: EditorModel["global"] = [];
  const schema = readJson(files["config/settings_schema.json"]);
  if (Array.isArray(schema)) {
    for (const g of schema.slice(0, 100)) {
      if (!isObject(g) || g["name"] === "theme_info") continue;
      const settings = editorSettings(g["settings"], loc);
      if (settings.some((s) => s.id)) global.push({ name: labelOf(g["name"], loc, ""), settings });
    }
  }
  const data = readJson(files["config/settings_data.json"]);
  const current = isObject(data) ? (typeof data["current"] === "string" && isObject(data["presets"]) ? (data["presets"] as Record<string, unknown>)[data["current"]] : data["current"]) : undefined;
  const fileGlobals: Record<string, unknown> = {};
  if (isObject(current)) for (const [k, v] of Object.entries(current)) if (k !== "sections" && k !== "content_for_index" && k !== "blocks") fileGlobals[k] = v;
  const globalValues: Record<string, unknown> = {};
  for (const g of global) for (const s of g.settings) if (s.id) globalValues[s.id] = s.id in (saved ?? {}) ? saved![s.id] : s.id in fileGlobals ? fileGlobals[s.id] : s.default;

  const schemas = readSectionSchemas(files);
  const blockSchemas = readSectionSchemas(files, "blocks");
  const overrides = sectionOverridesOf(saved);
  const sections: EditorSection[] = [];
  const add = (key: string, id: string, d: SectionData) => {
    if (!isObject(d) || typeof d.type !== "string" || !idOk(id) || sections.length >= 200) return;
    const sc: SectionSchema = schemas.get(d.type) ?? {};
    const ov = overrides[key]?.[id];
    const settings = editorSettings(sc.settings, loc);
    const values: Record<string, unknown> = {};
    for (const s of settings) if (s.id) values[s.id] = ov?.settings && s.id in ov.settings ? ov.settings[s.id] : d.settings && s.id in d.settings ? d.settings[s.id] : s.default;
    const blocks: EditorBlock[] = [];
    const order = [...new Set(d.block_order ?? Object.keys(d.blocks ?? {}))].slice(0, 50);
    for (const bid of order) {
      if (!idOk(bid) || !d.blocks || !Object.hasOwn(d.blocks, bid)) continue;
      const b = d.blocks[bid];
      if (!isObject(b) || typeof b.type !== "string") continue;
      const bs = ((sc.blocks ?? []).find((x) => x.type === b.type) ?? blockSchemas.get(b.type)) as (Record<string, unknown> & { settings?: unknown }) | undefined;
      const bset = editorSettings(bs?.settings, loc);
      if (!bset.some((s) => s.id)) continue;
      const bov = ov?.blocks?.[bid];
      const bvals: Record<string, unknown> = {};
      for (const s of bset) if (s.id) bvals[s.id] = bov && s.id in bov ? bov[s.id] : b.settings && s.id in b.settings ? b.settings[s.id] : s.default;
      blocks.push({ id: bid, type: b.type, name: labelOf(bs?.["name"], loc, b.type), settings: bset, values: bvals });
    }
    if (!settings.some((s) => s.id) && blocks.length === 0) return;
    sections.push({ key, id, type: d.type, name: labelOf((sc as Record<string, unknown>)["name"], loc, d.type), settings, values, blocks });
  };
  for (const [path, src] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const m = /^(templates|sections)\/([A-Za-z0-9_.-]+)\.json$/.exec(path);
    if (!m) continue;
    const g = readJson(src);
    if (!isObject(g) || !isObject(g["sections"])) continue;
    const secs = g["sections"] as Record<string, SectionData>;
    const order = Array.isArray(g["order"]) ? (g["order"] as unknown[]).filter((x): x is string => typeof x === "string") : Object.keys(secs);
    for (const id of [...new Set(order)].slice(0, 25)) if (secs[id]) add(`${m[1]}/${m[2]}`, id, secs[id]!);
  }
  // {% section 'x' %} で置いたもの: 値は settings_data.json の current.sections.x、無ければスキーマの default
  const staticTypes = new Set<string>();
  for (const [path, src] of Object.entries(files)) if (path.endsWith(".liquid")) for (const m of src.matchAll(/\{%-?\s*section\s+['"]([A-Za-z0-9_.-]+)['"]\s*-?%\}/g)) staticTypes.add(m[1]!);
  const fileStatic = isObject(current) && isObject(current["sections"]) ? (current["sections"] as Record<string, SectionData>) : {};
  for (const type of [...staticTypes].sort()) {
    const saved0 = fileStatic[type];
    if (isObject(saved0)) add(`static/${type}`, type, { ...saved0, type });
    else {
      const def = schemas.get(type)?.default;
      const blocks: Record<string, { type: string; settings?: Record<string, unknown> }> = {};
      (def?.blocks ?? []).slice(0, 50).forEach((b, i) => {
        if (isObject(b) && typeof b.type === "string") blocks[`${b.type}-${i + 1}`] = { type: b.type, ...(isObject(b.settings) ? { settings: b.settings } : {}) };
      });
      add(`static/${type}`, type, { type, ...(isObject(def?.settings) ? { settings: def!.settings } : {}), blocks, block_order: Object.keys(blocks) });
    }
  }
  const imageAssets = bundle.assets.filter((a) => /\.(png|jpe?g|gif|webp|avif)$/i.test(a)).sort();
  return { global, globalValues, sections, imageAssets };
}

/** 保存した値のうち、セクションの上書き */
export function sectionOverridesOf(saved: Record<string, unknown> | null | undefined): SectionOverrides {
  const v = saved?.[SECTION_OVERRIDES_KEY];
  return isObject(v) ? (v as SectionOverrides) : {};
}

/** 保存した値のうち、テーマ全体の設定（セクションの上書きを除く） */
export function globalSettingsOf(saved: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(saved ?? {})) if (k !== SECTION_OVERRIDES_KEY) out[k] = v;
  return out;
}

/** 1 つの値を種類に沿って確かめる。ok なら値、だめなら理由 */
export function parseSettingValue(s: EditorSetting, raw: string | undefined, imageAssets: readonly string[]): { ok: true; value: unknown } | { ok: false; reason: string } {
  const type = s.type ?? "";
  if (type === "checkbox") return { ok: true, value: raw === "on" || raw === "true" || raw === "1" };
  const v = (raw ?? "").replace(/\r\n/g, "\n");
  const max = LONG_TYPES.has(type) ? SETTING_VALUE_LIMITS.long : SETTING_VALUE_LIMITS.short;
  if (v.length > max) return { ok: false, reason: `too_long:${max}` };
  switch (type) {
    case "number":
    case "range": {
      if (v.trim() === "") return type === "range" ? { ok: false, reason: "number" } : { ok: true, value: null };
      const n = Number(v);
      if (!Number.isFinite(n)) return { ok: false, reason: "number" };
      if (s.min !== undefined && n < s.min) return { ok: false, reason: `min:${s.min}` };
      if (s.max !== undefined && n > s.max) return { ok: false, reason: `max:${s.max}` };
      return { ok: true, value: n };
    }
    case "select":
    case "radio":
      if (!(s.options ?? []).some((o) => o.value === v)) return { ok: false, reason: "option" };
      return { ok: true, value: v };
    case "color":
      if (v === "") return { ok: true, value: "" };
      if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return { ok: false, reason: "color" };
      return { ok: true, value: v.toLowerCase() };
    case "url":
    case "video_url":
      if (v === "") return { ok: true, value: null };
      if (!/^(https:\/\/[^\s"'<>]+|\/[^\s"'<>]*)$/.test(v)) return { ok: false, reason: "url" };
      return { ok: true, value: v };
    case "image_picker":
      if (v === "") return { ok: true, value: null };
      if (!imageAssets.includes(v)) return { ok: false, reason: "option" };
      return { ok: true, value: `asset:${v}` };
    default:
      return { ok: true, value: v };
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * 入力欄に出す値（保存した値かテーマのファイルの値）。画像は資産の名前、資産でない値（shopify://... など）はそのまま出す。
 * 送られた値がこれと同じなら「触っていない」とみなし、検査せずに元の値のままにする（画面で直せない値を壊さない）
 */
export function shownValue(v: unknown, type: string): string {
  if (v === null || v === undefined) return "";
  if (type === "image_picker" && typeof v === "string") return v.startsWith("asset:") ? v.slice(6) : v;
  if (typeof v === "object") return "";
  return String(v);
}

/** 1 つの欄: 触っていなければ元の値、変えていれば検査した値 */
function fieldValue(s: EditorSetting, raw: string | undefined, current: unknown, imageAssets: readonly string[]): ReturnType<typeof parseSettingValue> {
  if (s.type !== "checkbox" && (raw ?? "").replace(/\r\n/g, "\n") === shownValue(current, s.type ?? "")) return { ok: true, value: current };
  return parseSettingValue(s, raw, imageAssets);
}

/** 画面に出したフォームの名前（テーマ全体 g|id、セクション s|置き場|セクション|id、ブロック b|置き場|セクション|ブロック|id） */
export const fieldName = {
  global: (id: string) => `g|${id}`,
  section: (key: string, sid: string, id: string) => `s|${key}|${sid}|${id}`,
  block: (key: string, sid: string, bid: string, id: string) => `b|${key}|${sid}|${bid}|${id}`,
};

/**
 * 送られたフォームから、保存する値を作る。宣言に無い名前は受け取らない。
 * セクション・ブロックの値は、テーマのファイルの値（values の元）と違うものだけを置く。
 * fileValues: テーマのファイルだけの値（editorModel(bundle, null)）。宣言にある鍵だけ作り直すので、宣言から消えた鍵は持ち越さない
 */
export function settingsFromForm(model: EditorModel, form: Record<string, string | undefined>, fileValues: { global: Record<string, unknown>; sections: EditorModel["sections"] }): { ok: true; settings: Record<string, unknown> } | { ok: false; errors: { field: string; label: string; reason: string }[] } {
  const errors: { field: string; label: string; reason: string }[] = [];
  const out = bag<unknown>();
  for (const g of model.global) {
    for (const s of g.settings) {
      if (!s.id || !s.type || !EDITABLE_SETTING_TYPES.has(s.type)) continue;
      const r = fieldValue(s, form[fieldName.global(s.id)], model.globalValues[s.id], model.imageAssets);
      if (!r.ok) errors.push({ field: fieldName.global(s.id), label: s.label ?? s.id, reason: r.reason });
      else if (!same(r.value, fileValues.global[s.id])) out[s.id] = r.value;
    }
  }
  const ov = bag<Record<string, { settings?: Record<string, unknown>; blocks?: Record<string, Record<string, unknown>> }>>() as SectionOverrides;
  for (const sec of model.sections) {
    const base = fileValues.sections.find((x) => x.key === sec.key && x.id === sec.id);
    const entry: { settings?: Record<string, unknown>; blocks?: Record<string, Record<string, unknown>> } = {};
    for (const s of sec.settings) {
      if (!s.id || !s.type || !EDITABLE_SETTING_TYPES.has(s.type)) continue;
      const name = fieldName.section(sec.key, sec.id, s.id);
      const r = fieldValue(s, form[name], sec.values[s.id], model.imageAssets);
      if (!r.ok) errors.push({ field: name, label: `${sec.name} / ${s.label ?? s.id}`, reason: r.reason });
      else if (!same(r.value, base?.values[s.id])) (entry.settings ??= bag())[s.id] = r.value;
    }
    for (const b of sec.blocks) {
      const bbase = base?.blocks.find((x) => x.id === b.id);
      for (const s of b.settings) {
        if (!s.id || !s.type || !EDITABLE_SETTING_TYPES.has(s.type)) continue;
        const name = fieldName.block(sec.key, sec.id, b.id, s.id);
        const r = fieldValue(s, form[name], b.values[s.id], model.imageAssets);
        if (!r.ok) errors.push({ field: name, label: `${sec.name} / ${b.name} / ${s.label ?? s.id}`, reason: r.reason });
        else if (!same(r.value, bbase?.values[s.id])) ((entry.blocks ??= bag())[b.id] ??= bag())[s.id] = r.value;
      }
    }
    if (entry.settings || entry.blocks) (ov[sec.key] ??= bag())[sec.id] = entry;
  }
  if (errors.length) return { ok: false, errors };
  if (Object.keys(ov).length) out[SECTION_OVERRIDES_KEY] = ov;
  return { ok: true, settings: out };
}
