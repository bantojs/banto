/**
 * ブログの記事の独自の項目（0117_article_fields、メンテナの決定 2026-11-05、docs/blog.md「記事の項目」）。
 * 定義はブログごと（blogs.article_fields）、値は記事（articles.fields）。image は画像の URL（このショップの画像の置き場のものだけ、0120）。形と指す先は DB のトリガー（banto_article_fields_norm）が正で、
 * ここは画面の入力・表示と絞り込みの形を作るだけ。記事は公開の読み物なので、項目もすべて公開
 */

import { shopImageUrl } from "../pages/markdown";
import { getTimeZone, zonedInputToIso } from "../i18n/time";
import type { Filter } from "../db/client";

export const ARTICLE_FIELDS_MAX = 20;
/** 日付・日時の種類と、その順での並べ替え・今日以降だけ（0124、メンテナの決定 2026-11-07）。当てるまで定義に書かせない */
export const ARTICLE_FIELD_DATES_MIGRATION = "0124_article_field_dates";
export const ARTICLE_FIELD_TYPES = ["text", "number", "select", "store", "product", "article", "image", "date", "datetime"] as const;
export type ArticleFieldType = (typeof ARTICLE_FIELD_TYPES)[number];

export interface ArticleFieldDef {
  key: string;
  label: string;
  type: ArticleFieldType;
  /** select の選択肢 */
  options?: string[];
  /** article: 指すブログの id */
  blog?: string;
  /** product / article: いくつも選べる（24 まで） */
  multiple?: boolean;
}

const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** 0117 が当たっているか（ブログの行に列があるかで分かる。問い合わせない） */
export const articleFieldsReady = (blog: { article_fields?: unknown }): boolean => Array.isArray(blog.article_fields);

/** ブログの定義（形の合うものだけ） */
export function articleFieldDefs(blog: { article_fields?: unknown }): ArticleFieldDef[] {
  const raw = Array.isArray(blog.article_fields) ? blog.article_fields : [];
  const out: ArticleFieldDef[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const key = typeof o["key"] === "string" ? o["key"] : "";
    const type = o["type"] as ArticleFieldType;
    if (!KEY.test(key) || !ARTICLE_FIELD_TYPES.includes(type) || out.some((f) => f.key === key)) continue;
    const label = typeof o["label"] === "string" && o["label"].trim() ? o["label"].trim().slice(0, 60) : key;
    const def: ArticleFieldDef = { key, label, type };
    if (type === "select") def.options = Array.isArray(o["options"]) ? o["options"].filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().slice(0, 60)).slice(0, 50) : [];
    if (type === "article" && typeof o["blog"] === "string" && UUID.test(o["blog"])) def.blog = o["blog"];
    if ((type === "product" || type === "article") && o["multiple"] === true) def.multiple = true;
    out.push(def);
    if (out.length >= ARTICLE_FIELDS_MAX) break;
  }
  return out;
}

/**
 * ブログの設定の欄 → 定義。1 行 1 項目で「キー | 表示名 | 種類 | 補足」。種類は text / number / select / store / product / products /
 * article / articles（s が付くといくつも選べる）/ image（画像、0120）。補足は select の選択肢（/ 区切り）か、article の指すブログの URL の名前
 *   例: height | 身長 | number
 *       store | 店舗 | store
 *       author | 書いた人 | article | staff
 *       items | 着用アイテム | products
 */
export function parseArticleFieldRows(input: string, blogs: { id: string; handle: string }[], opts: { dates?: boolean } = {}): { defs: ArticleFieldDef[]; error: string | null } {
  const defs: ArticleFieldDef[] = [];
  for (const line of input.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) continue;
    const [key = "", label = "", typeRaw = "", extra = ""] = line.split("|").map((x) => x.trim());
    const plural = typeRaw === "products" || typeRaw === "articles";
    const type = (plural ? typeRaw.slice(0, -1) : typeRaw) as ArticleFieldType;
    if (!KEY.test(key) || !ARTICLE_FIELD_TYPES.includes(type) || defs.some((f) => f.key === key) || ((type === "date" || type === "datetime") && opts.dates !== true)) return { defs, error: line };
    const def: ArticleFieldDef = { key, label: (label || key).slice(0, 60), type };
    if (type === "select") {
      def.options = extra.split("/").map((x) => x.trim()).filter(Boolean).slice(0, 50);
      if (def.options.length === 0) return { defs, error: line };
    }
    if (type === "article") {
      const b = blogs.find((x) => x.handle === extra);
      if (!b) return { defs, error: line };
      def.blog = b.id;
    }
    if (plural) def.multiple = true;
    defs.push(def);
    if (defs.length > ARTICLE_FIELDS_MAX) return { defs, error: line };
  }
  return { defs, error: null };
}

/** 定義 → 設定の欄の行（parseArticleFieldRows の逆） */
export function formatArticleFieldRows(defs: ArticleFieldDef[], blogs: { id: string; handle: string }[]): string {
  return defs
    .map((f) => {
      const type = f.multiple ? `${f.type}s` : f.type;
      const extra = f.type === "select" ? (f.options ?? []).join("/") : f.type === "article" ? (blogs.find((b) => b.id === f.blog)?.handle ?? "") : "";
      return [f.key, f.label, type, extra].filter((x, i) => i < 3 || x).join(" | ");
    })
    .join("\n");
}

