import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { openSession, sealSession, sessionCookieHeader, clearSessionCookieHeader, SESSION_COOKIE, type SessionData } from "../../auth/session";
import type { AuthSession } from "../../auth/supabase";
import { authClient, dbClient, isSecureRequest, sessionSecret, type AdminContext } from "./context";
import { appliedMigrations, migrated } from "../../db/migration-state";
import { createPrivilegedDb } from "../../db/privileged";
import { ipHash, subjectHash } from "../../members/auth";
import { clientIp } from "../common";

/** 運営者の二段階認証（0054）。DB が aal1 の JWT を止める（banto_pre_request） */
export const OPERATOR_MFA_MIGRATION = "0054_operator_mfa";

/** DB が「二段階認証がまだ」と言って止めたか（banto_pre_request の 'mfa_required:<state>'） */
export function mfaRequiredOf(e: unknown): "challenge" | "enroll" | null {
  if (!(e instanceof DbError)) return null;
  const m = /mfa_required:(challenge|enroll)/.exec(`${e.message} ${e.details ?? ""}`);
  return m ? (m[1] as "challenge" | "enroll") : null;
}

/** JWT の aal（aal1 / aal2）。署名は確かめない（自分で封をした Cookie の中のものを読むだけ。強制は DB が JWT を検証して行う） */
export function sessionAal(session: SessionData): string {
  try {
    const part = session.access_token.split(".")[1] ?? "";
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    return String((JSON.parse(json) as { aal?: string }).aal ?? "aal1");
  } catch {
    return "aal1";
  }
}

/** 運営者のセッションの世代と、管理者ログインの回数の制限を DB が持つ版 */
export const ADMIN_SESSIONS_MIGRATION = "0030_admin_sessions";

function adminSessionsReady(c: AdminContext): Promise<boolean> {
  const db = dbClient(c);
  if (!db) return Promise.resolve(false);
  return migrated({ db, cache: c.get("adapters").cache }, ADMIN_SESSIONS_MIGRATION);
}

