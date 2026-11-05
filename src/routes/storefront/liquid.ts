/**
 * お店の画面を Liquid のテーマで描く（docs/themes.md）。描けないときは null を返し、呼び出し側は既定のテーマ（TSX）で描く。
 *
 * 描くのは次がそろったときだけ:
 *   - ショップに公開中の版がある（shop_public_get の theme。独自ドメインのあるショップだけに出る、0071）
 *   - ショップのドメインで開いている（Banto の URL では描かない。テーマの JS を管理画面と同じオリジンで動かさない）
 *   - CPU の上限を気にしなくてよい（Workers の有料プラン = サイトの設定 workers_plan が paid、か Node）
 * テーマが壊れている・上限を超えた・その種類のテンプレートが無いときも既定のテーマで描く（お店を止めない）。
 */
import { optionSwatchesOf } from "../../products/option-swatches";
import { optionNamesOf } from "../../products/option-names";
import type { Hono } from "hono";
import type { AppEnv } from "../../app";
import type { CategoryRow, ProductImageRow } from "../../db/types";
import { getLocale, t, tf, type MessageKey } from "../../i18n";
import { categoryTree, type CategoryNode } from "../../products/categories";
import { productJsonLd, jsonLdText } from "../../storefront/structured-data";
import { productReviews } from "../../apps/app-data";
import { type ProductDetail, type ProductListPage, type ProductSummary, type PublicShop, type StorefrontData } from "../../storefront/data";
import { couponSource, privilegedFor } from "../payment-deps";
import { productUrl, shopHome, shopOrigin } from "../../storefront/urls";
import type { AccountPageProps, AddressFormValues, CartLine, ShippingInfo, ThemeContext } from "../../themes/types";
import type { Cart } from "../../cart/cart";
import { ADDRESS_FIELDS, paymentSetup, priceCart, type Confirmation } from "../../commerce/checkout";
import { escapeHtml, SafeHtml, ThemeError } from "../../themes/liquid/engine";
import { ConfirmationBlock } from "../../themes/default/confirmation";
import { AccountBody } from "../../themes/default";
import { assetType } from "../../themes/liquid/bundle";
import { loadTheme, type LoadedTheme } from "../../themes/liquid/cache";
import { extendShopify, fillConfirmation, newConfirmationMark, type Paginate } from "../../themes/liquid/shopify";
import { renderThemePage, renderThemeSections, renderThemeSnippet, themeHasSnippet, themeHasTemplate, themeSettings, type ThemeTemplate } from "../../themes/liquid/page";
import { absoluteMedia, pagePath, pagePublishedAt, pagesNav, type PageRow } from "../../pages";
import { categoryImageOf, categoryMetaDescription } from "../../products/category-media";
import { usesPart } from "../../content/layouts";
import { fillAppBlocks, fillArticleBlocks, fillProductBlocks, type ArticlesBlock, type ProductBlock } from "../../pages/blocks";
import type { AppBlockData } from "../../content/body-blocks";
import { articlePath, articleSummary, blogPath, blogsNav, type ArticleRow, type BlogRow } from "../../blog";
import { sectionLayoutsOf, sectionOverridesOf } from "../../themes/liquid/editor";
import { cartObject, type CartImages, collectionObject, footerMenu, menuFromCategories, money, paymentMethodsObject, productFromDetail, productFromSummary, reviewsLiquid, routesObject, shopObject, type CartDiscounts } from "../../themes/liquid/objects";
import { isSecureRequest, mediaBaseUrl, publicBaseUrl, type Ctx } from "../common";
import { readCookie } from "../../util/signed";
import { openThemePreview, PREVIEW_COOKIE, THEME_PREVIEW_SECONDS, type ThemePreview } from "../../themes/liquid/preview";
import { onShopDomain } from "./domain";
import { themeStorage } from "../../themes/liquid/versions";
import { shopAudiences } from "../audience-render";
import { matchedAudienceNames } from "../../content/audience-blocks";

export interface LiquidScope {
  shop: PublicShop;
  sf: StorefrontData;
  ctx: ThemeContext;
  /** このブラウザのカート（あれば、どのページでも cart.items を渡す。ヘッダーのカートの一覧に使われる） */
  cart?: Cart;
}

/** 描くテーマ。preview は管理画面から開いたプレビュー（公開していない版。誤りをその場所に出し、検索エンジンに載せない） */
export interface LiquidChoice {
  lt: LoadedTheme;
  settings: Record<string, unknown>;
  preview: boolean;
  /** カートの行（カートが空なら []。DB に問い合わせない） */
  cartLines: CartLine[];
  /** お店のオリジンから切り離して描く（AI 用 API の券のプレビュー、SANDBOXED_PREVIEW_CSP）。レジはテーマで描かない */
  sandboxed: boolean;
  /** カートの行の商品の画像（商品の id → 並び順の画像。カートが空なら空。item.image に使う） */
  cartImages: CartImages;
  /** ログイン中の会員が合う会員の条件の名前（同梱モジュール audiences、0097。customer.audiences） */
  audiences?: string[];
}

/** プレビューの版（?preview_theme=<版>&preview_token=… で始め、Cookie で続ける。?preview_theme=off で終わる） */
async function previewVersion(c: Ctx, s: LiquidScope): Promise<ThemePreview | null> {
  const secret = c.get("sessionSecret");
  if (!secret) return null;
  const q = c.req.query("preview_theme");
  const cookie = (token: string, age: number) =>
    c.header("Set-Cookie", `${PREVIEW_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${isSecureRequest(c) ? "; Secure" : ""}`, { append: true });
  if (q === "off") {
    cookie("", 0);
    return null;
  }
  const fromQuery = q ? await openThemePreview(secret, c.req.query("preview_token"), s.shop.id) : null;
  if (fromQuery && fromQuery.version === q) {
    cookie(c.req.query("preview_token")!, THEME_PREVIEW_SECONDS);
    return fromQuery;
  }
  return openThemePreview(secret, readCookie(c.req.header("cookie"), PREVIEW_COOKIE), s.shop.id);
}

