/**
 * AI 用トークンでの操作をまとめる層（docs/ai-access.md）。REST（/api/v1）と MCP（/mcp）の両方がここを使う。
 * 権限の判定は SQL（api_*）側。ここはトークンのハッシュ化、エラーの分類、画像の取り込みだけを担う。
 */
import type { PrivilegedDb } from "../db/privileged";
import { PrivilegedRpcError } from "../db/privileged";
import type { StorageAdapter } from "../adapters/types";
import { hashApiToken } from "./tokens";
import { MAX_IMAGE_BYTES, MAX_THUMB_BYTES, imageSize, productImageKey, sniffImage, thumbKey } from "../media/images";
import { fetchImage, ImageFetchError } from "../media/fetch-image";
import type { ConfigAdapter } from "../adapters/types";
import { CancelError, refundPayment } from "../orders/cancel";
import { migrated, type MigrationStateDeps } from "../db/migration-state";
import { planLimitOf } from "../plan/limits";
import { RELAY_LIMITS_MIGRATION } from "../commerce/checkout";
import { API_COUPONS_CUSTOMERS_MIGRATION } from "./tokens";
import { COUPON_ATTRIBUTES_MIGRATION, CUSTOMER_MASTER_MIGRATION, MARKETING_CONSENT_MIGRATION } from "../customers/fields";

/** 商品画像のファイルを送る（api_image_add_file）版 */
import { EXTRA_CATEGORIES_MIGRATION } from "../products/categories";
/** クーポンの条件のブランドと支払い方法（banto_api_coupon_apply が受け付ける版） */
export const COUPON_BRAND_PAYMENT_MIGRATION = "0044_coupon_brand_payment";
export const API_IMAGE_UPLOAD_MIGRATION = "0037_api_image_upload";

/** 購入前の確認画面の文言（checkout_terms）を api_shop_get / api_shop_update が扱う版 */
export const API_CHECKOUT_TERMS_MIGRATION = "0032_api_checkout_terms";

export type ApiErrorCode = "unauthorized" | "forbidden" | "not_found" | "invalid" | "conflict" | "migration_required" | "upstream";

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function mapRpcError(e: unknown): never {
  if (e instanceof PrivilegedRpcError) {
    if (e.is("unauthorized") || e.status === 401 || e.status === 403) throw new ApiError("unauthorized", "invalid, expired or insufficiently scoped token", 401);
    if (e.is("not_found")) throw new ApiError("not_found", "not found", 404);
    // クーポンと会員（0036）
    if (e.is("module_disabled")) throw new ApiError("conflict", "module_disabled: turn on the coupons module in the admin screen", 409);
    if (e.is("coupon_in_use")) throw new ApiError("conflict", "coupon_in_use: a coupon that has been used cannot be deleted; set active to false instead", 409);
    if (e.is("usage_limit_below_used")) throw new ApiError("conflict", "usage_limit_below_used: usage_limit cannot be lower than the uses so far", 409);
    if (e.is("email_taken")) throw new ApiError("conflict", "email_taken: a member with this email address already exists", 409);
    // 顧客マスタの外部連携（0047）
    if (e.is("external_ref_taken")) throw new ApiError("conflict", "external_ref_taken: another member already has this external_ref (provider + id)", 409);
    if (e.is("consent_requires_person")) throw new ApiError("invalid", "consent_requires_person: marketing_consent can only be set to true by the customer (checkout / account page); the API may only withdraw it (false)", 400);
    if (e.is("invalid_storage_key") || e.is("invalid_thumb_key") || e.is("invalid_dimensions")) throw new ApiError("invalid", e.dbMessage.replace(/^(invalid_[a-z_]+).*$/s, "$1"), 400);
    if (e.is("email_change_not_allowed")) throw new ApiError("invalid", "email_change_not_allowed: email addresses can only be changed from the admin screen", 400);
    if (/invalid_transition|hold_until_required|not_restockable/.test(e.dbMessage)) throw new ApiError("conflict", e.dbMessage.replace(/^.*?(invalid_transition|hold_until_required|not_restockable).*$/s, "$1"), 409);
    if (e.is("invalid_extra_categories")) throw new ApiError("invalid", "invalid_extra_categories: an array of up to 20 category slugs", 400);
    if (e.is("category_not_found")) throw new ApiError("invalid", "category_not_found: create it with category_save first", 400);
    if (/category_too_deep|category_cycle/.test(e.dbMessage)) throw new ApiError("invalid", "categories can be at most 3 levels deep and cannot be moved under their own child", 400);
    // プランの上限（0052）
    const hit = planLimitOf(e);
    if (hit) throw new ApiError("conflict", `plan_limit_exceeded: this Banto's plan allows at most ${hit.limit} ${hit.kind}; delete some or ask the operator to raise the plan`, 409);
    if (/duplicate key/.test(e.dbMessage)) throw new ApiError("conflict", "a record with the same slug or code already exists", 409);
    if (/violates foreign key constraint/.test(e.dbMessage)) throw new ApiError("conflict", "the record is referenced by orders and cannot be deleted", 409);
    if (/violates check constraint "shops_publish_requires_legal"/.test(e.dbMessage)) throw new ApiError("invalid", "legal_notice, privacy_policy and return_policy are required before publishing", 400);
    if (/violates check constraint|invalid_|null value in column|invalid input syntax/.test(e.dbMessage)) throw new ApiError("invalid", e.dbMessage.replace(/^.*?(invalid_[a-z_]+).*$/s, "$1"), 400);
    throw new ApiError("upstream", "database error", 502);
  }
  throw e;
}

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
/** id の形が違えば、存在しないのと同じ not_found（DB の型エラーを 400 で返して形の違いを言い分けない） */
function uuidOr404(v: string): string {
  if (!isUuid(v)) throw new ApiError("not_found", "not found", 404);
  return v;
}

