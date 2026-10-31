/**
 * 本文の中の「商品を並べる」「記事を並べる」のデータと既定のカード。お店の画面（既定のテーマ・Liquid）と
 * ヘッドレスの公開 API（src/routes/api/content.ts）の両方がここを通る。
 * - 商品: 1 ページに 3 つまで、ブロックごとに一覧と同じ問い合わせ 1 回・キャッシュ。取れなければそのブロックは空
 * - 記事: 1 ページに 2 つまで（ブログ・記事の一覧と同じ問い合わせ・キャッシュ）。ブログのモジュールが OFF なら空
 */
import type { CategoryRow } from "../db/types";
import type { PublicShop, StorefrontData } from "../storefront/data";
import { articleBlocksOf, defaultArticlesHtml, defaultProductsHtml, productBlocksOf, type ArticlesBlock, type ProductBlock } from "../pages/blocks";
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
}

export async function bodyBlocks(d: BodyBlocksDeps, body: string, categories: CategoryRow[]): Promise<BodyBlocks> {
  const [blocks, ablocks] = await Promise.all([
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
  ]);
  const cards = blocks.map((b) => defaultProductsHtml(b.items, b.block, { shopPath: d.shopPath, mediaBaseUrl: d.mediaBaseUrl, taxNote: t("store.tax_included"), yen }));
  const acards = ablocks.map((b) =>
    b ? defaultArticlesHtml(b.items.map((a) => ({ title: a.title, url: articlePath(d.shopPath, b.blog.handle, a.handle), image: a.image_url, date: formatDateTime(a.published_at ?? a.updated_at, { dateOnly: true }), summary: articleSummary(a, 80) })), b.block) : "",
  );
  return { blocks, cards, ablocks, acards };
}
