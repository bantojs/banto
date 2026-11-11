import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { ShopRow } from "../../db/types";
import { t, tf } from "../../i18n";
import { AdminLayout, PageHead } from "../../routes/admin/layout";
import { formFields, owner, param, publicBaseUrl, type AdminContext } from "../../routes/admin/context";
import { shopOrigin } from "../../storefront/urls";
import { requireOwner } from "../../routes/admin/auth";
import { loadShop } from "../../routes/admin/shops";
import { sealSecret } from "../../members/secret-box";
import { moduleEnabled } from "../registry";
import { PROVIDER_NAMES, callbackPath, providerClientId, providerModule, secretPurpose, type Provider } from "./providers";
import { NotSavedNotice, failCode, updateShop } from "../../routes/admin/shop-save";
import { can } from "../../routes/admin/access";
import { migrated } from "../../db/migration-state";

/** 提供元の保存し直しで、ほかの設定（友だち追加）を DB が残す */
const OAUTH_KEEP_SETTINGS_MIGRATION = "0131_oauth_client_keep_settings";

/**
 * 同梱モジュール「LINE でログイン」「Google でログイン」の設定画面（ショップごと）。
 *   GET  /admin/shops/:shopId/modules/line-login（google-login）  設定
 *   POST .../                                                    保存（シークレットは暗号化してから送る）
 *   POST .../delete                                              設定を消す
 * シークレットはこの Worker がサイトの秘密から作った鍵で暗号化し、暗号文だけを shop_oauth_client_save（owner の JWT）で保存する。
 * 画面にシークレットを出さない（「設定済み」とだけ出す）。CLAUDE.md §1-5 の例外（docs/knowledge/10-members-identity.md §14）。
 */
function botPrompt(shop: ShopRow): "" | "normal" | "aggressive" {
  const v = ((shop.settings ?? {})["oauth"] as Record<string, Record<string, unknown>> | undefined)?.["line"]?.["bot_prompt"];
  return v === "normal" || v === "aggressive" ? v : "";
}

