import { Hono } from "hono";
import { raw } from "hono/html";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { ProductImageRow, ProductRow, ShopRow } from "../../db/types";
import { t, tf, type MessageKey } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { migrated } from "../../db/migration-state";
import { IMAGE_QUEUE_MIGRATION } from "./job";
import { EXTRA_CATEGORIES_MIGRATION } from "../../products/categories";
import { COUPON_IMPORT_MIGRATION } from "../coupons/import";
import { couponCsv } from "../coupons/csv";
import { isoToZonedInput } from "../../i18n/time";
import { AdminLayout, PageHead } from "../../routes/admin/layout";
import { owner, param, publicBaseUrl, type AdminContext } from "../../routes/admin/context";
import { shopHome } from "../../storefront/urls";
import { requireOwner } from "../../routes/admin/auth";
import { loadShop } from "../../routes/admin/shops";
import type { ShopPerm } from "../../routes/admin/access";
import { fetchImage, fetchOriginalImage, ImageFetchError } from "../../media/fetch-image";
import { MAX_IMAGE_BYTES, MAX_THUMB_BYTES, imageSize, sniffImage, thumbKey } from "../../media/images";
import { createPrivilegedDb } from "../../db/privileged";
import { isPrefecture } from "../../commerce/shipping";
import { isTaxClass } from "../../commerce/tax";
import { productFields, MAX_FIELDS, type ProductField } from "../../products/fields";
import { moduleEnabled } from "../registry";
import { wcImageKey, wcImageTag } from "./keys";
import { wooImporter } from "./client";

/**
 * 同梱モジュール「WooCommerce から取り込み」（woo_import、既定 OFF）。docs/knowledge/08-woo-migration.md
 *   GET  /admin/shops/:shopId/modules/woo-import          画面（CSV の解析と対応付けはブラウザで行う）
 *   POST .../fields   取り込むカスタム項目の定義を足す（既存の定義は変えない）
 *   POST .../batch    カテゴリー・商品・SKU・在庫を書き込む（import_catalog RPC、owner の JWT）
 *   POST .../images   1 商品ぶんの画像を URL から取り込む（取り込み済みの URL は飛ばす）
 *   POST .../customers/passwords WordPress のパスワード（bcrypt の形式だけ）を取り込む（最大 100 件。0013。店の設定 members_password がオンのとき）
 *   POST .../customers 会員を取り込む（最大 100 件。customers 行をメールアドレスで引いて無ければ作る。0012）
 *   POST .../coupons  クーポンを作る（最大 100 件。メールアドレスで絞ったものは、その人ごとの発行済みクーポンにする。0023）
 *   POST .../coupons/usage  クーポンの 1 人ごとの使用回数（0023）
 *   POST .../orders   過去の注文（最大 100 件。在庫・クーポン・通知には触らない。0023）
 */
export const wooImport = new Hono<AppEnv>();

const MAX_BATCH_BYTES = 400_000;

/**
 * ブラウザに渡すスクリプトの前置き。Workers のビルド（wrangler の esbuild、keepNames）は関数の中に `__name(...)` を差し込むので、
 * ページ側で同じ働きの関数を用意しておく（無いと ReferenceError）。scripts/check-client-scripts.mjs が本番のバンドルで確かめる。
 */
export const CLIENT_PRELUDE = 'var __name = __name || function (t, v) { try { Object.defineProperty(t, "name", { value: v, configurable: true }); } catch (e) {} return t; };\n';
const MAX_IMAGES_PER_REQUEST = 20;

/** モジュールが OFF のショップでは何も出さない（存在しないのと同じ） */
async function scope(c: AdminContext, perm: ShopPerm = "catalog"): Promise<ShopRow | null> {
  const shop = await loadShop(c, param(c, "shopId"), perm);
  if (!shop || !moduleEnabled(shop.settings, "woo_import")) return null;
  return shop;
}

/** 画面に渡す文言（ブラウザ側のスクリプトは i18n を読めないので、ここで訳して渡す） */
const CLIENT_KEYS = [
  "analyzing", "not_woocommerce", "summary", "summary_line", "brands", "warnings", "example", "options", "brand_mode", "brand_first", "brand_last",
  "overwrite_stock", "skip_disabled", "variation_images", "fields", "fields_hint", "f_label", "f_key", "f_type", "f_filled", "f_sample", "start",
  "step_fields", "step_categories", "step_products", "done_products", "errors", "start_images", "step_images", "done_images", "failed",
  "unstable", "localized_headers", "localized_headers_fix", "encoding_sjis", "prices_exclude_tax", "prices_exclude_tax_hint", "tax_standard", "tax_none", "tax_rounding",
  "tax_round", "tax_floor", "tax_ceil", "w_sale_scheduled", "w_sale_ended", "w_skipped_type", "w_backorder", "w_no_variations_in_csv", "rest_loading", "rest_step_categories", "rest_step_products", "rest_step_variations", "rest_step_customers", "customers_summary", "customers_line", "customers_password_note", "customers_start", "customers_step", "customers_done", "customers_next", "customers_members_disabled", "customers_not_configured", "customers_password_disabled", "passwords_no_columns", "passwords_summary", "passwords_start", "passwords_step", "passwords_done", "passwords_delete_file", "rest_bad_url", "rest_network",
  "rest_step_coupons", "rest_step_brands", "coupons_summary", "coupons_line", "coupons_start", "coupons_step", "coupons_done", "coupons_disabled",
  "coupon_skip_code", "coupon_skip_fixed_product", "coupon_skip_amount", "coupon_skip_expired", "coupon_skip_exhausted", "coupon_note_free_shipping_dropped", "coupon_note_history_not_moved", "coupon_note_email_restricted",
  "rest_unauthorized", "rest_not_found", "rest_http", "rest_bad_response", "tax_detected_exclusive", "tax_detected_inclusive", "download_redirects", "redirects_hint", "w_meta_misaligned", "w_no_price", "w_disabled_variation", "w_stock_unknown", "w_no_sku", "w_orphan_variation", "w_bad_gtin", "w_mixed_tax_class", "tax_class", "tax_class_standard", "tax_class_reduced", "tax_class_exempt",
  "rest_step_orders", "orders_summary", "orders_line", "orders_note", "orders_start", "orders_step", "orders_done", "orders_conflicts", "orders_skip_status", "orders_skip_currency", "orders_skip_number",
  "coupons_usage_step", "coupons_usage_done", "coupons_grant_codes", "coupons_grant_codes_download", "coupon_note_history_moved", "coupon_note_email_grants", "coupon_note_email_wildcard_dropped",
  "img_failures_title", "img_fail_count", "img_show_list", "img_failures_download", "img_failures_hint", "img_fail_http", "img_fail_http_blocked", "img_fail_http_missing", "img_fail_http_busy", "img_fail_http_server", "img_fail_bad_url", "img_fail_host_not_allowed", "img_fail_fetch_failed", "img_fail_too_many_redirects", "img_fail_not_image", "img_fail_too_large", "img_fail_storage", "img_fail_db_error", "img_fail_request",
  "resize_step", "resize_done", "img_fail_too_large_original", "img_fail_decode", "img_fail_resize",
  "images_choice", "images_choice_browser", "images_choice_queue", "queue_images", "queue_step", "queue_done", "queue_missing", "queue_reload",
  "coupons_skipped_title", "coupons_skip_count", "coupons_notes_title", "coupons_show_codes", "coupons_list_download", "coupons_csv_skipped", "coupons_csv_note",
  "coupons_review_title", "coupons_review_intro", "coupons_review_download", "coupons_review_ids", "coupons_review_save", "coupons_review_next", "coupons_review_import_link", "coupons_review_needs_update",
  "coupons_review_mode", "coupons_review_skip", "coupons_review_inactive",
] as const;

