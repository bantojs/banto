import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { pendingMigrations } from "../../db/migrations";
import { t } from "../../i18n";
import { BANTO_VERSION } from "../../version";
import { AdminLayout, PageHead } from "./layout";
import { owner, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { requireOrgAdmin } from "./access";
import { isMigrateStep, MigrateForm, migrateStepJson, runMigrationFromForm } from "./migrate";
import { projectRefFromUrl } from "../../db/migrate-api";

/** アップデート（/admin/update）: 未適用マイグレーションの検出と適用（docs/upgrade.md） */
export const update = new Hono<AppEnv>();

async function appliedVersions(c: AdminContext): Promise<string[]> {
  const { db } = owner(c);
  const rows = await db.from<{ version: string }>("banto_migrations").select("version");
  return rows.map((r) => r.version);
}

function Page(props: { pending: string[]; applied: string[]; error?: string | null; done?: string[]; projectRef: string | null }) {
  return (
    <AdminLayout title={t("update.title")} nav crumbs={[{ label: t("update.title") }]}>
      <PageHead title={t("update.title")} />
      <p>
        {t("dashboard.version")}: v{BANTO_VERSION}
      </p>
      {props.done && props.done.length > 0 ? (
        <p class="notice">
          {t("migrate.done")} {props.done.join(", ")}
          {props.pending.length > 0 ? ` ${t("migrate.more")}` : null}
        </p>
      ) : null}
      {props.pending.length === 0 ? (
        <p>{t("update.up_to_date")}</p>
      ) : (
        <section class="step" data-state="ng">
          <h2>
            {t("setup.db.pending")} {props.pending.join(", ")}
          </h2>
          <MigrateForm action="/admin/update" pending={props.pending} error={props.error} projectRef={props.projectRef} />
        </section>
      )}
      <p class="muted">
        {t("setup.db.applied")} {props.applied.join(", ") || "-"}
      </p>
      <p>
        <a href="https://github.com/bantojs/banto/blob/main/docs/upgrade.md" target="_blank" rel="noopener">
          docs/upgrade.md
        </a>
      </p>
    </AdminLayout>
  );
}

update.get("/update", requireOwner, requireOrgAdmin, async (c: AdminContext) => {
  const applied = await appliedVersions(c);
  return c.html(<Page pending={pendingMigrations(applied)} applied={applied} done={c.req.query("done")?.split(",").filter(Boolean)} projectRef={projectRefFromUrl(c.get("adapters").config.get("SUPABASE_URL"))} />);
});

update.post("/update", requireOwner, requireOrgAdmin, async (c: AdminContext) => {
  const applied = await appliedVersions(c);
  const outcome = await runMigrationFromForm(c, applied);
  if (isMigrateStep(c)) return migrateStepJson(c, outcome, "/admin/update?done=");
  if (!outcome.ok) return c.html(<Page pending={pendingMigrations(applied)} applied={applied} error={outcome.message} projectRef={projectRefFromUrl(c.get("adapters").config.get("SUPABASE_URL"))} />, 400);
  return c.redirect(`/admin/update?done=${encodeURIComponent(outcome.applied.join(","))}`);
});
