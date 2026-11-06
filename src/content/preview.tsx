/**
 * ページ・記事のプレビュー（保存しない）。お店の画面と同じテーマ（既定の TSX のテーマ）・同じ本文の変換・同じブロックの中身で描く。
 * - 商品・ページ・記事のブロックは、お店の画面と同じ匿名の読み取り（公開中のものだけ）。非公開のショップでは中身が空になる
 * - 見せる相手の囲み（0097）は運営者には中身ごと見せる（だれに出るかは編集の画面の目印で分かる）
 * - Liquid のテーマのショップも、ここでは既定のテーマで描く（テーマのプレビューは「テーマ」の画面から）
 */
import type { AdminContext } from "../routes/admin/context";
import type { ShopRow } from "../db/types";
import { toPublicShop, type PublicShop } from "../storefront/data";
import { storefrontData } from "../routes/storefront/domain";
import { resolveTheme } from "../themes";
import type { ThemeContext } from "../themes/types";
import { markdownToHtml } from "../pages/markdown";
import { filterAudienceBlocks } from "./audience-blocks";
import { previewBody } from "../routes/audience-render";
import { bodyBlocks } from "./body-blocks";
import { fillAppBlocks, fillArticleBlocks, fillProductBlocks } from "../pages/blocks";
import { fillDateBlocks, fillShopBlocks } from "../pages/shop-blocks";
import { mediaBaseUrl, publicBaseUrl } from "../routes/common";
import type { PageRow } from "../pages";
import type { ArticleRow, BlogRow } from "../blog";
import { blogHasFeed, blogPath } from "../blog";
import type { CategoryRow } from "../db/types";
import { t } from "../i18n";
import { articleParts, fillCurrent, pageParts } from "./layouts";
import { shopHome } from "../storefront/urls";
import { sealContentPreview } from "./preview-ticket";
import { escapeHtml } from "../mail/html";

export type PreviewTarget = { kind: "page"; page: PageRow } | { kind: "article"; blog: BlogRow; article: ArticleRow };

/**
 * プレビューを出す。公開中のショップは、お店の画面のオリジン（独自ドメインならそのドメイン）へ下書きを送り、本物と同じ処理・同じテーマ
 * （Liquid のテーマを含む）で描く（src/routes/storefront/index.tsx の POST /_preview/content）。
 * 非公開のショップ・サイトの秘密が無いときは、管理画面で既定のテーマで描く（themedPreview）
 */
/**
 * 編集の画面のスクリプトが、プレビューのタブと「お店の見た目」の欄を描き直すための形（Accept: application/json）:
 * { kind: "post", action, token, draft }（スクリプトがお店のオリジンへ送る）か { kind: "html", html }（非公開のショップ。枠に srcdoc で入れる）
 */
export const wantsPreviewJson = (c: AdminContext) => (c.req.header("accept") ?? "").includes("application/json");

