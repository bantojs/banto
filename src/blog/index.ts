/**
 * ブログと記事（同梱モジュール blog、0081_mod_blog、メンテナの決定 2026-10-30、docs/blog.md）。
 * ブログは記事の入れ物（/blogs/<handle> が一覧）、記事はその中の 1 本（/blogs/<ブログ>/<handle>）。
 * 本文はページと同じ決まった書式（src/pages/markdown.ts）で、HTML にするのは描くとき。
 */
import type { PageNav } from "../pages";

export const BLOG_MODULE = "blog";
export const BLOG_MIGRATION = "0081_mod_blog";
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
  created_at: string;
  updated_at: string;
}

export interface ArticleRow {
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
  const text = (a.body ?? "")
    .split("\n")
    .filter((l) => !/^\s{0,3}(:::|\||---)/.test(l))
    .join(" ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
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
