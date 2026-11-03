/**
 * 固定ページを「ひな形」として割り当てる（段 C1、0101、メンテナの決定 2026-11-03、docs/pages.md「ひな形の割り当て」）。
 *
 * - shops.settings.page_layouts = { home?: <ページ id>, articles?: { <ブログ id>: <ページ id> } }（書くのは DB の page_layouts_set だけ）
 * - トップ: 一覧の絞り込みが無いとき、そのページの本文でトップを描く（?all=1 は今までの商品の一覧）
 * - 記事: ひな形の本文の `::: current part=content` に記事の本文を差し込み、ひとつの本文として描く
 *   （見せる相手の囲み・ブロックの数の上限・日時のブロックが、ひな形と記事の両方にそのまま効く）。
 *   ほかの部品（タイトル・アイキャッチ・書いた人・抜粋・タグ・前後の記事）は印を置いて、描いた後に入れる
 * - ひな形のページは匿名の読み取りで引く（会員限定・非公開・ゴミ箱なら見えず、今までの画面に戻す）
 */
import type { ArticleRow, BlogRow } from "../blog";
import { blogPath, articlePath } from "../blog";
import { CURRENT_PARTS, currentMarker } from "../pages/shop-blocks";
import { shopImageUrl } from "../pages/markdown";
import { t } from "../i18n";

export interface PageLayouts {
  home: string | null;
  articles: Record<string, string>;
  /** 商品詳細（0102）: ショップ全体と、カテゴリーごとの上書き（商品の主カテゴリーから親へたどって近いもの） */
  product: string | null;
  productCategories: Record<string, string>;
  /** 商品一覧（0103）: すべての一覧とカテゴリーの一覧に共通のものと、カテゴリーごとの上書き */
  collection: string | null;
  collectionCategories: Record<string, string>;
  /** 法務の 3 つのページ（0104）: 共通のものと、ページごと（legal・privacy・returns）の上書き */
  legal: string | null;
  legalPages: Record<string, string>;
}

const UUID = /^[0-9a-f-]{36}$/;
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** 公開の settings の page_layouts を読む（形の違うものは無いことにする） */
export function pageLayoutsOf(settings: Record<string, unknown> | null | undefined): PageLayouts {
  const raw = isObject(settings) ? settings["page_layouts"] : null;
  const out: PageLayouts = { home: null, articles: {}, product: null, productCategories: {}, collection: null, collectionCategories: {}, legal: null, legalPages: {} };
  if (!isObject(raw)) return out;
  if (typeof raw["home"] === "string" && UUID.test(raw["home"])) out.home = raw["home"];
  if (typeof raw["product"] === "string" && UUID.test(raw["product"])) out.product = raw["product"];
  if (typeof raw["collection"] === "string" && UUID.test(raw["collection"])) out.collection = raw["collection"];
  if (typeof raw["legal"] === "string" && UUID.test(raw["legal"])) out.legal = raw["legal"];
  if (isObject(raw["legal_pages"])) for (const [k, v] of Object.entries(raw["legal_pages"])) if (LEGAL_KINDS.includes(k) && typeof v === "string" && UUID.test(v)) out.legalPages[k] = v;
  const map = (v: unknown, into: Record<string, string>) => {
    if (isObject(v)) for (const [k, x] of Object.entries(v)) if (UUID.test(k) && typeof x === "string" && UUID.test(x)) into[k] = x;
  };
  map(raw["articles"], out.articles);
  map(raw["product_categories"], out.productCategories);
  map(raw["collection_categories"], out.collectionCategories);
  return out;
}

/** 商品詳細のひな形: 主カテゴリーから親へたどって最初に割り当てのあるもの、無ければショップ全体のもの（無ければ null） */
export function productLayoutId(l: PageLayouts, categories: readonly { id: string; parent_id: string | null }[], categoryId: string | null | undefined): string | null {
  return nearest(l.productCategories, categories, categoryId) ?? l.product;
}