export async function previewResponse(c: AdminContext, shop: ShopRow, target: PreviewTarget, categories: CategoryRow[]): Promise<Response | null> {
  const secret = c.get("sessionSecret");
  const json = wantsPreviewJson(c);
  if (!shop.published || !secret) {
    const res = await themedPreview(c, shop, target, categories);
    if (res && json) return c.json({ kind: "html", html: await res.text() }, 200, { "Cache-Control": "private, no-store" });
    return res;
  }
  const draft = JSON.stringify(target);
  // 枠を許すのは、この編集の画面のオリジンだけ（券に署名して結ぶ）
  const token = await sealContentPreview(secret, shop.id, draft, Date.now(), json ? new URL(c.req.url).origin : undefined);
  const action = `${shopHome(publicBaseUrl(c), shop)}/_preview/content`;
  if (json) return c.json({ kind: "post", action, token, draft }, 200, { "Cache-Control": "private, no-store" });
  c.header("Cache-Control", "private, no-store");
  c.header("X-Robots-Tag", "noindex");
  // 新しいタブで開いた画面から、お店のオリジンへ送る（スクリプトが動かなければボタンで）
  return c.html(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${escapeHtml(t("pages.preview"))}</title></head>` +
      `<body style="font-family:system-ui,sans-serif;padding:2rem"><form id="pv" method="post" action="${escapeHtml(action)}">` +
      `<input type="hidden" name="token" value="${escapeHtml(token)}"><input type="hidden" name="draft" value="${escapeHtml(draft)}">` +
      `<p>${escapeHtml(t("pages.preview_opening"))}</p><button type="submit">${escapeHtml(t("pages.preview"))}</button></form>` +
      `<script>document.getElementById("pv").submit();</script></body></html>`,
  );
}

/** テーマで描いたプレビューの HTML。テーマが描けなければ null（呼び出し側が今までの簡単な形で出す） */
export async function themedPreview(c: AdminContext, shop: ShopRow, target: PreviewTarget, categories: CategoryRow[]): Promise<Response | null> {
  const theme = resolveTheme(shop.settings ?? {});
  if (target.kind === "page" ? !theme.ContentPage : !theme.ArticlePage) return null;
  const sf = storefrontData(c);
  // メニュー（pages_nav など）はキャッシュ済みの公開のショップ行から。非公開なら管理画面の行から作る
  const pub: PublicShop = (shop.published && sf ? await sf.shopBySlug(shop.slug).catch(() => null) : null) ?? toPublicShop(shop);
  const mediaBase = mediaBaseUrl(c);
  const shopPath = `/${shop.slug}`;
  const ctx: ThemeContext = {
    shop: pub,
    shopPath,
    mediaBaseUrl: mediaBase,
    cartCount: 0,
    membersEnabled: (shop.settings ?? {})["members_enabled"] === true,
    publicBaseUrl: publicBaseUrl(c),
    themeSettings: typeof (shop.settings ?? {})["theme_settings"] === "object" && (shop.settings ?? {})["theme_settings"] ? ((shop.settings ?? {})["theme_settings"] as Record<string, unknown>) : {},
  };
  const source = target.kind === "page" ? target.page.body : target.article.body;
  // 部品の差し込み（0122）と、見せる相手の囲みは中身ごと
  const body = sf ? (await previewBody(sf, pub, source)).body : filterAudienceBlocks(source, () => true).body;
  const dates = target.kind === "page" ? { published: target.page.published_at ?? target.page.created_at, updated: target.page.updated_at } : { published: target.article.published_at ?? target.article.updated_at, updated: target.article.updated_at };
  // 今の記事・商品の部品: ページはそのページ自身、記事は記事のもの（ひな形の見本はお店の画面のプレビューで）
  const parts = target.kind === "page" ? pageParts({ mediaBase, page: target.page }) : articleParts({ shopPath, mediaBase, blog: target.blog, article: target.article });
  const raw = fillCurrent(fillDateBlocks(markdownToHtml(body, { mediaBase }), dates), parts);
  let html = raw;
  if (sf) {
    const b = await bodyBlocks({ sf, shop: pub, shopPath, mediaBaseUrl: mediaBase }, body, categories).catch(() => null);
    if (b) html = fillAppBlocks(fillArticleBlocks(fillProductBlocks(fillShopBlocks(raw, b.shopCards), b.cards), b.acards), b.appCards);
  }
  const notice = `<p style="padding:.5rem .75rem;border:1px dashed currentColor;border-radius:.4rem;opacity:.85">${t("pages.preview_theme_note")}${shop.published ? "" : ` ${t("pages.preview_unpublished")}`}</p>`;
  c.header("Cache-Control", "private, no-store");
  c.header("X-Robots-Tag", "noindex");
  if (target.kind === "page") return c.html(theme.ContentPage!({ ctx, page: target.page, html: notice + html }));
  return c.html(theme.ArticlePage!({ ctx, blog: target.blog, article: target.article, html: notice + html, feedUrl: blogHasFeed(target.blog) ? `${blogPath(shopPath, target.blog.handle)}/feed.atom` : null }));
}
