/**
 * ブログと記事（同梱モジュール blog、0081_mod_blog、メンテナの決定 2026-10-30、docs/blog.md）。
 * ブログは記事の入れ物（/blogs/<handle> が一覧）、記事はその中の 1 本（/blogs/<ブログ>/<handle>）。
 * 本文はページと同じ決まった書式（src/pages/markdown.ts）で、HTML にするのは描くとき。
 */
import { stripAudienceBlocks } from "../content/audience-blocks";
import type { PageNav } from "../pages";

export const BLOG_MODULE = "blog";
/** 一覧の 1 ページの記事の数 */
export const ARTICLES_PER_PAGE = 12;
/** 一覧で読む深さの上限（それより先は出さない。DB を重くしない） */
export const ARTICLES_OFFSET_MAX = 1200;
/** Atom のフィードに載せる数 */
export const FEED_ARTICLES = 20;

export interface BlogRow {
  id: string;
  shop_id: string;
  handle: string;
  title: string;
  description: string | null;
  seo_title: string | null;
  seo_description: string | null;
  template_suffix: string | null;
  nav: PageNav;
  sort_order: number;
  /** 記事の並び順（0116。無ければ 0116 の前の DB で、新しい順） */
  article_order?: ArticleOrder;
  /** Atom のフィードを出すか（0116。無ければ出す） */
  feed?: boolean;
  /** 記事の独自の項目の定義（0117。src/blog/fields.ts） */
  article_fields?: unknown;
  created_at: string;
  updated_at: string;
}

/** 記事の並び順（0116）: 公開した日時の新しい順・題の順・手で並べる（articles.position の小さい順） */
export const ARTICLE_ORDERS = ["new", "title", "manual"] as const;
export type ArticleOrder = (typeof ARTICLE_ORDERS)[number];
export const BLOG_ORDER_MIGRATION = "0116_blog_order";
export const isArticleOrder = (v: unknown): v is ArticleOrder => typeof v === "string" && (ARTICLE_ORDERS as readonly string[]).includes(v);

/**
 * 一覧で使う並び順。ブログの設定（override があればそれ）。0116 の前の DB（ブログの行に article_order が無い）では undefined = 今までどおり新しい順
 */
export function articleSortFor(blog: Pick<BlogRow, "article_order">, override?: ArticleOrder | null): ArticleOrder | undefined {
  if (!isArticleOrder(blog.article_order)) return undefined;
  return override ?? blog.article_order;
}

/** PostgREST の order（会員の一覧の articles_member_page と同じ並び。同じなら新しい順） */
export function articleOrderParam(sort: ArticleOrder | undefined): string {
  if (sort === "title") return "title.asc,published_at.desc,id.desc";
  if (sort === "manual") return "position.asc,published_at.desc,id.desc";
  return "published_at.desc,id.desc";
}

/** フィードを出すブログか（0116 の前は出す） */
export const blogHasFeed = (blog: Pick<BlogRow, "feed">) => blog.feed !== false;

