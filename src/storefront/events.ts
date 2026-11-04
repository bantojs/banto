/**
 * お店の画面で起きた出来事（商品を見た・カートに入れた・カートを見た・購入手続き・購入）。docs/storefront.md
 * コアはどの分析サービスの仕様も知らない（CLAUDE.md §2「分析はコアに入れない」）。ルートは中立の形で積むだけで、
 * 受け取って外の形にするのは同梱モジュール（例: ga4。src/storefront/head.ts の口から <head> に差し込む）。
 * 個人情報（氏名・メールアドレス・住所）は入れない。
 */
import type { Context } from "hono";
import type { AppEnv } from "../app";

export interface ShopEventItem {
  /** SKU の品番 */
  sku: string;
  name: string;
  /** SKU の名前（M・白 など） */
  variant?: string;
  /** 税込の単価（円） */
  price: number;
  quantity?: number;
}

export interface ShopEvent {
  type: "product_view" | "cart_add" | "cart_view" | "checkout_start" | "purchase" | "article_view" | "page_view";
  /** 税込の金額（円） */
  value_jpy: number;
  items: ShopEventItem[];
  /** purchase のときの注文番号 */
  order_number?: number;
  /** product_view のときの商品（0107。外部プラグインの条件に使う。ID・カテゴリー・タグだけ） */
  product?: { id: string; category_id?: string | null; tags?: string[] };
  /** article_view（0107）: ブログの記事。著者は記事の欄の文字（自由入力） */
  article?: { id: string; blog: string; handle: string; author?: string | null; tags?: string[] };
  /** page_view（0107）: ショップのページ */
  page?: { id: string; handle: string };
}

export function recordShopEvent(c: Context<AppEnv>, event: ShopEvent): void {
  c.set("shopEvents", [...(c.get("shopEvents") ?? []), event]);
}
