/**
 * 本文の中の「商品を並べる」「記事を並べる」のデータと既定のカード。お店の画面（既定のテーマ・Liquid）と
 * ヘッドレスの公開 API（src/routes/api/content.ts）の両方がここを通る。
 * - 商品: 1 ページに 3 つまで、ブロックごとに一覧と同じ問い合わせ 1 回・キャッシュ。取れなければそのブロックは空
 * - 記事: 1 ページに 2 つまで（ブログ・記事の一覧と同じ問い合わせ・キャッシュ）。ブログのモジュールが OFF なら空
 * - 外部プラグインのブロック（0086）: 1 ページに 2 つまで、ブロックごとに商品の拡張データを 1 回・キャッシュ。
 *   既定の見た目は reviews.v1 だけ（custom.v1 は形を知らないので、テーマの snippet が無ければ何も出さない）
 */

/** プラグインのブロックの中身（印の番号と同じ並び。商品が無ければ null） */
export interface AppBlockData {
  block: AppBlock;
  product: ProductRow;
  /** このプラグインのレビュー（無ければ null） */
  reviews: ProductReviews | null;
  /** このプラグインの custom.v1（名前 → 中身） */
  data: Record<string, unknown>;
}

/** reviews.v1 の既定の見た目（設定の layout=summary なら星と件数だけ、limit は一覧の件数 1〜20） */
export function defaultAppHtml(b: AppBlockData | null, productUrl: string): string {
  if (!b?.reviews) return "";
  if (b.block.settings["layout"] === "summary") return reviewsSummaryHtml(b.reviews, productUrl);
  const limit = Number(b.block.settings["limit"] ?? 20);
  return reviewsListHtml(b.reviews, { limit: Number.isInteger(limit) ? limit : 20, heading: false });
}
import type { CategoryRow } from "../db/types";
import type { PublicShop, StorefrontData } from "../storefront/data";
import { appBlocksOf, articleBlocksOf, defaultArticlesHtml, defaultProductsHtml, productBlocksOf, type AppBlock, type ArticlesBlock, type ProductBlock } from "../pages/blocks";
import type { ProductRow } from "../db/types";
import { customAppData, productReviews, type ProductReviews } from "../apps/app-data";
import { reviewsListHtml, reviewsSummaryHtml } from "../apps/reviews-html";
import { BLOG_MODULE, articlePath, articleSummary, type ArticleRow, type BlogRow } from "../blog";
import { moduleEnabled } from "../modules/registry";
import { formatDateTime } from "../i18n/time";
import { t } from "../i18n";
import { yen } from "../routes/common";

export interface BodyBlocksDeps {
  sf: StorefrontData;
  shop: PublicShop;
  /** カードのリンクの起点（お店の画面は /<slug> か ""、ヘッドレスはショップの絶対 URL） */
  shopPath: string;
  mediaBaseUrl: string;
}

type ProductItems = NonNullable<Awaited<ReturnType<StorefrontData["productPage"]>>>["items"];

export interface BodyBlocks {
  blocks: { block: ProductBlock; items: ProductItems }[];
  /** 商品のブロックの既定のカード（印の番号と同じ並び） */
  cards: string[];
  /** 記事のブロック（印の番号と同じ並び。ブログが無い・取れなかったブロックは null） */
  ablocks: ({ block: ArticlesBlock; blog: BlogRow; items: ArticleRow[] } | null)[];
  acards: string[];
  apps: (AppBlockData | null)[];
  appCards: string[];
}

export async function bodyBlocks(d: BodyBlocksDeps, body: string, categories: CategoryRow[]): Promise<BodyBlocks> {
  const [blocks, ablocks, apps] = await Promise.all([
    Promise.all(
      productBlocksOf(body).map(async (block) => {
        try {
          const r = await d.sf.productPage(d.shop, { ...(block.category ? { category: block.category } : {}), ...(block.tag ? { tag: block.tag } : {}), sort: block.sort, limit: block.limit }, categories);
          return { block, items: r?.items ?? [] };
        } catch (e) {
          console.error("[banto] page products:", e);
          return { block, items: [] as ProductItems };
        }
      }),
    ),
    Promise.all(
      (moduleEnabled(d.shop.settings, BLOG_MODULE) ? articleBlocksOf(body) : []).map(async (block) => {
        try {
          const blog = await d.sf.blogByHandle(d.shop, block.blog);
          if (!blog) return null;
          const { items } = await d.sf.articlesPage(d.shop, blog.id, { offset: 0, limit: block.limit, tag: block.tag });
          return { block, blog, items };
        } catch (e) {
          console.error("[banto] page articles:", e);
          return null;
        }
      }),
    ),
    Promise.all(
      appBlocksOf(body).map(async (block): Promise<AppBlockData | null> => {
        try {
          const product = await d.sf.productAppData(d.shop, block.product);
          if (!product) return null;
          const mine = { id: product.id, app_data: Array.isArray(product.app_data) ? product.app_data.filter((x: unknown) => typeof x === "object" && x !== null && (x as { app?: unknown }).app === block.app) : [] };
          return { block, product, reviews: productReviews(mine), data: customAppData(mine)[block.app] ?? {} };
        } catch (e) {
          console.error("[banto] page app block:", e);
          return null;
        }
      }),
    ),
  ]);
  const cards = blocks.map((b) => defaultProductsHtml(b.items, b.block, { shopPath: d.shopPath, mediaBaseUrl: d.mediaBaseUrl, taxNote: t("store.tax_included"), yen }));
  const acards = ablocks.map((b) =>
    b ? defaultArticlesHtml(b.items.map((a) => ({ title: a.title, url: articlePath(d.shopPath, b.blog.handle, a.handle), image: a.image_url, date: formatDateTime(a.published_at ?? a.updated_at, { dateOnly: true }), summary: articleSummary(a, 80) })), b.block) : "",
  );
  const appCards = apps.map((b) => defaultAppHtml(b, b ? `${d.shopPath}/p/${encodeURIComponent(b.product.slug)}#reviews` : ""));
  return { blocks, cards, ablocks, acards, apps, appCards };
}
