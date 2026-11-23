import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const h = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * 0166_member_email_change: 会員が自分でメールアドレスを変える。
 * ログインしてから 15 分以内のセッションだけ・コードは 15 分 5 回・回数の上限・ほかの会員のアドレスは送らずに変えない・
 * 変わったら世代を上げて今のセッションの行だけ付け替え・監査ログ・1 日のメールの上限・service_role だけ
 */
describe.skipIf(!dbAvailable)("会員のメールアドレスの変更（0166）", () => {
  let f: Fixture;
  type R = Record<string, unknown>;
  const newCustomer = async (email: string) => (await getPool().query<{ id: string }>("insert into customers (shop_id, email) values ($1, $2) returning id", [f.shopId, email])).rows[0]!.id;
  const epochOf = async (cid: string) => (await getPool().query<{ e: number }>("select session_epoch as e from customers where id = $1", [cid])).rows[0]!.e;
  const sessionStart = (cid: string, epoch: number) =>
    asService(async (c) => (await c.query<{ r: string }>("select member_session_start($1, $2, $3, 'web', 'dev', 86400) as r", [f.shopId, cid, epoch])).rows[0]!.r);
  const start = (cid: string, epoch: number, sid: string | null, email: string, code: string, ip: string | null = h("ip-1")) =>
    asService(async (c) => (await c.query<{ r: R }>("select member_email_change_start($1, $2, $3, $4, $5, $6, $7) as r", [f.shopId, cid, epoch, sid, email, h(code), ip])).rows[0]!.r);
  const verify = (cid: string, epoch: number, sid: string | null, code: string) =>
    asService(async (c) => (await c.query<{ r: R }>("select member_email_change_verify($1, $2, $3, $4, $5) as r", [f.shopId, cid, epoch, sid, h(code)])).rows[0]!.r);
  const stale = (sid: string) => getPool().query("update member_sessions set created_at = now() - interval '16 minutes', authenticated_at = now() - interval '16 minutes' where id = $1", [sid]);
  const pending = async (cid: string) => (await getPool().query<{ n: number }>("select count(*)::int as n from member_email_changes where customer_id = $1", [cid])).rows[0]!.n;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "mec@example.com", slug: "mec-shop", publish: true });
    await getPool().query("update shops set settings = settings || '{\"members_enabled\": true}' where id = $1", [f.shopId]);
    await getPool().query("insert into hook_endpoints (shop_id, name, url, events, settings) values ($1, 'mail', 'https://banto.invalid/plugins/email_resend', '{}', '{\"from\": \"Shop <shop@example.com>\"}')", [f.shopId]);
  });
  afterAll(closePool);

  it("セッション無し・15 分を過ぎたセッション・同じアドレス・形の誤りを断る", async () => {
    const cid = await newCustomer("a@example.com");
    expect(await start(cid, 0, null, "b@example.com", "111111")).toEqual({ ok: false, reason: "session" });
    const old = await sessionStart(cid, 0);
    await stale(old);
    expect(await start(cid, 0, old, "b@example.com", "111111")).toEqual({ ok: false, reason: "reauth" });
    const sid = await sessionStart(cid, 0);
    expect(await start(cid, 1, sid, "b@example.com", "111111")).toEqual({ ok: false, reason: "session" }); // 世代が違う
    expect(await start(cid, 0, sid, "A@Example.com", "111111")).toEqual({ ok: false, reason: "same" });
    expect(await expectDbError(() => start(cid, 0, sid, "nope", "111111"))).toMatch(/invalid_email/);
    expect(await pending(cid)).toBe(0);
    // コードを送った後に 15 分を過ぎたら、確かめも reauth
    expect(await start(cid, 0, sid, "b@example.com", "123456")).toEqual({ ok: true, send: true, mail_from: "Shop <shop@example.com>" });
    await stale(sid);
    expect(await verify(cid, 0, sid, "123456")).toEqual({ ok: false, reason: "reauth" });
    expect((await getPool().query("select email from customers where id = $1", [cid])).rows[0]).toEqual({ email: "a@example.com" });
  });

  it("コードは 5 回まで（5 回目の間違いで使えなくなる）。新しく送ると前のコードは無効", async () => {
    const cid = await newCustomer("c@example.com");
    const sid = await sessionStart(cid, 0);
    await start(cid, 0, sid, "d@example.com", "222222");
    for (let i = 0; i < 4; i++) expect(await verify(cid, 0, sid, "000000")).toEqual({ ok: false, reason: "invalid" });
    expect(await verify(cid, 0, sid, "000000")).toEqual({ ok: false, reason: "expired" });
    expect(await verify(cid, 0, sid, "222222")).toEqual({ ok: false, reason: "expired" });
    await start(cid, 0, sid, "d@example.com", "333333");
    await start(cid, 0, sid, "d@example.com", "444444");
    expect(await verify(cid, 0, sid, "333333")).toEqual({ ok: false, reason: "invalid" });
    // 期限切れ
    await getPool().query("update member_email_changes set expires_at = now() - interval '1 second' where customer_id = $1 and consumed_at is null", [cid]);
    expect(await verify(cid, 0, sid, "444444")).toEqual({ ok: false, reason: "expired" });
  });

  it("合えば変わる: 世代を上げて今のセッションの行だけ付け替え、ログインのコードを無効にし、監査ログに残す（アドレスはハッシュ）", async () => {
    const cid = await newCustomer("e@example.com");
    const other = await sessionStart(cid, 0);
    const sid = await sessionStart(cid, 0);
    await getPool().query("insert into member_login_challenges (shop_id, email, code_hash, link_hash, expires_at) values ($1, 'e@example.com', $2, $3, now() + interval '10 minutes')", [f.shopId, h("x1"), h("y1")]);
    await start(cid, 0, sid, "F@example.com", "555555");
    const r = await verify(cid, 0, sid, "555555");
    expect(r).toMatchObject({ ok: true, old_email: "e@example.com", new_email: "f@example.com", epoch: 1, mail_from: "Shop <shop@example.com>" });
    expect(typeof r["authenticated_at"]).toBe("string");
    expect(await epochOf(cid)).toBe(1);
    const check = (s: string, ep: number) => asService(async (c) => (await c.query<{ r: boolean }>("select member_session_check($1, $2, $3, $4) as r", [f.shopId, cid, ep, s])).rows[0]!.r);
    expect(await check(sid, 1)).toBe(true);
    expect(await check(other, 0)).toBe(false);
    expect(await check(other, 1)).toBe(false);
    expect((await getPool().query("select count(*)::int as n from member_login_challenges where email = 'e@example.com' and consumed_at is null")).rows[0]).toEqual({ n: 0 });
    // 同じコードは 2 度使えない
    expect(await verify(cid, 1, sid, "555555")).toEqual({ ok: false, reason: "expired" });
    const audit = await getPool().query<{ action: string; target_id: string; detail: R }>("select action, target_id, detail from audit_log where action = 'customer.email_changed' and target_id = $1", [cid]);
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0]!.detail)).not.toContain("@");
  });

  it("ほかの会員が使っているアドレス: 始めるときは送らない（答えは ok）。送った後に使われたら unavailable", async () => {
    const cid = await newCustomer("g@example.com");
    await newCustomer("taken@example.com");
    const sid = await sessionStart(cid, 0);
    expect(await start(cid, 0, sid, "Taken@example.com", "666666")).toEqual({ ok: true, send: false, mail_from: "Shop <shop@example.com>" });
    expect(await pending(cid)).toBe(0);
    await start(cid, 0, sid, "later@example.com", "777777");
    await newCustomer("later@example.com");
    expect(await verify(cid, 0, sid, "777777")).toEqual({ ok: false, reason: "unavailable" });
    expect(await epochOf(cid)).toBe(0);
  });

  it("同じアドレスへの変更が重なっても、変わるのは 1 人だけ", async () => {
    const c1 = await newCustomer("r1@example.com");
    const c2 = await newCustomer("r2@example.com");
    const s1 = await sessionStart(c1, 0);
    const s2 = await sessionStart(c2, 0);
    await start(c1, 0, s1, "race@example.com", "111111");
    await start(c2, 0, s2, "race@example.com", "222222");
    // 1 人目の確かめをコミットせずに止めておき、2 人目を走らせてから 1 人目をコミットする
    const a = await getPool().connect();
    try {
      await a.query("begin");
      await a.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      await a.query("set local role service_role");
      const first = (await a.query<{ r: R }>("select member_email_change_verify($1, $2, 0, $3, $4) as r", [f.shopId, c1, s1, h("111111")])).rows[0]!.r;
      expect(first).toMatchObject({ ok: true, new_email: "race@example.com" });
      const second = verify(c2, 0, s2, "222222");
      await new Promise((r) => setTimeout(r, 150));
      await a.query("commit");
      expect(await second).toEqual({ ok: false, reason: "unavailable" });
    } finally {
      a.release();
    }
    const rows = await getPool().query("select id from customers where shop_id = $1 and email = 'race@example.com'", [f.shopId]);
    expect(rows.rows).toEqual([{ id: c1 }]);
  });

  it("回数の上限: 会員ごとに 15 分 3 回（4 回目からは送らない。答えは同じ）、同じ IP から 1 時間 30 回", async () => {
    const cid = await newCustomer("h@example.com");
    const sid = await sessionStart(cid, 0);
    for (let i = 0; i < 3; i++) expect(await start(cid, 0, sid, `h${i}@example.com`, "121212")).toMatchObject({ ok: true, send: true });
    expect(await start(cid, 0, sid, "h9@example.com", "121212")).toMatchObject({ ok: true, send: false });
    expect(await pending(cid)).toBe(3);
    // 1 日 10 回（15 分より前の分も数える）
    await getPool().query("update member_email_changes set created_at = now() - interval '1 hour' where customer_id = $1", [cid]);
    await getPool().query("insert into member_email_changes (shop_id, customer_id, new_email, code_hash, expires_at, created_at) select $1, $2, 'x@example.com', $3, now(), now() - interval '2 hours' from generate_series(1, 7)", [f.shopId, cid, h("z")]);
    expect(await start(cid, 0, sid, "h10@example.com", "121212")).toMatchObject({ ok: true, send: false });
    // 同じ IP
    const ip = h("ip-many");
    const others = await Promise.all(Array.from({ length: 3 }, (_, i) => newCustomer(`ipx${i}@example.com`)));
    await getPool().query("insert into member_email_changes (shop_id, customer_id, new_email, code_hash, ip_hash, expires_at) select $1, $2, 'y@example.com', $3, $4, now() from generate_series(1, 30)", [f.shopId, others[0], h("z"), ip]);
    const s = await sessionStart(others[1]!, 0);
    expect(await start(others[1]!, 0, s, "ipnew@example.com", "131313", ip)).toMatchObject({ ok: true, send: false });
    expect(await start(others[1]!, 0, s, "ipnew@example.com", "131313", h("ip-other"))).toMatchObject({ ok: true, send: true });
  });

  it("送ったコードはプランの 1 日のメール（mail_per_day）に数える", async () => {
    const cid = await newCustomer("p@example.com");
    const sid = await sessionStart(cid, 0);
    const used = (await getPool().query<{ n: string }>("select banto_plan_mail_count() as n")).rows[0]!.n;
    await getPool().query("select site_settings_set('plan_limits', $1::jsonb)", [JSON.stringify({ mail_per_day: Number(used) + 1 })]);
    try {
      expect(await start(cid, 0, sid, "p1@example.com", "141414")).toMatchObject({ ok: true, send: true });
      expect(Number((await getPool().query<{ n: string }>("select banto_plan_mail_count() as n")).rows[0]!.n)).toBe(Number(used) + 1);
      expect(await expectDbError(() => start(cid, 0, sid, "p2@example.com", "151515"))).toMatch(/plan_limit_exceeded:mail_per_day/);
      // 断ったときは前のコードも生きたまま（まとめて戻る）
      expect(await verify(cid, 0, sid, "141414")).toMatchObject({ ok: true, new_email: "p1@example.com" });
    } finally {
      await getPool().query("select site_settings_set('plan_limits', '{}'::jsonb)");
    }
  });

  it("service_role だけ: anon・authenticated は関数も表も触れない", async () => {
    const cid = await newCustomer("q@example.com");
    for (const run of [asAnon, (fn: Parameters<typeof asAnon>[0]) => asUser(f.ownerId, fn)]) {
      expect(await expectDbError(() => run((c) => c.query("select member_email_change_start($1, $2, 0, null, 'z@example.com', $3, null)", [f.shopId, cid, h("1")])))).toMatch(/permission denied/);
      expect(await expectDbError(() => run((c) => c.query("select member_email_change_verify($1, $2, 0, null, $3)", [f.shopId, cid, h("1")])))).toMatch(/permission denied/);
      expect(await expectDbError(() => run((c) => c.query("select * from member_email_changes")))).toMatch(/permission denied/);
    }
  });

  it("会員機能が OFF・メールの送信元が無いショップでは始められない", async () => {
    const cid = await newCustomer("s@example.com");
    const sid = await sessionStart(cid, 0);
    await getPool().query("update hook_endpoints set settings = '{}' where shop_id = $1", [f.shopId]);
    try {
      expect(await expectDbError(() => start(cid, 0, sid, "s2@example.com", "161616"))).toMatch(/mail_not_configured/);
    } finally {
      await getPool().query("update hook_endpoints set settings = '{\"from\": \"Shop <shop@example.com>\"}' where shop_id = $1", [f.shopId]);
    }
    await getPool().query("update shops set settings = settings || '{\"members_enabled\": false}' where id = $1", [f.shopId]);
    try {
      expect(await expectDbError(() => start(cid, 0, sid, "s2@example.com", "161616"))).toMatch(/members_disabled/);
    } finally {
      await getPool().query("update shops set settings = settings || '{\"members_enabled\": true}' where id = $1", [f.shopId]);
    }
  });
});
