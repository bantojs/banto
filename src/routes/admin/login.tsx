import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { AuthError, verifiedTotp } from "../../auth/supabase";
import { t, type MessageKey } from "../../i18n";
import { AdminLayout } from "./layout";
import { authClient, formFields, sessionSecret, type AdminContext } from "./context";
import { adminDbReady, adminLoginGuard, bumpSessionEpoch, clearSessionCookie, ensureOwnerRow, loadSession, mfaRequiredOf, setSessionCookie, toSessionData } from "./auth";

export const login = new Hono<AppEnv>();

function LoginPage(props: { error: string | null }) {
  return (
    <AdminLayout title={t("login.title")}>
      <div class="auth">
        <div class="card">
          <h1>{t("login.title")}</h1>
          {props.error ? <p class="error">{props.error}</p> : null}
          <form method="post" action="/admin/login">
            <label for="email">{t("login.email")}</label>
            <input id="email" type="email" name="email" required autocomplete="username" />
            <label for="password">{t("login.password")}</label>
            <input id="password" type="password" name="password" required autocomplete="current-password" />
            <p>
              <button type="submit">{t("login.submit")}</button>
            </p>
          </form>
        </div>
        <p class="below">
          <a href="/admin/setup">{t("setup.title")}</a>
        </p>
      </div>
    </AdminLayout>
  );
}

function errorText(code: string | undefined): string | null {
  const map: Record<string, MessageKey> = {
    failed: "login.failed",
    not_owner: "login.not_owner",
    email_not_confirmed: "login.email_not_confirmed",
    locked: "login.locked",
    secret_missing: "error.secret_missing",
  };
  const key = code ? map[code] : undefined;
  return key ? t(key) : null;
}

login.get("/login", (c: AdminContext) => c.html(<LoginPage error={errorText(c.req.query("error"))} />));

login.post("/login", async (c: AdminContext) => {
  if (!sessionSecret(c)) return c.redirect("/admin/login?error=secret_missing");
  const auth = authClient(c);
  if (!auth) return c.redirect("/admin/setup");
  const form = await formFields(c);
  const email = (form.email ?? "").trim();
  const password = form.password ?? "";
  if (!email || !password) return c.redirect("/admin/login?error=failed");
  if (!(await adminDbReady(c))) return c.redirect("/admin/setup");
  // 回数の制限（0030）: 計算の前に判定する。超えていれば Supabase には問い合わせない
  const guard = await adminLoginGuard(c, email);
  if (!guard.allowed) return c.redirect("/admin/login?error=locked");
  try {
    const signedIn = await auth.signInWithPassword(email, password);
    const session = toSessionData(signedIn);
    // 二段階認証を登録している人（0054）: パスワードだけでは入れない。6 桁の画面へ（このあいだ DB も aal1 の JWT を止める）。
    // 成功の記録（失敗の数を消す）は 6 桁が通ってから（パスワードを知る人が再ログインで 6 桁の失敗の数を消せないように）
    if (verifiedTotp(signedIn.user)) {
      await setSessionCookie(c, { ...session, mfa: "challenge" });
      return c.redirect("/admin/mfa");
    }
    await guard.record(true);
    let state: Awaited<ReturnType<typeof ensureOwnerRow>>;
    try {
      state = await ensureOwnerRow(c, session);
    } catch (e) {
      const mfa = mfaRequiredOf(e);
      if (!mfa) throw e;
      // 組織が二段階認証を必須にしていて、まだ登録していない
      await setSessionCookie(c, { ...session, mfa });
      return c.redirect("/admin/mfa");
    }
    if (state !== "ok") return c.redirect("/admin/login?error=not_owner");
    await setSessionCookie(c, session);
    return c.redirect("/admin");
  } catch (e) {
    if (e instanceof AuthError) {
      await guard.record(false);
      if (e.code === "email_not_confirmed" || /not confirmed/i.test(e.message)) return c.redirect("/admin/login?error=email_not_confirmed");
      return c.redirect("/admin/login?error=failed");
    }
    throw e;
  }
});

login.post("/logout", async (c: AdminContext) => {
  const session = await loadSession(c);
  clearSessionCookie(c);
  // 世代を上げる（0030）: この人のすべての端末の Cookie が使えなくなる。access_token の残り時間に関係なく即時
  if (session) await bumpSessionEpoch(c, session);
  const auth = authClient(c);
  if (session && auth) {
    try {
      await auth.signOut(session.access_token);
    } catch {
      /* Cookie は消したので無視 */
    }
  }
  return c.redirect("/admin/login");
});