export interface ArticleRow {
  /** 会員限定（0100）: 会員の条件と、存在も隠すか */
  audience_id?: string | null;
  audience_hide?: boolean;
  id: string;
  shop_id: string;
  blog_id: string;
  handle: string;
  title: string;
  body: string;
  excerpt: string | null;
  tags: string[];
  image_url: string | null;
  author: string | null;
  seo_title: string | null;
  seo_description: string | null;
  template_suffix: string | null;
  published: boolean;
  published_at: string | null;
  /** 手で並べるときの順（0116） */
  position?: number;
  /** 独自の項目の値（0117。src/blog/fields.ts） */
  fields?: Record<string, unknown>;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 一覧で読む列（抜粋が無い記事は本文の頭を紹介に使うので本文も読む。一覧はキャッシュする） */
export const ARTICLE_LIST_COLUMNS = "id,shop_id,blog_id,handle,title,body,excerpt,tags,image_url,author,published_at,updated_at";

/** shop_public_get の blogs_nav の 1 件 */
export interface BlogNavItem {
  handle: string;
  title: string;
  nav: "header" | "footer";
}

/** URL の名前の形（DB の CHECK が正）。記事は feed を使えない（/blogs/<ブログ>/feed.atom と紛らわしい） */
export const blogHandleOk = (h: string) => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(h);
export const articleHandleOk = (h: string) => blogHandleOk(h) && h !== "feed";

export const blogPath = (shopPath: string, blog: string) => `${shopPath}/blogs/${encodeURIComponent(blog)}`;
export const articlePath = (shopPath: string, blog: string, article: string) => `${blogPath(shopPath, blog)}/${encodeURIComponent(article)}`;

/** メニューに出すブログ（モジュールが OFF なら DB 側で空。キャッシュ済みのショップ行から読むので往復しない） */
export function blogsNav(shop: { blogs_nav?: unknown }, place: "header" | "footer"): BlogNavItem[] {
  const list = Array.isArray(shop.blogs_nav) ? (shop.blogs_nav as BlogNavItem[]) : [];
  return list.filter((b) => b && b.nav === place && typeof b.handle === "string" && typeof b.title === "string");
}

/** 「新作, セール、春」→ ["新作","セール","春"]（読点・カンマで分け、空白を外し、重ねない。20 個・1 つ 50 文字まで） */
export function parseTags(s: string): string[] {
  const out: string[] = [];
  for (const raw of s.split(/[,、，]/)) {
    const t = raw.trim().slice(0, 50);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * 一覧に出す短い紹介: 抜粋があればそれ、無ければ本文の頭の文字（書式の記号・画像・ブロックの行を外す）。HTML ではなく文字
 */
export function articleSummary(a: { excerpt?: string | null; body?: string | null }, max = 120): string {
  if (a.excerpt) return a.excerpt;
  // 見せる相手の囲み（0097）の中身は抜粋に使わない（一覧・RSS はだれが見るか決めない）
  const text = stripAudienceBlocks(a.body ?? "")
    .split("\n")
    .filter((l) => !/^\s{0,3}(:::|\||---)/.test(l))
    .join(" ")
    // 文字と URL は長さで縛り、次の [ と ( で止める（閉じの無い [ の羅列で二乗にならない。長い・入れ子のものは文字のまま残る）
    .replace(/!\[[^[\]\n]{0,300}\]\([^()\n]{0,2000}\)/g, "")
    .replace(/\[([^[\]\n]{0,300})\]\([^()\n]{0,2000}\)/g, "$1")
    .replace(/(^|\s)(#{1,6}|>|[-*+]|\d+\.)\s+/g, "$1")
    .replace(/[*_`\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const xmlEsc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);

/** Atom のフィード（新しい記事 FEED_ARTICLES 本。本文は載せず、紹介と URL だけ） */
export function atomFeed(opts: { blogTitle: string; blogUrl: string; feedUrl: string; shopName: string; articles: { title: string; url: string; summary: string; published: string; updated: string; author: string | null }[] }): string {
  const updated = opts.articles.reduce((m, a) => (a.updated > m ? a.updated : m), opts.articles[0]?.updated ?? new Date(0).toISOString());
  const entries = opts.articles.map(
    (a) =>
      `  <entry>\n    <title>${xmlEsc(a.title)}</title>\n    <link href="${xmlEsc(a.url)}"/>\n    <id>${xmlEsc(a.url)}</id>\n    <published>${xmlEsc(a.published)}</published>\n    <updated>${xmlEsc(a.updated)}</updated>\n` +
      `    <author><name>${xmlEsc(a.author || opts.shopName)}</name></author>\n    <summary>${xmlEsc(a.summary)}</summary>\n  </entry>`,
  );
  return `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n  <title>${xmlEsc(`${opts.blogTitle} | ${opts.shopName}`)}</title>\n  <link href="${xmlEsc(opts.blogUrl)}"/>\n  <link rel="self" href="${xmlEsc(opts.feedUrl)}"/>\n  <id>${xmlEsc(opts.blogUrl)}</id>\n  <updated>${xmlEsc(updated)}</updated>\n${entries.join("\n")}\n</feed>\n`;
}
