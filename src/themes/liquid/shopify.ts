/**
 * Shopify のテーマと同じ名前のフィルター・タグ（人間の決定 2026-10-28、docs/themes.md）。
 * 名前と使い方だけを合わせ、中身は Banto のデータで作る（Shopify の文章・コードは持ち込まない）。
 *
 * 描画は同期で、1 回の描画のあいだの文脈（URL の起点・版・翻訳・セクション・レイアウト）は RenderEnv に置く。
 * 1 つの isolate の中で描画は同時に走らない（同期なので途中で他のリクエストに切り替わらない）ので、モジュールの変数でよい。
 */
/// <reference path="./liquidjs.d.ts" />
import { Hash, Tag, type Context, type Emitter, type Liquid, type TagToken, type Template, type TopLevelToken } from "liquidjs/dist/liquid.browser.mjs";
import { escapeHtml, SafeHtml, ThemeError, type ThemeEngine } from "./engine";
import { stripJsonComments } from "./bundle";

/** セクションの設定の宣言（{% schema %} の中身。使うのは既定値だけ） */
export interface SectionSchema {
  name?: string;
  settings?: SettingSchema[];
  blocks?: { type?: string; settings?: SettingSchema[] }[];
  max_blocks?: number;
  /** {% section %} で置いたセクション（JSON のテンプレートの外）の既定の設定とブロック */
  default?: { settings?: Record<string, unknown>; blocks?: { type: string; settings?: Record<string, unknown> }[] };
}
export interface SettingSchema {
  id?: string;
  type?: string;
  default?: unknown;
}

/** 1 つのテンプレート・まとまりに置けるセクションの数と、1 つのセクションのブロックの数（Shopify と同じ） */
export const SECTION_LIMITS = { sections: 25, blocks: 50 } as const;
/** HTML として出す設定の種類（テーマを書く人と design の項目を持つ人だけが決める値。テンプレートの中の HTML と同じ扱い） */
const HTML_SETTING_TYPES = new Set(["richtext", "inline_richtext", "html"]);

/** 設定の宣言に沿って値をそろえる: 既定値の上に値を重ね、HTML の種類の文字列は SafeHtml にする */
export function settingsWith(schema: SettingSchema[] | undefined, values: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const st of schema ?? []) if (st.id && st.default !== undefined) out[st.id] = st.default;
  Object.assign(out, values ?? {});
  for (const st of schema ?? []) {
    if (!st.id || !st.type) continue;
    const v = out[st.id];
    if (HTML_SETTING_TYPES.has(st.type) && typeof v === "string") out[st.id] = new SafeHtml(v);
    // 管理画面で選んだテーマの資産（"asset:<名前>"）。image_url が版の資産の URL にする
    else if (st.type === "image_picker" && typeof v === "string" && v.startsWith("asset:")) out[st.id] = { asset: v.slice(6), alt: "" };
  }
  return out;
}

/** 運営者が管理画面で変えたセクション・ブロックの値（置き場 → セクションの id → 値。src/themes/liquid/editor.ts） */
export type SectionOverrides = Record<string, Record<string, { settings?: Record<string, unknown>; blocks?: Record<string, Record<string, unknown>> }>>;

/** JSON のテンプレート・セクションのまとまりの 1 つ */
export interface BlockData {
  type: string;
  settings?: Record<string, unknown>;
  disabled?: boolean;
  /** {% content_for 'block' %} で置いたブロック（順の外） */
  static?: boolean;
  /** テーマのブロックの中のブロック（{% content_for 'blocks' %}） */
  blocks?: Record<string, BlockData>;
  block_order?: string[];
}

export interface SectionData {
  type: string;
  settings?: Record<string, unknown>;
  blocks?: Record<string, BlockData>;
  block_order?: string[];
  disabled?: boolean;
}

/** テーマのブロックの入れ子の深さ（Shopify は 8 段まで） */
export const BLOCK_DEPTH_MAX = 8;

export interface Paginate {
  current_page: number;
  page_size: number;
  items: number | null;
  pages: number | null;
  previous: { title: string; url: string; is_link: true } | null;
  next: { title: string; url: string; is_link: true } | null;
  parts: { title: string; url: string; is_link: boolean }[];
}

