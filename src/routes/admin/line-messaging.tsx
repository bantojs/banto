import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { t } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { sealSecret } from "../../members/secret-box";
import { LINE_SECRET_PURPOSE } from "../../plugins/line_token";
import { AdminLayout, PageHead } from "./layout";
import { formFields, owner, param, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";

/**
 * ショップの LINE 公式アカウント（Messaging API のチャネルアクセストークン、0021、docs/line.md）。
 *   GET  /admin/shops/:shopId/line-messaging          設定済みかどうか（トークンは二度と出さない）
 *   POST /admin/shops/:shopId/line-messaging          保存（サイトの秘密から作った鍵で暗号化してから送る）
 *   POST /admin/shops/:shopId/line-messaging/delete   消す
 * 同梱プラグイン「LINE 通知」「LINE で購入者に知らせる」が使う。CLAUDE.md §1-5 の例外（人間の決定 2026-10-17）。
 */
export const lineMessaging = new Hono<AppEnv>();

lineMessaging.get("/:shopId/line-messaging", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "integrations");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const row = await owner(c).db.from<{ updated_at: string }>("shop_secret_boxes").selectOne("updated_at", { eq: { shop_id: shop.id, purpose: LINE_SECRET_PURPOSE } });
  const base = `/admin/shops/${shop.id}/line-messaging`;
  const flash = c.req.query("flash");
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("linemsg.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("plugins.title"), href: `/admin/shops/${shop.id}/plugins` }, { label: t("linemsg.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "plugins" }}>
      <PageHead title={t("linemsg.title")} />
      {flash === "saved" ? <p class="notice">{t("linemsg.saved")}</p> : null}
      {flash === "deleted" ? <p class="notice">{t("linemsg.deleted")}</p> : null}
      {flash === "invalid" ? <p class="error">{t("linemsg.invalid")}</p> : null}
      <p>{t("linemsg.intro")}</p>
      <p class={row ? "notice" : "muted"}>{row ? `${t("linemsg.status_set")}（${formatDateTime(row.updated_at)}）` : t("linemsg.status_missing")}</p>
      <ol class="muted">
        <li>{t("linemsg.step_channel")}</li>
        <li>{t("linemsg.step_token")}</li>
        <li>{t("linemsg.step_provider")}</li>
        <li>{t("linemsg.step_plugin")}</li>
      </ol>
      <form method="post" action={base}>
        <label for="token">{t("linemsg.token")}</label>
        <input id="token" name="token" type="password" maxlength={500} autocomplete="new-password" required style="width:100%;max-width:36rem" />
        <p class="muted">{t("linemsg.token_note")}</p>
        <p>
          <button type="submit">{t("linemsg.save")}</button>
        </p>
      </form>
      {row ? (
        <form method="post" action={`${base}/delete`}>
          <button type="submit">{t("linemsg.delete")}</button>
        </form>
      ) : null}
    </AdminLayout>,
  );
});

lineMessaging.post("/:shopId/line-messaging", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "integrations");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const base = `/admin/shops/${shop.id}/line-messaging`;
  const token = ((await formFields(c)).token ?? "").trim();
  const secret = c.get("sessionSecret");
  // チャネルアクセストークン（長期）は英数字と + / = の長い文字列
  if (!secret || token.length < 20 || token.length > 500 || !/^[A-Za-z0-9+/=._-]+$/.test(token)) return c.redirect(`${base}?flash=invalid`);
  const box = await sealSecret(secret, shop.id, LINE_SECRET_PURPOSE, token);
  try {
    await owner(c).db.rpc("shop_secret_save", { p_shop_id: shop.id, p_purpose: LINE_SECRET_PURPOSE, p_secret_box: box });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${base}?flash=invalid`);
    throw e;
  }
  return c.redirect(`${base}?flash=saved`);
});

lineMessaging.post("/:shopId/line-messaging/delete", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "integrations");
  if (!shop) return c.text(t("shop.not_found"), 404);
  await owner(c).db.rpc("shop_secret_save", { p_shop_id: shop.id, p_purpose: LINE_SECRET_PURPOSE, p_secret_box: null });
  return c.redirect(`/admin/shops/${shop.id}/line-messaging?flash=deleted`);
});
