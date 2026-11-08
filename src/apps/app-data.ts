/**
 * 外部プラグインの拡張データ（0084_app_data、docs/app-data.md）。
 * プラグインが AI 用トークン（app_data:write、送信先に結んだもの）で置き直し、お客様の画面は商品と一緒に読んだ分だけで描く。
 * 形（kind）は Banto が知っているものだけ。検査と組み直しは DB（banto_app_data_normalize）、ここは読む側の型と取り出し。
 */

/** 知っている形。custom.v1 は形を決めない種類で、Banto 自身は描かない（Liquid のテーマとヘッドレスだけが読む） */
export const APP_DATA_KINDS = ["reviews.v1", "custom.v1"] as const;

/** custom.v1 の名前（0085 の CHECK と同じ） */
export const APP_DATA_KEY_RE = /^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export type AppDataKind = (typeof APP_DATA_KINDS)[number];

export function isAppDataKind(v: unknown): v is AppDataKind {
  return typeof v === "string" && (APP_DATA_KINDS as readonly string[]).includes(v);
}

export interface ReviewItem {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  author_display: string;
  created_at: string;
  incentivized: boolean;
  verified_purchase: boolean;
}

export interface ReviewsV1 {
  rating_avg: number;
  rating_count: number;
  items: ReviewItem[];
}

/** product_public_get が返す 1 行（公開・有効な送信先の分だけ） */
export interface PublicAppData {
  app: string;
  kind: string;
  /** custom.v1 の名前（ほかの種類は空か無い） */
  key?: string;
  data: unknown;
  updated_at?: string;
  /** 「もっと見る」の公開 API（0087、https だけ） */
  more_url?: string;
}

/** お客様の画面に出すレビュー（どのプラグインのものか付き） */
export interface ProductReviews extends ReviewsV1 {
  app: string;
  /** 「もっと見る」に使う（0087）。URL と商品の id がそろったときだけ */
  more?: { url: string; product_id: string };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 商品の app_data（DB の版が古ければ無い）を配列にそろえる */
export function appDataOf(product: { app_data?: unknown }): PublicAppData[] {
  const raw = product.app_data;
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is PublicAppData => isObj(r) && typeof r["app"] === "string" && typeof r["kind"] === "string");
}

function reviewItem(v: unknown): ReviewItem | null {
  if (!isObj(v)) return null;
  const rating = Number(v["rating"]);
  if (typeof v["id"] !== "string" || !Number.isInteger(rating) || rating < 1 || rating > 5) return null;
  if (typeof v["body"] !== "string" || typeof v["author_display"] !== "string" || typeof v["created_at"] !== "string") return null;
  return {
    id: v["id"],
    rating,
    title: typeof v["title"] === "string" && v["title"] !== "" ? v["title"] : null,
    body: v["body"],
    author_display: v["author_display"],
    created_at: v["created_at"],
    incentivized: v["incentivized"] === true,
    verified_purchase: v["verified_purchase"] === true,
  };
}

/** custom.v1 をプラグインの名前 → 名前（key）→ 中身にまとめる（Liquid の product.apps） */
export function customAppData(product: { app_data?: unknown }): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const row of appDataOf(product)) {
    if (row.kind !== "custom.v1" || typeof row.key !== "string" || row.key === "") continue;
    (out[row.app] ??= {})[row.key] = row.data;
  }
  return out;
}

/** レビュー（reviews.v1）。複数のプラグインが置いていれば名前の順で最初のもの。件数 0 なら null */
export function productReviews(product: { id?: string; app_data?: unknown }): ProductReviews | null {
  for (const row of appDataOf(product)) {
    if (row.kind !== "reviews.v1" || !isObj(row.data)) continue;
    const d = row.data;
    const count = Number(d["rating_count"]);
    const avg = Number(d["rating_avg"]);
    if (!Number.isInteger(count) || count <= 0 || !Number.isFinite(avg) || avg < 0 || avg > 5) continue;
    const items = Array.isArray(d["items"]) ? d["items"].map(reviewItem).filter((x): x is ReviewItem => x !== null).slice(0, 20) : [];
    const more = typeof row.more_url === "string" && /^https:\/\/[^\s"'<>`]+$/.test(row.more_url) && typeof product.id === "string" && product.id ? { url: row.more_url, product_id: product.id } : null;
    return { app: row.app, rating_avg: avg, rating_count: count, items, ...(more ? { more } : {}) };
  }
  return null;
}

/** 構造化データ（schema.org の AggregateRating と Review）。見えている分と同じものだけ */
export function reviewsJsonLd(r: ProductReviews): Record<string, unknown> {
  return {
    aggregateRating: { "@type": "AggregateRating", ratingValue: r.rating_avg, reviewCount: r.rating_count, bestRating: 5, worstRating: 1 },
    ...(r.items.length > 0
      ? {
          review: r.items.map((i) => ({
            "@type": "Review",
            reviewRating: { "@type": "Rating", ratingValue: i.rating, bestRating: 5, worstRating: 1 },
            author: { "@type": "Person", name: i.author_display },
            datePublished: i.created_at.slice(0, 10),
            ...(i.title ? { name: i.title } : {}),
            reviewBody: i.body,
          })),
        }
      : {}),
  };
}
