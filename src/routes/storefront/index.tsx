import { Hono } from "hono";
import { CARE_MODULE, productCareView } from "../../care-labels/care";
import { optionSwatchesOf } from "../../products/option-swatches";
import { optionNamesOf } from "../../products/option-names";
import { blockedTarget, storefrontSettings } from "../../storefront/mode";
import { recordShopEvent, type ShopEvent, type ShopEventItem } from "../../storefront/events";
import { injectHead, renderHeadTags } from "../../storefront/head";
import { STOREFRONT_HEAD_CONTRIBUTORS } from "../../modules/head";
import { FAVORITES_MODULE } from "../../modules/favorites";
import { EVENT_RELAY_MODULE, VISITOR_RE } from "../../modules/event-relay/relay";
import { DIALOGS_MODULE } from "../../modules/dialogs/dialogs";
import { acceptRelay } from "../../modules/event-relay/routes";
import { openSession as openMemberSession } from "../../members/auth";
import type { AppEnv } from "../../app";
import { PRODUCT_SEARCH_MIN_CHARS, type StorefrontData, type PublicShop, type ProductDetail, type ProductListPage, type ProductSort } from "../../storefront/data";
import type { CategoryRow } from "../../db/types";
import { categoryUrl, listUrl, productUrl, productsUrl, shopHome, shopOrigin } from "../../storefront/urls";
import { hostShop, onShopDomain, redirectToShopDomain, storefrontData } from "./domain";
import { addCoupon, addItem, cartCookieHeader, cartCookieName, changeQty, openCart, removeCoupon, sealCart, setQty, type Cart } from "../../cart/cart";
import { addsFrom, changeFrom, updatesFrom, usesLinePosition } from "../../cart/shopify-form";
import { cartObject } from "../../themes/liquid/objects";
import { openJson, readCookie } from "../../util/signed";
import { categoryPath, categoryTree } from "../../products/categories";
import { productFields, publicAttributes } from "../../products/fields";
import { resolveTheme } from "../../themes";
import type { CartLine, ThemeContext } from "../../themes/types";
import { t, tf, type MessageKey } from "../../i18n";
import { clientIpFor, csrfGuard, formFields, isSecureRequest, mediaBaseUrl, param, publicBaseUrl, readBodyLimited, type Ctx } from "../common";
import { fillAppBlocks, fillArticleBlocks, fillProductBlocks } from "../../pages/blocks";
import { bodyBlocks, type BodyBlocksDeps } from "../../content/body-blocks";
import { ARTICLE_FIELDS_CSS, articleFieldParts, usedFieldParts } from "../../content/article-fields";
import { articleFieldsReady, blogFieldSort } from "../../blog/fields";
import { fillDateBlocks, fillShopBlocks } from "../../pages/shop-blocks";
import { memberReader, previewBody, shopAudiences, storefrontQueryContext, viewerBody } from "../audience-render";
import { AUDIENCES_MODULE, GUEST, queryParamsOf, type AudienceContext } from "../../members/audience";
import { ARTICLES_OFFSET_MAX, ARTICLES_PER_PAGE, BLOG_MODULE, FEED_ARTICLES, articleHandleOk, articleSortFor, articleSummary, atomFeed, blogHandleOk, blogHasFeed, blogPath, type ArticleRow, type BlogRow } from "../../blog";
import { couponSource, placeOrderDeps, privilegedFor } from "../payment-deps";
import { normalizeCode } from "../../commerce/discounts";
import { ipHash } from "../../members/auth";
import type { AddressFormValues } from "../../themes/types";
import { ADDRESS_FIELDS, returnOrigins, PREFECTURES, couponNotice, createQuote, discountCart, isProvider, openQuote, paymentSetup, placeOrder, reserveLimits, priceCart, providerAvailable, recheckQuote, shippingSummary, type Confirmation, type PaymentSetup, type Provider, openStatusToken, sealStatusToken, withQueryParam, consentCollected } from "../../commerce/checkout";
import { bindScope, customerCookieName, customerPrefill, customerSession, members, membersEnabled, rememberOrderAfterLogin } from "./members";
import { orderLink, orderNumberParam, orderPageUrl } from "../../orders/lookup";
import { guestOrderLookup } from "../order-lookup";
import { liveLegalUrl, type LegalKind } from "../../storefront/legal-links";
import { PAGES_MODULE, pageBodyHtml, pageHandleOk, pagePublishedAt, type PageRow } from "../../pages";
import { markdownToHtml } from "../../pages/markdown";
import { audienceShow } from "../../content/audience-blocks";
import { contentPreviewFrameOrigin, openContentPreview } from "../../content/preview-ticket";
import { BLOG_PARTS_CSS, CURRENT_CSS, PRODUCT_PARTS_CSS, articleParts, blogLayoutId, collectionLayoutId, composeLayout, fillCurrent, legalLayoutId, legalParts, pageLayoutsOf, pageParts, productLayoutId, usesPart } from "../../content/layouts";
import { categoryImageOf, categoryMetaDescription } from "../../products/category-media";
import { BLOG_LIST_PARTS, COLLECTION_PARTS, LEGAL_PARTS, PRODUCT_LAYOUT_PARTS } from "../../pages/shop-blocks";
import { blogListParts, listParts, productView } from "../../themes/default";
import { escapeHtml } from "../../mail/html";
import { bindInquiryScope, inquiries } from "./inquiries";
import { cartImagesFor, cartSections, blogPartValues, collectionPartValues, liquidProductJsonLd, liquidThemeFor, productPartValues, themeLayoutParts, registerThemeAssets, renderCart, renderCheckoutAddress, renderCheckoutConfirm, renderCheckoutDone, renderArticlePage, renderBlogPage, renderContentPage, renderLegalPage, renderListing, renderNotFound, renderProduct, renderTryon } from "./liquid";
import { listSortOf } from "../../storefront/list-sort";
import { INQUIRIES_MODULE, inquiriesReady, sealOrderToken } from "../../modules/inquiries";
import { moduleEnabled } from "../../modules/registry";
import { FEED_MODULE, readFeed } from "../../modules/product-feed/job";
import { RECEIPT_MODULE, RECEIPT_STATUSES, receiptSettings, renderReceipt, type ReceiptOrder } from "../../modules/receipt/render";
import { dateLabel, deliveryOptions } from "../../modules/delivery-time";
import { TRYON_MODULE, checkTryon, storeView, todayHere, tryonSettings, visitDates } from "../../modules/store-tryon";
import { PrivilegedRpcError } from "../../db/privileged";

/**
 * ストアフロント（Hono SSR）。anon キーで PostgREST を読む（RLS: published のみ）。
 *   /                       公開ショップ一覧（1件なら転送）
 *   /:shop                  お店のトップ（ひな形が無ければすべての商品）
 *   /:shop/products         すべての商品（?tag= ?q= ?after=）
 *   /:shop/products/:product 商品詳細
 *   /:shop/categories/:category カテゴリーの一覧（?tag= ?q= ?after=）
 *   /:shop/cart             カート（署名付き Cookie）。/:shop/buy は購入リンク、/:shop/cart/load は API のカートを読み込む
 *   /:shop/legal|privacy|returns  法務ページ
 *   /:shop/pages/:handle  ショップのページ（同梱モジュール pages）
 *   /:shop/blogs/:blog    ブログの記事の一覧・/:shop/blogs/:blog/:article 記事・/:shop/blogs/:blog/feed.atom（同梱モジュール blog）
 *   /:shop/checkout         決済手段を選ぶ → 配送先入力 → /:shop/checkout/:provider で最終確認 → 在庫予約と決済ページへ転送
 *   /:shop/shipping, /:shop/orders/lookup  送料案内、注文照会
 */
export const storefront = new Hono<AppEnv>();

// ページ・記事のプレビュー（POST /<ショップ>/_preview/content）だけは管理画面のオリジンから届く。状態を変えず、券で確かめる
const PREVIEW_PATH = /^\/[^/]+\/_preview\/content$/;
storefront.use("*", (c, next) => (c.req.method === "POST" && PREVIEW_PATH.test(c.req.path) ? next() : csrfGuard(c, next)));
storefront.use("*", redirectToShopDomain);

const data = storefrontData;

/**
 * お店の画面の使い方（0041、src/storefront/mode.ts）と、同梱モジュールの <head> の口（src/storefront/head.ts）。
 * キャッシュ済みのショップ行だけで判定する（このために DB に問い合わせない）。
 *  - 使わない画面: GET は外のサイトへ 302、それ以外は 404
 *  - <head>: ON の同梱モジュールが返す決まった形のタグを、HTML の応答の </head> の前に入れる（ルートが積んだ出来事を渡す）
 */
function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

storefront.use("*", async (c, next) => {
  const m = /^\/([^/]+)(\/.*)?$/.exec(c.req.path);
  const sf = m && !m[1]!.startsWith("_") && !m[1]!.includes(".") ? data(c) : null;
  // 壊れたパーセント符号（/%E0%A4%A）で 500 にしない: 直せなければショップ無しとして次へ
  const slug = sf ? safeDecode(m![1]!) : null;
  const shop = sf && slug !== null ? await sf.shopBySlug(slug).catch(() => null) : null;
  if (!shop) return next();
  const target = blockedTarget(storefrontSettings(shop.settings), m![2] ?? "");
  if (target) {
    if (target === "not_found" || (c.req.method !== "GET" && c.req.method !== "HEAD")) return notFound(c);
    return c.redirect(target, 302);
  }
  await next();
  const contributors = STOREFRONT_HEAD_CONTRIBUTORS.filter((h) => moduleEnabled(shop.settings, h.module));
  // プレビュー（保存しない下書き）には分析のタグなどを入れない
  if (contributors.length === 0 || PREVIEW_PATH.test(c.req.path) || !(c.res.headers.get("content-type") ?? "").startsWith("text/html")) return;
  const events = c.get("shopEvents") ?? [];
  // 会員かどうか（お店の行動の中継・ダイアログの「だれに」）。要るモジュールが ON のときだけ確かめる
  const dialogsOn = contributors.some((h) => h.module === DIALOGS_MODULE) && (shop.dialogs ?? []).length > 0;
  const session = dialogsOn || contributors.some((h) => h.module === EVENT_RELAY_MODULE || h.module === FAVORITES_MODULE) ? await customerSession(c, { shop }).catch(() => null) : null;
  const member = Boolean(session);
  // 会員の条件のダイアログ（0110）があるときだけ条件の一覧を引く（キャッシュ済み）
  const audienceOk = dialogsOn && (shop.dialogs ?? []).some((d) => d.audience === "audience") ? audienceShow(await shopAudiences(c, shop), { ...(session ? { member: true, attrs: session.at ?? {} } : GUEST), params: queryParamsOf(new URL(c.req.url).searchParams.entries()) }) : undefined;
  const url = new URL(c.req.url);
  const extra = { member, base: onShopDomain(c, shop) ? "" : `/${shop.slug}`, path: m![2] ?? "", search: url.search, ...(audienceOk ? { audienceOk } : {}) };
  const snippet = renderHeadTags(contributors.flatMap((h) => h.tags(shop, events, extra)));
  if (!snippet) return;
  const html = await c.res.text();
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  c.res = new Response(injectHead(html, snippet), { status: c.res.status, headers });
});

interface ShopScope {
  shop: PublicShop;
  sf: StorefrontData;
  cart: Cart;
  ctx: ThemeContext;
  theme: ReturnType<typeof resolveTheme>;
  /** URL のクエリと覚えた値（同梱モジュール audiences。見せる相手の囲みの判定に使う） */
  query: Pick<AudienceContext, "params" | "remembered">;
}

async function scope(c: Ctx): Promise<ShopScope | null> {
  const sf = data(c);
  if (!sf) return null;
  const slug = param(c, "shop");
  const shop = await sf.shopBySlug(slug);
  if (!shop) return null;
  const secret = c.get("sessionSecret");
  const cart = secret ? await openCart(secret, readCookie(c.req.header("cookie"), cartCookieName(shop.id))) : { items: [] };
  // 独自ドメインの上ではショップがドメインのトップ（パスにスラッグを付けない）
  const onDomain = onShopDomain(c, shop);
  const ctx: ThemeContext = {
    shop,
    shopPath: onDomain ? "" : `/${shop.slug}`,
    mediaBaseUrl: mediaBaseUrl(c),
    cartCount: cart.items.reduce((n, i) => n + i.qty, 0),
    membersEnabled: membersEnabled(shop),
    publicBaseUrl: onDomain ? shopOrigin(publicBaseUrl(c), shop) : publicBaseUrl(c),
    themeSettings: (shop.settings ?? {})["theme_settings"] && typeof (shop.settings ?? {})["theme_settings"] === "object" ? ((shop.settings ?? {})["theme_settings"] as Record<string, unknown>) : {},
  };
  const theme = resolveTheme(shop.settings ?? {});
  // お問い合わせのリンク（同梱モジュール inquiries）。キャッシュ済みのショップ行だけで判定する（版の確認は画面を開いたときだけ）
  if (moduleEnabled(shop.settings, INQUIRIES_MODULE) && theme.InquiryPage) ctx.inquiries = true;
  let reader = sf;
  if (ctx.membersEnabled) {
    const member = await customerSession(c, { shop });
    ctx.member = member ? { email: member.email, attrs: member.at ?? {} } : null;
    // 会員限定の商品（0098）: 同梱モジュール audiences が ON のショップでは、ログイン中の会員の一覧・詳細・カートを会員の読み取りの経路で
    if (member?.sid && moduleEnabled(shop.settings, AUDIENCES_MODULE)) {
      const r = memberReader(c, shop.id, { cid: member.cid, ep: member.ep, sid: member.sid });
      if (r) reader = sf.withMember(r);
    }
  }
  const query = await storefrontQueryContext(c, shop, ctx.shopPath || "/");
  return { shop, sf: reader, cart, ctx, theme, query };
}

/**
 * ページ・記事のプレビュー（保存しない下書き。src/content/preview-ticket.ts）。管理画面の新しいタブから送られ、本物と同じ処理・同じテーマ
 * （Liquid のテーマを含む）で描く。券がそのショップのその下書きのものでなければ 404。何も書き換えない。
 * 管理画面のオリジンから送るので、このパスだけ csrfGuard を通さない（状態を変えず、券が下書きと結ばれている）。
 * 会員・お問い合わせのルート（それぞれ全パスに csrfGuard を付ける）より先に置く。
 * 見せる相手の囲み（0097）は中身ごと出す（運営者が確かめるため）
 */
/**
 * プレビューは編集のたびに描き直すので、読んでいた位置を残す（同じタブ・同じ枠の中だけ。保存できなければ何もしない）
 */