wooImport.get("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const dict: Record<string, string> = {};
  for (const k of CLIENT_KEYS) dict[k] = t(`woo.${k}` as MessageKey);
  const membersEnabled = (shop.settings ?? {})["members_enabled"] === true;
  const passwordsEnabled = membersEnabled && (shop.settings ?? {})["members_password"] === true;
  // 画像を裏で取り込む（0039）。当たっていなければ、予約のボタンも進み具合も出さない
  const queueReady = await migrated({ db: owner(c).db, cache: c.get("adapters").cache }, IMAGE_QUEUE_MIGRATION);
  const queue = queueReady ? await owner(c).db.rpc<QueueSummary | null>("image_import_summary", { p_shop_id: shop.id }) : null;
  // 裏の取り込みで大きすぎて止まった画像（このページで縮小して取り込める）
  const large = (queue?.failures ?? []).filter((f) => f.code === "too_large").map((f) => ({ slug: f.slug, url: f.url }));
  // 要確認のクーポンを直して入れる画面（0043）。当たっていなければリンクを出さない
  const couponImport = (await migrated({ db: owner(c).db, cache: c.get("adapters").cache }, COUPON_IMPORT_MIGRATION)) ? `/admin/shops/${shop.id}/modules/coupons/import` : undefined;
  const cfg = { base: `/admin/shops/${shop.id}/modules/woo-import`, shopUrl: shopHome(publicBaseUrl(c), shop), t: dict, queue: queueReady, large, couponImport };
  // </script> を閉じさせない（< をエスケープ）
  const json = JSON.stringify(cfg).replace(/</g, "\\u003c");
  const script = `${CLIENT_PRELUDE}(${wooImporter.toString()})().mount(document.getElementById("woo-import"), ${json});`;
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("mod.woo_import.name")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("modules.title"), href: `/admin/shops/${shop.id}/modules` }, { label: t("mod.woo_import.name") }]} shopTabs={{ shop: { id: shop.id, name: shop.name }, access: c.get("shopAccess"), active: "modules" }}>
      <PageHead title={t("mod.woo_import.name")} />
      <ul class="muted">
        <li>{t("woo.note_safe")}</li>
        <li>{t("woo.note_meta")}</li>
        <li>{t("woo.note_members")}</li>
      </ul>
      {queue ? <ImageQueueSection shopId={shop.id} q={queue} flash={c.req.query("queue")} /> : null}
      <div id="woo-import">
        <h2>{t("woo.rest_title")}</h2>
        <p>{t("woo.rest_intro")}</p>
        <p class="muted">{t("woo.rest_keys")}</p>
        <p>
          <label>
            {t("woo.rest_url")} <input type="url" data-wc-url="" placeholder="https://example.com" autocomplete="off" />
          </label>
        </p>
        <p>
          <label>
            {t("woo.rest_key")} <input type="text" data-wc-key="" placeholder="ck_…" autocomplete="off" spellcheck={false} />
          </label>
        </p>
        <p>
          <label>
            {t("woo.rest_secret")} <input type="password" data-wc-secret="" placeholder="cs_…" autocomplete="off" />
          </label>
        </p>
        <p>
          <button type="button" data-wc-load="">
            {t("woo.rest_load")}
          </button>
        </p>
        <h3>{t("woo.customers_title")}</h3>
        <p>{t("woo.customers_intro")}</p>
        {membersEnabled ? (
          <>
            <p>
              <button type="button" data-wc-customers="">
                {t("woo.customers_load")}
              </button>
            </p>
            <div data-customers-out=""></div>
          </>
        ) : (
          <p class="notice">
            {t("woo.customers_disabled")} <a href={`/admin/shops/${shop.id}#members`}>{t("woo.customers_open_settings")}</a>
          </p>
        )}
        <h3>{t("woo.coupons_title")}</h3>
        <p>{t("woo.coupons_intro")}</p>
        {moduleEnabled(shop.settings, "coupons") ? (
          <>
            <p>
              <button type="button" data-wc-coupons="">
                {t("woo.coupons_load")}
              </button>
            </p>
            <div data-coupons-out=""></div>
          </>
        ) : (
          <p class="notice">{t("woo.coupons_disabled")}</p>
        )}
        <h3>{t("woo.orders_title")}</h3>
        <p>{t("woo.orders_intro")}</p>
        <p>
          <button type="button" data-wc-orders="">
            {t("woo.orders_load")}
          </button>
        </p>
        <div data-orders-out=""></div>
        <h3>{t("woo.passwords_title")}</h3>
        <p>{t("woo.passwords_intro")}</p>
        {passwordsEnabled ? (
          <>
            <p>
              <input type="file" accept=".csv,text/csv" data-wc-passwords="" />
            </p>
            <div data-passwords-out=""></div>
          </>
        ) : (
          <p class="notice">
            {t("woo.passwords_disabled")} <a href={`/admin/shops/${shop.id}#members`}>{t("woo.customers_open_settings")}</a>
          </p>
        )}
        <h2>{t("woo.csv_title")}</h2>
        <p>{t("woo.intro")}</p>
        <p>
          <input type="file" accept=".csv,text/csv" />
        </p>
        <div data-out=""></div>
      </div>
      <script>{raw(script)}</script>
    </AdminLayout>,
  );
});

