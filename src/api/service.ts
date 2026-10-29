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
import { API_INQUIRY_ASSIGNEE_MIGRATION, API_INQUIRY_ATTACHMENTS_MIGRATION } from "./tokens";
import { attachmentResponse, removeAttachments, storeAttachments } from "../modules/inquiries/attachments";
import { SKU_IMAGES_MIGRATION } from "../products/images";
import { SKU_OPTION_AXES_MIGRATION } from "../products/option-axes";
import type { Mailer } from "../mail/send";
import { inquiryLinkHash } from "../members/auth";
import { randomToken } from "../util/signed";
import { returnOrigins, safeReturnUrl, withQueryParam } from "../commerce/checkout";
import { shopHome } from "../storefront/urls";
import { sendAssignNotice, sendReplyNotice } from "../modules/inquiries";
import type { InquiryMailShop } from "../modules/inquiries/mail";
import { deleteThemeFiles, missingThemeAsset, prepareThemeVersion, putThemeAsset, readThemeBundle, removeThemeBundle, storeThemeBundle, THEME_API_MIGRATION } from "../themes/liquid/versions";
import { THEME_PREVIEW_SECONDS, themePreviewUrl } from "../themes/liquid/preview";
import { getLocale } from "../i18n";

/** テーマ（theme:write / theme:publish、0072）。プレビューのリンクを作る秘密・お店の画面の URL・CPU の上限を気にしなくてよいランタイムか */
export interface ThemeApiDeps {
  secret: string | null;
  publicBase: string;
  cpuUnlimited: boolean;
}

/** お問い合わせの返事のお知らせ（0061）。メールのリンクのトークンを作る秘密・送り手・お店の画面の URL */
export interface InquiryMailDeps {
  secret: string;
  mailer: Mailer | null;
  publicBase: string;
}

/** AI から変えられるお問い合わせの状態 */
export const INQUIRY_API_STATUSES = ["closed", "waiting_shop", "waiting_customer"] as const;
export type InquiryApiStatus = (typeof INQUIRY_API_STATUSES)[number];
export const isInquiryApiStatus = (v: unknown): v is InquiryApiStatus => typeof v === "string" && (INQUIRY_API_STATUSES as readonly string[]).includes(v);

/** 商品画像のファイルを送る（api_image_add_file）版 */
/** クーポンの条件のブランドと支払い方法（banto_api_coupon_apply が受け付ける版） */

/** 購入前の確認画面の文言（checkout_terms）を api_shop_get / api_shop_update が扱う版 */

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

/** 画像の options の入力（0063）。無ければ undefined、object でなければ 400。中の値の形は SQL が確かめる */
export function imageOptionsInput(v: unknown): Record<string, unknown> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new ApiError("invalid", "options must be an object", 400);
  return v as Record<string, unknown>;
}

/** multipart の欄・クエリの options（JSON の文字列） */
export function parseOptionsText(v: unknown): unknown {
  if (typeof v !== "string") throw new ApiError("invalid", "options must be a JSON object", 400);
  try {
    return JSON.parse(v);
  } catch {
    throw new ApiError("invalid", "options must be a JSON object", 400);
  }
}

