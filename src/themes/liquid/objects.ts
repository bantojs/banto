/**
 * Banto のデータ → Shopify のテーマと同じ名前のオブジェクト（product・collection・shop・routes・request・linklists …）。docs/themes.md
 *
 * - 金額は Shopify と同じく最小の単位の 100 倍の整数（¥1,200 → 120000）。`money` フィルターで円の表示に戻す
 * - 作るのはただのオブジェクト（テーマは自前のプロパティだけを読める）。テーマに渡すのは公開してよい値だけ
 *   （在庫の数・原価・非公開の独自項目は渡さない。在庫は「あるか」だけ）
 */
import type { ProductField } from "../../products/fields";
import { optionLabel, type OptionNames } from "../../products/option-names";
import type { CategoryImage, CategoryRow, ProductImageRow } from "../../db/types";
import type { ProductDetail, ProductSummary, PublicShop } from "../../storefront/data";
import type { CartLine } from "../types";
import type { CategoryNode } from "../../products/categories";
import { firstImageForSku, orderImagesForSku } from "../../products/images";
import { getLocale } from "../../i18n";
import { appDataOf, customAppData, productReviews, type ProductReviews } from "../../apps/app-data";
import { reviewsMoreHtml } from "../../apps/reviews-html";
import { selectedRowValue, sizeChartLiquid, sizeChartOf } from "../../size-charts/chart";
import { escapeHtml, SafeHtml } from "./engine";
import { Drop } from "liquidjs/dist/liquid.browser.mjs";
import { swatchView, type OptionSwatches } from "../../products/option-swatches";
import { displayOptionAxes } from "../../products/option-axes";
import { categoryDescriptionHtml } from "../../products/category-media";
import { categoryUrl, productUrl, productsUrl } from "../../storefront/urls";

export const money = (jpy: number | null | undefined) => (jpy === null || jpy === undefined ? null : Math.round(jpy) * 100);

export interface UrlBase {
  /** ドメインの上でのパス（""）。商品は `${shopPath}/products/<slug>`（src/storefront/urls.ts） */
  shopPath: string;
  mediaBaseUrl: string;
  /** SKU の選択肢の key → 表示名（0094）。product.options・options_with_values の name に出す */
  optionNames?: OptionNames;
  /** 選択肢の値ごとの見本（0115）。options_with_values の値の swatch に出す */
  optionSwatches?: OptionSwatches;
  /** 商品の独自項目の定義（shops.settings.product_fields）。product.fields・field_list の表示名と公開の判定 */
  productFields?: ProductField[];
}

/**
 * 選択肢の値（product.options_with_values[].values の 1 つ。Shopify の product_option_value と同じ名前）。
 * テンプレートからは値の名前の文字と同じに見える（`{{ value }}`・`==`・`contains`・`| json`。liquidjs の Drop の valueOf）
 */
export class OptionValue extends Drop {
  readonly size: number;
  readonly length: number;
  constructor(
    readonly name: string,
    readonly swatch: ReturnType<typeof swatchView>,
    readonly selected: boolean,
    readonly available: boolean,
    readonly variant: unknown,
  ) {
    super();
    this.size = name.length;
    this.length = name.length;
  }
  override valueOf(): string {
    return this.name;
  }
  override toString(): string {
    return this.name;
  }
  toJSON(): string {
    return this.name;
  }
}

const mediaUrl = (u: UrlBase, key: string) => `${u.mediaBaseUrl.replace(/\/+$/, "")}/${key}`;

export function imageObject(u: UrlBase, img: Pick<ProductImageRow, "storage_key" | "thumb_key" | "width" | "height" | "variants" | "thumb_width"> & { id?: string }, alt: string) {
  const src = mediaUrl(u, img.storage_key);
  const o: Record<string, unknown> = {
    id: img.id ?? img.storage_key,
    key: img.storage_key,
    thumb_key: img.thumb_key,
    variants: img.variants ?? [],
    thumb_width: img.thumb_width ?? null,
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
    url: productUrl(u.shopPath, p.product.slug),
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
    // 一覧のカードの独自項目（0121。定義で card を付けた公開の項目だけが一覧に来る）
    ...productFieldsLiquid(u, p.attributes),
  };
}

