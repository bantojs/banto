import { Hono } from "hono";
import { blockedTarget, storefrontSettings } from "../../storefront/mode";
import { recordShopEvent, type ShopEvent, type ShopEventItem } from "../../storefront/events";
import { injectHead, renderHeadTags } from "../../storefront/head";
import { STOREFRONT_HEAD_CONTRIBUTORS } from "../../modules/head";
import type { AppEnv } from "../../app";
import { type StorefrontData, type PublicShop } from "../../storefront/data";
import { shopHome, shopOrigin } from "../../storefront/urls";
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
import { clientIpFor, csrfGuard, formFields, isSecureRequest, mediaBaseUrl, param, publicBaseUrl, readBodyLimited, yen, type Ctx } from "../common";
import { defaultProductsHtml, fillProductBlocks, productBlocksOf } from "../../pages/blocks";
import { couponSource, placeOrderDeps, privilegedFor } from "../payment-deps";
import { normalizeCode } from "../../commerce/discounts";
import { ipHash } from "../../members/auth";
import type { AddressFormValues } from "../../themes/types";
import { ADDRESS_FIELDS, returnOrigins, PREFECTURES, couponNotice, createQuote, discountCart, isProvider, openQuote, paymentSetup, placeOrder, reserveLimits, priceCart, providerAvailable, recheckQuote, shippingSummary, type Confirmation, type PaymentSetup, type Provider, openStatusToken, sealStatusToken, withQueryParam, consentCollected } from "../../commerce/checkout";
import { bindScope, customerPrefill, customerSession, members, membersEnabled, rememberOrderAfterLogin } from "./members";
import { orderLink, orderNumberParam, orderPageUrl } from "../../orders/lookup";
import { guestOrderLookup } from "../order-lookup";
import { liveLegalUrl, type LegalKind } from "../../storefront/legal-links";
import { PAGES_MODULE, pageBodyHtml, pageHandleOk } from "../../pages";
import { bindInquiryScope, inquiries } from "./inquiries";
import { cartImagesFor, cartSections, liquidThemeFor, registerThemeAssets, renderCart, renderCheckoutAddress, renderCheckoutConfirm, renderCheckoutDone, renderContentPage, renderLegalPage, renderListing, renderNotFound, renderProduct, renderSearch } from "./liquid";
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
 *   /:shop                  商品一覧
 *   /:shop/p/:product       商品詳細
 *   /:shop/cart             カート（署名付き Cookie）。/:shop/buy は購入リンク、/:shop/cart/load は API のカートを読み込む
 *   /:shop/legal|privacy|returns  法務ページ
 *   /:shop/pages/:handle  ショップのページ（同梱モジュール pages）
 *   /:shop/checkout         決済手段を選ぶ → 配送先入力 → /:shop/checkout/:provider で最終確認 → 在庫予約と決済ページへ転送
 *   /:shop/shipping, /:shop/orders/lookup  送料案内、注文照会
 */
export const storefront = new Hono<AppEnv>();

storefront.use("*", csrfGuard);
storefront.use("*", redirectToShopDomain);

const data = storefrontData;

/**
 * お店の画面の使い方（0041、src/storefront/mode.ts）と、同梱モジュールの <head> の口（src/storefront/head.ts）。
 * キャッシュ済みのショップ行だけで判定する（このために DB に問い合わせない）。
 *  - 使わない画面: GET は外のサイトへ 302、それ以外は 404
 *  - <head>: ON の同梱モジュールが返す決まった形のタグを、HTML の応答の </head> の前に入れる（ルートが積んだ出来事を渡す）
 */
