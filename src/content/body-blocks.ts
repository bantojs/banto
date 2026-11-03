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
import { productPartsOf, shopBlocksOf, type ShopBlock } from "../pages/shop-blocks";
import { PAGES_MODULE, pagePath } from "../pages";
import { imageUrl } from "../media/images";

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
  /** お店のブロック（src/pages/shop-blocks.ts）の中身（印の番号と同じ並び。出せないものは空） */
  shopCards: string[];
}

export async function bodyBlocks(d: BodyBlocksDeps, body: string, categories: CategoryRow[]): Promise<BodyBlocks> {
  const [blocks, ablocks, apps, shopCards] = await Promise.all([
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
    Promise.all(shopBlocksOf(body).map((b) => shopBlockHtml(d, b, categories).catch((e: unknown) => (console.error("[banto] shop block:", e), "")))),
  ]);
  const cards = blocks.map((b) => defaultProductsHtml(b.items, b.block, { shopPath: d.shopPath, mediaBaseUrl: d.mediaBaseUrl, taxNote: t("store.tax_included"), yen }));
  const acards = ablocks.map((b) =>
    b ? defaultArticlesHtml(b.items.map((a) => ({ title: a.title, url: articlePath(d.shopPath, b.blog.handle, a.handle), image: a.image_url, date: formatDateTime(a.published_at ?? a.updated_at, { dateOnly: true }), summary: articleSummary(a, 80) })), b.block) : "",
  );
  const appCards = apps.map((b) => defaultAppHtml(b, b ? `${d.shopPath}/p/${encodeURIComponent(b.product.slug)}#reviews` : ""));
  return { blocks, cards, ablocks, acards, apps, appCards, shopCards };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * お店のブロックの中身。商品・ページ・記事は匿名・会員の読み取りの経路（d.sf）のまま引くので、会員限定のものは合わない人には出ない。
 * 価格は見る人の単価（会員なら会員価格）。カートに入れる・今すぐ買うは Banto のカートのフォーム（判定はカートと最終確認）
 */
async function shopBlockHtml(d: BodyBlocksDeps, b: ShopBlock, categories: CategoryRow[]): Promise<string> {
  const a = b.attrs;
  if (b.kind === "search") {
    const ph = a["placeholder"] || t("blocks.search_placeholder");
    return `<form class="banto-search" role="search" method="get" action="${esc(`${d.shopPath}/search`)}"><input type="search" name="q" maxlength="100" placeholder="${esc(ph)}" aria-label="${esc(t("blocks.search_label"))}"><button type="submit">${esc(t("blocks.search_button"))}</button></form>`;
  }
  if (b.kind === "categories") {
    const parent = a["parent"] ? categories.find((c) => c.slug === a["parent"]) : null;
    if (a["parent"] && !parent) return "";
    const kids = (id: string | null): CategoryRow[] => categories.filter((c) => (c.parent_id ?? null) === id).sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0));
    const tree = (id: string | null, depth: number): string => {
      const list = kids(id);
      if (list.length === 0 || depth > 4) return "";
      return `<ul${depth === 0 ? ` class="banto-categories banto-categories--${a["layout"]}"` : ""}>${list.map((c) => `<li><a href="${esc(`${d.shopPath || "/"}?category=${encodeURIComponent(c.slug)}`)}">${esc(c.name)}</a>${a["layout"] === "grid" ? "" : tree(c.id, depth + 1)}</li>`).join("")}</ul>`;
    };
    return tree(parent ? parent.id : null, 0);
  }
  if (b.kind === "card") {
    if (a["page"]) {
      if (!moduleEnabled(d.shop.settings, PAGES_MODULE)) return "";
      const page = await d.sf.pageByHandle(d.shop, a["page"]);
      if (!page) return "";
      return cardHtml(pagePath(d.shopPath, page.handle), page.title, page.image_url ?? null, page.seo_description ?? "", d.mediaBaseUrl);
    }
    const [blogHandle, handle] = (a["article"] ?? "").split("/");
    if (!blogHandle || !handle || !moduleEnabled(d.shop.settings, BLOG_MODULE)) return "";
    const blog = await d.sf.blogByHandle(d.shop, blogHandle);
    const art = blog ? await d.sf.articleByHandle(d.shop, blog.id, handle) : null;
    if (!blog || !art) return "";
    return cardHtml(articlePath(d.shopPath, blog.handle, art.handle), art.title, art.image_url ?? null, articleSummary(art, 80), d.mediaBaseUrl, formatDateTime(art.published_at ?? art.updated_at, { dateOnly: true }));
  }
  if (b.kind === "product") {
    const detail = await d.sf.productBySlug(d.shop, a["slug"] ?? "");
    if (!detail) return "";
    const p = detail.product;
    const parts = productPartsOf(b);
    const url = `${d.shopPath}/p/${encodeURIComponent(p.slug)}`;
    const prices = detail.skus.map((k) => k.price_jpy);
    const min = prices.length ? Math.min(...prices) : null;
    const member = detail.skus.map((k) => k.member_price_jpy).filter((x): x is number => typeof x === "number");
    const out: string[] = [];
    for (const part of parts) {
      if (part === "image") {
        const img = detail.images[0];
        if (img) out.push(`<a href="${esc(url)}"><img src="${esc(imageUrl(d.mediaBaseUrl, img.storage_key))}" alt="${esc(p.name)}" loading="lazy" decoding="async"></a>`);
      } else if (part === "name") out.push(`<a class="banto-product__name" href="${esc(url)}">${esc(p.name)}</a>`);
      else if (part === "price" && min !== null) out.push(`<div class="banto-product__price">${esc(yen(min))}${prices.length > 1 && new Set(prices).size > 1 ? "〜" : ""}${member.length ? ` <small>（${esc(t("store.member_price"))} ${esc(yen(Math.min(...member)))}）</small>` : ""} <small>${esc(t("store.tax_included"))}</small></div>`);
      else if (part === "sku") out.push(`<div class="banto-product__sku">${detail.skus.map((k) => esc(k.code)).join(" / ")}</div>`);
      else if (part === "tags" && (p.tags ?? []).length) out.push(`<div class="banto-product__tags">${(p.tags ?? []).map((x) => `<span>${esc(x)}</span>`).join(" ")}</div>`);
      else if (part === "description" && p.description) out.push(`<div class="banto-product__description">${esc(p.description.slice(0, 400))}</div>`);
    }
    const cart = parts.includes("cart"), buy = parts.includes("buy");
    if ((cart || buy) && detail.skus.length > 0) {
      if (detail.purchasable === false) out.push(`<p class="banto-product__note">${esc(t("store.members_only_login"))}</p>`);
      else {
        const inStock = detail.skus.filter((k) => k.available > 0);
        const select = detail.skus.length > 1 ? `<select name="sku_id" aria-label="${esc(t("store.variant"))}">${detail.skus.map((k) => `<option value="${esc(k.id)}"${k.available > 0 ? "" : " disabled"}>${esc(k.name || k.code)} — ${esc(yen(k.price_jpy))}</option>`).join("")}</select>` : `<input type="hidden" name="sku_id" value="${esc(detail.skus[0]!.id)}">`;
        const disabled = inStock.length === 0 ? " disabled" : "";
        const buttons = `${cart ? `<button type="submit"${disabled}>${esc(inStock.length === 0 ? t("store.sold_out") : t("store.add_to_cart"))}</button>` : ""}${buy ? `<button type="submit" name="buy" value="1"${disabled}>${esc(t("blocks.buy_now"))}</button>` : ""}`;
        out.push(`<form method="post" action="${esc(`${d.shopPath}/cart/add`)}">${select}<input type="hidden" name="qty" value="1">${buttons}</form>`);
      }
    }
    return `<div class="banto-product">${out.join("")}</div>`;
  }
  return "";
}

function cardHtml(url: string, title: string, image: string | null, summary: string, mediaBase: string, date?: string): string {
  const src = image ? (image.startsWith("/") || /^https?:\/\//.test(image) ? image : imageUrl(mediaBase, image)) : null;
  return `<a class="banto-card" href="${esc(url)}">${src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">` : ""}<span><span class="banto-card__title">${esc(title)}</span>${date ? `<br><small>${esc(date)}</small>` : ""}${summary ? `<br><small>${esc(summary)}</small>` : ""}</span></a>`;
}
