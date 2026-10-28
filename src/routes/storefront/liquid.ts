/**
 * お店の画面を Liquid のテーマで描く（docs/themes.md）。描けないときは null を返し、呼び出し側は既定のテーマ（TSX）で描く。
 *
 * 描くのは次がそろったときだけ:
 *   - ショップに公開中の版がある（shop_public_get の theme。独自ドメインのあるショップだけに出る、0071）
 *   - ショップのドメインで開いている（Banto の URL では描かない。テーマの JS を管理画面と同じオリジンで動かさない）
 *   - CPU の上限を気にしなくてよい（Workers の有料プラン = サイトの設定 workers_plan が paid、か Node）
 * テーマが壊れている・上限を超えた・その種類のテンプレートが無いときも既定のテーマで描く（お店を止めない）。
 */
import type { Hono } from "hono";
import type { AppEnv } from "../../app";
import type { CategoryRow } from "../../db/types";
import { getLocale, t } from "../../i18n";
import { categoryTree, type CategoryNode } from "../../products/categories";
import { productJsonLd, jsonLdText } from "../../storefront/structured-data";
import type { ProductDetail, ProductListPage, PublicShop, StorefrontData } from "../../storefront/data";
import { shopHome, shopOrigin } from "../../storefront/urls";
import type { ThemeContext } from "../../themes/types";
import { escapeHtml, ThemeError } from "../../themes/liquid/engine";
import { assetType } from "../../themes/liquid/bundle";
import { loadTheme, type LoadedTheme } from "../../themes/liquid/cache";
import { extendShopify, type Paginate } from "../../themes/liquid/shopify";
import { renderThemePage, themeHasTemplate, themeSettings, type ThemeTemplate } from "../../themes/liquid/page";
import { collectionObject, footerMenu, menuFromCategories, productFromDetail, productFromSummary, routesObject, shopObject } from "../../themes/liquid/objects";
import { isSecureRequest, mediaBaseUrl, publicBaseUrl, type Ctx } from "../common";
import { openJson, readCookie, sealJson } from "../../util/signed";
import { onShopDomain } from "./domain";

export interface LiquidScope {
  shop: PublicShop;
  sf: StorefrontData;
  ctx: ThemeContext;
}

/** 描くテーマ。preview は管理画面から開いたプレビュー（公開していない版。誤りをその場所に出し、検索エンジンに載せない） */
export interface LiquidChoice {
  lt: LoadedTheme;
  settings: Record<string, unknown>;
  preview: boolean;
}

/** プレビューの券（管理画面の「デザイン」が作る。ショップと版を結び、30 分で切れる） */
export const THEME_PREVIEW_SECONDS = 30 * 60;
const PREVIEW_COOKIE = "banto_theme_preview";
/** 券の鍵はプレビュー専用にする（サイトの秘密で署名するほかの値と取り違えさせない） */
const previewKey = (secret: string): string => `${secret}:theme_preview`;

export function sealThemePreview(secret: string, shopId: string, versionId: string, now = Date.now()): Promise<string> {
  return sealJson(previewKey(secret), { k: "theme_preview", s: shopId, v: versionId, exp: Math.floor(now / 1000) + THEME_PREVIEW_SECONDS });
}

async function openThemePreview(secret: string, token: string | undefined, shopId: string): Promise<string | null> {
  const v = (await openJson(previewKey(secret), token)) as { k?: unknown; s?: unknown; v?: unknown; exp?: unknown } | null;
  if (!v || v.k !== "theme_preview" || v.s !== shopId || typeof v.v !== "string" || !/^[0-9a-f-]{36}$/.test(v.v) || typeof v.exp !== "number" || v.exp * 1000 < Date.now()) return null;
  return v.v;
}

/** プレビューの版（?preview_theme=<版>&preview_token=… で始め、Cookie で続ける。?preview_theme=off で終わる） */
async function previewVersion(c: Ctx, s: LiquidScope): Promise<string | null> {
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
  if (fromQuery && fromQuery === q) {
    cookie(c.req.query("preview_token")!, THEME_PREVIEW_SECONDS);
    return fromQuery;
  }
  return openThemePreview(secret, readCookie(c.req.header("cookie"), PREVIEW_COOKIE), s.shop.id);
}