export interface RenderEnv {
  engine: ThemeEngine;
  /** テーマの版の id（資産の URL に使う） */
  versionId: string;
  /** ショップのドメインの起点（https://shop.example.jp）と、ドメインの上でのパス（""） */
  shopOrigin: string;
  shopPath: string;
  mediaBaseUrl: string;
  /** 翻訳（locales/ja.json など。既定の言語にない鍵は既定のファイルから） */
  locales: Record<string, unknown>;
  schemas: Map<string, SectionSchema>;
  /** テーマのブロック（blocks/*.liquid）の {% schema %} */
  blockSchemas?: Map<string, SectionSchema>;
  /** 今描いているセクション・ブロックの入れ子（{% content_for 'blocks' %} が読む） */
  blockStack?: { section: Record<string, unknown>; blocks: Record<string, BlockData>; order: string[] }[];
  /** config/settings_data.json の current.sections（{% section %} で置いたセクションの値） */
  staticSections: Record<string, SectionData>;
  /** 運営者が管理画面で変えたセクション・ブロックの値（置き場 → セクションの id、src/themes/liquid/editor.ts） */
  overrides: SectionOverrides;
  /** セクションの外から渡す値（product・collection など。セクションも同じものを読む） */
  globals: Record<string, unknown>;
  paginate: Paginate | null;
  /** テンプレートが {% layout %} で選んだレイアウト（undefined なら theme、null なら無し） */
  layout?: string | null;
  /** プレビューなら誤りをその場所に出す。本番は空にして続ける */
  preview: boolean;
  errors: string[];
}

let current: RenderEnv | null = null;
const env = (): RenderEnv => {
  if (!current) throw new ThemeError("theme render outside of a page", "render");
  return current;
};

/** env を置いて描く（同期） */
export function withRenderEnv<T>(e: RenderEnv, fn: () => T): T {
  const prev = current;
  current = e;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

// ---------- 値の取り出し ----------
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
/** liquidjs はキーワード引数を [鍵, 値] の配列で渡す */
function kwargs(args: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) if (Array.isArray(a) && a.length === 2 && typeof a[0] === "string") out[a[0]] = a[1];
  return out;
}
const positional = (args: unknown[]) => args.filter((a) => !(Array.isArray(a) && a.length === 2 && typeof a[0] === "string"));
const attr = (k: string, v: unknown) => (v === undefined || v === null || v === false || v === "" ? "" : ` ${k}="${escapeHtml(v)}"`);

// ---------- お金（Shopify と同じく、金額は最小の単位の 100 倍の整数。JPY は 1 円 = 100） ----------
const yen = (v: unknown) => Math.round(Number(v ?? 0) / 100);
const grouped = (n: number) => String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export const formatMoney = (v: unknown) => `${yen(v) < 0 ? "-" : ""}¥${grouped(yen(v))}`;

// ---------- 画像 ----------
/** image_url が返す URL（後ろの image_tag が大きさと代わりの文字を使えるように元の画像を持つ） */
export class ImageUrl {
  constructor(
    readonly url: string,
    readonly width: number | null,
    readonly height: number | null,
    readonly alt: string,
  ) {}
  toString(): string {
    return this.url;
  }
}

interface ImageLike {
  key?: string;
  thumb_key?: string | null;
  width?: number | null;
  height?: number | null;
  alt?: string | null;
  src?: string;
  /** テーマの資産の名前（設定の image_picker で選んだもの） */
  asset?: string;
}

function themeAssetUrl(name: string): string {
  const e = env();
  return `${e.shopOrigin}/_theme/${e.versionId}/assets/${encodeURIComponent(name)}`;
}

function mediaUrl(key: string): string {
  return `${env().mediaBaseUrl.replace(/\/+$/, "")}/${key}`;
}

