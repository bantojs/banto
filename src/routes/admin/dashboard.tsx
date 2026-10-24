import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { pendingMigrations } from "../../db/migrations";
import { t } from "../../i18n";
import { BANTO_VERSION } from "../../version";
import { AdminLayout } from "./layout";
import { SLUG_RE, formFields, owner } from "./context";
import { DbError } from "../../db/client";
import { planLimitOf } from "../../plan/limits";
import type { ShopRow } from "../../db/types";
import { requireOwner } from "./auth";
import { isOrgAdmin, myShops, requireOrgAdmin } from "./access";
import { fetchLatestRelease, isNewer } from "../../updates/releases";

export const dashboard = new Hono<AppEnv>();

dashboard.get("/", requireOwner, async (c) => {
  const { db, session } = owner(c);
  const [shops, admin, stores, migrations, latest] = await Promise.all([
    myShops(c),
    isOrgAdmin(c),
    db.rpc<{ id: string; name: string; perms: string[] }[]>("banto_my_stores", {}),
    db.from<{ version: string }>("banto_migrations").select("version"),
    fetchLatestRelease({ fetch: c.get("deps").fetch, cache: c.get("adapters").cache }),
  ]);
  const pending = pendingMigrations(migrations.map((m) => m.version));
  const updateAvailable = latest && isNewer(BANTO_VERSION, latest.version) ? latest : null;
  // 直近 30 日の売上（ショップごと、reports の項目を持つショップだけ）
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const until = new Date(Date.now() + 86400_000).toISOString();
  const summaries = new Map<string, { orders: number; revenue_jpy: number }>();
  await Promise.all(
    shops
      .filter((s) => s.perms.includes("reports"))
      .map(async (s) => {
        const r = await db.rpc<{ total: { orders: number; revenue_jpy: number } }>("sales_summary", { p_shop_id: s.id, p_from: since, p_to: until, p_group_by: "month" });
        summaries.set(s.id, r.total);
      }),
  );

  const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
  const flash = c.req.query("flash");
  return c.html(
    <AdminLayout title={t("dashboard.title")} nav user={session.email}>
      <div class="page-head">
        <div>
          <h1>{t("dashboard.title")}</h1>
          <p class="muted">
            {t("dashboard.version")}: v{BANTO_VERSION} · {session.email}
          </p>
        </div>
        {admin ? (
          <div class="actions">
            <a class="btn secondary" href="/admin/org">
              {t("org.title")}
            </a>
            <a class="btn" href="#add-shop">
              {t("dashboard.add_shop")}
            </a>
          </div>
        ) : null}
      </div>
      {flash === "stripe_state_invalid" ? <p class="error">{t("stripe.state_invalid")}</p> : null}
      {flash === "forbidden" ? <p class="error">{t("access.forbidden")}</p> : null}
      {admin && pending.length > 0 ? (
        <p class="notice">
          {t("dashboard.pending_migrations")} ({pending.join(", ")}) <a href="/admin/update">{t("update.title")}</a>
        </p>
      ) : null}
      {admin && updateAvailable ? (
        <p class="notice">
          {t("dashboard.update_available")} v{updateAvailable.version} — <a href={updateAvailable.url} target="_blank" rel="noopener">{t("dashboard.release_notes")}</a>
          {" · "}
          <a href="https://github.com/bantojs/banto/blob/main/docs/upgrade.md" target="_blank" rel="noopener">docs/upgrade.md</a>
        </p>
      ) : null}
      {admin ? (
        <div class="quick">
          <a class="btn secondary" href="/admin/stores">
            {t("stores.title")}
          </a>
          <a class="btn secondary" href="/admin/site">
            {t("site.title")}
          </a>
        </div>
      ) : null}

      <h2>{t("dashboard.shops")}</h2>
      {shops.length === 0 && stores.length > 0 && !admin ? null : shops.length === 0 ? (
        <div class="empty">
          {admin ? (
            <>
              {t("dashboard.no_shops")} <a href="/admin/setup">{t("setup.step.shop")}</a>
            </>
          ) : (
            t("access.no_shops")
          )}
        </div>
      ) : (
        <div class="grid">
          {shops.map((s) => {
            const sum = summaries.get(s.id);
            return (
              <div class="card">
                <div class="card-head">
                  <div class="card-title">
                    <span class="avatar" aria-hidden="true">
                      {[...s.name][0] ?? "?"}
                    </span>
                    <div style="min-width:0">
                      <a href={`/admin/shops/${s.id}`}>{s.name}</a>
                      <div class="muted">
                        <code>{s.slug}</code>
                      </div>
                    </div>
                  </div>
                  <span class={s.published ? "status on" : "status"}>{s.published ? t("dashboard.published") : t("dashboard.unpublished")}</span>
                </div>
                <div>
                  <div class="muted">{t("dashboard.last30")}</div>
                  {sum ? (
                    <div class="metric">
                      {yen(sum.revenue_jpy)}
                      <small>{sum.orders}件</small>
                    </div>
                  ) : (
                    <div class="metric">-</div>
                  )}
                </div>
                <div class="card-links">
                  {(
                    [
                      ["catalog", `/admin/shops/${s.id}/products`, t("product.list")],
                      ["orders", `/admin/shops/${s.id}/orders`, t("order.list")],
                      ["integrations", `/admin/shops/${s.id}/tokens`, t("tokens.title")],
                    ] as const
                  )
                    .filter(([perm]) => s.perms.includes(perm))
                    .map(([, href, label]) => (
                      <a href={href}>{label}</a>
                    ))}
                  <a href={`/admin/shops/${s.id}`}>{t("dashboard.settings")}</a>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {stores.length > 0 ? (
        <>
          <h2>{t("stores.mine")}</h2>
          <div class="grid">
            {stores.map((st) => (
              <div class="card">
                <div class="card-title">
                  <span class="avatar" aria-hidden="true">
                    {[...st.name][0] ?? "?"}
                  </span>
                  <strong>{st.name}</strong>
                </div>
                <div class="card-links">
                  {st.perms.includes("tryon") ? <a href={`/admin/stores/${st.id}/requests`}>{t("tryon.requests")}</a> : null}
                  {st.perms.includes("hours") ? <a href={`/admin/stores/${st.id}`}>{t("tryon.store_hours")}</a> : null}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {admin ? (
        <>
          <h2 id="add-shop">{t("dashboard.add_shop")}</h2>
          {flash === "invalid_slug" ? <p class="error">{t("setup.shop.invalid_slug")}</p> : null}
          {flash === "slug_taken" ? <p class="error">{t("dashboard.slug_taken")}</p> : null}
          {flash === "plan_limit" ? <p class="error">{t("plan.limit_shops")}</p> : null}
          <form method="post" action="/admin/shops" class="card" style="max-width:36rem">
            <label for="name" style="margin-top:0">
              {t("setup.shop.name")}
            </label>
            <input id="name" type="text" name="name" required maxlength={200} />
            <label for="slug">{t("setup.shop.slug")}</label>
            <input id="slug" type="text" name="slug" required pattern="[a-z0-9][a-z0-9-]{0,62}" />
            <p style="margin-bottom:0">
              <button type="submit">{t("setup.shop.submit")}</button>
            </p>
          </form>
          <p class="notice">{t("dashboard.signup_warning")}</p>
          {!c.get("adapters").config.get("SESSION_SECRET") ? <p class="notice">{t("dashboard.session_secret_warning")}</p> : null}
        </>
      ) : null}
    </AdminLayout>,
  );
});

/** 2店舗目以降の追加（1店舗目はセットアップウィザード） */
dashboard.post("/shops", requireOwner, requireOrgAdmin, async (c) => {
  const { db, session } = owner(c);
  const f = await formFields(c);
  const name = (f.name ?? "").trim();
  const slug = (f.slug ?? "").trim();
  if (!name || name.length > 200) return c.redirect("/admin?flash=generic");
  if (!SLUG_RE.test(slug)) return c.redirect("/admin?flash=invalid_slug");
  try {
    const [shop] = await db.from<ShopRow>("shops").insert({ owner_id: session.user_id, slug, name });
    return c.redirect(`/admin/shops/${shop!.id}?flash=saved`);
  } catch (e) {
    if (e instanceof DbError && e.status === 409) return c.redirect("/admin?flash=slug_taken");
    if (e instanceof DbError && planLimitOf(e)) return c.redirect("/admin?flash=plan_limit");
    if (e instanceof DbError) return c.redirect("/admin?flash=generic");
    throw e;
  }
});
