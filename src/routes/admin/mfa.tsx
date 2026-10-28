import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { AuthError, verifiedTotp, type TotpEnrollment } from "../../auth/supabase";
import type { SessionData } from "../../auth/session";
import { t, type MessageKey } from "../../i18n";
import { AdminLayout } from "./layout";
import { authClient, dbClient, formFields, type AdminContext } from "./context";
import { adminLoginGuard, ensureOwnerRow, loadSession, sessionAal, setSessionCookie, toSessionData } from "./auth";

/**
 * 運営者の二段階認証（0054、docs/hardening.md）。Supabase Auth（GoTrue）の TOTP。
 *   /admin/mfa         パスワードのあとの 6 桁（session.mfa = "challenge"）
 *   /admin/mfa/setup   登録・解除（自分の設定）。組織が必須にしたのに未登録（session.mfa = "enroll"）ならここへ
 * 強制は DB（banto_pre_request が aal1 の JWT を止める）。ここは GoTrue だけで済む画面なので、二段階目の前でも開ける。
 * 6 桁の試行はパスワードと同じ回数の制限（adminLoginGuard、0030）で数える。
 */
export const mfa = new Hono<AppEnv>();

const CODE_RE = /^\d{6}$/;

function Shell(props: { title: string; error?: MessageKey | null; notice?: MessageKey | null; children?: unknown }) {
  return (
    <AdminLayout title={props.title}>
      <div class="auth">
        <div class="card">
          <h1>{props.title}</h1>
          {props.error ? <p class="error">{t(props.error)}</p> : null}
          {props.notice ? <p class="notice">{t(props.notice)}</p> : null}
          {props.children}
        </div>
      </div>
    </AdminLayout>
  );
}

function CodeField() {
  return (
    <>
      <label for="code">{t("mfa.code")}</label>
      <input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength={6} autocomplete="one-time-code" required />
    </>
  );
}

