import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const h = (s: string) => createHash("sha256").update(s).digest("hex");

/** 0030_admin_sessions: 監査（2026-10-18 のコード監査）の M1 / M2 / M13 */
describe.skipIf(!dbAvailable)("運営者の入口（0030_admin_sessions）", () => {
  let f: Fixture;
  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "as-owner@example.com", slug: "as-shop", publish: true });
  });
  afterAll(closePool);

  it("M1: 最初の運営者の Auth ユーザーを消しても、ショップか組織のメンバーが残っていれば「運営者なし」にならず、自己登録も開かない", async () => {
    const state = async () => (await asAnon((c) => c.query<{ r: { has_owner: boolean } }>("select banto_setup_state() as r"))).rows[0]!.r;
    expect((await state()).has_owner).toBe(true);
    await getPool().query("delete from auth.users where id = $1", [f.ownerId]);
    expect((await getPool().query("select count(*)::int as n from owners")).rows[0].n).toBe(0);
    expect((await state()).has_owner).toBe(true); // shops が残っている
    const intruder = await createAuthUser("intruder@example.com");
    expect(await expectDbError(() => asUser(intruder, (c) => c.query("insert into owners (id) values ($1)", [intruder])))).toMatch(/row-level security/);
    // ショップも組織のメンバーも無くなって初めて開く（本当に空のデプロイ）
    await getPool().query("delete from shops");
    await getPool().query("delete from org_members");
    expect((await state()).has_owner).toBe(false);
    await asUser(intruder, (c) => c.query("insert into owners (id) values ($1)", [intruder]));
    expect((await state()).has_owner).toBe(true);
  });

  it("M13: 世代は本人だけが読み、ログアウトで上がる。メンバーでなければ member=false。表は誰にも見えない", async () => {
    const owner = await createAuthUser("as-owner2@example.com");
    await getPool().query("insert into owners (id) values ($1)", [owner]);
    const me = () => asUser(owner, async (c) => (await c.query<{ r: { member: boolean; epoch?: number } }>("select banto_admin_me() as r")).rows[0]!.r);
    expect(await me()).toEqual({ member: true, epoch: 0 });
    expect(await asUser(owner, async (c) => (await c.query<{ r: number }>("select admin_session_bump() as r")).rows[0]!.r)).toBe(1);
    expect(await me()).toEqual({ member: true, epoch: 1 });
    const stranger = await createAuthUser("stranger@example.com");
    expect(await asUser(stranger, async (c) => (await c.query<{ r: unknown }>("select banto_admin_me() as r")).rows[0]!.r)).toEqual({ member: false });
    expect((await asUser(owner, (c) => c.query("select user_id from admin_users"))).rows).toHaveLength(0);
    expect(await expectDbError(() => asAnon((c) => c.query("select banto_admin_me()")))).toMatch(/permission denied/);
  });

  it("M2: 同じアドレスは 15 分に 5 回、同じ IP は 20 回まで失敗できる。成功すれば失敗は消える。service_role だけ", async () => {
    const check = (email: string, ip: string | null) => asService(async (c) => (await c.query<{ r: { allowed: boolean } }>("select admin_login_check($1, $2) as r", [h(email), ip ? h(ip) : null])).rows[0]!.r);
    const record = (email: string, ip: string | null, ok: boolean) => asService((c) => c.query("select admin_login_record($1, $2, $3)", [h(email), ip ? h(ip) : null, ok]));
    for (let i = 0; i < 5; i++) {
      expect((await check("a@example.com", "198.51.100.1")).allowed).toBe(true);
      await record("a@example.com", "198.51.100.1", false);
    }
    expect((await check("a@example.com", "198.51.100.2")).allowed).toBe(false);
    expect((await check("b@example.com", "198.51.100.1")).allowed).toBe(true);
    await getPool().query("update admin_login_attempts set created_at = now() - interval '16 minutes'");
    expect((await check("a@example.com", "198.51.100.1")).allowed).toBe(true);
    for (let i = 0; i < 20; i++) await record(`u${i}@example.com`, "198.51.100.9", false);
    expect((await check("z@example.com", "198.51.100.9")).allowed).toBe(false);
    expect((await check("z@example.com", "198.51.100.10")).allowed).toBe(true);
    for (let i = 0; i < 5; i++) await record("c@example.com", null, false);
    expect((await check("c@example.com", null)).allowed).toBe(false);
    await record("c@example.com", null, true);
    expect((await check("c@example.com", null)).allowed).toBe(true);
    expect(await expectDbError(() => asAnon((c) => c.query("select admin_login_check($1, null)", [h("x")])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select admin_login_record($1, null, false)", [h("x")])))).toMatch(/permission denied/);
  });
});
