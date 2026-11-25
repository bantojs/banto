import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, closePool, createShopFixture, dbAvailable, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0177_line_test_member: LINE のテスト送信の宛先を会員のメールアドレスで引く。
 * service_role だけ・LINE と結びついた会員だけ・監査ログに会員の id（メール・UID は入れない）、誰がは X-Banto-Actor
 */
describe.skipIf(!dbAvailable)("LINE のテスト送信の宛先（0177）", () => {
  let f: Fixture;
  let lineMember: string;
  const UID = `U${"d".repeat(32)}`;
  const recipient = (email: string, actor?: string) =>
    asService(async (c) => {
      if (actor) await c.query("select set_config('request.headers', $1, true)", [JSON.stringify({ "x-banto-actor": actor })]);
      return (await c.query<{ r: Record<string, unknown> | null }>("select line_test_recipient($1, $2) as r", [f.shopId, email])).rows[0]!.r;
    });

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "lt-owner@example.com", slug: "lt-shop", publish: true });
    const pool = getPool();
    lineMember = (await pool.query<{ id: string }>("insert into customers (shop_id, email, name) values ($1, 'Tester@Example.com', 'テスト') returning id", [f.shopId])).rows[0]!.id;
    await pool.query("insert into customers (shop_id, email, name) values ($1, 'mailonly@example.com', 'メールだけ')", [f.shopId]);
    await pool.query("insert into member_identities (shop_id, provider, subject, customer_id) values ($1, 'line', $2, $3)", [f.shopId, UID, lineMember]);
  });
  afterAll(closePool);

  it("LINE と結びついた会員のメールアドレス（大文字小文字を問わない）だけ UID を返し、監査ログに会員の id を運営者の名で残す", async () => {
    const r = await recipient(" tester@example.com ", `user:${f.ownerId}`);
    expect(r).toEqual({ line_user_id: UID, customer_id: lineMember });
    const log = (await getPool().query<{ actor_kind: string; actor_id: string; target_id: string; detail: Record<string, unknown> }>(
      "select actor_kind, actor_id, target_id, detail from audit_log where action = 'line.test_recipient' and shop_id = $1", [f.shopId])).rows;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_kind: "user", actor_id: f.ownerId, target_id: lineMember, detail: {} });
    expect(JSON.stringify(log)).not.toContain(UID);
    expect(JSON.stringify(log).toLowerCase()).not.toContain("tester@example.com");
  });

  it("LINE と結びついていない会員・いないアドレス・別のショップは null（監査ログも書かない）", async () => {
    const before = (await getPool().query<{ n: string }>("select count(*) as n from audit_log where action = 'line.test_recipient'")).rows[0]!.n;
    expect(await recipient("mailonly@example.com")).toBeNull();
    expect(await recipient("nobody@example.com")).toBeNull();
    expect(await recipient("")).toBeNull();
    const other = await createShopFixture({ email: "lt-other@example.com", slug: "lt-other", publish: true });
    const r = await asService(async (c) => (await c.query<{ r: unknown }>("select line_test_recipient($1, 'tester@example.com') as r", [other.shopId])).rows[0]!.r);
    expect(r).toBeNull();
    expect((await getPool().query<{ n: string }>("select count(*) as n from audit_log where action = 'line.test_recipient'")).rows[0]!.n).toBe(before);
  });

  it("会員の id で（0178）: メールアドレスの無い会員にも。結びついていない会員・別のショップは null", async () => {
    const pool = getPool();
    const noMail = (await pool.query<{ id: string }>("insert into customers (shop_id, name) values ($1, 'メール無し') returning id", [f.shopId])).rows[0]!.id;
    const UID2 = `U${"f".repeat(32)}`;
    await pool.query("insert into member_identities (shop_id, provider, subject, customer_id) values ($1, 'line', $2, $3)", [f.shopId, UID2, noMail]);
    const byId = (shop: string, id: string) => asService(async (c) => (await c.query<{ r: Record<string, unknown> | null }>("select line_test_recipient_member($1, $2) as r", [shop, id])).rows[0]!.r);
    expect(await byId(f.shopId, noMail)).toEqual({ line_user_id: UID2, customer_id: noMail });
    expect((await pool.query<{ n: string }>("select count(*) as n from audit_log where action = 'line.test_recipient' and target_id = $1", [noMail])).rows[0]!.n).toBe("1");
    const plain = (await pool.query<{ id: string }>("select id from customers where shop_id = $1 and email = 'mailonly@example.com'", [f.shopId])).rows[0]!.id;
    expect(await byId(f.shopId, plain)).toBeNull();
    const other = await createShopFixture({ email: "lt-other2@example.com", slug: "lt-other2", publish: true });
    expect(await byId(other.shopId, noMail)).toBeNull();
  });

  it("anon・authenticated からは呼べない", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const fn of ["line_test_recipient(uuid, text)", "line_test_recipient_member(uuid, uuid)"]) {
        const r = await getPool().query<{ ok: boolean }>(`select has_function_privilege($1, '${fn}', 'execute') as ok`, [role]);
        expect(r.rows[0]!.ok).toBe(false);
      }
    }
  });
});
