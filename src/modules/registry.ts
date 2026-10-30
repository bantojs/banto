/**
 * 同梱モジュールの一覧（3 層の 2 層目。docs/ARCHITECTURE.md「プラグインアーキテクチャ」、CLAUDE.md §7）。
 * 開発チームのコードとして同梱し、**既定 OFF**。ショップごとに管理画面で ON にする（shops.settings.modules.<id> = true）。
 * ON/OFF はキャッシュ済み / 読み込み済みのショップ行で判定し、そのために DB に問い合わせない。OFF のモジュールはルートもメニューも出さない。
 */
import type { MessageKey } from "../i18n";

export interface ModuleDef {
  id: string;
  name: MessageKey;
  description: MessageKey;
  /** ON のとき管理画面のショップ設定に出すリンク（/admin/shops/:id/modules/<adminPath>） */
  adminPath?: string;
  /** 要るマイグレーション（土台より新しいもの）。当たるまでは一覧に出さず、ON にできない（CLAUDE.md §11「コードと DB の版のずれ」） */
  migration?: string;
}

export const MODULES: readonly ModuleDef[] = [
  { id: "coupons", name: "mod.coupons.name", description: "mod.coupons.description", adminPath: "coupons" },
  { id: "woo_import", name: "mod.woo_import.name", description: "mod.woo_import.description", adminPath: "woo-import" },
  // LINE・Google でログイン（0014）。会員機能と、ショップごとの提供元の設定（モジュールの画面で入れる）が要る（docs/members.md）
  { id: "line_login", name: "mod.line_login.name", description: "mod.line_login.description", adminPath: "line-login" },
  { id: "google_login", name: "mod.google_login.name", description: "mod.google_login.description", adminPath: "google-login" },
  // 商品フィード（Google Merchant Center / Meta のカタログ）。Cron で 1 時間ごとに作り、/<スラッグ>/feed/products.xml で配る（docs/product-feed.md）
  { id: "product_feed", name: "mod.product_feed.name", description: "mod.product_feed.description", adminPath: "product-feed" },
  // 領収書（適格簡易請求書）。税の計算はコア（src/commerce/tax.ts、0017_tax）、印刷はブラウザ（docs/tax.md）
  { id: "receipt", name: "mod.receipt.name", description: "mod.receipt.description", adminPath: "receipt" },
  // 配送日時の指定（時間帯はヤマト・佐川で共通の区分）。注文の orders.delivery（0018）に入る（docs/delivery-time.md）
  { id: "delivery_time", name: "mod.delivery_time.name", description: "mod.delivery_time.description", adminPath: "delivery-time" },
  // 送り状 CSV（ヤマト B2 クラウド・佐川 e飛伝Ⅲ）。Shift_JIS への変換はブラウザ（docs/shipping-labels.md）
  { id: "shipping_labels", name: "mod.shipping_labels.name", description: "mod.shipping_labels.description", adminPath: "shipping-labels" },
  // お店で試着（決済なし。店舗と営業日・申し込み・在庫の取り置き。0025_store_tryon、docs/store-tryon.md）
  { id: "store_tryon", name: "mod.store_tryon.name", description: "mod.store_tryon.description", adminPath: "store-tryon" },
  // パスキーでログイン（0046）。会員機能と、ショップの独自ドメインが要る（RP ID = ショップのドメイン。docs/members.md「パスキー」）
  { id: "passkey", name: "mod.passkey.name", description: "mod.passkey.description" },
  // Google アナリティクス（GA4）。お店の画面の <head> の口（src/storefront/head.ts）にタグを入れ、コアの出来事を GA4 の EC のイベントにする（docs/ga4.md）
  { id: "ga4", name: "mod.ga4.name", description: "mod.ga4.description", adminPath: "ga4" },
  // お問い合わせ（チケット。メールはリンクだけで、やり取りは Banto の画面。0061_mod_inquiries、docs/inquiries.md）
  { id: "inquiries", name: "mod.inquiries.name", description: "mod.inquiries.description", adminPath: "inquiries" },
  // ショップのページ（「私たちについて」など。/pages/<handle>。本文は決まった書式、0079_mod_pages、docs/pages.md）
  { id: "pages", name: "mod.pages.name", description: "mod.pages.description", adminPath: "pages", migration: "0079_mod_pages" },
];

export function moduleEnabled(settings: Record<string, unknown> | null | undefined, id: string): boolean {
  const mods = (settings ?? {})["modules"];
  return Boolean(mods && typeof mods === "object" && (mods as Record<string, unknown>)[id] === true);
}

export function enabledModules(settings: Record<string, unknown> | null | undefined): ModuleDef[] {
  return MODULES.filter((m) => moduleEnabled(settings, m.id));
}