const PREVIEW_SCROLL_SCRIPT = `<script>(function(){try{var k="banto-preview-scroll",s=window.sessionStorage,y=+(s.getItem(k)||0);if(y){window.scrollTo(0,y);window.addEventListener("load",function(){window.scrollTo(0,y)})}window.addEventListener("scroll",function(){s.setItem(k,String(Math.round(window.scrollY)))},{passive:true})}catch(e){}})();</script>`;

storefront.post("/:shop/_preview/content", async (c: Ctx) => {
  const secret = c.get("sessionSecret");
  const s = secret ? await scope(c) : null;
  if (!s || !secret) return notFound(c);
  const f = await formFields(c);
  const draft = await openContentPreview(secret, f["token"], s.shop.id, f["draft"]);
  if (!draft) return notFound(c);
  c.header("Cache-Control", "private, no-store");
  c.header("X-Robots-Tag", "noindex");
  c.header("Referrer-Policy", "no-referrer");
  // 編集の画面の「お店の見た目」の欄（frame=1）: 券に結んだ管理画面のオリジンの枠にだけ入れてよい
  if (f["frame"] === "1") {
    const origin = await contentPreviewFrameOrigin(secret, f["token"]);
    if (origin) c.header("Content-Security-Policy", `frame-ancestors 'self' ${origin}`);
  }
  const prefix = PREVIEW_SCROLL_SCRIPT + `<p class="banto-preview-note" style="padding:.5rem .75rem;border:1px dashed currentColor;border-radius:.4rem;opacity:.85">${escapeHtml(t("pages.preview_theme_note"))}</p>`;
  const categories = await s.sf.listCategories(s.shop);
  if (draft.kind === "page") {
    if (!moduleEnabled(s.shop.settings, PAGES_MODULE)) return notFoundPage(c, s);
    // ひな形に割り当てたページ（0101・0102）なら、見本の記事・商品で描く（今の記事・商品の部品の中身が見えるように）
    const sample = await templateSample(s, draft.page.id, categories);
    const note = (what: string) => PREVIEW_SCROLL_SCRIPT + `<p class="banto-preview-note" style="padding:.5rem .75rem;border:1px dashed currentColor;border-radius:.4rem;opacity:.85">${escapeHtml(t("pages.preview_theme_note"))} ${escapeHtml(tf("pages.preview_sample", { name: what }))}</p>`;
    if (sample?.kind === "article") {
      const body = (await previewBody(s.sf, s.shop, sample.article.body)).body;
      return articlePageResponse(c, s, sample.blog, sample.article, body, markdownToHtml(body, { mediaBase: s.ctx.mediaBaseUrl }), categories, { prefix: note(sample.article.title), preview: true, layout: draft.page });
    }
    if (sample?.kind === "product") return productPageResponse(c, s, sample.detail, categories, { prefix: note(sample.detail.product.name), preview: true, layout: draft.page });
    if (sample?.kind === "blog") return blogListResponse(c, s, sample.blog, { tag: null, pageNo: 1 }, categories, { prefix: note(sample.blog.title), preview: true, layout: draft.page });
    if (sample?.kind === "legal") return legalResponse(c, s, sample.legal, { prefix: note(legalPages[sample.legal]!.title()), preview: true, layout: draft.page });
    if (sample?.kind === "collection") {
      const list = await listingData(s, { categories, ...(sample.category ? { category: sample.category } : {}), top: false, count: Boolean(await liquidThemeFor(c, s)) });
      if (list) return collectionResponse(c, s, list, { prefix: note(sample.category ? sample.category.name : t("store.all_products")), preview: true, layout: draft.page });
    }
    const body = (await previewBody(s.sf, s.shop, draft.page.body)).body;
    return contentPageResponse(c, s, draft.page, body, markdownToHtml(body, { mediaBase: s.ctx.mediaBaseUrl }), categories, { prefix, preview: true });
  }
  if (!moduleEnabled(s.shop.settings, BLOG_MODULE)) return notFoundPage(c, s);
  const body = (await previewBody(s.sf, s.shop, draft.article.body)).body;
  return articlePageResponse(c, s, draft.blog, draft.article, body, markdownToHtml(body, { mediaBase: s.ctx.mediaBaseUrl }), categories, { prefix, preview: true });
});


/**
 * ひな形のプレビューの見本（0101・0102）: そのページを記事のひな形にしているブログのいちばん新しい記事、
 * 商品詳細のひな形なら割り当てたカテゴリー（無ければショップ全体）の最初の商品。どれにも割り当てていなければ null
 */
async function templateSample(s: ShopScope, pageId: string, categories: CategoryRow[]): Promise<{ kind: "article"; blog: BlogRow; article: ArticleRow } | { kind: "product"; detail: ProductDetail } | { kind: "collection"; category: CategoryRow | null } | { kind: "legal"; legal: LegalKind } | { kind: "blog"; blog: BlogRow } | null> {
  const l = pageLayoutsOf(s.shop.settings);
  // ブログの一覧のひな形（0114）: 割り当てたブログの一覧の 1 ページ目
  const listBlogId = Object.entries(l.blogs).find(([, p]) => p === pageId)?.[0];
  if (listBlogId && moduleEnabled(s.shop.settings, BLOG_MODULE)) {
    const blog = await s.sf.blogById(s.shop, listBlogId);
    if (blog) return { kind: "blog", blog };
  }
  const blogId = Object.entries(l.articles).find(([, p]) => p === pageId)?.[0];
  if (blogId && moduleEnabled(s.shop.settings, BLOG_MODULE)) {
    const blog = await s.sf.blogById(s.shop, blogId);
    const article = blog ? (await s.sf.articlesPage(s.shop, blog.id, { offset: 0, limit: 1, sort: articleSortFor(blog), withFields: articleFieldsReady(blog) })).items[0] : undefined;
    if (blog && article) return { kind: "article", blog, article };
  }
  const catId = Object.entries(l.productCategories).find(([, p]) => p === pageId)?.[0];
  if (catId || l.product === pageId) {
    const cat = catId ? categories.find((x) => x.id === catId) : undefined;
    const list = await s.sf.productPage(s.shop, { ...(cat ? { category: cat.slug } : {}), limit: 1 }, categories);
    const first = list?.items[0];
    const detail = first ? await s.sf.productBySlug(s.shop, first.product.slug) : null;
    if (detail) return { kind: "product", detail };
  }
  // 商品一覧のひな形（0103）: 割り当てたカテゴリーの一覧、共通のものならすべての一覧
  const colCat = Object.entries(l.collectionCategories).find(([, p]) => p === pageId)?.[0];
  if (colCat) return { kind: "collection", category: categories.find((x) => x.id === colCat) ?? null };
  if (l.collection === pageId) return { kind: "collection", category: null };
  // 法務のページ（0104）: 上書きしたページ、共通のものなら特商法の表記
  const legalKind = Object.entries(l.legalPages).find(([, p]) => p === pageId)?.[0];
  if (legalKind) return { kind: "legal", legal: legalKind as LegalKind };
  if (l.legal === pageId) return { kind: "legal", legal: "legal" };
  return null;
}

// 会員ルートは別モジュール。ショップの解決だけこちらのものを貸す
bindScope(async (c) => {
  const s = await scope(c);
  if (!s) return null;
  const session = await customerSession(c, { shop: s.shop });
  return { shop: s.shop, theme: s.theme, shopPath: s.ctx.shopPath, session, ...(s.ctx.inquiries ? { inquiries: true } : {}) };
});
storefront.route("/", members);
// お問い合わせ（同梱モジュール inquiries）も同じくショップの解決を借りる
bindInquiryScope(async (c) => {
  const s = await scope(c);
  return s ? { shop: s.shop, sf: s.sf, ctx: s.ctx, theme: s.theme } : null;
});
storefront.route("/", inquiries);

async function writeCart(c: Ctx, s: ShopScope, cart: Cart): Promise<void> {
  const secret = c.get("sessionSecret");
  if (!secret) return;
  c.header("Set-Cookie", cartCookieHeader(cartCookieName(s.shop.id), await sealCart(secret, cart), { path: s.ctx.shopPath || "/", secure: isSecureRequest(c) }), {
    append: true,
  });
}

/** お店の画面で起きた出来事を積む（src/storefront/events.ts。受け取るモジュールが ON のときだけ外に出る。個人情報は入れない） */
function track(c: Ctx, type: ShopEvent["type"], value: number, items: ShopEventItem[], orderNumber?: number) {
  recordShopEvent(c, { type, value_jpy: value, items, ...(orderNumber !== undefined ? { order_number: orderNumber } : {}) });
}
/** 最後に積んだ product_view に商品の ID・カテゴリー・タグを足す（0107。外部プラグインの条件に使う） */
function attachProduct(c: Ctx, product: NonNullable<ShopEvent["product"]>) {
  const list = c.get("shopEvents") ?? [];
  const last = list[list.length - 1];
  if (last?.type === "product_view") last.product = product;
}
const cartItems = (lines: CartLine[]): ShopEventItem[] =>
  lines.map((l) => ({ sku: l.sku.code, name: l.product.name, ...(l.sku.name ? { variant: l.sku.name } : {}), price: l.sku.price_jpy, quantity: l.qty }));

function notFound(c: Ctx, s?: ShopScope) {
  const theme = s?.theme ?? resolveTheme({});
  return c.html(theme.NotFound({ ctx: s?.ctx }), 404);
}

/** 一覧・商品のページの「見つかりません」。Liquid のテーマがあればその 404 で（docs/themes.md） */
async function notFoundPage(c: Ctx, s: ShopScope) {
  const lt = await liquidThemeFor(c, s);
  // テーマの 404 にもメニュー（カテゴリーの木）を出す。カテゴリーはキャッシュ済みなら往復なし
  return (lt && renderNotFound(c, s, lt, await s.sf.listCategories(s.shop).catch(() => []))) || notFound(c, s);
}

// テーマの資産（ショップのドメインでだけ。src/routes/storefront/liquid.ts）
registerThemeAssets(storefront, scope);

// ---------- robots / sitemap ----------
// 独自ドメインの上ではそのショップだけ。Banto の URL では独自ドメインの無いショップだけ（サイトマップに別のホストを載せない）
storefront.get("/robots.txt", async (c: Ctx) => {
  const own = await hostShop(c);
  if (own) {
    const origin = shopOrigin(publicBaseUrl(c), own);
    return c.text(`User-agent: *\nDisallow: /admin\nDisallow: /api/v1\nDisallow: /mcp\nDisallow: /cart\nDisallow: /checkout\nDisallow: /account\nSitemap: ${origin}/sitemap.xml\n`);
  }
  return c.text(`User-agent: *\nDisallow: /admin\nDisallow: /api/v1\nDisallow: /mcp\nDisallow: /*/cart\nDisallow: /*/checkout\nDisallow: /*/account\nSitemap: ${publicBaseUrl(c)}/sitemap.xml\n`);
});

/** サイトマップの商品のファイル 1 つの URL の数（0060） */
const SITEMAP_PRODUCTS_PER_FILE = 10000;

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const xmlResponse = (c: Ctx, body: string) => c.body(body, 200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=600" });
const urlset = (urls: string[]) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;

/** サイトマップに載せるショップ（独自ドメインの上ではそのショップだけ。Banto の URL では独自ドメインの無いショップだけ）と、お店のトップ */
async function sitemapShops(c: Ctx, sf: StorefrontData): Promise<{ shop: PublicShop; home: string; own: boolean }[]> {
  const base = publicBaseUrl(c);
  const own = await hostShop(c);
  const shops = own ? [own] : (await sf.listShops()).filter((shop) => !shop.domain);
  return shops.filter((shop) => storefrontSettings(shop.settings).mode !== "off").map((shop) => ({ shop, home: shopHome(base, shop), own: Boolean(own) }));
}

/** トップ（お店の画面を使うショップだけ）と法務・送料のページ。カートと購入だけ使うショップは法務のページだけ（商品は外のサイトのもの） */
function pageUrls(entries: { shop: PublicShop; home: string; own: boolean }[]): string[] {
  const urls: string[] = [];
  for (const { shop, home, own } of entries) {
    if (storefrontSettings(shop.settings).mode === "full") urls.push(own ? `${home}/` : home);
    for (const page of ["legal", "privacy", "returns", "shipping"]) urls.push(`${home}/${page}`);
  }
  return urls;
}

/**
 * 索引（sitemapindex、0060）: ページのファイル 1 つと、ショップごとの商品のファイル（10,000 件ずつ）。
 */
storefront.get("/sitemap.xml", async (c: Ctx) => {
  const sf = data(c);
  if (!sf) return c.notFound();
  const entries = await sitemapShops(c, sf);
  const own = await hostShop(c);
  const files = [own ? `${shopOrigin(publicBaseUrl(c), own)}/sitemap-pages.xml` : `${publicBaseUrl(c)}/sitemap-pages.xml`];
  for (const { shop, home } of entries) {
    if (storefrontSettings(shop.settings).mode !== "full") continue;
    const n = Math.ceil((await sf.productCount(shop)) / SITEMAP_PRODUCTS_PER_FILE);
    for (let i = 1; i <= n; i++) files.push(`${home}/sitemap-products-${i}.xml`);
  }
  return xmlResponse(c, `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${files.map((u) => `  <sitemap><loc>${xmlEsc(u)}</loc></sitemap>`).join("\n")}\n</sitemapindex>\n`);
});

storefront.get("/sitemap-pages.xml", async (c: Ctx) => {
  const sf = data(c);
  if (!sf) return c.notFound();
  const entries = await sitemapShops(c, sf);
  const urls = pageUrls(entries);
  // すべての商品とカテゴリーの一覧（お店の画面を使うショップだけ。カテゴリーはキャッシュ済みなら往復なし）
  for (const { shop, home } of entries) {
    if (storefrontSettings(shop.settings).mode !== "full") continue;
    urls.push(productsUrl(home));
    for (const cat of await sf.listCategories(shop)) urls.push(categoryUrl(home, cat.slug));
  }
  // ショップのページ（同梱モジュール pages、0079）。お店の画面を使うショップで、モジュールが ON のものだけ問い合わせる
  for (const { shop, home } of entries) {
    if (storefrontSettings(shop.settings).mode !== "full" || !moduleEnabled(shop.settings, PAGES_MODULE)) continue;
    for (const pg of await sf.pageHandles(shop)) urls.push(`${home}/pages/${encodeURIComponent(pg.handle)}`);
  }
  // ブログと記事（同梱モジュール blog、0081）
  for (const { shop, home } of entries) {
    if (storefrontSettings(shop.settings).mode !== "full" || !moduleEnabled(shop.settings, BLOG_MODULE)) continue;
    const { blogs, articles } = await sf.blogSitemap(shop);
    const handleOf = new Map(blogs.map((b) => [b.id, b.handle]));
    for (const b of blogs) urls.push(`${home}/blogs/${encodeURIComponent(b.handle)}`);
    for (const a of articles) {
      const bh = handleOf.get(a.blog_id);
      if (bh) urls.push(`${home}/blogs/${encodeURIComponent(bh)}/${encodeURIComponent(a.handle)}`);
    }
  }
  return xmlResponse(c, urlset(urls.map((u) => `  <url><loc>${xmlEsc(u)}</loc></url>`)));
});

storefront.get("/:shop/:file{sitemap-products-[0-9]{1,4}\\.xml}", async (c: Ctx) => {
  const sf = data(c);
  const shop = sf ? await sf.shopBySlug(param(c, "shop")) : null;
  if (!sf || !shop || storefrontSettings(shop.settings).mode !== "full") return c.notFound();
  const n = Number(/([0-9]+)/.exec(param(c, "file"))![1]);
  if (n < 1) return c.notFound();
  const rows = await sf.productSlugs(shop, (n - 1) * SITEMAP_PRODUCTS_PER_FILE, SITEMAP_PRODUCTS_PER_FILE);
  if (rows.length === 0) return c.notFound();
  const home = shopHome(publicBaseUrl(c), shop);
  return xmlResponse(c, urlset(rows.map(([slug, updated]) => `  <url><loc>${xmlEsc(productUrl(home, slug))}</loc><lastmod>${xmlEsc(updated.slice(0, 10))}</lastmod></url>`)));
});

// ---------- 一覧 ----------
storefront.get("/", async (c: Ctx) => {
  const sf = data(c);
  if (!sf) return c.redirect("/admin/setup");
  const shops = await sf.listShops();
  if (shops.length === 1) return c.redirect(`/${shops[0]!.slug}`);
  return c.html(resolveTheme({}).ShopIndex({ shops }));
});

/** お店の画面の一覧の 1 ページの数 */
const STORE_PAGE_SIZE = 48;

storefront.get("/:shop", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  // お店のトップのひな形（0101）。見えないページ（非公開・会員限定）なら、すべての商品の一覧をトップとして出す
  const homeId = moduleEnabled(s.shop.settings, PAGES_MODULE) ? pageLayoutsOf(s.shop.settings).home : null;
  const home = homeId ? await s.sf.layoutPage(s.shop, homeId) : null;
  if (home) {
    const categories = await s.sf.listCategories(s.shop);
    const view = await viewerBody(c, s.sf, s.shop, home.body, viewerOf(s));
    const raw = pageBodyHtml({ ...home, body: view.body }, s.ctx.mediaBaseUrl, undefined, view.key);
    return contentPageResponse(c, s, { ...home, seo_title: home.seo_title || s.shop.name }, view.body, raw, categories, { layoutPath: "" });
  }
  return listResponse(c, s, { top: true });
});