/** 商品ページ（ProductDetail）。selectedSku は ?sku=<品番>（その SKU の画像を先に並べる。0063） */
export function productFromDetail(u: UrlBase, d: ProductDetail, selectedSku?: string | null) {
  const p = d.product;
  const selected = d.skus.find((s) => s.code === selectedSku) ?? null;
  const images = orderImagesForSku(d.images, selected?.options ?? null).map((img) => imageObject(u, img, p.name));
  // 選択肢の key（並びは商品の軸の順（0065）、軸に無い key は SKU に出てくる順）。テーマに出す名前は表示名（Shopify の product.options と同じく名前の並び）
  const optionKeys: string[] = displayOptionAxes(p.option_axes, d.skus).map((a) => a.key);
  for (const s of d.skus) for (const k of Object.keys(s.options ?? {})) if (!optionKeys.includes(k)) optionKeys.push(k);
  const optionNames = optionKeys.map((k) => optionLabel(u.optionNames ?? {}, k));
  // 選択肢の値は、選択肢の名前の並びと同じ位置で持つ（SKU ごとに鍵が違っても、位置がずれないように）
  const optsBySku = d.skus.map((s) => optionKeys.map((k) => (s.options?.[k] === undefined ? null : String(s.options[k]))));
  const variants = d.skus.map((s, si) => {
    const opts = optsBySku[si]!;
    return {
      id: s.id,
      title: s.name || opts.filter(Boolean).join(" / ") || s.code,
      sku: s.code,
      barcode: s.gtin ?? null,
      price: money(s.price_jpy),
      compare_at_price: s.compare_at_price_jpy ? money(s.compare_at_price_jpy) : null,
      // 会員価格（0099）: member_price はこの見る人に効く会員価格（会員）か、ゲストに見せる会員価格。regular_price は通常の価格
      member_price: s.regular_price_jpy !== undefined && s.regular_price_jpy > s.price_jpy ? money(s.price_jpy) : s.member_price_jpy !== undefined && s.member_price_jpy < s.price_jpy ? money(s.member_price_jpy) : null,
      regular_price: money(s.regular_price_jpy ?? s.price_jpy),
      available: s.available > 0,
      options: opts.filter((x): x is string => x !== null),
      option1: opts[0] ?? null,
      option2: opts[1] ?? null,
      option3: opts[2] ?? null,
      url: productUrl(u.shopPath, p.slug, { sku: s.code }),
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
    url: productUrl(u.shopPath, p.slug),
    description: descriptionHtml(p.description),
    content: descriptionHtml(p.description),
    price: prices.length ? Math.min(...prices) : null,
    price_min: prices.length ? Math.min(...prices) : null,
    price_max: prices.length ? Math.max(...prices) : null,
    price_varies: new Set(prices).size > 1,
    compare_at_price: compare.length ? Math.min(...compare) : null,
    compare_at_price_min: compare.length ? Math.min(...compare) : null,
    compare_at_price_max: compare.length ? Math.max(...compare) : null,
    // 会員限定で買えない商品（0098）は売り切れと同じに見せ、members_only でテーマが「会員の方だけ」を出せる
    available: available.length > 0 && d.purchasable !== false,
    members_only: Boolean(p.audience_id),
    purchasable: d.purchasable !== false,
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
    // 値は OptionValue（名前の文字に見え、swatch・selected・available・variant を持つ。0115）。variant はその値を持つ SKU のうち、
    // 今の SKU とほかの選択肢がそろうもの、無ければ在庫のあるもの、無ければ最初のもの
    options_with_values: optionNames.map((name, i) => {
      const sel = first ? (optsBySku[variants.indexOf(first)]?.[i] ?? null) : null;
      const vals = [...new Set(optsBySku.map((o) => o[i]).filter((x): x is string => Boolean(x)))];
      return {
        name,
        position: i + 1,
        selected_value: sel,
        values: vals.map((v) => {
          const withV = variants.filter((_, vi) => optsBySku[vi]?.[i] === v);
          const fo = first ? optsBySku[variants.indexOf(first)] : null;
          const near = fo ? withV.find((x) => optsBySku[variants.indexOf(x)]!.every((ov, oi) => oi === i || ov === fo[oi])) : undefined;
          const variant = near ?? withV.find((x) => x.available) ?? withV[0] ?? null;
          return new OptionValue(v, swatchView(u.mediaBaseUrl, u.optionSwatches?.[optionKeys[i]!]?.[v] ?? null), v === sel, withV.some((x) => x.available), variant);
        }),
      };
    }),
    selected_variant: selected ? first : null,
    selected_or_first_available_variant: first,
    first_available_variant: available[0] ?? null,
    created_at: p.created_at,
    updated_at: p.updated_at,
    // 商品の独自項目（公開のものだけ。値は product_public_get が公開の項目だけを返す）。{{ product.fields.material }}・
    // 定義の順に並べた field_list（key・label・type・value）
    ...productFieldsLiquid(u, p.attributes),
    // 外部プラグインの拡張データ（0084、docs/app-data.md）。文字は既定でエスケープして描かれる
    reviews: reviewsObject(p),
    app_data: appDataOf(p).map((x) => ({ app: x.app, kind: x.kind, key: x.key ?? "", data: x.data })),
    // custom.v1 をプラグインの名前 → 名前（key）で（0085）。{{ product.apps['size-guide']['size-table'].note }}
    apps: customAppData(p),
    // 採寸表（同梱モジュール size_charts、0095。モジュールが OFF・表が無ければ null）。docs/size-charts.md
    size_chart: (() => {
      const chart = sizeChartOf(p.size_chart);
      return sizeChartLiquid(chart, (k) => mediaUrl(u, k), chart ? selectedRowValue(chart, selected?.options) : null);
    })(),
  };
}

/** product.fields と product.field_list（公開の項目の定義にあって、値の入っているものだけ） */
export function productFieldsLiquid(u: UrlBase, attributes: Record<string, unknown> | null | undefined): { fields: Record<string, unknown>; field_list: { key: string; label: string; type: string; value: unknown }[] } {
  const defs = (u.productFields ?? []).filter((f) => f.public);
  const a = attributes ?? {};
  const field_list = defs.filter((f) => a[f.key] !== undefined && a[f.key] !== null && String(a[f.key]).trim() !== "").map((f) => ({ key: f.key, label: f.label, type: f.type, value: a[f.key] }));
  return { fields: Object.fromEntries(field_list.map((f) => [f.key, f.value])), field_list };
}

/** product.reviews（レビューのプラグインが置いた要約。無ければ null） */
function reviewsObject(p: ProductDetail["product"]) {
  return reviewsLiquid(productReviews(p));
}

/** レビューの要約の Liquid の形（product.reviews と、本文のプラグインのブロックの reviews で同じ） */
export function reviewsLiquid(r: ProductReviews | null) {
  if (!r) return null;
  return {
    app: r.app,
    rating: r.rating_avg,
    rating_count: r.rating_count,
    items: r.items.map((i) => ({ id: i.id, rating: i.rating, title: i.title, body: i.body, author: i.author_display, created_at: i.created_at, incentivized: i.incentivized, verified_purchase: i.verified_purchase })),
    // 「もっと見る」（0087）: ボタンと Banto のスクリプト。data-banto-reviews の中の ol.review-list に li.review を足す
    more_url: r.more?.url ?? null,
    more_html: new SafeHtml(reviewsMoreHtml(r, r.items.length)),
  };
}

export function collectionObject(u: UrlBase, c: { handle: string; title: string; description?: string | null; image?: CategoryImage | null; products: unknown[]; count: number | null; allTags: string[]; currentTags?: string[] }) {
  const url = c.handle === "all" ? productsUrl(u.shopPath) : categoryUrl(u.shopPath, c.handle);
  return {
    id: c.handle,
    handle: c.handle,
    title: c.title,
    // カテゴリーの説明と画像（0113）。説明はエスケープして改行を <br> にした HTML（商品の説明と同じ）
    description: new SafeHtml(categoryDescriptionHtml(c.description)),
    image: c.image ? imageObject(u, { storage_key: c.image.key, thumb_key: null, width: c.image.width, height: c.image.height, variants: [], thumb_width: null }, c.title) : null,
    featured_image: c.image ? imageObject(u, { storage_key: c.image.key, thumb_key: null, width: c.image.width, height: c.image.height, variants: [], thumb_width: null }, c.title) : null,
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
    url: categoryUrl(u.shopPath, n.slug),
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
    locale: getLocale(),
    enabled_currencies: [{ iso_code: "JPY", symbol: "¥" }],
  };
}

/** coupons: 同梱モジュール coupons が ON か（ON のときだけ cart_coupon_url を渡す。Banto の名前で、Shopify には無い） */
export function routesObject(shopPath: string, opts: { coupons?: boolean } = {}) {
  const root = shopPath || "/";
  return {
    ...(opts.coupons ? { cart_coupon_url: `${shopPath}/cart/coupon` } : {}),
    root_url: root,
    cart_url: `${shopPath}/cart`,
    cart_add_url: `${shopPath}/cart/add`,
    cart_change_url: `${shopPath}/cart/change`,
    cart_update_url: `${shopPath}/cart/update`,
    // すべての商品（/products）。検索は /products?q=（フォームは GET で q を送る）。カテゴリーの一覧は collection.url
    collections_url: productsUrl(shopPath),
    all_products_collection_url: productsUrl(shopPath),
    search_url: productsUrl(shopPath),
    predictive_search_url: productsUrl(shopPath),
    account_url: `${shopPath}/account`,
    account_login_url: `${shopPath}/account/login`,
    account_logout_url: `${shopPath}/account/logout`,
    account_register_url: `${shopPath}/account/login`,
  };
}

/** カートのクーポン（同梱モジュール coupons が ON のとき）。amount は円 */
export interface CartDiscounts {
  applied: { code: string; name: string; amount_jpy: number; free_shipping: boolean }[];
  /** 入っているが使えないコード（discount_codes の applicable: false。理由の文は banto_message） */
  rejected?: { code: string; message: string }[];
  discount: number;
}

/** カートの決済手段の選択肢（cart.banto_payment_methods。{% form 'cart' %} の provider の欄に入れる id） */
export function paymentMethodsObject(options: { stripe: boolean; komoju: boolean }, label: (provider: "stripe" | "komoju") => string): { id: string; name: string }[] {
  return (["stripe", "komoju"] as const).filter((p) => options[p]).map((p) => ({ id: p, name: label(p) }));
}

/**
 * カート（Shopify の cart。カートのページ・ヘッダーのカート・/cart.js が同じ形を使う）。
 * 行の鍵（key・id）は SKU の id（Banto のカートは SKU ごとに 1 行）。金額は 100 倍の整数、値引きは商品の値引きだけ（送料は配送先が決まってから）
 */
/** カートの行の画像の材料（商品の id → 並び順の画像。SKU に合う画像を選ぶのは src/products/images.ts） */
export type CartImages = ReadonlyMap<string, readonly ProductImageRow[]>;

export function cartObject(u: UrlBase, lines: CartLine[], discounts: CartDiscounts | null = null, images: CartImages = new Map()) {
  const items = lines.map((l, i) => {
    const imgRow = firstImageForSku(images.get(l.product.id) ?? [], l.sku.options ?? null);
    const image = imgRow ? imageObject(u, imgRow, l.product.name) : null;
    const opts = Object.entries(l.sku.options ?? {}).map(([key, value]) => ({ name: optionLabel(u.optionNames ?? {}, key), value: String(value) }));
    const variantTitle = l.sku.name || opts.map((o) => o.value).join(" / ") || null;
    const price = money(l.sku.price_jpy)!;
    const url = productUrl(u.shopPath, l.product.slug, { sku: l.sku.code });
    return {
      id: l.sku.id,
      key: l.sku.id,
      variant_id: l.sku.id,
      product_id: l.product.id,
      index: i + 1,
      title: variantTitle ? `${l.product.name} - ${variantTitle}` : l.product.name,
      product_title: l.product.name,
      variant_title: variantTitle,
      sku: l.sku.code,
      vendor: l.product.brand ?? "",
      quantity: l.qty,
      price,
      original_price: price,
      final_price: price,
      line_price: price * l.qty,
      original_line_price: price * l.qty,
      final_line_price: price * l.qty,
      line_level_total_discount: 0,
      discounts: [],
      url,
      url_to_remove: `${u.shopPath}/cart/change?id=${encodeURIComponent(l.sku.id)}&quantity=0`,
      image,
      featured_image: image,
      options_with_values: opts,
      variant: { id: l.sku.id, title: variantTitle ?? l.sku.code, sku: l.sku.code, price, available: l.sku.available > 0, options: opts.map((o) => o.value) },
      product: { id: l.product.id, handle: l.product.slug, title: l.product.name, url: productUrl(u.shopPath, l.product.slug), vendor: l.product.brand ?? "", tags: l.product.tags ?? [] },
      requires_shipping: true,
      // 在庫が足りない行（Banto の判定。確認画面へは進めない）
      available: !l.short,
    };
  });
  const subtotal = items.reduce((n, x) => n + x.line_price, 0);
  const discount = money(discounts?.discount ?? 0)!;
  return {
    item_count: items.reduce((n, x) => n + x.quantity, 0),
    items,
    items_subtotal_price: subtotal,
    original_total_price: subtotal,
    total_discount: discount,
    total_price: Math.max(0, subtotal - discount),
    cart_level_discount_applications: (discounts?.applied ?? []).map((a) => ({ title: a.name, code: a.code, total_allocated_amount: money(a.amount_jpy), type: "discount_code", value_type: a.free_shipping ? "shipping" : "fixed_amount" })),
    discount_codes: [...(discounts?.applied ?? []).map((a) => ({ code: a.code, applicable: true })), ...(discounts?.rejected ?? []).map((r) => ({ code: r.code, applicable: false, banto_message: r.message }))],
    requires_shipping: items.length > 0,
    currency: { iso_code: "JPY" },
    note: null,
    attributes: {},
    empty: items.length === 0,
  };
}

/** 法務のページ（フッターのメニュー、linklists['footer']） */
export function footerMenu(shopPath: string, labels: { legal: string; privacy: string; returns: string; shipping: string }) {
  const l = (title: string, path: string) => ({ title, url: `${shopPath}${path}`, active: false, links: [], levels: 0, type: "http_link" });
  return { handle: "footer", title: "Footer", links: [l(labels.legal, "/legal"), l(labels.privacy, "/privacy"), l(labels.returns, "/returns"), l(labels.shipping, "/shipping")], levels: 1 };
}

export type { CategoryRow };