export function socialLoginAdmin(p: Provider): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const name = PROVIDER_NAMES[p];

  async function scope(c: AdminContext): Promise<ShopRow | null> {
    const shop = await loadShop(c, param(c, "shopId"), "integrations");
    if (!shop || !moduleEnabled(shop.settings, providerModule(p))) return null;
    return shop;
  }

  app.get("/", requireOwner, async (c: AdminContext) => {
    const shop = await scope(c);
    if (!shop) return c.notFound();
    const clientId = providerClientId(shop.settings, p);
    const flash = c.req.query("flash");
    const base = `/admin/shops/${shop.id}/modules/${p}-login`;
    return c.html(
      <AdminLayout title={`${shop.name} · ${tf("social.title", { name })}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("settings.tab_members"), href: `/admin/shops/${shop.id}/settings/members` }, { label: name }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "settings", here: "settings-members" }}>
        <PageHead title={tf("social.title", { name })} />
        {flash === "saved" ? <p class="notice">{t("social.saved")}</p> : null}
        {flash === "deleted" ? <p class="notice">{t("social.deleted")}</p> : null}
        <NotSavedNotice flash={flash} />
        {c.req.query("error") === "invalid" ? <p class="error">{t("social.invalid")}</p> : null}
        {(shop.settings ?? {})["members_enabled"] !== true ? (
          <p class="error">
            {t("social.members_off")} <a href={`/admin/shops/${shop.id}/settings/members`}>{t("shop.members_open_settings")}</a>
          </p>
        ) : null}
        <p>{tf("social.intro", { name })}</p>
        <p class={clientId ? "notice" : "muted"}>{t(clientId ? "social.status_ready" : "social.status_missing")}</p>
        <h2>{tf("social.callback", { name })}</h2>
        <p>
          <code>{`${shopOrigin(publicBaseUrl(c), shop)}${callbackPath(p)}`}</code>
        </p>
        {shop.domain ? <p class="muted">{t("social.callback_domain")}</p> : null}
        <p class="muted">{t(p === "line" ? "social.steps_line" : "social.steps_google")}</p>
        <form method="post" action={base}>
          <label for="client_id">{t(p === "line" ? "social.client_id_line" : "social.client_id_google")}</label>
          <input id="client_id" name="client_id" value={clientId ?? ""} required maxlength={200} autocomplete="off" spellcheck={false} style="width:100%;max-width:36rem" />
          <label for="client_secret">{t(p === "line" ? "social.client_secret_line" : "social.client_secret_google")}</label>
          <input id="client_secret" name="client_secret" type="password" maxlength={500} autocomplete="new-password" placeholder={clientId ? t("social.secret_set") : ""} required={!clientId} style="width:100%;max-width:36rem" />
          <p class="muted">{t("social.secret_note")}</p>
          <p>
            <button type="submit">{t("social.save")}</button>
          </p>
        </form>
        {p === "line" && clientId && can(c.get("shopAccess"), "settings") ? (
          <form method="post" action={`${base}/bot-prompt`}>
            <label for="bot_prompt">{t("social.bot_prompt")}</label>
            <select id="bot_prompt" name="bot_prompt">
              {(["", "normal", "aggressive"] as const).map((v) => (
                <option value={v} selected={botPrompt(shop) === v}>
                  {t(v ? `social.bot_prompt_${v}` : "social.bot_prompt_none")}
                </option>
              ))}
            </select>
            <p class="muted">
              <a href={`/admin/shops/${shop.id}/line-messaging`}>{t("linemsg.title")}</a>
            </p>
            <p>
              <button type="submit">{t("social.save")}</button>
            </p>
          </form>
        ) : null}
        {clientId ? (
          <form method="post" action={`${base}/delete`}>
            <button type="submit">{t("social.delete")}</button>
          </form>
        ) : null}
      </AdminLayout>,
    );
  });

  app.post("/", requireOwner, async (c: AdminContext) => {
    const shop = await scope(c);
    if (!shop) return c.notFound();
    const base = `/admin/shops/${shop.id}/modules/${p}-login`;
    const f = await formFields(c);
    const clientId = (f.client_id ?? "").trim();
    const clientSecret = (f.client_secret ?? "").trim();
    const siteSecret = c.get("sessionSecret");
    if (!siteSecret || !clientId || clientId.length > 200 || /\s/.test(clientId) || clientSecret.length > 500) return c.redirect(`${base}?error=invalid`);
    const box = clientSecret ? await sealSecret(siteSecret, shop.id, secretPurpose(p), clientSecret) : null;
    try {
      await owner(c).db.rpc("shop_oauth_client_save", { p_shop_id: shop.id, p_provider: p, p_client_id: clientId, p_secret_box: box });
      // 0131 より前の shop_oauth_client_save は settings.oauth.<provider> を { client_id } で置き換えるので、友だち追加の設定を戻す
      // （0131 からは DB が残す）。戻すのは shops の行の更新なので settings の項目も要る（RLS、0024）
      const bot = p === "line" && can(c.get("shopAccess"), "settings") ? botPrompt(shop) : "";
      if (bot && !(await migrated({ db: owner(c).db, cache: c.get("adapters").cache }, OAUTH_KEEP_SETTINGS_MIGRATION))) {
        const fresh = await loadShop(c, shop.id, "integrations");
        const settings = fresh?.settings ?? {};
        const oauth = (settings["oauth"] ?? {}) as Record<string, Record<string, unknown>>;
        await updateShop(c, shop.id, { settings: { ...settings, oauth: { ...oauth, line: { ...(oauth["line"] ?? {}), bot_prompt: bot } } } });
      }
    } catch (e) {
      if (e instanceof DbError) return c.redirect(`${base}?error=invalid`);
      throw e;
    }
    return c.redirect(`${base}?flash=saved`);
  });

  // LINE: ログインの画面で公式アカウントの友だち追加を促す（settings.oauth.line.bot_prompt。0021）
  app.post("/bot-prompt", requireOwner, async (c: AdminContext) => {
    const shop = await scope(c);
    if (!shop || p !== "line") return c.notFound();
    const v = (await formFields(c)).bot_prompt;
    const settings = shop.settings ?? {};
    const oauth = (settings["oauth"] ?? {}) as Record<string, Record<string, unknown>>;
    const line = { ...(oauth["line"] ?? {}) };
    if (v === "normal" || v === "aggressive") line["bot_prompt"] = v;
    else delete line["bot_prompt"];
    try {
      await updateShop(c, shop.id, { settings: { ...settings, oauth: { ...oauth, line } } });
    } catch (e) {
      if (e instanceof DbError) return c.redirect(`/admin/shops/${shop.id}/modules/line-login?flash=${failCode(e, "generic")}`);
      throw e;
    }
    return c.redirect(`/admin/shops/${shop.id}/modules/line-login?flash=saved`);
  });

  app.post("/delete", requireOwner, async (c: AdminContext) => {
    const shop = await scope(c);
    if (!shop) return c.notFound();
    await owner(c).db.rpc("shop_oauth_client_delete", { p_shop_id: shop.id, p_provider: p });
    return c.redirect(`/admin/shops/${shop.id}/modules/${p}-login?flash=deleted`);
  });

  return app;
}