export interface ListQuery {
  query?: string;
  published?: boolean;
  limit?: number;
  offset?: number;
}

export interface OrdersQuery {
  status?: string;
  /** 注文番号、または（orders:pii があれば）メール・氏名の部分一致 */
  query?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** AI から進められる試着の状態（期限切れは Cron。在庫を戻すのは tryonRequestRestock） */
export const TRYON_API_STATUSES = ["sent", "ready", "purchased", "not_purchased", "cancelled"] as const;
export type TryonApiStatus = (typeof TRYON_API_STATUSES)[number];
export const isTryonApiStatus = (v: unknown): v is TryonApiStatus => typeof v === "string" && (TRYON_API_STATUSES as readonly string[]).includes(v);

export class ApiService {
  private constructor(
    private readonly db: PrivilegedDb,
    private readonly tokenHash: string,
    private readonly storage: StorageAdapter,
    private readonly fetchImpl: typeof fetch,
    private readonly config: ConfigAdapter,
    private readonly migrationState: MigrationStateDeps | null,
    /** 外から渡された URL を開く fetch（Node では社内のアドレスに繋がない。監査 M12） */
    private readonly publicFetch: typeof fetch = fetchImpl,
  ) {}

  /** migrationState: 新しいマイグレーションを使う項目を、適用されるまで受け付けないため（null なら新しい項目は受け付けない） */
  static async forToken(
    rawToken: string,
    deps: { db: PrivilegedDb; storage: StorageAdapter; fetch: typeof fetch; publicFetch?: typeof fetch | undefined; config: ConfigAdapter; migrationState: MigrationStateDeps | null },
  ): Promise<ApiService> {
    return new ApiService(deps.db, await hashApiToken(rawToken), deps.storage, deps.fetch, deps.config, deps.migrationState, deps.publicFetch ?? deps.fetch);
  }

  private migratedTo(version: string): Promise<boolean> {
    return this.migrationState ? migrated(this.migrationState, version) : Promise.resolve(false);
  }

  /**
   * 古い DB が黙って捨てる（または知らない鍵で断る）項目を、わかる理由で断る。
   * DB の版はその項目を書けるトークンにだけ明かす（スコープが無ければ 401）
   */
  private async requireMigration(field: string, version: string, scope: string): Promise<void> {
    if (await this.migratedTo(version)) return;
    if (!(await this.call<boolean>("api_has_scope", { p_scope: scope }))) throw new ApiError("unauthorized", "invalid, expired or insufficiently scoped token", 401);
    throw new ApiError("migration_required", `${field} needs the database update ${version}; apply it from /admin/update`, 409);
  }

