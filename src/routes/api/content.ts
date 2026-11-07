import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { createDbClient } from "../../db/client";
import { StorefrontData, type PublicShop } from "../../storefront/data";
import { shopHome } from "../../storefront/urls";
import { moduleEnabled } from "../../modules/registry";
import { PAGES_MODULE, pageBodyHtml, pageHandleOk, pagePublishedAt, type PageRow } from "../../pages";
import { articleFieldDefs, articleFieldsReady, blogFieldSort } from "../../blog/fields";
import { ARTICLES_OFFSET_MAX, ARTICLES_PER_PAGE, BLOG_MODULE, articleHandleOk, articleSortFor, articleSummary, blogHasFeed, blogHandleOk, type ArticleRow, type BlogRow } from "../../blog";
import { fillAppBlocks, fillArticleBlocks, fillProductBlocks } from "../../pages/blocks";
import { bodyBlocks } from "../../content/body-blocks";
import { fillDateBlocks, fillShopBlocks } from "../../pages/shop-blocks";
import { mediaBaseUrl, param, publicBaseUrl, type Ctx } from "../common";
import { hasAudienceBlocks } from "../../content/audience-blocks";
import { apiViewerData, viewerBody } from "../audience-render";
import { withIncludes } from "../../content/include";
import { GUEST, queryParamsOf } from "../../members/audience";
import { memberFromRequest } from "./members";

/**
 * ヘッドレスの公開 API: ショップのページ（同梱モジュール pages、0079）とブログ・記事（blog、0081）。docs/headless.md「ページ・ブログ」。
 * - 読むのは anon キー（公開中・日時を過ぎた・ゴミ箱の外だけが RLS で返る）。CORS は ./index.ts の公開の設定（*）
 * - モジュールが OFF のショップは 404（キャッシュ済みのショップ行で判定し、DB に問い合わせない）
 * - 本文は元の書式（body）と、Banto が描いた HTML（html）の両方。html には並べ方の CSS と、商品・記事のブロックの既定のカードが入る。
 *   画像はこの Banto の絶対 URL、カードのリンクはショップの絶対 URL（連携サイトに差し込んでも読めるように）。本文のリンクは書いたまま
 * - お店の画面の使い方（settings.storefront）は見ない（Banto の画面を使わないショップこそ、ここから読む）
 */
export const contentApi = new Hono<AppEnv>();

interface Scope {
  sf: StorefrontData;
  shop: PublicShop;
  mediaBaseUrl: string;
  /** /media/ の画像を絶対 URL にするオリジン */
  origin: string;
  /** カードのリンクの起点（ショップの絶対 URL） */
  home: string;
}

async function scope(c: Ctx, module: string): Promise<Scope | Response> {
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const anonKey = cfg.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) return c.json({ error: "not_configured" }, 503);
  const sf = new StorefrontData(createDbClient({ url, anonKey, fetch: c.get("deps").fetch }), c.get("adapters").cache);
  const shop = await sf.shopBySlug(param(c, "shop"));
  if (!shop || !moduleEnabled(shop.settings, module)) return c.json({ error: "not_found" }, 404);
  // 会員トークンの会員には会員限定のページ・記事も（0100。同梱モジュール audiences が ON のショップだけ。壊れたトークンは 401）
  const viewer = await apiViewerData(c, sf, shop);
  if (viewer instanceof Response) return viewer;
  const origin = publicBaseUrl(c);
  return { sf: viewer, shop, mediaBaseUrl: mediaBaseUrl(c), origin, home: shopHome(origin, shop) };
}

/** アイキャッチ（保存した URL。/media/ から始まるものは絶対 URL に） */
const absImage = (s: Scope, url: string | null | undefined) => (url ? (url.startsWith("/") ? `${s.origin}${url}` : url) : null);

/**
 * 見る人に合わせた本文の書式と HTML（書式 → HTML、商品・記事のブロックに既定のカード）。
 * 見せる相手の囲み（0097）は、会員トークン（Authorization: Bearer bm1.…）の会員に合わせて、書式からも HTML からも外す。
 * トークンが無ければゲスト、壊れていれば 401
 */
