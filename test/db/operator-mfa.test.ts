import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

/**
 * 0054_operator_mfa: 運営者の二段階認証を DB（PostgREST のリクエストの前の関数）で強制する。
 * withRole は PostgREST と同じく banto_pre_request() を通すので、ここでの「止まる」は本番の PostgREST でも止まる。
 */
describe.skipIf(!dbAvailable)("運営者の二段階認証（0054_operator_mfa）", () => {
  let f: Fixture;
  let orgId: string;
  let admin: string;
  let member: string;
  const as = (uid: string, aal: "aal1" | "aal2", sql: string, params: unknown[] = []) =>
    withRole("authenticated", { sub: uid, aal }, async (c) => (await c.query(sql, params)).rows);
  const addFactor = (uid: string, status = "verified") => getPool().query("insert into auth.mfa_factors (user_id, status) values ($1, $2)", [uid, status]);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "mfa-owner@example.com", slug: "mfa-shop", publish: true, stock: 5 });
    orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    admin = await createAuthUser("mfa-admin@example.com");
    member = await createAuthUser("mfa-member@example.com");
    await getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, 'admin'), ($1, $3, 'member')", [orgId, admin, member]);
  });
  afterAll(closePool);

  it("登録していない人は今までどおり（aal1 で読める）", async () => {
    expect(await as(f.ownerId, "aal1", "select id from shops where id = $1", [f.shopId])).toEqual([{ id: f.shopId }]);
  });

  it("登録した人の aal1 の JWT は、テーブルも RPC も通らない。aal2 なら通る", async () => {
    await addFactor(f.ownerId);
    expect(await expectDbError(() => as(f.ownerId, "aal1", "select id from shops"))).toMatch(/mfa_required:challenge/);
    expect(await expectDbError(() => as(f.ownerId, "aal1", "select banto_my_shops()"))).toMatch(/mfa_required:challenge/);
    expect(await expectDbError(() => as(f.ownerId, "aal1", "update products set name = 'x' where id = $1", [f.productId]))).toMatch(/mfa_required/);
    expect(await as(f.ownerId, "aal2", "select id from shops where id = $1", [f.shopId])).toEqual([{ id: f.shopId }]);
    // 確認待ち（unverified）の登録は数えない
    await addFactor(member, "unverified");
    expect(await as(member, "aal1", "select banto_mfa_state() as s")).toEqual([{ s: "ok" }]);
  });

  it("お客様の画面（anon）と特権の経路（service_role）は関係ない", async () => {
    expect((await withRole("anon", {}, (c) => c.query("select shop_public_get('mfa-shop') is not null as ok"))).rows).toEqual([{ ok: true }]);
    expect((await withRole("service_role", {}, (c) => c.query("select count(*)::int as n from shops"))).rows[0].n).toBeGreaterThan(0);
  });

  it("全員必須: owner が aal2 で入れる（aal1 や owner 以外は不可）。未登録のメンバーは enroll で止まる", async () => {
    expect(await expectDbError(() => as(admin, "aal1", "select org_set_require_mfa($1, true)", [orgId]))).toMatch(/forbidden/);
    // 登録の無い owner が必須にすると自分が締め出されるので、aal2 を求める（ここでは owner は登録済み）
    expect(await expectDbError(() => as(f.ownerId, "aal1", "select org_set_require_mfa($1, true)", [orgId]))).toMatch(/mfa_required:challenge/);
    await as(f.ownerId, "aal2", "select org_set_require_mfa($1, true)", [orgId]);
    expect(await expectDbError(() => as(admin, "aal1", "select id from organizations"))).toMatch(/mfa_required:enroll/);
    // 登録すれば challenge、済ませれば通る
    await addFactor(admin);
    expect(await expectDbError(() => as(admin, "aal1", "select id from organizations"))).toMatch(/mfa_required:challenge/);
    expect(await as(admin, "aal2", "select id from organizations")).toEqual([{ id: orgId }]);
    const audit = (await getPool().query("select action, detail from audit_log where org_id = $1 and action = 'org.require_mfa'", [orgId])).rows;
    expect(audit).toEqual([{ action: "org.require_mfa", detail: { required: true } }]);
    // 外すのは aal2 の owner なら登録の確かめ無しでよい
    await as(f.ownerId, "aal2", "select org_set_require_mfa($1, false)", [orgId]);
    expect(await as(member, "aal1", "select banto_mfa_state() as s")).toEqual([{ s: "ok" }]);
  });

  it("メンバーの登録の有無は owner / admin だけが見る", async () => {
    const rows = await as(admin, "aal2", "select user_id, has_mfa from org_members_mfa($1) order by user_id", [orgId]);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.user_id === f.ownerId)?.has_mfa).toBe(true);
    expect(rows.find((r) => r.user_id === member)?.has_mfa).toBe(false);
    expect(await as(member, "aal1", "select * from org_members_mfa($1)", [orgId])).toEqual([]);
  });

  it("登録を外す許可: 同じ組織の owner / admin。admin は owner を外せない。自分・他人の組織は不可。監査ログに残る", async () => {
    expect(await as(admin, "aal2", "select org_member_mfa_reset_authorize($1) as ok", [member])).toEqual([{ ok: true }]);
    expect(await expectDbError(() => as(admin, "aal2", "select org_member_mfa_reset_authorize($1)", [f.ownerId]))).toMatch(/forbidden/);
    expect(await as(f.ownerId, "aal2", "select org_member_mfa_reset_authorize($1) as ok", [admin])).toEqual([{ ok: true }]);
    expect(await expectDbError(() => as(f.ownerId, "aal2", "select org_member_mfa_reset_authorize($1)", [f.ownerId]))).toMatch(/forbidden/);
    expect(await expectDbError(() => as(member, "aal1", "select org_member_mfa_reset_authorize($1)", [admin]))).toMatch(/forbidden/);
    const stranger = await createShopFixture({ email: "mfa-stranger@example.com", slug: "mfa-stranger" });
    expect(await expectDbError(() => as(stranger.ownerId, "aal1", "select org_member_mfa_reset_authorize($1)", [member]))).toMatch(/forbidden/);
    const logged = (await getPool().query("select action, target_id, actor_id from audit_log where org_id = $1 and action = 'org_member.mfa_reset' order by id", [orgId])).rows;
    expect(logged).toEqual([
      { action: "org_member.mfa_reset", target_id: member, actor_id: admin },
      { action: "org_member.mfa_reset", target_id: admin, actor_id: f.ownerId },
    ]);
  });
});
