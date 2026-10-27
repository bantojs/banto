import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { BUNDLED_PLUGINS, bundledPluginUrl, findBundledPlugin } from "../../plugins";
import { t, tf } from "../../i18n";
import { mailTransportName } from "../../mail/send";
import { AdminLayout, PageHead } from "./layout";
import { publicBaseUrl } from "../common";
import { owner, param, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";

/**
 * 同梱プラグイン（/admin/shops/:shopId/plugins）。有効化 = hooks の送信先行（URL は内部マーカー）を作る。
 * 設定・無効化・削除は送信先の画面（/hooks/:endpointId）で行う。
 */
export const plugins = new Hono<AppEnv>();

interface EndpointRow {
  id: string;
  url: string;
  enabled: boolean;
}

plugins.get("/:shopId/plugins", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "integrations");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const rows = await db.from<EndpointRow>("hook_endpoints").select("id,url,enabled", { eq: { shop_id: shopId } });
  const byUrl = new Map(rows.map((r) => [r.url, r]));
  const cfg = c.get("adapters").config;
  const base = publicBaseUrl(c);
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("plugins.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("plugins.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "plugins" }}>
      <PageHead title={t("plugins.title")} sub={t("plugins.intro")}>
        <a class="btn secondary" href={`/admin/shops/${shop.id}/hooks`}>
          {t("hooks.title")}
        </a>
      </PageHead>
      <p class="muted">
        <a href={`/admin/shops/${shop.id}/line-messaging`}>{t("linemsg.title")}</a> {t("linemsg.link_hint")}
      </p>
      {c.req.query("flash") === "generic" ? <p class="error">{t("error.generic")}</p> : null}
      {BUNDLED_PLUGINS.map((p) => {
        const row = byUrl.get(bundledPluginUrl(p.id));
        const missing = (typeof p.requiredSecrets === "function" ? p.requiredSecrets(cfg) : p.requiredSecrets).filter((name) => !cfg.get(name));
        const malformed = Object.entries(p.secretFormats ?? {})
          .filter(([name, f]) => cfg.get(name) && !f.pattern.test(cfg.get(name)!))
          .map(([name, f]) => ({ name, hint: f.hint }));
        return (
          <section class="step" data-state={row?.enabled ? "ok" : undefined}>
            <h2>
              {p.manifest.name}
              {row?.enabled ? <span class="badge ok">{t("hooks.enabled")}</span> : <span class="badge">{t("plugins.off")}</span>}
            </h2>
            <p>{p.manifest.description}</p>
            {p.id === "email_resend" ? <p class="muted">{tf("plugins.mail_transport", { name: mailTransportName(cfg) ?? `${cfg.get("MAIL_TRANSPORT")} (?)` })}</p> : null}
            {missing.length > 0 ? (
              <p class="notice">
                {t("plugins.missing_secrets")} <code>{missing.join(", ")}</code>
                <pre>{missing.map((m) => `npx wrangler secret put ${m}`).join("\n")}</pre>
              </p>
            ) : null}
            {malformed.length > 0 ? (
              <p class="error">
                {t("plugins.malformed_secrets")}
                <ul>
                  {malformed.map((m) => (
                    <li>
                      <code>{m.name}</code>: {m.hint}
                    </li>
                  ))}
                </ul>
              </p>
            ) : null}
            {p.webhook ? (
              <div class="muted">
                <p>
                  {t("plugins.webhook_url")} <code>{`${base}${p.webhook.path}`}</code>
                </p>
                <p>
                  {t("plugins.webhook_events")} <code>{p.webhook.events.join(", ")}</code>
                </p>
                <p>{p.webhook.where}</p>
              </div>
            ) : null}
            {row ? (
              <p>
                <a href={`/admin/shops/${shop.id}/hooks/${row.id}`}>{t("plugins.configure")}</a>
              </p>
            ) : (
              <form method="post" action={`/admin/shops/${shop.id}/plugins/${p.id}/enable`}>
                <button type="submit">{t("plugins.enable")}</button>
              </form>
            )}
          </section>
        );
      })}
    </AdminLayout>,
  );
});

plugins.post("/:shopId/plugins/:pluginId/enable", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "integrations");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const plugin = findBundledPlugin(param(c, "pluginId"));
  if (!plugin) return c.text(t("hooks.not_found"), 404);
  const url = bundledPluginUrl(plugin.id);
  const existing = await db.from<EndpointRow>("hook_endpoints").selectOne("id,url,enabled", { eq: { shop_id: shopId, url } });
  try {
    if (existing) {
      await db.from<EndpointRow>("hook_endpoints").update({ enabled: true }, { id: existing.id });
      return c.redirect(`/admin/shops/${shopId}/hooks/${existing.id}?flash=saved`);
    }
    const [created] = await db.from<EndpointRow>("hook_endpoints").insert({
      shop_id: shopId,
      name: plugin.manifest.name,
      url,
      events: plugin.manifest.events,
      enabled: true,
      manifest: plugin.manifest,
      settings: {},
    } as unknown as Partial<EndpointRow>);
    return c.redirect(`/admin/shops/${shopId}/hooks/${created!.id}?flash=saved`);
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}/plugins?flash=generic`);
    throw e;
  }
});
