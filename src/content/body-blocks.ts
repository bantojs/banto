/**
 * 本文の中の「商品を並べる」「記事を並べる」のデータと既定のカード。お店の画面（既定のテーマ・Liquid）と
 * ヘッドレスの公開 API（src/routes/api/content.ts）の両方がここを通る。
 * - 商品: 1 ページに 3 つまで、ブロックごとに一覧と同じ問い合わせ 1 回・キャッシュ。取れなければそのブロックは空。
 *   選んだ商品（slugs=、0112）はページの全部のブロックの分をまとめて 1 回
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
import { ALL_BLOGS, PRODUCT_BLOCK_SLUGS_MAX, PRODUCT_TAG, appBlocksOf, articleBlockBlogs, articleBlocksOf, defaultArticlesHtml, defaultProductsHtml, productBlocksOf, type AppBlock, type ArticlesBlock, type ProductBlock } from "../pages/blocks";
import type { ProductRow } from "../db/types";
import { customAppData, productReviews, type ProductReviews } from "../apps/app-data";
import { reviewsListHtml, reviewsSummaryHtml } from "../apps/reviews-html";
import { ARTICLES_MULTI_MIGRATION, BLOG_MODULE, articlePath, articleSortFor, articleSummary, type ArticleRow, type BlogRow } from "../blog";
import { BLOG_DATE_ORDER_MIGRATION, type ArticleFieldDef, type FieldSort, articleFieldDefs, articleFieldsReady, blogFieldSort, fieldContains, fieldSortOf, fieldValues } from "../blog/fields";
import { moduleEnabled } from "../modules/registry";
import { formatDateTime } from "../i18n/time";
import { t } from "../i18n";
import { yen } from "../routes/common";
import { productPartsOf, shopBlocksOf, type ShopBlock } from "../pages/shop-blocks";
import { storeView, todayHere } from "../modules/store-tryon";
import { storeFieldView } from "../stores/fields";
import type { StoreView } from "../themes/types";
import { productFields } from "../products/fields";
import { shopImageSrc } from "../pages/markdown";
import { PAGES_MODULE, pagePath } from "../pages";
import { imageUrl } from "../media/images";
import { categoryImageOf } from "../products/category-media";
import { categoryUrl, productUrl, productsUrl } from "../storefront/urls";
import { displayOptionAxes } from "../products/option-axes";
import { optionLabel, optionNamesOf } from "../products/option-names";
import { optionSwatchesOf, swatchFor, swatchView } from "../products/option-swatches";

export interface BodyBlocksDeps {
  sf: StorefrontData;
  shop: PublicShop;
  /** カードのリンクの起点（お店の画面は /<slug> か ""、ヘッドレスはショップの絶対 URL） */
  shopPath: string;
  mediaBaseUrl: string;
  /**
   * 描いている商品（商品詳細のひな形、0102）。::: articles tag=@product がこの商品の URL の名前で絞り、
   * ::: products related=@product が同じ主カテゴリー・同じタグの商品を並べる（この商品は除く）
   */
  current?: {
    product?: string;
    productId?: string;
    categoryId?: string | null;
    tags?: readonly string[];
    /** 描いている記事（0117）: ::: articles field:<key>=@article の値（URL の名前）と、::: products from=@field:<key> の材料 */
    article?: string;
    articleFields?: Record<string, unknown>;
  };
}

type ProductItems = NonNullable<Awaited<ReturnType<StorefrontData["productPage"]>>>["items"];

/**
 * 記事のブロックの中身。blog は 1 つのブログのブロックならそのブログ、ブログをまたぐブロック（0140）なら最初のブログで、
 * blogs にまたいだブログすべて（記事の blog_id でどのブログかを引く）
 */
export type ArticleBlockData = { block: ArticlesBlock; blog: BlogRow; blogs?: BlogRow[]; items: ArticleRow[] } | null;

/** 記事が載っているブログ（またいだブロックは blog_id で引く） */
export function articleBlogOf(b: NonNullable<ArticleBlockData>, a: Pick<ArticleRow, "blog_id">): BlogRow {
  return b.blogs?.find((x) => x.id === a.blog_id) ?? b.blog;
}