/** すべての商品（/products）。?tag= ?q= ?after= で絞る・探す・ページを送る */
storefront.get("/:shop/products", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  return listResponse(c, s, listQueryOf(c));
});

/** カテゴリーの一覧（/categories/<カテゴリー>、子のカテゴリーの商品も含む）。?tag= ?q= ?after= も付けられる */
storefront.get("/:shop/categories/:category", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  return listResponse(c, s, { ...listQueryOf(c), category: param(c, "category") });
});

/** 一覧の条件（タグは 50 文字まで、検索の語は 100 文字まで。文字で数える。UTF-16 の単位で切ると絵文字の途中で切れる） */
function listQueryOf(c: Ctx): { tag?: string; q?: string; after?: string; sort?: ProductSort } {
  const tag = (c.req.query("tag") ?? "").trim().slice(0, 50);
  const q = [...(c.req.query("q") ?? "").trim()].slice(0, 100).join("");
  const after = c.req.query("after") || "";
  // 並べ方（?sort=、Shopify のテーマの ?sort_by= も読む）。既定の新しい順は持たない
  const sort = listSortOf(c.req.query("sort"), c.req.query("sort_by"));
  return { ...(tag ? { tag } : {}), ...(q ? { q } : {}), ...(after ? { after } : {}), ...(sort ? { sort } : {}) };
}

/**
 * 商品の一覧を描く（お店のトップ・すべての商品・カテゴリーの一覧、タグ・検索の語・ページ送り付き）。
 * 商品一覧のひな形（0103）はカテゴリーの一覧（近い割り当て、無ければ共通）・すべての商品・トップ（トップのひな形が無いとき）に効く。検索の語があれば今までの画面
 */
async function listResponse(c: Ctx, s: ShopScope, o: { top?: boolean; category?: string; tag?: string; q?: string; after?: string; sort?: ProductSort }): Promise<Response> {
  // カテゴリーで絞るときは、子孫まで広げるためにカテゴリーを先に読む（キャッシュ済みなら往復なし）
  const categories = await s.sf.listCategories(s.shop);
  const category = o.category ? categories.find((x) => x.slug === o.category) : undefined;
  if (o.category && !category) return notFoundPage(c, s);
  const colId = !o.q && moduleEnabled(s.shop.settings, PAGES_MODULE) ? collectionLayoutId(pageLayoutsOf(s.shop.settings), categories, category?.id) : null;
  const colLayout = colId ? await s.sf.layoutPage(s.shop, colId) : null;
  // Liquid のテーマはページの数（paginate.pages）を使うので、全体の数も数える
  const lt = await liquidThemeFor(c, s);
  const list = await listingData(s, { categories, ...(category ? { category } : {}), ...(o.tag ? { tag: o.tag } : {}), ...(o.q ? { q: o.q } : {}), ...(o.after ? { after: o.after } : {}), ...(o.sort ? { sort: o.sort } : {}), top: Boolean(o.top), count: Boolean(lt) });
  if (!list) return notFoundPage(c, s);
  if (colLayout) return collectionResponse(c, s, list, { layout: colLayout });
  const { page, facets, link } = list;
  if (lt) {
    const res = renderListing(c, s, lt, {
      page,
      categories,
      ...(category ? { category } : {}),
      ...(o.tag ? { tag: o.tag } : {}),
      ...(o.q ? { search: { q: o.q, performed: list.searchable } } : {}),
      top: Boolean(o.top),
      tags: facets.tags,
      link,
      ...(o.after ? { after: o.after } : {}),
      ...(o.sort ? { sort: o.sort } : {}),
      path: list.path,
    });
    if (res) return res;
  }
  return c.html(s.theme.ShopHome(listProps(s, list)));
}

interface ListingData {
  page: ProductListPage;
  facets: Awaited<ReturnType<StorefrontData["productFacets"]>>;
  categories: CategoryRow[];
  category?: CategoryRow;
  tag?: string;
  q?: string;
  after?: string;
  /** 並べ方（既定の new は持たない） */
  sort?: ProductSort;
  /** お店のトップ（トップのひな形が無いときに、すべての商品をトップとして出す） */
  top: boolean;
  /** 検索の語を探したか（語が短く、カテゴリー・タグでも絞っていなければ探さない） */
  searchable: boolean;
  /** ショップの中のパス（canonical。トップは ""、一覧は /products?… か /categories/<カテゴリー>?…） */
  path: string;
  /** ページ送りの URL */
  link: (cursor: string | null) => string;
}

/** 商品の一覧の材料（お店のトップ・すべての商品・カテゴリーの一覧・商品一覧のひな形のプレビューで同じ） */
async function listingData(s: ShopScope, q: { categories: CategoryRow[]; category?: CategoryRow; tag?: string; q?: string; after?: string; sort?: ProductSort; top: boolean; count: boolean }): Promise<ListingData | null> {
  // 2 文字以下の語は、カテゴリー・タグでも絞っていなければ探さない（インデックスが効かず全件を見るため。0058 の q_too_short）
  const searchable = !q.q || [...q.q].length >= PRODUCT_SEARCH_MIN_CHARS || Boolean(q.tag || q.category);
  const query = { tag: q.tag, category: q.category?.slug, ...(q.q && searchable ? { q: q.q } : {}), ...(q.sort ? { sort: q.sort } : {}), limit: STORE_PAGE_SIZE };
  const empty: ProductListPage = { items: [], total: 0, totalCapped: false, limit: STORE_PAGE_SIZE, offset: 0, nextOffset: null, nextCursor: null };
  const [page, facets] = await Promise.all([searchable ? s.sf.productPage(s.shop, query, q.categories, { cursor: q.after, ...(q.count ? { count: true } : {}) }) : Promise.resolve(empty), s.sf.productFacets(s.shop, q.categories)]);
  if (!page) return null;
  const cond = { category: q.category?.slug, tag: q.tag, q: q.q };
  // ページ送りは並べ方を保つ。canonical（path）は並べ方を外す（並べ替えただけの同じ一覧を別のページにしない）
  const link = (cursor: string | null) => listUrl(s.ctx.shopPath, { ...cond, sort: q.sort, after: cursor });
  const path = q.top && !q.after ? "" : listUrl("", cond);
  return { page, facets, categories: q.categories, ...(q.category ? { category: q.category } : {}), ...(q.tag ? { tag: q.tag } : {}), ...(q.q ? { q: q.q } : {}), ...(q.after ? { after: q.after } : {}), ...(q.sort ? { sort: q.sort } : {}), top: q.top, searchable, path, link };
}

/** 既定のテーマの一覧に渡すもの（一覧と商品一覧のひな形で同じ） */
function listProps(s: ShopScope, d: ListingData) {
  return {
    ctx: s.ctx,
    products: d.page.items,
    ...(d.tag ? { tag: d.tag } : {}),
    ...(d.q ? { q: d.q } : {}),
    ...(d.top ? { top: true } : {}),
    tags: d.facets.tags,
    categories: categoryTree(d.categories),
    ...(d.category ? { category: categoryProp(d.category) } : {}),
    path: `${s.ctx.shopPath}${d.path}` || "/",
    pagination: { ...(d.page.nextCursor ? { next: d.link(d.page.nextCursor) } : {}), ...(d.after ? { first: d.link(null) } : {}) },
    ...(d.sort ? { sort: d.sort } : {}),
    ...(d.q && !d.searchable ? { notice: t("store.search_too_short") } : d.q && d.page.items.length === 0 ? { notice: tf("store.search_none", { q: d.q }) } : {}),
  };
}

/**
 * 商品一覧をひな形（0103）で描く（お店の画面とひな形のプレビューで同じ）。部品は既定のテーマのもの（並び・ページ送り・タグ・子カテゴリー・パンくず）。
 * 並べ方・ページ送り・会員限定の出し分けは今の一覧と同じ（listingData）
 */
async function collectionResponse(c: Ctx, s: ShopScope, d: ListingData, o: RenderOpts & { layout: PageRow }): Promise<Response> {
  const layout = o.layout;
  const view = o.preview ? await previewBody(s.sf, s.shop, layout.body) : await viewerBody(c, s.sf, s.shop, layout.body, viewerOf(s));
  const raw = o.preview ? markdownToHtml(view.body, { mediaBase: s.ctx.mediaBaseUrl }) : pageBodyHtml({ ...layout, body: view.body }, s.ctx.mediaBaseUrl, undefined, view.key);
  const { blocks, cards, ablocks, acards, apps, appCards, shopCards } = await bodyProducts(s, view.body, d.categories);
  const doc = (o.prefix ?? "") + fillDateBlocks(fillShopBlocks(raw, shopCards), { published: pagePublishedAt(layout), updated: layout.updated_at });
  const props = listProps(s, d);
  const only = (parts: Record<string, string>) => Object.fromEntries(COLLECTION_PARTS.map((k) => [k, parts[k] ?? ""]));
  const lt = await liquidThemeFor(c, s);
  if (lt) {
    const parts: Record<string, string> = {};
    for (const [k, node] of Object.entries(listParts(props))) parts[k] = node === null ? "" : String(node);
    const page: PageRow = { ...layout, title: d.category ? d.category.name : t("store.all_products"), seo_title: null, seo_description: d.category ? categoryMetaDescription(d.category.description) : null, image_url: null };
    // テーマに snippets/part-<部品> があれば、その部品はテーマの見た目で（無ければ既定のまま）
    const values = collectionPartValues(c, s, { page: d.page, ...(d.category ? { category: d.category } : {}), ...(d.tag ? { tag: d.tag } : {}), tags: d.facets.tags, link: d.link, ...(d.after ? { after: d.after } : {}) });
    const themed = themeLayoutParts(c, s, lt, { body: view.body, names: COLLECTION_PARTS, defaults: only(parts), values, title: page.title, path: d.path, categories: d.categories });
    const res = renderContentPage(c, s, lt, { page, html: `<style>${CURRENT_CSS}</style>` + fillCurrent(doc, themed), categories: d.categories, blocks, cards, ablocks, acards, apps, appCards, path: d.path, ...(d.after || d.q ? { noindex: true } : {}) });
    if (res) return res;
  }
  const html = fillAppBlocks(fillArticleBlocks(fillProductBlocks(doc, cards), acards), appCards);
  return c.html(s.theme.ShopHome({ ...props, layout: (parts) => `<style>${CURRENT_CSS}</style>` + fillCurrent(html, only(parts)) }));
}

storefront.get("/:shop/products/:product", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const [detail, categories] = await Promise.all([s.sf.productBySlug(s.shop, param(c, "product")), s.sf.listCategories(s.shop)]);
  if (!detail) {
    // 会員限定の商品（0098）にゲストが来たとき: 「会員の方だけ」とログインへ（存在も隠す商品は 404。ログイン中で合わない会員も 404）
    if (!s.ctx.member && s.ctx.membersEnabled && moduleEnabled(s.shop.settings, AUDIENCES_MODULE) && (await s.sf.productGate(s.shop, param(c, "product")))) {
      const loginUrl = `${s.ctx.shopPath}/account/login`;
      c.header("Cache-Control", "private, no-store");
      return c.html(s.theme.MembersOnlyPage ? s.theme.MembersOnlyPage({ ctx: s.ctx, loginUrl }) : s.theme.LegalPage({ ctx: s.ctx, title: t("store.members_only_title"), body: t("store.members_only_login") }));
    }
    return notFoundPage(c, s);
  }
  // 品目は SKU の品番（カート・購入手続きと同じ）。商品を見たときは SKU を全部並べる
  const items = detail.skus.map((k) => ({ sku: k.code, name: detail.product.name, ...(k.name ? { variant: k.name } : {}), price: k.price_jpy }));
  const price = items.reduce<number | null>((m, k) => (m === null || k.price < m ? k.price : m), null) ?? 0;
  track(c, "product_view", price, items);
  attachProduct(c, { id: detail.product.id, category_id: detail.product.category_id ?? null, tags: (detail.product.tags ?? []).slice(0, 20) });
  // カートに入れた直後の商品ページ（?added=1&sku=…&qty=…）。どの SKU かは sku で受ける（無ければ最安の SKU）
  if (c.req.query("added") === "1") {
    const added = items.find((k) => k.sku === c.req.query("sku")) ?? items.find((k) => k.price === price);
    const qty = Math.min(999, Math.max(1, Number.parseInt(c.req.query("qty") ?? "1", 10) || 1));
    if (added) track(c, "cart_add", added.price * qty, [{ ...added, quantity: qty }]);
  }
  return productPageResponse(c, s, detail, categories);
});