function readCookie(c: AdminContext, name: string): string | undefined {
  const header = c.req.header("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

export function toSessionData(s: AuthSession): SessionData {
  return {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + s.expires_in,
    user_id: s.user.id,
    email: s.user.email,
  };
}

export async function setSessionCookie(c: AdminContext, data: SessionData): Promise<void> {
  const secret = sessionSecret(c);
  if (!secret) throw new Error("SESSION_SECRET missing");
  c.header("Set-Cookie", sessionCookieHeader(await sealSession(secret, data), { secure: isSecureRequest(c) }), { append: true });
}

export function clearSessionCookie(c: AdminContext): void {
  c.header("Set-Cookie", clearSessionCookieHeader(), { append: true });
}

/** Cookie からセッションを復元し、期限が近ければ refresh する。無効なら null */
export async function loadSession(c: AdminContext): Promise<SessionData | null> {
  const secret = sessionSecret(c);
  if (!secret) return null;
  const data = await openSession(secret, readCookie(c, SESSION_COOKIE));
  if (!data) return null;
  const now = Math.floor(Date.now() / 1000);
  if (data.expires_at - now > 60) return data;
  const auth = authClient(c);
  if (!auth) return null;
  try {
    const refreshed: SessionData = {
      ...toSessionData(await auth.refresh(data.refresh_token)),
      ...(data.epoch !== undefined ? { epoch: data.epoch } : {}),
      ...(data.mfa ? { mfa: data.mfa } : {}),
    };
    await setSessionCookie(c, refreshed);
    return refreshed;
  } catch {
    return null;
  }
}

/**
 * ログインの前に、DB が使える状態か確かめる。マイグレーションが 1 つも当たっていない（初回のデプロイでウィザードを通していない）、
 * または Supabase に届かない（URL・anon キーの誤り）ときは、ログインの処理に進まずセットアップの画面で理由を出す。
 * 適用済みの一覧はキャッシュされるので、続く migrated() は問い合わせを増やさない
 */
export async function adminDbReady(c: AdminContext): Promise<boolean> {
  const db = dbClient(c);
  if (!db) return false;
  try {
    return (await appliedMigrations({ db, cache: c.get("adapters").cache })).size > 0;
  } catch (e) {
    if (!(e instanceof DbError && e.isMissingRelation)) console.error("[banto] admin login: database not reachable:", e);
    return false;
  }
}

/**
 * 管理者ログインの回数の制限（0030、監査 M2）。Supabase の /token の制限は Worker の出口 IP でまとめて掛かるので、Banto が
 * アドレス（HMAC）と IP（HMAC）ごとに数える。計算（Supabase への問い合わせ）の前に判定する。0030 より前の DB では何もしない。
 * 戻り値の record は、試した結果を記録する（成功したらそのアドレスの失敗を消す）
 */
export async function adminLoginGuard(c: AdminContext, email: string): Promise<{ allowed: boolean; record: (success: boolean) => Promise<void> }> {
  const none = { allowed: true, record: async () => undefined };
  const secret = sessionSecret(c);
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret || !url || !serviceRoleKey || !(await adminSessionsReady(c))) return none;
  const db = createPrivilegedDb({ url, serviceRoleKey, fetch: c.get("deps").fetch });
  const emailHash = await subjectHash(secret, `admin:${email.trim().toLowerCase()}`);
  const ip = clientIp(c);
  const ipH = ip ? await ipHash(secret, ip) : null;
  const r = await db.adminLoginCheck(emailHash, ipH);
  return { allowed: r.allowed !== false, record: (success) => db.adminLoginRecord(emailHash, ipH, success) };
}

/** ログアウト: 世代を上げて、この人のすべての Cookie を無効にする（0030）。古い DB では何もしない */
export async function bumpSessionEpoch(c: AdminContext, session: SessionData): Promise<void> {
  if (!(await adminSessionsReady(c))) return;
  const db = dbClient(c, session.access_token);
  if (!db) return;
  await db.rpc("admin_session_bump", {}).catch(() => undefined);
}

/**
 * 運営側の人か確かめる（0024: どこかの組織のメンバー）。どこにも入っていなければ owners の行を作ってみる
 * （1 人目だけ RLS が許す = 最初の組織の owner。トリガーが組織を作る）。2 人目からは招待で入る。
 * 組織から外された人は、owners の行が残っていても入れない（owners への 2 回目の insert は弾かれる）。戻り値: "ok" | "not_owner"
 */
export async function ensureOwnerRow(c: AdminContext, session: SessionData): Promise<"ok" | "not_owner" | "stale"> {
  const db = dbClient(c, session.access_token);
  if (!db) return "not_owner";
  if (await adminSessionsReady(c)) {
    // 0030: メンバーかどうかと世代を 1 回で。Cookie の世代が古ければ（ログアウト済み）入れない
    const me = await db.rpc<{ member: boolean; epoch?: number }>("banto_admin_me", {});
    if (me?.member) {
      const epoch = typeof me.epoch === "number" ? me.epoch : 0;
      if (session.epoch === undefined) session.epoch = epoch; // ログイン直後: 世代を Cookie に入れる
      else if (session.epoch !== epoch) return "stale";
      return "ok";
    }
  } else if (await db.from<{ org_id: string }>("org_members").selectOne("org_id", { eq: { user_id: session.user_id } })) {
    return "ok";
  }
  try {
    await db.from("owners").insert({ id: session.user_id });
    if (session.epoch === undefined) session.epoch = 0;
    return "ok";
  } catch (e) {
    if (e instanceof DbError && (e.isRlsViolation || e.status === 409)) return "not_owner";
    throw e;
  }
}

/** 管理画面の認可。未ログインならログインへ、owner でなければ Cookie を消してログインへ */
export const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await loadSession(c);
  if (!session) {
    clearSessionCookie(c);
    return c.redirect("/admin/login");
  }
  // 二段階認証の途中（0054）: 6 桁の確認・登録の画面だけ
  if (session.mfa) return c.redirect("/admin/mfa");
  const hadEpoch = session.epoch !== undefined;
  let state: Awaited<ReturnType<typeof ensureOwnerRow>>;
  try {
    state = await ensureOwnerRow(c, session);
  } catch (e) {
    const mfa = mfaRequiredOf(e);
    if (!mfa) throw e;
    // DB が止めた（別の端末で登録した・組織が必須にした）: 途中の印を付けて二段階認証の画面へ
    session.mfa = mfa;
    await setSessionCookie(c, session);
    return c.redirect("/admin/mfa");
  }
  if (state !== "ok") {
    clearSessionCookie(c);
    return c.redirect(state === "stale" ? "/admin/login" : "/admin/login?error=not_owner");
  }
  // 0030 を当てた後の最初のリクエスト: 世代を Cookie に入れ直す（以後ログアウトで切れる）
  if (!hadEpoch && session.epoch !== undefined) await setSessionCookie(c, session);
  c.set("session", session);
  c.set("db", dbClient(c, session.access_token) ?? undefined);
  await next();
};
