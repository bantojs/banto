/**
 * ショップのページ（同梱モジュール pages、0079_mod_pages、メンテナの決定 2026-10-30、docs/pages.md）。
 * URL は /pages/<handle>。本文は決まった書式の文字で、HTML にするのは描くとき（src/pages/markdown.ts）。
 */
import { markdownToHtml } from "./markdown";

export const PAGES_MODULE = "pages";
export const PAGES_MIGRATION = "0079_mod_pages";

export type PageNav = "none" | "header" | "footer";
export const PAGE_NAVS: readonly PageNav[] = ["none", "header", "footer"];

export interface PageRow {
  id: string;
  shop_id: string;
  handle: string;
  title: string;
  body: string;
  seo_title: string | null;
  seo_description: string | null;
  template_suffix: string | null;
  nav: PageNav;
  sort_order: number;
  published: boolean;
  created_at: string;
  updated_at: string;
}

/** お客様の画面で読む列（下書きは RLS で見えない） */
export const PUBLIC_PAGE_COLUMNS = "id,shop_id,handle,title,body,seo_title,seo_description,template_suffix,nav,sort_order,published,created_at,updated_at";

/** shop_public_get の pages_nav の 1 件（メニューに出す公開中のページ） */
export interface PageNavItem {
  handle: string;
  title: string;
  nav: "header" | "footer";
}

/** 0079 の banto_page_handle_ok と同じ（DB の CHECK が正。画面で先に止めるため） */
export const RESERVED_HANDLES = ["legal", "privacy", "returns", "shipping", "cart", "checkout", "account", "search", "orders", "inquiries"] as const;
export function pageHandleOk(handle: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(handle) && !(RESERVED_HANDLES as readonly string[]).includes(handle);
}
export const PAGE_LIMITS = { title: 200, body: 50000, seoTitle: 200, seoDescription: 500 } as const;

export const pagePath = (shopPath: string, handle: string) => `${shopPath}/pages/${encodeURIComponent(handle)}`;

/** メニューに出すページ（モジュールが OFF なら DB 側で空。キャッシュ済みのショップ行から読むので往復しない） */
export function pagesNav(shop: { pages_nav?: unknown }, place: "header" | "footer"): PageNavItem[] {
  const list = Array.isArray(shop.pages_nav) ? (shop.pages_nav as PageNavItem[]) : [];
  return list.filter((p) => p && p.nav === place && typeof p.handle === "string" && typeof p.title === "string");
}

/**
 * 本文の HTML（描くたびに変換しないよう、isolate の中にページの版ごとに覚える）。
 * 鍵は id と updated_at なので、直したページは新しい鍵になる。覚える数は上限まで（古いものから捨てる）
 */
const htmlCache = new Map<string, string>();
const HTML_CACHE_MAX = 200;
export function pageBodyHtml(page: Pick<PageRow, "id" | "updated_at" | "body">, mediaBase: string): string {
  const key = `${page.id}|${page.updated_at}|${mediaBase}`;
  const hit = htmlCache.get(key);
  if (hit !== undefined) return hit;
  const html = markdownToHtml(page.body, { mediaBase });
  htmlCache.set(key, html);
  if (htmlCache.size > HTML_CACHE_MAX) htmlCache.delete(htmlCache.keys().next().value!);
  return html;
}
