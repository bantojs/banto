import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { ShopRow } from "../../db/types";
import { t } from "../../i18n";
import { migrated } from "../../db/migration-state";
import { AdminLayout, PageHead } from "../../routes/admin/layout";
import { formFields, owner, param, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { loadShop } from "../../routes/admin/shops";
import { STOREFRONT_SETTINGS_MIGRATION } from "../../storefront/data";
import { moduleEnabled } from "../registry";
import { GA4_ID_RE, GA4_MODULE, ga4Id } from "./ga4";

/**
 * 同梱モジュール「Google アナリティクス（GA4）」の設定（測定 ID。shops.settings.analytics.ga4_id）。docs/ga4.md
 *   GET/POST /admin/shops/:shopId/modules/ga4
 * 測定 ID はお客様の画面に出す値なので、公開の settings に入る（0041 が当たるまでは画面に渡らないので、設定の欄も出さない）。
 */
export const ga4Admin = new Hono<AppEnv>();

async function scope(c: AdminContext): Promise<ShopRow | null> {
  const shop = await loadShop(c, param(c, "shopId"), "settings");
  return shop && moduleEnabled(shop.settings, GA4_MODULE) ? shop : null;
}

ga4Admin.get("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const ready = await migrated({ db: owner(c).db, cache: c.get("adapters").cache }, STOREFRONT_SETTINGS_MIGRATION);
  const flash = c.req.query("flash");
  const id = ga4Id(shop.settings);
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("mod.ga4.name")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("modules.title"), href: `/admin/shops/${shop.id}/modules` }, { label: t("mod.ga4.name") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "modules" }}>
      <PageHead title={t("mod.ga4.name")} />
      {flash === "saved" ? <p class="notice">{t("ga4.saved")}</p> : null}
      {flash === "invalid" ? <p class="error">{t("ga4.invalid")}</p> : null}
      <p>{t("ga4.intro")}</p>
      {ready ? (
        <form method="post" action={`/admin/shops/${shop.id}/modules/ga4`}>
          <label for="ga4_id">{t("ga4.id")}</label>
          <input id="ga4_id" type="text" name="ga4_id" value={id ?? ""} placeholder="G-XXXXXXXXXX" pattern="[Gg]-[A-Za-z0-9]{4,20}" style="width:14rem" />
          <p class="muted">{t("ga4.id_hint")}</p>
          <p>
            <button type="submit">{t("shop.save")}</button>
          </p>
        </form>
      ) : (
        <p class="notice">
          {t("ga4.needs_update")} <a href="/admin/update">{t("update.title")}</a>
        </p>
      )}
      <p class="muted">{id ? t("ga4.status_on") : t("ga4.status_off")}</p>
      <p class="muted">{t("ga4.privacy")}</p>
    </AdminLayout>,
  );
});

ga4Admin.post("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const base = `/admin/shops/${shop.id}/modules/ga4`;
  const raw = ((await formFields(c)).ga4_id ?? "").trim().toUpperCase();
  if (raw && !GA4_ID_RE.test(raw)) return c.redirect(`${base}?flash=invalid`);
  const current = shop.settings ?? {};
  const analytics = { ...(current["analytics"] && typeof current["analytics"] === "object" && !Array.isArray(current["analytics"]) ? (current["analytics"] as Record<string, unknown>) : {}), ga4_id: raw || null };
  try {
    await owner(c).db.from<ShopRow>("shops").update({ settings: { ...current, analytics } }, { id: shop.id });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${base}?flash=invalid`);
    throw e;
  }
  return c.redirect(`${base}?flash=saved`);
});