export interface BodyBlocks {
  blocks: { block: ProductBlock; items: ProductItems }[];
  /** 商品のブロックの既定のカード（印の番号と同じ並び） */
  cards: string[];
  /** 記事のブロック（印の番号と同じ並び。ブログが無い・取れなかったブロックは null） */
  ablocks: ArticleBlockData[];
  acards: string[];
  apps: (AppBlockData | null)[];
  appCards: string[];
  /** お店のブロック（src/pages/shop-blocks.ts）の中身（印の番号と同じ並び。出せないものは空） */
  shopCards: string[];
}

/**
 * 似た商品（::: products related=@product）: 描いている商品の主カテゴリーの商品、足りなければ最初のタグの商品で埋める（この商品は除く）。
 * 閲覧の履歴は持たない（「いっしょに見られている」は行動の中継を使う外部プラグインの仕事）。商品の画面の外では何も並べない
 */
async function relatedProducts(d: BodyBlocksDeps, block: ProductBlock, categories: CategoryRow[]): Promise<ProductItems> {
  const cur = d.current;
  if (!cur?.productId) return [];
  const take = async (o: { category?: string; tag?: string }) => {
    try {
      return (await d.sf.productPage(d.shop, { ...o, sort: block.sort, limit: block.limit + 1 }, categories))?.items ?? [];
    } catch (e) {
      console.error("[banto] related products:", e);
      return [] as ProductItems;
    }
  };
  const out: ProductItems = [];
  const add = (list: ProductItems) => {
    for (const x of list) if (x.product.id !== cur.productId && !out.some((y) => y.product.id === x.product.id) && out.length < block.limit) out.push(x);
  };
  const main = cur.categoryId ? categories.find((c) => c.id === cur.categoryId) : undefined;
  if (main) add(await take({ category: main.slug }));
  const tag = cur.tags?.[0];
  if (out.length < block.limit && tag) add(await take({ tag }));
  return out;
}