/**
 * 商品ページを描く（お店の画面とひな形のプレビューで同じ）。o.layout はひな形の上書き（プレビュー: 保存していないひな形の下書き）。
 * null なら割り当てがあってもひな形を使わない
 */
async function productPageResponse(c: Ctx, s: ShopScope, detail0: ProductDetail, categories: CategoryRow[], o: RenderOpts & { layout?: PageRow | null } = {}): Promise<Response> {
  // 洗濯表示（同梱モジュール care_labels、0127）: 商品に無ければ主カテゴリーから親へたどって決める（材料はキャッシュ済みのカテゴリーとショップ行）
  const detail: ProductDetail = { ...detail0, care: productCareView(moduleEnabled(s.shop.settings, CARE_MODULE), detail0.product, categories, s.shop, s.ctx.mediaBaseUrl) };
  const props = {
    ctx: s.ctx,
    detail,
    added: c.req.query("added") === "1",
    // ?sku=<品番> で選んだ SKU（その SKU の画像を先頭に。0063）
    selectedSku: c.req.query("sku") ?? null,
    categoryPath: categoryPath(categories, detail.product.category_id).map((x) => ({ slug: x.slug, name: x.name })),
    attributes: publicAttributes(productFields(s.shop.settings), detail.product.attributes),
  };
  const lt = await liquidThemeFor(c, s);
  // 商品詳細のひな形（0102）: 主カテゴリーから親へたどって近い割り当て、無ければショップ全体。見えないページなら今までの画面
  const layoutId = o.layout === undefined && moduleEnabled(s.shop.settings, PAGES_MODULE) ? productLayoutId(pageLayoutsOf(s.shop.settings), categories, detail.product.category_id) : null;
  const layout = o.layout !== undefined ? o.layout : layoutId ? await s.sf.layoutPage(s.shop, layoutId) : null;
  if (layout) {
    const view = o.preview ? await previewBody(s.sf, s.shop, layout.body) : await viewerBody(c, s.sf, s.shop, layout.body, viewerOf(s));
    const raw = o.preview ? markdownToHtml(view.body, { mediaBase: s.ctx.mediaBaseUrl }) : pageBodyHtml({ ...layout, body: view.body }, s.ctx.mediaBaseUrl, undefined, view.key);
    const { blocks, cards, ablocks, acards, apps, appCards, shopCards } = await bodyProducts(s, view.body, categories, { product: detail.product.slug, productId: detail.product.id, categoryId: detail.product.category_id ?? null, tags: detail.product.tags ?? [] });
    const doc = (o.prefix ?? "") + fillDateBlocks(fillShopBlocks(raw, shopCards), { published: detail.product.created_at, updated: detail.product.updated_at });
    // 商品の部品は既定のテーマのもの（買うフォームはここにしか無い。値段・在庫・会員価格は DB の判定のまま）。記事の部品は空
    const only = (parts: Record<string, string>) => Object.fromEntries(PRODUCT_LAYOUT_PARTS.map((k) => [k, parts[k] ?? ""]));
    if (lt) {
      const view2 = productView(props);
      const parts: Record<string, string> = {};
      for (const [k, node] of Object.entries(view2.parts)) parts[k] = node === null ? "" : String(node);
      parts["buy"] = (parts["added"] ?? "") + (parts["buy"] ?? "");
      const { jsonLd, path } = liquidProductJsonLd(c, s, { detail, categoryNames: props.categoryPath.map((x) => x.name), selectedSku: props.selectedSku });
      // テーマに snippets/part-<部品> があれば、その部品はテーマの見た目で（無ければ既定のまま）
      const themed = themeLayoutParts(c, s, lt, { body: view.body, names: PRODUCT_LAYOUT_PARTS, defaults: only(parts), values: productPartValues(c, s, detail, props.selectedSku), title: detail.product.name, path, categories });
      const page: PageRow = { ...layout, title: detail.product.name, seo_title: null, seo_description: detail.product.description ? detail.product.description.slice(0, 200) : null, image_url: null };
      const res = renderContentPage(c, s, lt, { page, html: `<style>${CURRENT_CSS}${PRODUCT_PARTS_CSS}</style>` + fillCurrent(doc, themed), categories, blocks, cards, ablocks, acards, apps, appCards, path, jsonLd });
      if (res) return res;
    }
    const html = fillAppBlocks(fillArticleBlocks(fillProductBlocks(doc, cards), acards), appCards);
    return c.html(s.theme.ProductPage({ ...props, layout: (parts) => `<style>${CURRENT_CSS}</style>` + fillCurrent(html, only(parts)) }));
  }
  if (lt) {
    const res = renderProduct(c, s, lt, { detail, categories, categoryNames: props.categoryPath.map((x) => x.name), selectedSku: props.selectedSku });
    if (res) return res;
  }
  return c.html(s.theme.ProductPage(props));
}

// ---------- 法務ページ ----------
const legalPages: Record<string, { title: () => string; pick: (s: PublicShop) => string | null }> = {
  legal: { title: () => t("shop.legal_notice"), pick: (s) => s.legal_notice },
  privacy: { title: () => t("shop.privacy_policy"), pick: (s) => s.privacy_policy },
  returns: { title: () => t("shop.return_policy"), pick: (s) => s.return_policy },
};

// 商品フィード（同梱モジュール product_feed）。Cron が作って置いたものを配る。DB はキャッシュ済みのショップ行だけ
storefront.get("/:shop/feed/products.xml", async (c: Ctx) => {
  const sf = data(c);
  const shop = sf ? await sf.shopBySlug(param(c, "shop")) : null;
  if (!shop || !moduleEnabled(shop.settings, FEED_MODULE)) return c.notFound();
  const body = await readFeed(c.get("adapters").storage, shop.id);
  if (!body) return c.text(t("feed.not_ready"), 404);
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=600", "X-Content-Type-Options": "nosniff" } });
});

// ---------- ショップのページ（同梱モジュール pages、0079、docs/pages.md） ----------
/**
 * 会員限定のページ・記事（0100）にゲストが来たとき: 「会員の方だけ」とログインへ（存在も隠すものは null = 404。ログイン中で合わない会員も 404）。
 * 商品（0098）と同じ画面
 */
async function membersOnlyGate(c: Ctx, s: ShopScope, kind: "page" | "article", handle: string, blogId: string | null = null): Promise<Response | null> {
  if (s.ctx.member || !s.ctx.membersEnabled || !moduleEnabled(s.shop.settings, AUDIENCES_MODULE)) return null;
  if (!(await s.sf.contentGate(s.shop, kind, handle, blogId))) return null;
  const loginUrl = `${s.ctx.shopPath}/account/login`;
  c.header("Cache-Control", "private, no-store");
  return c.html(s.theme.MembersOnlyPage ? s.theme.MembersOnlyPage({ ctx: s.ctx, loginUrl }) : s.theme.LegalPage({ ctx: s.ctx, title: t("store.members_only_title"), body: t("store.members_only_login") }));
}

/** 見る人（ログイン中の会員なら独自項目の値も）。見せる相手の囲み（0097）の判定に使う */
const viewerOf = (s: ShopScope): AudienceContext => ({ ...(s.ctx.member ? { member: true, attrs: s.ctx.member.attrs ?? {} } : GUEST), ...s.query });

/** テーマに渡すカテゴリー（説明と画像は 0113。無ければ出さない） */
const categoryProp = (c: CategoryRow) => ({ slug: c.slug, name: c.name, description: c.description ?? null, image: categoryImageOf(c) });

/** 本文の中の「商品を並べる」「記事を並べる」（src/content/body-blocks.ts。ヘッドレスの API と共通） */
function bodyProducts(s: ShopScope, body: string, categories: CategoryRow[], current?: BodyBlocksDeps["current"]) {
  return bodyBlocks({ sf: s.sf, shop: s.shop, shopPath: s.ctx.shopPath, mediaBaseUrl: s.ctx.mediaBaseUrl, ...(current ? { current } : {}) }, body, categories);
}

storefront.get("/:shop/pages/:handle", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  // モジュールの ON/OFF はキャッシュ済みのショップ行で判定する（OFF なら DB に問い合わせない）
  const handle = param(c, "handle");
  if (!moduleEnabled(s.shop.settings, PAGES_MODULE) || !pageHandleOk(handle)) return notFoundPage(c, s);
  const [page, categories] = await Promise.all([s.sf.pageByHandle(s.shop, handle), s.sf.listCategories(s.shop)]);
  if (!page) return (await membersOnlyGate(c, s, "page", handle)) ?? notFoundPage(c, s);
  // 部品のページ（0122）はほかの本文に差し込むだけで、単独では見せない
  if (page.is_part) return notFoundPage(c, s);
  const view = await viewerBody(c, s.sf, s.shop, page.body, viewerOf(s));
  const raw = pageBodyHtml({ ...page, body: view.body }, s.ctx.mediaBaseUrl, undefined, view.key);
  return contentPageResponse(c, s, page, view.body, raw, categories);
});

/** 描き方の指定（プレビュー・ひな形） */
interface RenderOpts {
  /** プレビューの知らせ（本文の前に足す） */
  prefix?: string;
  /** プレビュー: 見せる相手の囲みは中身ごと・本文の HTML を覚えない */
  preview?: boolean;
  /** ページをひな形（0101）として描く: テーマの見出しを出さず、canonical をこのパスにする（お店のトップは ""） */
  layoutPath?: string;
}

/**
 * ページを描く（お店の画面・プレビュー・お店のトップのひな形で同じ）。body は見る人で絞った本文、raw はその HTML
 */
async function contentPageResponse(c: Ctx, s: ShopScope, page: PageRow, body: string, raw: string, categories: CategoryRow[], o: RenderOpts = {}): Promise<Response> {
  // ページを見た（0107。プレビュー・ひな形の見本では積まない）
  if (!o.preview) recordShopEvent(c, { type: "page_view", value_jpy: 0, items: [], page: { id: page.id, handle: page.handle } });
  const { blocks, cards, ablocks, acards, apps, appCards, shopCards } = await bodyProducts(s, body, categories);
  // お店のブロック（検索・カテゴリー・カード・商品・日時）はテーマに依らない HTML なので先に入れる。日時は描くたびに。
  // 「今の記事・商品の部品」はふつうのページ（お店のトップのひな形を含む）ではそのページ自身のタイトル・アイキャッチ・抜粋（SEO の説明）
  const html = (o.prefix ?? "") + fillCurrent(fillDateBlocks(fillShopBlocks(raw, shopCards), { published: pagePublishedAt(page), updated: page.updated_at }), pageParts({ mediaBase: s.ctx.mediaBaseUrl, page }));
  const layout = o.layoutPath !== undefined;
  const lt = await liquidThemeFor(c, s);
  if (lt) {
    const res = renderContentPage(c, s, lt, { page, html, categories, blocks, cards, ablocks, acards, apps, appCards, ...(layout ? { path: o.layoutPath } : {}) });
    if (res) return res;
  }
  if (!s.theme.ContentPage) return notFoundPage(c, s);
  return c.html(s.theme.ContentPage({ ctx: s.ctx, page, html: fillAppBlocks(fillArticleBlocks(fillProductBlocks(html, cards), acards), appCards), ...(layout ? { bare: true, path: `${s.ctx.shopPath}${o.layoutPath}` || "/" } : {}) }));
}

/** 記事の本文・ひな形の中のブロックに渡す「今の記事」（0117: field:<key>=@article と from=@field:<key>） */
const articleCurrent = (a: ArticleRow): BodyBlocksDeps["current"] => ({ article: a.handle, articleFields: a.fields ?? {} });

/**
 * 記事を描く（お店の画面とプレビューで同じ）。ブログに記事のひな形（0101）があれば、ひな形の本文に記事の本文を差し込んで描く。
 * body は見る人で絞った記事の本文、raw はその HTML、segment は見る人の区分（本文の HTML の覚えの鍵）
 */
