/** supabase/migrations/ のテーブルに対応する行の型（アプリ層で使う列だけ） */

export interface ShopRow {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  published: boolean;
  legal_notice: string | null;
  privacy_policy: string | null;
  return_policy: string | null;
  stripe_account_id: string | null;
  settings: Record<string, unknown>;
  /** 0015_shop_domain。独自ドメイン（ホスト名）。null ならパス（/<スラッグ>）で公開 */
  domain?: string | null;
  /** 0024_organizations。ショップの持ち主の組織 */
  org_id?: string | null;
  /** 0062_legal_links。法務のページの外の URL を確かめた結果（legal_links_record だけが書く） */
  legal_links_state?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ProductRow {
  id: string;
  shop_id: string;
  slug: string;
  name: string;
  description: string | null;
  /** 0007_tags.sql。src/products/tags.ts で正規化する */
  tags: string[];
  /** 0008_catalog.sql。主カテゴリー（1 つ）。null なら未分類 */
  category_id?: string | null;
  /** 0042。追加カテゴリー（売り場の棚、20 個まで）。絞り込みとクーポンの条件で主カテゴリーと同じに扱う。src/products/categories.ts の productCategoryIds */
  extra_category_ids?: string[];
  brand?: string | null;
  /** カスタム項目の値（定義は shops.settings.product_fields。src/products/fields.ts） */
  attributes?: Record<string, string | number>;
  /** 0017_tax。税の区分（standard 標準 / reduced 軽減 / exempt 非課税）。src/commerce/tax.ts */
  tax_class?: "standard" | "reduced" | "exempt";
  published: boolean;
  created_at: string;
  updated_at: string;
}

export interface SkuRow {
  id: string;
  shop_id: string;
  product_id: string;
  code: string;
  name: string | null;
  price_jpy: number;
  /** 0008_catalog.sql。選択肢（例: {"サイズ": "M"}） */
  options?: Record<string, string | number>;
  /** JAN / GTIN */
  gtin?: string | null;
  /** 通常価格（セール表示用）。price_jpy より高いときだけ */
  compare_at_price_jpy?: number | null;
  created_at: string;
}

/** 0008_catalog.sql。3 段まで */
export interface CategoryRow {
  id: string;
  shop_id: string;
  parent_id: string | null;
  slug: string;
  name: string;
  sort_order: number;
  created_at: string;
}

export interface InventoryRow {
  sku_id: string;
  shop_id: string;
  available: number;
  updated_at: string;
}

export interface ProductImageRow {
  id: string;
  shop_id: string;
  product_id: string;
  storage_key: string;
  /** サムネイル（長辺 400px）のキー。管理画面からのアップロードだけが持つ。null なら本画像を使う */
  thumb_key: string | null;
  width: number | null;
  height: number | null;
  sort_order: number;
  created_at: string;
}

export interface OrderRow {
  id: string;
  shop_id: string;
  reservation_id: string | null;
  status: "paid" | "shipped" | "cancelled" | "refunded";
  total_jpy: number;
  customer_email: string | null;
  customer_name: string | null;
  shipping_address: Record<string, unknown> | null;
  payment_provider: string | null;
  payment_ref: string | null;
  shipped_at: string | null;
  created_at: string;
  updated_at: string;
  customer_id?: string | null;
  /** 値引きの合計とスナップショット（0010_coupons） */
  discount_jpy?: number;
  discounts?: { code?: string; name?: string; amount_jpy?: number }[] | null;
  /** 決済事業者が受け取った額（照合用） */
  amount_paid_jpy?: number | null;
}

export interface OrderItemRow {
  id: string;
  shop_id: string;
  order_id: string;
  /** 取り込んだ過去の注文で、Banto に無い商品の明細は null（0023） */
  sku_id: string | null;
  qty: number;
  unit_price_jpy: number;
  /** 取り込んだ時点の品名・バリエーション（0023。通常の注文では null） */
  item_name?: string | null;
  item_variant?: string | null;
}

/** クーポンのキャンペーン（0010_coupons.sql） */
export interface CouponCampaignRow {
  id: string;
  shop_id: string;
  name: string;
  code: string | null;
  kind: "percent" | "fixed" | "free_shipping";
  value: number;
  starts_at: string | null;
  ends_at: string | null;
  usage_limit: number | null;
  per_customer_limit: number | null;
  combinable: boolean;
  audience: "public" | "members";
  conditions: Record<string, unknown>;
  active: boolean;
  /** 0019。発行したクーポンの有効日数（受け取ってから。null ならキャンペーンの期間だけ） */
  grant_valid_days?: number | null;
  /** 0020。自動で配る（会員の初回ログイン / 注文の確定）と、先着の獲得ページ */
  auto_grant?: "first_login" | "after_purchase" | null;
  claimable?: boolean;
  created_at: string;
  updated_at: string;
}