/** 描くテーマ（公開中の版か、プレビューの版）。描けないなら null */
export async function liquidThemeFor(c: Ctx, s: LiquidScope, known?: { cartLines: CartLine[] }): Promise<LiquidChoice | null> {
  if (!onShopDomain(c, s.shop)) return null;
  const preview = await previewVersion(c, s);
  if (!preview && !s.shop.theme) return null;
  const adapters = c.get("adapters");
  try {
    const site = await s.sf.siteLiquidCached();
    if (!site.themes || (!adapters.cpuUnlimited && site.plan !== "paid")) return null;
    // プレビューの版にも、管理画面で保存した設定の値を効かせる（0074。券を確かめた後で、その版の settings だけを引く）
    const theme = preview
      ? { id: preview.version, storage_key: `themes/${s.shop.id}/${preview.version}/bundle.json`, settings: (await previewSettings(c, s, preview.version)) ?? {} }
      : s.shop.theme!;
    const lt = await loadTheme(themeStorage(adapters), theme, { extend: extendShopify, timezone: adapters.config.get("BANTO_TIMEZONE") ?? "Asia/Tokyo" });
    if (!lt) return null;
    // カートに品物があるときだけ引く（ヘッダーのカートの一覧。空のカートでは往復を増やさない）
    const cartLines = known ? known.cartLines : s.cart && s.cart.items.length > 0 ? (await priceCart(s.sf, s.shop, s.cart)).lines : [];
    const cartImages = await cartImagesFor(s.sf, s.shop, cartLines);
    // 会員が合う条件の名前（モジュールが OFF・ゲストなら引かない）
    const member = s.ctx.member;
    const audiences = member ? matchedAudienceNames(await shopAudiences(c, s.shop), { member: true, attrs: member.attrs ?? {} }) : [];
    return { lt, settings: theme.settings ?? {}, preview: Boolean(preview), cartLines, sandboxed: Boolean(preview?.sandboxed), cartImages, audiences };
  } catch (e) {
    console.error("[banto] theme load:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** カートの行の商品の画像（行が無ければ DB に問い合わせない。お店の画面の一覧と同じく短く覚える） */
export async function cartImagesFor(sf: StorefrontData, shop: PublicShop, lines: CartLine[]): Promise<CartImages> {
  if (lines.length === 0) return new Map();
  const rows = await sf.cartImages(shop, lines.map((l) => l.product.id));
  const out = new Map<string, ProductImageRow[]>();
  for (const r of rows) out.set(r.product_id, [...(out.get(r.product_id) ?? []), r]);
  return out;
}

async function previewSettings(c: Ctx, s: LiquidScope, versionId: string): Promise<Record<string, unknown> | null> {
  const db = privilegedFor(c);
  if (!db) return null;
  const v = await db.themePreviewSettings(s.shop.id, versionId);
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

interface PageParts {
  template: ThemeTemplate;
  /** そのページだけの値（product・collection・paginate など） */
  values: Record<string, unknown>;
  title: string;
  description?: string;
  /** canonical の後ろ（ショップのトップからのパスと検索の条件） */
  path: string;
  noindex?: boolean;
  jsonLd?: unknown;
  categories: CategoryRow[];
  currentCategory?: string;
  paginate?: Paginate | null;
  status?: 200 | 400 | 404 | 409;
  /**
   * 住所・連絡先が載る画面（レジの配送先・最終確認、会員ページ）: 外のスクリプトを止め（CSP）、覚えさせず、切り離したプレビューではテーマで描かない。
   * confirm は {% banto_confirmation %} を描いたときだけ
   */
  checkout?: "address" | "confirm" | "account";
  /** 最終確認画面: Banto が描いた表示（特商法の項目と確定のボタン）。{% banto_confirmation %} の印の場所に、描き終えてから入れる */
  confirmation?: string;
  /** content_for_header に足すもの（決まった形だけ。完了画面の読み込み直し） */
  headExtra?: string;
  /** 今のショップのページの handle（メニューの active。同梱モジュール pages） */
  currentPage?: string;
}

/**
 * メニューにショップのページ（同梱モジュール pages、0079）を足す: header はメインメニューの後ろ、footer はフッターの前。
 * 一覧はショップ行（shop_public_get の pages_nav）にあるので、DB に問い合わせない
 */
function withPageLinks(lists: { "main-menu": ReturnType<typeof menuFromCategories>; footer: ReturnType<typeof footerMenu> }, shop: PublicShop, shopPath: string, current?: string) {
  const link = (p: { handle: string; title: string }) => ({ title: p.title, url: pagePath(shopPath, p.handle), handle: p.handle, active: p.handle === current, child_active: false, links: [], levels: 0, type: "page_link" });
  const blogLink = (b: { handle: string; title: string }) => ({ title: b.title, url: blogPath(shopPath, b.handle), handle: b.handle, active: false, child_active: false, links: [], levels: 0, type: "blog_link" });
  const header = [...pagesNav(shop, "header").map(link), ...blogsNav(shop, "header").map(blogLink)];
  const footer = [...pagesNav(shop, "footer").map(link), ...blogsNav(shop, "footer").map(blogLink)];
  if (header.length === 0 && footer.length === 0) return lists;
  return {
    "main-menu": { ...lists["main-menu"], links: [...lists["main-menu"].links, ...header] },
    footer: { ...lists.footer, links: [...footer, ...lists.footer.links] },
  };
}

/**
 * レジの画面の CSP（メンテナの決定 2026-10-28、docs/themes.md「レジ」）。住所・連絡先が載る画面なので、スクリプトはショップのドメインのもの
 * （テーマの資産）だけ。インラインのスクリプトと外のスクリプト（分析のタグなど）は動かない。フォームの送り先は決済ページへの転送があるので縛らない
 */
export const CHECKOUT_CSP = "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'";

/**
 * AI 用 API の券で開いたプレビューの CSP。sandbox（allow-same-origin なし）で、ページはお店のオリジンとは別の、名前の無いオリジンになる。
 * テーマの JS は動くが、お店の Cookie（会員・カート）を使った問い合わせや、お店のページの中身の読み取りはできない。
 * 券は開いた人に結ばれないので、リンクを買い物客に渡されてもお店のオリジンで知らない JS を動かさないため
 */
export const SANDBOXED_PREVIEW_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals";

/** ページの値（テーマに渡す shop・settings・cart・routes …）と、描く場所の情報 */
function pageInput(c: Ctx, s: LiquidScope, choice: LiquidChoice, page: PageParts) {
  const { lt } = choice;
  const home = shopHome(publicBaseUrl(c), s.shop);
  const origin = shopOrigin(publicBaseUrl(c), s.shop);
  const shopPath = s.ctx.shopPath;
  const u = { shopPath, mediaBaseUrl: mediaBaseUrl(c), optionNames: optionNamesOf(s.shop.option_names), optionSwatches: optionSwatchesOf(s.shop.option_swatches) };
  const tree: CategoryNode[] = categoryTree(page.categories);
  const canonical = `${home}${page.path}`;
  const head = [
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    page.noindex || choice.preview ? '<meta name="robots" content="noindex">' : "",
    page.headExtra ?? "",
    page.jsonLd ? `<script type="application/ld+json">${jsonLdText(page.jsonLd)}</script>` : "",
  ].join("");
  const intro = typeof s.ctx.themeSettings?.["description"] === "string" ? (s.ctx.themeSettings["description"] as string) : undefined;
  const path = relativePath(c, s);
  const globals: Record<string, unknown> = {
    shop: shopObject(s.shop, home, intro),
    settings: themeSettings(lt, choice.settings),
    routes: routesObject(shopPath, { coupons: couponSource(c, s.shop) !== null }),
    request: { host: new URL(origin).host, path, page_type: page.template.split(".")[0]!, locale: { iso_code: getLocale(), primary: true, root_url: shopPath || "/" }, design_mode: false },
    cart: cartObject(u, choice.cartLines, null, choice.cartImages),
    // attributes は会員の条件で使っている独自項目の値だけ（Cookie に入れたもの、0097）。audiences は合う条件の名前
    customer: s.ctx.member ? { email: s.ctx.member.email, logged_in: true, attributes: s.ctx.member.attrs ?? {}, audiences: choice.audiences ?? [] } : null,
    linklists: withPageLinks(
      {
        "main-menu": menuFromCategories(u, tree, page.currentCategory),
        footer: footerMenu(shopPath, { legal: t("shop.legal_notice"), privacy: t("shop.privacy_policy"), returns: t("shop.return_policy"), shipping: t("shipping.title") }),
      },
      s.shop,
      shopPath,
      page.currentPage,
    ),
    collections: Object.fromEntries([["all", collectionObject(u, { handle: "all", title: s.shop.name, products: [], count: null, allTags: [] })], ...page.categories.map((cat) => [cat.slug, collectionObject(u, { handle: cat.slug, title: cat.name, description: cat.description ?? null, image: categoryImageOf(cat), products: [], count: null, allTags: [] })])]),
    page_title: page.title,
    page_description: page.description ?? intro ?? "",
    canonical_url: canonical,
    ...page.values,
  };
  return { template: page.template, globals, head, paginate: page.paginate ?? null, shopOrigin: origin, shopPath, mediaBaseUrl: u.mediaBaseUrl, preview: choice.preview, overrides: sectionOverridesOf(choice.settings), layouts: sectionLayoutsOf(choice.settings) };
}

/** ?sections=a,b（JSON）か ?section_id=a（HTML）で、セクションだけを返す（Shopify の Section Rendering API） */
function sectionsRequested(c: Ctx): { ids: string[]; single: boolean } | null {
  const one = c.req.query("section_id");
  if (one) return { ids: [one], single: true };
  const many = c.req.query("sections");
  return many ? { ids: many.split(",").map((x) => x.trim()).filter(Boolean), single: false } : null;
}

function sectionsResponse(c: Ctx, choice: LiquidChoice, input: ReturnType<typeof pageInput>, want: { ids: string[]; single: boolean }): Response | null {
  try {
    const out = renderThemeSections(choice.lt, input, want.ids);
    c.header("Cache-Control", "private, no-store");
    if (choice.preview) c.header("X-Robots-Tag", "noindex");
    if (choice.sandboxed) c.header("Content-Security-Policy", SANDBOXED_PREVIEW_CSP);
    if (want.single) {
      const html = out[want.ids[0]!];
      return typeof html === "string" ? c.html(html) : c.text("not found", 404);
    }
    return c.json(out);
  } catch (e) {
    console.error("[banto] theme sections:", e instanceof ThemeError ? `${e.kind}: ${e.message}` : e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * AJAX のカート（/cart/add.js など）に sections があれば、変えた後のカートで描いたセクションを返す（Shopify と同じ。Dawn のカートの引き出しが使う）。
 * 描けない（Liquid のテーマで描いていない）ときは null（応答に sections を付けない）
 */
export async function cartSections(c: Ctx, s: LiquidScope, raw: unknown, lines: CartLine[], discounts: CartDiscounts | null): Promise<Record<string, string | null> | null> {
  const ids = (typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : []).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  if (ids.length === 0) return null;
  const choice = await liquidThemeFor(c, s, { cartLines: lines });
  if (!choice) return null;
  const u = { shopPath: s.ctx.shopPath, mediaBaseUrl: mediaBaseUrl(c), optionNames: optionNamesOf(s.shop.option_names), optionSwatches: optionSwatchesOf(s.shop.option_swatches) };
  const [categories, setup] = await Promise.all([s.sf.listCategories(s.shop), paymentSetup(s.sf, s.shop, c.get("adapters").config)]);
  const cart = { ...cartObject(u, lines, discounts, choice.cartImages), banto_payment_methods: paymentMethodsObject(setup.options, paymentLabel) };
  const input = pageInput(c, s, choice, { template: "cart", values: { cart }, title: t("store.cart"), path: "/cart", noindex: true, categories });
  try {
    return renderThemeSections(choice.lt, input, ids);
  } catch (e) {
    console.error("[banto] theme sections:", e instanceof ThemeError ? `${e.kind}: ${e.message}` : e instanceof Error ? e.message : e);
    return null;
  }
}

/** Liquid のテーマで 1 ページを描いた Response。描けなければ null */
function render(c: Ctx, s: LiquidScope, choice: LiquidChoice, page: PageParts): Response | null {
  const { lt } = choice;
  // 切り離したプレビューでは、レジ（住所・特商法の表示）をテーマで描かない
  if (choice.sandboxed && page.checkout) return null;
  const want = !page.checkout && c.req.method === "GET" ? sectionsRequested(c) : null;
  if (want) return sectionsResponse(c, choice, pageInput(c, s, choice, page), want);
  if (!themeHasTemplate(lt, page.template)) return null;
  // 最終確認画面: 印はリクエストごとの乱数（テーマの変数からは読めない）。描いた結果の印を Banto の表示に差し替える
  const mark = page.checkout === "confirm" ? newConfirmationMark() : null;
  const input = { ...pageInput(c, s, choice, page), ...(mark ? { confirmationMark: mark } : {}) };
  try {
    const r = renderThemePage(lt, input);
    if (!r) return null;
    if (r.errors.length > 0) console.error("[banto] theme sections:", r.errors.slice(0, 5).join(" / "));
    let html = r.html;
    if (mark) {
      // 最終確認画面に Banto の表示（特商法）の印が無ければ描かない（既定のテーマで描く）
      const filled = fillConfirmation(html, mark, page.confirmation ?? "");
      if (filled === null) return null;
      html = filled;
    }
    if (page.checkout) {
      c.header("Content-Security-Policy", CHECKOUT_CSP);
      c.header("Cache-Control", "private, no-store");
    }
    if (!choice.preview) return c.html(html, page.status ?? 200);
    // プレビュー: 帯を出し、覚えさせず、検索エンジンに載せない
    const bar = `<div style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#111;color:#fff;font:14px/1.6 sans-serif;padding:8px 12px">${escapeHtml(t("design.preview_bar"))} <a style="color:#9cf" href="?preview_theme=off">${escapeHtml(t("design.preview_end"))}</a></div>`;
    const i = html.search(/<\/body>/i);
    c.header("Cache-Control", "private, no-store");
    c.header("X-Robots-Tag", "noindex");
    if (choice.sandboxed) c.header("Content-Security-Policy", SANDBOXED_PREVIEW_CSP);
    return c.html(i < 0 ? html + bar : html.slice(0, i) + bar + html.slice(i), page.status ?? 200);
  } catch (e) {
    console.error("[banto] theme render:", e instanceof ThemeError ? `${e.kind}: ${e.message}` : e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * ページ送り。Banto のページ送りは位置（cursor）で進むので、今が何ページ目かは分からない。前は「最初のページ」、次は「次の 1 ページ」。
 * 全体の数が分かれば pages を出す（テーマの {% if paginate.pages > 1 %} が効くように）
 */
function paginateOf(page: ProductListPage, after: string | undefined, link: (cursor: string | null) => string): Paginate {
  const previous = after ? { title: "«", url: link(null), is_link: true as const } : null;
  const next = page.nextCursor ? { title: "»", url: link(page.nextCursor), is_link: true as const } : null;
  const pages = page.total !== null ? Math.max(1, Math.ceil(page.total / page.limit)) : previous || next ? 2 : 1;
  return {
    current_page: after ? 2 : 1,
    page_size: page.limit,
    items: page.total,
    pages,
    previous,
    next,
    parts: [...(previous ? [{ title: "1", url: previous.url, is_link: true }] : []), { title: after ? "…" : "1", url: "", is_link: false }, ...(next ? [{ title: "»", url: next.url, is_link: true }] : [])],
  };
}

/**
 * ひな形の部品（::: current part=…）をテーマの snippets/part-<部品> で描く（docs/themes.md「ひな形の部品」）。
 * ひな形の本文で使っている部品のうち、テーマに snippet があるものだけを描き、無い・誤りのある・空を返さなかった部品は既定の見た目（defaults）のまま。
 * snippet には今の値（商品詳細は product・current_variant、商品一覧は collection・products・current_tags・paginate）と
 * part（name と、Banto の既定の HTML の default）を渡す。part.default を出せば、既定の部品（買うフォームなど）をテーマの枠で包める。
 * 値段・在庫・会員価格・買えるかの判定は今までどおり DB（カートと最終確認で引き直す）で、テーマの部品からは変えられない
 */
export function themeLayoutParts(
  c: Ctx,
  s: LiquidScope,
  choice: LiquidChoice,
  p: { body: string; names: readonly string[]; defaults: Record<string, string>; values: Record<string, unknown>; title: string; path: string; categories: CategoryRow[] },
): Record<string, string> {
  const out = { ...p.defaults };
  const want = p.names.filter((n) => usesPart(p.body, n) && themeHasSnippet(choice.lt, `part-${n}`));
  if (want.length === 0) return out;
  let input: ReturnType<typeof pageInput>;
  try {
    input = pageInput(c, s, choice, { template: "page", values: p.values, title: p.title, path: p.path, categories: p.categories });
  } catch (e) {
    console.error("[banto] theme layout parts:", e instanceof Error ? e.message : e);
    return out;
  }
  for (const n of want) {
    try {
      const html = renderThemeSnippet(choice.lt, input, `part-${n}`, { ...p.values, part: { name: n, default: new SafeHtml(p.defaults[n] ?? "") } });
      if (html !== null) out[n] = html;
    } catch (e) {
      console.error(`[banto] theme part-${n}:`, e instanceof ThemeError ? `${e.kind}: ${e.message}` : e instanceof Error ? e.message : e);
    }
  }
  return out;
}

/** 商品詳細のひな形の部品に渡す値（templates/product と同じ product・current_variant） */
export function productPartValues(c: Ctx, s: LiquidScope, detail: ProductDetail, selectedSku: string | null): Record<string, unknown> {
  const u = { shopPath: s.ctx.shopPath, mediaBaseUrl: mediaBaseUrl(c), optionNames: optionNamesOf(s.shop.option_names), optionSwatches: optionSwatchesOf(s.shop.option_swatches) };
  const product = productFromDetail(u, detail, selectedSku);
  return { product, current_variant: product.selected_or_first_available_variant };
}

/** 商品一覧のひな形の部品に渡す値（templates/collection と同じ collection・products・current_tags と paginate） */
export function collectionPartValues(
  c: Ctx,
  s: LiquidScope,
  p: { page: ProductListPage; category?: CategoryRow; tag?: string; tags: { tag: string; count: number }[]; link: (cursor: string | null) => string; after?: string },
): Record<string, unknown> {
  const u = { shopPath: s.ctx.shopPath, mediaBaseUrl: mediaBaseUrl(c), optionNames: optionNamesOf(s.shop.option_names), optionSwatches: optionSwatchesOf(s.shop.option_swatches) };
  const products = p.page.items.map((x) => productFromSummary(u, x));
  const collection = collectionObject(u, {
    handle: p.category?.slug ?? "all",
    title: p.category?.name ?? t("store.all_products"),
    description: p.category?.description ?? null,
    image: p.category ? categoryImageOf(p.category) : null,
    products,
    count: p.page.total,
    allTags: p.tags.map((x) => x.tag),
    ...(p.tag ? { currentTags: [p.tag] } : {}),
  });
  return { collection, products, current_tags: p.tag ? [p.tag] : [], paginate: paginateOf(p.page, p.after, p.link) };
}

/**
 * 商品の一覧（お店のトップ・すべての商品・カテゴリーの一覧、タグ・検索の語・ページ送り付き）。
 * テンプレートは、検索の語があればテーマの templates/search（任意。無ければ collection）、トップは templates/index（無ければ collection）、ほかは templates/collection。
 * どのテンプレートにも collection・products・current_tags と、検索の語があれば search（terms・results・results_count・performed・too_short）を渡す
 */
export function renderListing(
  c: Ctx,
  s: LiquidScope,
  choice: LiquidChoice,
  p: { page: ProductListPage; categories: CategoryRow[]; category?: CategoryRow; tag?: string; search?: { q: string; performed: boolean }; top: boolean; tags: { tag: string; count: number }[]; link: (cursor: string | null) => string; after?: string; path: string },
): Response | null {
  const u = { shopPath: s.ctx.shopPath, mediaBaseUrl: mediaBaseUrl(c), optionNames: optionNamesOf(s.shop.option_names), optionSwatches: optionSwatchesOf(s.shop.option_swatches) };
  const products = p.page.items.map((x) => productFromSummary(u, x));
  const collection = collectionObject(u, {
    handle: p.category?.slug ?? "all",
    title: p.category?.name ?? (p.tag ? `#${p.tag}` : p.top ? s.shop.name : t("store.all_products")),
    description: p.category?.description ?? null,
    image: p.category ? categoryImageOf(p.category) : null,
    products,
    count: p.page.total,
    allTags: p.tags.map((x) => x.tag),
    ...(p.tag ? { currentTags: [p.tag] } : {}),
  });
  const paginate = paginateOf(p.page, p.after, p.link);
  // 短すぎる語（3 文字未満で、カテゴリー・タグでも絞っていない）は探さない。performed は false にし、too_short（Banto の名前）で案内を出せるように
  const search = p.search
    ? { performed: p.search.performed, terms: p.search.q, too_short: !p.search.performed, results: products.map((x) => ({ ...x, object_type: "product" })), results_count: p.page.total ?? products.length, types: ["product"], filters: [], sort_by: null, sort_options: [] }
    : null;
  const template: ThemeTemplate = search && themeHasTemplate(choice.lt, "search") ? "search" : p.top && !p.tag && !search && themeHasTemplate(choice.lt, "index") ? "index" : "collection";
  return render(c, s, choice, {
    template,
    values: { collection, products, current_tags: p.tag ? [p.tag] : [], ...(search ? { search } : {}) },
    title: search ? (search.terms ? `${t("store.search")}: ${search.terms}` : t("store.search")) : p.top ? s.shop.name : collection.title,
    ...(p.category && categoryMetaDescription(p.category.description) ? { description: categoryMetaDescription(p.category.description)! } : {}),
    path: p.path,
    noindex: Boolean(p.after || search),
    categories: p.categories,
    ...(p.category ? { currentCategory: p.category.slug } : {}),
    paginate,
  });
}

/** 商品の構造化データ（Liquid の商品ページと、商品詳細のひな形で同じ） */
export function liquidProductJsonLd(c: Ctx, s: LiquidScope, p: { detail: ProductDetail; categoryNames: string[]; selectedSku: string | null }): { jsonLd: unknown; path: string } {
  const u = { shopPath: s.ctx.shopPath, mediaBaseUrl: mediaBaseUrl(c), optionNames: optionNamesOf(s.shop.option_names), optionSwatches: optionSwatchesOf(s.shop.option_swatches) };
  const product = productFromDetail(u, p.detail, p.selectedSku);
  const home = shopHome(publicBaseUrl(c), s.shop);
  const path = productUrl("", p.detail.product.slug);
  const jsonLd = productJsonLd({
    url: `${home}${path}`,
    product: p.detail.product,
    images: product.images.map((i) => String(i["src"])),
    skus: p.detail.skus,
    category: p.categoryNames,
    reviews: productReviews(p.detail.product),
  });
  return { jsonLd, path };
}

export function renderProduct(c: Ctx, s: LiquidScope, choice: LiquidChoice, p: { detail: ProductDetail; categories: CategoryRow[]; categoryNames: string[]; selectedSku: string | null }): Response | null {
  const u = { shopPath: s.ctx.shopPath, mediaBaseUrl: mediaBaseUrl(c), optionNames: optionNamesOf(s.shop.option_names), optionSwatches: optionSwatchesOf(s.shop.option_swatches) };
  const product = productFromDetail(u, p.detail, p.selectedSku);
  const { jsonLd, path } = liquidProductJsonLd(c, s, p);
  return render(c, s, choice, {
    template: "product",
    values: { product, current_variant: product.selected_or_first_available_variant },
    title: p.detail.product.name,
    ...(p.detail.product.description ? { description: p.detail.product.description.slice(0, 200) } : {}),
    path,
    jsonLd,
    categories: p.categories,
  });
}

/** 決済手段の表示名（既定のテーマのカートのボタンと同じ文言） */
const paymentLabel = (p: "stripe" | "komoju"): string => t(p === "stripe" ? "store.pay_with_stripe" : "store.pay_with_komoju");

/** カートのページ（templates/cart）。テーマに無ければ null（既定のテーマで描く）。payments は使える決済手段（cart.banto_payment_methods） */
export function renderCart(c: Ctx, s: LiquidScope, choice: LiquidChoice, p: { lines: CartLine[]; discounts: CartDiscounts | null; payments: { stripe: boolean; komoju: boolean }; error?: string; categories: CategoryRow[] }): Response | null {
  const u = { shopPath: s.ctx.shopPath, mediaBaseUrl: mediaBaseUrl(c), optionNames: optionNamesOf(s.shop.option_names), optionSwatches: optionSwatchesOf(s.shop.option_swatches) };
  const cart = { ...cartObject(u, p.lines, p.discounts, choice.cartImages), banto_payment_methods: paymentMethodsObject(p.payments, paymentLabel) };
  return render(c, s, choice, { template: "cart", values: { cart, cart_error: p.error ?? null }, title: t("store.cart"), path: "/cart", noindex: true, categories: p.categories });
}

/** 配送先の画面（templates/checkout）。checkout に値・都道府県・お届け日時・誤りを渡し、{% form 'checkout_address' %} で送らせる */
export function renderCheckoutAddress(
  c: Ctx,
  s: LiquidScope,
  choice: LiquidChoice,
  p: { provider: string; values: AddressFormValues; prefectures: readonly string[]; shipping: ShippingInfo; subtotal: number; error?: string; delivery?: { dates: { value: string; label: string }[]; slots: { value: string; label: string }[] } | null; consent?: boolean; categories: CategoryRow[]; status?: 200 | 400 },
): Response | null {
  const fee = (pref: string) => p.shipping.table?.find((x) => x.prefecture === pref)?.fee;
  const checkout = {
    provider: p.provider,
    values: Object.fromEntries(ADDRESS_FIELDS.map((k) => [k, p.values[k] ?? ""]).concat([["marketing_consent", p.values.marketing_consent ?? ""]])),
    error: p.error ?? null,
    subtotal_price: money(p.subtotal),
    shipping_summary: p.shipping.summary,
    free_shipping_over: p.shipping.freeOver === null ? null : money(p.shipping.freeOver),
    free_shipping_applied: p.shipping.freeOver !== null && p.subtotal >= p.shipping.freeOver,
    prefectures: p.prefectures.map((name) => ({ name, shipping_price: fee(name) === undefined ? null : money(fee(name)) })),
    delivery: p.delivery ? { dates: p.delivery.dates, slots: p.delivery.slots, note: t("delivery.note") } : null,
    marketing_consent: Boolean(p.consent),
    cart_url: `${s.ctx.shopPath}/cart`,
  };
  return render(c, s, choice, { template: "checkout", values: { checkout }, title: t("store.address_title"), path: "/checkout", noindex: true, categories: p.categories, checkout: "address", ...(p.status ? { status: p.status } : {}) });
}

/**
 * 最終確認画面（templates/checkout_confirm）。表示の項目は Banto が描く {% banto_confirmation %}（同梱テーマと同じ部品）。
 * テーマはその外側（見出し・注文の要約・案内）を作る。checkout.confirmation は要約に使う値（金額は 100 倍の整数）
 */
export async function renderCheckoutConfirm(c: Ctx, s: LiquidScope, choice: LiquidChoice, p: { confirmation: Confirmation; quote: string; error?: string; categories: CategoryRow[]; status?: 200 | 409 }): Promise<Response | null> {
  const cf = p.confirmation;
  const block = await Promise.resolve(ConfirmationBlock({ shopPath: s.ctx.shopPath, confirmation: cf, quote: p.quote, ...(p.error ? { error: p.error } : {}) }).toString());
  const checkout = {
    provider: cf.payment.provider,
    error: p.error ?? null,
    confirmation: {
      lines: cf.lines.map((l) => ({ title: l.product_name, variant_title: l.sku_name, sku: l.code, quantity: l.qty, price: money(l.unit_price_jpy), line_price: money(l.line_total_jpy), reduced_tax: l.reduced })),
      subtotal_price: money(cf.subtotal_jpy),
      shipping_price: money(cf.shipping_jpy),
      total_discount: money(cf.discount_jpy),
      total_price: money(cf.total_jpy),
      payment_method: cf.payment.method,
      free: Boolean(cf.payment.free),
    },
    cart_url: `${s.ctx.shopPath}/cart`,
  };
  return render(c, s, choice, {
    template: "checkout_confirm",
    values: { checkout },
    confirmation: block,
    title: t("confirm.title"),
    path: "/checkout",
    noindex: true,
    categories: p.categories,
    checkout: "confirm",
    ...(p.status ? { status: p.status } : {}),
  });
}

/** 法務のページ（templates/page。特定商取引法に基づく表記・プライバシーポリシー・返品）。page.content は Banto が文面から作る（改行を残してエスケープ） */
export function renderLegalPage(c: Ctx, s: LiquidScope, choice: LiquidChoice, p: { handle: string; title: string; body: string; categories: CategoryRow[] }): Response | null {
  const content = new SafeHtml(`<div class="banto-legal">${escapeHtml(p.body).replace(/\r?\n/g, "<br>")}</div>`);
  const page = { id: p.handle, handle: p.handle, title: p.title, content, url: `${s.ctx.shopPath}/${p.handle}`, template_suffix: null };
  return render(c, s, choice, { template: "page", values: { page }, title: p.title, path: `/${p.handle}`, categories: p.categories });
}

/** 購入の完了画面（templates/checkout_done）。checkout.status は confirmed / pending / released / not_found / unknown（照会できないとき）、確定していれば order_number */
export function renderCheckoutDone(c: Ctx, s: LiquidScope, choice: LiquidChoice, p: { status: string; orderNumber: number | null; message: string; refresh: boolean; free: boolean; inquiryUrl: string | null; categories: CategoryRow[] }): Response | null {
  const checkout = { status: p.status, order_number: p.orderNumber, message: p.message, free: p.free, inquiry_url: p.inquiryUrl, continue_url: s.ctx.shopPath || "/" };
  return render(c, s, choice, { template: "checkout_done", values: { checkout }, title: t("store.thanks_title"), path: "/checkout/done", noindex: true, categories: p.categories, ...(p.refresh ? { headExtra: '<meta http-equiv="refresh" content="4">' } : {}) });
}

/**
 * 会員ページ（templates/customers/account）。customer は Shopify に近い形（email・name・orders・default_address）。
 * 住所の保存・ログインの方法・クーポン・ログアウト・退会などは {% banto_account %} が Banto の部品として描く（既定のテーマと同じもの）
 */
export async function renderAccount(c: Ctx, s: LiquidScope, choice: LiquidChoice, props: AccountPageProps): Promise<Response | null> {
  const block = await Promise.resolve(AccountBody({ ...props, strict: true }).toString());
  const orders = props.orders.map((o) => ({
    id: o["number"],
    name: `#${String(o["number"])}`,
    order_number: o["number"],
    created_at: o["created_at"],
    financial_status: o["status"],
    status: o["status"],
    status_label: t(`order.status.${String(o["status"])}` as MessageKey),
    total_price: money(Number(o["total_jpy"] ?? 0)),
    url: `${s.ctx.shopPath}/orders/lookup?banto_order=${encodeURIComponent(String(o["number"]))}&banto_member=1`,
  }));
  const customer = props.customer
    ? { email: props.customer.email, name: props.customer.name, first_name: props.customer.name, default_address: props.customer.default_address, accepts_marketing: props.customer.marketing_consent === true, orders, orders_count: orders.length, has_account: true }
    : null;
  return render(c, s, choice, { template: "customers/account", values: { customer, __banto_account: new SafeHtml(block) }, title: t("member.account"), path: "/account", noindex: true, categories: await s.sf.listCategories(s.shop), checkout: "account" });
}

/** ショップのページ（同梱モジュール pages、0079、/pages/<handle>）。templates/page.<suffix> があればそれ、無ければ templates/page */
/** path: canonical のパス（ひな形、0101。お店のトップは ""・記事は /blogs/…。無ければ /pages/<handle>） */
export function renderContentPage(c: Ctx, s: LiquidScope, choice: LiquidChoice, p: { page: PageRow; html: string; categories: CategoryRow[]; blocks?: { block: ProductBlock; items: ProductSummary[] }[]; cards?: string[]; path?: string; jsonLd?: unknown; noindex?: boolean } & ArticleBlocks): Response | null {
  const pg = p.page;
  const suffixed = pg.template_suffix ? (`page.${pg.template_suffix}` as const) : null;
  const template: ThemeTemplate = suffixed && themeHasTemplate(choice.lt, suffixed) ? suffixed : "page";
  // アイキャッチ画像（0080）: page.image と、Shopify と同じ page_image（テーマが OG の画像に使う）
  const img = pg.image_url ? absoluteMedia(pg.image_url, s.ctx.publicBaseUrl) : null;
  const image = img ? { src: img, url: img, alt: pg.title } : null;
  const parts = (html: string): PageParts => ({
    template,
    values: { page: { id: pg.id, handle: pg.handle, title: pg.title, content: new SafeHtml(html), url: pagePath(s.ctx.shopPath, pg.handle), template_suffix: pg.template_suffix, published_at: pagePublishedAt(pg), updated_at: pg.updated_at, image }, ...(image ? { page_image: image } : {}) },
    title: pg.seo_title || pg.title,
    ...(pg.seo_description ? { description: pg.seo_description } : {}),
    path: p.path ?? `/pages/${encodeURIComponent(pg.handle)}`,
    categories: p.categories,
    ...(p.path === undefined ? { currentPage: pg.handle } : {}),
    ...(p.jsonLd ? { jsonLd: p.jsonLd } : {}),
    ...(p.noindex ? { noindex: true } : {}),
  });
  return render(c, s, choice, parts(withAppBlocks(c, s, choice, parts, withArticleBlocks(c, s, choice, parts, withProductBlocks(c, s, choice, parts, p.html, p.blocks, p.cards), p), p)));
}

type ArticleBlocks = { ablocks?: ({ block: ArticlesBlock; blog: BlogRow; items: ArticleRow[] } | null)[]; acards?: string[]; apps?: (AppBlockData | null)[]; appCards?: string[] };

/**
 * 本文の外部プラグインのブロック（0086）の場所に中身を入れる: snippets/app-<プラグイン>-<ブロック> → app-<ブロック> の順に探して描き
 * （block・product・reviews・data を渡す）、どちらも無ければ既定の見た目（reviews.v1 だけ。custom.v1 は空）
 */
function withAppBlocks(c: Ctx, s: LiquidScope, choice: LiquidChoice, parts: (html: string) => PageParts, html: string, p: ArticleBlocks): string {
  const cards = p.appCards ?? [];
  const names = (p.apps ?? []).map((b) => (b ? [`app-${b.block.app}-${b.block.block}`, `app-${b.block.block}`].find((n) => themeHasSnippet(choice.lt, n)) ?? null : null));
  if (!names.some(Boolean)) return fillAppBlocks(html, cards);
  let rendered = cards;
  try {
    const input = pageInput(c, s, choice, parts(html));
    const sp = s.ctx.shopPath;
    rendered = cards.map((card, i) => {
      const b = p.apps?.[i];
      const name = names[i];
      if (!b || !name) return card;
      const product = { id: b.product.id, handle: b.product.slug, title: b.product.name, url: productUrl(sp, b.product.slug) };
      const block = { app: b.block.app, id: b.block.block, settings: b.block.settings, style: b.block.style, index: i };
      return renderThemeSnippet(choice.lt, input, name, { block, product, reviews: reviewsLiquid(b.reviews), data: b.data }) ?? card;
    });
  } catch (e) {
    console.error("[banto] theme app block:", e instanceof ThemeError ? `${e.kind}: ${e.message}` : e instanceof Error ? e.message : e);
  }
  return fillAppBlocks(html, rendered);
}

/**
 * 本文の「記事を並べる」の場所に中身を入れる: テーマに snippets/page-articles があればそれで描き（articles・block・blog を渡す）、
 * 無ければ既定のカード（acards）
 */
function withArticleBlocks(c: Ctx, s: LiquidScope, choice: LiquidChoice, parts: (html: string) => PageParts, html: string, p: ArticleBlocks): string {
  if (!p.ablocks?.length || !themeHasSnippet(choice.lt, "page-articles")) return fillArticleBlocks(html, p.acards ?? []);
  let rendered = p.acards ?? [];
  try {
    const input = pageInput(c, s, choice, parts(html));
    const sp = s.ctx.shopPath;
    rendered = (p.acards ?? []).map((card, i) => {
      const b = p.ablocks?.[i];
      if (!b) return card;
      const out = renderThemeSnippet(choice.lt, input, "page-articles", { articles: b.items.map((a) => articleObject(sp, b.blog, a, "", s.ctx.publicBaseUrl)), blog: blogObject(sp, b.blog), block: { ...b.block, index: i } });
      return out ?? card;
    });
  } catch (e) {
    console.error("[banto] theme page-articles:", e instanceof ThemeError ? `${e.kind}: ${e.message}` : e instanceof Error ? e.message : e);
  }
  return fillArticleBlocks(html, rendered);
}

type BodyBlocks = { block: ProductBlock; items: ProductSummary[] }[];

/**
 * 本文の「商品を並べる」の場所に中身を入れる（ページと記事で共通）: テーマに snippets/page-products があればそれで描き
 * （products・block を渡す）、無ければ既定のカード（cards）
 */
function withProductBlocks(c: Ctx, s: LiquidScope, choice: LiquidChoice, parts: (html: string) => PageParts, html: string, blocks?: BodyBlocks, cards?: string[]): string {
  if (!blocks?.length) return fillProductBlocks(html, []);
  const u = { shopPath: s.ctx.shopPath, mediaBaseUrl: mediaBaseUrl(c), optionNames: optionNamesOf(s.shop.option_names), optionSwatches: optionSwatchesOf(s.shop.option_swatches) };
  let rendered = cards ?? [];
  if (themeHasSnippet(choice.lt, "page-products")) {
    try {
      const input = pageInput(c, s, choice, parts(html));
      rendered = blocks.map((b, i) => {
        const out = renderThemeSnippet(choice.lt, input, "page-products", { products: b.items.map((x) => productFromSummary(u, x)), block: { ...b.block, index: i } });
        return out ?? cards?.[i] ?? "";
      });
    } catch (e) {
      console.error("[banto] theme page-products:", e instanceof ThemeError ? `${e.kind}: ${e.message}` : e instanceof Error ? e.message : e);
    }
  }
  return fillProductBlocks(html, rendered);
}

/** templates/<種類>.<suffix> があればそれ、無ければ templates/<種類> */
function suffixedTemplate(lt: LoadedTheme, kind: "blog" | "article", suffix: string | null): ThemeTemplate {
  const t2 = suffix ? (`${kind}.${suffix}` as const) : null;
  return t2 && themeHasTemplate(lt, t2) ? t2 : kind;
}

/** ブログ（Liquid の blog。記事の一覧は blog.articles） */
function blogObject(shopPath: string, b: BlogRow, extra: Record<string, unknown> = {}) {
  return { id: b.id, handle: b.handle, title: b.title, url: blogPath(shopPath, b.handle), description: b.description ?? "", template_suffix: b.template_suffix, comments_enabled: false, moderated: false, ...extra };
}

/** 記事（Liquid の article）。content は本文の HTML（一覧では空）、excerpt は抜粋か本文の頭の文字 */
function articleObject(shopPath: string, blog: BlogRow, a: ArticleRow, content: string, origin?: string) {
  const img = a.image_url ? absoluteMedia(a.image_url, origin) : null;
  const image = img ? { src: img, url: img, alt: a.title } : null;
  const excerpt = articleSummary(a);
  return {
    id: a.id,
    handle: a.handle,
    title: a.title,
    url: articlePath(shopPath, blog.handle, a.handle),
    content: new SafeHtml(content),
    excerpt,
    excerpt_or_content: content ? new SafeHtml(content) : excerpt,
    image,
    tags: a.tags,
    author: a.author ?? "",
    published_at: a.published_at ?? a.updated_at,
    created_at: a.published_at ?? a.updated_at,
    updated_at: a.updated_at,
    template_suffix: a.template_suffix,
    blog_handle: blog.handle,
    comments: [],
    comments_count: 0,
  };
}

/** ブログの記事の一覧（同梱モジュール blog、0081、/blogs/<handle>）。templates/blog.<suffix> か templates/blog */
type BlogListInput = { blog: BlogRow; articles: { article: ArticleRow; summary: string }[]; tag: string | null; tags: string[]; pageNo: number; newer: string | null; older: string | null };

/** ブログの一覧のひな形の部品に渡す値（templates/blog と同じ blog・articles・current_tags・paginate、0114） */
export function blogPartValues(s: LiquidScope, p: BlogListInput): Record<string, unknown> {
  const v = blogListValues(s, p);
  return { blog: v.blog, articles: v.articles, current_tags: p.tag ? [p.tag] : [], paginate: v.paginate };
}

function blogListValues(s: LiquidScope, p: BlogListInput) {
  const sp = s.ctx.shopPath;
  const articles = p.articles.map(({ article }) => articleObject(sp, p.blog, article, "", s.ctx.publicBaseUrl));
  const paginate: Paginate = {
    current_page: p.pageNo,
    page_size: articles.length,
    items: null,
    pages: p.older ? p.pageNo + 1 : p.pageNo,
    previous: p.newer ? { title: "«", url: p.newer, is_link: true } : null,
    next: p.older ? { title: "»", url: p.older, is_link: true } : null,
    parts: [],
  };
  const blog = blogObject(sp, p.blog, { articles, articles_count: articles.length, all_tags: p.tags, tags: p.tags });
  return { articles, paginate, blog };
}

export function renderBlogPage(c: Ctx, s: LiquidScope, choice: LiquidChoice, p: BlogListInput & { categories: CategoryRow[] }): Response | null {
  const { blog, paginate } = blogListValues(s, p);
  return render(c, s, choice, {
    template: suffixedTemplate(choice.lt, "blog", p.blog.template_suffix),
    // paginate は {% paginate blog.articles by … %} の中と外のどちらでも読める（Banto が 1 ページの数を決める）
    values: { blog, current_tags: p.tag ? [p.tag] : [], paginate },
    title: p.tag ? `${tf("blog.tagged", { tag: p.tag })} | ${p.blog.title}` : p.blog.seo_title || p.blog.title,
    ...(p.blog.seo_description || p.blog.description ? { description: p.blog.seo_description || p.blog.description || "" } : {}),
    path: `/blogs/${encodeURIComponent(p.blog.handle)}`,
    noindex: Boolean(p.tag),
    categories: p.categories,
    paginate,
  });
}

/** ブログの記事（/blogs/<ブログ>/<handle>）。templates/article.<suffix> か templates/article */
export function renderArticlePage(c: Ctx, s: LiquidScope, choice: LiquidChoice, p: { blog: BlogRow; article: ArticleRow; html: string; categories: CategoryRow[]; blocks?: BodyBlocks; cards?: string[] } & ArticleBlocks): Response | null {
  const a = p.article;
  const sp = s.ctx.shopPath;
  const parts = (html: string): PageParts => {
    const article = articleObject(sp, p.blog, a, html, s.ctx.publicBaseUrl);
    return {
      template: suffixedTemplate(choice.lt, "article", a.template_suffix),
      values: { article, blog: blogObject(sp, p.blog), ...(article.image ? { page_image: article.image } : {}) },
      title: a.seo_title || a.title,
      ...(a.seo_description || a.excerpt ? { description: a.seo_description || a.excerpt || "" } : {}),
      path: `/blogs/${encodeURIComponent(p.blog.handle)}/${encodeURIComponent(a.handle)}`,
      categories: p.categories,
    };
  };
  return render(c, s, choice, parts(withAppBlocks(c, s, choice, parts, withArticleBlocks(c, s, choice, parts, withProductBlocks(c, s, choice, parts, p.html, p.blocks, p.cards), p), p)));
}

export function renderNotFound(c: Ctx, s: LiquidScope, choice: LiquidChoice, categories: CategoryRow[]): Response | null {
  return render(c, s, choice, { template: "404", values: {}, title: t("store.not_found"), path: relativePath(c, s), noindex: true, categories, status: 404 });
}

/** ショップのトップからのパス（独自ドメインでは domain.ts がパスの前にスラッグを足して処理しているので、それを外す） */
function relativePath(c: Ctx, s: LiquidScope): string {
  const p = new URL(c.req.url).pathname;
  const prefix = `/${s.shop.slug}`;
  if (s.ctx.shopPath === "" && (p === prefix || p.startsWith(`${prefix}/`))) return p.slice(prefix.length) || "/";
  return p;
}

/**
 * テーマの資産（CSS・JS・画像・フォント）。ショップのドメインでだけ配る（Banto の URL では 404）。
 * 公開中の版は置き場が版ごとに違い中身は変わらないので、長く覚えてよい。公開していない版（プレビュー・取り込みの途中）は
 * 中身を置き換えられるので覚えさせない
 */
export function registerThemeAssets(app: Hono<AppEnv>, scopeOf: (c: Ctx) => Promise<LiquidScope | null>): void {
  app.get("/:shop/_theme/:version/assets/:name", async (c) => {
    const s = await scopeOf(c);
    const version = c.req.param("version");
    const name = c.req.param("name");
    const type = assetType(name);
    if (!s || !type || !onShopDomain(c, s.shop) || !/^[0-9a-f-]{36}$/.test(version)) return c.notFound();
    const obj = await themeStorage(c.get("adapters")).get(`themes/${s.shop.id}/${version}/assets/${name}`);
    if (!obj) return c.notFound();
    const live = s.shop.theme?.id === version;
    return new Response(obj.body, {
      headers: {
        "Content-Type": type,
        "Cache-Control": live ? "public, max-age=31536000, immutable" : "private, no-store",
        "X-Content-Type-Options": "nosniff",
        // 切り離したプレビュー（SANDBOXED_PREVIEW_CSP）のページは名前の無いオリジンなので、公開していない版の資産は same-site にしない（中身はテーマのファイルで秘密ではない）
        "Cross-Origin-Resource-Policy": live ? "same-site" : "cross-origin",
      },
    });
  });
}