/** 法務のページ（0104）。ページごとの上書き、無ければ共通のもの */
export const LEGAL_KINDS: readonly string[] = ["legal", "privacy", "returns"];
export function legalLayoutId(l: PageLayouts, kind: string): string | null {
  return l.legalPages[kind] ?? l.legal;
}

/** 法務のページの部品: 見出しと文面（ショップの設定の必須項目。文字のまま、改行を活かす） */
export function legalParts(title: string, body: string): Record<string, string> {
  return { title: `<h1>${esc(title)}</h1>`, legal: `<pre class="legal banto-legal">${esc(body)}</pre>` };
}

/** 商品一覧のひな形（0103）: そのカテゴリーから親へたどって最初に割り当てのあるもの、無ければ共通のもの（すべての一覧は共通のもの） */
export function collectionLayoutId(l: PageLayouts, categories: readonly { id: string; parent_id: string | null }[], categoryId: string | null | undefined): string | null {
  return nearest(l.collectionCategories, categories, categoryId) ?? l.collection;
}

function nearest(map: Record<string, string>, categories: readonly { id: string; parent_id: string | null }[], categoryId: string | null | undefined): string | null {
  const byId = new Map(categories.map((c) => [c.id, c]));
  let cur = categoryId ? byId.get(categoryId) : undefined;
  for (let depth = 0; cur && depth < 20; depth++) {
    const hit = map[cur.id];
    if (hit) return hit;
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return null;
}

/** 一覧の絞り込み・ページ送りが無いトップか（そのときだけトップのひな形を使う。?all=1 は今までの一覧） */
export function isPlainTop(query: Record<string, string>): boolean {
  return !query["tag"] && !query["category"] && !query["after"] && query["all"] !== "1";
}

/** 囲みの名前（src/pages/layout.ts の LAYOUT_CONTAINERS と同じ。1 行のブロックではないもの） */
const CONTAINER = /^\s{0,3}(:{3,})\s*(group|columns|column|cover|media|gallery|accordion|audience|grid|tabs|tab)\b/;
const CLOSE = /^\s{0,3}(:{3,})\s*$/;
const CONTENT_LINE = /^\s{0,3}:{3}\s*current\s+part=content\s*$/;

/**
 * ひな形の本文に記事の本文を差し込む。差し込めるのは、いちばん外側（囲みの外）の最初の `::: current part=content` の行だけ
 * （囲みの中に記事の囲みを入れると、閉じの数が合わなくなるため）。差し込めなければ inserted: false（その行は印のまま、描いた後に入れる）
 */
export function composeLayout(layoutBody: string, articleBody: string): { body: string; inserted: boolean } {
  const lines = layoutBody.replace(/\r\n?/g, "\n").split("\n");
  const stack: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const open = CONTAINER.exec(l);
    if (open) {
      stack.push(open[1]!.length);
      continue;
    }
    const close = CLOSE.exec(l);
    if (close && stack.length > 0 && stack[stack.length - 1] === close[1]!.length) {
      stack.pop();
      continue;
    }
    if (stack.length === 0 && CONTENT_LINE.test(l)) {
      const body = [...lines.slice(0, i), "", articleBody.replace(/\r\n?/g, "\n"), "", ...lines.slice(i + 1)].join("\n");
      return { body, inserted: true };
    }
  }
  return { body: layoutBody, inserted: false };
}