async function articlePageResponse(c: Ctx, s: ShopScope, blog: BlogRow, article: ArticleRow, body: string, raw: string, categories: CategoryRow[], o: RenderOpts & { segment?: string; layout?: PageRow | null } = {}): Promise<Response> {
  // 記事を読んだ（0107。プレビューでは積まない）
  if (!o.preview) recordShopEvent(c, { type: "article_view", value_jpy: 0, items: [], article: { id: article.id, blog: blog.handle, handle: article.handle, author: article.author ?? null, tags: (article.tags ?? []).slice(0, 20) } });
  const feedUrl = blogHasFeed(blog) ? `${blogPath(s.ctx.shopPath, blog.handle)}/feed.atom` : null;
  const dates = { published: article.published_at ?? article.updated_at, updated: article.updated_at };
  const layoutId = o.layout === undefined && moduleEnabled(s.shop.settings, PAGES_MODULE) ? pageLayoutsOf(s.shop.settings).articles[blog.id] : undefined;
  const layout = o.layout !== undefined ? o.layout : layoutId ? await s.sf.layoutPage(s.shop, layoutId) : null;
  if (layout) {
    const lview = o.preview ? await previewBody(s.sf, s.shop, layout.body) : await viewerBody(c, s.sf, s.shop, layout.body, viewerOf(s));
    const comp = composeLayout(lview.body, body);
    const doc = o.preview
      ? markdownToHtml(comp.body, { mediaBase: s.ctx.mediaBaseUrl })
      : pageBodyHtml({ id: `${layout.id}:${article.id}`, updated_at: `${layout.updated_at}|${article.updated_at}`, body: comp.body }, s.ctx.mediaBaseUrl, undefined, `${lview.key}|${o.segment ?? ""}`);
    const neighbors = usesPart(lview.body, "prev-next") ? await s.sf.articleNeighbors(s.shop, blog.id, article) : null;
    // 本文を差し込めなかった（囲みの中に置いた）ときは、記事の本文の HTML をそのまま入れる（その本文のお店のブロックは出ない）
    // 記事の項目（0117）: ひな形で使っている項目の部品と、書いた人のカード
    const used = usedFieldParts(lview.body);
    const fieldParts = (used.fields.length > 0 || used.author) && articleFieldsReady(blog) ? await articleFieldParts({ sf: s.sf, shop: s.shop, shopPath: s.ctx.shopPath, mediaBase: s.ctx.mediaBaseUrl }, blog, article, used) : {};
    const parts = { ...articleParts({ shopPath: s.ctx.shopPath, mediaBase: s.ctx.mediaBaseUrl, blog, article, neighbors, ...(comp.inserted ? {} : { content: fillCurrent(raw).replace(/<!--banto:[a-z]+:\d+-->/g, "") }) }), ...fieldParts };
    const { blocks, cards, ablocks, acards, apps, appCards, shopCards } = await bodyProducts(s, comp.body, categories, articleCurrent(article));
    const html = (o.prefix ?? "") + `<style>${CURRENT_CSS}${Object.keys(fieldParts).length ? ARTICLE_FIELDS_CSS : ""}</style>` + fillCurrent(fillDateBlocks(fillShopBlocks(doc, shopCards), dates), parts);
    const path = `/blogs/${encodeURIComponent(blog.handle)}/${encodeURIComponent(article.handle)}`;
    const lt = await liquidThemeFor(c, s);
    if (lt) {
      // Liquid: ひな形のページとして templates/page（ひな形の template_suffix があればそれ）で描く。見出しなどは記事のもの
      const page: PageRow = { ...layout, title: article.title, seo_title: article.seo_title, seo_description: article.seo_description || article.excerpt, image_url: article.image_url };
      const res = renderContentPage(c, s, lt, { page, html, categories, blocks, cards, ablocks, acards, apps, appCards, path });
      if (res) return res;
    }
    if (s.theme.ArticlePage) return c.html(s.theme.ArticlePage({ ctx: s.ctx, blog, article, html: fillAppBlocks(fillArticleBlocks(fillProductBlocks(html, cards), acards), appCards), feedUrl, bare: true }));
  }
  const { blocks, cards, ablocks, acards, apps, appCards, shopCards } = await bodyProducts(s, body, categories, articleCurrent(article));
  const html = (o.prefix ?? "") + fillCurrent(fillDateBlocks(fillShopBlocks(raw, shopCards), dates));
  const lt = await liquidThemeFor(c, s);
  if (lt) {
    const res = renderArticlePage(c, s, lt, { blog, article, html, categories, blocks, cards, ablocks, acards, apps, appCards });
    if (res) return res;
  }
  if (!s.theme.ArticlePage) return notFoundPage(c, s);
  return c.html(s.theme.ArticlePage({ ctx: s.ctx, blog, article, html: fillAppBlocks(fillArticleBlocks(fillProductBlocks(html, cards), acards), appCards), feedUrl }));
}


// ---------- ブログ（同梱モジュール blog、0081、docs/blog.md） ----------
/** ブログの記事の一覧（公開した日時の新しい順、?tag= で絞る、?page= でページ送り） */
storefront.get("/:shop/blogs/:blog", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const handle = param(c, "blog");
  if (!moduleEnabled(s.shop.settings, BLOG_MODULE) || !blogHandleOk(handle)) return notFoundPage(c, s);
  const tagRaw = (c.req.query("tag") ?? "").trim();
  const tag = tagRaw && tagRaw.length <= 50 ? tagRaw : null;
  const pageNo = Math.max(1, Math.min(Math.floor(ARTICLES_OFFSET_MAX / ARTICLES_PER_PAGE) + 1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1));
  const [blog, categories] = await Promise.all([s.sf.blogByHandle(s.shop, handle), s.sf.listCategories(s.shop)]);
  if (!blog) return notFoundPage(c, s);
  return blogListResponse(c, s, blog, { tag, pageNo }, categories);
});

/**
 * ブログの記事の一覧を描く（お店の画面とひな形のプレビューで同じ）。ブログの一覧のひな形（0114）は、記事の並びの部品
 * （`::: current part=articles`）が見る人に見える本文にあるときだけ使う（無ければ今までの一覧）。タグで絞った一覧・ページ送りもひな形で描く
 */
async function blogListResponse(c: Ctx, s: ShopScope, blog: BlogRow, q: { tag: string | null; pageNo: number }, categories: CategoryRow[], o: RenderOpts & { layout?: PageRow | null } = {}): Promise<Response> {
  const { tag, pageNo } = q;
  const { items, hasNext } = await s.sf.articlesPage(s.shop, blog.id, { offset: (pageNo - 1) * ARTICLES_PER_PAGE, limit: ARTICLES_PER_PAGE, tag, sort: articleSortFor(blog), fieldSort: blogFieldSort(blog), withFields: articleFieldsReady(blog) });
  const path = blogPath(s.ctx.shopPath, blog.handle);
  const link = (n: number) => `${path}?${new URLSearchParams({ ...(tag ? { tag } : {}), ...(n > 1 ? { page: String(n) } : {}) }).toString()}`.replace(/\?$/, "");
  const newer = pageNo > 1 ? link(pageNo - 1) : null;
  const older = hasNext && pageNo * ARTICLES_PER_PAGE <= ARTICLES_OFFSET_MAX ? link(pageNo + 1) : null;
  const articles = items.map((article) => ({ article, summary: articleSummary(article) }));
  const tags = [...new Set(items.flatMap((a) => a.tags))].slice(0, 30);
  const feedUrl = blogHasFeed(blog) ? `${path}/feed.atom` : null;
  const lt = await liquidThemeFor(c, s);
  const layoutId = o.layout === undefined && moduleEnabled(s.shop.settings, PAGES_MODULE) ? blogLayoutId(pageLayoutsOf(s.shop.settings), blog.id) : null;
  const layout = o.layout !== undefined ? o.layout : layoutId ? await s.sf.layoutPage(s.shop, layoutId) : null;
  if (layout && s.theme.BlogPage) {
    const view = o.preview ? await previewBody(s.sf, s.shop, layout.body) : await viewerBody(c, s.sf, s.shop, layout.body, viewerOf(s));
    if (usesPart(view.body, "articles")) {
      const raw = o.preview ? markdownToHtml(view.body, { mediaBase: s.ctx.mediaBaseUrl }) : pageBodyHtml({ ...layout, body: view.body }, s.ctx.mediaBaseUrl, undefined, view.key);
      const { blocks, cards, ablocks, acards, apps, appCards, shopCards } = await bodyProducts(s, view.body, categories);
      const doc = (o.prefix ?? "") + fillDateBlocks(fillShopBlocks(raw, shopCards), { published: pagePublishedAt(layout), updated: layout.updated_at });
      const props = { ctx: s.ctx, blog, articles, tag, tags, newer, older };
      const only = (parts: Record<string, string>) => Object.fromEntries(BLOG_LIST_PARTS.map((k) => [k, parts[k] ?? ""]));
      if (lt) {
        const parts: Record<string, string> = {};
        for (const [k, node] of Object.entries(blogListParts(props))) parts[k] = node === null ? "" : String(node);
        const qs = new URLSearchParams({ ...(tag ? { tag } : {}), ...(pageNo > 1 ? { page: String(pageNo) } : {}) }).toString();
        const lpath = `/blogs/${encodeURIComponent(blog.handle)}${qs ? `?${qs}` : ""}`;
        const title = tag ? `${tf("blog.tagged", { tag })} | ${blog.title}` : blog.seo_title || blog.title;
        // テーマに snippets/part-<部品> があれば、その部品はテーマの見た目で（無ければ既定のまま）
        const themed = themeLayoutParts(c, s, lt, { body: view.body, names: BLOG_LIST_PARTS, defaults: only(parts), values: blogPartValues(s, { blog, articles, tag, tags, pageNo, newer, older }), title, path: lpath, categories });
        const page: PageRow = { ...layout, title: tag ? tf("blog.tagged", { tag }) : blog.title, seo_title: title, seo_description: blog.seo_description || blog.description, image_url: null };
        const res = renderContentPage(c, s, lt, { page, html: `<style>${CURRENT_CSS}${BLOG_PARTS_CSS}</style>` + fillCurrent(doc, themed), categories, blocks, cards, ablocks, acards, apps, appCards, path: lpath, ...(tag ? { noindex: true } : {}) });
        if (res) return res;
      }
      const html = fillAppBlocks(fillArticleBlocks(fillProductBlocks(doc, cards), acards), appCards);
      return c.html(s.theme.BlogPage({ ...props, feedUrl, layout: (parts) => `<style>${CURRENT_CSS}</style>` + fillCurrent(html, only(parts)) }));
    }
  }
  if (lt) {
    const res = renderBlogPage(c, s, lt, { blog, articles, tag, tags, pageNo, newer, older, categories });
    if (res) return res;
  }
  if (!s.theme.BlogPage) return notFoundPage(c, s);
  return c.html(s.theme.BlogPage({ ctx: s.ctx, blog, articles, tag, tags, newer, older, feedUrl }));
}

/** Atom のフィード（新しい記事 20 本の紹介と URL） */
storefront.get("/:shop/blogs/:blog/feed.atom", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const handle = param(c, "blog");
  if (!moduleEnabled(s.shop.settings, BLOG_MODULE) || !blogHandleOk(handle)) return notFoundPage(c, s);
  const blog = await s.sf.blogByHandle(s.shop, handle);
  // フィードを出さないブログ（0116）は無いことにする
  if (!blog || !blogHasFeed(blog)) return notFoundPage(c, s);
  // フィードはブログの並び順によらず新しい順
  const { items } = await s.sf.articlesPage(s.shop, blog.id, { offset: 0, limit: FEED_ARTICLES, sort: articleSortFor(blog, "new") });
  const home = shopHome(publicBaseUrl(c), s.shop);
  const blogUrl = `${home}/blogs/${encodeURIComponent(blog.handle)}`;
  const body = atomFeed({
    blogTitle: blog.title,
    blogUrl,
    feedUrl: `${blogUrl}/feed.atom`,
    shopName: s.shop.name,
    articles: items.map((a) => ({ title: a.title, url: `${blogUrl}/${encodeURIComponent(a.handle)}`, summary: articleSummary(a, 300), published: a.published_at ?? a.updated_at, updated: a.updated_at, author: a.author })),
  });
  return c.body(body, 200, { "Content-Type": "application/atom+xml; charset=utf-8", "Cache-Control": "public, max-age=600" });
});

/** ブログの記事 */
storefront.get("/:shop/blogs/:blog/:article", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const handle = param(c, "blog");
  const ah = param(c, "article");
  if (!moduleEnabled(s.shop.settings, BLOG_MODULE) || !blogHandleOk(handle) || !articleHandleOk(ah)) return notFoundPage(c, s);
  const [blog, categories] = await Promise.all([s.sf.blogByHandle(s.shop, handle), s.sf.listCategories(s.shop)]);
  if (!blog) return notFoundPage(c, s);
  const article = await s.sf.articleByHandle(s.shop, blog.id, ah);
  if (!article) return (await membersOnlyGate(c, s, "article", ah, blog.id)) ?? notFoundPage(c, s);
  const view = await viewerBody(c, s.sf, s.shop, article.body, viewerOf(s));
  const raw = pageBodyHtml({ ...article, body: view.body }, s.ctx.mediaBaseUrl, undefined, view.key);
  return articlePageResponse(c, s, blog, article, view.body, raw, categories, { segment: view.key });
});

storefront.get("/:shop/:page{legal|privacy|returns}", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const kind = param(c, "page") as LegalKind;
  // 連携サイトのページに向けていて、最後の確認で生きていればそちらへ（0062）。落ちていれば Banto のページを出す
  const external = liveLegalUrl(s.shop.legal_links, kind);
  if (external) return c.redirect(external, 302);
  return legalResponse(c, s, kind);
});

/**
 * 法務のページを描く（お店の画面とひな形のプレビューで同じ）。ひな形（0104）は、文面の部品（`::: current part=legal`）が
 * 見る人に見える本文にあるときだけ使う（無い・見せる相手の囲みで隠れるなら今までの画面。文面を出さない法務のページを作らせない）
 */
async function legalResponse(c: Ctx, s: ShopScope, kind: LegalKind, o: RenderOpts & { layout?: PageRow | null } = {}): Promise<Response> {
  const page = legalPages[kind]!;
  const title = page.title();
  const body = page.pick(s.shop) ?? "";
  const lt = await liquidThemeFor(c, s);
  const layoutId = o.layout === undefined && moduleEnabled(s.shop.settings, PAGES_MODULE) ? legalLayoutId(pageLayoutsOf(s.shop.settings), kind) : null;
  const layout = o.layout !== undefined ? o.layout : layoutId ? await s.sf.layoutPage(s.shop, layoutId) : null;
  if (layout) {
    const view = o.preview ? await previewBody(s.sf, s.shop, layout.body) : await viewerBody(c, s.sf, s.shop, layout.body, viewerOf(s));
    if (usesPart(view.body, "legal")) {
      const categories = await s.sf.listCategories(s.shop);
      const raw = o.preview ? markdownToHtml(view.body, { mediaBase: s.ctx.mediaBaseUrl }) : pageBodyHtml({ ...layout, body: view.body }, s.ctx.mediaBaseUrl, undefined, view.key);
      const { blocks, cards, ablocks, acards, apps, appCards, shopCards } = await bodyProducts(s, view.body, categories);
      const doc = (o.prefix ?? "") + fillDateBlocks(fillShopBlocks(raw, shopCards), { published: pagePublishedAt(layout), updated: layout.updated_at });
      const parts = legalParts(title, body);
      const only = Object.fromEntries(LEGAL_PARTS.map((k) => [k, parts[k] ?? ""]));
      if (lt) {
        const pg: PageRow = { ...layout, title, seo_title: null, seo_description: null, image_url: null };
        const res = renderContentPage(c, s, lt, { page: pg, html: fillCurrent(doc, only), categories, blocks, cards, ablocks, acards, apps, appCards, path: `/${kind}` });
        if (res) return res;
      }
      const html = fillCurrent(fillAppBlocks(fillArticleBlocks(fillProductBlocks(doc, cards), acards), appCards), only);
      return c.html(s.theme.LegalPage({ ctx: s.ctx, title, body, layout: () => html }));
    }
  }
  // Liquid のテーマの templates/page（文面は Banto が作る）。無ければ既定のテーマ
  if (lt) {
    const res = renderLegalPage(c, s, lt, { handle: kind, title, body, categories: await s.sf.listCategories(s.shop) });
    if (res) return res;
  }
  return c.html(s.theme.LegalPage({ ctx: s.ctx, title, body }));
}

// ---------- カート ----------
async function cartLines(s: ShopScope): Promise<{ lines: CartLine[]; total: number }> {
  const priced = await priceCart(s.sf, s.shop, s.cart);
  return { lines: priced.lines, total: priced.subtotal };
}

