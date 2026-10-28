/**
 * Liquid のテーマの描画の仕組み（人間の決定 2026-10-28、docs/themes.md）。
 *
 * - liquidjs のブラウザ向けの版を使う（Workers と Node で同じ。eval / new Function を使わない）
 * - **描画は同期だけ**。非同期の描画は同じテンプレートで 7 倍ほど遅い（generator と Promise の重さ）。テーマのファイルは先にメモリへ読み、
 *   データも描く前にそろえる（テーマは途中で DB を引けない。CLAUDE.md §11「テーマはデータ取得をしない」と同じ）
 * - **既定でエスケープ**。`escape` / `escape_once` はエスケープして、もうエスケープしない（Shopify の書き癖 `{{ x | escape }}` を二重にしない）。
 *   生で出すのは `{{ x | raw }}`。本体が作った HTML（`content_for_layout`・セクション・フォームなど）は SafeHtml で渡し、エスケープせずに出す
 * - 渡したデータの自前のプロパティだけを読む（`constructor`・`__proto__` に触れない）。知らないフィルターは解析で止める
 * - **描画の手数（テンプレートの部品を描いた回数）を数えて上限で止める**。liquidjs の renderLimit は時計で測るが、本番の Workers は
 *   計算のあいだ時計が進まないので効かない。量（文字列・配列・範囲）は memoryLimit、出力の大きさはここで数える
 */
/// <reference path="./liquidjs.d.ts" />
import { Liquid, type Template } from "liquidjs/dist/liquid.browser.mjs";

/** テーマのファイルの形（束ねたファイルの中身）。鍵は "layout/theme.liquid" のような置き場の相対パス */
export type ThemeFiles = Readonly<Record<string, string>>;

export const THEME_LIMITS = {
  /** 1 ページで部品を描く回数（for の 1 回・if の中身・出力の 1 つがそれぞれ 1 手）。商品 48 件の一覧で数千手 */
  steps: 200_000,
  /** 1 ページの出力（文字） */
  outputChars: 2_000_000,
  /** 1 ページで作る文字列・配列の量（liquidjs の memoryLimit） */
  memory: 20_000_000,
  /** 1 つのテンプレートの大きさ（文字。liquidjs の parseLimit） */
  parseChars: 512 * 1024,
} as const;

/** テーマの誤り（解析・描画）。message は運営者に見せてよい（テーマのファイル名と位置だけで、データは含めない） */
export class ThemeError extends Error {
  constructor(
    message: string,
    readonly kind: "parse" | "render" | "limit" | "missing",
  ) {
    super(message);
    this.name = "ThemeError";
  }
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, (ch) => ESC[ch]!);
/** 本体が作った HTML（エスケープせずに出す）。テーマが作った文字列は SafeHtml にならない */
export class SafeHtml {
  constructor(readonly html: string) {}
  toString(): string {
    return this.html;
  }
}

const UNESC: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#34;": '"' };
const unescapeHtml = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39|#34);/g, (m) => UNESC[m]!);

/** ファイルの置き場 → liquidjs のテンプレートの名前。snippets は `render 'name'` で引けるように名前だけにする */
function templateName(path: string): string | null {
  const m = /^(layout|templates|sections|snippets)\/([A-Za-z0-9_.-]+)\.liquid$/.exec(path);
  if (!m) return null;
  return m[1] === "snippets" ? m[2]! : `${m[1]}/${m[2]}`;
}

/** 描画の手数を数える（1 回の描画ごとに reset する。描画は同期なので、同じ isolate のほかのリクエストと混ざらない） */
class StepCounter {
  steps = 0;
  reset() {
    this.steps = 0;
  }
}

export interface ThemeEngine {
  readonly liquid: Liquid;
  /** そのテンプレートがあるか（"templates/product" や "sections/header"、snippets は名前だけ） */
  has(name: string): boolean;
  /** 1 つのテンプレートを描く（同期）。上限を超えたら ThemeError(kind: "limit") */
  render(name: string, scope: Record<string, unknown>): string;
  /** テンプレートの文字列を描く（テーマの中の小さな式・検査用） */
  renderString(source: string, scope: Record<string, unknown>): string;
}

export interface EngineOptions {
  /** フィルター・タグを足す（Shopify の名前。src/themes/liquid/shopify.ts） */
  extend?: (liquid: Liquid) => void;
  limits?: Partial<Record<keyof typeof THEME_LIMITS, number>>;
}