async function jsonBody(c: AdminContext): Promise<Record<string, unknown> | null> {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > MAX_BATCH_BYTES) return null;
  try {
    const text = await c.req.text();
    if (text.length > MAX_BATCH_BYTES) return null;
    const body: unknown = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** カスタム項目の定義を足す。取り込んだ項目は既定で非公開（表示は運営者が確かめてから公開にする） */
wooImport.post("/fields", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const body = await jsonBody(c);
  if (!body || !Array.isArray(body["fields"])) return c.json({ error: "invalid_request" }, 400);
  const existing = productFields(shop.settings);
  const incoming = productFields({ product_fields: (body["fields"] as Record<string, unknown>[]).map((f) => ({ ...f, public: false })) });
  const merged: ProductField[] = [...existing];
  for (const f of incoming) if (!merged.some((x) => x.key === f.key) && merged.length < MAX_FIELDS) merged.push(f);
  try {
    await owner(c).db.from<ShopRow>("shops").update({ settings: { ...(shop.settings ?? {}), product_fields: merged } }, { id: shop.id });
  } catch (e) {
    if (e instanceof DbError) return c.json({ error: "db_error" }, 502);
    throw e;
  }
  return c.json({ fields: merged.length, added: merged.length - existing.length, skipped: incoming.length - (merged.length - existing.length) });
});

/**
 * 主カテゴリーのほかのカテゴリー（取り込み画面が extra_category_slugs / extra_category_names で送る）。
 * 0042 の DB なら追加カテゴリーに、それより前ならタグに写す（0042 までの取り込みと同じ）
 */
function withExtraCategories(p: unknown, extraReady: boolean): unknown {
  if (!p || typeof p !== "object") return p;
  const { extra_category_names: names, ...rest } = p as Record<string, unknown>;
  if (extraReady) return rest;
  const { extra_category_slugs: _slugs, ...old } = rest;
  const tags = Array.isArray(old["tags"]) ? (old["tags"] as unknown[]) : [];
  return Array.isArray(names) && names.length > 0 ? { ...old, tags: [...tags, ...names] } : old;
}

wooImport.post("/batch", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "invalid_request" }, 400);
  try {
    const extraReady = await migrated({ db: owner(c).db, cache: c.get("adapters").cache }, EXTRA_CATEGORIES_MIGRATION);
    const products = (Array.isArray(body["products"]) ? (body["products"] as unknown[]) : []).map((p) => withExtraCategories(p, extraReady));
    const result = await owner(c).db.rpc<Record<string, unknown>>("import_catalog", {
      p_shop_id: shop.id,
      p_batch: { categories: Array.isArray(body["categories"]) ? body["categories"] : [], products, overwrite_stock: body["overwrite_stock"] !== false },
    });
    // 税区分（0017 の列。import_catalog は知らないので 0022 の import_tax_classes で入れる）
    const taxItems = products
      .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
      .filter((p) => typeof p["slug"] === "string" && isTaxClass(p["tax_class"]))
      .map((p) => ({ slug: p["slug"], tax_class: p["tax_class"] }));
    if (taxItems.length > 0) result["tax_classes"] = await owner(c).db.rpc<number>("import_tax_classes", { p_shop_id: shop.id, p_items: taxItems });
    return c.json(result);
  } catch (e) {
    if (e instanceof DbError) return c.json({ error: "db_error", message: e.message.slice(0, 300) }, 502);
    throw e;
  }
});

wooImport.post("/images", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const body = await jsonBody(c);
  const slug = typeof body?.["slug"] === "string" ? body["slug"] : "";
  const urls = Array.isArray(body?.["urls"]) ? (body!["urls"] as unknown[]).filter((u): u is string => typeof u === "string").slice(0, MAX_IMAGES_PER_REQUEST) : [];
  if (!slug || urls.length === 0) return c.json({ error: "invalid_request" }, 400);
  const { db } = owner(c);
  const product = await db.from<ProductRow>("products").selectOne("id", { eq: { shop_id: shop.id, slug } });
  if (!product) return c.json({ error: "not_found" }, 404);
  const existing = await db.from<ProductImageRow>("product_images").select("storage_key,sort_order", { eq: { product_id: product.id } });
  const storage = c.get("adapters").storage;
  // 外から渡された URL を開く（Node では社内のアドレスに繋がない。監査 M12）
  const fetchImpl = c.get("adapters").publicFetch ?? c.get("deps").fetch;
  let order = existing.reduce((n, i) => Math.max(n, i.sort_order + 1), 0);
  const rows: Partial<ProductImageRow>[] = [];
  let skipped = 0;
  // 失敗した画像ごとの理由（画面で一覧と CSV にする。code は ImageFetchError の種類か storage）
  const failures: { url: string; code: string }[] = [];
  const rowUrls: string[] = [];
  for (const url of urls) {
    const tag = wcImageTag(url);
    if (existing.some((i) => i.storage_key.includes(tag)) || rows.some((r) => r.storage_key?.includes(tag))) {
      skipped++;
      continue;
    }
    try {
      const img = await fetchImage(url, fetchImpl);
      const key = wcImageKey(shop.id, product.id, url, img.ext);
      await storage.put(key, img.body, img.contentType);
      rows.push({ shop_id: shop.id, product_id: product.id, storage_key: key, sort_order: order++ });
      rowUrls.push(url.slice(0, 500));
    } catch (e) {
      failures.push({ url: url.slice(0, 500), code: e instanceof ImageFetchError ? e.code : "storage" });
    }
  }
  if (rows.length > 0) {
    try {
      await db.from<ProductImageRow>("product_images").insert(rows);
    } catch (e) {
      await Promise.all(rows.map((r) => storage.delete(r.storage_key!).catch(() => undefined)));
      if (e instanceof DbError) return c.json({ error: "db_error", added: 0, skipped, failed: failures.length + rows.length, failures: [...failures, ...rowUrls.map((url) => ({ url, code: "db_error" }))] }, 502);
      throw e;
    }
  }
  return c.json({ added: rows.length, skipped, failed: failures.length, failures });
});

