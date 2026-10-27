import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { ShopRow } from "../../db/types";
import { t } from "../../i18n";
import { AdminLayout, PageHead } from "../../routes/admin/layout";
import { formFields, owner, param, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { loadShop } from "../../routes/admin/shops";
import { DELIVERY_SLOTS, deliverySettings, slotLabel } from "./index";

/**
 * 同梱モジュール「配送日時の指定」の設定（shops.settings.delivery_time）。
 *   GET/POST /admin/shops/:shopId/modules/delivery-time
 */
export const deliveryAdmin = new Hono<AppEnv>();

async function scope(c: AdminContext): Promise<ShopRow | null> {
  const shop = await loadShop(c, param(c, "shopId"), "settings");
  return shop && deliverySettings(shop.settings) ? shop : null;
}

deliveryAdmin.get("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const ds = deliverySettings(shop.settings)!;
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("delivery.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("modules.title"), href: `/admin/shops/${shop.id}/modules` }, { label: t("delivery.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "modules" }}>
      <PageHead title={t("delivery.title")} />
      {c.req.query("flash") === "saved" ? <p class="notice">{t("delivery.saved")}</p> : null}
      <p>{t("delivery.intro")}</p>
      <form method="post" action={`/admin/shops/${shop.id}/modules/delivery-time`}>
        <label for="min_days">{t("delivery.min_days")}</label>
        <input id="min_days" type="number" name="min_days" min={0} max={60} value={String(ds.min_days)} style="width:6rem" />
        <label for="max_days">{t("delivery.max_days")}</label>
        <input id="max_days" type="number" name="max_days" min={0} max={90} value={String(ds.max_days)} style="width:6rem" />
        <fieldset>
          <legend>{t("delivery.slots")}</legend>
          {DELIVERY_SLOTS.map((sl) => (
            <label>
              <input type="checkbox" name={`slot_${sl}`} value="on" checked={ds.slots.includes(sl)} /> {slotLabel(sl)}
            </label>
          ))}
        </fieldset>
        <p>
          <button type="submit">{t("delivery.save")}</button>
        </p>
      </form>
    </AdminLayout>,
  );
});

deliveryAdmin.post("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const f = await formFields(c);
  const int = (v: string | undefined, lo: number, hi: number, d: number) => {
    const n = Number.parseInt(v ?? "", 10);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : d;
  };
  const min = int(f.min_days, 0, 60, 3);
  const delivery_time = { min_days: min, max_days: Math.max(min, int(f.max_days, 0, 90, 14)), slots: DELIVERY_SLOTS.filter((sl) => f[`slot_${sl}`] === "on") };
  try {
    await owner(c).db.from<ShopRow>("shops").update({ settings: { ...(shop.settings ?? {}), delivery_time } }, { id: shop.id });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shop.id}/modules/delivery-time?flash=generic`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shop.id}/modules/delivery-time?flash=saved`);
});
