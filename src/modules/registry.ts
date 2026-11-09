/**
 * 同梱モジュールの一覧（3 層の 2 層目。docs/ARCHITECTURE.md「プラグインアーキテクチャ」、CLAUDE.md §7）。
 * 開発チームのコードとして同梱し、**既定 OFF**。ショップごとに管理画面で ON にする（shops.settings.modules.<id> = true）。
 * ON/OFF はキャッシュ済み / 読み込み済みのショップ行で判定し、そのために DB に問い合わせない。OFF のモジュールはルートもメニューも出さない。
 */
import type { MessageKey } from "../i18n";
import type { ShopPerm } from "../routes/admin/access";
import { CARE_MIGRATION } from "../care-labels/care";

/** お気に入り（0123_mod_favorites）のマイグレーション。モジュールの一覧と API が「当たるまで出さない」判定に使う */
export const FAVORITES_MIGRATION = "0123_mod_favorites";

export interface ModuleDef {
  id: string;
  name: MessageKey;
  description: MessageKey;
  /** ON のとき管理画面のショップ設定に出すリンク（/admin/shops/:id/modules/<adminPath>） */
  adminPath?: string;
  /**
   * このモジュールを扱う権限の項目。画面の入口（loadShop）・上のタブ・ショップ設定の近道が使う。
   * ON / OFF の切り替えは settings に加えてこの項目も要る（DB の banto_shops_guard が banto_shop_settings_perm（0129）で確かめるのと同じ。機能の画面はこの項目の無い人に切り替えのボタンを出さない）。
   * 全モジュールで決める（test/module-perms.test.ts が DB の対応表と画面に縛る）
   */
  perm: ShopPerm;
  /** 要るマイグレーション（土台より新しいもの）。当たるまでは一覧に出さず、ON にできない（CLAUDE.md §11「コードと DB の版のずれ」） */
  migration?: string;
}

