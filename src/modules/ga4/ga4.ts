/**
 * 同梱モジュール「Google アナリティクス（GA4）」（ga4、既定 OFF）。docs/ga4.md
 * 運営者自身の測定 ID（shops.settings.analytics.ga4_id、0041 で公開の settings に入る）のタグを、お店の画面の <head> に入れる
 * （コアの口 src/storefront/head.ts）。コアが積んだ中立の出来事（src/storefront/events.ts）を GA4 の EC のイベントにする。
 * 送り先は運営者の GA4 で、開発チームには何も送らない（CLAUDE.md §1-9）。個人情報は送らない（出来事に入っていない）。
 */
import type { PublicShop } from "../../storefront/data";
import type { ShopEvent } from "../../storefront/events";
import type { HeadTag, StorefrontHeadContributor } from "../../storefront/head";
import { moduleEnabled } from "../registry";

export const GA4_MODULE = "ga4";
export const GA4_ID_RE = /^G-[A-Z0-9]{4,20}$/;

export function ga4Id(settings: Record<string, unknown> | null | undefined): string | null {
  const a = settings?.["analytics"];
  const id = a && typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>)["ga4_id"] : null;
  return typeof id === "string" && GA4_ID_RE.test(id) ? id : null;
}

const GA4_EVENT: Record<ShopEvent["type"], string> = {
  product_view: "view_item",
  cart_add: "add_to_cart",
  cart_view: "view_cart",
  checkout_start: "begin_checkout",
  purchase: "purchase",
};

/** 出来事 → GA4 の EC のイベントの引数（https://developers.google.com/analytics/devguides/collection/ga4/ecommerce） */
export function ga4Params(e: ShopEvent): Record<string, unknown> {
  return {
    currency: "JPY",
    value: e.value_jpy,
    items: e.items.map((i) => ({ item_id: i.sku, item_name: i.name, ...(i.variant ? { item_variant: i.variant } : {}), price: i.price, ...(i.quantity ? { quantity: i.quantity } : {}) })),
    // GA4 は同じ transaction_id の購入を重ねて数えない（完了画面を開き直しても 1 回）
    ...(e.order_number !== undefined ? { transaction_id: String(e.order_number) } : {}),
  };
}

/** <script> の中に置く JSON（</script> や <!-- で抜けさせない） */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export function ga4Tags(id: string, events: readonly ShopEvent[]): HeadTag[] {
  const calls = events.map((e) => `gtag("event",${scriptJson(GA4_EVENT[e.type])},${scriptJson(ga4Params(e))});`).join("");
  return [
    { kind: "script", src: `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}` },
    { kind: "inline-script", code: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());gtag("config",${scriptJson(id)});${calls}` },
  ];
}

export const ga4Head: StorefrontHeadContributor = {
  module: GA4_MODULE,
  tags(shop: PublicShop, events) {
    const id = moduleEnabled(shop.settings, GA4_MODULE) ? ga4Id(shop.settings) : null;
    return id ? ga4Tags(id, events) : [];
  },
};