/** GoTrue の QR は「data:image/svg+xml;utf-8,<svg…>」。img の src に入れられる形にする */
function qrSrc(qr: string): string {
  const m = /^data:image\/svg\+xml;utf-8,(.*)$/s.exec(qr);
  return m ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(m[1]!)}` : qr;
}

/** 二段階目を済ませた新しいセッションに入れ替える（世代は ensureOwnerRow が入れる） */
async function finish(c: AdminContext, next: SessionData): Promise<"ok" | "not_owner"> {
  const state = await ensureOwnerRow(c, next);
  if (state !== "ok") return "not_owner";
  await setSessionCookie(c, next);
  return "ok";
}

// ---------- パスワードのあとの 6 桁 ----------
mfa.get("/mfa", async (c: AdminContext) => {
  const session = await loadSession(c);
  if (!session) return c.redirect("/admin/login");
  if (session.mfa !== "challenge") return c.redirect("/admin/mfa/setup");
  const error = c.req.query("error") === "code" ? "mfa.code_invalid" : c.req.query("error") === "locked" ? "login.locked" : null;
  return c.html(
    <Shell title={t("mfa.challenge_title")} error={error}>
      <p>{t("mfa.challenge_intro")}</p>
      <form method="post" action="/admin/mfa">
        <CodeField />
        <p>
          <button type="submit">{t("mfa.verify")}</button>
        </p>
      </form>
      <p class="below">{t("mfa.lost_help")}</p>
    </Shell>,
  );
});

mfa.post("/mfa", async (c: AdminContext) => {
  const session = await loadSession(c);
  const auth = authClient(c);
  if (!session || !auth) return c.redirect("/admin/login");
  const code = ((await formFields(c)).code ?? "").trim();
  // 6 桁の失敗はパスワードの失敗とは別に数える（鍵 mfa:<利用者 id>）。パスワードの再ログインで消えない（0056）
  const guard = await adminLoginGuard(c, `mfa:${session.user_id}`);
  if (!guard.allowed) return c.redirect("/admin/mfa?error=locked");
  if (!CODE_RE.test(code)) return c.redirect("/admin/mfa?error=code");
  try {
    const factor = verifiedTotp(await auth.getUser(session.access_token));
    if (!factor) return c.redirect("/admin/mfa/setup");
    const next = toSessionData(await auth.verifyTotp(session.access_token, factor.id, code));
    await guard.record(true);
    // 6 桁まで通ったので、パスワードの側の失敗も消す（login.tsx は二段階認証の人の成功を記録しない）
    if (session.email) await (await adminLoginGuard(c, session.email)).record(true);
    if ((await finish(c, next)) !== "ok") return c.redirect("/admin/login?error=not_owner");
    return c.redirect("/admin");
  } catch (e) {
    if (e instanceof AuthError) {
      await guard.record(false);
      return c.redirect("/admin/mfa?error=code");
    }
    throw e;
  }
});

// ---------- 自分の設定: 登録・解除 ----------
mfa.get("/mfa/setup", async (c: AdminContext) => {
  const session = await loadSession(c);
  const auth = authClient(c);
  if (!session || !auth) return c.redirect("/admin/login");
  if (session.mfa === "challenge") return c.redirect("/admin/mfa");
  const factor = verifiedTotp(await auth.getUser(session.access_token));
  const flash = c.req.query("flash");
  const notice: MessageKey | null = flash === "enabled" ? "mfa.enabled" : flash === "disabled" ? "mfa.disabled" : null;
  const error: MessageKey | null = c.req.query("error") === "code" ? "mfa.code_invalid_restart" : c.req.query("error") === "aal" ? "mfa.need_aal2" : null;
  return c.html(
    <Shell title={t("mfa.title")} notice={notice} error={error}>
      {session.mfa === "enroll" ? <p class="error">{t("mfa.org_requires")}</p> : null}
      {factor ? (
        <>
          <p>
            <span class="badge ok">{t("mfa.on")}</span> {t("mfa.on_help")}
          </p>
          <form method="post" action="/admin/mfa/disable">
            <p>
              <label>
                {t("mfa.code")}
                <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength={6} required />
              </label>
            </p>
            <button type="submit">{t("mfa.disable")}</button>
          </form>
          <p class="below">{t("mfa.disable_code_help")}</p>
          <p class="below">{t("mfa.disable_help")}</p>
        </>
      ) : (
        <>
          <p>{t("mfa.intro")}</p>
          <form method="post" action="/admin/mfa/setup">
            <button type="submit">{t("mfa.start")}</button>
          </form>
        </>
      )}
      <p class="below">
        <a href="/admin">{t("nav.dashboard")}</a>
      </p>
    </Shell>,
  );
});

function EnrollPage(props: { e: TotpEnrollment }) {
  return (
    <Shell title={t("mfa.title")}>
      <p>{t("mfa.scan")}</p>
      <p>
        <img src={qrSrc(props.e.qr_code)} width={200} height={200} alt={t("mfa.qr_alt")} />
      </p>
      <p>
        {t("mfa.secret")}: <code>{props.e.secret}</code>
      </p>
      <form method="post" action="/admin/mfa/setup/verify">
        <input type="hidden" name="factor_id" value={props.e.id} />
        <CodeField />
        <p>
          <button type="submit">{t("mfa.enable")}</button>
        </p>
      </form>
    </Shell>
  );
}

mfa.post("/mfa/setup", async (c: AdminContext) => {
  const session = await loadSession(c);
  const auth = authClient(c);
  if (!session || !auth) return c.redirect("/admin/login");
  if (session.mfa === "challenge") return c.redirect("/admin/mfa");
  const user = await auth.getUser(session.access_token);
  if (verifiedTotp(user)) return c.redirect("/admin/mfa/setup");
  // 前に途中でやめた登録（unverified）は消してから始める（GoTrue は同じ名前の登録を重ねられない）
  for (const f of user.factors ?? []) if (f.status !== "verified") await auth.unenroll(session.access_token, f.id).catch(() => undefined);
  const e = await auth.enrollTotp(session.access_token, `Banto ${new Date().toISOString().slice(0, 10)}`);
  return c.html(<EnrollPage e={e} />, 200, { "Cache-Control": "no-store" });
});

mfa.post("/mfa/setup/verify", async (c: AdminContext) => {
  const session = await loadSession(c);
  const auth = authClient(c);
  if (!session || !auth) return c.redirect("/admin/login");
  const form = await formFields(c);
  const code = (form.code ?? "").trim();
  const factorId = form.factor_id ?? "";
  const guard = await adminLoginGuard(c, session.email ?? session.user_id);
  if (!guard.allowed) return c.redirect("/admin/mfa/setup?error=code");
  if (!CODE_RE.test(code) || !/^[0-9a-f-]{36}$/i.test(factorId)) return c.redirect("/admin/mfa/setup?error=code");
  try {
    const next = toSessionData(await auth.verifyTotp(session.access_token, factorId, code));
    await guard.record(true);
    if ((await finish(c, next)) !== "ok") return c.redirect("/admin/login?error=not_owner");
    await auditMfa(c, next, "enabled");
    return c.redirect("/admin/mfa/setup?flash=enabled");
  } catch (e) {
    if (e instanceof AuthError) {
      await guard.record(false);
      return c.redirect("/admin/mfa/setup?error=code");
    }
    throw e;
  }
});

// 解除は二段階目を済ませたセッションで、さらに 6 桁をもう一度入れたときだけ（席を離れたブラウザ・盗まれた Cookie から外されないように。0057）。
// 組織が必須なら、次の操作で DB がまた登録を求める。解除は監査ログに残す
mfa.post("/mfa/disable", async (c: AdminContext) => {
  const session = await loadSession(c);
  const auth = authClient(c);
  if (!session || !auth) return c.redirect("/admin/login");
  if (sessionAal(session) !== "aal2") return c.redirect("/admin/mfa/setup?error=aal");
  const code = ((await formFields(c)).code ?? "").trim();
  const guard = await adminLoginGuard(c, `mfa:${session.user_id}`);
  if (!guard.allowed) return c.redirect("/admin/mfa/setup?error=code");
  if (!CODE_RE.test(code)) return c.redirect("/admin/mfa/setup?error=code");
  const factor = verifiedTotp(await auth.getUser(session.access_token));
  if (!factor) return c.redirect("/admin/mfa/setup");
  try {
    await auth.verifyTotp(session.access_token, factor.id, code);
  } catch (e) {
    if (e instanceof AuthError) {
      await guard.record(false);
      return c.redirect("/admin/mfa/setup?error=code");
    }
    throw e;
  }
  await guard.record(true);
  await auth.unenroll(session.access_token, factor.id);
  await auditMfa(c, session, "disabled");
  return c.redirect("/admin/mfa/setup?flash=disabled");
});

/** 二段階認証の登録・解除を監査ログに残す（0057 の org_member_mfa_self） */
async function auditMfa(c: AdminContext, session: SessionData, action: "enabled" | "disabled"): Promise<void> {
  const db = dbClient(c, session.access_token);
  if (!db) return;
  await db.rpc("org_member_mfa_self", { p_action: action }).catch((e: unknown) => console.error("[banto] mfa audit:", e));
}
