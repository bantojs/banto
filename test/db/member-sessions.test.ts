import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** 会員のセッションを端末ごとに持つ（0045_member_sessions、監査 M9） */
describe.skipIf(!dbAvailable)("会員のセッション（0045_member_sessions）", () => {
  let a: Fixture;
  let b: Fixture;
  let alice: string;
  let bob: string;
  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "owner-a@example.com", slug: "shop-a", publish: true });
    b = await createShopFixture({ email: "owner-b@example.com", slug: "shop-b", publish: true });
    alice = (await getPool().query("insert into customers (shop_id, email) values ($1, 'alice@example.com') returning id", [a.shopId])).rows[0].id;
    bob = (await getPool().query("insert into customers (shop_id, email) values ($1, 'bob@example.com') returning id", [a.shopId])).rows[0].id;
  });
  beforeEach(async () => {
    await getPool().query("delete from member_sessions");
    await getPool().query("update customers set session_epoch = 0");
  });
  afterAll(closePool);

  const q = <T>(sql: string, params: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(sql, params)).rows[0]!.r);
  const start = (shopId: string, cid: string, ep = 0, kind = "web", ttl = 3600) => q<string | null>("select member_session_start($1, $2, $3, $4, 'Chrome / macOS', $5) as r", [shopId, cid, ep, kind, ttl]);
  const check = (shopId: string, cid: string, sid: string, ep = 0) => q<boolean>("select member_session_check($1, $2, $3, $4) as r", [shopId, cid, ep, sid]);
  const refresh = (cid: string, sid: string, gen: number, ep = 0) => q<{ ok: boolean; gen?: number; reason?: string }>("select member_session_refresh($1, $2, $3, $4, $5) as r", [a.shopId, cid, ep, sid, gen]);
  const revoke = (shopId: string, cid: string, sid: string, ep = 0, reason = "revoked") => q<boolean>("select member_session_revoke($1, $2, $3, $4, $5) as r", [shopId, cid, ep, sid, reason]);
  const list = (cid: string, ep = 0) => q<{ id: string; kind: string; label: string | null }[] | null>("select member_sessions_list($1, $2, $3) as r", [a.shopId, cid, ep]);

  it("作る・確かめる・取り消す。世代を上げる（全端末からログアウト）と、それまでの行は通らない", async () => {
    const sid = (await start(a.shopId, alice))!;
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(await check(a.shopId, alice, sid)).toBe(true);
    // 世代が今と違えば作らない（ログインの途中で全端末からログアウトされた）
    expect(await start(a.shopId, alice, 7)).toBeNull();
    // 他人・他店・違う世代では通らない
    expect(await check(a.shopId, bob, sid)).toBe(false);
    expect(await check(b.shopId, alice, sid)).toBe(false);
    expect(await check(a.shopId, alice, sid, 1)).toBe(false);

    const other = (await start(a.shopId, alice))!;
    expect(await revoke(a.shopId, alice, other)).toBe(true);
    expect(await check(a.shopId, alice, other)).toBe(false);
    expect(await check(a.shopId, alice, sid)).toBe(true);
    // ほかの会員のセッションは取り消せない
    expect(await revoke(a.shopId, bob, sid)).toBe(false);
    expect(await check(a.shopId, alice, sid)).toBe(true);

    await asService((c) => c.query("select member_logout_all($1, $2, 0)", [a.shopId, alice]));
    expect(await check(a.shopId, alice, sid)).toBe(false);
    expect(await check(a.shopId, alice, sid, 1)).toBe(false);
    expect(await list(alice, 0)).toBeNull();
    expect(await list(alice, 1)).toEqual([]);
  });

  it("期限を過ぎた行は通らない（延ばさない）", async () => {
    const sid = (await start(a.shopId, alice))!;
    await getPool().query("update member_sessions set expires_at = now() - interval '1 second' where id = $1", [sid]);
    expect(await check(a.shopId, alice, sid)).toBe(false);
    expect(await expectDbError(() => start(a.shopId, alice, 0, "web", 10))).toMatch(/invalid_session/);
    expect(await expectDbError(() => start(a.shopId, alice, 0, "other"))).toMatch(/invalid_session/);
  });

  it("refresh は回るたびに世代が進む。直後の同時の呼び出しは通し、それより古い世代は使い回しとしてセッションごと止める", async () => {
    const sid = (await start(a.shopId, alice, 0, "api"))!;
    expect(await refresh(alice, sid, 0)).toMatchObject({ ok: true, gen: 1 });
    // 同時に refresh した 2 つ目（30 秒以内）: 同じ世代を返す
    expect(await refresh(alice, sid, 0)).toMatchObject({ ok: true, gen: 1 });
    expect(await refresh(alice, sid, 1)).toMatchObject({ ok: true, gen: 2 });
    // 2 つ前 = 使い回し
    expect(await refresh(alice, sid, 0)).toEqual({ ok: false, reason: "reuse" });
    expect((await getPool().query("select revoked_reason from member_sessions where id = $1", [sid])).rows[0].revoked_reason).toBe("reuse");
    expect(await refresh(alice, sid, 2)).toEqual({ ok: false, reason: "invalid" });

    // 1 つ前でも、回してから時間が経っていれば使い回し
    const sid2 = (await start(a.shopId, alice, 0, "api"))!;
    expect(await refresh(alice, sid2, 0)).toMatchObject({ ok: true, gen: 1 });
    await getPool().query("update member_sessions set rotated_at = now() - interval '1 minute' where id = $1", [sid2]);
    expect(await refresh(alice, sid2, 0)).toEqual({ ok: false, reason: "reuse" });

    // お店の画面の Cookie のセッションは refresh できない。ほかの会員のセッションも
    const web = (await start(a.shopId, alice))!;
    expect(await refresh(alice, web, 0)).toEqual({ ok: false, reason: "invalid" });
    const sid3 = (await start(a.shopId, alice, 0, "api"))!;
    expect(await refresh(bob, sid3, 0)).toEqual({ ok: false, reason: "invalid" });
  });

  it("一覧は今の世代の生きている行だけ。1 人 20 まで（超えたら古いものから取り消す）", async () => {
    const first = (await start(a.shopId, alice))!;
    const api = (await start(a.shopId, alice, 0, "api"))!;
    const gone = (await start(a.shopId, alice))!;
    await revoke(a.shopId, alice, gone, 0, "logout");
    const rows = (await list(alice))!;
    expect(rows.map((r) => r.id).sort()).toEqual([first, api].sort());
    expect(rows.find((r) => r.id === api)).toMatchObject({ kind: "api", label: "Chrome / macOS" });
    expect(await list(bob)).toEqual([]);

    for (let i = 0; i < 19; i++) await start(a.shopId, alice);
    expect((await list(alice))!).toHaveLength(20);
    expect(await check(a.shopId, alice, first)).toBe(false);
    expect((await getPool().query("select revoked_reason from member_sessions where id = $1", [first])).rows[0].revoked_reason).toBe("limit");
  });

  it("片付け: 期限切れ・取り消してから 1 日・古い世代の行を消す。退会で消える", async () => {
    const live = (await start(a.shopId, bob))!;
    const old = (await start(a.shopId, alice))!;
    await getPool().query("update member_sessions set expires_at = now() - interval '1 second' where id = $1", [old]);
    expect(await q<number>("select member_session_cleanup() as r", [])).toBe(1);
    expect((await getPool().query("select id from member_sessions")).rows.map((r) => r.id)).toEqual([live]);
    await asService((c) => c.query("select member_withdraw($1, $2, 0)", [a.shopId, bob]));
    expect((await getPool().query("select count(*)::int as n from member_sessions")).rows[0].n).toBe(0);
    bob = (await getPool().query("insert into customers (shop_id, email) values ($1, 'bob@example.com') returning id", [a.shopId])).rows[0].id;
  });

  it("service_role だけ。表は誰にも見せない", async () => {
    const sid = (await start(a.shopId, alice))!;
    expect(await expectDbError(() => asAnon((c) => c.query("select member_session_start($1, $2, 0, 'web', null, 3600)", [a.shopId, alice])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select member_session_check($1, $2, 0, $3)", [a.shopId, alice, sid])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select member_sessions_list($1, $2, 0)", [a.shopId, alice])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asAnon((c) => c.query("select banto_member_session_live($1, $2, 0, $3)", [a.shopId, alice, sid])))).toMatch(/permission denied/);
    const seen = await asUser(a.ownerId, async (c) => (await c.query("select id from member_sessions").catch(() => ({ rows: [] }))).rows);
    expect(seen).toEqual([]);
  });
});