  private async call<T>(fn: `api_${string}`, args: Record<string, unknown>): Promise<T> {
    try {
      return await this.db.apiRpc<T>(fn, { p_token_hash: this.tokenHash, ...args });
    } catch (e) {
      return mapRpcError(e);
    }
  }

  // ---- shop ----
  shopGet = () => this.call<Record<string, unknown>>("api_shop_get", {});
  shopUpdate = async (values: Record<string, unknown>) => {
    // 0032 より前の DB は checkout_terms を黙って捨てるので、保存したと誤解させないように断る（DB の版は shop:write を持つトークンにだけ明かす）
    // 同じく 0033 より前の DB は IP ごとの上限（max_pending_per_ip / login_per_ip_per_hour）を黙って捨てる
    const needs: [string, string][] = [];
    if (values["checkout_terms"] !== undefined) needs.push(["checkout_terms", API_CHECKOUT_TERMS_MIGRATION]);
    if (values["max_pending_per_ip"] !== undefined || values["login_per_ip_per_hour"] !== undefined) needs.push(["max_pending_per_ip / login_per_ip_per_hour", RELAY_LIMITS_MIGRATION]);
    for (const [field, version] of needs) {
      if (await this.migratedTo(version)) continue;
      if (!(await this.call<boolean>("api_has_scope", { p_scope: "shop:write" }))) throw new ApiError("unauthorized", "invalid, expired or insufficiently scoped token", 401);
      throw new ApiError("migration_required", `${field} needs the database update ${version}; apply it from /admin/update`, 409);
    }
    return this.call<Record<string, unknown>>("api_shop_update", { p_values: values });
  };

  // ---- products ----
  productsList = (q: ListQuery = {}) =>
    this.call<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number }>("api_products_list", {
      p_query: q.query ?? null,
      p_published: q.published ?? null,
      p_limit: q.limit ?? 50,
      p_offset: q.offset ?? 0,
    });
  productGet = (ref: { id?: string; slug?: string }) => this.call<Record<string, unknown>>("api_product_get", { p_product_id: ref.id ?? null, p_slug: ref.slug ?? null });
  productCreate = async (values: Record<string, unknown>) => {
    if (values["extra_categories"] !== undefined) await this.requireMigration("extra_categories", EXTRA_CATEGORIES_MIGRATION, "products:write");
    return this.call<Record<string, unknown>>("api_product_create", { p_values: values });
  };
  productUpdate = async (id: string, values: Record<string, unknown>) => {
    if (values["extra_categories"] !== undefined) await this.requireMigration("extra_categories", EXTRA_CATEGORIES_MIGRATION, "products:write");
    return this.call<Record<string, unknown>>("api_product_update", { p_product_id: id, p_values: values });
  };
  skuCreate = (productId: string, values: Record<string, unknown>) => this.call<Record<string, unknown>>("api_sku_create", { p_product_id: productId, p_values: values });
  skuUpdate = (skuId: string, values: Record<string, unknown>) => this.call<Record<string, unknown>>("api_sku_update", { p_sku_id: skuId, p_values: values });
  categoriesList = () => this.call<Record<string, unknown>[]>("api_categories_list", {});
  categorySave = (values: Record<string, unknown>) => this.call<Record<string, unknown>>("api_category_save", { p_values: values });
  skuDelete = (skuId: string) => this.call<Record<string, unknown>>("api_sku_delete", { p_sku_id: skuId });

