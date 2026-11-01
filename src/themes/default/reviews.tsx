/**
 * 外部プラグインのレビュー（0084、docs/app-data.md）の既定の見た目。「星と件数」と「レビューの一覧」の 2 つ。
 * 文字はすべてエスケープして描く（プラグインが HTML を送っても文字のまま）。凝った見た目は Liquid のテーマに任せる。
 */
import type { ProductReviews } from "../../apps/app-data";
import { t, tf } from "../../i18n";

/** ★ の並び（四捨五入で 5 つ）。読み上げは aria-label の数で */
export function Stars(props: { rating: number }) {
  const full = Math.max(0, Math.min(5, Math.round(props.rating)));
  return (
    <span class="stars" role="img" aria-label={tf("store.reviews_rating", { rating: props.rating.toFixed(1) })}>
      {"★".repeat(full)}
      <span class="stars-off">{"★".repeat(5 - full)}</span>
    </span>
  );
}

/** 星と件数（商品の名前の下。一覧へのリンク） */
export function ReviewsSummary(props: { reviews: ProductReviews; href?: string }) {
  const r = props.reviews;
  const label = tf("store.reviews_count", { count: r.rating_count.toLocaleString("ja-JP") });
  return (
    <p class="reviews-summary">
      <Stars rating={r.rating_avg} /> <strong>{r.rating_avg.toFixed(1)}</strong> {props.href ? <a href={props.href}>{label}</a> : <span>{label}</span>}
    </p>
  );
}

/** レビューの一覧（新しい 20 件まで。置かれた分だけ） */
export function ReviewsList(props: { reviews: ProductReviews; id?: string }) {
  const r = props.reviews;
  return (
    <section class="reviews" id={props.id}>
      <h2>{t("store.reviews")}</h2>
      <ReviewsSummary reviews={r} />
      {r.items.length > 0 ? (
        <ol class="review-list">
          {r.items.map((i) => (
            <li class="review">
              <p class="review-head">
                <Stars rating={i.rating} /> {i.title ? <strong>{i.title}</strong> : null}
              </p>
              <p class="review-body">{i.body}</p>
              <p class="muted review-meta">
                {i.author_display} · <time datetime={i.created_at}>{i.created_at.slice(0, 10)}</time>
                {i.verified_purchase ? <span class="badge">{t("store.review_verified")}</span> : null}
                {i.incentivized ? <span class="badge">{t("store.review_incentivized")}</span> : null}
              </p>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

export const REVIEWS_CSS =
  ".stars{color:#e3a008;letter-spacing:.05em}.stars-off{color:color-mix(in srgb,CanvasText 20%,transparent)}.reviews-summary{margin:.25rem 0}.reviews{margin-top:2rem}.review-list{list-style:none;padding:0}.review{border-top:1px solid color-mix(in srgb,CanvasText 15%,transparent);padding:.75rem 0}.review-head,.review-meta{margin:.2rem 0}.review-body{white-space:pre-wrap;margin:.4rem 0}.review-meta .badge{margin-left:.5rem}";