/** カート画面のクーポン欄（モジュールが OFF なら null。コードが無ければ DB に問い合わせない） */
async function cartCoupons(c: Ctx, s: ShopScope, lines: CartLine[], subtotal: number) {
  const source = couponSource(c, s.shop);
  if (!source) return null;
  const member = s.ctx.membersEnabled ? await customerSession(c, s) : null;
  // 送料は配送先が決まるまで分からないので 0 で判定する（送料無料のクーポンは確認画面で額が決まる）
  const d = await discountCart({ sf: s.sf, shop: s.shop, coupons: source, member: member ? { id: member.cid } : null }, { lines, subtotal, dropped: [], cart: s.cart }, s.cart.coupons, 0, null);
  return {
    applied: d.applied.map((a) => ({ code: a.code, name: a.name, amount_jpy: a.amount_jpy, free_shipping: a.kind === "free_shipping" })),
    rejected: d.rejected.map(couponNotice),
    discount: d.itemDiscount,
  };
}

function paymentOptions(c: Ctx, s: ShopScope): Promise<PaymentSetup> {
  return paymentSetup(s.sf, s.shop, c.get("adapters").config);
}

const CART_ERRORS: Record<string, MessageKey> = {
  stock: "store.checkout_error_stock",
  payment: "store.checkout_error_payment",
  config: "store.checkout_error_config",
  expired: "confirm.expired",
  quote_used: "confirm.expired",
  price: "confirm.changed",
  limit: "store.checkout_error_limit",
  coupon: "store.checkout_error_coupon",
  minimum: "store.checkout_error_minimum",
  coupon_invalid: "store.coupon_invalid",
};

storefront.get("/:shop/cart", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  // クーポン付きリンク（/:shop/cart?coupon=SUMMER10）: コードをカートに入れてから表示する
  const linked = normalizeCode(c.req.query("coupon"));
  if (linked && couponSource(c, s.shop)) {
    await writeCart(c, s, addCoupon(s.cart, linked));
    return c.redirect(`${s.ctx.shopPath}/cart`);
  }
  const [{ lines, total }, { options }] = await Promise.all([cartLines(s), paymentOptions(c, s)]);
  const coupons = await cartCoupons(c, s, lines, total);
  const errorKey = CART_ERRORS[c.req.query("error") ?? ""];
  const tryon = moduleEnabled(s.shop.settings, TRYON_MODULE) && !!s.theme.TryonPage;
  if (lines.length > 0) track(c, "cart_view", total, cartItems(lines));
  // Liquid のテーマの templates/cart（無ければ既定のテーマ）
  const lt = await liquidThemeFor(c, s, { cartLines: lines });
  if (lt) {
    const res = renderCart(c, s, lt, { lines, discounts: coupons ? { applied: coupons.applied, rejected: coupons.rejected, discount: coupons.discount } : null, payments: options, ...(errorKey ? { error: t(errorKey) } : {}), categories: await s.sf.listCategories(s.shop) });
    if (res) return res;
  }
  return c.html(s.theme.CartPage({ ctx: s.ctx, lines, total, payments: options, shipping: shippingSummary(s.shop), coupons, error: errorKey ? t(errorKey) : undefined, tryon }));
});

// ---------- お店で試着（同梱モジュール store_tryon、決済なし。docs/store-tryon.md） ----------
storefront.get("/:shop/stores", async (c: Ctx) => {
  const s = await scope(c);
  if (!s || !moduleEnabled(s.shop.settings, TRYON_MODULE) || !s.theme.StoresPage) return notFound(c, s ?? undefined);
  const today = todayHere();
  const stores = (await s.sf.listStores(s.shop)).map((st) => storeView(st, today));
  return c.html(s.theme.StoresPage({ ctx: s.ctx, stores }));
});

/** 申し込みの画面の共通の材料。モジュールが OFF・テーマが対応していなければ null */
async function tryonScope(c: Ctx) {
  const s = await scope(c);
  if (!s || !moduleEnabled(s.shop.settings, TRYON_MODULE) || !s.theme.TryonPage) return { s, t: null };
  const settings = tryonSettings(s.shop.settings);
  const [stores, { lines }] = await Promise.all([s.sf.listStores(s.shop), cartLines(s)]);
  return { s, t: { settings, stores: stores.filter((x) => x.tryon), lines, today: todayHere() } };
}

/** カートの点数の上限・在庫切れ（申し込めないときのエラー） */
function tryonCartError(lines: CartLine[], max: number): MessageKey | null {
  if (lines.length === 0) return "tryon.error_empty";
  if (lines.some((l) => l.short)) return "store.checkout_error_stock";
  if (lines.reduce((n, l) => n + l.qty, 0) > max) return "tryon.error_too_many";
  return null;
}

type TryonProps = Parameters<NonNullable<ShopScope["theme"]["TryonPage"]>>[0];

/** 試着の画面: Liquid のテーマに templates/tryon があればそれ（メンテナの決定 2026-11-06）、無ければ・描けなければ既定のテーマ */
async function tryonRender(c: Ctx, s: ShopScope, props: TryonProps, status: 200 | 400 | 409 = 200): Promise<Response> {
  const lt = await liquidThemeFor(c, s);
  if (lt) {
    const { ctx: _ctx, ...rest } = props;
    const res = await renderTryon(c, s, lt, { ...rest, status });
    if (res) return res;
  }
  return c.html(s.theme.TryonPage!(props), status);
}

function tryonPage(c: Ctx, s: ShopScope, tr: NonNullable<Awaited<ReturnType<typeof tryonScope>>["t"]>, props: Partial<TryonProps>, status: 200 | 400 | 409 = 200) {
  return tryonRender(
    c,
    s,
    {
      ctx: s.ctx,
      step: "store",
      lines: tr.lines,
      stores: tr.stores.map((st) => storeView(st, tr.today)),
      settings: { mode: tr.settings.mode, hold_days: tr.settings.hold_days, max_items: tr.settings.max_items, notice: tr.settings.notice },
      values: {},
      ...props,
    },
    status,
  );
}

storefront.get("/:shop/tryon", async (c: Ctx) => {
  const { s, t: tr } = await tryonScope(c);
  if (!s || !tr) return notFound(c, s ?? undefined);
  const cartError = tryonCartError(tr.lines, tr.settings.max_items);
  if (cartError === "tryon.error_empty") return c.redirect(`${s.ctx.shopPath}/cart`);
  if (cartError) return tryonPage(c, s, tr, { error: tf(cartError, { max: tr.settings.max_items }) }, 409);
  const store = tr.stores.find((x) => x.id === c.req.query("store"));
  if (!store) return tryonPage(c, s, tr, {});
  const prefill = s.ctx.membersEnabled ? await customerPrefill(c, s) : {};
  const dates = tr.settings.mode === "visit" ? visitDates(store, tr.settings, tr.today).map((d) => ({ value: d, label: dateLabel(d) })) : [];
  return tryonPage(c, s, tr, {
    step: "details",
    store: storeView(store, tr.today),
    dates,
    values: { store: store.id, customer_name: prefill.customer_name, customer_email: prefill.customer_email, customer_phone: prefill.phone },
  });
});

storefront.post("/:shop/tryon/confirm", async (c: Ctx) => {
  const { s, t: tr } = await tryonScope(c);
  if (!s || !tr) return notFound(c, s ?? undefined);
  const cartError = tryonCartError(tr.lines, tr.settings.max_items);
  if (cartError) return cartError === "tryon.error_empty" ? c.redirect(`${s.ctx.shopPath}/cart`) : tryonPage(c, s, tr, { error: tf(cartError, { max: tr.settings.max_items }) }, 409);
  const r = checkTryon(await formFields(c), tr.stores, tr.settings, tr.today);
  if (!r.store) return tryonPage(c, s, tr, { error: t("tryon.error_store") }, 400);
  const view = storeView(r.store, tr.today);
  if (r.error) {
    const dates = tr.settings.mode === "visit" ? visitDates(r.store, tr.settings, tr.today).map((d) => ({ value: d, label: dateLabel(d) })) : [];
    return tryonPage(c, s, tr, { step: "details", store: view, dates, values: r.input, error: t(r.error) }, 400);
  }
  return tryonPage(c, s, tr, { step: "confirm", store: view, values: r.input, visitLabel: r.input.visit_date ? dateLabel(r.input.visit_date) : null });
});

/** 同じ人・同じ IP の開いている申し込みの上限に使う IP の HMAC（0029。p_customer.ip_hash で渡す） */
async function tryonIpHash(c: Ctx, shop: { id: string }): Promise<string | null> {
  const secret = c.get("sessionSecret");
  const ip = await clientIpFor(c, shop);
  return secret && ip ? ipHash(secret, ip) : null;
}

const TRYON_RPC_ERRORS: Record<string, MessageKey> = {
  too_many_requests: "tryon.error_too_many_open",
  insufficient_stock: "store.checkout_error_stock",
  sku_not_available: "store.checkout_error_stock",
  store_not_available: "tryon.error_store",
  invalid_customer: "tryon.error_email",
};

storefront.post("/:shop/tryon/submit", async (c: Ctx) => {
  const { s, t: tr } = await tryonScope(c);
  if (!s || !tr) return notFound(c, s ?? undefined);
  const cartError = tryonCartError(tr.lines, tr.settings.max_items);
  if (cartError) return cartError === "tryon.error_empty" ? c.redirect(`${s.ctx.shopPath}/cart`) : tryonPage(c, s, tr, { error: tf(cartError, { max: tr.settings.max_items }) }, 409);
  const r = checkTryon(await formFields(c), tr.stores, tr.settings, tr.today);
  if (!r.store || r.error) return tryonPage(c, s, tr, { error: t(r.error ?? "tryon.error_store") }, 400);
  const db = privilegedFor(c);
  if (!db) return tryonPage(c, s, tr, { error: t("store.checkout_error_config") }, 409);
  const member = s.ctx.membersEnabled ? await customerSession(c, s) : null;
  try {
    const res = await db.tryonRequest(
      s.shop.id,
      r.store.id,
      tr.lines.map((l) => ({ sku_id: l.sku.id, qty: l.qty })),
      { customer_email: r.input.customer_email, customer_name: r.input.customer_name, customer_phone: r.input.customer_phone, note: r.input.note || null, customer_id: member?.cid ?? null, ip_hash: await tryonIpHash(c, s.shop) },
      r.input.visit_date || null,
    );
    // 申し込んだ商品はカートから外す（クーポンは残す）
    await writeCart(c, s, { ...s.cart, items: [] });
    return c.redirect(`${s.ctx.shopPath}/tryon/done?n=${res.number}&store=${r.store.id}`);
  } catch (e) {
    if (e instanceof PrivilegedRpcError) {
      const key = Object.entries(TRYON_RPC_ERRORS).find(([k]) => e.message.includes(k))?.[1];
      if (key) return tryonPage(c, s, tr, { error: t(key) }, 409);
    }
    throw e;
  }
});

storefront.get("/:shop/tryon/done", async (c: Ctx) => {
  const s = await scope(c);
  if (!s || !moduleEnabled(s.shop.settings, TRYON_MODULE) || !s.theme.TryonPage) return notFound(c, s ?? undefined);
  const number = Number(c.req.query("n"));
  if (!Number.isInteger(number) || number <= 0) return notFound(c, s);
  const today = todayHere();
  const store = (await s.sf.listStores(s.shop)).find((x) => x.id === c.req.query("store"));
  const settings = tryonSettings(s.shop.settings);
  return tryonRender(c, s, {
    ctx: s.ctx,
    step: "done",
    lines: [],
    stores: [],
    store: store ? storeView(store, today) : null,
    settings: { mode: settings.mode, hold_days: settings.hold_days, max_items: settings.max_items, notice: settings.notice },
    values: {},
    number,
  });
});

/** クーポンのコードを入れる / 外す（使えるかどうかはカートの表示のたびに判定する） */
storefront.post("/:shop/cart/coupon", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const cartUrl = `${s.ctx.shopPath}/cart`;
  if (!couponSource(c, s.shop)) return c.redirect(cartUrl);
  const f = await formFields(c);
  if (f.remove) {
    await writeCart(c, s, removeCoupon(s.cart, f.remove));
    return c.redirect(cartUrl);
  }
  const code = normalizeCode(f.code);
  if (!code) return c.redirect(`${cartUrl}?error=coupon_invalid`);
  await writeCart(c, s, addCoupon(s.cart, code));
  return c.redirect(cartUrl);
});

// お店の行動の中継（同梱モジュール event_relay、0107）。会員は Cookie の署名だけで確かめる（DB に触らない）。docs/event-relay.md
storefront.post("/:shop/_x", async (c: Ctx) => {
  const sf = data(c);
  const shop = sf ? await sf.shopBySlug(param(c, "shop")).catch(() => null) : null;
  if (!shop) return c.body(null, 404);
  const secret = c.get("sessionSecret");
  const session = secret && membersEnabled(shop) ? await openMemberSession(secret, shop.id, readCookie(c.req.header("cookie"), customerCookieName(shop.id))) : null;
  return acceptRelay(c, shop, session && !session.add ? session.cid : null, "storefront");
});

storefront.post("/:shop/cart/add", async (c: Ctx) => {
  // Shopify のテーマの JS（Dawn など）は routes.cart_add_url（.js の付かない URL）に fetch で送り、JSON を受け取る
  if (wantsCartJson(c)) return cartAddJs(c);
  const s = await scope(c);
  if (!s) return notFound(c);
  const f = await formFields(c);
  // Liquid のテーマの商品フォームは Shopify と同じ名前（id = バリエーション、quantity）で送ってくる（docs/themes.md）
  const skuId = (f.sku_id ?? f.id ?? "").trim();
  const qty = Number.parseInt(f.qty ?? f.quantity ?? "1", 10);
  if (!skuId || !Number.isInteger(qty) || qty <= 0) return c.redirect(`${s.ctx.shopPath}/cart`);
  // 公開中の SKU だけ受け付ける
  const found = await s.sf.skusForCart(s.shop, [skuId]);
  const hit = found.get(skuId);
  if (!hit) return notFound(c, s);
  // 会員限定で買えない商品（0098）は入れない（商品のページが「会員の方だけ購入できます」を出している）
  if (!hit.purchasable) return c.redirect(productUrl(s.ctx.shopPath, hit.product.slug));
  const next = addItem(s.cart, skuId, qty);
  await writeCart(c, s, next);
  // 本文の「今すぐ買う」（src/pages/shop-blocks.ts）: カートに入れて、そのまま購入手続き（配送先 → 最終確認）へ
  if (f.buy === "1") return startCheckout(c, { ...s, cart: next }, {});
  // sku と qty は「カートに入れた」の出来事用（どの SKU を何点入れたか。src/storefront/events.ts）
  return c.redirect(productUrl(s.ctx.shopPath, hit.product.slug, { added: "1", sku: hit.sku.code, qty: String(qty) }));
});

