import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { OrderItemRow, ProductRow, ShopRow, SkuRow } from "../../db/types";
import { t } from "../../i18n";
import { AdminLayout, PageHead } from "../../routes/admin/layout";
import { formFields, owner, param, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { loadShop } from "../../routes/admin/shops";
import { moduleEnabled } from "../registry";
import { INVOICE_NUMBER_RE, RECEIPT_MODULE, RECEIPT_STATUSES, receiptSettings, renderReceipt, type ReceiptOrder } from "./render";

export { RECEIPT_MODULE };

/**
 * 同梱モジュール「領収書」の設定（発行者名・登録番号・但し書き。shops.settings.receipt）と、運営者が出す領収書。
 *   GET/POST /admin/shops/:shopId/modules/receipt                設定
 *   GET      /admin/shops/:shopId/orders/:orderId/receipt?name=   領収書（routes/admin/orders.tsx から）
 */
export const receiptAdmin = new Hono<AppEnv>();

async function scope(c: AdminContext): Promise<ShopRow | null> {
  const shop = await loadShop(c, param(c, "shopId"), "settings");
  return shop && moduleEnabled(shop.settings, RECEIPT_MODULE) ? shop : null;
}

receiptAdmin.get("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const s = receiptSettings(shop);
  const raw = ((shop.settings ?? {})["receipt"] ?? {}) as Record<string, unknown>;
  const flash = c.req.query("flash");
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("receipt.module_title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("modules.title"), href: `/admin/shops/${shop.id}/modules` }, { label: t("receipt.module_title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name }, access: c.get("shopAccess"), active: "modules" }}>
      <PageHead title={t("receipt.module_title")} />
      {flash === "saved" ? <p class="notice">{t("receipt.saved")}</p> : null}
      {flash === "invalid" ? <p class="error">{t("receipt.invalid_number")}</p> : null}
      <p>{t("receipt.module_intro")}</p>
      <form method="post" action={`/admin/shops/${shop.id}/modules/receipt`}>
        <label for="issuer">{t("receipt.issuer")}</label>
        <input id="issuer" name="issuer" value={typeof raw["issuer"] === "string" ? raw["issuer"] : ""} placeholder={shop.name} maxlength={200} />
        <label for="invoice_number">{t("receipt.invoice_number_label")}</label>
        <input id="invoice_number" name="invoice_number" value={s.invoice_number ?? ""} placeholder="T1234567890123" pattern="T[0-9]{13}" maxlength={14} />
        <p class="muted">{t("receipt.invoice_number_hint")}</p>
        <label for="proviso">{t("receipt.proviso_label")}</label>
        <input id="proviso" name="proviso" value={typeof raw["proviso"] === "string" ? raw["proviso"] : ""} placeholder={t("receipt.proviso_default")} maxlength={100} />
        <p>
          <button type="submit">{t("receipt.save")}</button>
        </p>
      </form>
      <p class="muted">{t("receipt.where")}</p>
    </AdminLayout>,
  );
});

receiptAdmin.post("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const f = await formFields(c);
  const num = (f.invoice_number ?? "").trim().toUpperCase();
  const base = `/admin/shops/${shop.id}/modules/receipt`;
  if (num && !INVOICE_NUMBER_RE.test(num)) return c.redirect(`${base}?flash=invalid`);
  const receipt = { issuer: (f.issuer ?? "").trim().slice(0, 200), invoice_number: num || null, proviso: (f.proviso ?? "").trim().slice(0, 100) };
  try {
    await owner(c).db.from<ShopRow>("shops").update({ settings: { ...(shop.settings ?? {}), receipt } }, { id: shop.id });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${base}?flash=invalid`);
    throw e;
  }
  return c.redirect(`${base}?flash=saved`);
});

interface AdminOrderRow {
  id: string;
  number: number;
  status: string;
  created_at: string;
  total_jpy: number;
  shipping_jpy: number;
  discount_jpy?: number | null;
  discounts?: { code?: string; name?: string; amount_jpy?: number }[] | null;
  shipping_tax_rate?: number | string | null;
  tax_rounding?: string | null;
  customer_name: string | null;
}

/** 運営者が出す領収書（owner の JWT、RLS の経路）。宛名の既定は購入者の名前 */
export async function adminReceipt(c: AdminContext): Promise<Response> {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "orders");
  if (!shop || !moduleEnabled(shop.settings, RECEIPT_MODULE)) return c.notFound();
  const order = await db.from<AdminOrderRow>("orders").selectOne("*", { eq: { id: param(c, "orderId"), shop_id: shopId } });
  if (!order || !RECEIPT_STATUSES.includes(order.status)) return c.text(t("receipt.not_available"), 404);
  const [items, skus, products] = await Promise.all([
    db.from<OrderItemRow & { tax_rate?: number | string | null }>("order_items").select("*", { eq: { order_id: order.id } }),
    db.from<SkuRow>("skus").select("id,code,name,product_id", { eq: { shop_id: shopId } }),
    db.from<ProductRow>("products").select("id,name", { eq: { shop_id: shopId } }),
  ]);
  const skuById = new Map(skus.map((s) => [s.id, s]));
  const nameById = new Map(products.map((p) => [p.id, p.name]));
  const ro: ReceiptOrder = {
    ...order,
    discounts: (order.discounts ?? []).map((d) => ({ code: String(d.code ?? ""), name: String(d.name ?? ""), amount_jpy: Number(d.amount_jpy ?? 0) })),
    items: items.map((i) => {
      const sku = i.sku_id ? skuById.get(i.sku_id) : undefined;
      // 取り込んだ過去の注文は取り込んだ時点の品名（0023）
      return { name: i.item_name ?? (sku && nameById.get(sku.product_id)) ?? "", sku: i.item_variant ?? (sku ? (sku.name ?? sku.code) : null), qty: i.qty, unit_price_jpy: i.unit_price_jpy, tax_rate: i.tax_rate ?? null, discount_jpy: (i as { discount_jpy?: number }).discount_jpy ?? 0 };
    }),
  };
  const name = (c.req.query("name") ?? order.customer_name ?? "").trim().slice(0, 100);
  c.header("Cache-Control", "no-store");
  return c.html(renderReceipt({ shopName: shop.name, settings: receiptSettings(shop), shopSettings: shop.settings, order: ro, addressee: name, issuedAt: new Date(), nameForm: { action: `/admin/shops/${shopId}/orders/${order.id}/receipt`, method: "get", hidden: {} } }));
}
