import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const h = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * 0053_plan_mail_limit: プランの上限 mail_per_day（会員のログインのコード + 組織への招待の 1 日の数、デプロイ全体）。
 * - 文単位の AFTER INSERT トリガー（member_login_challenges / org_invitations）。上限が無ければ数えない
 * - 値の検査と書き手は 0052 と同じ。banto_plan_usage に mail_per_day が出る
 */
describe.skipIf(!dbAvailable)("1 日のメールの上限（0053_plan_mail_limit）", () => {
  let a: Fixture;
  let orgId: string;
  const setLimits = (v: unknown) => getPool().query("select site_settings_set('plan_limits', $1::jsonb)", [JSON.stringify(v)]);
  const start = (email: string) =>
    asService((c) => c.query("select member_login_start($1, $2, $3, $4, null, null)", [a.shopId, email, h(`code:${email}`), h(`link:${email}`)]));
  const invite = (email: string) =>
    asUser(a.ownerId, (c) => c.query("select org_invite($1, $2, 'member', '[]'::jsonb, $3)", [orgId, email, h(`inv:${email}`)]));

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "pm-a@example.com", slug: "pm-a", publish: true });
    orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [a.shopId])).rows[0]!.org_id;
    await getPool().query(`update shops set settings = settings || '{"members_enabled": true}'::jsonb where id = $1`, [a.shopId]);
    await getPool().query("insert into hook_endpoints (shop_id, name, url, events, settings) values ($1, 'mail', 'https://banto.invalid/plugins/email_resend', '{}', '{\"from\": \"Shop <shop@example.com>\"}')", [a.shopId]);
  });
  afterAll(closePool);

  it("mail_per_day を受け付ける（ほかの鍵と同じ検査）。上限が無ければ数えない", async () => {
    await setLimits({ mail_per_day: 3 });
    expect(await expectDbError(() => setLimits({ mail_per_day: 0 }))).toMatch(/invalid_value/);
    expect(await expectDbError(() => setLimits({ mail_per_day: "3" }))).toMatch(/invalid_value/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select site_settings_set('plan_limits', '{\"mail_per_day\": 1}'::jsonb)")))).toMatch(/forbidden/);
    await setLimits({});
    for (const e of ["u1@example.com", "u2@example.com", "u3@example.com", "u4@example.com"]) await start(e);
    expect((await getPool().query<{ n: string }>("select count(*)::text as n from member_login_challenges")).rows[0]!.n).toBe("4");
    await getPool().query("delete from member_login_challenges");
  });

  it("ログインのコードと招待を合わせて数え、超えた文だけ止まる。使用量に出る", async () => {
    await setLimits({ mail_per_day: 3 });
    await start("m1@example.com");
    await invite("s1@example.com");
    await start("m2@example.com"); // 3 通目 = 上限ちょうど
    expect(await expectDbError(() => start("m3@example.com"))).toMatch(/plan_limit_exceeded:mail_per_day:3/);
    expect(await expectDbError(() => invite("s2@example.com"))).toMatch(/plan_limit_exceeded:mail_per_day:3/);
    expect((await getPool().query<{ n: string }>("select count(*)::text as n from member_login_challenges")).rows[0]!.n).toBe("2");
    expect((await getPool().query<{ n: string }>("select count(*)::text as n from org_invitations")).rows[0]!.n).toBe("1");
    const usage = await asUser(a.ownerId, async (c) => (await c.query<{ r: { limits: Record<string, number>; usage: Record<string, number> } }>("select banto_plan_usage() as r")).rows[0]!.r);
    expect(usage.limits).toEqual({ mail_per_day: 3 });
    expect(usage.usage["mail_per_day"]).toBe(3);
    // 昨日の分は数えない
    await getPool().query("update member_login_challenges set created_at = now() - interval '2 days'");
    await start("m3@example.com");
    expect((await asUser(a.ownerId, async (c) => (await c.query<{ r: { usage: Record<string, number> } }>("select banto_plan_usage() as r")).rows[0]!.r)).usage["mail_per_day"]).toBe(2);
    await setLimits({});
  });
});