function mapRpcError(e: unknown): never {
  if (e instanceof PrivilegedRpcError) {
    if (e.is("unauthorized") || e.status === 401 || e.status === 403) throw new ApiError("unauthorized", "invalid, expired or insufficiently scoped token", 401);
    if (e.is("not_found")) throw new ApiError("not_found", "not found", 404);
    // クーポンと会員（0036）
    if (e.is("module_disabled")) throw new ApiError("conflict", "module_disabled: turn on the module (coupons / inquiries) in the admin screen", 409);
    if (e.is("pii_scope_required")) throw new ApiError("unauthorized", "attachments need the orders:pii scope as well as inquiries:read", 401);
    if (e.is("too_many_attachments")) throw new ApiError("invalid", "invalid_attachment: up to 3 files per reply and 20 per inquiry", 400);
    if (e.is("invalid_attachment")) throw new ApiError("invalid", "invalid_attachment", 400);
    if (e.is("inquiry_masked")) throw new ApiError("conflict", "inquiry_masked: the contact details and messages of this inquiry were erased", 409);
    if (e.is("invalid_body")) throw new ApiError("invalid", "invalid_body: body must be 1 to 5000 characters", 400);
    if (e.is("invalid_assignee")) throw new ApiError("invalid", "invalid_assignee: the assignee must be a user_id from inquiry_assignees (someone with the Inquiries permission for this shop), or null / \"none\"", 400);
    if (e.is("coupon_in_use")) throw new ApiError("conflict", "coupon_in_use: a coupon that has been used cannot be deleted; set active to false instead", 409);
    if (e.is("usage_limit_below_used")) throw new ApiError("conflict", "usage_limit_below_used: usage_limit cannot be lower than the uses so far", 409);
    if (e.is("email_taken")) throw new ApiError("conflict", "email_taken: a member with this email address already exists", 409);
    // 顧客マスタの外部連携（0047）
    if (e.is("external_ref_taken")) throw new ApiError("conflict", "external_ref_taken: another member already has this external_ref (provider + id)", 409);
    if (e.is("consent_requires_person")) throw new ApiError("invalid", "consent_requires_person: marketing_consent can only be set to true by the customer (checkout / account page); the API may only withdraw it (false)", 400);
    if (e.is("invalid_storage_key") || e.is("invalid_thumb_key") || e.is("invalid_dimensions")) throw new ApiError("invalid", e.dbMessage.replace(/^(invalid_[a-z_]+).*$/s, "$1"), 400);
    if (e.is("email_change_not_allowed")) throw new ApiError("invalid", "email_change_not_allowed: email addresses can only be changed from the admin screen", 400);
    if (/invalid_transition|hold_until_required|not_restockable/.test(e.dbMessage)) throw new ApiError("conflict", e.dbMessage.replace(/^.*?(invalid_transition|hold_until_required|not_restockable).*$/s, "$1"), 409);
    if (e.is("invalid_option_axes")) throw new ApiError("invalid", "invalid_option_axes: an array of up to 3 { key, values? } (keys up to 40 characters, no duplicates; values up to 100 strings of 60 characters), [] for SKU code only, or null to leave it unset", 400);
    if (e.is("option_axes_mismatch")) throw new ApiError("invalid", "option_axes_mismatch: SKU options must have exactly the keys of the product's option_axes, with non-empty values", 400);
    if (e.is("option_combination_exists")) throw new ApiError("conflict", "option_combination_exists: another SKU of this product has the same options", 409);
    if (e.is("invalid_options")) throw new ApiError("invalid", "invalid_options: an object of up to 5 string values (keys up to 40 characters, values up to 60) taken from the SKU options, or {} for the whole product", 400);
    if (e.is("invalid_extra_categories")) throw new ApiError("invalid", "invalid_extra_categories: an array of up to 20 category slugs", 400);
    if (e.is("category_not_found")) throw new ApiError("invalid", "category_not_found: create it with category_save first", 400);
    if (/category_too_deep|category_cycle/.test(e.dbMessage)) throw new ApiError("invalid", "categories can be at most 3 levels deep and cannot be moved under their own child", 400);
    // テーマ（0072）
    if (e.is("theme_versions_full")) throw new ApiError("conflict", "theme_versions_full: a shop can keep up to 20 theme versions; delete unpublished ones first", 409);
    if (e.is("theme_incomplete")) throw new ApiError("conflict", "theme_incomplete: upload every asset and call /complete before publishing", 409);
    if (e.is("theme_requires_domain")) throw new ApiError("conflict", "theme_requires_domain: Liquid themes are shown only on the shop's own domain; set the shop domain first", 409);
    if (e.is("theme_published")) throw new ApiError("conflict", "theme_published: the published version cannot be deleted; publish another version or unpublish first", 409);
    if (e.is("shop_unpublished")) throw new ApiError("conflict", "shop_unpublished: previews open on the storefront, so the shop must be published", 409);
    // プランの上限（0052）
    const hit = planLimitOf(e);
    if (hit) throw new ApiError("conflict", `plan_limit_exceeded: this Banto's plan allows at most ${hit.limit} ${hit.kind}; delete some or ask the operator to raise the plan`, 409);
    if (/duplicate key/.test(e.dbMessage)) throw new ApiError("conflict", "a record with the same slug or code already exists", 409);
    if (/violates foreign key constraint/.test(e.dbMessage)) throw new ApiError("conflict", "the record is referenced by orders and cannot be deleted", 409);
    if (/violates check constraint "shops_publish_requires_legal"/.test(e.dbMessage)) throw new ApiError("invalid", "legal_notice, privacy_policy and return_policy are required before publishing", 400);
    if (/violates check constraint|invalid_|null value in column|invalid input syntax/.test(e.dbMessage)) {
      // DB の内部名（制約名・列名）は外に出さない。invalid_xxx の印だけ返す
      const m = /(invalid_[a-z_]+)/.exec(e.dbMessage);
      throw new ApiError("invalid", m ? m[1]! : "invalid request", 400);
    }
    throw new ApiError("upstream", "database error", 502);
  }
  throw e;
}

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
/** id の形が違えば、存在しないのと同じ not_found（DB の型エラーを 400 で返して形の違いを言い分けない） */
/** 版の行から外に返すもの（置き場の鍵・ショップの id は返さない） */
function publicTheme(row: Record<string, unknown>): Record<string, unknown> {
  const { storage_key: _k, shop_id: _s, ...rest } = row;
  return rest;
}

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
    private readonly inquiryMail: InquiryMailDeps | null = null,
    /** お問い合わせの添付の置き場（公開しない。無ければ添付を受け付けない） */
    private readonly privateStorage: StorageAdapter | null = null,
    private readonly theme: ThemeApiDeps | null = null,
  ) {}

  /** migrationState: 新しいマイグレーションを使う項目を、適用されるまで受け付けないため（null なら新しい項目は受け付けない） */
  static async forToken(
    rawToken: string,
    deps: { db: PrivilegedDb; storage: StorageAdapter; fetch: typeof fetch; publicFetch?: typeof fetch | undefined; config: ConfigAdapter; migrationState: MigrationStateDeps | null; inquiryMail?: InquiryMailDeps | null; privateStorage?: StorageAdapter | null | undefined; theme?: ThemeApiDeps | null },
  ): Promise<ApiService> {
    return new ApiService(deps.db, await hashApiToken(rawToken), deps.storage, deps.fetch, deps.config, deps.migrationState, deps.publicFetch ?? deps.fetch, deps.inquiryMail ?? null, deps.privateStorage ?? null, deps.theme ?? null);
  }

  private migratedTo(version: string): Promise<boolean> {
    return this.migrationState ? migrated(this.migrationState, version) : Promise.resolve(false);
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
  shopUpdate = (values: Record<string, unknown>) => this.call<Record<string, unknown>>("api_shop_update", { p_values: values });

  // ---- products ----
  productsList = (q: ListQuery = {}) =>
    this.call<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number }>("api_products_list", {
      p_query: q.query ?? null,
      p_published: q.published ?? null,
      p_limit: q.limit ?? 50,
      p_offset: q.offset ?? 0,
    });
  productGet = (ref: { id?: string; slug?: string }) => this.call<Record<string, unknown>>("api_product_get", { p_product_id: ref.id ?? null, p_slug: ref.slug ?? null });
  productCreate = (values: Record<string, unknown>) => this.call<Record<string, unknown>>("api_product_create", { p_values: values });
  productUpdate = (id: string, values: Record<string, unknown>) => this.call<Record<string, unknown>>("api_product_update", { p_product_id: id, p_values: values });
  skuCreate = (productId: string, values: Record<string, unknown>) => this.call<Record<string, unknown>>("api_sku_create", { p_product_id: productId, p_values: values });
  skuUpdate = (skuId: string, values: Record<string, unknown>) => this.call<Record<string, unknown>>("api_sku_update", { p_sku_id: skuId, p_values: values });
  categoriesList = () => this.call<Record<string, unknown>[]>("api_categories_list", {});
  categorySave = (values: Record<string, unknown>) => this.call<Record<string, unknown>>("api_category_save", { p_values: values });
  skuDelete = (skuId: string) => this.call<Record<string, unknown>>("api_sku_delete", { p_sku_id: skuId });

  /** 画像を URL から取り込む。http(s) のみ、プライベートアドレス不可、5MB まで、画像の Content-Type のみ */
  async imageAddFromUrl(productId: string, url: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> {
    // URL の形を先に確かめる（不正な URL で所有確認の RPC を呼ばない）
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new ImageFetchError("image_url must be http(s)");
    } catch (e) {
      throw new ApiError("invalid", e instanceof ImageFetchError ? e.message : "image_url must be an absolute http(s) URL", 400);
    }
    const optionsArg = await this.imageOptionsArg(options);
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
      return await this.call<Record<string, unknown>>("api_image_add", { p_product_id: productId, p_storage_key: key, p_sort_order: null, ...optionsArg });
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
  async imageUpload(productId: string, image: Uint8Array, thumbnail: Uint8Array | null, options?: Record<string, unknown>): Promise<Record<string, unknown>> {
    uuidOr404(productId);
    const main = sniffImage(image.subarray(0, 256));
    if (!main) throw new ApiError("invalid", "image must be JPEG, PNG, WebP, GIF or AVIF", 400);
    if (image.byteLength > MAX_IMAGE_BYTES) throw new ApiError("invalid", "image is larger than 5MB", 400);
    const thumb = thumbnail ? sniffImage(thumbnail.subarray(0, 256)) : null;
    if (thumbnail && !thumb) throw new ApiError("invalid", "thumbnail must be JPEG, PNG, WebP, GIF or AVIF", 400);
    if (thumbnail && thumbnail.byteLength > MAX_THUMB_BYTES) throw new ApiError("invalid", "thumbnail is larger than 1MB", 400);
    // ストレージに書く前に、書き込みのスコープを確かめる（他のショップの商品は api_image_add_file が not_found にして、置いたものを消す）
    if (!(await this.call<boolean>("api_has_scope", { p_scope: "products:write" }))) throw new ApiError("unauthorized", "invalid, expired or insufficiently scoped token", 401);
    const optionsArg = await this.imageOptionsArg(options);
    const shop = await this.shopGetIdOnly();
    const key = productImageKey(shop, productId, main.ext);
    const tkey = thumbnail && thumb ? thumbKey(key, thumb.ext) : null;
    const size = imageSize(image, main.contentType);
    const copy = (b: Uint8Array) => b.slice().buffer;
    await this.storage.put(key, copy(image), main.contentType);
    try {
      if (tkey && thumbnail && thumb) await this.storage.put(tkey, copy(thumbnail), thumb.contentType);
      return await this.call<Record<string, unknown>>("api_image_add_file", { p_product_id: productId, p_storage_key: key, p_thumb_key: tkey, p_width: size?.width ?? null, p_height: size?.height ?? null, ...optionsArg });
    } catch (e) {
      await Promise.all([key, tkey].filter((k): k is string => !!k).map((k) => this.storage.delete(k).catch(() => undefined)));
      throw e;
    }
  }

  async imageDelete(imageId: string): Promise<void> {
    const keys = await this.call<{ storage_key: string; thumb_key: string | null }>("api_image_delete", { p_image_id: imageId });
    await Promise.all([keys.storage_key, keys.thumb_key].filter((k): k is string => !!k).map((k) => this.storage.delete(k).catch(() => undefined)));
  }

  /**
   * 登録と同時に SKU に結ぶときの引数（0063）。空なら引数を渡さない（0063 より前の DB でも今までどおり登録できる）。
   * 形の検査は SQL（banto_image_options_ok）
   */
  private async imageOptionsArg(options: Record<string, unknown> | undefined): Promise<{ p_options?: Record<string, unknown> }> {
    if (!options || Object.keys(options).length === 0) return {};
    if (!(await this.migratedTo(SKU_IMAGES_MIGRATION))) {
      await this.call("api_token_shop", {});
      throw new ApiError("migration_required", `image options need the database update ${SKU_IMAGES_MIGRATION}; apply it from /admin/update`, 409);
    }
    return { p_options: options };
  }

  /** 商品の SKU を分ける軸を決める（0065。[] で品番だけ、null で決めない）。返すのは商品 */
  async productSetOptionAxes(productId: string, axes: unknown): Promise<Record<string, unknown>> {
    uuidOr404(productId);
    if (!(await this.migratedTo(SKU_OPTION_AXES_MIGRATION))) {
      await this.call("api_token_shop", {});
      throw new ApiError("migration_required", `option axes need the database update ${SKU_OPTION_AXES_MIGRATION}; apply it from /admin/update`, 409);
    }
    return this.call<Record<string, unknown>>("api_product_set_option_axes", { p_product_id: productId, p_axes: axes });
  }

  /** 画像を SKU の options の一部に結ぶ（0063。{} で商品全体）。返すのは商品 */
  async imageSetOptions(imageId: string, options: Record<string, unknown>): Promise<Record<string, unknown>> {
    uuidOr404(imageId);
    if (!(await this.migratedTo(SKU_IMAGES_MIGRATION))) {
      await this.call("api_token_shop", {});
      throw new ApiError("migration_required", `image options need the database update ${SKU_IMAGES_MIGRATION}; apply it from /admin/update`, 409);
    }
    return this.call<Record<string, unknown>>("api_image_set_options", { p_image_id: imageId, p_options: options });
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

  // ---- お問い合わせ（0061。inquiries:read / inquiries:write、モジュール inquiries が ON のショップだけ）----
  /** assignee: "none"（未割り当て）か担当者の user_id（0068 が要る） */
  inquiriesList = async (q: { status?: string; limit?: number; offset?: number; assignee?: string } = {}) => {
    if (q.assignee !== undefined) await this.requireAssignee();
    return this.call<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number; pii: boolean }>("api_inquiries_list", {
      p_status: q.status ?? null,
      p_limit: q.limit ?? 50,
      p_offset: q.offset ?? 0,
      ...(q.assignee !== undefined ? { p_assignee: q.assignee } : {}),
    });
  };
  /** 担当者（0068）の関数があるか。無ければ有効なトークンであることだけ確かめて 409 */
  private async requireAssignee(): Promise<void> {
    if (await this.migratedTo(API_INQUIRY_ASSIGNEE_MIGRATION)) return;
    await this.call("api_token_shop", {});
    throw new ApiError("migration_required", `assignees need the database update ${API_INQUIRY_ASSIGNEE_MIGRATION}; apply it from /admin/update`, 409);
  }
  /** 担当者にできる人（そのショップの「お問い合わせ」の項目を持つ運営側の人。user_id と運営者のメールアドレス） */
  inquiryAssignees = async () => {
    await this.requireAssignee();
    return this.call<{ user_id: string; email: string }[]>("api_inquiry_assignees", {});
  };
  /** 担当者を決める・外す（userId = null で外す）。担当になった人にはリンクだけのメール（宛先は AI に返さない） */
  inquiryAssign = async (number: number, userId: string | null): Promise<Record<string, unknown>> => {
    await this.requireAssignee();
    if (userId !== null && !isUuid(userId)) throw new ApiError("invalid", "invalid_assignee: user_id must be a user_id from inquiry_assignees, or null to unassign", 400);
    const r = await this.call<{ inquiry: Record<string, unknown>; mail: { inquiry_id: string; number: number; send: boolean; to: string | null; mail_from: string | null; shop: InquiryMailShop } }>("api_inquiry_assign", { p_number: number, p_user: userId });
    const deps = this.inquiryMail;
    const sent = deps && r.mail.to ? await sendAssignNotice({ mailer: deps.mailer, adminBase: deps.publicBase }, r.mail.shop, r.mail) : false;
    return { ...r.inquiry, mail_sent: sent };
  };
  inquiryGet = (number: number) => this.call<Record<string, unknown>>("api_inquiry_get", { p_number: number });
  /**
   * 返事を書く。お客様にはリンクだけのメール（本文は載せない）。リンクの行き先は管理画面の返事と同じ
   * （連携サイトの画面が今の許可リストにあればそこ、無ければ Banto の画面）。宛先は AI に返さない
   */
  inquiryReply = async (number: number, body: string, files: File[] = []): Promise<Record<string, unknown>> => {
    const deps = this.inquiryMail;
    if (!deps) throw new ApiError("upstream", "not configured (SESSION_SECRET)", 503);
    const token = randomToken(32);
    const args: Record<string, unknown> = { p_number: number, p_body: body, p_link_hash: await inquiryLinkHash(deps.secret, token) };
    // 添付（0064）: 先に公開しない置き場へ置き、返事の関数に鍵を渡す（数・種類・大きさは DB も確かめる）。断られたら置いた実体を消す
    let stored: string[] = [];
    if (files.length > 0) {
      const storage = await this.attachmentStorage();
      const shopId = (await this.call<{ shop_id: string }>("api_token_shop", {})).shop_id;
      const r = await storeAttachments(storage, shopId, files);
      if (!r.ok) {
        const message = r.error === "too_many" ? "up to 3 files per reply" : r.error === "too_large" ? "each file must be 5MB or smaller" : "files must be JPEG, PNG, WebP or PDF";
        throw new ApiError("invalid", `invalid_attachment: ${message}`, 400);
      }
      stored = r.stored.map((f) => f.key);
      args["p_attachments"] = r.stored;
    }
    let r: { inquiry: Record<string, unknown>; mail: { send: boolean; to: string | null; mail_from: string | null; return_to: string | null; shop: InquiryMailShop } };
    try {
      r = await this.call("api_inquiry_reply", args);
    } catch (e) {
      if (stored.length > 0) await removeAttachments(this.privateStorage!, stored);
      throw e;
    }
    const shop = r.mail.shop;
    const target = r.mail.return_to ? safeReturnUrl(r.mail.return_to, returnOrigins(shop.settings), "") : "";
    const link = target ? withQueryParam(target, "banto_inquiry", token) : `${shopHome(deps.publicBase, shop)}/inquiries/open?t=${token}`;
    const sent = await sendReplyNotice({ mailer: deps.mailer }, shop, { ...r.mail, number }, link);
    return { ...r.inquiry, mail_sent: sent };
  };
  /** 添付を扱える置き場（0064 の適用と、公開しない置き場の設定が要る） */
  private async attachmentStorage(): Promise<StorageAdapter> {
    if (!(await this.migratedTo(API_INQUIRY_ATTACHMENTS_MIGRATION))) {
      await this.call("api_token_shop", {});
      throw new ApiError("migration_required", `attachments need the database update ${API_INQUIRY_ATTACHMENTS_MIGRATION}; apply it from /admin/update`, 409);
    }
    if (!this.privateStorage) throw new ApiError("conflict", "attachments_unavailable: the private bucket (PRIVATE) is not configured", 409);
    return this.privateStorage;
  }
  /** お客様の添付を受け取る（0064。inquiries:read と orders:pii）。中身の種類は DB の値で、nosniff を付けて渡す */
  async inquiryAttachment(number: number, attachmentId: string): Promise<Response> {
    uuidOr404(attachmentId);
    const storage = await this.attachmentStorage();
    const meta = await this.call<{ storage_key: string; content_type: string; filename: string }>("api_inquiry_attachment_get", { p_number: number, p_attachment_id: attachmentId });
    const res = await attachmentResponse(storage, meta);
    if (!res) throw new ApiError("not_found", "not found", 404);
    return res;
  }
  inquirySetStatus = (number: number, status: InquiryApiStatus) => this.call<Record<string, unknown>>("api_inquiry_set_status", { p_number: number, p_status: status });

  // ---- クーポン（0036。coupons:read / coupons:write、モジュール coupons が ON のショップだけ）----
  couponsList = (q: { query?: string; active?: boolean; limit?: number; offset?: number } = {}) =>
    this.call<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number }>("api_coupons_list", {
      p_query: q.query ?? null,
      p_active: q.active ?? null,
      p_limit: q.limit ?? 50,
      p_offset: q.offset ?? 0,
    });
  // id の形の検査（uuidOr404）は同期で投げるので、どれも async にして Promise の失敗として返す
  /** id（UUID）かコードで 1 件 */
  couponGet = async (ref: string) => this.call<Record<string, unknown>>("api_coupon_get", isUuid(ref) ? { p_campaign_id: ref, p_code: null } : { p_campaign_id: null, p_code: ref });
  couponCreate = (values: Record<string, unknown>) => this.call<Record<string, unknown>>("api_coupon_create", { p_values: values });
  couponUpdate = async (id: string, values: Record<string, unknown>) => this.call<Record<string, unknown>>("api_coupon_update", { p_campaign_id: uuidOr404(id), p_values: values });
  couponDelete = async (id: string) => this.call<Record<string, unknown>>("api_coupon_delete", { p_campaign_id: uuidOr404(id) });
  couponGrantsList = async (id: string, q: { status?: string; limit?: number; offset?: number } = {}) =>
    this.call<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number }>("api_coupon_grants_list", {
      p_campaign_id: uuidOr404(id),
      p_status: q.status ?? null,
      p_limit: q.limit ?? 50,
      p_offset: q.offset ?? 0,
    });
  /** 会員 ID ごとに 1 枚と、誰でも 1 回使えるコードを count 枚（合わせて 500 まで） */
  couponGrantsIssue = async (id: string, customerIds: string[], count: number) => {
    if (customerIds.some((x) => !isUuid(x))) throw new ApiError("invalid", "customer_ids must be member ids (UUID)", 400);
    return this.call<Record<string, unknown>>("api_coupon_grants_issue", { p_campaign_id: uuidOr404(id), p_customer_ids: customerIds, p_count: count });
  };
  couponGrantRevoke = async (grantId: string) => this.call<Record<string, unknown>>("api_coupon_grant_revoke", { p_grant_id: uuidOr404(grantId) });

  // ---- 会員（0036。customers:read / customers:write。メールアドレスは変えられない）----
  // 0047: external_ref（外部の ID）・attributes（独自項目。定義は shops.settings.customer_fields）・updated_since・upsert（docs/knowledge/13-external-customer-master.md）
  customersList = async (q: { query?: string; email?: string; limit?: number; offset?: number; externalProvider?: string; externalId?: string; updatedSince?: string; marketingConsent?: boolean } = {}) => {
    const extra: Record<string, unknown> = {};
    if (q.marketingConsent !== undefined) extra["p_marketing_consent"] = q.marketingConsent;
    if (q.externalProvider !== undefined || q.externalId !== undefined || q.updatedSince !== undefined) {
      if (q.updatedSince !== undefined && Number.isNaN(Date.parse(q.updatedSince))) throw new ApiError("invalid", "updated_since must be an ISO 8601 date-time", 400);
      if (q.externalId !== undefined && !q.externalProvider) throw new ApiError("invalid", "external_id needs external_provider", 400);
      extra["p_external_provider"] = q.externalProvider ?? null;
      extra["p_external_id"] = q.externalId ?? null;
      extra["p_updated_since"] = q.updatedSince ?? null;
    }
    return this.call<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number }>("api_customers_list", {
      p_query: q.query ?? null,
      p_email: q.email ?? null,
      p_limit: q.limit ?? 50,
      p_offset: q.offset ?? 0,
      ...extra,
    });
  };
  customerGet = async (id: string) => this.call<Record<string, unknown>>("api_customer_get", { p_customer_id: uuidOr404(id) });
  customerCreate = (values: Record<string, unknown>) => this.call<Record<string, unknown>>("api_customer_create", { p_values: values });
  customerUpdate = async (id: string, values: Record<string, unknown>) => this.call<Record<string, unknown>>("api_customer_update", { p_customer_id: uuidOr404(id), p_values: values });
  /** メールアドレスで引いて、あれば渡した鍵だけ更新、無ければ作る（外部のマスタからの同期の窓口。email は変えない） */
  customerUpsert = (values: Record<string, unknown>) => this.call<Record<string, unknown>>("api_customer_upsert", { p_values: values });
  customerDelete = async (id: string) => this.call<Record<string, unknown>>("api_customer_delete", { p_customer_id: uuidOr404(id) });
  // ---- テーマ（theme:write / theme:publish、0072。docs/themes.md） ----
  private async themeReady(): Promise<ThemeApiDeps> {
    if (!(await this.migratedTo(THEME_API_MIGRATION))) {
      await this.call("api_token_shop", {});
      throw new ApiError("migration_required", `themes need the database update ${THEME_API_MIGRATION}; apply it from /admin/update`, 409);
    }
    if (!this.theme) throw new ApiError("upstream", "not configured", 502);
    return this.theme;
  }

  /** 版の一覧と、取り込める条件（can_render: Workers の有料プランか Node。locale: 取り込む翻訳の言語） */
  async themesList(): Promise<Record<string, unknown>> {
    const deps = await this.themeReady();
    const r = await this.call<Record<string, unknown>>("api_themes_list", {});
    return { ...r, can_render: deps.cpuUnlimited || r["site_plan"] === "paid", locale: getLocale() };
  }

  /** 版を足す: 検査して束ねたファイルを置き、版の行を足す。資産はこのあと assets に 1 つずつ置き、最後に complete */
  async themeCreate(name: string, bundle: unknown): Promise<Record<string, unknown>> {
    const list = await this.themesList();
    if (!list["can_render"]) throw new ApiError("conflict", "theme_requires_paid_plan: Liquid themes need the Workers paid plan (or Node); set the site setting workers_plan", 409);
    const prep = prepareThemeVersion(bundle);
    if (!prep.ok) throw new ApiError("invalid", `invalid_theme: ${prep.errors.slice(0, 20).join("; ")}`, 400);
    const v = prep.version;
    const shopId = String(list["shop_id"]);
    await storeThemeBundle(this.storage, shopId, v);
    try {
      const row = await this.call<Record<string, unknown>>("api_theme_create", { p_id: v.id, p_name: name.trim().slice(0, 100) || "theme", p_size_bytes: v.sizeBytes, p_file_count: v.fileCount, p_manifest: v.manifest });
      return { ...publicTheme(row), assets: v.bundle.assets };
    } catch (e) {
      await removeThemeBundle(this.storage, shopId, v.id);
      throw e;
    }
  }

  private async themeRow(versionId: string): Promise<Record<string, unknown> & { shop_id: string; complete: boolean }> {
    await this.themeReady();
    return this.call("api_theme_get", { p_version_id: uuidOr404(versionId) });
  }

  /** 資産を 1 つ置く（置き終えた版には置けない） */
  async themeAssetPut(versionId: string, name: string, body: ArrayBuffer): Promise<{ ok: true }> {
    const row = await this.themeRow(versionId);
    if (row.complete) throw new ApiError("conflict", "theme_complete: assets of a completed version cannot be replaced; upload a new version", 409);
    const r = await putThemeAsset(this.storage, row.shop_id, versionId, name, body);
    if (!r.ok) {
      if (r.reason === "type") throw new ApiError("invalid", "invalid_asset: this file type cannot be a theme asset (HTML and SVG are not allowed)", 400);
      if (r.reason === "too_large") throw new ApiError("invalid", "invalid_asset: an asset can be up to 5MB", 413);
      throw new ApiError("not_found", "asset not listed in the theme bundle", 404);
    }
    return { ok: true };
  }

  /** 資産を置き終えた（すべての資産が置き場にあるかを確かめてから）。これで公開できる */
  async themeComplete(versionId: string): Promise<Record<string, unknown>> {
    const row = await this.themeRow(versionId);
    const missing = await missingThemeAsset(this.storage, row.shop_id, versionId);
    if (missing === undefined) throw new ApiError("not_found", "not found", 404);
    if (missing !== null) throw new ApiError("conflict", `asset_missing: ${missing}`, 409);
    return this.call<Record<string, unknown>>("api_theme_complete", { p_version_id: versionId });
  }

  /** ショップのドメインでプレビューを開くリンク（30 分。開いたことは監査ログに残る） */
  async themePreview(versionId: string): Promise<{ preview_url: string; expires_in: number }> {
    const deps = await this.themeReady();
    if (!deps.secret) throw new ApiError("upstream", "SESSION_SECRET is not configured", 502);
    const shop = await this.call<{ shop_id: string; slug: string; domain: string }>("api_theme_preview", { p_version_id: uuidOr404(versionId) });
    return { preview_url: await themePreviewUrl(deps.publicBase, shop, shop.shop_id, versionId, deps.secret, "api"), expires_in: THEME_PREVIEW_SECONDS };
  }

  /** 公開していない版を消す（置き場のファイルも） */
  async themeDelete(versionId: string): Promise<{ ok: true }> {
    const row = await this.themeRow(versionId);
    const bundle = await readThemeBundle(this.storage, row.shop_id, versionId);
    const prefix = await this.call<string>("api_theme_delete", { p_version_id: versionId });
    await deleteThemeFiles(this.storage, prefix, bundle);
    return { ok: true };
  }

  /** 公開する（theme:publish）。versionId が null なら取り下げて既定のテーマに戻す。お店の画面は 30 秒ほどで切り替わる */
  async themePublish(versionId: string | null): Promise<Record<string, unknown>> {
    await this.themeReady();
    return this.call<Record<string, unknown>>("api_theme_publish", { p_version_id: versionId === null ? null : uuidOr404(versionId) });
  }

  // ---- stats ----
  salesSummary = (from: string, to: string, groupBy: "day" | "month" | "product" = "day") =>
    this.call<Record<string, unknown>>("api_sales_summary", { p_from: from, p_to: to, p_group_by: groupBy });
  inventoryLow = (threshold?: number) => this.call<Record<string, unknown>[]>("api_inventory_low", { p_threshold: threshold ?? null });
}