export const MODULES: readonly ModuleDef[] = [
  { id: "coupons", name: "mod.coupons.name", description: "mod.coupons.description", perm: "marketing", adminPath: "coupons" },
  { id: "woo_import", name: "mod.woo_import.name", description: "mod.woo_import.description", perm: "catalog", adminPath: "woo-import" },
  // LINE・Google でログイン（0014）。会員機能と、ショップごとの提供元の設定（モジュールの画面で入れる）が要る（docs/members.md）
  { id: "line_login", name: "mod.line_login.name", description: "mod.line_login.description", perm: "integrations", adminPath: "line-login" },
  { id: "google_login", name: "mod.google_login.name", description: "mod.google_login.description", perm: "integrations", adminPath: "google-login" },
  // 商品フィード（Google Merchant Center / Meta のカタログ）。Cron で 1 時間ごとに作り、/<スラッグ>/feed/products.xml で配る（docs/product-feed.md）
  { id: "product_feed", name: "mod.product_feed.name", description: "mod.product_feed.description", perm: "marketing", adminPath: "product-feed" },
  // 領収書（適格簡易請求書）。税の計算はコア（src/commerce/tax.ts、0017_tax）、印刷はブラウザ（docs/tax.md）
  { id: "receipt", name: "mod.receipt.name", description: "mod.receipt.description", perm: "settings", adminPath: "receipt" },
  // 配送日時の指定（時間帯はヤマト・佐川で共通の区分）。注文の orders.delivery（0018）に入る（docs/delivery-time.md）
  { id: "delivery_time", name: "mod.delivery_time.name", description: "mod.delivery_time.description", perm: "settings", adminPath: "delivery-time" },
  // 送り状 CSV（ヤマト B2 クラウド・佐川 e飛伝Ⅲ）。Shift_JIS への変換はブラウザ（docs/shipping-labels.md）
  { id: "shipping_labels", name: "mod.shipping_labels.name", description: "mod.shipping_labels.description", perm: "orders", adminPath: "shipping-labels" },
  // お店で試着（決済なし。店舗と営業日・申し込み・在庫の取り置き。0025_store_tryon、docs/store-tryon.md）
  { id: "store_tryon", name: "mod.store_tryon.name", description: "mod.store_tryon.description", perm: "stores", adminPath: "store-tryon" },
  // パスキーでログイン（0046）。会員機能と、ショップの独自ドメインが要る（RP ID = ショップのドメイン。docs/members.md「パスキー」）
  { id: "passkey", name: "mod.passkey.name", description: "mod.passkey.description", perm: "integrations" },
  // Google アナリティクス（GA4）。お店の画面の <head> の口（src/storefront/head.ts）にタグを入れ、コアの出来事を GA4 の EC のイベントにする（docs/ga4.md）
  { id: "ga4", name: "mod.ga4.name", description: "mod.ga4.description", perm: "settings", adminPath: "ga4" },
  // お問い合わせ（チケット。メールはリンクだけで、やり取りは Banto の画面。0061_mod_inquiries、docs/inquiries.md）
  { id: "inquiries", name: "mod.inquiries.name", description: "mod.inquiries.description", perm: "support", adminPath: "inquiries" },
  // ショップのページ（「私たちについて」など。/pages/<handle>。本文は決まった書式、0079_mod_pages、docs/pages.md）
  { id: "pages", name: "mod.pages.name", description: "mod.pages.description", perm: "content", adminPath: "pages" },
  // ブログと記事（/blogs/<ブログ>・/blogs/<ブログ>/<記事>。編集の画面はページと同じ、0081_mod_blog、docs/blog.md）
  { id: "blog", name: "mod.blog.name", description: "mod.blog.description", perm: "content", adminPath: "blog" },
  // 貼れるタグ（Web Component。STUDIO・Wix・ペライチなど HTML を貼れるサイトに商品とカートを置く。レジは Banto の画面）。
  // スクリプト（/api/embed/v1.js）は公開 API を呼ぶだけの静的なファイルなので ON/OFF に関係なく配り、ON で貼るコードの画面を出す（docs/embed.md）
  { id: "embed", name: "mod.embed.name", description: "mod.embed.description", perm: "catalog", adminPath: "embed" },
  // 採寸表（ショップ全体・カテゴリー・商品の段。表示するときに近い段から決める。0095_mod_size_charts、docs/size-charts.md）
  // 会員の条件（会員の独自項目の組み合わせ。ブロック・商品・ページ・会員価格で使う。0097_audiences、docs/audiences.md）
  { id: "audiences", name: "mod.audiences.name", description: "mod.audiences.description", perm: "marketing", adminPath: "audiences" },
  { id: "size_charts", name: "mod.size_charts.name", description: "mod.size_charts.description", perm: "catalog", adminPath: "size-charts" },
  // お店の行動（商品を見た・記事を読んだ・カートに入れた…）を、つないだ外部プラグインへ渡す。何を渡すかは連携ごとに運営者が許す（0107_mod_event_relay、docs/event-relay.md）
  { id: "event_relay", name: "mod.event_relay.name", description: "mod.event_relay.description", perm: "integrations" },
  // お店の画面のダイアログ（今の訪問・今のページで分かることだけで出す。0110_mod_dialogs、docs/dialogs.md）
  { id: "dialogs", name: "mod.dialogs.name", description: "mod.dialogs.description", perm: "marketing", adminPath: "dialogs" },
  // 会員のお気に入り（本人・運営者・AI 用 API と連携。ゲストはブラウザに覚えてログインで移す。0123_mod_favorites、docs/favorites.md）
  { id: "favorites", name: "mod.favorites.name", description: "mod.favorites.description", perm: "customers", migration: FAVORITES_MIGRATION },
  // 洗濯表示（JIS L 0001 の記号番号。カテゴリーで決めて商品で上書き。記号の絵は運営者が持ち込む。0127_mod_care_labels、docs/care-labels.md）
  { id: "care_labels", name: "mod.care_labels.name", description: "mod.care_labels.description", perm: "catalog", adminPath: "care-labels", migration: CARE_MIGRATION },
];

export function moduleEnabled(settings: Record<string, unknown> | null | undefined, id: string): boolean {
  const mods = (settings ?? {})["modules"];
  return Boolean(mods && typeof mods === "object" && (mods as Record<string, unknown>)[id] === true);
}

export function enabledModules(settings: Record<string, unknown> | null | undefined): ModuleDef[] {
  return MODULES.filter((m) => moduleEnabled(settings, m.id));
}
