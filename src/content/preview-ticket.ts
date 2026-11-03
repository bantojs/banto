/**
 * ページ・記事のプレビューの券（保存しない下書きを、お店の画面のオリジンで本物と同じ処理で描くため。docs/pages.md「プレビュー」）。
 *
 * 管理画面（content の項目の人）が下書きの JSON と券を作り、新しいタブからお店の画面の POST /_preview/content へ送る。
 * 券はショップ・下書きの SHA-256・期限（10 分）を結ぶので、券で描けるのはその下書きだけ。状態は何も変えない（描くだけ）。
 * 鍵はプレビュー専用（サイトの秘密で署名するほかの値と取り違えさせない）。
 */
import { openJson, sealJson } from "../util/signed";
import { sha256Hex } from "../util/sigv4";
import type { PageRow } from "../pages";
import type { ArticleRow, BlogRow } from "../blog";

export const CONTENT_PREVIEW_SECONDS = 10 * 60;
/** 下書きの JSON の大きさの上限（本文の上限より十分大きく） */
export const CONTENT_PREVIEW_MAX_CHARS = 1_000_000;
const key = (secret: string) => `${secret}:content_preview`;

export type PreviewDraft = { kind: "page"; page: PageRow } | { kind: "article"; blog: BlogRow; article: ArticleRow };

export async function sealContentPreview(secret: string, shopId: string, draft: string, now = Date.now()): Promise<string> {
  return sealJson(key(secret), { k: "content_preview", s: shopId, h: await sha256Hex(draft), exp: Math.floor(now / 1000) + CONTENT_PREVIEW_SECONDS });
}

/** 券がこのショップのこの下書きのものなら、下書き（形の合わないものは null） */
export async function openContentPreview(secret: string, token: string | undefined, shopId: string, draft: string | undefined): Promise<PreviewDraft | null> {
  if (!token || !draft || draft.length > CONTENT_PREVIEW_MAX_CHARS) return null;
  const v = (await openJson(key(secret), token)) as { k?: unknown; s?: unknown; h?: unknown; exp?: unknown } | null;
  if (!v || v.k !== "content_preview" || v.s !== shopId || typeof v.exp !== "number" || v.exp * 1000 < Date.now()) return null;
  if (v.h !== (await sha256Hex(draft))) return null;
  let d: unknown;
  try {
    d = JSON.parse(draft);
  } catch {
    return null;
  }
  const o = d as { kind?: unknown; page?: { body?: unknown; handle?: unknown; shop_id?: unknown }; blog?: { handle?: unknown; shop_id?: unknown }; article?: { body?: unknown; handle?: unknown; shop_id?: unknown } };
  if (o.kind === "page" && o.page && typeof o.page.body === "string" && typeof o.page.handle === "string" && o.page.shop_id === shopId) return d as PreviewDraft;
  if (o.kind === "article" && o.blog && o.article && typeof o.article.body === "string" && typeof o.blog.handle === "string" && o.blog.shop_id === shopId && o.article.shop_id === shopId) return d as PreviewDraft;
  return null;
}