/** 画像の URL。Banto は縮小した版を 2 つ（本画像と長辺 400px）しか持たないので、幅 400 以下ならサムネイル */
function imageUrlOf(input: unknown, width?: number, height?: number): ImageUrl | string {
  let img: ImageLike | null = null;
  if (isObject(input)) img = (isObject(input["preview_image"]) ? input["preview_image"] : isObject(input["featured_image"]) ? input["featured_image"] : input) as ImageLike;
  if (!img) return typeof input === "string" ? input : "";
  if (typeof img.asset === "string") return new ImageUrl(themeAssetUrl(img.asset), null, null, String(img.alt ?? ""));
  if (!img.key) return typeof img.src === "string" ? img.src : "";
  const key = width && width <= 400 && img.thumb_key ? img.thumb_key : img.key;
  const w = img.width ?? null;
  const h = img.height ?? null;
  // 求めた幅に合わせた大きさ（縦横の比は元のまま）
  const tw = width ?? (height && w && h ? Math.round((height * w) / h) : w);
  const th = tw && w && h ? Math.round((tw * h) / w) : (height ?? h);
  return new ImageUrl(mediaUrl(key), tw ?? null, th ?? null, String(img.alt ?? ""));
}

// ---------- 翻訳 ----------
function lookup(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const k of path.split(".")) {
    if (!isObject(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function translate(key: string, args: Record<string, unknown>): string | SafeHtml {
  const e = env();
  let v = lookup(e.locales, key);
  if (isObject(v) && "count" in args) {
    const n = Number(args["count"]);
    v = (n === 0 && v["zero"]) || (n === 1 && v["one"]) || v["other"];
  }
  if (typeof v !== "string") return `translation missing: ${key}`;
  const html = key.endsWith("_html");
  const out = v.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, name: string) => (name in args ? (html ? escapeHtml(args[name]) : String(args[name] ?? "")) : ""));
  return html ? new SafeHtml(out) : out;
}

// ---------- フィルター ----------
export function registerShopifyFilters(liquid: Liquid): void {
  liquid.registerFilter("money", (v: unknown) => formatMoney(v));
  liquid.registerFilter("money_without_trailing_zeros", (v: unknown) => formatMoney(v));
  liquid.registerFilter("money_with_currency", (v: unknown) => `${formatMoney(v)} JPY`);
  liquid.registerFilter("money_without_currency", (v: unknown) => `${yen(v) < 0 ? "-" : ""}${grouped(yen(v))}`);

  liquid.registerFilter("image_url", (input: unknown, ...args: unknown[]) => {
    const kw = kwargs(args);
    return imageUrlOf(input, kw["width"] ? Number(kw["width"]) : undefined, kw["height"] ? Number(kw["height"]) : undefined);
  });
  // 古い書き方（img_url: '400x'）
  liquid.registerFilter("img_url", (input: unknown, size?: unknown) => {
    // 長い入力で遅くならない形（数字は 5 桁まで）
    const sz = String(size ?? "");
    const m = sz.length <= 16 ? /^(\d{1,5})?(?:x(\d{1,5})?)?$/.exec(sz) : null;
    return imageUrlOf(input, m?.[1] ? Number(m[1]) : undefined, m?.[2] ? Number(m[2]) : undefined);
  });
  liquid.registerFilter("image_tag", (input: unknown, ...args: unknown[]) => {
    const kw = kwargs(args);
    const u = input instanceof ImageUrl ? input : null;
    const src = String(input ?? "");
    if (!src) return "";
    const alt = kw["alt"] !== undefined ? kw["alt"] : (u?.alt ?? "");
    const width = kw["width"] ?? u?.width;
    const height = kw["height"] ?? u?.height;
    const extra = Object.entries(kw)
      .filter(([k]) => !["alt", "width", "height", "widths", "preload", "loading"].includes(k) && /^[a-z][a-z0-9_-]*$/.test(k))
      .map(([k, v]) => attr(k.replace(/_/g, "-"), v))
      .join("");
    return new SafeHtml(`<img src="${escapeHtml(src)}"${attr("alt", alt) || ' alt=""'}${attr("width", width)}${attr("height", height)}${attr("loading", kw["loading"] ?? "lazy")}${extra}>`);
  });
  liquid.registerFilter("asset_url", (name: unknown) => themeAssetUrl(String(name ?? "")));
  liquid.registerFilter("asset_img_url", (name: unknown) => {
    const e = env();
    return `${e.shopOrigin}/_theme/${e.versionId}/assets/${encodeURIComponent(String(name ?? ""))}`;
  });
  liquid.registerFilter("stylesheet_tag", (url: unknown) => new SafeHtml(`<link rel="stylesheet" href="${escapeHtml(url)}" media="all">`));
  liquid.registerFilter("script_tag", (url: unknown) => new SafeHtml(`<script src="${escapeHtml(url)}"></script>`));
  liquid.registerFilter("preload_tag", (url: unknown, ...args: unknown[]) => new SafeHtml(`<link rel="preload" href="${escapeHtml(url)}"${attr("as", kwargs(args)["as"])}>`));

  liquid.registerFilter("t", (key: unknown, ...args: unknown[]) => translate(String(key ?? ""), kwargs(args)));
  liquid.registerFilter("translate", (key: unknown, ...args: unknown[]) => translate(String(key ?? ""), kwargs(args)));

  // JSON は <script> の中で使う。</script> や <!-- で抜けられないように < > & を逃がす（引用符は逃がさない。属性に入れるときは escape を重ねる）
  liquid.registerFilter("json", (v: unknown) =>
    new SafeHtml(
      JSON.stringify(v instanceof SafeHtml ? v.html : (v ?? null))
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/&/g, "\\u0026"),
    ),
  );
  const handleize = (v: unknown) =>
    String(v ?? "")
      .toLowerCase()
      .normalize("NFKC")
      .replace(/['"]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "");
  liquid.registerFilter("handleize", handleize);
  liquid.registerFilter("handle", handleize);
  liquid.registerFilter("pluralize", (n: unknown, one: unknown, other: unknown) => (Number(n) === 1 ? one : other));
  liquid.registerFilter("link_to", (text: unknown, url: unknown, title?: unknown) => new SafeHtml(`<a href="${escapeHtml(url)}"${attr("title", title)}>${text instanceof SafeHtml ? text.html : escapeHtml(text)}</a>`));
  liquid.registerFilter("within", (url: unknown) => url);
  liquid.registerFilter("default_pagination", (p: unknown, ...args: unknown[]) => {
    const pg = isObject(p) ? (p as unknown as Paginate) : null;
    if (!pg) return "";
    const kw = kwargs(args);
    const prev = pg.previous ? `<span class="prev"><a href="${escapeHtml(pg.previous.url)}">${escapeHtml(kw["previous"] ?? "«")}</a></span>` : "";
    const next = pg.next ? `<span class="next"><a href="${escapeHtml(pg.next.url)}">${escapeHtml(kw["next"] ?? "»")}</a></span>` : "";
    return new SafeHtml(`${prev}${next}`);
  });
  liquid.registerFilter("placeholder_svg_tag", (_name: unknown, cls?: unknown) => new SafeHtml(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 525 525"${attr("class", cls)} aria-hidden="true"><rect width="525" height="525" fill="#eee"/></svg>`));
  liquid.registerFilter("time_tag", (v: unknown, ...args: unknown[]) => {
    const d = new Date(String(v ?? ""));
    if (Number.isNaN(d.getTime())) return "";
    const p = positional(args);
    // parseAndRenderSync の結果はもうエスケープ済み（二重にしない）
    const shown = p[0] ? String(liquid.parseAndRenderSync(`{{ d | date: f }}`, { d: d.toISOString(), f: String(p[0]) })) : escapeHtml(d.toISOString().slice(0, 10));
    return new SafeHtml(`<time datetime="${escapeHtml(d.toISOString())}">${shown}</time>`);
  });
}

// ---------- タグ ----------
/** 終わりのタグまでの中身を、Liquid として解かずに文字のまま取る（schema・stylesheet・javascript） */
function rawUntil(name: string, token: TagToken, rest: TopLevelToken[]): string {
  let out = "";
  while (rest.length) {
    const t = rest.shift()!;
    if ((t as TagToken).name === `end${name}`) return out;
    out += t.getText();
  }
  throw new Error(`tag ${token.getText()} not closed`);
}

/** 中身を Liquid として解き、終わりのタグで止める（form・paginate・style） */
function parseBody(tag: Tag & { templates: Template[] }, name: string, token: TagToken, rest: TopLevelToken[], liquid: Liquid): void {
  const stream = liquid.parser
    .parseStream(rest)
    .on("template", (tpl: Template) => tag.templates.push(tpl))
    .on(`tag:end${name}`, () => stream.stop())
    .on("end", () => {
      throw new Error(`tag ${token.getText()} not closed`);
    });
  stream.start();
}

/** セクションを 1 つ描く（section タグ・JSON のテンプレート・セクションのまとまりで共通）。誤りはそのセクションだけを空にする */
export function renderSection(id: string, data: SectionData, index = 1): string {
  const e = env();
  if (data.disabled || typeof data.type !== "string") return "";
  const schema = e.schemas.get(data.type) ?? {};
  const order = [...new Set(data.block_order ?? Object.keys(data.blocks ?? {}))].slice(0, SECTION_LIMITS.blocks);
  const blocks = order
    .map((bid) => {
      const b = data.blocks?.[bid];
      if (!b || b.disabled) return null;
      return blockObject(bid, b, schema);
    })
    .filter(Boolean);
  const section = { id, type: data.type, settings: settingsWith(schema.settings, data.settings), blocks, index, location: "template" };
  const stack = (e.blockStack ??= []);
  stack.push({ section, blocks: data.blocks ?? {}, order });
  try {
    const html = e.engine.render(`sections/${data.type}`, { ...e.globals, section });
    return `<div id="section-${escapeHtml(id)}" class="theme-section">${html}</div>`;
  } catch (err) {
    // 上限を超えたらページ全体を止める（セクションを空にして続けると、1 ページで何度も上限まで回せてしまう）
    if (err instanceof ThemeError && err.kind === "limit") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    e.errors.push(`sections/${data.type}: ${msg}`);
    return e.preview ? `<div class="theme-error" style="border:2px solid #c00;padding:8px;color:#c00">${escapeHtml(`sections/${data.type}: ${msg}`)}</div>` : "";
  } finally {
    stack.pop();
  }
}

/** section.blocks・block の 1 つ（設定の宣言はセクションの schema、無ければテーマのブロックの schema） */
function blockObject(id: string, b: BlockData, parent: SectionSchema) {
  const e = env();
  const bs = (parent.blocks ?? []).find((x) => x.type === b.type) ?? e.blockSchemas?.get(b.type);
  return { id, type: b.type, settings: settingsWith(bs?.settings, b.settings), shopify_attributes: new SafeHtml(`data-block-id="${escapeHtml(id)}"`) };
}

/** テーマのブロック（blocks/<種類>.liquid）を 1 つ描く。中のブロックも同じ仕組みで描けるように入れ子に積む */
function renderThemeBlock(id: string, b: BlockData): string {
  const e = env();
  const stack = (e.blockStack ??= []);
  const top = stack[stack.length - 1];
  if (!top || b.disabled || typeof b.type !== "string") return "";
  if (stack.length > BLOCK_DEPTH_MAX) throw new ThemeError(`blocks nested deeper than ${BLOCK_DEPTH_MAX}`, "limit");
  const name = `blocks/${b.type}`;
  if (!e.engine.has(name)) {
    e.errors.push(`${name}: missing`);
    return "";
  }
  const block = blockObject(id, b, e.blockSchemas?.get(b.type) ?? {});
  const order = [...new Set(b.block_order ?? Object.keys(b.blocks ?? {}))].slice(0, SECTION_LIMITS.blocks);
  stack.push({ section: top.section, blocks: b.blocks ?? {}, order });
  try {
    return e.engine.render(name, { ...e.globals, section: top.section, block });
  } catch (err) {
    if (err instanceof ThemeError && err.kind === "limit") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    e.errors.push(`${name}: ${msg}`);
    return e.preview ? `<div class="theme-error" style="border:2px solid #c00;padding:8px;color:#c00">${escapeHtml(`${name}: ${msg}`)}</div>` : "";
  } finally {
    stack.pop();
  }
}

/** JSON のセクションのまとまり（templates/*.json・sections/*.json）を順に描く。同じ id は 1 回、数は 25 まで */
export function renderSectionGroup(group: { sections?: Record<string, SectionData>; order?: string[] }, key: string): string {
  const sections = isObject(group.sections) ? group.sections : {};
  const order = [...new Set(Array.isArray(group.order) ? group.order.filter((x): x is string => typeof x === "string") : Object.keys(sections))].slice(0, SECTION_LIMITS.sections);
  const ov = env().overrides[key];
  return order.map((id, i) => (isObject(sections[id]) ? renderSection(id, withOverride(sections[id]!, ov?.[id]), i + 1) : "")).join("");
}

/** {% section 'x' %} で置いたセクション: settings_data.json の current.sections.x、無ければスキーマの default */
function staticSection(type: string): SectionData {
  const e = env();
  const saved = e.staticSections[type];
  if (isObject(saved)) return { ...saved, type };
  const def = e.schemas.get(type)?.default;
  const blocks: Record<string, { type: string; settings?: Record<string, unknown> }> = {};
  (def?.blocks ?? []).slice(0, SECTION_LIMITS.blocks).forEach((b, i) => {
    if (isObject(b) && typeof b.type === "string") blocks[`${b.type}-${i + 1}`] = { type: b.type, ...(isObject(b.settings) ? { settings: b.settings } : {}) };
  });
  return { type, ...(isObject(def?.settings) ? { settings: def!.settings } : {}), blocks, block_order: Object.keys(blocks) };
}

/**
 * {% form %} の送り先（Shopify の名前 → Banto の画面）。contact はお問い合わせ（同梱モジュール inquiries。OFF なら送り先は 404）、
 * customer_login / create_customer は会員のログイン（Banto はメールのコードでログインするので、どちらも同じ）
 */
const FORM_ACTIONS: Readonly<Record<string, string>> = {
  product: "/cart/add",
  cart: "/cart",
  contact: "/inquiries/new",
  customer_login: "/account/login",
  create_customer: "/account/login",
  recover_customer_password: "/account/login",
};

/** {% banto_confirmation %} を描いた印（描いた結果にこれが無ければ、既定のテーマの最終確認画面にする） */
export const CONFIRMATION_MARK = "<!-- banto:confirmation -->";

export function registerShopifyTags(liquid: Liquid): void {
  liquid.registerTag(
    "schema",
    class extends Tag {
      constructor(token: TagToken, rest: TopLevelToken[], l: Liquid) {
        super(token, rest, l);
        rawUntil("schema", token, rest);
      }
      *render() {
        return "";
      }
    },
  );
  for (const [name, open, close] of [
    ["stylesheet", "<style>", "</style>"],
    ["javascript", "<script>", "</script>"],
  ] as const) {
    liquid.registerTag(
      name,
      class extends Tag {
        body: string;
        constructor(token: TagToken, rest: TopLevelToken[], l: Liquid) {
          super(token, rest, l);
          this.body = rawUntil(name, token, rest);
        }
        *render(_ctx: Context, emitter: Emitter) {
          // 中身はテーマを書いた人の CSS / JS（テーマの資産と同じ扱い）。閉じタグで抜けられないものだけ断つ
          emitter.write(new RegExp(`</${close.slice(2, -1)}`, "i").test(this.body) ? "" : `${open}${this.body}${close}`);
        }
      },
    );
  }
  liquid.registerTag(
    "style",
    class extends Tag {
      templates: Template[] = [];
      constructor(token: TagToken, rest: TopLevelToken[], l: Liquid) {
        super(token, rest, l);
        parseBody(this, "style", token, rest, l);
      }
      *render(ctx: Context, emitter: Emitter) {
        emitter.write("<style>");
        yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
        emitter.write("</style>");
      }
    },
  );
  // {% layout 'name' %} / {% layout none %}: このテンプレートを包むレイアウトを選ぶ
  liquid.registerTag(
    "layout",
    class extends Tag {
      layoutName: string | null;
      constructor(token: TagToken, rest: TopLevelToken[], l: Liquid) {
        super(token, rest, l);
        const a = token.args.trim();
        const m = /^['"]([A-Za-z0-9_.-]+)['"]$/.exec(a);
        if (a !== "none" && !m) throw new Error(`illegal tag: ${token.getText()}`);
        this.layoutName = m ? m[1]! : null;
      }
      *render() {
        env().layout = this.layoutName;
        return "";
      }
    },
  );
  liquid.registerTag(
    "section",
    class extends Tag {
      type: string;
      constructor(token: TagToken, rest: TopLevelToken[], l: Liquid) {
        super(token, rest, l);
        const m = /^['"]([A-Za-z0-9_.-]+)['"]$/.exec(token.args.trim());
        if (!m) throw new Error(`illegal tag: ${token.getText()}`);
        this.type = m[1]!;
      }
      *render(_ctx: Context, emitter: Emitter) {
        emitter.write(renderSection(this.type, withOverride(staticSection(this.type), env().overrides[`static/${this.type}`]?.[this.type])));
      }
    },
  );
  // 最終確認画面の中身（特商法の表示と注文を確定するボタン）。Banto が描いたものをそのまま置く。templates/checkout_confirm には必須
  liquid.registerTag(
    "banto_confirmation",
    class extends Tag {
      *render(_ctx: Context, emitter: Emitter) {
        const v = env().globals["__banto_confirmation"];
        if (v instanceof SafeHtml) emitter.write(`${CONFIRMATION_MARK}${v.html}`);
      }
    },
  );
  // テーマのブロック: {% content_for 'blocks' %}（今のセクション・ブロックの中のブロックを順に）、
  // {% content_for 'block', type: 'x', id: 'y' %}（決まった場所に置くブロック。値は中のブロックの id から、無ければ宣言の既定値）
  liquid.registerTag(
    "content_for",
    class extends Tag {
      kind: "blocks" | "block";
      hash: Hash;
      constructor(token: TagToken, rest: TopLevelToken[], l: Liquid) {
        super(token, rest, l);
        const m = /^\s*['"](blocks|block)['"]\s*(.*)$/s.exec(token.args);
        if (!m) throw new Error(`illegal tag: ${token.getText()}`);
        this.kind = m[1] as "blocks" | "block";
        this.hash = new Hash(m[2]!.replace(/^\s*,/, ""), l.options.keyValueSeparator);
      }
      *render(ctx: Context, emitter: Emitter) {
        const e = env();
        const top = e.blockStack?.[e.blockStack.length - 1];
        if (!top) return;
        if (this.kind === "blocks") {
          for (const bid of top.order) {
            const b = top.blocks[bid];
            if (b && !b.static) emitter.write(renderThemeBlock(bid, b));
          }
          return;
        }
        const h = (yield this.hash.render(ctx)) as Record<string, unknown>;
        const type = typeof h["type"] === "string" ? h["type"] : "";
        const id = typeof h["id"] === "string" ? h["id"] : "";
        if (!/^[A-Za-z0-9_.-]{1,100}$/.test(type) || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) return;
        const saved = top.blocks[id];
        emitter.write(renderThemeBlock(id, saved && saved.type === type ? saved : { type, static: true }));
      }
    },
  );
  liquid.registerTag(
    "sections",
    class extends Tag {
      group: string;
      constructor(token: TagToken, rest: TopLevelToken[], l: Liquid) {
        super(token, rest, l);
        const m = /^['"]([A-Za-z0-9_.-]+)['"]$/.exec(token.args.trim());
        if (!m) throw new Error(`illegal tag: ${token.getText()}`);
        this.group = m[1]!;
      }
      *render(_ctx: Context, emitter: Emitter) {
        const g = groupOf(this.group);
        emitter.write(g ? renderSectionGroup(g, `sections/${this.group}`) : "");
      }
    },
  );
  liquid.registerTag(
    "form",
    class extends Tag {
      templates: Template[] = [];
      formType: string;
      hash: Hash;
      constructor(token: TagToken, rest: TopLevelToken[], l: Liquid) {
        super(token, rest, l);
        const m = /^\s*['"]([a-z_]+)['"]\s*(?:,\s*([A-Za-z_][A-Za-z0-9_.]*)\s*)?(.*)$/s.exec(token.args);
        if (!m) throw new Error(`illegal tag: ${token.getText()}`);
        this.formType = m[1]!;
        this.hash = new Hash(m[3]!.replace(/^\s*,/, ""), l.options.keyValueSeparator);
        parseBody(this, "form", token, rest, l);
      }
      *render(ctx: Context, emitter: Emitter) {
        const e = env();
        const h = (yield this.hash.render(ctx)) as Record<string, unknown>;
        // 配送先のフォーム: 送り先は選んだ決済手段の確認（Banto が渡す checkout.provider）
        const provider = this.formType === "checkout_address" && isObject(e.globals["checkout"]) ? String((e.globals["checkout"] as Record<string, unknown>)["provider"] ?? "") : "";
        const action = /^(stripe|komoju)$/.test(provider) ? `${e.shopPath}/checkout/${provider}` : FORM_ACTIONS[this.formType] !== undefined ? `${e.shopPath}${FORM_ACTIONS[this.formType]}` : null;
        if (!action) e.errors.push(`form '${this.formType}' is not supported yet`);
        const extra = Object.entries(h)
          .filter(([k, v]) => /^[a-z][a-z0-9_-]*$/.test(k) && v !== undefined && k !== "return_to")
          .map(([k, v]) => attr(k.replace(/_/g, "-"), v))
          .join("");
        emitter.write(`<form method="post" action="${escapeHtml(action ?? "#")}" accept-charset="UTF-8"${extra}><input type="hidden" name="form_type" value="${escapeHtml(this.formType)}">`);
        ctx.push({ form: { errors: null, posted_successfully: false } });
        yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
        ctx.pop();
        emitter.write("</form>");
      }
    },
  );
  liquid.registerTag(
    "paginate",
    class extends Tag {
      templates: Template[] = [];
      constructor(token: TagToken, rest: TopLevelToken[], l: Liquid) {
        super(token, rest, l);
        if (!/\sby\s+/.test(` ${token.args} `)) throw new Error(`illegal tag: ${token.getText()}`);
        parseBody(this, "paginate", token, rest, l);
      }
      *render(ctx: Context, emitter: Emitter) {
        // Banto は描く前にページを分けて読んでいる（1 ページの数は Banto が決める）。ここではそのページ送りを渡すだけ
        ctx.push({ paginate: env().paginate ?? { current_page: 1, page_size: 0, items: null, pages: null, previous: null, next: null, parts: [] } });
        yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
        ctx.pop();
      }
    },
  );
}

/** sections/<名前>.json（セクションのまとまり） */
function groupOf(name: string): { sections?: Record<string, SectionData>; order?: string[] } | null {
  const e = env();
  const g = e.globals["__groups"];
  return isObject(g) && isObject(g[name]) ? (g[name] as { sections?: Record<string, SectionData>; order?: string[] }) : null;
}

/** テーマの中の {% schema %} の JSON（セクションごと）。読み込むときに一度だけ */
export function readSectionSchemas(files: Readonly<Record<string, string>>, dir: "sections" | "blocks" = "sections"): Map<string, SectionSchema> {
  const out = new Map<string, SectionSchema>();
  const re = new RegExp(`^${dir}\\/([A-Za-z0-9_.-]+)\\.liquid$`);
  for (const [path, src] of Object.entries(files)) {
    const m = re.exec(path);
    if (!m) continue;
    const body = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/.exec(src)?.[1];
    if (!body) continue;
    try {
      const v = JSON.parse(stripJsonComments(body)) as unknown;
      if (isObject(v)) out.set(m[1]!, v as SectionSchema);
    } catch {
      // 壊れた schema は既定値なし（取り込みの検査で止める）
    }
  }
  return out;
}

/** Shopify の名前のフィルターとタグを足す（createThemeEngine の extend に渡す） */
export function extendShopify(liquid: Liquid): void {
  registerShopifyFilters(liquid);
  registerShopifyTags(liquid);
}

/** セクションの値に上書きを重ねる（描くときに。テーマのファイルの値は変えない） */
export function withOverride(data: SectionData, ov: SectionOverrides[string][string] | undefined): SectionData {
  if (!ov) return data;
  const blocks = data.blocks ? { ...data.blocks } : undefined;
  if (blocks && isObject(ov.blocks)) {
    for (const [bid, vals] of Object.entries(ov.blocks)) {
      const b = blocks[bid];
      if (b && isObject(vals)) blocks[bid] = { ...b, settings: { ...(b.settings ?? {}), ...vals } };
    }
  }
  return { ...data, ...(isObject(ov.settings) ? { settings: { ...(data.settings ?? {}), ...ov.settings } } : {}), ...(blocks ? { blocks } : {}) };
}
