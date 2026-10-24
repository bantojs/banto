import type { Context } from "hono";
import type { AppEnv } from "../../app";
import { applyMigrations, migrationHosts, MigrationError } from "../../db/migrate";
import { applyMigrationsViaApi, ManagementApiError, normalizeAccessToken, projectRefFromUrl } from "../../db/migrate-api";
import { pendingMigrationFiles } from "../../db/migrations";
import { forgetAppliedMigrations } from "../../db/migration-state";
import { t } from "../../i18n";

/**
 * マイグレーション適用フォーム（ウィザードの手順2と /admin/update で共用）。
 * 既定: Supabase のアクセストークンを貼る → Worker が Management API（HTTPS）で未適用分を流す → トークンは捨てる。
 * 代替: 接続文字列（Node で動かしている場合・ローカル Supabase 用）。
 */
export function MigrateForm(props: { action: string; pending: string[]; error?: string | null; projectRef?: string | null }) {
  return (
    <form method="post" action={props.action}>
      <p>{t("migrate.intro")}</p>
      {props.error ? <p class="error">{props.error}</p> : null}
      {props.projectRef ? (
        <div>
          <ol>
            <li>{t("migrate.token_step1")}</li>
            <li>{t("migrate.token_step2")}</li>
            <li>{t("migrate.token_step3")}</li>
          </ol>
          <label for="access_token">{t("migrate.token_field")}</label>
          <input id="access_token" type="password" name="access_token" placeholder="sbp_..." autocomplete="off" style="width:100%;max-width:40rem" />
          <p class="muted">
            {t("migrate.token_hint")} <code>{props.projectRef}</code>
          </p>
        </div>
      ) : null}
      <details open={!props.projectRef}>
        <summary>{t("migrate.alt_summary")}</summary>
        <ol>
          <li>{t("migrate.step1")}</li>
          <li>{t("migrate.step2")}</li>
          <li>{t("migrate.step3")}</li>
        </ol>
        <label for="connection_string">{t("migrate.field")}</label>
        <input id="connection_string" type="password" name="connection_string" placeholder="postgresql://postgres.xxxx:[YOUR-PASSWORD]@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres" autocomplete="off" style="width:100%;max-width:40rem" />
      </details>
      <p class="muted">{t("migrate.not_stored")}</p>
      <p>
        <button type="submit">
          {t("migrate.submit")} ({props.pending.join(", ")})
        </button>
      </p>
    </form>
  );
}

export type MigrateOutcome = { ok: true; applied: string[] } | { ok: false; message: string };

/** 接続文字列かアクセストークンを受け取って未適用分を当てる。失敗理由は画面向けの文言に直す */
export async function runMigrationFromForm(c: Context<AppEnv>, applied: readonly string[]): Promise<MigrateOutcome> {
  const outcome = await applyFromForm(c, applied);
  // 新しい機能を出すかどうかの判定（src/db/migration-state.ts）が古い一覧を使わないように
  if (outcome.ok) await forgetAppliedMigrations(c.get("adapters").cache);
  return outcome;
}

async function applyFromForm(c: Context<AppEnv>, applied: readonly string[]): Promise<MigrateOutcome> {
  const body = await c.req.parseBody();
  const files = pendingMigrationFiles(applied);
  const rawToken = typeof body["access_token"] === "string" ? body["access_token"].trim() : "";
  if (rawToken) {
    const token = normalizeAccessToken(rawToken);
    if (!token) return { ok: false, message: t("migrate.error_token") };
    const ref = projectRefFromUrl(c.get("adapters").config.get("SUPABASE_URL"));
    if (!ref) return { ok: false, message: t("migrate.error_ref") };
    try {
      const result = await applyMigrationsViaApi({ ref, token, fetch: c.get("deps").fetch }, files);
      return { ok: true, applied: result.applied };
    } catch (e) {
      if (e instanceof ManagementApiError) {
        if (e.kind === "token") return { ok: false, message: t("migrate.error_token") };
        if (e.kind === "ref") return { ok: false, message: `${t("migrate.error_ref")} ${e.message}` };
        if (e.kind === "rate_limited") return { ok: false, message: t("migrate.error_rate") };
        if (e.kind === "apply") return { ok: false, message: `${t("migrate.error_apply")} ${e.version ?? ""}: ${e.message}` };
        return { ok: false, message: `${t("migrate.error_connect")} ${e.message}` };
      }
      throw e;
    }
  }
  const raw = typeof body["connection_string"] === "string" ? body["connection_string"].trim() : "";
  if (!raw) return { ok: false, message: t("migrate.error_invalid") };
  try {
    const result = await applyMigrations(raw, files, migrationHosts(c.get("adapters").config.get("DB_MIGRATION_HOSTS")));
    return { ok: true, applied: result.applied };
  } catch (e) {
    if (e instanceof MigrationError) {
      if (e.stage === "connect") {
        if (e.message === "host_not_allowed") return { ok: false, message: t("migrate.error_host") };
        if (e.message === "invalid") return { ok: false, message: t("migrate.error_invalid") };
        if (e.message.endsWith("[direct_connection]")) return { ok: false, message: `${t("migrate.error_direct")} ${e.message.replace(" [direct_connection]", "")}` };
        return { ok: false, message: `${t("migrate.error_connect")} ${e.message}` };
      }
      return { ok: false, message: `${t("migrate.error_apply")} ${e.version ?? ""}: ${e.message}` };
    }
    throw e;
  }
}
