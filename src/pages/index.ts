/**
 * ショップのページ（同梱モジュール pages、0079_mod_pages、メンテナの決定 2026-10-30、docs/pages.md）。
 * URL は /pages/<handle>。本文は決まった書式の文字で、HTML にするのは描くとき（src/pages/markdown.ts）。
 */
import { markdownToHtml } from "./markdown";

export const PAGES_MODULE = "pages";
export const PAGES_MIGRATION = "0079_mod_pages";
/** 予約公開・ゴミ箱・リビジョン・アイキャッチ・メディアライブラリ（0080） */
export const PAGES_PUBLISHING_MIGRATION = "0080_mod_pages_publishing";
/** ページ・ブログの記事を AI 用トークンで扱う（content:read / content:write） */
export const CONTENT_API_MIGRATION = "0083_api_content";
/** ゴミ箱に置いておく日数（過ぎたら Cron が消す） */
export const PAGES_TRASH_DAYS = 30;

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
  /** 公開する日時（null はすぐ）。0080 から */
  published_at?: string | null;
  /** ゴミ箱に入れた日時。0080 から */
  deleted_at?: string | null;
  /** アイキャッチ画像（ショップの画像の置き場の URL）。0080 から */
  image_url?: string | null;
}

/**
 * お客様の画面で読む列（下書き・予約・ゴミ箱は RLS で見えない）。0080 の列（image_url・published_at）は当たっていれば入る形にする:
 * anon はページの全部の列を読める（秘密の列は無い）ので * にし、版のずれでも表・列の無いエラーにならない
 */
export const PUBLIC_PAGE_COLUMNS = "*";

/** ページを公開した日時（予約していればその日時、無ければ作った日時） */
export const pagePublishedAt = (p: Pick<PageRow, "published_at" | "created_at">) => p.published_at ?? p.created_at;

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
/** タイトルから URL の名前を作る（英数字の部分だけ。作れない・予約の名前なら空。編集の画面のスクリプトも同じ規則） */
export function handleFromTitle(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return pageHandleOk(s) ? s : "";
}

/** 名前を空で保存したとき・タイトルから作れないときの名前（page-xxxxxx） */
export function randomPageHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `page-${Array.from(bytes, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("")}`;
}

export const PAGE_LIMITS ={ title: 200, body: 50000, seoTitle: 200, seoDescription: 500 } as const;

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
