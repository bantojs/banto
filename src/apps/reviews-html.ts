/**
 * レビュー（reviews.v1）の既定の見た目を HTML の文字で（0084・0086）。既定のテーマの商品のページ・本文のプラグインのブロック・
 * snippet の無い Liquid のテーマが使う。文字はすべてエスケープする（プラグインが HTML を送っても文字のまま）
 */
import type { ProductReviews } from "./app-data";
import { t, tf } from "../i18n";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ESC[ch]!);

export function starsHtml(rating: number): string {
  const full = Math.max(0, Math.min(5, Math.round(rating)));
  return `<span class="stars" role="img" aria-label="${esc(tf("store.reviews_rating", { rating: rating.toFixed(1) }))}">${"★".repeat(full)}<span class="stars-off">${"★".repeat(5 - full)}</span></span>`;
}

/** 星と件数（href があれば件数を一覧へのリンクに） */
export function reviewsSummaryHtml(r: ProductReviews, href?: string): string {
  const label = esc(tf("store.reviews_count", { count: r.rating_count.toLocaleString("ja-JP") }));
  return `<p class="reviews-summary">${starsHtml(r.rating_avg)} <strong>${r.rating_avg.toFixed(1)}</strong> ${href ? `<a href="${esc(href)}">${label}</a>` : `<span>${label}</span>`}</p>`;
}

/** レビューの一覧（見出し・星と件数・新しいものから limit 件） */
export function reviewsListHtml(r: ProductReviews, opts: { id?: string; limit?: number; heading?: boolean } = {}): string {
  const items = r.items.slice(0, Math.max(0, Math.min(20, opts.limit ?? 20)));
  const list = items.length
    ? `<ol class="review-list">${items
        .map(
          (i) =>
            `<li class="review"><p class="review-head">${starsHtml(i.rating)} ${i.title ? `<strong>${esc(i.title)}</strong>` : ""}</p><p class="review-body">${esc(i.body)}</p><p class="muted review-meta">${esc(i.author_display)} · <time datetime="${esc(i.created_at)}">${esc(i.created_at.slice(0, 10))}</time>${i.verified_purchase ? `<span class="badge">${esc(t("store.review_verified"))}</span>` : ""}${i.incentivized ? `<span class="badge">${esc(t("store.review_incentivized"))}</span>` : ""}</p></li>`,
        )
        .join("")}</ol>`
    : "";
  return `<section class="reviews"${opts.id ? ` id="${esc(opts.id)}"` : ""}>${opts.heading === false ? "" : `<h2>${esc(t("store.reviews"))}</h2>`}${reviewsSummaryHtml(r)}${list}</section>`;
}
