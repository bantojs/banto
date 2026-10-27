import { Hono } from "hono";
import { raw } from "hono/html";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { OrderItemRow, ProductRow, ShopRow, SkuRow } from "../../db/types";
import { t } from "../../i18n";
import { getTimeZone } from "../../i18n/time";
import { AdminLayout, PageHead } from "../../routes/admin/layout";
import { formFields, owner, param, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { loadShop } from "../../routes/admin/shops";
import { moduleEnabled } from "../registry";
import { CLIENT_PRELUDE } from "../woo-import/admin";
import { todayIn } from "../delivery-time";
import { CARRIERS, buildLabelsCsv, labelSettings, type Carrier, type LabelOrder } from "./csv";
import { shippingLabelsClient } from "./client";
import { TRACKING_CARRIERS, carrierLabel, isTrackingCarrier } from "../../orders/tracking";
import { selectIn } from "../../db/select-in";

export const LABELS_MODULE = "shipping_labels";

/**
 * 同梱モジュール「送り状 CSV」（docs/shipping-labels.md）。
 *   GET  /admin/shops/:shopId/modules/shipping-labels            ご依頼主の設定と、CSV のダウンロード
 *   POST /admin/shops/:shopId/modules/shipping-labels            設定を保存
 *   GET  /admin/shops/:shopId/modules/shipping-labels/rows.json  未発送（支払い済み）の注文の CSV（文字列。Shift_JIS への変換はブラウザ）
 *   POST /admin/shops/:shopId/modules/shipping-labels/tracking   送り状番号の取り込み（JSON。CSV はブラウザで読む。0022 の ship_orders）
 */
export const labelsAdmin = new Hono<AppEnv>();

async function scope(c: AdminContext): Promise<ShopRow | null> {
  const shop = await loadShop(c, param(c, "shopId"), "orders");
  return shop && moduleEnabled(shop.settings, LABELS_MODULE) ? shop : null;
}

const CLIENT_KEYS = [
  "ship_date", "download_yamato", "download_sagawa", "loading", "done", "unmappable", "warn", "failed", "f_phone", "f_postal_code", "f_address_long", "f_address2_long", "f_name_long",
  "import_file", "import_carrier", "import_col_number", "import_col_tracking", "import_column", "import_preview", "import_start", "import_done", "import_missing", "import_no_rows",
] as const;
/** 送り状番号の取り込みの 1 回あたりの上限（ship_orders と同じ） */
const MAX_TRACKING_ITEMS = 500;

labelsAdmin.get("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const s = labelSettings(shop.settings);
  const base = `/admin/shops/${shop.id}/modules/shipping-labels`;
  const dict: Record<string, string> = Object.fromEntries(CLIENT_KEYS.map((k) => [k, t(`labels.${k}`)]));
  for (const k of TRACKING_CARRIERS) dict[`carrier_${k}`] = carrierLabel(k);
  const json = JSON.stringify({ rows: `${base}/rows.json`, tracking: `${base}/tracking`, t: dict }).replace(/</g, "\\u003c");
  const script = `${CLIENT_PRELUDE}var __labels = (${shippingLabelsClient.toString()})(); var __cfg = ${json}; __labels.mount(document.getElementById("shipping-labels"), __cfg); __labels.mountImport(document.getElementById("tracking-import"), __cfg);`;
  const field = (name: keyof typeof s, label: string, hint?: string) => (
    <div>
      <label for={name}>{label}</label>
      <input id={name} name={name} value={s[name]} maxlength={100} />
      {hint ? <p class="muted">{hint}</p> : null}
    </div>
  );
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("labels.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("modules.title"), href: `/admin/shops/${shop.id}/modules` }, { label: t("labels.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "modules" }}>
      <PageHead title={t("labels.title")} />
      {c.req.query("flash") === "saved" ? <p class="notice">{t("labels.saved")}</p> : null}
      <p>{t("labels.intro")}</p>
      <div id="shipping-labels"></div>
      <h2>{t("labels.import_title")}</h2>
      <p>{t("labels.import_intro")}</p>
      <div id="tracking-import"></div>
      <script>{raw(script)}</script>
      <h2>{t("labels.settings")}</h2>
      <form method="post" action={base}>
        {field("shipper_name", t("labels.shipper_name"))}
        {field("shipper_phone", t("labels.shipper_phone"))}
        {field("shipper_postal", t("labels.shipper_postal"))}
        {field("shipper_address", t("labels.shipper_address"))}
        {field("shipper_address2", t("labels.shipper_address2"))}
        {field("item_name", t("labels.item_name"), t("labels.item_name_hint"))}
        <h3>{t("labels.yamato")}</h3>
        {field("yamato_type", t("labels.yamato_type"), t("labels.yamato_type_hint"))}
        {field("yamato_billing_code", t("labels.yamato_billing_code"))}
        {field("yamato_freight_no", t("labels.yamato_freight_no"))}
        <p>
          <button type="submit">{t("labels.save")}</button>
        </p>
      </form>
      <h2>{t("labels.howto")}</h2>
      <ul>
        <li>{t("labels.howto_yamato")}</li>
        <li>{t("labels.howto_sagawa")}</li>
      </ul>
    </AdminLayout>,
  );
});

