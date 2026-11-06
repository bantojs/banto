/**
 * お店の一覧の並べ替え（?sort=、メンテナの決定 2026-11-06、docs/storefront.md「URL」）。
 * 値は Banto の名前（new・price_asc・price_desc・name・updated）。Shopify のテーマの ?sort_by=（created-descending など）も同じものに読み替える。
 * 並べ方そのものは一覧の読み取り（product_public_list）と同じ。既定（new）は URL に出さない
 */
import type { MessageKey } from "../i18n";
import { PRODUCT_SORTS, type ProductSort } from "./data";

/** 画面に出す選択肢（updated は ?sort= では受けるが、お客様向けの選択肢には出さない） */
export const LIST_SORT_OPTIONS: readonly { value: ProductSort; shopify: string; label: MessageKey }[] = [
  { value: "new", shopify: "created-descending", label: "store.sort_new" },
  { value: "price_asc", shopify: "price-ascending", label: "store.sort_price_asc" },
  { value: "price_desc", shopify: "price-descending", label: "store.sort_price_desc" },
  { value: "name", shopify: "title-ascending", label: "store.sort_name" },
];

const SHOPIFY: Readonly<Record<string, ProductSort>> = {
  "created-descending": "new",
  "price-ascending": "price_asc",
  "price-descending": "price_desc",
  "title-ascending": "name",
};

/** ?sort=（Banto の名前）か ?sort_by=（Shopify の名前）→ 並べ方。既定・知らない値は undefined */
export function listSortOf(sort: string | undefined, sortBy?: string): ProductSort | undefined {
  const v = sort && (PRODUCT_SORTS as readonly string[]).includes(sort) ? (sort as ProductSort) : sortBy ? SHOPIFY[sortBy] : undefined;
  return v && v !== "new" ? v : undefined;
}

/** Shopify の名前（Liquid の collection.sort_by）。updated は Shopify に無いので Banto の名前のまま */
export function shopifySortName(sort: ProductSort | undefined): string {
  return LIST_SORT_OPTIONS.find((o) => o.value === (sort ?? "new"))?.shopify ?? (sort ?? "new");
}
