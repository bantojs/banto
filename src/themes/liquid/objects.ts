/**
 * Banto のデータ → Shopify のテーマと同じ名前のオブジェクト（product・collection・shop・routes・request・linklists …）。docs/themes.md
 *
 * - 金額は Shopify と同じく最小の単位の 100 倍の整数（¥1,200 → 120000）。`money` フィルターで円の表示に戻す
 * - 作るのはただのオブジェクト（テーマは自前のプロパティだけを読める）。テーマに渡すのは公開してよい値だけ
 *   （在庫の数・原価・非公開の独自項目は渡さない。在庫は「あるか」だけ）
 */
import type { CategoryRow, ProductImageRow } from "../../db/types";
import type { ProductDetail, ProductSummary, PublicShop } from "../../storefront/data";
import type { CategoryNode } from "../../products/categories";
import { orderImagesForSku } from "../../products/images";
import { escapeHtml, SafeHtml } from "./engine";

export const money = (jpy: number | null | undefined) => (jpy === null || jpy === undefined ? null : Math.round(jpy) * 100);

export interface UrlBase {
  /** ドメインの上でのパス（""）。商品は `${shopPath}/p/<slug>` */
  shopPath: string;
  mediaBaseUrl: string;
}

const mediaUrl = (u: UrlBase, key: string) => `${u.mediaBaseUrl.replace(/\/+$/, "")}/${key}`;

export function imageObject(u: UrlBase, img: Pick<ProductImageRow, "storage_key" | "thumb_key" | "width" | "height"> & { id?: string }, alt: string) {
  const src = mediaUrl(u, img.storage_key);
  const o: Record<string, unknown> = {
    id: img.id ?? img.storage_key,
    key: img.storage_key,
    thumb_key: img.thumb_key,
    src,
    url: src,
    width: img.width,
    height: img.height,
    aspect_ratio: img.width && img.height ? Math.round((img.width / img.height) * 1000) / 1000 : 1,
    alt,
    media_type: "image",
  };
  o["preview_image"] = { ...o };
  return o;
}

/** 説明は Banto ではただの文（HTML ではない）。エスケープして改行を <br> にした HTML を渡す */
const descriptionHtml = (s: string | null | undefined) => new SafeHtml(escapeHtml(s ?? "").replace(/\r?\n/g, "<br>"));

/** 一覧の 1 件（ProductSummary）。SKU と在庫の細かいところは一覧では読まない */
export function productFromSummary(u: UrlBase, p: ProductSummary) {
  const image = p.image ? imageObject(u, p.image, p.product.name) : null;
  const price = money(p.minPrice);
  return {
    id: p.product.id,
    handle: p.product.slug,
    title: p.product.name,
    url: `${u.shopPath}/p/${encodeURIComponent(p.product.slug)}`,
    price,
    price_min: price,
    price_max: price,
    price_varies: false,
    compare_at_price: p.compareAt ? money(p.compareAt) : null,
    compare_at_price_min: p.compareAt ? money(p.compareAt) : null,
    compare_at_price_max: p.compareAt ? money(p.compareAt) : null,
    available: price !== null,
    vendor: p.product.brand ?? "",
    type: "",
    tags: p.product.tags ?? [],
    featured_image: image,
    featured_media: image,
    images: image ? [image] : [],
    media: image ? [image] : [],
    variants: [],
    has_only_default_variant: true,
    options: [],
    options_with_values: [],
    created_at: p.product.created_at,
    updated_at: p.product.updated_at,
  };
}

