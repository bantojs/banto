/**
 * 会員のログイン（同梱テーマの画面とヘッドレス API の両方がここを通る）。
 * コードとトークンを作ってメールで送り（送り手は src/mail/send.ts）、DB には HMAC の値だけを渡す。照合・回数の制限・失効は DB（0012_member_auth.sql）。
 */
import { PrivilegedRpcError, type MemberLoginVerify, type PrivilegedDb } from "../db/privileged";
import { MailError, type Mailer, sendMail } from "../mail/send";
import { renderMailHtml } from "../mail/html";
import { t, tf } from "../i18n";
import { planLimitOf } from "../plan/limits";
import { codeHash, generateCode, generateLinkToken, ipHash, isEmail, linkHash, normalizeEmail } from "./auth";

export interface LoginDeps {
  db: PrivilegedDb;
  secret: string;
  fetch: typeof fetch;
  /** メールの送り手（createMailer。設定が無ければ null） */
  mailer: Mailer | null;
}

export type StartResult = { ok: true; challengeId: string; email: string } | { ok: false; error: "invalid_email" | "disabled" | "unavailable" | "mail_failed" | "limit" };

/**
 * ログインを始める。link(challengeId, token) がメールのリンクの URL を返す。
 * 回数の上限を超えたときも ok: true（送らないだけ。応答を変えない）
 */
export async function startLogin(
  deps: LoginDeps,
  shop: { id: string; name: string; settings?: Record<string, unknown> | null },
  rawEmail: string,
  opts: { ip: string | null; returnTo: string | null; link: (challengeId: string, token: string) => string },
): Promise<StartResult> {
  const email = normalizeEmail(rawEmail);
  if (!isEmail(email)) return { ok: false, error: "invalid_email" };
  const code = generateCode();
  const token = generateLinkToken();
  let started;
  try {
    started = await deps.db.memberLoginStart(shop.id, email, await codeHash(deps.secret, code), await linkHash(deps.secret, token), opts.ip ? await ipHash(deps.secret, opts.ip) : null, opts.returnTo);
  } catch (e) {
    if (e instanceof PrivilegedRpcError) {
      if (e.is("invalid_email")) return { ok: false, error: "invalid_email" };
      if (e.is("members_disabled")) return { ok: false, error: "disabled" };
      if (e.is("mail_not_configured")) return { ok: false, error: "unavailable" };
      if (planLimitOf(e)) return { ok: false, error: "limit" }; // 1 日のメールの上限（0053、plan_limits.mail_per_day）
    }
    throw e;
  }
  if (started.send) {
    const link = opts.link(started.challenge_id, token);
    try {
      await sendMail(deps.mailer, {
        from: started.mail_from,
        to: email,
        subject: tf("member.mail_subject", { shop: shop.name, code }),
        text: tf("member.mail_body", { shop: shop.name, code, link }),
        html: renderMailHtml(shop, {
          heading: t("member.mail_heading"),
          paragraphs: [tf("member.mail_intro", { shop: shop.name })],
          code,
          button: { label: t("member.mail_button"), url: link },
          note: t("member.mail_note"),
        }),
      });
    } catch (e) {
      if (e instanceof MailError) return { ok: false, error: e.status === 0 && !deps.mailer ? "unavailable" : "mail_failed" };
      throw e;
    }
  }
  return { ok: true, challengeId: started.challenge_id, email };
}

export async function verifyLogin(deps: Pick<LoginDeps, "db" | "secret">, shopId: string, challengeId: string, input: { code: string } | { token: string }): Promise<MemberLoginVerify> {
  if (!/^[0-9a-f-]{36}$/.test(challengeId)) return { ok: false, reason: "invalid" };
  try {
    if ("code" in input) {
      const code = input.code.replace(/\s+/g, "");
      if (!/^[0-9]{6}$/.test(code)) return { ok: false, reason: "invalid" };
      return await deps.db.memberLoginVerify(shopId, challengeId, await codeHash(deps.secret, code), null);
    }
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(input.token)) return { ok: false, reason: "invalid" };
    return await deps.db.memberLoginVerify(shopId, challengeId, null, await linkHash(deps.secret, input.token));
  } catch (e) {
    // 初回のログイン = 会員の作成が、プランの会員数の上限（0052）に当たった
    if (e instanceof PrivilegedRpcError && planLimitOf(e)) return { ok: false, reason: "limit" };
    throw e;
  }
}

/** リンクの確認画面に出すアドレス（使わない）。合わなければ null */
export async function peekLogin(deps: Pick<LoginDeps, "db" | "secret">, shopId: string, challengeId: string, token: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/.test(challengeId) || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  return deps.db.memberLoginPeek(shopId, challengeId, await linkHash(deps.secret, token));
}
