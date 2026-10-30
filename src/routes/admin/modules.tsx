import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { ShopRow } from "../../db/types";
import { t } from "../../i18n";
import { AdminLayout, PageHead } from "./layout";
import { formFields, owner, param, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";
import { MODULES, moduleEnabled, type ModuleDef } from "../../modules/registry";
import { migrated } from "../../db/migration-state";
import { wooImport } from "../../modules/woo-import/admin";
import { couponsAdmin } from "../../modules/coupons/admin";
import { couponImport } from "../../modules/coupons/import";
import { socialLoginAdmin } from "../../modules/social-login/admin";
import { productFeedAdmin } from "../../modules/product-feed/admin";
import { ga4Admin } from "../../modules/ga4/admin";
import { receiptAdmin } from "../../modules/receipt/admin";
import { deliveryAdmin } from "../../modules/delivery-time/admin";
import { labelsAdmin } from "../../modules/shipping-labels/admin";
import { tryonAdmin } from "../../modules/store-tryon/admin";
import { inquiriesAdmin } from "../../modules/inquiries/admin";
import { pagesAdmin } from "../../modules/pages/admin";
import { blogAdmin } from "../../modules/blog/admin";

/**
 * 同梱モジュールの ON/OFF（shops.settings.modules）。/admin/shops/:shopId/modules
 * モジュールの画面は ON のときだけ開ける（各モジュールの側でも確かめる）。
 */
export const modules = new Hono<AppEnv>();

/** マイグレーションが当たっているモジュールだけ（当たる前は一覧に出さず、ON にもできない。CLAUDE.md §11） */
async function availableModules(c: AdminContext): Promise<ModuleDef[]> {
  const deps = { db: owner(c).db, cache: c.get("adapters").cache };
  const ok = await Promise.all(MODULES.map((m) => (m.migration ? migrated(deps, m.migration) : true)));
  return MODULES.filter((_, i) => ok[i]);
}

modules.get("/:shopId/modules", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "settings");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const saved = c.req.query("flash") === "saved";
  const available = await availableModules(c);
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("modules.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("modules.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "modules" }}>
      <PageHead title={t("modules.title")} sub={t("modules.intro")} />
      {saved ? <p class="notice">{t("modules.saved")}</p> : null}
      <div class="grid">
        {available.map((m) => {
          const on = moduleEnabled(shop.settings, m.id);
          return (
            <section class="card" data-module={m.id}>
              <div class="card-head">
                <strong>{t(m.name)}</strong>
                <span class={`status ${on ? "on" : "off"}`}>{on ? t("modules.on") : t("modules.off")}</span>
              </div>
              <p class="muted">{t(m.description)}</p>
              <div class="card-foot">
                <form method="post" action={`/admin/shops/${shop.id}/modules/${m.id}/enabled`}>
                  <input type="hidden" name="enabled" value={on ? "off" : "on"} />
                  <button type="submit" class={on ? "secondary small" : "small"}>
                    {on ? t("modules.disable") : t("modules.enable")}
                  </button>
                </form>
                {on && m.adminPath ? (
                  <a class="btn secondary small" href={`/admin/shops/${shop.id}/modules/${m.adminPath}`}>
                    {t("modules.open")}
                  </a>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </AdminLayout>,
  );
});

/**
 * ON/OFF の切り替え。モジュールの画面（/modules/<adminPath>）とは別の URL にする。
 * 以前は /modules/<id> に POST していたため、id と adminPath が同じ「coupons」で、クーポンの作成（POST /modules/coupons）と衝突し、
 * OFF のまま切り替えられずに 404 になっていた（2026-10-16 の本番確認）。各モジュールの画面より先に登録する
 */
modules.post("/:shopId/modules/:moduleId/enabled", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "settings");
  const mod = (await availableModules(c)).find((m) => m.id === param(c, "moduleId"));
  if (!shop || !mod) return c.text(t("shop.not_found"), 404);
  const f = await formFields(c);
  const current = (shop.settings ?? {})["modules"];
  const mods = { ...(current && typeof current === "object" ? (current as Record<string, unknown>) : {}), [mod.id]: f.enabled === "on" };
  try {
    await owner(c).db.from<ShopRow>("shops").update({ settings: { ...(shop.settings ?? {}), modules: mods } }, { id: shopId });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}/modules?flash=generic`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shopId}/modules?flash=saved`);
});

// モジュールの画面（ON/OFF の切り替えより後に登録する）
modules.route("/:shopId/modules/woo-import", wooImport);
modules.route("/:shopId/modules/coupons/import", couponImport);
modules.route("/:shopId/modules/coupons", couponsAdmin);
modules.route("/:shopId/modules/line-login", socialLoginAdmin("line"));
modules.route("/:shopId/modules/google-login", socialLoginAdmin("google"));
modules.route("/:shopId/modules/product-feed", productFeedAdmin);
modules.route("/:shopId/modules/receipt", receiptAdmin);
modules.route("/:shopId/modules/delivery-time", deliveryAdmin);
modules.route("/:shopId/modules/shipping-labels", labelsAdmin);
modules.route("/:shopId/modules/store-tryon", tryonAdmin);
modules.route("/:shopId/modules/ga4", ga4Admin);
modules.route("/:shopId/modules/inquiries", inquiriesAdmin);
modules.route("/:shopId/modules/pages", pagesAdmin);
modules.route("/:shopId/modules/blog", blogAdmin);