export function createThemeEngine(files: ThemeFiles, opts: EngineOptions = {}): ThemeEngine {
  const limits: Record<keyof typeof THEME_LIMITS, number> = { ...THEME_LIMITS, ...opts.limits };
  const templates: Record<string, string> = {};
  for (const [path, src] of Object.entries(files)) {
    const name = templateName(path);
    if (name) templates[name] = src;
  }
  const liquid = new Liquid({
    templates,
    cache: true,
    ownPropertyOnly: true,
    strictFilters: true,
    strictVariables: false,
    outputEscape: (v: unknown) => (v instanceof SafeHtml ? v.html : escapeHtml(v)),
    parseLimit: limits.parseChars,
    memoryLimit: limits.memory,
    // 時計の上限は本番の Workers では効かない（上の説明）。手数で止めるので、liquidjs の側は大きくしておく
    renderLimit: 60_000,
    // Shopify と同じ: 未定義の値は空、空文字・0 は真
    jsTruthy: false,
  });

  // escape / escape_once: エスケープした結果を、もうエスケープしない
  liquid.registerFilter("escape", { handler: (v: unknown) => escapeHtml(v), raw: true });
  liquid.registerFilter("escape_once", { handler: (v: unknown) => escapeHtml(unescapeHtml(String(v ?? ""))), raw: true });
  // Shopify と同じ: 整数どうしの割り算は切り捨て
  liquid.registerFilter("divided_by", (a: unknown, b: unknown) => {
    const x = Number(a);
    const y = Number(b);
    return Number.isInteger(x) && Number.isInteger(y) ? Math.floor(x / y) : x / y;
  });
  opts.extend?.(liquid);

  // 手数を数える: liquidjs はテンプレートの部品の並びを renderTemplates で 1 つずつ描くので、その入口で部品の数を足す
  const counter = new StepCounter();
  const renderer = liquid.renderer;
  const original = renderer.renderTemplates.bind(renderer);
  renderer.renderTemplates = function* (tpls, ctx, emitter) {
    counter.steps += tpls.length;
    if (counter.steps > limits.steps) throw new ThemeError(`theme render step limit exceeded (${limits.steps})`, "limit");
    return yield* original(tpls, ctx, emitter);
  };

  const parsed = new Map<string, Template[]>();
  const parse = (name: string): Template[] => {
    let t = parsed.get(name);
    if (!t) {
      const src = templates[name];
      if (src === undefined) throw new ThemeError(`template not found: ${name}`, "missing");
      try {
        t = liquid.parse(src, name);
      } catch (e) {
        throw new ThemeError(messageOf(e), "parse");
      }
      parsed.set(name, t);
    }
    return t;
  };

  const run = (tpls: Template[], scope: Record<string, unknown>): string => {
    counter.reset();
    let out: unknown;
    try {
      out = liquid.renderSync(tpls, scope);
    } catch (e) {
      if (e instanceof ThemeError) throw e;
      const inner = innerThemeError(e);
      if (inner) throw inner;
      throw new ThemeError(messageOf(e), /limit exceeded/.test(messageOf(e)) ? "limit" : "render");
    }
    const html = String(out ?? "");
    if (html.length > limits.outputChars) throw new ThemeError(`theme output limit exceeded (${limits.outputChars})`, "limit");
    return html;
  };

  return {
    liquid,
    has: (name) => name in templates,
    render: (name, scope) => run(parse(name), scope),
    renderString: (source, scope) => {
      let tpls: Template[];
      try {
        tpls = liquid.parse(source);
      } catch (e) {
        throw new ThemeError(messageOf(e), "parse");
      }
      return run(tpls, scope);
    },
  };
}

/** liquidjs の誤りの文から、最初の 1 行（テンプレートの名前と位置）だけを残す */
function messageOf(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split("\n")[0]!.slice(0, 300);
}

/** liquidjs が包んだ誤り（RenderError の originalError）の中の ThemeError を取り出す */
function innerThemeError(e: unknown): ThemeError | null {
  for (let cur: unknown = e, i = 0; cur && i < 5; i++) {
    if (cur instanceof ThemeError) return cur;
    cur = (cur as { originalError?: unknown }).originalError;
  }
  return null;
}
