import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { AuthError } from "../../auth/supabase";
import { DbError } from "../../db/client";
import { pendingMigrations } from "../../db/migrations";
import { t, type MessageKey } from "../../i18n";
import { BANTO_VERSION } from "../../version";
import { AdminLayout, PageHead } from "./layout";
import {
  REQUIRED_PUBLIC_VARS,
  REQUIRED_SECRETS,
  SLUG_RE,
  authClient,
  dbClient,
  formFields,
  owner,
  type AdminContext,
} from "./context";
import { ensureOwnerRow, loadSession, requireOwner, setSessionCookie, toSessionData } from "./auth";
import { generateSecret } from "../../auth/session";
import { requireOrgAdmin } from "./access";
import { isMigrateStep, MigrateForm, migrateStepJson, runMigrationFromForm } from "./migrate";
import { projectRefFromUrl } from "../../db/migrate-api";
import { createPrivilegedAuth } from "../../db/privileged";

export const setup = new Hono<AppEnv>();

interface EnvCheck {
  name: string;
  ok: boolean;
  secret: boolean;
}

interface DbState {
  status: "ok" | "unreachable" | "no_migrations" | "skipped";
  detail?: string;
  applied: string[];
  pending: string[];
  hasOwner: boolean;
  shopCount: number;
}

interface SetupStateResponse {
  has_owner: boolean;
  shop_count: number;
  migrations: string[];
}

function checkEnv(c: AdminContext): { checks: EnvCheck[]; ok: boolean } {
  const cfg = c.get("adapters").config;
  const checks: EnvCheck[] = [
    ...REQUIRED_PUBLIC_VARS.map((name) => ({ name, ok: Boolean(cfg.get(name)), secret: false })),
    ...REQUIRED_SECRETS.map((name) => ({ name, ok: Boolean(cfg.get(name)), secret: true })),
  ];
  return { checks, ok: checks.every((x) => x.ok) };
}

async function checkDb(c: AdminContext): Promise<DbState> {
  const db = dbClient(c);
  const empty: DbState = { status: "skipped", applied: [], pending: [], hasOwner: false, shopCount: 0 };
  if (!db) return empty;
  try {
    const s = await db.rpc<SetupStateResponse>("banto_setup_state");
    return {
      status: "ok",
      applied: s.migrations,
      pending: pendingMigrations(s.migrations),
      // 0030 より前の DB でも、ショップがあれば運営者登録は閉じる（最初の運営者を消しても匿名に開かない。監査 M1）
      hasOwner: s.has_owner || s.shop_count > 0,
      shopCount: s.shop_count,
    };
  } catch (e) {
    if (e instanceof DbError && e.isMissingRelation) return { ...empty, status: "no_migrations", pending: pendingMigrations([]) };
    return { ...empty, status: "unreachable", detail: e instanceof Error ? e.message : String(e) };
  }
}

function errorMessage(code: string | undefined): string | null {
  const map: Record<string, MessageKey> = {
    taken: "setup.owner.taken",
    signup_disabled: "setup.owner.signup_disabled",
    invalid_slug: "setup.shop.invalid_slug",
    blocked: "setup.blocked",
    generic: "error.generic",
    secret_missing: "error.secret_missing",
  };
  if (!code) return null;
  const key = map[code];
  return key ? t(key) : t("error.generic");
}

