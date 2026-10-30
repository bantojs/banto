import { Hono } from "hono";
import type { AppEnv } from "../../app";
import type { DbClient, Row } from "../../db/client";
import { createPrivilegedDb, PrivilegedRpcError } from "../../db/privileged";
import { t } from "../../i18n";
import { BANTO_VERSION } from "../../version";
import { migrated } from "../../db/migration-state";
import { PAGES_MIGRATION } from "../../pages";
import { BLOG_MIGRATION } from "../../blog";
import { owner, param, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";

/**
 * バックアップ用の書き出し。GET /admin/shops/:shopId/export.json
 * owner の JWT（RLS が効く）で、そのショップの行を全部 JSON にして返す。画像の実体（R2）は含まない。
 * Supabase Free には自動バックアップが無いので、定期的にこれを保存してもらう（docs/backup.md）。
 * 復元ツールは同梱しない: Supabase の SQL エディタや、同じ形を読む移行スクリプトで戻す前提。
 */
export const exportRoute = new Hono<AppEnv>();

const PAGE = 1000;
/** 復元 JSON の上限（Workers のメモリと JSON.parse の時間を考えて） */
export const MAX_RESTORE_BYTES = 50 * 1024 * 1024;
const RESTORE_TABLES = ["categories", "products", "skus", "inventory", "product_images", "orders", "order_items", "customers", "hook_endpoints"] as const;
/** eq / columns は書き出しを絞るとき（coupon_slots は使用済みの行の数だけ要る。全体の上限の数だけ行があるため） */
const TABLES: { name: string; order: string; eq?: Record<string, string>; columns?: string }[] = [
  { name: "categories", order: "created_at.asc" },
  { name: "products", order: "created_at.asc" },
  { name: "skus", order: "created_at.asc" },
  { name: "inventory", order: "sku_id.asc" },
  { name: "product_images", order: "created_at.asc" },
  { name: "orders", order: "created_at.asc" },
  { name: "order_items", order: "id.asc" },
  { name: "customers", order: "created_at.asc" },
  { name: "hook_endpoints", order: "created_at.asc" },
  { name: "coupon_campaigns", order: "created_at.asc" },
  { name: "coupon_slots", order: "id.asc", eq: { status: "used" }, columns: "campaign_id,status" },
  { name: "coupon_grants", order: "created_at.asc" },
];

/** お問い合わせ（0061） */
const INQUIRY_TABLES: typeof TABLES = [
  { name: "inquiries", order: "created_at.asc", columns: "id,number,category,status,origin,contact_email,contact_name,email_verified_at,customer_id,order_id,claimed_order_number,created_at,last_message_at,closed_at,masked_at" },
  { name: "inquiry_messages", order: "created_at.asc", columns: "id,inquiry_id,author,body,created_at" },
];

/** ショップのページ（同梱モジュール pages、0079）。当たっているときだけ書き出す（復元は今までどおり商品・注文・会員まで） */
const PAGE_TABLES: typeof TABLES = [{ name: "pages", order: "created_at.asc" }];
/** ブログと記事（同梱モジュール blog、0081）。当たっているときだけ */
const BLOG_TABLES: typeof TABLES = [{ name: "blogs", order: "created_at.asc" }, { name: "articles", order: "created_at.asc" }];

/** PostgREST の 1 回あたりの上限（既定 1,000 行）を offset で回して全件読む */
export async function readAll(db: DbClient, table: string, shopId: string, order: string, eq: Record<string, string> = {}, columns = "*"): Promise<Row[]> {
  const out: Row[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await db.from("" + table).select(columns, { eq: { ...eq, shop_id: shopId }, order, limit: PAGE, offset });
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

exportRoute.get("/:shopId/export.json", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "admin");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const tables: Record<string, Row[]> = {};
  const deps = { db, cache: c.get("adapters").cache };
  const [hasPages, hasBlog] = await Promise.all([migrated(deps, PAGES_MIGRATION), migrated(deps, BLOG_MIGRATION)]);
  const pages = hasPages ? PAGE_TABLES : [];
  const blog = hasBlog ? BLOG_TABLES : [];
  for (const tbl of [...TABLES, ...INQUIRY_TABLES, ...pages, ...blog]) tables[tbl.name] = await readAll(db, tbl.name, shopId, tbl.order, tbl.eq, tbl.columns);
  const body = {
    banto_export: 1,
    version: BANTO_VERSION,
    exported_at: new Date().toISOString(),
    shop,
    tables,
    counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
    note: "画像ファイル（R2）の実体は含まれません。product_images.storage_key / thumb_key がキーです。",
  };
  const date = body.exported_at.slice(0, 10);
  return c.body(JSON.stringify(body, null, 2), 200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="banto-${shop.slug}-${date}.json"`,
    "Cache-Control": "no-store",
  });
});

/**
 * バックアップ JSON からの復元。POST /admin/shops/:shopId/restore（multipart、file = export.json）
 * 空のショップにだけ入れられる（restore_shop_data が検査）。所有の確認は loadShop（owner JWT）、書き込みは service_role の RPC。
 */
exportRoute.post("/:shopId/restore", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const base = `/admin/shops/${shopId}`;
  const shop = await loadShop(c, shopId, "admin");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File) || file.size === 0) return c.redirect(`${base}?flash=restore_invalid`);
  if (file.size > MAX_RESTORE_BYTES) return c.redirect(`${base}?flash=restore_invalid`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return c.redirect(`${base}?flash=restore_invalid`);
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { banto_export?: unknown }).banto_export !== 1) return c.redirect(`${base}?flash=restore_invalid`);
  const rawTables = (parsed as { tables?: unknown }).tables;
  if (!rawTables || typeof rawTables !== "object") return c.redirect(`${base}?flash=restore_invalid`);
  const tables: Record<string, unknown[]> = {};
  for (const name of RESTORE_TABLES) {
    const rows = (rawTables as Record<string, unknown>)[name];
    if (rows !== undefined && !Array.isArray(rows)) return c.redirect(`${base}?flash=restore_invalid`);
    tables[name] = Array.isArray(rows) ? rows : [];
  }
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) return c.redirect(`${base}?flash=generic`);
  try {
    const privileged = createPrivilegedDb({ url, serviceRoleKey, fetch: c.get("deps").fetch });
    // SKU を分ける軸（0065）: 戻す間はショップの既定を外す（商品を戻したときに既定が写り、SKU が合わずに止まらないように）。最後に戻す
    if (shop.option_axes !== null && shop.option_axes !== undefined) await privileged.restoreOptionAxes(shopId, { shop: null });
    const counts = await privileged.restoreShopData(shopId, tables);
    // 0006 が知らない列（タグ・カテゴリー・ブランド・カスタム項目・SKU の拡張）を戻す（0008）
    Object.assign(counts, await privileged.restoreCatalog(shopId, { categories: tables["categories"] ?? [], products: tables["products"] ?? [], skus: tables["skus"] ?? [] }));
    // 税の区分と注文の税率（0017）
    Object.assign(counts, await privileged.restoreTax(shopId, tables["products"] ?? [], tables["orders"] ?? []));
    // クーポン・注文の値引き・配送の指定・お問い合わせ番号（0022）
    const pick = (name: string) => {
      const rows = (rawTables as Record<string, unknown>)[name];
      return Array.isArray(rows) ? rows : [];
    };
    const commerce = Object.fromEntries(["products", "categories", "skus", "orders", "order_items", "coupon_campaigns", "coupon_slots", "coupon_grants"].map((n) => [n, pick(n)]));
    Object.assign(counts, await privileged.restoreCommerce(shopId, commerce));
    // 取り込んだ過去の注文の ID と品名、SKU の無い明細（0023）
    Object.assign(counts, await privileged.restoreHistory(shopId, commerce));
    // 会員の外部の ID と独自項目（0047）
    Object.assign(counts, await privileged.restoreCustomerMaster(shopId, pick("customers")));
    // お問い合わせとやり取り（0061）。書き出しに入っているときだけ
    if (pick("inquiries").length > 0) {
      Object.assign(counts, await privileged.restoreInquiries(shopId, { inquiries: pick("inquiries"), inquiry_messages: pick("inquiry_messages"), orders: pick("orders"), customers: pick("customers") }));
    }
    // 画像を SKU に結んだもの（0063）。結んだ画像があるときだけ
    const imageOptions = pick("product_images")
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !!(r as Record<string, unknown>)["options"] && Object.keys((r as Record<string, unknown>)["options"] as object).length > 0)
      .map((r) => ({ storage_key: r["storage_key"], options: r["options"] }));
    if (imageOptions.length > 0) {
      Object.assign(counts, await privileged.restoreProductImageOptions(shopId, imageOptions));
    }
    {
      const backupShop = (parsed as { shop?: { option_axes?: unknown } }).shop;
      const shopAxes = backupShop && "option_axes" in backupShop ? backupShop.option_axes : (shop.option_axes ?? null);
      const rows = (name: string) => pick(name).filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && Array.isArray((r as Record<string, unknown>)["option_axes"]));
      Object.assign(
        counts,
        await privileged.restoreOptionAxes(shopId, {
          shop: shopAxes ?? null,
          categories: rows("categories").map((r) => ({ slug: r["slug"], option_axes: r["option_axes"] })),
          products: rows("products").map((r) => ({ slug: r["slug"], option_axes: r["option_axes"], option_axes_custom: r["option_axes_custom"] === true })),
        }),
      );
    }
    const detail = Object.entries(counts)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    return c.redirect(`${base}?flash=restored&detail=${encodeURIComponent(detail)}`);
  } catch (e) {
    if (e instanceof PrivilegedRpcError) {
      if (e.message.includes("shop_not_empty")) return c.redirect(`${base}?flash=restore_not_empty`);
      if (e.message.includes("invalid_export")) return c.redirect(`${base}?flash=restore_invalid`);
      console.error("[banto] restore failed:", e.message);
      return c.redirect(`${base}?flash=restore_failed`);
    }
    throw e;
  }
});