/** 描くテーマ（公開中の版か、プレビューの版）。描けないなら null */
export async function liquidThemeFor(c: Ctx, s: LiquidScope): Promise<LiquidChoice | null> {
  if (!onShopDomain(c, s.shop)) return null;
  const preview = await previewVersion(c, s);
  const theme = preview ? { id: preview, storage_key: `themes/${s.shop.id}/${preview}/bundle.json`, settings: {} } : s.shop.theme;
  if (!theme) return null;
  const adapters = c.get("adapters");
  try {
    if (!adapters.cpuUnlimited && (await s.sf.sitePlanCached()) !== "paid") return null;
    const lt = await loadTheme(adapters.storage, theme, { extend: extendShopify, timezone: adapters.config.get("BANTO_TIMEZONE") ?? "Asia/Tokyo" });
    return lt ? { lt, settings: theme.settings ?? {}, preview: Boolean(preview) } : null;
  } catch (e) {
    console.error("[banto] theme load:", e instanceof Error ? e.message : e);
    return null;
  }
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
  status?: 200 | 404;
}

/** Liquid のテーマで 1 ページを描いた Response。描けなければ null */
function render(c: Ctx, s: LiquidScope, choice: LiquidChoice, page: PageParts): Response | null {
  const { lt } = choice;
  if (!themeHasTemplate(lt, page.template)) return null;
  const home = shopHome(publicBaseUrl(c), s.shop);
  const origin = shopOrigin(publicBaseUrl(c), s.shop);
  const shopPath = s.ctx.shopPath;
  const u = { shopPath, mediaBaseUrl: mediaBaseUrl(c) };
  const tree: CategoryNode[] = categoryTree(page.categories);
  const canonical = `${home}${page.path}`;
  const head = [
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    page.noindex || choice.preview ? '<meta name="robots" content="noindex">' : "",
    page.jsonLd ? `<script type="application/ld+json">${jsonLdText(page.jsonLd)}</script>` : "",
  ].join("");
  const intro = typeof s.ctx.themeSettings?.["description"] === "string" ? (s.ctx.themeSettings["description"] as string) : undefined;
  const path = relativePath(c, s);
  const globals: Record<string, unknown> = {
    shop: shopObject(s.shop, home, intro),
    settings: themeSettings(lt, choice.settings),
    routes: routesObject(shopPath),
    request: { host: new URL(origin).host, path, page_type: page.template, locale: { iso_code: getLocale(), primary: true, root_url: shopPath || "/" }, design_mode: false },
    cart: { item_count: s.ctx.cartCount, items: [], total_price: 0, items_subtotal_price: 0, currency: { iso_code: "JPY" } },
    customer: s.ctx.member ? { email: s.ctx.member.email } : null,
    linklists: {
      "main-menu": menuFromCategories(u, tree, page.currentCategory),
      footer: footerMenu(shopPath, { legal: t("shop.legal_notice"), privacy: t("shop.privacy_policy"), returns: t("shop.return_policy"), shipping: t("shipping.title") }),
    },
    collections: Object.fromEntries([["all", collectionObject(u, { handle: "all", title: s.shop.name, products: [], count: null, allTags: [] })], ...page.categories.map((cat) => [cat.slug, collectionObject(u, { handle: cat.slug, title: cat.name, products: [], count: null, allTags: [] })])]),
    page_title: page.title,
    page_description: page.description ?? intro ?? "",
    canonical_url: canonical,
    ...page.values,
  };
  try {
    const r = renderThemePage(lt, { template: page.template, globals, head, paginate: page.paginate ?? null, shopOrigin: origin, shopPath, mediaBaseUrl: u.mediaBaseUrl, preview: choice.preview });
    if (!r) return null;
    if (r.errors.length > 0) console.error("[banto] theme sections:", r.errors.slice(0, 5).join(" / "));
    if (!choice.preview) return c.html(r.html, page.status ?? 200);
    // プレビュー: 帯を出し、覚えさせず、検索エンジンに載せない
    const bar = `<div style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#111;color:#fff;font:14px/1.6 sans-serif;padding:8px 12px">${escapeHtml(t("design.preview_bar"))} <a style="color:#9cf" href="?preview_theme=off">${escapeHtml(t("design.preview_end"))}</a></div>`;
    const i = r.html.search(/<\/body>/i);
    c.header("Cache-Control", "private, no-store");
    c.header("X-Robots-Tag", "noindex");
    return c.html(i < 0 ? r.html + bar : r.html.slice(0, i) + bar + r.html.slice(i), page.status ?? 200);
  } catch (e) {
    console.error("[banto] theme render:", e instanceof ThemeError ? `${e.kind}: ${e.message}` : e instanceof Error ? e.message : e);
    return null;
  }
}