// ---------- 画像を裏で取り込む（0039、Cron は ./job.ts） ----------

interface QueueSummary {
  pending: number;
  running: number;
  done: number;
  failed: number;
  last_done_at: string | null;
  batch: number;
  plan: "free" | "paid";
  failures: { slug: string; url: string; code: string | null }[];
}

/** 取り込めなかった理由（画面のスクリプトの imageFailureReason と同じ分け方） */
export function imageFailureReason(code: string | null): string {
  const c = code ?? "error";
  const http = /^http_(\d+)$/.exec(c);
  if (http) {
    const status = Number(http[1]);
    const key = status === 403 || status === 401 ? "woo.img_fail_http_blocked" : status === 404 || status === 410 ? "woo.img_fail_http_missing" : status === 429 ? "woo.img_fail_http_busy" : status >= 500 ? "woo.img_fail_http_server" : "woo.img_fail_http";
    return tf(key, { status });
  }
  const known = ["bad_url", "host_not_allowed", "fetch_failed", "too_many_redirects", "not_image", "too_large", "too_large_original", "decode", "resize", "storage", "db_error"];
  return known.includes(c) ? t(`woo.img_fail_${c}` as MessageKey) : c;
}

function ImageQueueSection({ shopId, q, flash }: { shopId: string; q: QueueSummary; flash?: string }) {
  const base = `/admin/shops/${shopId}/modules/woo-import/images/queue`;
  const left = q.pending + q.running;
  const total = left + q.done + q.failed;
  if (total === 0 && !flash) return null;
  // 5 分おきの Cron で 1 回 batch 枚
  const hours = Math.ceil((left / q.batch) * 5 / 60);
  const byReason = new Map<string, number>();
  for (const f of q.failures) byReason.set(imageFailureReason(f.code), (byReason.get(imageFailureReason(f.code)) ?? 0) + 1);
  return (
    <section id="image-queue" class="notice">
      <h2>{t("woo.queue_title")}</h2>
      {flash === "cancelled" ? <p>{t("woo.queue_cancelled")}</p> : null}
      {flash === "retried" ? <p>{t("woo.queue_retried")}</p> : null}
      <p>{tf("woo.queue_counts", { done: q.done, left, failed: q.failed })}</p>
      {left > 0 ? <p>{tf(q.plan === "paid" ? "woo.queue_eta_paid" : "woo.queue_eta_free", { batch: q.batch, hours: Math.max(1, hours) })} <a href="/admin/site">{t("site.title")}</a></p> : <p>{t("woo.queue_idle")}</p>}
      {q.last_done_at ? <p class="muted">{tf("woo.queue_last", { at: formatDateTime(q.last_done_at) })}</p> : null}
      <p class="muted">{t("woo.queue_hint")}</p>
      {q.failed > 0 ? (
        <>
          <h3>{tf("woo.img_failures_title", { n: q.failed })}</h3>
          <ul>
            {[...byReason].sort((a, b) => b[1] - a[1]).map(([reason, n]) => (
              <li>{tf("woo.img_fail_count", { reason, n })}</li>
            ))}
          </ul>
          <p>
            <a href={`${base}/failures.csv`}>{t("woo.img_failures_download")}</a>
          </p>
          {q.failures.some((f) => f.code === "too_large") ? (
            <p>
              <button type="button" data-resize-large="">
                {tf("woo.resize_button", { n: q.failures.filter((f) => f.code === "too_large").length })}
              </button>{" "}
              <span class="muted">{t("woo.resize_hint")}</span>
            </p>
          ) : null}
          <div data-resize-out=""></div>
          <form method="post" action={`${base}/retry`} style="display:inline">
            <button type="submit">{t("woo.queue_retry")}</button>
          </form>{" "}
        </>
      ) : null}
      {left + q.failed > 0 ? (
        <form method="post" action={`${base}/cancel`} style="display:inline">
          <button type="submit">{t("woo.queue_cancel")}</button>
        </form>
      ) : null}
      <p>
        <a href={`/admin/shops/${shopId}/modules/woo-import#image-queue`}>{t("woo.queue_reload")}</a>
      </p>
    </section>
  );
}

const MAX_QUEUE_PRODUCTS = 100;

/** 大きすぎる画像を縮小して取り込んだとき、裏の予約を取り込み済みにする（0040） */
export const IMAGE_RESOLVE_MIGRATION = "0040_mod_woo_import_resolve";

/**
 * 元の画像を中継する（5MB を超えた画像を、このページのブラウザで縮小するため。40MB まで）。
 * 守りは URL からの取り込みと同じ（http(s)・社内のアドレス不可・リダイレクト先も確かめる・中身が画像のものだけ）。保存はしない。
 * 応答はページとして開かれても何もできないように、種類を中身で決め、CSP で何も読み込ませない。
 */