storefront.use("*", async (c, next) => {
  const m = /^\/([^/]+)(\/.*)?$/.exec(c.req.path);
  const sf = m && !m[1]!.startsWith("_") && !m[1]!.includes(".") ? data(c) : null;
  const shop = sf ? await sf.shopBySlug(decodeURIComponent(m![1]!)).catch(() => null) : null;
  if (!shop) return next();
  const target = blockedTarget(storefrontSettings(shop.settings), m![2] ?? "");
  if (target) {
    if (target === "not_found" || (c.req.method !== "GET" && c.req.method !== "HEAD")) return notFound(c);
    return c.redirect(target, 302);
  }
  await next();
  const contributors = STOREFRONT_HEAD_CONTRIBUTORS.filter((h) => moduleEnabled(shop.settings, h.module));
  if (contributors.length === 0 || !(c.res.headers.get("content-type") ?? "").startsWith("text/html")) return;
  const events = c.get("shopEvents") ?? [];
  const snippet = renderHeadTags(contributors.flatMap((h) => h.tags(shop, events)));
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
  if (ctx.membersEnabled) {
    const member = await customerSession(c, { shop });
    ctx.member = member ? { email: member.email } : null;
  }
  return { shop, sf, cart, ctx, theme };
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
  // ショップのページ（同梱モジュール pages、0079）。お店の画面を使うショップで、モジュールが ON のものだけ問い合わせる
  for (const { shop, home } of entries) {
    if (storefrontSettings(shop.settings).mode !== "full" || !moduleEnabled(shop.settings, PAGES_MODULE)) continue;
    for (const pg of await sf.pageHandles(shop)) urls.push(`${home}/pages/${encodeURIComponent(pg.handle)}`);
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
  return xmlResponse(c, urlset(rows.map(([slug, updated]) => `  <url><loc>${xmlEsc(`${home}/p/${slug}`)}</loc><lastmod>${xmlEsc(updated.slice(0, 10))}</lastmod></url>`)));
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
  const tag = c.req.query("tag") || undefined;
  const categorySlug = c.req.query("category") || undefined;
  const after = c.req.query("after") || undefined;
  const query = { tag, category: categorySlug, limit: STORE_PAGE_SIZE };
  // カテゴリーで絞るときは、子孫まで広げるためにカテゴリーを先に読む（キャッシュ済みなら往復なし）。それ以外は並列
  const categories = await s.sf.listCategories(s.shop);
  const category = categorySlug ? categories.find((x) => x.slug === categorySlug) : undefined;
  if (categorySlug && !category) return notFoundPage(c, s);
  // Liquid のテーマはページの数（paginate.pages）を使うので、全体の数も数える
  const lt = await liquidThemeFor(c, s);
  const [page, facets] = await Promise.all([s.sf.productPage(s.shop, query, categories, { cursor: after, ...(lt ? { count: true } : {}) }), s.sf.productFacets(s.shop, categories)]);
  if (!page) return notFoundPage(c, s);
  const link = (cursor: string | null) => {
    const q = new URLSearchParams();
    if (tag) q.set("tag", tag);
    if (categorySlug) q.set("category", categorySlug);
    if (cursor) q.set("after", cursor);
    const qs = q.toString();
    return `${s.ctx.shopPath || "/"}${qs ? `?${qs}` : ""}`;
  };
  if (lt) {
    const filter = new URLSearchParams();
    if (tag) filter.set("tag", tag);
    if (categorySlug) filter.set("category", categorySlug);
    const qs = filter.toString();
    const res = renderListing(c, s, lt, { page, categories, ...(category ? { category } : {}), ...(tag ? { tag } : {}), tags: facets.tags, link, ...(after ? { after } : {}), path: qs ? `?${qs}` : "" });
    if (res) return res;
  }
  return c.html(
    s.theme.ShopHome({
      ctx: s.ctx,
      products: page.items,
      tag,
      tags: facets.tags,
      categories: categoryTree(categories),
      ...(category ? { category: { slug: category.slug, name: category.name } } : {}),
      pagination: { ...(page.nextCursor ? { next: link(page.nextCursor) } : {}), ...(after ? { first: link(null) } : {}) },
    }),
  );
});

storefront.get("/:shop/p/:product", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const [detail, categories] = await Promise.all([s.sf.productBySlug(s.shop, param(c, "product")), s.sf.listCategories(s.shop)]);
  if (!detail) return notFoundPage(c, s);
  // 品目は SKU の品番（カート・購入手続きと同じ）。商品を見たときは SKU を全部並べる
  const items = detail.skus.map((k) => ({ sku: k.code, name: detail.product.name, ...(k.name ? { variant: k.name } : {}), price: k.price_jpy }));
  const price = items.reduce<number | null>((m, k) => (m === null || k.price < m ? k.price : m), null) ?? 0;
  track(c, "product_view", price, items);
  // カートに入れた直後の商品ページ（?added=1&sku=…&qty=…）。どの SKU かは sku で受ける（無ければ最安の SKU）
  if (c.req.query("added") === "1") {
    const added = items.find((k) => k.sku === c.req.query("sku")) ?? items.find((k) => k.price === price);
    const qty = Math.min(999, Math.max(1, Number.parseInt(c.req.query("qty") ?? "1", 10) || 1));
    if (added) track(c, "cart_add", added.price * qty, [{ ...added, quantity: qty }]);
  }
  const lt = await liquidThemeFor(c, s);
  if (lt) {
    const res = renderProduct(c, s, lt, { detail, categories, categoryNames: categoryPath(categories, detail.product.category_id).map((x) => x.name), selectedSku: c.req.query("sku") ?? null });
    if (res) return res;
  }
  return c.html(
    s.theme.ProductPage({
      ctx: s.ctx,
      detail,
      added: c.req.query("added") === "1",
      // ?sku=<品番> で選んだ SKU（その SKU の画像を先頭に。0063）
      selectedSku: c.req.query("sku") ?? null,
      categoryPath: categoryPath(categories, detail.product.category_id).map((x) => ({ slug: x.slug, name: x.name })),
      attributes: publicAttributes(productFields(s.shop.settings), detail.product.attributes),
    }),
  );
});

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
storefront.get("/:shop/pages/:handle", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  // モジュールの ON/OFF はキャッシュ済みのショップ行で判定する（OFF なら DB に問い合わせない）
  const handle = param(c, "handle");
  if (!moduleEnabled(s.shop.settings, PAGES_MODULE) || !pageHandleOk(handle)) return notFoundPage(c, s);
  const [page, categories] = await Promise.all([s.sf.pageByHandle(s.shop, handle), s.sf.listCategories(s.shop)]);
  if (!page) return notFoundPage(c, s);
  const html = pageBodyHtml(page, s.ctx.mediaBaseUrl);
  // 本文の中の「商品を並べる」（1 ページに 3 つまで、ブロックごとに一覧と同じ問い合わせ 1 回・キャッシュ）。取れなければそのブロックは空
  const blocks = await Promise.all(
    productBlocksOf(page.body).map(async (block) => {
      try {
        const r = await s.sf.productPage(s.shop, { ...(block.category ? { category: block.category } : {}), ...(block.tag ? { tag: block.tag } : {}), sort: block.sort, limit: block.limit }, categories);
        return { block, items: r?.items ?? [] };
      } catch (e) {
        console.error("[banto] page products:", e);
        return { block, items: [] };
      }
    }),
  );
  const cards = blocks.map((b) => defaultProductsHtml(b.items, b.block, { shopPath: s.ctx.shopPath, mediaBaseUrl: s.ctx.mediaBaseUrl, taxNote: t("store.tax_included"), yen }));
  const lt = await liquidThemeFor(c, s);
  if (lt) {
    const res = renderContentPage(c, s, lt, { page, html, categories, blocks, cards });
    if (res) return res;
  }
  if (!s.theme.ContentPage) return notFoundPage(c, s);
  return c.html(s.theme.ContentPage({ ctx: s.ctx, page, html: fillProductBlocks(html, cards) }));
});