/** 値を文字の並びに（product / article の配列・1 つ、ほかは 1 つ） */
export function fieldValues(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" || typeof v === "number") return [String(v)];
  return [];
}

/**
 * 記事の編集の画面のフォーム（field_<key>）→ 値。形の検査は DB が行う（ここは入力を整えるだけ）。
 * image はこのショップの画像の置き場（mediaBase）のものだけ（ほかは捨てる。src/pages/markdown.ts の shopImageUrl）
 */
export function fieldsFromForm(defs: ArticleFieldDef[], form: Record<string, string | undefined>, mediaBase?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of defs) {
    const raw = (form[`field_${f.key}`] ?? "").trim();
    if (!raw) continue;
    if (f.type === "product" || f.type === "article") {
      const list = [...new Set(raw.split(/[,、\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => HANDLE.test(x)))];
      if (list.length === 0) continue;
      out[f.key] = f.multiple ? list.slice(0, 24) : list[0];
    } else if (f.type === "image") {
      const img = shopImageUrl(raw, mediaBase);
      if (img) out[f.key] = img;
    } else if (f.type === "datetime") {
      // 画面の日時（デプロイの時間帯の「日付と時刻」）→ 時差つき。時差つきで来たものはそのまま（DB が UTC にそろえる）
      const iso = /(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : zonedInputToIso(raw);
      if (iso) out[f.key] = iso;
    } else out[f.key] = raw.slice(0, 500);
  }
  return out;
}

/** 絞り込みの形（fields @> …）。multiple は配列に、number は数に。合わなければ null（何も並べない） */
export function fieldContains(def: ArticleFieldDef, value: string): Record<string, unknown> | null {
  if (!value) return null;
  if (def.type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? { [def.key]: n } : null;
  }
  return { [def.key]: def.multiple ? [value] : value };
}

/** 日付の項目の順（::: articles sort=field:<key>、0124）。from は「今日以降だけ」のときの下限（date は今日の日付、datetime は今日の始まりの UTC の日時） */
export interface FieldSort {
  key: string;
  from: string | null;
  /** いつまで出すかの項目（終了日、0125）。値のある記事はこの項目で、無い記事は key で「今日以降」を決める（from があるときだけ） */
  until?: { key: string; from: string } | null;
}
/** ブログの並び順を日付の項目の順に・いつまで出すかの項目（0125）。当てるまで出さない */
export const BLOG_DATE_ORDER_MIGRATION = "0125_blog_date_order";

/** ブログの定義に日付・日時の項目 key があれば並べ方を作る（無ければ null = 何も並べない）。今日はデプロイの時間帯で決める */
export function fieldSortOf(blog: { article_fields?: unknown }, key: string, fromToday: boolean, now: number = Date.now(), untilKey: string | null = null): FieldSort | null {
  const defs = articleFieldDefs(blog);
  const isDate = (k: string) => defs.find((f) => f.key === k && (f.type === "date" || f.type === "datetime"));
  const def = isDate(key);
  if (!def) return null;
  if (!fromToday) return { key, from: null };
  const from = todayBound(def.type as "date" | "datetime", now);
  const u = untilKey && untilKey !== key ? isDate(untilKey) : undefined;
  return { key, from, ...(u && from ? { until: { key: u.key, from: todayBound(u.type as "date" | "datetime", now)! } } : {}) };
}

/** 今日の下限: date は今日の日付（デプロイの時間帯の YYYY-MM-DD。en-CA はこの並び）、datetime は今日の 0 時の UTC の日時 */
function todayBound(type: "date" | "datetime", now: number): string | null {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: getTimeZone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  if (type === "date") return today;
  const start = zonedInputToIso(`${today}T00:00`);
  return start ? `${new Date(start).toISOString().slice(0, 19)}Z` : null;
}

/** PostgREST の order と絞り込み（articles_member_page と同じ並び: その値の早い順、値の無い記事は後ろ、同じなら新しい順） */
export function fieldSortQuery(fs: FieldSort): { order: string; where: Filter[] } {
  const order = `fields->>${fs.key}.asc.nullslast,published_at.desc,id.desc`;
  if (!fs.from) return { order, where: [] };
  const byKey: Filter = { col: `fields->>${fs.key}`, op: "gte", value: fs.from };
  if (!fs.until) return { order, where: [byKey] };
  // 終了日があればその日付で、無ければ並び順の項目で（articles_member_page と同じ）
  const u = `fields->>${fs.until.key}`;
  return { order, where: [{ or: [{ col: u, op: "gte", value: fs.until.from }, { and: [{ col: u, op: "is", value: null }, byKey] }] }] };
}

/** 日付・日時の値の見せ方（日付は時間帯でずらさない） */
export function fieldDateLabel(type: "date" | "datetime", v: string, format: (iso: string, opts?: { dateOnly?: boolean }) => string): string {
  return type === "date" ? format(`${v}T12:00:00Z`, { dateOnly: true }) : format(v);
}

/** ブログの並び順が日付の項目の順（0124、article_order = field:<キー>）なら、その並べ方（article_from_today なら今日以降だけ） */
export function blogFieldSort(blog: { article_fields?: unknown; article_order?: unknown; article_from_today?: unknown; article_until?: unknown }, now: number = Date.now()): FieldSort | null {
  const o = blog.article_order;
  if (typeof o !== "string" || !o.startsWith("field:")) return null;
  return fieldSortOf(blog, o.slice(6), blog.article_from_today === true, now, typeof blog.article_until === "string" ? blog.article_until : null);
}
