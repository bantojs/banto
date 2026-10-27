/**
 * 商品フィード（Google Merchant Center / Meta のカタログ。同梱モジュール product_feed、docs/product-feed.md）。
 * 形式は RSS 2.0 + Google の名前空間（g:）。Meta のカタログも同じ XML を読める。
 * 1 SKU = 1 商品（Google の決まり）。SKU が複数ある商品は item_group_id で束ねる。
 * データ取得はしない（feedCatalog の結果と URL の起点から組む）。
 */
import type { CategoryRow, InventoryRow, ProductImageRow, ProductRow, SkuRow } from "../../db/types";
import { categoryPath } from "../../products/categories";
import { imageUrl } from "../../media/images";
import { imageOptionsOf, orderImagesForSku } from "../../products/images";

export interface FeedCatalog {
  products: ProductRow[];
  skus: SkuRow[];
  /** フィードが見るのは「1 以上か」だけ（0060 の product_feed_page は 1 / 0 を返す） */
  inventory: Pick<InventoryRow, "sku_id" | "available">[];
  images: ProductImageRow[];
  categories: CategoryRow[];
}

export interface FeedTarget {
  shopName: string;
  /** ショップのトップの絶対 URL（src/storefront/urls.ts の shopHome） */
  home: string;
  /** 商品ページを外のサイトに任せているとき（お店の画面の使い方、src/storefront/mode.ts）の商品ページの URL */
  productLink?: (slug: string) => string | null;
  mediaBaseUrl: string;
}

export interface FeedItem {
  id: string;
  item_group_id?: string;
  title: string;
  description: string;
  link: string;
  image_link: string;
  additional_image_link: string[];
  availability: "in_stock" | "out_of_stock";
  price: string;
  sale_price?: string;
  condition: "new";
  brand?: string;
  gtin?: string;
  identifier_exists?: "no";
  product_type?: string;
}

export interface FeedResult {
  items: FeedItem[];
  /** 載せなかった SKU の数（理由ごと） */
  skipped: { no_image: number; no_price: number };
}

const GTIN_RE = /^[0-9]{8}$|^[0-9]{12,14}$/;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const yen = (n: number) => `${n} JPY`;

function skuTitle(product: ProductRow, sku: SkuRow, many: boolean): string {
  if (!many) return product.name;
  const opts = Object.values(sku.options ?? {}).map(String).filter(Boolean);
  const suffix = opts.length > 0 ? opts.join(" / ") : (sku.name ?? sku.code);
  return `${product.name} ${suffix}`;
}

/** SKU ごとの画像がある商品は、商品ページの URL に ?sku=<品番> を付ける（広告の画像と着地の画像をそろえる） */
function skuLink(url: string, code: string | null): string {
  if (!code) return url;
  return `${url}${url.includes("?") ? "&" : "?"}sku=${encodeURIComponent(code)}`;
}

export function buildFeed(cat: FeedCatalog, target: FeedTarget): FeedResult {
  const stock = new Map(cat.inventory.map((i) => [i.sku_id, i.available]));
  const imagesBy = new Map<string, ProductImageRow[]>();
  for (const img of cat.images) imagesBy.set(img.product_id, [...(imagesBy.get(img.product_id) ?? []), img]);
  const skusBy = new Map<string, SkuRow[]>();
  for (const s of cat.skus) skusBy.set(s.product_id, [...(skusBy.get(s.product_id) ?? []), s]);
  const items: FeedItem[] = [];
  const skipped = { no_image: 0, no_price: 0 };
  for (const p of cat.products) {
    const skus = skusBy.get(p.id) ?? [];
    const productImages = imagesBy.get(p.id) ?? [];
    const path = p.category_id ? categoryPath(cat.categories, p.category_id).map((c) => c.name) : [];
    for (const s of skus) {
      // SKU ごとの画像（0063）: その SKU に結んだ画像を先頭に。商品ページも ?sku= で同じ画像を出す
      const imgs = orderImagesForSku(productImages, s.options).map((i) => imageUrl(target.mediaBaseUrl, i.storage_key));
      if (imgs.length === 0) {
        skipped.no_image++;
        continue;
      }
      if (!(s.price_jpy > 0)) {
        skipped.no_price++;
        continue;
      }
      const sale = s.compare_at_price_jpy && s.compare_at_price_jpy > s.price_jpy ? s.compare_at_price_jpy : null;
      const gtin = (s.gtin ?? "").trim();
      items.push({
        id: s.code.length <= 50 ? s.code : s.id,
        ...(skus.length > 1 ? { item_group_id: p.id } : {}),
        title: clip(skuTitle(p, s, skus.length > 1), 150),
        description: clip((p.description ?? "").trim() || p.name, 5000),
        link: skuLink(target.productLink?.(p.slug) ?? `${target.home}/p/${encodeURIComponent(p.slug)}`, skus.length > 1 && productImages.some((i) => Object.keys(imageOptionsOf(i.options)).length > 0) ? s.code : null),
        image_link: imgs[0]!,
        additional_image_link: imgs.slice(1, 11),
        availability: (stock.get(s.id) ?? 0) > 0 ? "in_stock" : "out_of_stock",
        price: yen(sale ?? s.price_jpy),
        ...(sale ? { sale_price: yen(s.price_jpy) } : {}),
        condition: "new",
        ...(p.brand ? { brand: clip(p.brand, 70) } : {}),
        ...(GTIN_RE.test(gtin) ? { gtin } : { identifier_exists: "no" as const }),
        ...(path.length > 0 ? { product_type: clip(path.join(" > "), 750) } : {}),
      });
    }
  }
  return { items, skipped };
}

const esc = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** フィードの頭（<channel> の見出しまで）。分けて作るとき（job.ts）は頭・<item> の並び・尻を別々に置いてつなぐ */
export function feedHead(target: FeedTarget): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>${esc(target.shopName)}</title><link>${esc(target.home)}</link><description>${esc(target.shopName)}</description>\n`;
}

export const FEED_TAIL = "</channel></rss>\n";

export function feedXml(r: FeedResult, target: FeedTarget): string {
  return `${feedHead(target)}${feedItemsXml(r)}${FEED_TAIL}`;
}

/** <item> の並び（1 行に 1 件。分けて作るときは part ごとにつなぐので、末尾にも改行） */
export function feedItemsXml(r: FeedResult): string {
  const el = (k: string, v: string | undefined) => (v === undefined ? "" : `<g:${k}>${esc(v)}</g:${k}>`);
  const items = r.items.map(
    (i) =>
      `<item>${el("id", i.id)}${el("item_group_id", i.item_group_id)}${el("title", i.title)}${el("description", i.description)}${el("link", i.link)}${el("image_link", i.image_link)}${i.additional_image_link.map((u) => el("additional_image_link", u)).join("")}${el("availability", i.availability)}${el("price", i.price)}${el("sale_price", i.sale_price)}${el("condition", i.condition)}${el("brand", i.brand)}${el("gtin", i.gtin)}${el("identifier_exists", i.identifier_exists)}${el("product_type", i.product_type)}</item>`,
  );
  return items.map((x) => `${x}\n`).join("");
}
