/**
 * 外部プラグインのレビュー（0084、docs/app-data.md）の既定の見た目。「星と件数」と「レビューの一覧」の 2 つ。
 * 中身は src/apps/reviews-html.ts（本文のプラグインのブロックと同じ HTML。文字はすべてエスケープ）。凝った見た目は Liquid のテーマに任せる。
 */
import { raw } from "hono/html";
import type { ProductReviews } from "../../apps/app-data";
import { reviewsListHtml, reviewsSummaryHtml } from "../../apps/reviews-html";

/** 星と件数（商品の名前の下。一覧へのリンク） */
export function ReviewsSummary(props: { reviews: ProductReviews; href?: string }) {
  return raw(reviewsSummaryHtml(props.reviews, props.href));
}

/** レビューの一覧（新しい 20 件まで。置かれた分だけ） */
export function ReviewsList(props: { reviews: ProductReviews; id?: string }) {
  return raw(reviewsListHtml(props.reviews, props.id ? { id: props.id } : {}));
}

export const REVIEWS_CSS =
  ".stars{color:#e3a008;letter-spacing:.05em}.stars-off{color:color-mix(in srgb,CanvasText 20%,transparent)}.reviews-summary{margin:.25rem 0}.reviews{margin-top:2rem}.review-list{list-style:none;padding:0}.review{border-top:1px solid color-mix(in srgb,CanvasText 15%,transparent);padding:.75rem 0}.review-head,.review-meta{margin:.2rem 0}.review-body{white-space:pre-wrap;margin:.4rem 0}.review-meta .badge{margin-left:.5rem}.reviews-more{margin-top:.5rem}";