wooImport.get("/images/original", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const url = c.req.query("url") ?? "";
  try {
    const img = await fetchOriginalImage(url, c.get("adapters").publicFetch ?? c.get("deps").fetch);
    return c.body(img.body, 200, { "Content-Type": img.contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" });
  } catch (e) {
    if (e instanceof ImageFetchError) return c.json({ error: e.code }, e.code === "too_large_original" ? 413 : 502);
    throw e;
  }
});

/**
 * このページのブラウザで縮小した画像（長辺 1600px）とサムネイル（400px）を受け取り、元の URL の置き場所のキーで登録する
 * （次に取り込みを押しても、この画像は取り込み済みとして飛ばす）。multipart: slug・url・image・thumbnail（任意）
 */
wooImport.post("/images/resized", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  if (Number(c.req.header("content-length") ?? 0) > MAX_IMAGE_BYTES + MAX_THUMB_BYTES + 64 * 1024) return c.json({ error: "too_large" }, 413);
  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody();
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }
  const slug = typeof form["slug"] === "string" ? form["slug"] : "";
  const url = typeof form["url"] === "string" ? form["url"] : "";
  const file = form["image"];
  const thumbFile = form["thumbnail"];
  if (!slug || !/^https?:\/\//.test(url) || url.length > 2000 || !(file instanceof Blob)) return c.json({ error: "invalid_request" }, 400);
  const image = new Uint8Array(await file.arrayBuffer());
  const thumb = thumbFile instanceof Blob ? new Uint8Array(await thumbFile.arrayBuffer()) : null;
  const kind = sniffImage(image.subarray(0, 256));
  const thumbKind = thumb ? sniffImage(thumb.subarray(0, 256)) : null;
  if (!kind || image.byteLength > MAX_IMAGE_BYTES || (thumb && (!thumbKind || thumb.byteLength > MAX_THUMB_BYTES))) return c.json({ error: "invalid_image" }, 400);
  const { db } = owner(c);
  const product = await db.from<ProductRow>("products").selectOne("id", { eq: { shop_id: shop.id, slug } });
  if (!product) return c.json({ error: "not_found" }, 404);
  const existing = await db.from<ProductImageRow>("product_images").select("storage_key,sort_order", { eq: { product_id: product.id } });
  const resolve = async () => {
    if (await migrated({ db, cache: c.get("adapters").cache }, IMAGE_RESOLVE_MIGRATION)) await db.rpc("image_import_resolve", { p_shop_id: shop.id, p_product_id: product.id, p_url: url });
  };
  if (existing.some((i) => i.storage_key.includes(wcImageTag(url)))) {
    await resolve();
    return c.json({ added: 0, skipped: 1 });
  }
  const storage = c.get("adapters").storage;
  const key = wcImageKey(shop.id, product.id, url, kind.ext);
  const tKey = thumb && thumbKind ? thumbKey(key, thumbKind.ext) : null;
  const size = imageSize(image, kind.contentType);
  await storage.put(key, image.slice().buffer, kind.contentType);
  try {
    if (thumb && thumbKind && tKey) await storage.put(tKey, thumb.slice().buffer, thumbKind.contentType);
    await db.from<ProductImageRow>("product_images").insert({
      shop_id: shop.id,
      product_id: product.id,
      storage_key: key,
      thumb_key: tKey,
      width: size?.width ?? null,
      height: size?.height ?? null,
      sort_order: existing.reduce((n, i) => Math.max(n, i.sort_order + 1), 0),
    });
  } catch (e) {
    await Promise.all([key, tKey].filter((k): k is string => !!k).map((k) => storage.delete(k).catch(() => undefined)));
    if (e instanceof DbError) return c.json({ error: "db_error" }, 502);
    throw e;
  }
  await resolve();
  return c.json({ added: 1, skipped: 0 });
});

/** 予約: { items: [{ slug, urls }] }（1 回 100 商品まで）。取り込み済み（同じ URL のキーが既にある）は飛ばす */
wooImport.post("/images/queue", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const { db } = owner(c);
  if (!(await migrated({ db, cache: c.get("adapters").cache }, IMAGE_QUEUE_MIGRATION))) return c.json({ error: "migration_required" }, 409);
  const body = await jsonBody(c);
  const items = Array.isArray(body?.["items"]) ? (body!["items"] as unknown[]) : null;
  if (!items || items.length === 0 || items.length > MAX_QUEUE_PRODUCTS) return c.json({ error: "invalid_request" }, 400);
  const payload: { slug: string; urls: { url: string; tag: string }[] }[] = [];
  for (const it of items) {
    const r = it as Record<string, unknown> | null;
    const slug = typeof r?.["slug"] === "string" ? r["slug"] : "";
    const urls = Array.isArray(r?.["urls"]) ? (r!["urls"] as unknown[]).filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 50) : [];
    if (slug && urls.length > 0) payload.push({ slug, urls: urls.map((url) => ({ url, tag: wcImageTag(url) })) });
  }
  if (payload.length === 0) return c.json({ queued: 0, skipped: 0, missing: 0 });
  try {
    return c.json(await db.rpc<{ queued: number; skipped: number; missing: number }>("image_import_enqueue", { p_shop_id: shop.id, p_items: payload }));
  } catch (e) {
    if (e instanceof DbError) return c.json({ error: "db_error" }, 502);
    throw e;
  }
});

wooImport.post("/images/queue/cancel", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  await owner(c).db.rpc("image_import_cancel", { p_shop_id: shop.id });
  return c.redirect(`/admin/shops/${shop.id}/modules/woo-import?queue=cancelled#image-queue`);
});

wooImport.post("/images/queue/retry", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  await owner(c).db.rpc("image_import_retry", { p_shop_id: shop.id });
  return c.redirect(`/admin/shops/${shop.id}/modules/woo-import?queue=retried#image-queue`);
});

wooImport.get("/images/queue/failures.csv", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const q = await owner(c).db.rpc<QueueSummary | null>("image_import_summary", { p_shop_id: shop.id });
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = (q?.failures ?? []).map((f) => [f.slug, f.url, imageFailureReason(f.code)].map(cell).join(","));
  return c.body(`\uFEFFslug,url,reason\r\n${rows.join("\r\n")}\r\n`, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="banto-image-failures.csv"', "Cache-Control": "no-store" });
});

const MAX_CUSTOMERS_PER_REQUEST = 100;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** 取り込む会員の住所を Banto の既定の住所の形に整える（形の違う値は捨てる） */
function cleanAddress(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  const str = (k: string, max = 200) => (typeof a[k] === "string" ? (a[k] as string).trim().slice(0, max) : "");
  const state = str("state");
  if (!str("line1") || !isPrefecture(state)) return null;
  return { name: str("name"), phone: str("phone", 50), postal_code: str("postal_code", 20), country: "JP", state, city: str("city"), line1: str("line1"), line2: str("line2") || null };
}

