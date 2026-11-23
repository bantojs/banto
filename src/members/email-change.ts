/**
 * 会員が自分でメールアドレスを変える（0166、メンテナの決定 2026-11-23、docs/members.md・docs/knowledge/10-members-identity.md）。
 * 同梱テーマの会員ページとヘッドレス API の両方がここを通る。
 *
 * - ログインを確かめてから 15 分以内のセッションだけ（盗まれた Cookie・トークンから変えさせない。過ぎていれば reauth）
 * - 新しいアドレスに 6 桁のコードを送り、合えば変わる。コードは HMAC の値だけを DB へ渡す（照合・回数・期限は DB）
 * - 変わったら前のアドレスと新しいアドレスの両方に知らせる（心当たりが無ければお店へ）。ほかの端末は DB がログアウトする
 * - ほかの会員が使っているアドレス・回数の上限のときも「送った」と同じ応答（アドレスが登録されているかを探らせない）。
 *   DB も同じ後始末をし（前のコードを無効にし、誰にも合わないコードの行を作る）、メールは応答の後に送る（応答の時間と答えで分からないように。
 *   送れなかったときはログに残すだけで、応答には出さない）
 */
import { PrivilegedRpcError, type MemberEmailChangeVerify, type PrivilegedDb } from "../db/privileged";
import { MailError, mailFailureLog, type Mailer, sendMail } from "../mail/send";
import { renderMailHtml } from "../mail/html";
import { t, tf } from "../i18n";
import { formatDateTime } from "../i18n/time";
import { planLimitOf } from "../plan/limits";
import { emailChangeCodeHash, generateCode, ipHash, isEmail, normalizeEmail } from "./auth";

/** このマイグレーションが当たるまで画面・API に出さない */
export const EMAIL_CHANGE_MIGRATION = "0166_member_email_change";

export interface EmailChangeDeps {
  db: PrivilegedDb;
  secret: string;
  mailer: Mailer | null;
}

type Shop = { id: string; name: string; settings?: Record<string, unknown> | null };
/** 会員本人のセッション（世代とセッションの行） */
export type EmailChangeMember = { id: string; epoch: number; sid: string };

export type EmailChangeStartResult =
  /** deliver: コードのメールを送る仕事（呼び出し側が応答の後に走らせる。送らないときも同じ形で、何もしない） */
  | { ok: true; deliver: () => Promise<void> }
  | { ok: false; error: "invalid_email" | "same_email" | "reauth" | "session" | "unavailable" | "limit" | "disabled" };

/** 新しいアドレスにコードを送る。回数の上限・使われているアドレスでも ok: true（送らないだけ。応答は同じ） */
export async function startEmailChange(deps: EmailChangeDeps, shop: Shop, member: EmailChangeMember, rawEmail: string, ip: string | null): Promise<EmailChangeStartResult> {
  const email = normalizeEmail(rawEmail);
  if (!isEmail(email)) return { ok: false, error: "invalid_email" };
  // 送り手が無いデプロイ（どのアドレスでも同じ。アドレスで答えを変えない）
  if (!deps.mailer) return { ok: false, error: "unavailable" };
  const code = generateCode();
  let r;
  try {
    r = await deps.db.memberEmailChangeStart(shop.id, member.id, member.epoch, member.sid, email, await emailChangeCodeHash(deps.secret, code), ip ? await ipHash(deps.secret, ip) : null);
  } catch (e) {
    if (e instanceof PrivilegedRpcError) {
      if (e.is("invalid_email")) return { ok: false, error: "invalid_email" };
      if (e.is("members_disabled")) return { ok: false, error: "disabled" };
      if (e.is("mail_not_configured")) return { ok: false, error: "unavailable" };
      if (planLimitOf(e)) return { ok: false, error: "limit" };
    }
    throw e;
  }
  if (!r.ok) return { ok: false, error: r.reason === "same" ? "same_email" : r.reason };
  const send = r.send && r.mail_from ? { from: r.mail_from } : null;
  const mailer = deps.mailer;
  return {
    ok: true,
    deliver: async () => {
      if (!send) return;
      try {
        await sendMail(mailer, {
          from: send.from,
          to: email,
          subject: tf("member.email_change_mail_subject", { shop: shop.name, code }),
          text: tf("member.email_change_mail_body", { shop: shop.name, code }),
          html: renderMailHtml(shop, {
            heading: t("member.email_change_mail_heading"),
            paragraphs: [tf("member.email_change_mail_intro", { shop: shop.name })],
            code,
            note: t("member.email_change_mail_note"),
          }),
        });
      } catch (e) {
        // 応答はもう返している（送れたかどうかで答えを変えない）。ログに残すだけ
        if (e instanceof MailError) console.error(mailFailureLog("member email change", mailer, e));
        else console.error("[banto] member email change:", e);
      }
    },
  };
}

/** 前のアドレスへの知らせに出す新しいアドレス（頭の 1 文字と @ 以降だけ。前のアドレスがもう他人のものでも、新しいアドレスを渡さない） */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${[...email.slice(0, at)][0]}***${email.slice(at)}`;
}

/** コードを確かめてアドレスを変える。成功したら前後のアドレスに知らせる（notify は応答の後に送るために呼び出し側へ返す） */
export async function verifyEmailChange(
  deps: EmailChangeDeps,
  shop: Shop,
  member: EmailChangeMember,
  rawCode: string,
  accountUrl: string,
): Promise<{ result: MemberEmailChangeVerify; notify: () => Promise<void> }> {
  const code = rawCode.replace(/\s+/g, "");
  if (!/^[0-9]{6}$/.test(code)) return { result: { ok: false, reason: "invalid" }, notify: async () => undefined };
  const result = await deps.db.memberEmailChangeVerify(shop.id, member.id, member.epoch, member.sid, await emailChangeCodeHash(deps.secret, code));
  const notify = async () => {
    if (!result.ok) return;
    await sendEmailChangedNotices(deps, shop, { from: result.mail_from, oldEmail: result.old_email, newEmail: result.new_email, accountUrl });
  };
  return { result, notify };
}

/** 変わったことを前後のアドレスに知らせる（送れなくても変更は戻さない。送信元が無ければ送らない） */
export async function sendEmailChangedNotices(
  deps: Pick<EmailChangeDeps, "mailer">,
  shop: Shop,
  m: { from: string | null; oldEmail: string | null; newEmail: string; accountUrl: string; at?: Date },
): Promise<void> {
  if (!deps.mailer || !m.from) return;
  const time = formatDateTime((m.at ?? new Date()).toISOString());
  const send = (to: string, intro: string, advice: string) =>
    sendMail(deps.mailer, {
      from: m.from!,
      to,
      subject: tf("member.email_self_changed_subject", { shop: shop.name }),
      text: tf("member.change_body", { intro, advice, account: m.accountUrl, shop: shop.name }),
      html: renderMailHtml(shop, {
        heading: t("member.email_changed_heading"),
        paragraphs: [intro, advice],
        button: { label: t("member.notice_button"), url: m.accountUrl },
      }),
    }).catch((e: unknown) => console.error("[banto] email changed notice:", e));
  const jobs: Promise<unknown>[] = [send(m.newEmail, tf("member.email_changed_intro_new", { email: m.newEmail, time }), t("member.email_changed_advice_new"))];
  if (m.oldEmail && m.oldEmail !== m.newEmail) jobs.push(send(m.oldEmail, tf("member.email_changed_intro_old", { old: m.oldEmail, email: maskEmail(m.newEmail), time }), t("member.email_changed_advice_old")));
  await Promise.all(jobs);
}