/** 商品ページ（ProductDetail）。selectedSku は ?sku=<品番>（その SKU の画像を先に並べる。0063） */
export function productFromDetail(u: UrlBase, d: ProductDetail, selectedSku?: string | null) {
  const p = d.product;
  const selected = d.skus.find((s) => s.code === selectedSku) ?? null;
  const images = orderImagesForSku(d.images, selected?.options ?? null).map((img) => imageObject(u, img, p.name));
  const optionNames: string[] = [];
  for (const s of d.skus) for (const k of Object.keys(s.options ?? {})) if (!optionNames.includes(k)) optionNames.push(k);
  const variants = d.skus.map((s) => {
    const opts = optionNames.map((k) => (s.options?.[k] === undefined ? null : String(s.options[k])));
    return {
      id: s.id,
      title: s.name || opts.filter(Boolean).join(" / ") || s.code,
      sku: s.code,
      barcode: s.gtin ?? null,
      price: money(s.price_jpy),
      compare_at_price: s.compare_at_price_jpy ? money(s.compare_at_price_jpy) : null,
      available: s.available > 0,
      options: opts.filter((x): x is string => x !== null),
      option1: opts[0] ?? null,
      option2: opts[1] ?? null,
      option3: opts[2] ?? null,
      url: `${u.shopPath}/p/${encodeURIComponent(p.slug)}?sku=${encodeURIComponent(s.code)}`,
    };
  });
  const prices = variants.map((v) => v.price ?? 0);
  const available = variants.filter((v) => v.available);
  const first = selected ? (variants.find((v) => v.sku === selected.code) ?? null) : (available[0] ?? variants[0] ?? null);
  const compare = variants.map((v) => v.compare_at_price).filter((x): x is number => x !== null);
  return {
    id: p.id,
    handle: p.slug,
    title: p.name,
    url: `${u.shopPath}/p/${encodeURIComponent(p.slug)}`,
    description: descriptionHtml(p.description),
    content: descriptionHtml(p.description),
    price: prices.length ? Math.min(...prices) : null,
    price_min: prices.length ? Math.min(...prices) : null,
    price_max: prices.length ? Math.max(...prices) : null,
    price_varies: new Set(prices).size > 1,
    compare_at_price: compare.length ? Math.min(...compare) : null,
    compare_at_price_min: compare.length ? Math.min(...compare) : null,
    compare_at_price_max: compare.length ? Math.max(...compare) : null,
    available: available.length > 0,
    vendor: p.brand ?? "",
    type: "",
    tags: p.tags ?? [],
    featured_image: images[0] ?? null,
    featured_media: images[0] ?? null,
    images,
    media: images,
    variants,
    has_only_default_variant: variants.length <= 1 && optionNames.length === 0,
    options: optionNames,
    options_with_values: optionNames.map((name, i) => ({
      name,
      position: i + 1,
      values: [...new Set(variants.map((v) => v.options[i]).filter((x): x is string => Boolean(x)))],
      selected_value: first?.options[i] ?? null,
    })),
    selected_variant: selected ? first : null,
    selected_or_first_available_variant: first,
    first_available_variant: available[0] ?? null,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

export function collectionObject(u: UrlBase, c: { handle: string; title: string; description?: string; products: unknown[]; count: number | null; allTags: string[]; currentTags?: string[] }) {
  const url = c.handle === "all" ? u.shopPath || "/" : `${u.shopPath || ""}/?category=${encodeURIComponent(c.handle)}`;
  return {
    id: c.handle,
    handle: c.handle,
    title: c.title,
    description: c.description ?? "",
    url,
    products: c.products,
    products_count: c.count ?? c.products.length,
    all_products_count: c.count ?? c.products.length,
    all_tags: c.allTags,
    tags: c.allTags,
    current_tags: c.currentTags ?? [],
    sort_by: "created-descending",
    default_sort_by: "created-descending",
    filters: [],
  };
}

/** カテゴリーの木 → メニュー（linklists['main-menu']）。Banto はメニューを持たないので、カテゴリーから組む */
export function menuFromCategories(u: UrlBase, nodes: CategoryNode[], currentSlug?: string) {
  const link = (n: CategoryNode): Record<string, unknown> => ({
    title: n.name,
    url: `${u.shopPath || ""}/?category=${encodeURIComponent(n.slug)}`,
    handle: n.slug,
    active: n.slug === currentSlug,
    child_active: n.children.some((ch) => ch.slug === currentSlug),
    links: n.children.map(link),
    levels: n.children.length ? 1 : 0,
    type: "collection_link",
  });
  return { handle: "main-menu", title: "Main menu", links: nodes.map(link), levels: nodes.some((n) => n.children.length) ? 2 : 1 };
}

export function shopObject(shop: PublicShop, home: string, intro: string | undefined) {
  return {
    id: shop.id,
    name: shop.name,
    url: home,
    secure_url: home,
    domain: shop.domain ?? "",
    permanent_domain: shop.domain ?? "",
    description: intro ?? "",
    currency: "JPY",
    money_format: "¥{{amount_no_decimals}}",
    money_with_currency_format: "¥{{amount_no_decimals}} JPY",
    locale: "ja",
    enabled_currencies: [{ iso_code: "JPY", symbol: "¥" }],
  };
}

export function routesObject(shopPath: string) {
  const root = shopPath || "/";
  return {
    root_url: root,
    cart_url: `${shopPath}/cart`,
    cart_add_url: `${shopPath}/cart/add`,
    cart_change_url: `${shopPath}/cart/update`,
    cart_update_url: `${shopPath}/cart/update`,
    collections_url: root,
    all_products_collection_url: root,
    search_url: root,
    account_url: `${shopPath}/account`,
    account_login_url: `${shopPath}/account/login`,
    account_logout_url: `${shopPath}/account/logout`,
    account_register_url: `${shopPath}/account/login`,
  };
}

/** 法務のページ（フッターのメニュー、linklists['footer']） */
export function footerMenu(shopPath: string, labels: { legal: string; privacy: string; returns: string; shipping: string }) {
  const l = (title: string, path: string) => ({ title, url: `${shopPath}${path}`, active: false, links: [], levels: 0, type: "http_link" });
  return { handle: "footer", title: "Footer", links: [l(labels.legal, "/legal"), l(labels.privacy, "/privacy"), l(labels.returns, "/returns"), l(labels.shipping, "/shipping")], levels: 1 };
}

export type { CategoryRow };