/** 一覧（トップ・カテゴリー・タグ）。トップは templates/index、絞り込みは templates/collection */
export function renderListing(
  c: Ctx,
  s: LiquidScope,
  choice: LiquidChoice,
  p: { page: ProductListPage; categories: CategoryRow[]; category?: CategoryRow; tag?: string; tags: { tag: string; count: number }[]; link: (cursor: string | null) => string; after?: string; path: string },
): Response | null {
  const u = { shopPath: s.ctx.shopPath, mediaBaseUrl: mediaBaseUrl(c) };
  const products = p.page.items.map((x) => productFromSummary(u, x));
  const filtered = Boolean(p.category || p.tag);
  const collection = collectionObject(u, {
    handle: p.category?.slug ?? "all",
    title: p.category?.name ?? (p.tag ? `#${p.tag}` : s.shop.name),
    products,
    count: p.page.total,
    allTags: p.tags.map((x) => x.tag),
    ...(p.tag ? { currentTags: [p.tag] } : {}),
  });
  // Banto のページ送りは位置（cursor）で進むので、今が何ページ目かは分からない。前は「最初のページ」、次は「次の 1 ページ」。
  // 全体の数が分かれば pages を出す（テーマの {% if paginate.pages > 1 %} が効くように）
  const previous = p.after ? { title: "«", url: p.link(null), is_link: true as const } : null;
  const next = p.page.nextCursor ? { title: "»", url: p.link(p.page.nextCursor), is_link: true as const } : null;
  const pages = p.page.total !== null ? Math.max(1, Math.ceil(p.page.total / p.page.limit)) : previous || next ? 2 : 1;
  const paginate: Paginate = {
    current_page: p.after ? 2 : 1,
    page_size: p.page.limit,
    items: p.page.total,
    pages,
    previous,
    next,
    parts: [...(previous ? [{ title: "1", url: previous.url, is_link: true }] : []), { title: p.after ? "…" : "1", url: "", is_link: false }, ...(next ? [{ title: "»", url: next.url, is_link: true }] : [])],
  };
  const template: ThemeTemplate = filtered || !themeHasTemplate(choice.lt, "index") ? "collection" : "index";
  return render(c, s, choice, {
    template,
    values: { collection, products, current_tags: p.tag ? [p.tag] : [] },
    title: filtered ? collection.title : s.shop.name,
    path: p.path,
    noindex: Boolean(p.after),
    categories: p.categories,
    ...(p.category ? { currentCategory: p.category.slug } : {}),
    paginate,
  });
}

export function renderProduct(c: Ctx, s: LiquidScope, choice: LiquidChoice, p: { detail: ProductDetail; categories: CategoryRow[]; categoryNames: string[]; selectedSku: string | null }): Response | null {
  const u = { shopPath: s.ctx.shopPath, mediaBaseUrl: mediaBaseUrl(c) };
  const product = productFromDetail(u, p.detail, p.selectedSku);
  const home = shopHome(publicBaseUrl(c), s.shop);
  const path = `/p/${encodeURIComponent(p.detail.product.slug)}`;
  const jsonLd = productJsonLd({
    url: `${home}${path}`,
    product: p.detail.product,
    images: product.images.map((i) => String(i["src"])),
    skus: p.detail.skus,
    category: p.categoryNames,
  });
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
 * 版ごとに置き場が違い中身は変わらないので、長く覚えてよい
 */
export function registerThemeAssets(app: Hono<AppEnv>, scopeOf: (c: Ctx) => Promise<LiquidScope | null>): void {
  app.get("/:shop/_theme/:version/assets/:name", async (c) => {
    const s = await scopeOf(c);
    const version = c.req.param("version");
    const name = c.req.param("name");
    const type = assetType(name);
    if (!s || !type || !onShopDomain(c, s.shop) || !/^[0-9a-f-]{36}$/.test(version)) return c.notFound();
    const obj = await c.get("adapters").storage.get(`themes/${s.shop.id}/${version}/assets/${name}`);
    if (!obj) return c.notFound();
    return new Response(obj.body, {
      headers: {
        "Content-Type": type,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-site",
      },
    });
  });
}