  /** 画像を URL から取り込む。http(s) のみ、プライベートアドレス不可、5MB まで、画像の Content-Type のみ */
  async imageAddFromUrl(productId: string, url: string): Promise<Record<string, unknown>> {
    // URL の形を先に確かめる（不正な URL で所有確認の RPC を呼ばない）
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new ImageFetchError("image_url must be http(s)");
    } catch (e) {
      throw new ApiError("invalid", e instanceof ImageFetchError ? e.message : "image_url must be an absolute http(s) URL", 400);
    }
    // 所有確認を先に（取得前に他ショップの product_id を弾く）
    await this.productGet({ id: productId });
    let image: Awaited<ReturnType<typeof fetchImage>>;
    try {
      image = await fetchImage(url, this.publicFetch);
    } catch (e) {
      if (e instanceof ImageFetchError) throw new ApiError("invalid", e.message, 400);
      throw e;
    }
    const { body: buf, contentType, ext } = image;

    // storage_key の shop_id は SQL 側で検証されるので、ここでは RPC から shop_id を得るために product を使う
    const shop = await this.shopGetIdOnly();
    const key = productImageKey(shop, productId, ext);
    await this.storage.put(key, buf, contentType);
    try {
      return await this.call<Record<string, unknown>>("api_image_add", { p_product_id: productId, p_storage_key: key, p_sort_order: null });
    } catch (e) {
      await this.storage.delete(key).catch(() => undefined);
      throw e;
    }
  }

  /** スコープを確かめてからトークンのショップ id を返す（RPC を介さない処理の入口。GET /relay-check） */
  async tokenShopFor(scope: string): Promise<string> {
    if (!(await this.call<boolean>("api_has_scope", { p_scope: scope }))) throw new ApiError("unauthorized", "invalid, expired or insufficiently scoped token", 401);
    return (await this.call<{ shop_id: string }>("api_token_shop", {})).shop_id;
  }

  /** shop:read が無いトークンでも画像追加はできるべきなので、products:read 相当の情報から shop_id を得る */
  private async shopGetIdOnly(): Promise<string> {
    const r = await this.call<{ shop_id: string }>("api_token_shop", {});
    return r.shop_id;
  }

  /** キャンセル: 決済事業者で返金してから cancel_order。返金に失敗したら注文は変えない */
  async orderCancel(id: string): Promise<Record<string, unknown>> {
    const info = await this.call<{ status: string; payment_provider: string | null; payment_ref: string | null }>("api_order_payment_info", { p_order_id: id });
    if (info.status === "cancelled" || info.status === "refunded") return this.orderGet(id);
    if (info.status !== "paid") throw new ApiError("invalid", `order is ${info.status} and cannot be cancelled`, 400);
    const shop = await this.call<{ shop_id: string; stripe_account_id?: string | null }>("api_token_shop", {});
    let refunded = false;
    try {
      refunded = await refundPayment(info, { config: this.config, fetch: this.fetchImpl, stripeAccountId: shop.stripe_account_id ?? null, idempotencyKey: `cancel-${id}` });
    } catch (e) {
      throw new ApiError("upstream", `refund failed: ${e instanceof CancelError || e instanceof Error ? e.message : String(e)}`, 502);
    }
    return this.call<Record<string, unknown>>("api_order_cancel", { p_order_id: id, p_refunded: refunded });
  }

  /**
   * ファイルで送られた画像（とサムネイル）を置いて商品に登録する（0037）。縮小はしない（長辺 1600px 程度に縮小済みのものを送る）。
   * 種類は中身の先頭のバイトで決め、申告の Content-Type は信じない。SVG は受けない。寸法は見出しから読む（AVIF は読まない）。
   */
  async imageUpload(productId: string, image: Uint8Array, thumbnail: Uint8Array | null): Promise<Record<string, unknown>> {
    uuidOr404(productId);
    if (!(await this.migratedTo(API_IMAGE_UPLOAD_MIGRATION))) {
      await this.call("api_token_shop", {});
      throw new ApiError("migration_required", `image upload needs the database update ${API_IMAGE_UPLOAD_MIGRATION}; apply it from /admin/update`, 409);
    }
    const main = sniffImage(image.subarray(0, 256));
    if (!main) throw new ApiError("invalid", "image must be JPEG, PNG, WebP, GIF or AVIF", 400);
    if (image.byteLength > MAX_IMAGE_BYTES) throw new ApiError("invalid", "image is larger than 5MB", 400);
    const thumb = thumbnail ? sniffImage(thumbnail.subarray(0, 256)) : null;
    if (thumbnail && !thumb) throw new ApiError("invalid", "thumbnail must be JPEG, PNG, WebP, GIF or AVIF", 400);
    if (thumbnail && thumbnail.byteLength > MAX_THUMB_BYTES) throw new ApiError("invalid", "thumbnail is larger than 1MB", 400);
    // ストレージに書く前に、書き込みのスコープを確かめる（他のショップの商品は api_image_add_file が not_found にして、置いたものを消す）
    if (!(await this.call<boolean>("api_has_scope", { p_scope: "products:write" }))) throw new ApiError("unauthorized", "invalid, expired or insufficiently scoped token", 401);
    const shop = await this.shopGetIdOnly();
    const key = productImageKey(shop, productId, main.ext);
    const tkey = thumbnail && thumb ? thumbKey(key, thumb.ext) : null;
    const size = imageSize(image, main.contentType);
    const copy = (b: Uint8Array) => b.slice().buffer;
    await this.storage.put(key, copy(image), main.contentType);
    try {
      if (tkey && thumbnail && thumb) await this.storage.put(tkey, copy(thumbnail), thumb.contentType);
      return await this.call<Record<string, unknown>>("api_image_add_file", { p_product_id: productId, p_storage_key: key, p_thumb_key: tkey, p_width: size?.width ?? null, p_height: size?.height ?? null });
    } catch (e) {
      await Promise.all([key, tkey].filter((k): k is string => !!k).map((k) => this.storage.delete(k).catch(() => undefined)));
      throw e;
    }
  }

  async imageDelete(imageId: string): Promise<void> {
    const keys = await this.call<{ storage_key: string; thumb_key: string | null }>("api_image_delete", { p_image_id: imageId });
    await Promise.all([keys.storage_key, keys.thumb_key].filter((k): k is string => !!k).map((k) => this.storage.delete(k).catch(() => undefined)));
  }

  // ---- orders ----
  ordersList = (q: OrdersQuery = {}) =>
    this.call<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number; pii: boolean }>("api_orders_list", {
      p_status: q.status ?? null,
      p_from: q.from ?? null,
      p_to: q.to ?? null,
      p_limit: q.limit ?? 50,
      p_offset: q.offset ?? 0,
      p_query: q.query ?? null,
    });
  orderGet = (id: string) => this.call<Record<string, unknown>>("api_order_get", { p_order_id: id });
  orderUpdateStatus = (id: string, status: "shipped" | "cancelled") =>
    status === "cancelled" ? this.orderCancel(id) : this.call<Record<string, unknown>>("api_order_update_status", { p_order_id: id, p_status: status });

  // ---- お店で試着（0026。注文に準じて orders:read / orders:write、連絡先は orders:pii）----
  tryonRequestsList = (q: { status?: string; storeId?: string; limit?: number; offset?: number } = {}) =>
    this.call<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number; pii: boolean }>("api_tryon_requests_list", {
      p_status: q.status ?? null,
      p_store_id: q.storeId ?? null,
      p_limit: q.limit ?? 50,
      p_offset: q.offset ?? 0,
    });
  tryonRequestGet = (number: number) => this.call<Record<string, unknown>>("api_tryon_request_get", { p_number: number });
  tryonRequestUpdate = (number: number, status: TryonApiStatus, holdUntil?: string) =>
    this.call<Record<string, unknown>>("api_tryon_request_update", { p_number: number, p_status: status, p_hold_until: holdUntil ?? null });
  /** 終わった申し込み（購入なし・期限切れ・取り消し）の在庫を EC に戻す。2 回目は何もしない */
  tryonRequestRestock = (number: number) => this.call<Record<string, unknown>>("api_tryon_request_restock", { p_number: number });
  storesList = () => this.call<Record<string, unknown>[]>("api_stores_list", {});

  // ---- クーポン（0036。coupons:read / coupons:write、モジュール coupons が ON のショップだけ）----
  /**
   * 0036 より前の DB では関数が無いので、先に断る。その DB ではこれらのスコープのトークンは作れないので、
   * 有効なトークンであることだけ確かめてから DB の版を返す（無効なトークンには unauthorized）
   */
  private async need0036(scope: string): Promise<void> {
    if (await this.migratedTo(API_COUPONS_CUSTOMERS_MIGRATION)) return;
    await this.call("api_token_shop", {});
    throw new ApiError("migration_required", `this endpoint needs the database update ${API_COUPONS_CUSTOMERS_MIGRATION}; apply it from /admin/update (${scope})`, 409);
  }
  private async call0036<T>(scope: string, fn: `api_${string}`, args: Record<string, unknown>): Promise<T> {
    await this.need0036(scope);
    return this.call<T>(fn, args);
  }
  couponsList = (q: { query?: string; active?: boolean; limit?: number; offset?: number } = {}) =>
    this.call0036<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number }>("coupons:read", "api_coupons_list", {
      p_query: q.query ?? null,
      p_active: q.active ?? null,
      p_limit: q.limit ?? 50,
      p_offset: q.offset ?? 0,
    });
  // id の形の検査（uuidOr404）は同期で投げるので、どれも async にして Promise の失敗として返す
  /** id（UUID）かコードで 1 件 */
  couponGet = async (ref: string) => this.call0036<Record<string, unknown>>("coupons:read", "api_coupon_get", isUuid(ref) ? { p_campaign_id: ref, p_code: null } : { p_campaign_id: null, p_code: ref });
  couponCreate = async (values: Record<string, unknown>) => {
    await this.needTagConditions(values);
    return this.call0036<Record<string, unknown>>("coupons:write", "api_coupon_create", { p_values: values });
  };
  couponUpdate = async (id: string, values: Record<string, unknown>) => {
    const campaignId = uuidOr404(id);
    await this.needTagConditions(values);
    return this.call0036<Record<string, unknown>>("coupons:write", "api_coupon_update", { p_campaign_id: campaignId, p_values: values });
  };
  /** タグ（0042）・ブランドと支払い方法（0044）の条件。古い DB は知らない鍵として断るので、わかる理由で先に断る */
  private async needTagConditions(values: Record<string, unknown>): Promise<void> {
    const cond = values["conditions"];
    if (!cond || typeof cond !== "object") return;
    const has = (keys: string[]) => keys.some((k) => k in cond);
    if (!has(["tags", "exclude_tags", "brands", "exclude_brands", "payment_methods", "attributes"])) return;
    await this.need0036("coupons:write");
    if (has(["tags", "exclude_tags"])) await this.requireMigration("conditions.tags / exclude_tags", EXTRA_CATEGORIES_MIGRATION, "coupons:write");
    if (has(["brands", "exclude_brands", "payment_methods"])) await this.requireMigration("conditions.brands / exclude_brands / payment_methods", COUPON_BRAND_PAYMENT_MIGRATION, "coupons:write");
    if (has(["attributes"])) await this.requireMigration("conditions.attributes", COUPON_ATTRIBUTES_MIGRATION, "coupons:write");
  }
  couponDelete = async (id: string) => this.call0036<Record<string, unknown>>("coupons:write", "api_coupon_delete", { p_campaign_id: uuidOr404(id) });
  couponGrantsList = async (id: string, q: { status?: string; limit?: number; offset?: number } = {}) =>
    this.call0036<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number }>("coupons:read", "api_coupon_grants_list", {
      p_campaign_id: uuidOr404(id),
      p_status: q.status ?? null,
      p_limit: q.limit ?? 50,
      p_offset: q.offset ?? 0,
    });
  /** 会員 ID ごとに 1 枚と、誰でも 1 回使えるコードを count 枚（合わせて 500 まで） */
  couponGrantsIssue = async (id: string, customerIds: string[], count: number) => {
    if (customerIds.some((x) => !isUuid(x))) throw new ApiError("invalid", "customer_ids must be member ids (UUID)", 400);
    return this.call0036<Record<string, unknown>>("coupons:write", "api_coupon_grants_issue", { p_campaign_id: uuidOr404(id), p_customer_ids: customerIds, p_count: count });
  };
  couponGrantRevoke = async (grantId: string) => this.call0036<Record<string, unknown>>("coupons:write", "api_coupon_grant_revoke", { p_grant_id: uuidOr404(grantId) });

  // ---- 会員（0036。customers:read / customers:write。メールアドレスは変えられない）----
  // 0047: external_ref（外部の ID）・attributes（独自項目。定義は shops.settings.customer_fields）・updated_since・upsert（docs/knowledge/13-external-customer-master.md）
  customersList = async (q: { query?: string; email?: string; limit?: number; offset?: number; externalProvider?: string; externalId?: string; updatedSince?: string; marketingConsent?: boolean } = {}) => {
    const extra: Record<string, unknown> = {};
    if (q.marketingConsent !== undefined) {
      await this.need0036("customers:read");
      await this.requireMigration("marketing_consent", MARKETING_CONSENT_MIGRATION, "customers:read");
      extra["p_marketing_consent"] = q.marketingConsent;
    }
    if (q.externalProvider !== undefined || q.externalId !== undefined || q.updatedSince !== undefined) {
      await this.need0036("customers:read");
      await this.requireMigration("external_provider / external_id / updated_since", CUSTOMER_MASTER_MIGRATION, "customers:read");
      if (q.updatedSince !== undefined && Number.isNaN(Date.parse(q.updatedSince))) throw new ApiError("invalid", "updated_since must be an ISO 8601 date-time", 400);
      if (q.externalId !== undefined && !q.externalProvider) throw new ApiError("invalid", "external_id needs external_provider", 400);
      extra["p_external_provider"] = q.externalProvider ?? null;
      extra["p_external_id"] = q.externalId ?? null;
      extra["p_updated_since"] = q.updatedSince ?? null;
    }
    return this.call0036<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number }>("customers:read", "api_customers_list", {
      p_query: q.query ?? null,
      p_email: q.email ?? null,
      p_limit: q.limit ?? 50,
      p_offset: q.offset ?? 0,
      ...extra,
    });
  };
  customerGet = async (id: string) => this.call0036<Record<string, unknown>>("customers:read", "api_customer_get", { p_customer_id: uuidOr404(id) });
  customerCreate = async (values: Record<string, unknown>) => {
    await this.requireCustomerMaster(values);
    return this.call0036<Record<string, unknown>>("customers:write", "api_customer_create", { p_values: values });
  };
  customerUpdate = async (id: string, values: Record<string, unknown>) => {
    await this.requireCustomerMaster(values);
    return this.call0036<Record<string, unknown>>("customers:write", "api_customer_update", { p_customer_id: uuidOr404(id), p_values: values });
  };
  /** メールアドレスで引いて、あれば渡した鍵だけ更新、無ければ作る（外部のマスタからの同期の窓口。email は変えない） */
  customerUpsert = async (values: Record<string, unknown>) => {
    await this.need0036("customers:write");
    await this.requireMigration("customer upsert", CUSTOMER_MASTER_MIGRATION, "customers:write");
    return this.call<Record<string, unknown>>("api_customer_upsert", { p_values: values });
  };
  customerDelete = async (id: string) => this.call0036<Record<string, unknown>>("customers:write", "api_customer_delete", { p_customer_id: uuidOr404(id) });
  /** attributes / external_ref は 0047 から（古い DB では invalid_field で断られるより先に、わかる理由で断る） */
  private async requireCustomerMaster(values: Record<string, unknown>): Promise<void> {
    if (!values || typeof values !== "object") return;
    if ("marketing_consent" in values) {
      await this.need0036("customers:write");
      await this.requireMigration("marketing_consent", MARKETING_CONSENT_MIGRATION, "customers:write");
    }
    if (!("attributes" in values) && !("external_ref" in values)) return;
    await this.need0036("customers:write");
    await this.requireMigration("attributes / external_ref", CUSTOMER_MASTER_MIGRATION, "customers:write");
  }

  // ---- stats ----
  salesSummary = (from: string, to: string, groupBy: "day" | "month" | "product" = "day") =>
    this.call<Record<string, unknown>>("api_sales_summary", { p_from: from, p_to: to, p_group_by: groupBy });
  inventoryLow = (threshold?: number) => this.call<Record<string, unknown>[]>("api_inventory_low", { p_threshold: threshold ?? null });
}
