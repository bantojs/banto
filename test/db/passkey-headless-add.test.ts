import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { asAnon, asService, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/**
 * 0070_mod_passkey_headless_add: ヘッドレスの会員がパスキーを追加するための券。
 * ログインしてから 15 分以内の api のセッションだけが出せ、2 分・1 回限り。券を出した後にログアウトしていれば使えない
 */
describe.skipIf(!dbAvailable)("パスキーの追加の券（0070）", () => {
  let a: Fixture;
  let cid: string;
  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "pk-a@example.com", slug: "pk-a", publish: true });
    const pool = getPool();
    await pool.query("update shops set domain = 'pk.example.com', settings = settings || '{\"members_enabled\":true,\"modules\":{\"passkey\":true}}'::jsonb where id = $1", [a.shopId]);
    cid = (await pool.query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'm@example.com') returning id", [a.shopId])).rows[0]!.id;
  });
  afterAll(closePool);

  const session = (kind: "api" | "web") => asService(async (c) => (await c.query<{ r: string }>("select member_session_start($1, $2, 0, $3, 'test', 86400) as r", [a.shopId, cid, kind])).rows[0]!.r);
  const create = (sid: string, token: string) => asService(async (c) => (await c.query<{ r: J }>("select member_passkey_ticket_create($1, $2, 0, $3, $4) as r", [a.shopId, cid, sid, hash(token)])).rows[0]!.r);
  const take = (id: unknown, token: string) => asService(async (c) => (await c.query<{ r: J }>("select member_passkey_ticket_take($1, $2, $3) as r", [a.shopId, id, hash(token)])).rows[0]!.r);

  it("15 分以内の api のセッションだけが券を出せる。web のセッション・古いセッションは断る。anon は呼べない", async () => {
    const api = await session("api");
    expect(await create(api, "t1")).toMatchObject({ ok: true });
    expect(await create(await session("web"), "t2")).toEqual({ ok: false, reason: "session" });
    const old = await session("api");
    await getPool().query("update member_sessions set created_at = now() - interval '16 minutes' where id = $1", [old]);
    expect(await create(old, "t3")).toEqual({ ok: false, reason: "reauth" });
    expect(await expectDbError(() => asAnon((c) => c.query("select member_passkey_ticket_create($1, $2, 0, $3, $4)", [a.shopId, cid, api, hash("x")])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asAnon((c) => c.query("select * from member_passkey_tickets")))).toMatch(/permission denied/);
  });

  it("券は 1 回限り・トークンが合うときだけ・2 分まで。出した後にログアウトしたら使えない", async () => {
    const api = await session("api");
    const t = await create(api, "ok-token");
    expect(await take(t["id"], "wrong")).toEqual({ ok: false });
    expect(await take(t["id"], "ok-token")).toEqual({ ok: true, customer_id: cid, session_epoch: 0, email: "m@example.com" });
    expect(await take(t["id"], "ok-token")).toEqual({ ok: false });
    const t2 = await create(api, "late");
    await getPool().query("update member_passkey_tickets set expires_at = now() - interval '1 second' where id = $1", [t2["id"]]);
    expect(await take(t2["id"], "late")).toEqual({ ok: false });
    const t3 = await create(api, "revoked");
    await getPool().query("update member_sessions set revoked_at = now(), revoked_reason = 'logout' where id = $1", [api]);
    expect(await take(t3["id"], "revoked")).toEqual({ ok: false });
  });

  it("パスキーが使えないショップ（独自ドメインなし）では出さない", async () => {
    const api = await session("api");
    await getPool().query("update shops set domain = null where id = $1", [a.shopId]);
    expect(await create(api, "nodomain")).toEqual({ ok: false, reason: "disabled" });
  });
});