export async function bodyBlocks(d: BodyBlocksDeps, body: string, categories: CategoryRow[]): Promise<BodyBlocks> {
  // 記事の項目の商品（from=@field:<key>、0117）は、描いている記事のその項目の URL の名前を選んだ商品として扱う
  const pblocks = productBlocksOf(body).map((b) => (b.from ? { ...b, slugs: fieldValues(d.current?.articleFields?.[b.from]).slice(0, PRODUCT_BLOCK_SLUGS_MAX) } : b));
  // 選んだ商品（slugs=）は、ページの全部のブロックの分をまとめて 1 回で引く（0112）
  const picked = pblocks.some((b) => b.slugs?.length)
    ? d.sf.productsBySlugs(d.shop, pblocks.flatMap((b) => b.slugs ?? [])).catch((e: unknown) => (console.error("[banto] page products (slugs):", e), [] as ProductItems))
    : null;
  const [blocks, ablocks, apps, shopCards] = await Promise.all([
    Promise.all(
      pblocks.map(async (block) => {
        if (block.slugs?.length) {
          const bySlug = new Map((await picked!).map((x) => [x.product.slug, x]));
          return { block, items: block.slugs.map((x) => bySlug.get(x)).filter((x): x is ProductItems[number] => x !== undefined) };
        }
        if (block.from) return { block, items: [] as ProductItems };
        if (block.related) return { block, items: await relatedProducts(d, block, categories) };
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
          // tag=@product: 描いている商品の URL の名前のタグ（商品の画面の外では何も並べない）
          const tag = block.tag === PRODUCT_TAG ? (d.current?.product ?? null) : block.tag;
          if (block.tag === PRODUCT_TAG && !tag) return null;
          // ブログをまたぐブロック（0140）。名前が 1 つのブログにしか当たらなければ、そのブログのブロックと同じに描く
          const spec = articleBlockBlogs(block);
          const many = spec === ALL_BLOGS || spec.length > 1 ? await resolveBlogs(d, spec) : null;
          if (many && many.length === 0) return null;
          if (many && many.length > 1) return { block: { ...block, tag }, blog: many[0]!, blogs: many, items: await multiBlogArticles(d, many, block, tag) };
          const blog = many ? many[0]! : await d.sf.blogByHandle(d.shop, block.blog);
          if (!blog) return null;
          // 項目で絞る（0117）: @product は描いている商品、@article は描いている記事の URL の名前。定義に無い項目・値の無いときは何も並べない
          let fields: Record<string, unknown> | null = null;
          if (block.field) {
            const def = articleFieldDefs(blog).find((f) => f.key === block.field!.key);
            const v = block.field.value === PRODUCT_TAG ? (d.current?.product ?? "") : block.field.value === "@article" ? (d.current?.article ?? "") : block.field.value;
            fields = def ? fieldContains(def, v) : null;
            if (!fields) return { block: { ...block, tag }, blog, items: [] as ArticleRow[] };
          }
          // 日付の項目の順・今日以降だけ（0124）。日付・日時の項目でなければ何も並べない
          // ブロックに並べ方が無ければブログの並び順（日付の項目の順なら、その順と今日以降だけ）
          // until（終了日、0125）は当たっている DB だけ（会員の経路の関数が受けるため）
          const until = block.until && (await d.sf.migratedTo(BLOG_DATE_ORDER_MIGRATION)) ? block.until : null;
          const fieldSort = block.fieldSort ? fieldSortOf(blog, block.fieldSort, block.from === "today", Date.now(), until) : block.sort ? null : blogFieldSort(blog);
          if (block.fieldSort && !fieldSort) return { block: { ...block, tag }, blog, items: [] as ArticleRow[] };
          const { items } = await d.sf.articlesPage(d.shop, blog.id, { offset: 0, limit: block.limit, tag, sort: articleSortFor(blog, block.sort), withFields: articleFieldsReady(blog), ...(fields ? { fields } : {}), ...(fieldSort ? { fieldSort } : {}) });
          // テーマ（snippets/page-articles）には置き換えた後のタグを渡す（「もっと見る」を /blogs/<ブログ>?tag=<商品> にできる）
          return { block: { ...block, tag }, blog, items };
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
  const cards = blocks.map((b) => defaultProductsHtml(b.items, b.block, { shopPath: d.shopPath, mediaBaseUrl: d.mediaBaseUrl, taxNote: t("store.tax_included"), yen, cardFields: productFields(d.shop.settings) }));
  const acards = ablocks.map((b) =>
    b ? defaultArticlesHtml(b.items.map((a) => ({ title: a.title, url: articlePath(d.shopPath, articleBlogOf(b, a).handle, a.handle), image: a.image_url ? shopImageSrc(a.image_url, d.mediaBaseUrl) : null, date: formatDateTime(a.published_at ?? a.updated_at, { dateOnly: true }), summary: articleSummary(a, 80) })), b.block) : "",
  );
  const appCards = apps.map((b) => defaultAppHtml(b, b ? `${productUrl(d.shopPath, b.product.slug)}#reviews` : ""));
  return { blocks, cards, ablocks, acards, apps, appCards, shopCards };
}

/**
 * またぐブログ（0140）: すべて（"*"）ならショップのブログの一覧（キャッシュ済み、並びはブログの並び順）、名前ならその順に引く（無い名前は飛ばす）。
 * 0140 が当たるまでは何も並べない（会員の経路の関数が無いため。ゲストと会員で並ぶものを変えない）
 */
async function resolveBlogs(d: BodyBlocksDeps, spec: string[] | typeof ALL_BLOGS): Promise<BlogRow[]> {
  if (!(await d.sf.migratedTo(ARTICLES_MULTI_MIGRATION))) return [];
  if (spec === ALL_BLOGS) return await d.sf.blogsList(d.shop);
  const found = await Promise.all(spec.map((h) => d.sf.blogByHandle(d.shop, h)));
  return found.filter((b): b is BlogRow => b !== null);
}

/**
 * ブログをまたいで並べる記事（0140、メンテナの決定 2026-11-10）。並びは新しい順（既定）・題の順・日付の項目の順だけ
 * （手で並べた順はブログごとの順なので新しい順にする。ブログごとの並び順の設定も使わない）。
 * 記事の項目（field:）は、またいだブログのすべてに同じキー・同じ種類（と「いくつも持てる」）の項目があるときだけ効く。無ければ何も並べない
 */
async function multiBlogArticles(d: BodyBlocksDeps, blogs: BlogRow[], block: ArticlesBlock, tag: string | null): Promise<ArticleRow[]> {
  const ready = blogs.every((b) => articleFieldsReady(b));
  let fields: Record<string, unknown> | null = null;
  if (block.field) {
    const def = commonFieldDef(blogs, block.field.key);
    const v = block.field.value === PRODUCT_TAG ? (d.current?.product ?? "") : block.field.value === "@article" ? (d.current?.article ?? "") : block.field.value;
    fields = def && ready ? fieldContains(def, v) : null;
    if (!fields) return [];
  }
  let fieldSort: FieldSort | null = null;
  if (block.fieldSort) {
    // 日付の項目の順・今日以降だけは、どのブログでも同じ答えになるときだけ（同じキーが同じ種類の日付・日時の項目）
    const until = block.until && (await d.sf.migratedTo(BLOG_DATE_ORDER_MIGRATION)) ? block.until : null;
    const now = Date.now();
    const each = blogs.map((b) => fieldSortOf(b, block.fieldSort!, block.from === "today", now, until));
    if (!ready || each.some((x) => !x) || each.some((x) => JSON.stringify(x) !== JSON.stringify(each[0]))) return [];
    fieldSort = each[0]!;
  }
  return d.sf.articlesMulti(
    d.shop,
    blogs.map((b) => b.id),
    { limit: block.limit, tag, sort: block.sort === "title" ? "title" : "new", withFields: ready, ...(fields ? { fields } : {}), ...(fieldSort ? { fieldSort } : {}) },
  );
}

/** どのブログにも同じキー・同じ種類・同じ「いくつも持てる」の項目があれば、その定義（無ければ null） */
function commonFieldDef(blogs: BlogRow[], key: string): ArticleFieldDef | null {
  const defs = blogs.map((b) => articleFieldDefs(b).find((f) => f.key === key) ?? null);
  const first = defs[0];
  if (!first) return null;
  return defs.every((f) => f !== null && f.type === first.type && Boolean(f.multiple) === Boolean(first.multiple)) ? first : null;
}

/** 実店舗の独自項目の行（dl。画像は <img>） */
function storeFieldsHtml(items: { key: string; label: string; type: string; value: string | number }[], mediaBase: string): string {
  if (items.length === 0) return "";
  const dd = (x: (typeof items)[number]) =>
    x.type === "image" ? `<img src="${esc(shopImageSrc(String(x.value), mediaBase) ?? "")}" alt="${esc(x.label)}" loading="lazy">` : x.type === "url" ? `<a href="${esc(String(x.value))}" rel="noopener">${esc(String(x.value))}</a>` : esc(String(x.value));
  return `<dl class="banto-store__fields">${items.map((x) => `<div class="banto-store__field banto-store__field--${esc(x.key)}"><dt>${esc(x.label)}</dt><dd>${dd(x)}</dd></div>`).join("")}</dl>`;
}

/**
 * 実店舗に添える記事（`::: stores articles=<ブログ>[:<キー>]`）。記事の「実店舗」の項目（キーを省けばブログに 1 つだけあるもの）が店舗を指す記事を、
 * 店舗の分まとめて 1 回で引き、店舗ごとに limit 本までのカード（既定の記事のカードの list）にする。店舗 id → HTML
 */
async function storeArticles(d: BodyBlocksDeps, spec: string, storeIds: readonly string[], limit: number, sort: string | null, fromToday: boolean, until: string | null): Promise<Map<string, string> | null> {
  if (!moduleEnabled(d.shop.settings, BLOG_MODULE)) return null;
  const [handle, keyRaw] = spec.split(":");
  const blog = handle ? await d.sf.blogByHandle(d.shop, handle) : null;
  if (!blog || !articleFieldsReady(blog)) return null;
  const storeDefs = articleFieldDefs(blog).filter((f) => f.type === "store");
  const def = keyRaw ? storeDefs.find((f) => f.key === keyRaw) : storeDefs.length === 1 ? storeDefs[0] : undefined;
  if (!def) return null;
  // 日付の項目の順・今日以降だけ（sort=field:<key> from=today、0124）。日付・日時の項目でなければ添えない
  const fieldSort = sort?.startsWith("field:") ? fieldSortOf(blog, sort.slice(6), fromToday, Date.now(), until) : blogFieldSort(blog);
  if (sort?.startsWith("field:") && !fieldSort) return null;
  const rows = await d.sf.articlesForStores(d.shop, blog.id, def.key, storeIds, articleSortFor(blog, null), fieldSort);
  const byStore = new Map<string, ArticleRow[]>();
  for (const r of rows) {
    const v = r.fields?.[def.key];
    if (typeof v !== "string") continue;
    const list = byStore.get(v) ?? [];
    if (list.length < limit) list.push(r);
    byStore.set(v, list);
  }
  const block: ArticlesBlock = { blog: blog.handle, tag: null, sort: null, limit, layout: "list", style: null };
  const out = new Map<string, string>();
  for (const [id, list] of byStore) {
    out.set(id, defaultArticlesHtml(list.map((x) => ({ title: x.title, url: articlePath(d.shopPath, blog.handle, x.handle), image: x.image_url ? shopImageSrc(x.image_url, d.mediaBaseUrl) : null, date: formatDateTime(x.published_at ?? x.updated_at, { dateOnly: true }), summary: articleSummary(x, 80) })), block));
  }
  return out;
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
    return `<form class="banto-search" role="search" method="get" action="${esc(productsUrl(d.shopPath))}"><input type="search" name="q" maxlength="100" placeholder="${esc(ph)}" aria-label="${esc(t("blocks.search_label"))}"><button type="submit">${esc(t("blocks.search_button"))}</button></form>`;
  }
  if (b.kind === "categories") {
    const parent = a["parent"] ? categories.find((c) => c.slug === a["parent"]) : null;
    if (a["parent"] && !parent) return "";
    const kids = (id: string | null): CategoryRow[] => categories.filter((c) => (c.parent_id ?? null) === id).sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0));
    const tree = (id: string | null, depth: number): string => {
      const list = kids(id);
      if (list.length === 0 || depth > 4) return "";
        // 格子はカテゴリーの画像（0113）があれば名前の上に出す
      const img = (c: CategoryRow) => {
        const im = a["layout"] === "grid" ? categoryImageOf(c) : null;
        return im ? `<img class="banto-categories__image" src="${esc(imageUrl(d.mediaBaseUrl, im.key))}" width="${im.width}" height="${im.height}" alt="" loading="lazy" decoding="async">` : "";
      };
      return `<ul${depth === 0 ? ` class="banto-categories banto-categories--${a["layout"]}"` : ""}>${list.map((c) => `<li><a href="${esc(categoryUrl(d.shopPath, c.slug))}">${img(c)}${esc(c.name)}</a>${a["layout"] === "grid" ? "" : tree(c.id, depth + 1)}</li>`).join("")}</ul>`;
    };
    return tree(parent ? parent.id : null, 0);
  }
  if (b.kind === "card") {
    if (a["page"]) {
      if (!moduleEnabled(d.shop.settings, PAGES_MODULE)) return "";
      const page = await d.sf.pageByHandle(d.shop, a["page"]);
      if (!page || page.is_part) return "";
      return cardHtml(pagePath(d.shopPath, page.handle), page.title, page.image_url ?? null, page.seo_description ?? "", d.mediaBaseUrl);
    }
    const [blogHandle, handle] = (a["article"] ?? "").split("/");
    if (!blogHandle || !handle || !moduleEnabled(d.shop.settings, BLOG_MODULE)) return "";
    const blog = await d.sf.blogByHandle(d.shop, blogHandle);
    const art = blog ? await d.sf.articleByHandle(d.shop, blog.id, handle) : null;
    if (!blog || !art) return "";
    return cardHtml(articlePath(d.shopPath, blog.handle, art.handle), art.title, art.image_url ?? null, articleSummary(art, 80), d.mediaBaseUrl, formatDateTime(art.published_at ?? art.updated_at, { dateOnly: true }));
  }
  if (b.kind === "stores") {
    // ショップで使う実店舗（shop_store_list、キャッシュ済み）。tryon=1 ならお店で試着を受ける店舗だけ
    const today = todayHere();
    const rows = (await d.sf.listStores(d.shop)).filter((st) => a["tryon"] !== "1" || st.tryon);
    const storeRows = new Map(rows.map((st) => [st.id, st]));
    const list = rows.map((st) => storeView(st, today));
    if (list.length === 0) return "";
    const attached = a["articles"] ? await storeArticles(d, a["articles"], list.map((st) => st.id), Number(a["limit"] ?? "3"), a["sort"] ?? null, a["from"] === "today", a["until"]?.slice(6) ?? null) : null;
    const card = (st: StoreView) => {
      const addr = st.address ? `<p class="banto-store__address">${st.postal_code ? `〒${esc(st.postal_code)} ` : ""}${esc(st.address)}</p>` : "";
      const tel = st.phone ? `<p class="banto-store__phone"><a href="tel:${esc(st.phone.replace(/[^0-9+]/g, ""))}">${esc(st.phone)}</a></p>` : "";
      const week = `<details class="banto-store__hours"><summary>${esc(t("tryon.hours"))}</summary><table><tbody>${st.week.map((w) => `<tr><th>${esc(w.day)}</th><td>${esc(w.text)}</td></tr>`).join("")}</tbody></table></details>`;
      const specials = st.specials.length ? `<ul class="banto-store__specials">${st.specials.map((x) => `<li>${esc(x.date)} ${esc(x.text)}</li>`).join("")}</ul>` : "";
      const note = st.note ? `<p class="banto-store__note">${esc(st.note)}</p>` : "";
      // 実店舗の独自項目（0126。show=field:<key> で選んだ公開の項目だけ、選んだ順）
      const show = a["show"] ? a["show"].split(",").map((x) => x.slice(6)) : null;
      const raw = show ? storeRows.get(st.id) : undefined;
      const fieldsHtml = show && raw ? storeFieldsHtml(storeFieldView(raw.field_defs, raw.fields, show), d.mediaBaseUrl) : "";
      const arts = attached?.get(st.id) ?? "";
      return `<li class="banto-store"><p class="banto-store__name">${esc(st.name)}</p>${addr}${tel}<p class="banto-store__today">${esc(st.today)}</p>${week}${specials}${note}${fieldsHtml}${arts ? `<div class="banto-store__articles">${arts}</div>` : ""}</li>`;
    };
    return `<ul class="banto-stores banto-stores--${a["layout"] === "grid" ? "grid" : "list"}">${list.map(card).join("")}</ul>`;
  }
  if (b.kind === "product") {
    const detail = await d.sf.productBySlug(d.shop, a["slug"] ?? "");
    if (!detail) return "";
    const p = detail.product;
    const parts = productPartsOf(b);
    const url = productUrl(d.shopPath, p.slug);
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
      else if (part === "options") out.push(optionsHtml(d, detail));
      else if (part === "sku") out.push(`<div class="banto-product__sku">${detail.skus.map((k) => esc(k.code)).join(" / ")}</div>`);
      else if (part === "tags" && (p.tags ?? []).length) out.push(`<div class="banto-product__tags">${(p.tags ?? []).map((x) => `<span>${esc(x)}</span>`).join(" ")}</div>`);
      else if (part === "description" && p.description) out.push(`<div class="banto-product__description">${esc(p.description.slice(0, 400))}</div>`);
      else if (part.startsWith("field:")) out.push(productFieldHtml(d, p, part.slice(6)));
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

/**
 * 商品の独自項目（show=field:<key>）。公開の項目だけ（値は product_public_get が公開の項目だけを返す）。
 * 値は文字として出し、URL の項目は http(s) のときだけリンクにする
 */
function productFieldHtml(d: BodyBlocksDeps, p: ProductRow, key: string): string {
  const f = productFields(d.shop.settings).find((x) => x.key === key && x.public);
  const raw = f ? (p.attributes ?? {})[key] : undefined;
  if (!f || raw === undefined || raw === null || String(raw).trim() === "") return "";
  const v = String(raw);
  if (f.type === "image") {
    const src = shopImageSrc(v, d.mediaBaseUrl);
    if (!src) return "";
    return `<div class="banto-product__field banto-product__field--${esc(key)} banto-product__field--image"><span class="banto-product__field-label">${esc(f.label)}</span><span class="banto-product__field-value"><img src="${esc(src)}" alt="${esc(f.label)}" loading="lazy"></span></div>`;
  }
  const value = f.type === "url" && /^https?:\/\//i.test(v) ? `<a href="${esc(v)}" rel="nofollow noopener">${esc(v)}</a>` : esc(v).replace(/\n/g, "<br>");
  return `<div class="banto-product__field banto-product__field--${esc(key)}"><span class="banto-product__field-label">${esc(f.label)}</span><span class="banto-product__field-value">${value}</span></div>`;
}

/**
 * 商品のブロックの選択肢（show=options、0115）。軸ごとに値を並べ、見本（色・画像）があれば丸い見本、無ければ値の文字。
 * 押すとその値を持つ SKU（在庫のあるもの、無ければ最初）を選んだ商品ページへ（?sku=<品番>）。在庫の無い値は印を付ける
 */
function optionsHtml(d: BodyBlocksDeps, detail: NonNullable<Awaited<ReturnType<StorefrontData["productBySlug"]>>>): string {
  const axes = displayOptionAxes(detail.product.option_axes, detail.skus);
  if (axes.length === 0) return "";
  const names = optionNamesOf(d.shop.option_names);
  const table = optionSwatchesOf(d.shop.option_swatches);
  const rows = axes.map((a) => {
    const values = [...new Set(detail.skus.map((k) => String((k.options ?? {})[a.key] ?? "").trim()).filter(Boolean))];
    const items = values.map((v) => {
      const withV = detail.skus.filter((k) => String((k.options ?? {})[a.key] ?? "").trim() === v);
      const sku = withV.find((k) => k.available > 0) ?? withV[0]!;
      const sw = swatchView(d.mediaBaseUrl, swatchFor(table, a.key, v));
      const dot = sw?.color ? `<span class="banto-swatch__dot" style="background:${sw.color}"></span>` : sw?.image ? `<span class="banto-swatch__dot"><img src="${esc(sw.image.src)}" alt="" loading="lazy" decoding="async"></span>` : `<span class="banto-swatch__text">${esc(v)}</span>`;
      const out = withV.every((k) => k.available <= 0) ? " banto-swatch--out" : "";
      return `<a class="banto-swatch${out}" href="${esc(productUrl(d.shopPath, detail.product.slug, { sku: sku.code }))}" title="${esc(v)}" aria-label="${esc(v)}">${dot}</a>`;
    });
    return `<div class="banto-product__option"><span class="banto-product__option-name">${esc(optionLabel(names, a.key))}</span><span class="banto-swatches">${items.join("")}</span></div>`;
  });
  return `<div class="banto-product__options">${rows.join("")}</div>`;
}

function cardHtml(url: string, title: string, image: string | null, summary: string, mediaBase: string, date?: string): string {
  // アイキャッチ（置き場の URL）は本文の画像と同じ規則で起点から。キーだけのもの（カテゴリーの画像など）は置き場の起点に付ける
  const src = image ? (image.startsWith("/") || /^https?:\/\//.test(image) ? shopImageSrc(image, mediaBase) : imageUrl(mediaBase, image)) : null;
  return `<a class="banto-card" href="${esc(url)}">${src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">` : ""}<span><span class="banto-card__title">${esc(title)}</span>${date ? `<br><small>${esc(date)}</small>` : ""}${summary ? `<br><small>${esc(summary)}</small>` : ""}</span></a>`;
}