function EnvSection(props: { checks: EnvCheck[]; ok: boolean }) {
  const missing = props.checks.filter((x) => !x.ok);
  return (
    <section class="step" data-state={props.ok ? "ok" : "ng"}>
      <h2>
        {t("setup.step.env")}
        <span class={`badge ${props.ok ? "ok" : "ng"}`}>{props.ok ? t("setup.env.ok") : t("setup.env.missing")}</span>
      </h2>
      <table>
        <tbody>
          {props.checks.map((x) => (
            <tr>
              <td>
                <code>{x.name}</code>
                {x.secret ? <span class="badge">Secret</span> : null}
              </td>
              <td class={x.ok ? "" : "error"}>{x.ok ? t("setup.env.ok") : t("setup.env.missing")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {missing.length > 0 ? (
        <div>
          <p>{t("setup.env.howto")}</p>
          <ol>
            {missing.map((x) => (
              <li>
                <code>{x.name}</code>: {x.secret ? t("setup.env.add_secret") : t("setup.env.add_var")} {t(`setup.env.where.${x.name}` as MessageKey)}
                {x.name === "SESSION_SECRET" ? <pre>{generateSecret()}</pre> : null}
              </li>
            ))}
          </ol>
          <details>
            <summary>{t("setup.env.cli")}</summary>
            <pre>{missing.map((x) => `npx wrangler secret put ${x.name}`).join("\n")}</pre>
          </details>
        </div>
      ) : null}
    </section>
  );
}

function DbSection(props: { db: DbState; migrateError?: string | null; migrated?: string[]; projectRef: string | null }) {
  const { db } = props;
  const ok = db.status === "ok" && db.pending.length === 0;
  const needsMigration = db.status === "no_migrations" || (db.status === "ok" && db.pending.length > 0);
  return (
    <section class="step" data-state={db.status === "skipped" ? undefined : ok ? "ok" : "ng"}>
      <h2>
        {t("setup.step.db")}
        {db.status !== "skipped" ? <span class={`badge ${ok ? "ok" : "ng"}`}>{ok ? "OK" : "NG"}</span> : null}
      </h2>
      {db.status === "skipped" ? <p>{t("setup.blocked")}</p> : null}
      {db.status === "unreachable" ? (
        <div>
          <p class="error">{t("setup.db.unreachable")}</p>
          {db.detail ? <pre>{db.detail}</pre> : null}
        </div>
      ) : null}
      {db.status === "no_migrations" ? <p class="error">{t("setup.db.no_migrations")}</p> : null}
      {db.status === "ok" && db.pending.length > 0 ? (
        <p class="error">
          {t("setup.db.pending")} {db.pending.join(", ")}
        </p>
      ) : null}
      {props.migrated && props.migrated.length > 0 ? (
        <p class="notice">
          {t("migrate.done")} {props.migrated.join(", ")}
          {needsMigration ? ` ${t("migrate.more")}` : null}
        </p>
      ) : null}
      {needsMigration ? <MigrateForm action="/admin/setup/migrate" pending={db.pending} error={props.migrateError} projectRef={props.projectRef} /> : null}
      {db.status === "ok" ? (
        <p>
          {t("setup.db.ok")} {t("setup.db.applied")} {db.applied.join(", ") || "-"}
        </p>
      ) : null}
    </section>
  );
}

function OwnerSection(props: { enabled: boolean; hasOwner: boolean; error: string | null; info?: string }) {
  return (
    <section class="step" data-state={props.hasOwner ? "ok" : props.enabled ? undefined : "ng"}>
      <h2>
        {t("setup.step.owner")}
        {props.hasOwner ? <span class="badge ok">{t("setup.env.ok")}</span> : null}
      </h2>
      {props.hasOwner ? (
        <p>
          {t("setup.owner.exists")} <a href="/admin/login">{t("login.title")}</a>
        </p>
      ) : !props.enabled ? (
        <p>{t("setup.blocked")}</p>
      ) : (
        <form method="post" action="/admin/setup/owner">
          <p>{t("setup.owner.intro")}</p>
          {props.error ? <p class="error">{props.error}</p> : null}
          {props.info ? <p class="notice">{props.info}</p> : null}
          <label for="email">{t("login.email")}</label>
          <input id="email" type="email" name="email" required autocomplete="username" />
          <label for="password">
            {t("login.password")}（{t("setup.owner.password_hint")}）
          </label>
          <input id="password" type="password" name="password" required minlength={8} autocomplete="new-password" />
          <p>
            <button type="submit">{t("setup.owner.submit")}</button>
          </p>
        </form>
      )}
    </section>
  );
}

function ShopSection(props: { enabled: boolean; done: boolean; error: string | null; loggedIn: boolean }) {
  return (
    <section class="step" data-state={props.done ? "ok" : props.enabled ? undefined : "ng"}>
      <h2>{t("setup.step.shop")}</h2>
      {props.done ? (
        <p>
          {t("setup.done")} <a href="/admin">{t("nav.dashboard")}</a>
        </p>
      ) : !props.enabled ? (
        <p>{t("setup.blocked")}</p>
      ) : !props.loggedIn ? (
        <p>
          <a href="/admin/login">{t("login.title")}</a>
        </p>
      ) : (
        <form method="post" action="/admin/setup/shop">
          <p>{t("setup.shop.intro")}</p>
          {props.error ? <p class="error">{props.error}</p> : null}
          <label for="name">{t("setup.shop.name")}</label>
          <input id="name" type="text" name="name" required maxlength={200} />
          <label for="slug">{t("setup.shop.slug")}</label>
          <input id="slug" type="text" name="slug" required pattern="[a-z0-9][a-z0-9-]{0,62}" />
          <p>
            <button type="submit">{t("setup.shop.submit")}</button>
          </p>
        </form>
      )}
    </section>
  );
}

async function renderSetup(c: AdminContext, opts: { error?: string; info?: string; migrateError?: string | null; status?: 200 | 400 } = {}) {
  const env = checkEnv(c);
  const db = await checkDb(c);
  const dbOk = db.status === "ok" && db.pending.length === 0;

  // 完了済みならフォームを出さない（owner と shop が揃っている）
  if (db.hasOwner && db.shopCount > 0) {
    return c.html(
      <AdminLayout title={t("setup.title")}>
        <div class="auth">
          <div class="card">
            <h1>{t("setup.title")}</h1>
            <p>{t("setup.locked")}</p>
            <a class="btn" href="/admin/login" style="width:100%">
              {t("login.title")}
            </a>
          </div>
        </div>
      </AdminLayout>,
    );
  }

  const session = db.hasOwner ? await loadSession(c) : null;
  const loggedIn = session !== null && (await ensureOwnerRow(c, session)) === "ok";
  const err = errorMessage(opts.error ?? c.req.query("error"));

  return c.html(
    <AdminLayout title={t("setup.title")}>
      <div class="narrow">
        <PageHead title={t("setup.title")} sub={t("setup.intro")} />
        <EnvSection checks={env.checks} ok={env.ok} />
        <DbSection db={db} migrateError={opts.migrateError} migrated={c.req.query("migrated")?.split(",").filter(Boolean)} projectRef={projectRefFromUrl(c.get("adapters").config.get("SUPABASE_URL"))} />
        <OwnerSection enabled={env.ok && dbOk} hasOwner={db.hasOwner} error={db.hasOwner ? null : err} info={opts.info} />
        <ShopSection enabled={env.ok && dbOk && db.hasOwner} done={db.shopCount > 0} error={db.hasOwner ? err : null} loggedIn={loggedIn} />
      </div>
    </AdminLayout>,
    opts.status ?? 200,
  );
}

setup.get("/", (c) => renderSetup(c));

/**
 * AI や導入スクリプトが進捗を確認するための JSON（docs/install-with-ai.md）。
 * 値や秘密は返さない。運営者が登録されたら 404（以後の状態はログインした運営者だけが見る）。
 */
setup.get("/status.json", async (c) => {
  const env = checkEnv(c);
  const db = await checkDb(c);
  if (db.hasOwner) return c.json({ error: "setup_completed" }, 404);
  const next = !env.ok ? "env" : db.status !== "ok" || db.pending.length > 0 ? "migrate" : "owner";
  return c.json(
    {
      version: BANTO_VERSION,
      env: { missing: env.checks.filter((x) => !x.ok).map((x) => x.name), ok: env.checks.filter((x) => x.ok).map((x) => x.name) },
      db: { status: db.status, pending_migrations: db.pending, applied_migrations: db.applied },
      owner: { exists: false },
      next,
    },
    200,
    { "Cache-Control": "no-store" },
  );
});

/** 手順2: 接続文字列を貼ってマイグレーションを当てる。owner 登録後はログイン必須 */
setup.post("/migrate", async (c) => {
  const db = await checkDb(c);
  if (db.hasOwner) {
    const session = await loadSession(c);
    if (!session || (await ensureOwnerRow(c, session)) !== "ok") return c.redirect("/admin/login");
  }
  if (db.status === "ok" && db.pending.length === 0) return isMigrateStep(c) ? migrateStepJson(c, { ok: true, applied: [], remaining: [] }, "/admin/setup?migrated=") : c.redirect("/admin/setup");
  const outcome = await runMigrationFromForm(c, db.status === "ok" ? db.applied : []);
  if (isMigrateStep(c)) return migrateStepJson(c, outcome, "/admin/setup?migrated=");
  if (!outcome.ok) return renderSetup(c, { migrateError: outcome.message, status: 400 });
  return c.redirect(`/admin/setup?migrated=${encodeURIComponent(outcome.applied.join(","))}`);
});

setup.post("/owner", async (c) => {
  const env = checkEnv(c);
  const db = await checkDb(c);
  if (!env.ok || db.status !== "ok" || db.pending.length > 0 || db.hasOwner) {
    return c.redirect("/admin/setup?error=blocked");
  }
  const form = await formFields(c);
  const email = (form.email ?? "").trim();
  const password = form.password ?? "";
  if (!email || password.length < 8) return c.redirect("/admin/setup?error=generic");

  const auth = authClient(c);
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!auth || !url || !serviceRoleKey) return c.redirect("/admin/setup?error=blocked");
  try {
    // 確認メールを待たない: service_role の Admin API で確認済みユーザーを作り、そのままログインする。
    // （signup だと確認メールのリンク先が Supabase の Site URL（既定 localhost:3000）になり、運営者が詰まる）
    try {
      await createPrivilegedAuth({ url, serviceRoleKey, fetch: c.get("deps").fetch }).createConfirmedUser(email, password);
    } catch (e) {
      if (!(e instanceof AuthError && e.code === "email_exists")) throw e;
      // 既存ユーザー: パスワードが合えばそのまま進む（未確認ならその旨を案内）
    }
    let session;
    try {
      session = await auth.signInWithPassword(email, password);
    } catch (e) {
      if (e instanceof AuthError && e.code === "email_not_confirmed") return renderSetup(c, { info: t("setup.owner.exists_unconfirmed") });
      if (e instanceof AuthError) return renderSetup(c, { info: t("setup.owner.email_taken") });
      throw e;
    }
    const data = toSessionData(session);
    if ((await ensureOwnerRow(c, data)) !== "ok") return c.redirect("/admin/setup?error=taken");
    await setSessionCookie(c, data);
    return c.redirect("/admin/setup");
  } catch (e) {
    if (e instanceof AuthError) {
      if (e.code === "signup_disabled" || /signups? not allowed/i.test(e.message)) return c.redirect("/admin/setup?error=signup_disabled");
      return renderSetup(c, { error: "generic", info: e.message });
    }
    throw e;
  }
});

setup.post("/shop", requireOwner, requireOrgAdmin, async (c) => {
  const { session, db } = owner(c);
  const form = await formFields(c);
  const name = (form.name ?? "").trim();
  const slug = (form.slug ?? "").trim();
  if (!name || name.length > 200) return c.redirect("/admin/setup?error=generic");
  if (!SLUG_RE.test(slug)) return c.redirect("/admin/setup?error=invalid_slug");
  try {
    await db.from("shops").insert({ owner_id: session.user_id, slug, name });
  } catch (e) {
    if (e instanceof DbError) return renderSetup(c, { error: "generic", info: e.message });
    throw e;
  }
  return c.redirect("/admin");
});