/** ひな形の中で使われている部品（前後の記事のように引くものがあるときだけ DB に問い合わせるため） */
export function usesPart(body: string, part: string): boolean {
  return new RegExp(`^\\s{0,3}:{3}\\s*current\\s+part=${part.replace(/[-]/g, "\\-")}\\s*$`, "m").test(body);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 記事の部品の HTML（決まった形。文字はエスケープ、画像は置き場のものだけ） */
export function articleParts(o: {
  shopPath: string;
  mediaBase: string;
  blog: BlogRow;
  article: ArticleRow;
  neighbors?: { prev: Pick<ArticleRow, "handle" | "title"> | null; next: Pick<ArticleRow, "handle" | "title"> | null } | null;
  /** 差し込めなかった本文（囲みの中に置いたとき）。描いた HTML をそのまま入れる */
  content?: string;
}): Record<string, string> {
  const a = o.article;
  const img = a.image_url ? shopImageUrl(a.image_url, o.mediaBase) : null;
  const n = o.neighbors;
  const link = (x: Pick<ArticleRow, "handle" | "title">, rel: "prev" | "next") =>
    `<a class="banto-current-nav__${rel}" rel="${rel}" href="${esc(articlePath(o.shopPath, o.blog.handle, x.handle))}"><span>${esc(t(rel === "prev" ? "layout.prev" : "layout.next"))}</span>${esc(x.title)}</a>`;
  return {
    title: `<h1 class="banto-current-title">${esc(a.title)}</h1>`,
    image: img ? `<img class="banto-current-image" src="${esc(img)}" alt="" decoding="async">` : "",
    author: a.author ? `<p class="banto-current-author">${esc(a.author)}</p>` : "",
    excerpt: a.excerpt ? `<p class="banto-current-excerpt">${esc(a.excerpt)}</p>` : "",
    tags: a.tags.length > 0 ? `<p class="blog-tags banto-current-tags">${a.tags.map((x) => `<a href="${esc(`${blogPath(o.shopPath, o.blog.handle)}?tag=${encodeURIComponent(x)}`)}">#${esc(x)}</a>`).join("")}</p>` : "",
    content: o.content ?? "",
    "prev-next": n && (n.prev || n.next) ? `<nav class="banto-current-nav" aria-label="${esc(t("layout.nav_label"))}">${n.prev ? link(n.prev, "prev") : "<span></span>"}${n.next ? link(n.next, "next") : "<span></span>"}</nav>` : "",
  };
}

/** ふつうのページ（お店のトップのひな形を含む）の部品: そのページ自身のタイトル・アイキャッチ・抜粋（SEO の説明）。ほかは空 */
export function pageParts(o: { mediaBase: string; page: { title: string; image_url?: string | null; seo_description?: string | null } }): Record<string, string> {
  const img = o.page.image_url ? shopImageUrl(o.page.image_url, o.mediaBase) : null;
  return {
    title: `<h1 class="banto-current-title">${esc(o.page.title)}</h1>`,
    image: img ? `<img class="banto-current-image" src="${esc(img)}" alt="" decoding="async">` : "",
    excerpt: o.page.seo_description ? `<p class="banto-current-excerpt">${esc(o.page.seo_description)}</p>` : "",
  };
}

/** 部品の印を入れる（無い部品・トップのひな形・ふつうのページでは空） */
export function fillCurrent(html: string, parts: Record<string, string> = {}): string {
  if (!html.includes("<!--banto:current:")) return html;
  return CURRENT_PARTS.reduce((h, p) => h.split(currentMarker(p)).join(parts[p] ?? ""), html);
}

/** 商品の部品の最小の CSS（Liquid のテーマで商品詳細のひな形を描くとき。既定のテーマは自分の CSS を持つ） */
export const PRODUCT_PARTS_CSS =
  ".gallery img[data-main]{width:100%;height:auto;border-radius:var(--banto-radius,.5rem)}.gallery .thumbs{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.5rem}.gallery .thumbs img{width:4rem;height:4rem;object-fit:cover;border-radius:.35rem}.product-price{font-size:1.25em;font-weight:600}";

/** 部品の最小の CSS（ひな形を使うページにだけ添える） */
export const CURRENT_CSS =
  ".banto-current-image{width:100%;height:auto;border-radius:var(--banto-radius,.5rem);margin:0 0 1.5rem}.banto-current-author{opacity:.75}.banto-current-excerpt{font-size:1.1em;opacity:.85}" +
  ".banto-current-nav{display:flex;justify-content:space-between;gap:1rem;margin:2rem 0;padding-top:1rem;border-top:1px solid color-mix(in srgb,currentColor 15%,transparent)}.banto-current-nav a{display:flex;flex-direction:column;text-decoration:none;max-width:48%}.banto-current-nav__next{text-align:right;margin-left:auto}.banto-current-nav span{font-size:.8em;opacity:.7}";