storefront.post("/:shop/cart/update", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const body = await cartInput(c);
  const skuId = typeof body["sku_id"] === "string" ? body["sku_id"].trim() : "";
  let cart = s.cart;
  if (skuId) {
    const qty = Number.parseInt(String(body["qty"] ?? "0"), 10);
    cart = setQty(s.cart, skuId, Number.isInteger(qty) ? qty : 0);
    await writeCart(c, s, cart);
  } else {
    // Liquid のテーマの書き方（updates[<SKU>] / updates[]）
    cart = await applyUpdates(s, body);
    await writeCart(c, s, cart);
  }
  // 購入手続きへ進むときは、変えた後のカートで
  if ("checkout" in body) return startCheckout(c, { ...s, cart }, stringFields(body));
  return c.redirect(`${s.ctx.shopPath}/cart`);
});

// ---------- Liquid のテーマのカート（Shopify と同じ書き方。docs/themes.md「カート」） ----------
/** フォームか JSON の本文（AJAX）。updates[] のような同じ名前の欄はすべて受け取る */
async function cartInput(c: Ctx): Promise<Record<string, unknown>> {
  if ((c.req.header("content-type") ?? "").includes("application/json")) {
    const raw = await readJsonLimited(c, 64 * 1024);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  }
  if (c.req.method !== "POST") return Object.fromEntries(new URL(c.req.url).searchParams.entries());
  return (await c.req.parseBody({ all: true })) as Record<string, unknown>;
}

async function readJsonLimited(c: Ctx, max: number): Promise<unknown> {
  const raw = await readBodyLimited(c.req.raw, max);
  if (!raw) return null;
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
}

/** テーマの JS が JSON を待っているか（Accept か本文が JSON。Dawn は Accept: application/javascript で送る） */
function wantsCartJson(c: Ctx): boolean {
  const accept = c.req.header("accept") ?? "";
  return /application\/(json|javascript)/.test(accept) || (c.req.header("content-type") ?? "").includes("application/json");
}

/**
 * updates を当てる。カートにある行は数を変え（0 で外す）、カートに無い SKU に 1 以上を書けば足す（Shopify の update と同じ）。
 * 足すのは公開中の SKU だけで、カートに無い SKU があるときだけ DB に問い合わせる
 */
async function applyUpdates(s: ShopScope, body: Record<string, unknown>): Promise<Cart> {
  const changes = updatesFrom(body, await lineOrder(s, body));
  const inCart = new Set(s.cart.items.map((i) => i.sku_id));
  const fresh = changes.filter((u) => !inCart.has(u.skuId) && u.qty > 0);
  const found = fresh.length > 0 ? await s.sf.skusForCart(s.shop, fresh.map((u) => u.skuId)) : new Map<string, unknown>();
  return changes.reduce((cart, u) => (inCart.has(u.skuId) ? changeQty(cart, u.skuId, u.qty) : u.qty > 0 && found.has(u.skuId) ? addItem(cart, u.skuId, u.qty) : cart), s.cart);
}

/**
 * 行の位置（updates[]・line）を数える並び。位置は画面と /cart.js に出ている行（公開中の SKU、priceCart の結果）で数える。
 * Cookie の行には公開をやめた SKU が残っていることがあり、そのまま数えると見えていない行を変えてしまう。位置を使わない書き方では DB に問い合わせない
 */
async function lineOrder(s: ShopScope, body: Record<string, unknown>): Promise<string[]> {
  if (!usesLinePosition(body) || s.cart.items.length === 0) return s.cart.items.map((i) => i.sku_id);
  return (await priceCart(s.sf, s.shop, s.cart)).lines.map((l) => l.sku.id);
}

const stringFields = (body: Record<string, unknown>): Record<string, string> => Object.fromEntries(Object.entries(body).filter((e): e is [string, string] => typeof e[1] === "string"));

/**
 * /cart.js などの応答（Shopify の cart と同じ形）。sections（本文の sections か ?sections=）があれば、変えた後のカートで描いたセクションも付ける
 * （Liquid のテーマのショップのドメインだけ。Dawn のカートの引き出しが使う）
 */
async function cartJson(c: Ctx, s: ShopScope, cart: Cart, sectionsRaw?: unknown) {
  const { lines, subtotal } = await priceCart(s.sf, s.shop, cart);
  // 値引きはカートのページ（cart.total_price）と同じ。コードが無ければ DB に問い合わせない
  const coupons = cart.coupons?.length ? await cartCoupons(c, { ...s, cart }, lines, subtotal) : null;
  const discounts = coupons ? { applied: coupons.applied, rejected: coupons.rejected, discount: coupons.discount } : null;
  const json = cartObject({ shopPath: s.ctx.shopPath, mediaBaseUrl: mediaBaseUrl(c), optionNames: optionNamesOf(s.shop.option_names), optionSwatches: optionSwatchesOf(s.shop.option_swatches) }, lines, discounts, await cartImagesFor(s.sf, s.shop, lines));
  const sections = sectionsRaw === undefined ? null : await cartSections(c, { ...s, cart }, sectionsRaw, lines, discounts);
  return sections ? { ...json, sections } : json;
}

/** {% form 'cart' %} の送り先: 数を変え、checkout を押したら購入手続きへ */
storefront.post("/:shop/cart", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const body = await cartInput(c);
  const cart = await applyUpdates(s, body);
  if (cart !== s.cart) await writeCart(c, s, cart);
  if ("checkout" in body) return startCheckout(c, { ...s, cart }, stringFields(body));
  return c.redirect(`${s.ctx.shopPath}/cart`);
});

/** 1 行を変える（url_to_remove は GET。カートの中身だけなので Banto の購入リンク（/buy）と同じ扱い） */
const cartChange = async (c: Ctx) => {
  // Dawn などは routes.cart_change_url（.js の付かない URL）に JSON を送り、JSON を受け取る
  if (c.req.method === "POST" && wantsCartJson(c)) return cartChangeJs(c, "change");
  const s = await scope(c);
  if (!s) return notFound(c);
  const body = await cartInput(c);
  const ch = changeFrom(body, await lineOrder(s, body));
  if (ch) await writeCart(c, s, changeQty(s.cart, ch.skuId, ch.qty));
  return c.redirect(`${s.ctx.shopPath}/cart`);
};
storefront.get("/:shop/cart/change", cartChange);
storefront.post("/:shop/cart/change", cartChange);

// AJAX（テーマの JS が fetch で呼ぶ。応答は JSON。Shopify の /cart.js と同じ形）
storefront.get("/:shop/cart.js", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return c.json({ status: 404, message: "not found" }, 404);
  return c.json(await cartJson(c, s, s.cart, c.req.query("sections")), 200, { "cache-control": "no-store" });
});
storefront.post("/:shop/cart/add.js", (c: Ctx) => cartAddJs(c));
async function cartAddJs(c: Ctx): Promise<Response> {
  const s = await scope(c);
  if (!s) return c.json({ status: 404, message: "not found" }, 404);
  const body = await cartInput(c);
  const adds = addsFrom(body);
  if (adds.length === 0) return c.json({ status: 422, message: "invalid", description: "id and quantity are required" }, 422);
  const found = await s.sf.skusForCart(s.shop, adds.map((a) => a.skuId));
  if (adds.some((a) => !found.has(a.skuId))) return c.json({ status: 404, message: "not found", description: "this variant is not available" }, 404);
  if (adds.some((a) => found.get(a.skuId)?.purchasable === false)) return c.json({ status: 422, message: "Cart Error", description: t("store.members_only_buy") }, 422);
  const cart = adds.reduce((cart, a) => addItem(cart, a.skuId, a.qty), s.cart);
  // 在庫を超えるなら入れない（Shopify と同じく 422）
  const { lines } = await priceCart(s.sf, s.shop, cart);
  const short = lines.find((l) => l.short && adds.some((a) => a.skuId === l.sku.id));
  if (short) return c.json({ status: 422, message: "Cart Error", description: tf("store.cart_add_short", { name: short.product.name }) }, 422);
  await writeCart(c, s, cart);
  const json = await cartJson(c, s, cart, body["sections"]);
  const items = json.items.filter((x) => adds.some((a) => a.skuId === x.id));
  const sections = "sections" in json ? { sections: json.sections } : {};
  return c.json(Array.isArray(body["items"]) ? { items, ...sections } : { ...(items[0] ?? {}), ...sections }, 200, { "cache-control": "no-store" });
}
async function cartChangeJs(c: Ctx, kind: "change" | "update" | "clear"): Promise<Response> {
  const s = await scope(c);
  if (!s) return c.json({ status: 404, message: "not found" }, 404);
  const body = kind === "clear" ? {} : await cartInput(c);
  const order = kind === "change" ? await lineOrder(s, body) : [];
  let cart = s.cart;
  if (kind === "clear") cart = { items: [], ...(s.cart.coupons ? { coupons: s.cart.coupons } : {}) };
  else if (kind === "update") cart = await applyUpdates(s, body);
  else {
    const ch = changeFrom(body, order);
    if (!ch) return c.json({ status: 400, message: "invalid", description: "id or line, and quantity are required" }, 400);
    // カートに無い品は変えられない（Shopify と同じく 400。足すのは add.js）
    if (!s.cart.items.some((i) => i.sku_id === ch.skuId)) return c.json({ status: 400, message: "invalid", description: "this item is not in the cart" }, 400);
    cart = changeQty(s.cart, ch.skuId, ch.qty);
  }
  await writeCart(c, s, cart);
  return c.json(await cartJson(c, s, cart, body["sections"]), 200, { "cache-control": "no-store" });
}
storefront.post("/:shop/cart/change.js", (c: Ctx) => cartChangeJs(c, "change"));
storefront.post("/:shop/cart/update.js", (c: Ctx) => cartChangeJs(c, "update"));
storefront.post("/:shop/cart/clear.js", (c: Ctx) => cartChangeJs(c, "clear"));
storefront.post("/:shop/cart/clear", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  await writeCart(c, s, { items: [], ...(s.cart.coupons ? { coupons: s.cart.coupons } : {}) });
  return c.redirect(`${s.ctx.shopPath}/cart`);
});

/** 検索は /products?q=（すべての商品）と /categories/<カテゴリー>?q=（カテゴリーの中）。listResponse を見る */

/**
 * 購入リンク（連携側の「買う」ボタンの行き先）。GET /:shop/buy?sku=<id>&qty=2、または ?items=<id>:2,<id>:1。
 * 今のカートに足してカート画面へ。公開中の SKU だけ受け付ける。docs/headless.md
 */
storefront.get("/:shop/buy", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const wanted: { sku_id: string; qty: number }[] = [];
  const sku = (c.req.query("sku") ?? "").trim();
  if (sku) wanted.push({ sku_id: sku, qty: Number.parseInt(c.req.query("qty") ?? "1", 10) });
  for (const part of (c.req.query("items") ?? "").split(",")) {
    const [id, q] = part.split(":");
    if (id && id.trim()) wanted.push({ sku_id: id.trim(), qty: Number.parseInt(q ?? "1", 10) });
  }
  const valid = wanted.filter((w) => Number.isInteger(w.qty) && w.qty > 0);
  if (valid.length === 0) return c.redirect(`${s.ctx.shopPath}/cart`);
  const found = await s.sf.skusForCart(
    s.shop,
    valid.map((w) => w.sku_id),
  );
  if (valid.some((w) => !found.has(w.sku_id))) return notFound(c, s);
  const linked = normalizeCode(c.req.query("coupon"));
  const cart = valid.reduce((cart, w) => addItem(cart, w.sku_id, w.qty), s.cart);
  await writeCart(c, s, linked && couponSource(c, s.shop) ? addCoupon(cart, linked) : cart);
  return c.redirect(`${s.ctx.shopPath}/cart`);
});

/**
 * カート API（/api/shops/:shop/cart）のトークンをこのブラウザのカートにして、カート画面へ。
 * 連携側の画面でカートを作り、レジ（配送先・最終確認・決済）だけ同梱テーマを使うときの入口。
 */
storefront.get("/:shop/cart/load", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const secret = c.get("sessionSecret");
  const token = c.req.query("cart");
  // 署名が合わないトークンで今のカートを空にしない
  if (secret && token && (await openJson(secret, token)) !== null) await writeCart(c, s, await openCart(secret, token));
  // 貼れるタグの訪問者 ID（0109、お店の行動の中継）はカートの画面へ持ち越す（形の合うものだけ。お店の画面のスクリプトが、まだ無ければ使う）
  const visitor = c.req.query("banto_v");
  return c.redirect(`${s.ctx.shopPath}/cart${visitor && VISITOR_RE.test(visitor) ? `?banto_v=${visitor}` : ""}`);
});

// ---------- チェックアウト ----------
// 配送先入力 → 最終確認（特商法の最終確認画面）→ 在庫予約と決済ページへの転送。計算は src/commerce/checkout.ts

function addressValues(f: Record<string, string>): AddressFormValues {
  const v: AddressFormValues = {};
  for (const k of ADDRESS_FIELDS) if (f[k] !== undefined) v[k] = f[k];
  return v;
}

/** 「購入手続きへ」: 決済手段を選び、配送先入力へ（全決済手段で共通）。確認画面の「修正する」もここに戻る */
storefront.post("/:shop/checkout", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  return startCheckout(c, s, await formFields(c));
});

/** 配送先の画面を出す。決済手段は provider（無ければ使える最初のもの。Liquid のテーマのカートは選ばずに送ってくる） */
async function startCheckout(c: Ctx, s: ShopScope, f: Record<string, string>): Promise<Response> {
  const cartUrl = `${s.ctx.shopPath}/cart`;
  const setup = await paymentOptions(c, s);
  const provider = f.provider ?? (["stripe", "komoju"] as const).find((p) => providerAvailable(setup, p)) ?? "stripe";
  if (!isProvider(provider) || !providerAvailable(setup, provider)) return c.redirect(cartUrl);
  const { lines, total } = await cartLines(s);
  if (lines.length === 0 || lines.some((l) => l.short)) return c.redirect(`${cartUrl}?error=stock`);
  const edited = addressValues(f);
  const values = Object.keys(edited).length > 0 ? edited : await customerPrefill(c, s);
  return addressPage(c, s, { provider, values, subtotal: total, lines });
}