labelsAdmin.post("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const f = await formFields(c);
  const keys = ["shipper_name", "shipper_phone", "shipper_postal", "shipper_address", "shipper_address2", "item_name", "yamato_type", "yamato_billing_code", "yamato_freight_no"] as const;
  const shipping_labels = Object.fromEntries(keys.map((k) => [k, (f[k] ?? "").trim().slice(0, 100)]));
  try {
    await owner(c).db.from<ShopRow>("shops").update({ settings: { ...(shop.settings ?? {}), shipping_labels } }, { id: shop.id });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shop.id}/modules/shipping-labels?flash=generic`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shop.id}/modules/shipping-labels?flash=saved`);
});

interface OrderForLabel {
  id: string;
  number: number;
  customer_name: string | null;
  shipping_address: Record<string, unknown> | null;
  delivery?: { date?: string | null; slot?: string | null } | null;
}

labelsAdmin.get("/rows.json", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const carrier = c.req.query("carrier") as Carrier;
  if (!(CARRIERS as readonly string[]).includes(carrier)) return c.json({ error: "carrier" }, 400);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query("date") ?? "") ? c.req.query("date")! : todayIn(getTimeZone(), Date.now());
  const { db } = owner(c);
  // 未発送 = 支払い済み（status = paid）。古い順に最大 500 件
  const orders = await db.from<OrderForLabel>("orders").select("*", { eq: { shop_id: shop.id, status: "paid" }, order: "created_at.asc", limit: 500 });
  // 明細・SKU・商品は送り状に載せる注文の分だけ（ショップ全体を読むと 1,000 行で欠ける）
  const items = await selectIn<OrderItemRow>(db, "order_items", "order_id,sku_id,qty,item_name", shop.id, "order_id", orders.map((o) => o.id));
  const skus = await selectIn<SkuRow>(db, "skus", "id,product_id", shop.id, "id", items.map((i) => i.sku_id).filter((id): id is string => Boolean(id)));
  const products = await selectIn<ProductRow>(db, "products", "id,name", shop.id, "id", skus.map((k) => k.product_id));
  const productOfSku = new Map(skus.map((k) => [k.id, k.product_id]));
  const nameOf = new Map(products.map((p) => [p.id, p.name]));
  const itemsBy = new Map<string, OrderItemRow[]>();
  for (const it of items) itemsBy.set(it.order_id, [...(itemsBy.get(it.order_id) ?? []), it]);
  const rows: LabelOrder[] = orders.map((o) => {
    const its = itemsBy.get(o.id) ?? [];
    const first = its[0] ? (its[0].item_name ?? nameOf.get(productOfSku.get(its[0].sku_id ?? "") ?? "")) : undefined;
    return { number: o.number, customer_name: o.customer_name, shipping_address: o.shipping_address, delivery: o.delivery ?? null, first_item: first ?? null, item_count: its.length };
  });
  const { csv, warnings } = buildLabelsCsv(carrier, rows, labelSettings(shop.settings), date);
  c.header("Cache-Control", "no-store");
  return c.json({ csv, count: rows.length, warnings });
});

labelsAdmin.post("/tracking", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  let body: unknown;
  try {
    const text = await c.req.text();
    if (text.length > 200_000) return c.json({ error: "too_large" }, 413);
    body = JSON.parse(text);
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>)["items"] : null;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TRACKING_ITEMS) return c.json({ error: "invalid_request" }, 400);
  // 形だけそろえる。番号の検査と突き合わせは ship_orders（所有の確認も）
  const items = raw.map((r) => {
    const o = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
    return { number: String(o["number"] ?? "").slice(0, 20), carrier: isTrackingCarrier(o["carrier"]) ? o["carrier"] : "other", tracking: String(o["tracking"] ?? "").slice(0, 80) };
  });
  try {
    const result = await owner(c).db.rpc<{ shipped: number; updated: number; invalid: number; missing: number[] }>("ship_orders", { p_shop_id: shop.id, p_items: items });
    return c.json(result);
  } catch (e) {
    if (e instanceof DbError) return c.json({ error: "db_error" }, 502);
    throw e;
  }
});
