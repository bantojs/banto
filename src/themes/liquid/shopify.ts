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
  settings?: { id?: string; default?: unknown }[];
  blocks?: { type?: string; settings?: { id?: string; default?: unknown }[] }[];
  max_blocks?: number;
}

/** JSON のテンプレート・セクションのまとまりの 1 つ */
export interface SectionData {
  type: string;
  settings?: Record<string, unknown>;
  blocks?: Record<string, { type: string; settings?: Record<string, unknown>; disabled?: boolean }>;
  block_order?: string[];
  disabled?: boolean;
}

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
}

function mediaUrl(key: string): string {
  return `${env().mediaBaseUrl.replace(/\/+$/, "")}/${key}`;
}

/** 画像の URL。Banto は縮小した版を 2 つ（本画像と長辺 400px）しか持たないので、幅 400 以下ならサムネイル */
function imageUrlOf(input: unknown, width?: number, height?: number): ImageUrl | string {
  let img: ImageLike | null = null;
  if (isObject(input)) img = (isObject(input["preview_image"]) ? input["preview_image"] : isObject(input["featured_image"]) ? input["featured_image"] : input) as ImageLike;
  if (!img) return typeof input === "string" ? input : "";
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
    const m = /^(\d+)?x?(\d+)?$/.exec(String(size ?? ""));
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
  liquid.registerFilter("asset_url", (name: unknown) => {
    const e = env();
    return `${e.shopOrigin}/_theme/${e.versionId}/assets/${encodeURIComponent(String(name ?? ""))}`;
  });
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
    const shown = p[0] ? liquid.filters["date"] && String(liquid.parseAndRenderSync(`{{ d | date: f }}`, { d: d.toISOString(), f: String(p[0]) })) : d.toISOString().slice(0, 10);
    return new SafeHtml(`<time datetime="${escapeHtml(d.toISOString())}">${escapeHtml(shown)}</time>`);
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
export function renderSection(id: string, data: SectionData): string {
  const e = env();
  if (data.disabled) return "";
  const schema = e.schemas.get(data.type) ?? {};
  const defaults = Object.fromEntries((schema.settings ?? []).filter((s) => s.id && s.default !== undefined).map((s) => [s.id!, s.default]));
  const order = data.block_order ?? Object.keys(data.blocks ?? {});
  const blocks = order
    .map((bid) => {
      const b = data.blocks?.[bid];
      if (!b || b.disabled) return null;
      const bs = (schema.blocks ?? []).find((x) => x.type === b.type);
      const bdef = Object.fromEntries((bs?.settings ?? []).filter((s) => s.id && s.default !== undefined).map((s) => [s.id!, s.default]));
      return { id: bid, type: b.type, settings: { ...bdef, ...(b.settings ?? {}) }, shopify_attributes: "" };
    })
    .filter(Boolean);
  const section = { id, type: data.type, settings: { ...defaults, ...(data.settings ?? {}) }, blocks, index: 0 };
  try {
    const html = e.engine.render(`sections/${data.type}`, { ...e.globals, section });
    return `<div id="section-${escapeHtml(id)}" class="theme-section">${html}</div>`;
  } catch (err) {
    // 上限を超えたらページ全体を止める（セクションを空にして続けると、1 ページで何度も上限まで回せてしまう）
    if (err instanceof ThemeError && err.kind === "limit") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    e.errors.push(`sections/${data.type}: ${msg}`);
    return e.preview ? `<div class="theme-error" style="border:2px solid #c00;padding:8px;color:#c00">${escapeHtml(`sections/${data.type}: ${msg}`)}</div>` : "";
  }
}

/** JSON のセクションのまとまり（templates/*.json・sections/*.json）を順に描く */
export function renderSectionGroup(group: { sections?: Record<string, SectionData>; order?: string[] }): string {
  const sections = group.sections ?? {};
  return (group.order ?? Object.keys(sections))
    .map((id) => (sections[id] ? renderSection(id, sections[id]!) : ""))
    .join("");
}

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
        emitter.write(renderSection(this.type, { type: this.type }));
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
        emitter.write(g ? renderSectionGroup(g) : "");
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
        const action = this.formType === "product" ? `${e.shopPath}/cart/add` : null;
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
export function readSectionSchemas(files: Readonly<Record<string, string>>): Map<string, SectionSchema> {
  const out = new Map<string, SectionSchema>();
  for (const [path, src] of Object.entries(files)) {
    const m = /^sections\/([A-Za-z0-9_.-]+)\.liquid$/.exec(path);
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