storefront.get("/:shop/:page{legal|privacy|returns}", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  const kind = param(c, "page") as LegalKind;
  // 連携サイトのページに向けていて、最後の確認で生きていればそちらへ（0062）。落ちていれば Banto のページを出す
  const external = liveLegalUrl(s.shop.legal_links, kind);
  if (external) return c.redirect(external, 302);
  const page = legalPages[kind]!;
  // Liquid のテーマの templates/page（文面は Banto が作る）。無ければ既定のテーマ
  const lt = await liquidThemeFor(c, s);
  if (lt) {
    const res = renderLegalPage(c, s, lt, { handle: kind, title: page.title(), body: page.pick(s.shop) ?? "", categories: await s.sf.listCategories(s.shop) });
    if (res) return res;
  }
  return c.html(s.theme.LegalPage({ ctx: s.ctx, title: page.title(), body: page.pick(s.shop) ?? "" }));
});

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

function tryonPage(c: Ctx, s: ShopScope, tr: NonNullable<Awaited<ReturnType<typeof tryonScope>>["t"]>, props: Partial<Parameters<NonNullable<ShopScope["theme"]["TryonPage"]>>[0]>, status: 200 | 400 | 409 = 200) {
  const page = s.theme.TryonPage!({
    ctx: s.ctx,
    step: "store",
    lines: tr.lines,
    stores: tr.stores.map((st) => storeView(st, tr.today)),
    settings: { mode: tr.settings.mode, hold_days: tr.settings.hold_days, max_items: tr.settings.max_items, notice: tr.settings.notice },
    values: {},
    ...props,
  });
  return c.html(page, status);
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
  return c.html(
    s.theme.TryonPage({
      ctx: s.ctx,
      step: "done",
      lines: [],
      stores: [],
      store: store ? storeView(store, today) : null,
      settings: { mode: settings.mode, hold_days: settings.hold_days, max_items: settings.max_items, notice: settings.notice },
      values: {},
      number,
    }),
  );
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
  await writeCart(c, s, addItem(s.cart, skuId, qty));
  // sku と qty は「カートに入れた」の出来事用（どの SKU を何点入れたか。src/storefront/events.ts）
  return c.redirect(`${s.ctx.shopPath}/p/${hit.product.slug}?added=1&sku=${encodeURIComponent(hit.sku.code)}&qty=${qty}`);
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
  const json = cartObject({ shopPath: s.ctx.shopPath, mediaBaseUrl: mediaBaseUrl(c) }, lines, discounts, await cartImagesFor(s.sf, s.shop, lines));
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

/** 検索（?q=）。Liquid のテーマは templates/search、既定のテーマは一覧に結果を並べる */
storefront.get("/:shop/search", async (c: Ctx) => {
  const s = await scope(c);
  if (!s) return notFound(c);
  // 100 文字まで（文字で数える。UTF-16 の単位で切ると絵文字の途中で切れる）
  const q = [...(c.req.query("q") ?? "").trim()].slice(0, 100).join("");
  const after = c.req.query("after") || undefined;
  const categories = await s.sf.listCategories(s.shop);
  const lt = await liquidThemeFor(c, s);
  // 2 文字以下の語は探さない（インデックスが効かず全件を見るため。0058 の q_too_short）
  const searchable = [...q].length >= 3;
  const page = searchable ? await s.sf.productPage(s.shop, { q, limit: STORE_PAGE_SIZE }, categories, { cursor: after, ...(lt ? { count: true } : {}) }) : null;
  const link = (cursor: string | null) => {
    const p = new URLSearchParams({ q });
    if (cursor) p.set("after", cursor);
    return `${s.ctx.shopPath}/search?${p.toString()}`;
  };
  if (lt) {
    const res = renderSearch(c, s, lt, { q, page, categories, link, ...(after ? { after } : {}) });
    if (res) return res;
  }
  if (!q) return c.redirect(s.ctx.shopPath || "/");
  const facets = await s.sf.productFacets(s.shop, categories);
  return c.html(
    s.theme.ShopHome({
      ctx: s.ctx,
      products: page?.items ?? [],
      tags: facets.tags,
      categories: categoryTree(categories),
      pagination: { ...(page?.nextCursor ? { next: link(page.nextCursor) } : {}), ...(after ? { first: link(null) } : {}) },
      ...(!searchable ? { notice: t("store.search_too_short") } : page && page.items.length === 0 ? { notice: tf("store.search_none", { q }) } : {}),
    }),
  );
});

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
  return c.redirect(`${s.ctx.shopPath}/cart`);
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
