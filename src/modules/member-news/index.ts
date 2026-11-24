/**
 * 会員へのお知らせと既読（同梱モジュール member_news、0155、メンテナの決定 2026-11-18、docs/member-news.md）。
 * Banto は置かれたお知らせを出して既読を覚えるだけ。だれに・いつ置くかは決めない（自動で作るお知らせは持たない）。
 * 書き手は管理画面（全員向け）と AI 用 API（member_news:write）。読むのは本人（会員ページ・Liquid の customer.news・ヘッドレス）
 */
import { moduleEnabled, MEMBER_NEWS_MIGRATION } from "../registry";

export const MEMBER_NEWS_MODULE = "member_news";
export { MEMBER_NEWS_MIGRATION };

/** 本人に見えるお知らせ（新しい順、50 件まで） */
export interface MemberNewsItem {
  id: string;
  title: string;
  body: string;
  url: string | null;
  starts_at: string;
  read: boolean;
}
export interface MemberNewsList {
  items: MemberNewsItem[];
  unread: number;
}

export function memberNewsEnabled(shop: { settings?: Record<string, unknown> | null }): boolean {
  return moduleEnabled(shop.settings, MEMBER_NEWS_MODULE);
}

/** リンクの行き先: https はそのまま、/ で始まるパスはお店の中（shopPath の下） */
export function memberNewsHref(shopPath: string, url: string | null): string | null {
  // \ と制御文字はどちらも受けない（ブラウザは /\host を //host と読む。DB の banto_member_news_norm も断る）
  if (!url || /[\\\u0000-\u001f\u007f]/.test(url)) return null;
  if (url.startsWith("https://")) return url;
  if (url.startsWith("/") && !url.startsWith("//")) return `${shopPath}${url === "/" ? "" : url}` || "/";
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 既読にする本文（ヘッドレス）: { ids?: string[] }。ids が無ければ見えるものすべて。50 件まで、id の形が違えば null */
export function parseNewsReadBody(b: Record<string, unknown>): { ids: string[] | null } | null {
  const ids = b["ids"];
  if (ids === undefined || ids === null) return { ids: null };
  if (!Array.isArray(ids) || ids.length > 50 || !ids.every((x): x is string => typeof x === "string" && UUID.test(x))) return null;
  return { ids };
}
