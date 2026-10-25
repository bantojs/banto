import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const h = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * 0057_member_reauth: パスワードの設定と LINE / Google の連携は、ログインしてから 15 分以内のセッションだけ。
 * パスワードを変えても今のセッションの行は作り直さない（0046 の「15 分以内」が新しい行で通らない）。
 */
describe.skipIf(!dbAvailable)("会員の入る手段の追加（0057_member_reauth）", () => {
  let f: Fixture;
  let cid: string;
  const sessionStart = (epoch: number) =>
    asService(async (c) => (await c.query<{ r: string }>("select member_session_start($1, $2, $3, 'web', 'dev', 86400) as r", [f.shopId, cid, epoch])).rows[0]!.r);
  const setPassword = (epoch: number, sid: string | null) =>
    asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select member_set_password($1, $2, $3, 'new-password-1', $4) as r", [f.shopId, cid, epoch, sid])).rows[0]!.r);
  const link = (epoch: number, sid: string | null) =>
    asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select member_oauth_login($1, 'google', 'sub-1', 'm@example.com', true, $2, $3, $4) as r", [f.shopId, cid, epoch, sid])).rows[0]!.r);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "mr@example.com", slug: "mr-shop", publish: true });
    await getPool().query("update shops set settings = settings || '{\"members_enabled\": true, \"members_password\": true, \"modules\": {\"google_login\": true}}' where id = $1", [f.shopId]);
    await getPool().query("insert into hook_endpoints (shop_id, name, url, events, settings) values ($1, 'mail', 'https://banto.invalid/plugins/email_resend', '{}', '{\"from\": \"Shop <shop@example.com>\"}')", [f.shopId]);
    cid = (await getPool().query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'm@example.com') returning id", [f.shopId])).rows[0]!.id;
  });
  afterAll(closePool);

  it("パスワード: セッション無し・15 分を過ぎたセッションでは設定できない。15 分以内なら設定でき、同じ行が新しい世代に付け替わる。知らせの送信元が返る", async () => {
    expect(await setPassword(0, null)).toEqual({ ok: false, reason: "session" });
    const stale = await sessionStart(0);
    await getPool().query("update member_sessions set created_at = now() - interval '16 minutes' where id = $1", [stale]);
    expect(await setPassword(0, stale)).toEqual({ ok: false, reason: "reauth" });
    const fresh = await sessionStart(0);
    const r = await setPassword(0, fresh);
    expect(r).toEqual({ ok: true, epoch: 1, email: "m@example.com", mail_from: "Shop <shop@example.com>" });
    // 今の行は新しい世代で生きている。古い行は世代が合わずに止まる。新しい行は作られていない
    const rows = await getPool().query<{ id: string; session_epoch: number }>("select id, session_epoch from member_sessions where customer_id = $1 order by created_at", [cid]);
    expect(rows.rows.map((x) => [x.id === fresh, x.session_epoch])).toEqual([[false, 0], [true, 1]]);
    expect((await asService(async (c) => (await c.query<{ r: boolean }>("select member_session_check($1, $2, 1, $3) as r", [f.shopId, cid, fresh])).rows[0]!.r))).toBe(true);
    expect((await asService(async (c) => (await c.query<{ r: boolean }>("select member_session_check($1, $2, 1, $3) as r", [f.shopId, cid, stale])).rows[0]!.r))).toBe(false);
    // パスキーの追加（0046）の「15 分以内」は、付け替えた行の作成時刻で判定される（パスワードの変更で若返らない）
    await getPool().query("update member_sessions set created_at = now() - interval '16 minutes' where id = $1", [fresh]);
    const begin = await asService(async (c) => (await c.query<{ r: { reason?: string } }>("select member_passkey_begin($1, 'register', $2, null, $3, 1, $4) as r", [f.shopId, h("ch"), cid, fresh])).rows[0]!.r);
    expect(begin.reason).toMatch(/reauth|disabled/);
  });

  it("連携: 15 分を過ぎたセッションでは reauth。15 分以内なら連携でき、知らせの送信元が返る", async () => {
    const stale = await sessionStart(1);
    await getPool().query("update member_sessions set created_at = now() - interval '16 minutes' where id = $1", [stale]);
    expect(await link(1, stale)).toEqual({ ok: false, reason: "reauth" });
    expect(await link(1, null)).toEqual({ ok: false, reason: "session" });
    const fresh = await sessionStart(1);
    expect(await link(1, fresh)).toMatchObject({ ok: true, linked: true, mail_from: "Shop <shop@example.com>" });
    // ログイン（link でない）はセッション無しで通る。mail_from は返らない
    expect(await asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select member_oauth_login($1, 'google', 'sub-1', 'm@example.com', true, null, null) as r", [f.shopId])).rows[0]!.r)).toMatchObject({ ok: true, linked: false, mail_from: null });
  });

  it("運営者の二段階認証の登録・解除は監査ログに残る（自分の分だけ）", async () => {
    await asUser(f.ownerId, (c) => c.query("select org_member_mfa_self('enabled')"));
    await asUser(f.ownerId, (c) => c.query("select org_member_mfa_self('disabled')"));
    const rows = await getPool().query("select action, actor_kind, actor_id, target_id from audit_log where action like 'org_member.mfa_%' order by created_at");
    expect(rows.rows).toEqual([
      { action: "org_member.mfa_enabled", actor_kind: "user", actor_id: f.ownerId, target_id: f.ownerId },
      { action: "org_member.mfa_disabled", actor_kind: "user", actor_id: f.ownerId, target_id: f.ownerId },
    ]);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select org_member_mfa_self('reset')")))).toMatch(/invalid_action/);
  });
});