/**
 * 会員を取り込む。会員機能が ON のショップだけ。パスワードは移さない（会員は初回もメールのコードかリンクで入る）。
 * 同じメールアドレスの会員が既にあれば、足りない項目だけ埋める。1 回の呼び出しで最大 100 件
 * （ユーザーの作成が 1 件ずつのため、Workers の 1 リクエストあたりのサブリクエスト上限に収める）
 */
wooImport.post("/customers", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c, "customers");
  if (!shop) return c.notFound();
  if ((shop.settings ?? {})["members_enabled"] !== true) return c.json({ error: "members_disabled" }, 409);
  const body = await jsonBody(c);
  const list = Array.isArray(body?.["customers"]) ? (body!["customers"] as unknown[]) : null;
  if (!list || list.length === 0 || list.length > MAX_CUSTOMERS_PER_REQUEST) return c.json({ error: "invalid_request" }, 400);
  const rows: { email: string; name: string | null; default_address: Record<string, unknown> | null }[] = [];
  const errors: { email: string; message: string }[] = [];
  for (const r of list) {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const email = typeof o["email"] === "string" ? o["email"].trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email) || email.length > 200) {
      errors.push({ email: email.slice(0, 200), message: "invalid_email" });
      continue;
    }
    if (rows.some((x) => x.email === email)) continue;
    const name = typeof o["name"] === "string" && o["name"].trim() ? o["name"].trim().slice(0, 200) : null;
    rows.push({ email, name, default_address: cleanAddress(o["default_address"]) });
  }
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) return c.json({ error: "not_configured" }, 503);
  // ショップの所有は scope()（owner の JWT）で確かめ済み。ここから先は service_role（privileged.ts）
  const db = createPrivilegedDb({ url, serviceRoleKey, fetch: c.get("deps").fetch });
  const r = rows.length > 0 ? await db.importMembers(shop.id, rows) : { created: 0, updated: 0, skipped: 0 };
  return c.json({ customers_created: r.created, customers_updated: r.updated, errors });
});

type CouponLookupDb = ReturnType<typeof owner>["db"];