/** 配送先の画面（Liquid のテーマの templates/checkout、無ければ既定のテーマ） */
async function addressPage(c: Ctx, s: ShopScope, p: { provider: string; values: AddressFormValues; subtotal: number; lines: CartLine[]; error?: string; status?: 200 | 400 }): Promise<Response> {
  const props = { provider: p.provider, values: p.values, prefectures: PREFECTURES, shipping: shippingSummary(s.shop), subtotal: p.subtotal, delivery: deliveryOptions(s.shop.settings), consent: consentCollected(s.shop), ...(p.error ? { error: p.error } : {}) };
  const lt = await liquidThemeFor(c, s, { cartLines: p.lines });
  if (lt) {
    const res = renderCheckoutAddress(c, s, lt, { ...props, categories: await s.sf.listCategories(s.shop), ...(p.status ? { status: p.status } : {}) });
    if (res) return res;
  }
  return c.html(s.theme.AddressPage({ ctx: s.ctx, ...props }), p.status ?? 200);
}

/** 最終確認画面（Liquid のテーマの templates/checkout_confirm。{% banto_confirmation %} が無ければ既定のテーマ） */
async function confirmPage(c: Ctx, s: ShopScope, p: { confirmation: Confirmation; quote: string; lines: CartLine[]; error?: string; status?: 200 | 409 }): Promise<Response> {
  // カートの行は見積もりで引いたものを使う（priceCart をもう一度引かない）
  const lt = await liquidThemeFor(c, s, { cartLines: p.lines });
  if (lt) {
    const res = await renderCheckoutConfirm(c, s, lt, { confirmation: p.confirmation, quote: p.quote, ...(p.error ? { error: p.error } : {}), ...(p.status ? { status: p.status } : {}), categories: await s.sf.listCategories(s.shop) });
    if (res) return res;
  }
  return c.html(s.theme.ConfirmPage({ ctx: s.ctx, confirmation: p.confirmation, quote: p.quote, ...(p.error ? { error: p.error } : {}) }), p.status ?? 200);
}

/**
 * 2 段階:
 *   配送先（住所の項目）を受け取ったら → 最終確認画面（署名付きの quote を埋め込む）
 *   quote を受け取ったら → 内容を引き直して一致すれば在庫を予約し、決済ページへ転送する
 */
storefront.post("/:shop/checkout/:provider{stripe|komoju}", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const cartUrl = `${s.ctx.shopPath}/cart`;
  const provider = param(c, "provider") as Provider;
  const setup = await paymentOptions(c, s);
  if (!providerAvailable(setup, provider)) return c.redirect(cartUrl);
  const secret = c.get("sessionSecret");
  if (!secret) return c.redirect(`${cartUrl}?error=config`);
  const base = publicBaseUrl(c);
  const member = s.ctx.membersEnabled ? await customerSession(c, s) : null;
  const qctx = { sf: s.sf, shop: s.shop, secret, baseUrl: base, coupons: couponSource(c, s.shop), member: member ? { id: member.cid } : null, consent: consentCollected(s.shop) };
  const f = await formFields(c);

  // 1. 配送先 → 最終確認画面
  if (f.quote === undefined) {
    const r = await createQuote(qctx, s.cart, provider, f);
    if (!r.ok && r.error === "invalid_address") {
      const { total: subtotal, lines } = await cartLines(s);
      const deliveryError = (r.invalid ?? []).some((k) => k.startsWith("delivery_"));
      return addressPage(c, s, { provider, values: addressValues(f), subtotal, lines, error: t(deliveryError ? "delivery.invalid" : "store.address_invalid"), status: 400 });
    }
    if (!r.ok) return c.redirect(`${cartUrl}?error=${r.error === "minimum_amount" ? "minimum" : "stock"}`);
    const conf = r.confirmation;
    track(c, "checkout_start", conf.total_jpy, conf.lines.map((l) => ({ sku: l.code, name: l.product_name, ...(l.sku_name ? { variant: l.sku_name } : {}), price: l.unit_price_jpy, quantity: l.qty })));
    return confirmPage(c, s, { confirmation: conf, quote: r.token, lines: r.lines });
  }

  // 2. 確認済みの quote → 確定
  const quote = await openQuote(secret, f.quote, s.shop.id);
  if (!quote || quote.provider !== provider) return c.redirect(`${cartUrl}?error=expired`);
  const check = await recheckQuote(qctx, quote);
  if (!check.ok) {
    if (check.error === "changed" && check.fresh.ok) return confirmPage(c, s, { confirmation: check.fresh.confirmation, quote: check.fresh.token, lines: check.fresh.lines, error: t("confirm.changed"), status: 409 });
    return c.redirect(`${cartUrl}?error=stock`);
  }
  const deps = placeOrderDeps(c, setup);
  if (!deps) return c.redirect(`${cartUrl}?error=config`);
  const statusToken = quote.id ? await sealStatusToken(secret, s.shop.id, quote.id) : null;
  const placed = await placeOrder(deps, {
    shop: s.shop,
    quote,
    lines: check.lines,
    subtotal: check.subtotal,
    discount: check.discount,
    // 決済の後はショップのドメインへ戻す（独自ドメインがあればそちら）。照会トークン（0035）を付けて、完了画面で注文番号を出す
    successUrl: statusToken ? withQueryParam(`${shopHome(base, s.shop)}/checkout/done`, "s", statusToken) : `${shopHome(base, s.shop)}/checkout/done`,
    cancelUrl: `${shopHome(base, s.shop)}/cart`,
    ...(member ? { customerId: member.cid, customerEpoch: member.ep } : {}),
    limits: await reserveLimits(secret, quote, await clientIpFor(c, s.shop), member ? { id: member.cid } : null),
  });
  // 全端末からログアウトした後の古いセッション: ログインし直してもらう
  if (!placed.ok && placed.error === "member") return c.redirect(`${s.ctx.shopPath}/account/login`);
  if (!placed.ok) return c.redirect(`${cartUrl}?error=${placed.error}`);
  // 0 円の注文はこの時点で確定している
  return c.redirect(placed.free ? withQueryParam(placed.url, "free", "1") : placed.url, 303);
});

// ---------- 送料ページ・注文照会 ----------
storefront.get("/:shop/shipping", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const { options } = await paymentOptions(c, s);
  return c.html(s.theme.ShippingPage({ ctx: s.ctx, shipping: shippingSummary(s.shop), payments: options }));
});

/**
 * 注文照会（0066）。注文メールのリンクは ?banto_order=<番号>（会員の注文なら &banto_member=1）。
 * 注文照会のページを連携サイトに向けていれば、そこへ同じクエリのまま移す（画面は連携サイトが作る）。
 * 会員の注文: ログイン中ならその注文をそのまま出す。ログインしていなければログインの画面へ送り、ログインした後にこの注文へ戻す。
 * ゲストの注文は番号とメールアドレスで開く（番号だけ埋めておく）
 */
storefront.get("/:shop/orders/lookup", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const number = orderNumberParam(c.req.query("banto_order"));
  const member = c.req.query("banto_member") === "1";
  const page = orderPageUrl(s.shop.settings);
  if (page && URL.canParse(page) && returnOrigins(s.shop.settings).includes(new URL(page).origin)) return c.redirect(number !== null ? orderLink(page, number, member) : page, 302);
  const values = number !== null ? { number: String(number) } : {};
  if (number !== null && member && s.ctx.membersEnabled) {
    const session = await customerSession(c, s);
    if (!session) {
      rememberOrderAfterLogin(c, { shop: s.shop, shopPath: s.ctx.shopPath }, number);
      return c.redirect(`${s.ctx.shopPath}/account/login`);
    }
    const db = privilegedFor(c);
    const result = db ? await db.memberOrder(s.shop.id, session.cid, session.ep, number).catch(() => null) : null;
    if (result) {
      c.header("Cache-Control", "no-store");
      const receipt = moduleEnabled(s.shop.settings, RECEIPT_MODULE) && RECEIPT_STATUSES.includes(String(result["status"]));
      const links = { receiptUrl: receipt ? `${s.ctx.shopPath}/account/orders/${number}/receipt` : null, inquiryUrl: s.ctx.inquiries ? `${s.ctx.shopPath}/inquiries/new?order=${number}` : null };
      return c.html(s.theme.OrderLookupPage({ ctx: s.ctx, values, result, member: links }));
    }
    // 別の会員の注文・ゲストで買った注文: 番号とメールアドレスで開く画面に戻す
  }
  return c.html(s.theme.OrderLookupPage({ ctx: s.ctx, values }));
});

storefront.post("/:shop/orders/lookup", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const f = await formFields(c);
  const number = Number.parseInt((f.number ?? "").trim(), 10);
  const email = (f.email ?? "").trim();
  const values = { number: f.number ?? "", email };
  if (!Number.isInteger(number) || !email) return c.html(s.theme.OrderLookupPage({ ctx: s.ctx, values, error: t("store.lookup_not_found") }), 400);
  const r = await guestOrderLookup(c, s.sf, s.shop, number, email);
  if (!r.ok) return c.html(s.theme.OrderLookupPage({ ctx: s.ctx, values, error: t("store.lookup_too_many") }), 429);
  const result = r.order;
  if (!result) return c.html(s.theme.OrderLookupPage({ ctx: s.ctx, values, error: t("store.lookup_not_found") }), 404);
  // この注文について問い合わせる（同梱モジュール inquiries）: 番号とメールアドレスが合った組を署名して、フォームに POST で渡す
  const secret = c.get("sessionSecret");
  const inquiry = secret && s.ctx.inquiries ? { token: await sealOrderToken(secret, s.shop.id, number, email) } : null;
  return c.html(s.theme.OrderLookupPage({ ctx: s.ctx, values, result, receipt: moduleEnabled(s.shop.settings, RECEIPT_MODULE), inquiry }));
});

/** 領収書（同梱モジュール receipt）。注文照会と同じく注文番号とメールアドレスで引く（GET の URL にメールアドレスを載せない） */
storefront.post("/:shop/orders/receipt", async (c: Ctx) => {
  const s = await scope(c);
  if (!s || !moduleEnabled(s.shop.settings, RECEIPT_MODULE)) return notFound(c);
  const f = await formFields(c);
  const number = Number.parseInt((f.number ?? "").trim(), 10);
  const email = (f.email ?? "").trim();
  const r = Number.isInteger(number) && email ? await guestOrderLookup(c, s.sf, s.shop, number, email) : null;
  if (r && !r.ok) return c.text(t("store.lookup_too_many"), 429);
  const order = (r?.order ?? null) as ReceiptOrder | null;
  if (!order || !RECEIPT_STATUSES.includes(order.status)) return c.text(t("receipt.not_available"), 404);
  c.header("Cache-Control", "no-store");
  // no-referrer にすると、宛名のフォームの POST に Origin: null が付いて csrfGuard に拒まれる（src/routes/storefront/members.ts の privatePage）
  c.header("Referrer-Policy", "same-origin");
  const name = (f.name ?? "").trim().slice(0, 100);
  return c.html(renderReceipt({ shopName: s.shop.name, settings: receiptSettings(s.shop), shopSettings: s.shop.settings, order, addressee: name, issuedAt: new Date(), nameForm: { action: `${s.ctx.shopPath}/orders/receipt`, method: "post", hidden: { number: String(number), email } } }));
});

/** 「確認中」の自動更新を続ける時間。これを過ぎたら「受付済み。メールでお知らせ」の表示に戻す（Webhook が遅れている・届いていない） */
const DONE_REFRESH_WINDOW_SECONDS = 10 * 60;

/**
 * 決済ページから戻ってきた直後。注文確定は Webhook のみ（CLAUDE.md §5）。カート Cookie は消す。
 * 照会トークン（?s=、0035）があれば checkout_status で「確定したか・注文番号」を引いて出す。引けなければ今までどおりの表示
 */
storefront.get("/:shop/checkout/done", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  await writeCart(c, s, { items: [] });
  const free = c.req.query("free") === "1";
  const secret = c.get("sessionSecret");
  const token = secret ? await openStatusToken(secret, c.req.query("s"), s.shop.id) : null;
  const db = token ? privilegedFor(c) : null;
  if (!token || !db) return doneView(c, s, { free });
  try {
    const r = await db.checkoutStatus(s.shop.id, token.quoteId);
    const refresh = r.status === "pending" && Date.now() / 1000 - token.issuedAt < DONE_REFRESH_WINDOW_SECONDS;
    // 確定したときだけ購入とする（注文番号で重ねて数えないのは受け取る側の仕事）
    if (r.status === "confirmed" && r.order) track(c, "purchase", r.order.total_jpy, [], r.order.number);
    // この注文について問い合わせる（同梱モジュール inquiries）: 同じ状態トークンをフォームに渡す（返事は注文時のアドレスへ）
    const inquiryUrl = r.status === "confirmed" && s.ctx.inquiries && inquiriesReady(s.shop, s.theme) ? `${s.ctx.shopPath}/inquiries/new?s=${encodeURIComponent(c.req.query("s") ?? "")}` : null;
    c.header("cache-control", "no-store");
    return doneView(c, s, { free, status: r.status, orderNumber: r.order?.number ?? null, refresh, inquiryUrl });
  } catch (e) {
    console.error("[banto] checkout/done status:", e);
    return doneView(c, s, { free });
  }
});

/** 完了画面（Liquid のテーマの templates/checkout_done、無ければ既定のテーマ）。文言は既定のテーマと同じ */
async function doneView(c: Ctx, s: ShopScope, p: { free: boolean; status?: "pending" | "confirmed" | "released" | "not_found"; orderNumber?: number | null; refresh?: boolean; inquiryUrl?: string | null }): Promise<Response> {
  const lt = await liquidThemeFor(c, s);
  if (lt) {
    const message =
      p.status === "confirmed" && p.orderNumber != null ? tf("store.thanks_confirmed", { n: p.orderNumber }) : p.status === "released" ? t("store.thanks_released") : p.status === "pending" && p.refresh ? t("store.thanks_pending") : p.free ? t("store.thanks_free") : t("store.thanks_body");
    const res = renderCheckoutDone(c, s, lt, { status: p.status ?? "unknown", orderNumber: p.orderNumber ?? null, message, refresh: Boolean(p.status === "pending" && p.refresh), free: p.free, inquiryUrl: p.inquiryUrl ?? null, categories: await s.sf.listCategories(s.shop) });
    if (res) return res;
  }
  return c.html(s.theme.CheckoutDone({ ctx: s.ctx, free: p.free, ...(p.status ? { status: p.status } : {}), ...(p.orderNumber !== undefined ? { orderNumber: p.orderNumber } : {}), ...(p.refresh !== undefined ? { refresh: p.refresh } : {}), ...(p.inquiryUrl !== undefined ? { inquiryUrl: p.inquiryUrl } : {}) }));
}
