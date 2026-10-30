import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { t } from "../../i18n";
import { AdminLayout, PageHead } from "./layout";
import { formFields, owner, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { requireOrgAdmin } from "./access";
import { PLAN_LIMIT_KINDS, type PlanUsage } from "../../plan/limits";

/**
 * サイトの設定（/admin/site、0038）: このデプロイ全体に効く設定。組織の owner / admin だけ（/admin/update と同じ）。
 * Cloudflare Workers のプラン（裏で動く処理が 1 回に進める量）の切り替えと、プランの上限（0052）の表示。書き込みは site_settings_set（鍵と値を SQL で確かめる）。
 * プランの上限は読み取り専用（書けるのは service_role か直接の SQL だけ。docs/knowledge/02-decisions.md 2026-10-23）。
 */
export const site = new Hono<AppEnv>();

site.get("/site", requireOwner, requireOrgAdmin, async (c: AdminContext) => {
  const { db } = owner(c);
  const row = await db.from<{ settings: Record<string, unknown> }>("banto_site_settings").selectOne("settings");
  const plan = row?.settings["workers_plan"] === "paid" ? "paid" : "free";
  // プランの上限（0052）。読み取り専用（書けるのは service_role か直接の SQL だけ）
  const usage = await db.rpc<PlanUsage | null>("banto_plan_usage", {});
  const KIND_LABEL = { shops: "plan.kind.shops", products: "plan.kind.products", customers: "plan.kind.customers", members: "plan.kind.members", mail_per_day: "plan.kind.mail_per_day", theme_versions: "plan.kind.theme_versions", pages: "plan.kind.pages", articles: "plan.kind.articles" } as const;
  return c.html(
    <AdminLayout title={t("site.title")} nav crumbs={[{ label: t("site.title") }]}>
      <PageHead title={t("site.title")} />
      <p>{t("site.intro")}</p>
      {c.req.query("flash") === "saved" ? <p class="notice">{t("site.saved")}</p> : null}
      <form method="post" action="/admin/site">
        <fieldset style="border:0;padding:0">
          <legend>
            <strong>{t("site.plan")}</strong>
          </legend>
          <p>
            <label>
              <input type="radio" name="workers_plan" value="free" checked={plan === "free"} /> {t("site.plan_free")}
            </label>
          </p>
          <p>
            <label>
              <input type="radio" name="workers_plan" value="paid" checked={plan === "paid"} /> {t("site.plan_paid")}
            </label>
          </p>
        </fieldset>
        <p class="muted">{t("site.plan_hint")}</p>
        <p>
          <button type="submit">{t("site.save")}</button>
        </p>
      </form>

      <h2>{t("plan.title")}</h2>
      <p>{t("plan.intro")}</p>
      {usage ? (
        <table>
          <thead>
            <tr>
              <th>{t("plan.kind")}</th>
              <th>{t("plan.usage")}</th>
              <th>{t("plan.limit")}</th>
            </tr>
          </thead>
          <tbody>
            {PLAN_LIMIT_KINDS.map((k) => (
              <tr>
                <td>{t(KIND_LABEL[k])}</td>
                <td>{usage.usage[k] ?? 0}</td>
                <td>{usage.limits[k] == null ? t("plan.unlimited") : usage.limits[k]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p class="muted">{t("plan.howto")}</p>
    </AdminLayout>,
  );
});

site.post("/site", requireOwner, requireOrgAdmin, async (c: AdminContext) => {
  const f = await formFields(c);
  const plan = f.workers_plan === "paid" ? "paid" : "free";
  await owner(c).db.rpc("site_settings_set", { p_key: "workers_plan", p_value: plan });
  return c.redirect("/admin/site?flash=saved");
});
