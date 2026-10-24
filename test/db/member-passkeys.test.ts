import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** 本番は Worker が HMAC（サイトの秘密）を渡す。DB から見れば 64 桁の 16 進なら何でもよい */
const h = (s: string) => createHash("sha256").update(s).digest("hex");
const KEY = "pQECAyYgASFYIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const cred = (n: number) => `cred-${String(n).padStart(20, "0")}`;

/** パスキー（0046_mod_passkey） */
describe.skipIf(!dbAvailable)("パスキー（0046_mod_passkey）", () => {
  let a: Fixture;
  let b: Fixture;
  let alice: string;
  let bob: string;
  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "owner-a@example.com", slug: "shop-a", publish: true });
    b = await createShopFixture({ email: "owner-b@example.com", slug: "shop-b", publish: true });
    await getPool().query(`update shops set domain = 'shop-a.example.jp', settings = settings || '{"members_enabled": true, "modules": {"passkey": true}}' where id = $1`, [a.shopId]);
    await getPool().query("insert into hook_endpoints (shop_id, name, url, events, settings) values ($1, 'mail', 'https://banto.invalid/plugins/email_resend', '{}', '{\"from\": \"Shop <shop@example.com>\"}')", [a.shopId]);
    alice = (await getPool().query("insert into customers (shop_id, email) values ($1, 'alice@example.com') returning id", [a.shopId])).rows[0].id;
    bob = (await getPool().query("insert into customers (shop_id, email) values ($1, 'bob@example.com') returning id", [a.shopId])).rows[0].id;
  });
  beforeEach(async () => {
    await getPool().query("delete from member_passkeys; delete from member_passkey_challenges; delete from member_sessions");
    await getPool().query("update customers set session_epoch = 0");
    await getPool().query("update shops set domain = 'shop-a.example.jp' where id = $1", [a.shopId]);
  });
  afterAll(closePool);

  const q = <T>(sql: string, params: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(sql, params)).rows[0]!.r);
  type Begin = { ok: boolean; reason?: string; challenge_id?: string; rp_id?: string; exclude?: string[]; user?: { email: string } };
  type Res = { ok: boolean; reason?: string; customer_id?: string; id?: string; email?: string; mail_from?: string | null };
  const session = (cid: string, kind = "web") => q<string>("select member_session_start($1, $2, 0, $3, null, 3600) as r", [a.shopId, cid, kind]);
  const beginLogin = (ch: string, ip: string | null = null, shopId = a.shopId) => q<Begin>("select member_passkey_begin($1, 'login', $2, $3) as r", [shopId, h(ch), ip ? h(ip) : null]);
  const beginRegister = (ch: string, cid: string, sid: string, ep = 0) => q<Begin>("select member_passkey_begin($1, 'register', $2, null, $3, $4, $5) as r", [a.shopId, h(ch), cid, ep, sid]);
  const register = (id: string, ch: string, cid: string, sid: string, credId: string, rpId = "shop-a.example.jp") =>
    q<Res>("select member_passkey_register($1, $2, $3, $4, 0, $5, $6, $7, -7, 0, $8, true, 'Chrome / macOS') as r", [a.shopId, id, h(ch), cid, sid, credId, KEY, rpId]);
  const login = (id: string, ch: string, passkeyId: string, count = 0) => q<Res>("select member_passkey_login($1, $2, $3, $4, $5, false) as r", [a.shopId, id, h(ch), passkeyId, count]);
  const lookup = (credId: string) => q<{ id: string; customer_id: string } | null>("select member_passkey_lookup($1, $2) as r", [a.shopId, credId]);

  async function addKey(cid: string, credId: string): Promise<string> {
    const sid = await session(cid);
    const bg = await beginRegister(`r-${credId}`, cid, sid);
    const r = await register(bg.challenge_id!, `r-${credId}`, cid, sid, credId);
    expect(r).toMatchObject({ ok: true, email: cid === alice ? "alice@example.com" : "bob@example.com", mail_from: "Shop <shop@example.com>" });
    return r.id!;
  }

  it("登録 → 引く → ログイン。challenge は 1 回限りで、目的・会員・セッションが合うものだけ", async () => {
    const sid = await session(alice);
    const bg = await beginRegister("c1", alice, sid);
    expect(bg).toMatchObject({ ok: true, rp_id: "shop-a.example.jp", exclude: [], user: { email: "alice@example.com" } });
    // 違う challenge・ほかの会員・ほかのセッションでは使えない
    expect(await register(bg.challenge_id!, "other", alice, sid, cred(1))).toEqual({ ok: false, reason: "expired" });
    const bg2 = await beginRegister("c2", alice, sid);
    const bobSid = await session(bob);
    expect(await register(bg2.challenge_id!, "c2", bob, bobSid, cred(1))).toEqual({ ok: false, reason: "expired" });
    const bg3 = await beginRegister("c3", alice, sid);
    const r = await register(bg3.challenge_id!, "c3", alice, sid, cred(1));
    expect(r).toMatchObject({ ok: true });
    expect(await register(bg3.challenge_id!, "c3", alice, sid, cred(2))).toEqual({ ok: false, reason: "expired" });
    expect((await beginRegister("c4", alice, sid)).exclude).toEqual([cred(1)]);

    expect(await lookup(cred(1))).toMatchObject({ id: r.id, customer_id: alice });
    expect(await lookup(cred(9))).toBeNull();
    const lg = await beginLogin("l1", "198.51.100.1");
    expect(lg).toMatchObject({ ok: true, rp_id: "shop-a.example.jp" });
    // 登録の challenge ではログインできない
    const reg = await beginRegister("c5", alice, sid);
    expect(await login(reg.challenge_id!, "c5", r.id!)).toEqual({ ok: false, reason: "expired" });
    expect(await login(lg.challenge_id!, "l1", r.id!)).toMatchObject({ ok: true, customer_id: alice, email: "alice@example.com" });
    expect(await login(lg.challenge_id!, "l1", r.id!)).toEqual({ ok: false, reason: "expired" });
    // 期限切れ
    const old = await beginLogin("l2");
    await getPool().query("update member_passkey_challenges set expires_at = now() - interval '1 second' where id = $1", [old.challenge_id]);
    expect(await login(old.challenge_id!, "l2", r.id!)).toEqual({ ok: false, reason: "expired" });
  });

  it("署名の回数: どちらも 0 なら数えない。数える認証器は前より進んでいなければ通さない", async () => {
    const id = await addKey(alice, cred(1));
    const at = async (ch: string, n: number) => login((await beginLogin(ch)).challenge_id!, ch, id, n);
    expect(await at("a", 0)).toMatchObject({ ok: true });
    expect(await at("b", 0)).toMatchObject({ ok: true });
    expect(await at("c", 5)).toMatchObject({ ok: true });
    expect(await at("d", 5)).toEqual({ ok: false, reason: "counter" });
    expect(await at("e", 0)).toEqual({ ok: false, reason: "counter" });
    expect(await at("f", 6)).toMatchObject({ ok: true });
  });

  it("追加はログインしてから 15 分以内のお店の画面のセッションだけ。10 個まで。同じパスキーは 2 回入れない", async () => {
    const sid = await session(alice);
    await getPool().query("update member_sessions set created_at = now() - interval '16 minutes' where id = $1", [sid]);
    expect(await beginRegister("x", alice, sid)).toEqual({ ok: false, reason: "reauth" });
    const api = await session(alice, "api");
    expect(await beginRegister("x", alice, api)).toEqual({ ok: false, reason: "reauth" });
    const fresh = await session(alice);
    expect(await beginRegister("x", alice, fresh, 1)).toEqual({ ok: false, reason: "session" });
    await q("select member_session_revoke($1, $2, 0, $3, 'logout') as r", [a.shopId, alice, fresh]);
    expect(await beginRegister("x", alice, fresh)).toEqual({ ok: false, reason: "session" });

    for (let i = 0; i < 10; i++) await addKey(alice, cred(i));
    const s2 = await session(alice);
    expect(await beginRegister("y", alice, s2)).toEqual({ ok: false, reason: "too_many" });
    const bg = await beginRegister("z", bob, await session(bob));
    expect(await register(bg.challenge_id!, "z", bob, (await getPool().query("select session_id from member_passkey_challenges where id = $1", [bg.challenge_id])).rows[0].session_id, cred(0))).toEqual({ ok: false, reason: "duplicate" });
  });

  it("ショップのドメインに結びつく: 違う RP ID では登録しない。ドメインを変えると使えない。モジュール・ドメインが無ければ出さない", async () => {
    const sid = await session(alice);
    const bg = await beginRegister("d1", alice, sid);
    expect(await register(bg.challenge_id!, "d1", alice, sid, cred(1), "example.jp")).toEqual({ ok: false, reason: "disabled" });
    const id = await addKey(alice, cred(2));
    await getPool().query("update shops set domain = 'new.example.jp' where id = $1", [a.shopId]);
    expect(await lookup(cred(2))).toBeNull();
    const lg = await beginLogin("d2");
    expect(lg.rp_id).toBe("new.example.jp");
    expect(await login(lg.challenge_id!, "d2", id)).toEqual({ ok: false, reason: "invalid" });
    expect(await q<{ usable: boolean }[]>("select member_passkeys_list($1, $2, 0) as r", [a.shopId, alice])).toMatchObject([{ id, usable: false, label: "Chrome / macOS", backed_up: true }]);
    // ほかのショップ（モジュールもドメインも無い）
    expect(await beginLogin("d3", null, b.shopId)).toEqual({ ok: false, reason: "disabled" });
    await getPool().query(`update shops set settings = jsonb_set(settings, '{modules,passkey}', 'false') where id = $1`, [a.shopId]);
    expect(await beginLogin("d4")).toEqual({ ok: false, reason: "disabled" });
    await getPool().query(`update shops set settings = jsonb_set(settings, '{modules,passkey}', 'true') where id = $1`, [a.shopId]);
  });

  it("ログインの challenge の数: 同じ IP から 10 分に 30 回まで", async () => {
    for (let i = 0; i < 30; i++) expect((await beginLogin(`ip${i}`, "203.0.113.9")).ok).toBe(true);
    expect(await beginLogin("ip-over", "203.0.113.9")).toEqual({ ok: false, reason: "limited" });
    expect((await beginLogin("ip-other", "203.0.113.10")).ok).toBe(true);
  });

  it("会員が消す・運営者が全部消す・退会で消える・世代では消えない", async () => {
    const k1 = await addKey(alice, cred(1));
    await addKey(alice, cred(2));
    const k3 = await addKey(bob, cred(3));
    expect(await q<boolean>("select member_passkey_delete($1, $2, 0, $3) as r", [a.shopId, alice, k3])).toBe(false);
    expect(await q<boolean>("select member_passkey_delete($1, $2, 0, $3) as r", [a.shopId, alice, k1])).toBe(true);
    await q("select member_logout_all($1, $2, 0) as r", [a.shopId, alice]);
    expect(await lookup(cred(2))).not.toBeNull();
    // ほかのショップの運営者は消せない
    expect(await expectDbError(() => asUser(b.ownerId, (c) => c.query("select member_passkeys_reset($1, $2)", [a.shopId, alice])))).toMatch(/forbidden/);
    expect((await asUser(a.ownerId, (c) => c.query("select member_passkeys_reset($1, $2) as n", [a.shopId, alice]))).rows[0].n).toBe(1);
    expect(await lookup(cred(2))).toBeNull();
    await asService((c) => c.query("select member_withdraw($1, $2, 0)", [a.shopId, bob]));
    expect(await lookup(cred(3))).toBeNull();
    bob = (await getPool().query("insert into customers (shop_id, email) values ($1, 'bob@example.com') returning id", [a.shopId])).rows[0].id;
  });

  it("service_role だけ（運営者の全部消すは authenticated）。表は誰にも見せない", async () => {
    await addKey(alice, cred(1));
    expect(await expectDbError(() => asAnon((c) => c.query("select member_passkey_begin($1, 'login', $2, null)", [a.shopId, h("x")])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select member_passkey_lookup($1, $2)", [a.shopId, cred(1)])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asAnon((c) => c.query("select member_passkeys_reset($1, $2)", [a.shopId, alice])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asAnon((c) => c.query("select banto_passkey_shop($1)", [a.shopId])))).toMatch(/permission denied/);
    const seen = await asUser(a.ownerId, async (c) => (await c.query("select id from member_passkeys").catch(() => ({ rows: [] }))).rows);
    expect(seen).toEqual([]);
  });
});
