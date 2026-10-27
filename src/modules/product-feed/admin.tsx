import { Hono } from "hono";
import type { AppEnv } from "../../app";
import type { ShopRow } from "../../db/types";
import { t, tf } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { AdminLayout, PageHead } from "../../routes/admin/layout";
import { mediaBaseUrl, owner, param, publicBaseUrl, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { loadShop } from "../../routes/admin/shops";
import { StorefrontData, toPublicShop } from "../../storefront/data";
import { shopHome } from "../../storefront/urls";
import { moduleEnabled } from "../registry";
import { FEED_MODULE, generateFeed, readFeedMeta } from "./job";

/**
 * 同梱モジュール「商品フィード」の画面（docs/product-feed.md）。
 *   GET  /admin/shops/:shopId/modules/product-feed           フィードの URL・最後に作った時刻・載らなかった件数
 *   POST /admin/shops/:shopId/modules/product-feed/generate  今すぐ作る（owner の JWT で公開中の商品だけを読む）
 */
export const productFeedAdmin = new Hono<AppEnv>();

async function scope(c: AdminContext): Promise<ShopRow | null> {
  const shop = await loadShop(c, param(c, "shopId"), "marketing");
  return shop && moduleEnabled(shop.settings, FEED_MODULE) ? shop : null;
}

export const feedUrl = (base: string, shop: { slug: string; domain?: string | null }) => `${shopHome(base, shop)}/feed/products.xml`;

productFeedAdmin.get("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const meta = await readFeedMeta(c.get("adapters").storage, shop.id);
  const flash = c.req.query("flash");
  const baseMissing = !c.get("adapters").config.get("PUBLIC_BASE_URL") && !shop.domain;
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("feed.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("modules.title"), href: `/admin/shops/${shop.id}/modules` }, { label: t("feed.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "modules" }}>
      <PageHead title={t("feed.title")} />
      {flash === "generated" ? <p class="notice">{t("feed.generated")}</p> : null}
      {flash === "started" ? <p class="notice">{t("feed.started")}</p> : null}
      {flash === "unpublished" ? <p class="error">{t("feed.unpublished")}</p> : null}
      <p>{t("feed.intro")}</p>
      <h2>{t("feed.url")}</h2>
      <p>
        <code>{feedUrl(publicBaseUrl(c), shop)}</code>
      </p>
      {baseMissing ? <p class="error">{t("feed.base_missing")}</p> : null}
      <p class="muted">
        {meta ? tf("feed.status", { time: formatDateTime(meta.generated_at), items: meta.items, no_image: meta.skipped.no_image, no_price: meta.skipped.no_price }) : t("feed.not_yet")}
      </p>
      <form method="post" action={`/admin/shops/${shop.id}/modules/product-feed/generate`}>
        <button type="submit">{t("feed.generate")}</button>
      </form>
      <h2>{t("feed.register_title")}</h2>
      <ul>
        <li>{t("feed.register_google")}</li>
        <li>{t("feed.register_meta")}</li>
      </ul>
      <p class="muted">{t("feed.note")}</p>
    </AdminLayout>,
  );
});

productFeedAdmin.post("/generate", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const base = `/admin/shops/${shop.id}/modules/product-feed`;
  if (!shop.published) return c.redirect(`${base}?flash=unpublished`);
  // 管理画面は owner の JWT で読む（anon の経路は使わない）。公開中の商品だけを載せる（feedCatalog が絞る）
  const sf = new StorefrontData(owner(c).db, c.get("adapters").cache);
  const r = await generateFeed(sf, c.get("adapters").storage, toPublicShop(shop), { publicBaseUrl: publicBaseUrl(c), mediaBaseUrl: mediaBaseUrl(c) });
  // 商品が多いショップは 1 回では作り終えない。続きは Cron（5 分ごと）が作る
  return c.redirect(`${base}?flash=${r === "in_progress" ? "started" : "generated"}`);
});