async function viewBody(c: Ctx, s: Scope, row: Pick<PageRow, "id" | "updated_at" | "body">, published: string | null): Promise<{ body: string; html: string } | Response> {
  // 部品の差し込み（0122）の後に、見せる相手の囲みがあれば見る人で外す
  let view = await withIncludes(s.sf, s.shop, row.body);
  if (hasAudienceBlocks(view.body)) {
    const m = await memberFromRequest(c, s.shop);
    if (!m.ok) return c.json({ error: "invalid_member_token" }, 401);
    // 連携サイトの見る人の URL のクエリは p.<名前> で受け取る（覚えた値も連携サイトが同じ形で渡す）
    const params = queryParamsOf([...new URL(c.req.url).searchParams.entries()].filter(([k]) => k.startsWith("p.")).map(([k, v]): [string, string] => [k.slice(2), v]));
    view = await viewerBody(c, s.sf, s.shop, row.body, { ...(m.member ? { member: true, attrs: m.member.attrs ?? {} } : GUEST), params });
    c.header("Vary", "Authorization");
  }
  // 日時のブロックは描くたびに入れる（本文の HTML の覚えに日時を入れない）
  const html = fillDateBlocks(pageBodyHtml({ ...row, body: view.body }, s.mediaBaseUrl, s.origin, view.key), { published, updated: row.updated_at });
  const categories = await s.sf.listCategories(s.shop);
  const { cards, acards, appCards, shopCards } = await bodyBlocks({ sf: s.sf, shop: s.shop, shopPath: s.home, mediaBaseUrl: s.mediaBaseUrl }, view.body, categories);
  return { body: view.body, html: fillAppBlocks(fillArticleBlocks(fillProductBlocks(fillShopBlocks(html, shopCards), cards), acards), appCards) };
}

function pageSummary(s: Scope, p: Omit<PageRow, "body">) {
  return {
    handle: p.handle,
    title: p.title,
    url: `${s.home}/pages/${encodeURIComponent(p.handle)}`,
    nav: p.nav,
    sort_order: p.sort_order,
    template_suffix: p.template_suffix,
    seo_title: p.seo_title,
    seo_description: p.seo_description,
    image_url: absImage(s, p.image_url),
    published_at: pagePublishedAt(p),
    updated_at: p.updated_at,
  };
}

/** 公開中のページ（並び順。本文は持たない） */
contentApi.get("/shops/:shop/pages", async (c: Ctx) => {
  const s = await scope(c, PAGES_MODULE);
  if (s instanceof Response) return s;
  const pages = await s.sf.pagesList(s.shop);
  return c.json({ pages: pages.map((p) => pageSummary(s, p)) });
});

/** ページ 1 つ（本文の書式と HTML） */
contentApi.get("/shops/:shop/pages/:handle", async (c: Ctx) => {
  const handle = param(c, "handle");
  if (!pageHandleOk(handle)) return c.json({ error: "not_found" }, 404);
  const s = await scope(c, PAGES_MODULE);
  if (s instanceof Response) return s;
  const page = await s.sf.pageByHandle(s.shop, handle);
  if (!page) {
    // 会員限定のページ（0100）: ゲストには「会員の方だけ」（存在も隠すページ・合わない会員は 404）
    if (!c.req.header("authorization") && (await s.sf.contentGate(s.shop, "page", handle))) return c.json({ error: "members_only" }, 403);
    return c.json({ error: "not_found" }, 404);
  }
  // 部品のページ（0122）は単独では返さない（差し込んだ本文に入る）
  if (page.is_part) return c.json({ error: "not_found" }, 404);
  const v = await viewBody(c, s, page, pagePublishedAt(page));
  if (v instanceof Response) return v;
  return c.json({ page: { ...pageSummary(s, page), body: v.body, html: v.html } });
});

function blogSummary(s: Scope, b: BlogRow) {
  const url = `${s.home}/blogs/${encodeURIComponent(b.handle)}`;
  // article_order: 記事の並び順（0116。前の DB は new）、feed_url: フィードを出さないブログは null
  return { handle: b.handle, title: b.title, description: b.description, url, nav: b.nav, sort_order: b.sort_order, article_order: b.article_order ?? "new", ...(typeof b.article_from_today === "boolean" ? { article_from_today: b.article_from_today } : {}), feed_url: blogHasFeed(b) ? `${url}/feed.atom` : null, ...(articleFieldsReady(b) ? { article_fields: articleFieldDefs(b).map(({ key, label, type, options, multiple }) => ({ key, label, type, ...(options ? { options } : {}), ...(multiple ? { multiple } : {}) })) } : {}), seo_title: b.seo_title, seo_description: b.seo_description, updated_at: b.updated_at };
}