/** クーポンの取り込みで使う、既にあるキャンペーンと、WooCommerce の商品・カテゴリー → Banto の id */
async function couponLookups(db: CouponLookupDb, shopId: string) {
  const page = async <T extends object>(table: string, columns: string): Promise<T[]> => {
    const out: T[] = [];
    for (let offset = 0; ; offset += 1000) {
      const rows = await db.from<T>(table).select(columns, { eq: { shop_id: shopId }, order: "id.asc", limit: 1000, offset });
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  };
  const [campaigns, products, categories] = await Promise.all([
    page<{ id: string; code: string | null; external_ref?: string | null }>("coupon_campaigns", "id,code,external_ref"),
    page<{ id: string; slug: string }>("products", "id,slug"),
    page<{ id: string; slug: string }>("categories", "id,slug"),
  ]);
  const productBySlug = new Map(products.map((p) => [p.slug, p.id]));
  const slugById = new Map(products.map((p) => [p.id, p.slug]));
  const categoryBySlug = new Map(categories.map((x) => [x.slug, x.id]));
  // インポーターと同じ slug の決め方（SKU → slug、重なれば -<ID>、SKU が無ければ wc-<ID>）
  const slugify = (v: string) => {
    const s = v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
    return /^[a-z0-9][a-z0-9-]{0,62}$/.test(s) ? s : null;
  };
  const productOf = (ref: unknown): string | null => {
    const o = (ref && typeof ref === "object" ? ref : {}) as Record<string, unknown>;
    const id = typeof o["id"] === "string" ? o["id"] : "";
    const base = slugify(typeof o["sku"] === "string" ? o["sku"] : "");
    for (const cand of [base ? `${base.slice(0, 50)}-${id}` : null, `wc-${id}`, base]) if (cand && productBySlug.has(cand)) return productBySlug.get(cand)!;
    return null;
  };
  return { campaigns, productOf, slugById, categoryBySlug };
}

/**
 * クーポンの取り込み（REST API から読んだもの。ブラウザが mapCoupon で組み立てて 100 件ずつ送ってくる）。
 * 同じコードが既にあれば作らない（何度流しても重複しない）。商品・カテゴリーで絞ったクーポンは、Banto で対象が
 * 1 つでも見つからなければ「無効」で作る（対象を広げて値引きしない）。書き込みは owner の JWT（RLS の経路）
 */
wooImport.post("/coupons", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c, "marketing");
  if (!shop) return c.notFound();
  if (!moduleEnabled(shop.settings, "coupons")) return c.json({ error: "coupons_disabled" }, 409);
  const body = await jsonBody(c);
  const list = Array.isArray(body?.["coupons"]) ? (body!["coupons"] as unknown[]) : null;
  if (!list || list.length === 0 || list.length > 100) return c.json({ error: "invalid_request" }, 400);
  const { db } = owner(c);
  const { campaigns, productOf, categoryBySlug } = await couponLookups(db, shop.id);
  const codes = new Set(campaigns.map((x) => x.code).filter(Boolean));
  const wcRefs = new Set(campaigns.map((x) => x.external_ref).filter(Boolean));
  const totals = { created: 0, existing: 0, inactive: 0, grants_members: 0 };
  const grantCodes: { coupon: string; email: string; code: string }[] = [];
  for (const raw of list) {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const code = typeof o["code"] === "string" ? o["code"].trim().toUpperCase() : "";
    const kind = o["kind"] === "percent" || o["kind"] === "fixed" || o["kind"] === "free_shipping" ? o["kind"] : null;
    if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(code) || !kind) continue;
    const ref = typeof o["wc_id"] === "string" && /^[0-9]{1,12}$/.test(o["wc_id"]) ? `woocommerce:${o["wc_id"]}` : null;
    const restricted = Array.isArray(o["restricted_emails"])
      ? [...new Set((o["restricted_emails"] as unknown[]).filter((e): e is string => typeof e === "string" && e.includes("@") && !e.includes("*")).map((e) => e.trim().toLowerCase().slice(0, 254)))].slice(0, 5000)
      : [];
    // メールアドレスで絞ったクーポン: 0023 があれば、コードを持たないキャンペーン + その人ごとの発行済みクーポン。無ければ無効で作る
    const asGrants = restricted.length > 0;
    if (codes.has(code) || (ref && wcRefs.has(ref))) {
      totals.existing++;
      continue;
    }
    const cond = (o["conditions"] && typeof o["conditions"] === "object" ? o["conditions"] : {}) as Record<string, unknown>;
    const refs = (k: string) => (Array.isArray(cond[k]) ? (cond[k] as unknown[]) : []);
    const slugs = (k: string) => refs(k).filter((x): x is string => typeof x === "string");
    const inc = refs("products").map(productOf);
    const exc = refs("exclude_products").map(productOf);
    const incCat = slugs("category_slugs").map((x) => categoryBySlug.get(x) ?? null);
    const excCat = slugs("exclude_category_slugs").map((x) => categoryBySlug.get(x) ?? null);
    const missing = [...inc, ...exc, ...incCat, ...excCat].some((x) => x === null);
    const conditions: Record<string, unknown> = {};
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
    if (num(cond["min_subtotal_jpy"])) conditions["min_subtotal_jpy"] = num(cond["min_subtotal_jpy"]);
    if (num(cond["max_subtotal_jpy"])) conditions["max_subtotal_jpy"] = num(cond["max_subtotal_jpy"]);
    if (cond["exclude_sale"] === true) conditions["exclude_sale"] = true;
    const ok = (xs: (string | null)[]) => xs.filter((x): x is string => x !== null);
    if (ok(inc).length > 0) conditions["product_ids"] = ok(inc);
    if (ok(exc).length > 0) conditions["exclude_product_ids"] = ok(exc);
    if (ok(incCat).length > 0) conditions["category_ids"] = ok(incCat);
    if (ok(excCat).length > 0) conditions["exclude_category_ids"] = ok(excCat);
    // ブランド（名前）と、2 つ目以降のブランドを入れたタグ
    for (const k of ["brands", "exclude_brands", "exclude_tags"] as const) {
      const names = slugs(k).map((x) => x.trim().slice(0, 100)).filter(Boolean).slice(0, 20);
      if (names.length > 0) conditions[k] = names;
    }
    const value = kind === "free_shipping" ? 0 : kind === "percent" ? Math.min(100, Math.max(1, Math.round(Number(o["value"] ?? 0)))) : Math.max(1, Math.round(Number(o["value"] ?? 0)));
    // プラグイン独自の設定があるクーポン（運営者が「無効で作る」を選んだとき）は、必ず無効で作る
    const pluginKeys = Array.isArray(o["plugin_keys"]) ? (o["plugin_keys"] as unknown[]).filter((k) => typeof k === "string") : [];
    const active = o["active"] === true && !missing && (restricted.length === 0 || asGrants) && pluginKeys.length === 0;
    const int = (v: unknown, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? Math.min(max, v) : null);
    try {
      const [created] = await db.from<{ id: string } & Record<string, unknown>>("coupon_campaigns").insert({
        shop_id: shop.id,
        name: (typeof o["name"] === "string" && o["name"].trim() ? o["name"].trim() : code).slice(0, 100),
        code: asGrants ? null : code,
        ...(ref ? { external_ref: ref } : {}),
        kind,
        value,
        ends_at: typeof o["ends_at"] === "string" && !Number.isNaN(Date.parse(o["ends_at"])) ? o["ends_at"] : null,
        usage_limit: int(o["usage_limit"], 100000),
        per_customer_limit: int(o["per_customer_limit"], 1000),
        combinable: o["combinable"] === true,
        audience: "public",
        conditions,
        active,
      });
      if (!asGrants) codes.add(code);
      if (ref) wcRefs.add(ref);
      totals.created++;
      if (!active) totals.inactive++;
      if (asGrants && created) {
        const issued = await db.rpc<{ email: string; code: string; member: boolean }[]>("coupon_grants_for_emails", { p_shop_id: shop.id, p_campaign_id: created.id, p_emails: restricted });
        for (const g of issued) {
          if (g.member) totals.grants_members++;
          else grantCodes.push({ coupon: code, email: g.email, code: g.code });
        }
      }
    } catch (e) {
      if (e instanceof DbError && (e.status === 409 || e.code === "23505")) {
        totals.existing++;
        continue;
      }
      throw e;
    }
  }
  return c.json({ ...totals, grant_codes: grantCodes });
});

/**
 * プラグイン独自の設定があるクーポン（要確認）を、Banto のクーポン CSV に書き出す（docs/coupon-csv.md）。何も作らない。
 * 本体の項目は Banto の列に写し、プラグインの設定は source_meta に JSON のまま入れる。人や AI がそれを読んで列を直し、
 * クーポンの「CSV から取り込む」で入れる。直さずにそのまま取り込んでも制限が外れないよう、active は false で書く
 */
