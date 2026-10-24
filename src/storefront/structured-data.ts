/**
 * 構造化データ（JSON-LD、schema.org の Product）。テーマの Layout が商品ページの <head> に入れる。
 * Google の検索結果の商品情報（価格・在庫）に使われる。データ取得はしない（テーマに渡された値だけで組む）。
 */
import type { ProductRow, SkuRow } from "../db/types";

export interface ProductLdInput {
  url: string;
  product: Pick<ProductRow, "name" | "description" | "brand">;
  images: string[];
  skus: (Pick<SkuRow, "code" | "name" | "price_jpy" | "gtin"> & { available: number })[];
  category?: string[];
}

/** GTIN の桁で schema.org の項目名を選ぶ（8 / 12 / 13 / 14 桁） */
function gtinField(gtin: string | null | undefined): Record<string, string> {
  const g = (gtin ?? "").trim();
  if (!/^[0-9]{8}$|^[0-9]{12,14}$/.test(g)) return {};
  return { [`gtin${g.length}`]: g };
}

export function productJsonLd(i: ProductLdInput): Record<string, unknown> {
  const offer = (s: ProductLdInput["skus"][number]) => ({
    "@type": "Offer",
    url: i.url,
    sku: s.code,
    ...gtinField(s.gtin),
    ...(s.name ? { name: s.name } : {}),
    price: s.price_jpy,
    priceCurrency: "JPY",
    availability: s.available > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    itemCondition: "https://schema.org/NewCondition",
  });
  const single = i.skus.length === 1 ? i.skus[0]! : null;
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: i.product.name,
    url: i.url,
    ...(i.product.description ? { description: i.product.description.slice(0, 5000) } : {}),
    ...(i.images.length > 0 ? { image: i.images.slice(0, 10) } : {}),
    ...(i.product.brand ? { brand: { "@type": "Brand", name: i.product.brand } } : {}),
    ...(i.category && i.category.length > 0 ? { category: i.category.join(" > ") } : {}),
    ...(single ? { sku: single.code, ...gtinField(single.gtin) } : {}),
    ...(i.skus.length > 0 ? { offers: single ? offer(single) : i.skus.map(offer) } : {}),
  };
}

/** <script type="application/ld+json"> の中身。</script> で抜けられないように < > & と行区切り文字を逃がす */
export function jsonLdText(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