function articleSummaryJson(s: Scope, blog: BlogRow, a: ArticleRow) {
  return {
    handle: a.handle,
    title: a.title,
    url: `${s.home}/blogs/${encodeURIComponent(blog.handle)}/${encodeURIComponent(a.handle)}`,
    excerpt: a.excerpt,
    /** 抜粋が無ければ本文の初め（書式の記号を外したもの） */
    summary: articleSummary(a),
    tags: a.tags,
    image_url: absImage(s, a.image_url),
    author: a.author,
    // 記事の項目（0117）: 商品・記事は URL の名前、店舗は id
    ...(a.fields ? { fields: a.fields } : {}),
    published_at: a.published_at ?? a.updated_at,
    updated_at: a.updated_at,
  };
}

/** ブログの一覧（並び順） */
contentApi.get("/shops/:shop/blogs", async (c: Ctx) => {
  const s = await scope(c, BLOG_MODULE);
  if (s instanceof Response) return s;
  const blogs = await s.sf.blogsList(s.shop);
  return c.json({ blogs: blogs.map((b) => blogSummary(s, b)) });
});

/** ブログの記事の一覧（公開した日時の新しい順に 12 本ずつ。?page=・?tag=。深さは 1,200 本まで） */
contentApi.get("/shops/:shop/blogs/:blog/articles", async (c: Ctx) => {
  const handle = param(c, "blog");
  if (!blogHandleOk(handle)) return c.json({ error: "not_found" }, 404);
  const s = await scope(c, BLOG_MODULE);
  if (s instanceof Response) return s;
  const blog = await s.sf.blogByHandle(s.shop, handle);
  if (!blog) return c.json({ error: "not_found" }, 404);
  const tagRaw = (c.req.query("tag") ?? "").trim();
  const tag = tagRaw && tagRaw.length <= 50 ? tagRaw : null;
  const pageNo = Math.max(1, Math.min(Math.floor(ARTICLES_OFFSET_MAX / ARTICLES_PER_PAGE) + 1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1));
  const { items, hasNext } = await s.sf.articlesPage(s.shop, blog.id, { offset: (pageNo - 1) * ARTICLES_PER_PAGE, limit: ARTICLES_PER_PAGE, tag, sort: articleSortFor(blog), fieldSort: blogFieldSort(blog), withFields: articleFieldsReady(blog) });
  return c.json({ blog: blogSummary(s, blog), articles: items.map((a) => articleSummaryJson(s, blog, a)), page: pageNo, per_page: ARTICLES_PER_PAGE, has_next: hasNext && pageNo * ARTICLES_PER_PAGE <= ARTICLES_OFFSET_MAX });
});

/** 記事 1 つ（本文の書式と HTML） */
contentApi.get("/shops/:shop/blogs/:blog/articles/:article", async (c: Ctx) => {
  const handle = param(c, "blog");
  const ah = param(c, "article");
  if (!blogHandleOk(handle) || !articleHandleOk(ah)) return c.json({ error: "not_found" }, 404);
  const s = await scope(c, BLOG_MODULE);
  if (s instanceof Response) return s;
  const blog = await s.sf.blogByHandle(s.shop, handle);
  if (!blog) return c.json({ error: "not_found" }, 404);
  const article = await s.sf.articleByHandle(s.shop, blog.id, ah);
  if (!article) {
    // 会員限定の記事（0100）: ゲストには「会員の方だけ」（存在も隠す記事・合わない会員は 404）
    if (!c.req.header("authorization") && (await s.sf.contentGate(s.shop, "article", ah, blog.id))) return c.json({ error: "members_only" }, 403);
    return c.json({ error: "not_found" }, 404);
  }
  const v = await viewBody(c, s, article, article.published_at ?? article.updated_at);
  if (v instanceof Response) return v;
  return c.json({ blog: blogSummary(s, blog), article: { ...articleSummaryJson(s, blog, article), seo_title: article.seo_title, seo_description: article.seo_description, template_suffix: article.template_suffix, body: v.body, html: v.html } });
});