wooImport.post("/coupons/review.csv", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c, "marketing");
  if (!shop) return c.notFound();
  const body = await jsonBody(c);
  const list = Array.isArray(body?.["coupons"]) ? (body!["coupons"] as unknown[]) : null;
  if (!list || list.length === 0 || list.length > 1000) return c.json({ error: "invalid_request" }, 400);
  const { productOf, slugById, categoryBySlug } = await couponLookups(owner(c).db, shop.id);
  const slugsOf = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").join(";") : "");
  const when = (iso: unknown) => (typeof iso === "string" && !Number.isNaN(Date.parse(iso)) ? isoToZonedInput(iso).replace("T", " ") : "");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const rows = list.map((raw) => {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const cond = (o["conditions"] && typeof o["conditions"] === "object" ? o["conditions"] : {}) as Record<string, unknown>;
    const notes: string[] = [];
    if (o["active"] === true) notes.push(t("woo.review_note_was_active"));
    // 商品・カテゴリー: Banto に無いものは書かない（列に書くと取り込みで弾かれる）。無かったことは note に書く
    const products = (k: string) => {
      const refs = Array.isArray(cond[k]) ? (cond[k] as unknown[]) : [];
      const slugs = refs.map((r) => slugById.get(productOf(r) ?? "") ?? null);
      if (slugs.some((s) => s === null)) notes.push(tf("woo.review_note_missing", { what: k }));
      return slugs.filter((s): s is string => s !== null).join(";");
    };
    const cats = (k: string) => {
      const slugs = (Array.isArray(cond[k]) ? (cond[k] as unknown[]) : []).filter((x): x is string => typeof x === "string");
      if (slugs.some((s) => !categoryBySlug.has(s))) notes.push(tf("woo.review_note_missing", { what: k }));
      return slugs.filter((s) => categoryBySlug.has(s)).join(";");
    };
    const meta = Array.isArray(o["plugin_meta"]) ? (o["plugin_meta"] as { key?: unknown; value?: unknown }[]) : [];
    const keys = meta.map((m) => String(m.key ?? "")).filter(Boolean);
    if (keys.length > 0) notes.push(tf("woo.review_note_plugin", { keys: keys.join(", ") }));
    const restricted = Array.isArray(o["restricted_emails"]) ? (o["restricted_emails"] as unknown[]).filter((e): e is string => typeof e === "string") : [];
    let sourceMeta = JSON.stringify(Object.fromEntries(meta.map((m) => [String(m.key ?? ""), m.value ?? null])));
    if (sourceMeta.length > 30000) sourceMeta = `${sourceMeta.slice(0, 30000)}…`;
    return {
      code: typeof o["code"] === "string" ? o["code"] : "",
      name: typeof o["name"] === "string" ? o["name"] : "",
      kind: typeof o["kind"] === "string" ? o["kind"] : "",
      value: o["kind"] === "free_shipping" ? "" : num(o["value"]),
      ends_at: when(o["ends_at"]),
      usage_limit: num(o["usage_limit"]),
      per_customer_limit: num(o["per_customer_limit"]),
      combinable: o["combinable"] === true,
      member_emails: restricted.join(";"),
      min_subtotal_jpy: num(cond["min_subtotal_jpy"]),
      max_subtotal_jpy: num(cond["max_subtotal_jpy"]),
      exclude_sale: cond["exclude_sale"] === true ? true : "",
      product_slugs: products("products"),
      exclude_product_slugs: products("exclude_products"),
      category_slugs: cats("category_slugs"),
      exclude_category_slugs: cats("exclude_category_slugs"),
      brands: slugsOf(cond["brands"]),
      exclude_brands: slugsOf(cond["exclude_brands"]),
      exclude_tags: slugsOf(cond["exclude_tags"]),
      active: false,
      ref: typeof o["wc_id"] === "string" && /^[0-9]{1,12}$/.test(o["wc_id"]) ? `woocommerce:${o["wc_id"]}` : "",
      note: notes.join(" / "),
      source_meta: sourceMeta,
    };
  });
  return c.body(couponCsv(rows), 200, { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" });
});

/**
 * クーポンの 1 人ごとの使用回数（WooCommerce の used_by をメールアドレスにそろえたもの）。0023 の import_coupon_usage。
 * reset の回で、そのキャンペーンに取り込んだ使用を入れ直す（何度流しても重ならない）
 */
wooImport.post("/coupons/usage", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c, "marketing");
  if (!shop) return c.notFound();
  const body = await jsonBody(c);
  const code = typeof body?.["code"] === "string" ? body["code"].trim().toUpperCase() : "";
  const emails = Array.isArray(body?.["emails"]) ? (body!["emails"] as unknown[]).filter((e): e is string => typeof e === "string").map((e) => e.slice(0, 254)) : null;
  if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(code) || !emails || emails.length > 2000) return c.json({ error: "invalid_request" }, 400);
  try {
    return c.json(await owner(c).db.rpc<Record<string, unknown>>("import_coupon_usage", { p_shop_id: shop.id, p_code: code, p_emails: emails, p_reset: body!["reset"] === true }));
  } catch (e) {
    if (e instanceof DbError) return c.json({ error: "db_error" }, 502);
    throw e;
  }
});

/** 過去の注文（REST API から読んだもの。ブラウザが mapOrder で組み立てて 100 件ずつ送る）。0023 の import_orders */
wooImport.post("/orders", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c, "orders");
  if (!shop) return c.notFound();
  const body = await jsonBody(c);
  const list = Array.isArray(body?.["orders"]) ? (body!["orders"] as unknown[]) : null;
  if (!list || list.length === 0 || list.length > 100) return c.json({ error: "invalid_request" }, 400);
  try {
    return c.json(await owner(c).db.rpc<Record<string, unknown>>("import_orders", { p_shop_id: shop.id, p_orders: list }));
  } catch (e) {
    if (e instanceof DbError) return c.json({ error: "db_error", message: e.message.slice(0, 300) }, 502);
    throw e;
  }
});

/**
 * WordPress のパスワードの取り込み。ブラウザが wp_users の CSV を読み、メールアドレスとハッシュだけを送ってくる。
 * 形式の確かめと保存は import_member_passwords（0013）。ハッシュはログに出さない
 */
wooImport.post("/customers/passwords", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c, "customers");
  if (!shop) return c.notFound();
  const settings = shop.settings ?? {};
  if (settings["members_enabled"] !== true || settings["members_password"] !== true) return c.json({ error: "password_disabled" }, 409);
  const body = await jsonBody(c);
  const list = Array.isArray(body?.["rows"]) ? (body!["rows"] as unknown[]) : null;
  if (!list || list.length === 0 || list.length > MAX_CUSTOMERS_PER_REQUEST) return c.json({ error: "invalid_request" }, 400);
  const rows = list.map((r) => {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    return { email: typeof o["email"] === "string" ? o["email"].slice(0, 254) : "", hash: typeof o["hash"] === "string" ? o["hash"].slice(0, 100) : "" };
  });
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) return c.json({ error: "not_configured" }, 503);
  const db = createPrivilegedDb({ url, serviceRoleKey, fetch: c.get("deps").fetch });
  return c.json(await db.importMemberPasswords(shop.id, rows));
});
