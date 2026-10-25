import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const h = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * WordPress と同じ形のハッシュ（テスト用の合成データ。PHP の password_hash で作った）:
 *   6.8 以降: "$wp" . password_hash(base64_encode(hash_hmac("sha384", $password, "wp-sha384", true)), PASSWORD_BCRYPT)
 *   プラグイン: password_hash($password, PASSWORD_BCRYPT)（$2y$）
 */
const WP68 = "$wp$2y$04$LbPQKS0GYZkujhJfiXGPYuVhBv.W.pfX642dRDefV8RHGhyAgUzP6"; // secret-pass-1
const WP68_JA = "$wp$2y$04$if6sg/Yx2iZS7hlwWyPKDeiVVkzLiHlX4dXBnySxZMIGKo7eiRw8i"; // パスワード日本語
const PLAIN_2Y = "$2y$04$yVrPNwUYByYeSfH7HyRxgeP3sZIfYq.3l7L5FunvOXnyan3vxnaJC"; // plain-pass-2
const PHPASS = "$P$BxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxX";

describe.skipIf(!dbAvailable)("会員のパスワード（0013）と LINE ログイン（0014）", () => {
  let f: Fixture;
  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "owner@example.com", slug: "shop", publish: true });
    await getPool().query("update shops set settings = settings || '{\"members_enabled\": true, \"members_password\": true, \"modules\": {\"line_login\": true, \"google_login\": true}}' where id = $1", [f.shopId]);
  });
  beforeEach(async () => {
    await getPool().query("delete from member_login_failures");
  });
  afterAll(closePool);

  type R = { ok: boolean; reason?: string; customer_id?: string; session_epoch?: number; email?: string | null; created?: boolean; linked?: boolean };
  const login = (email: string, password: string, ip: string | null = null) =>
    asService(async (c) => (await c.query<{ r: R }>("select member_password_login($1, $2, $3, $4) as r", [f.shopId, email, password, ip ? h(ip) : null])).rows[0]!.r);
  const importRows = (rows: unknown[]) => asService(async (c) => (await c.query<{ r: Record<string, number> }>("select import_member_passwords($1, $2::jsonb) as r", [f.shopId, JSON.stringify(rows)])).rows[0]!.r);

  it("WordPress のパスワード（6.8 以降の $wp$ と $2y$）で入れる。入れたら Banto の bcrypt に保存し直す。phpass は取り込まない", async () => {
    expect(
      await importRows([
        { email: "wp@example.com", hash: WP68 },
        { email: "ja@example.com", hash: WP68_JA },
        { email: "plain@example.com", hash: PLAIN_2Y },
        { email: "old@example.com", hash: PHPASS },
        { email: "bad", hash: WP68 },
      ]),
    ).toEqual({ imported: 3, created: 3, skipped_format: 1, skipped_has_password: 0, skipped_invalid_email: 1, skipped_active: 0 });
    expect((await getPool().query("select count(*)::int as n from customers where email = 'old@example.com'")).rows[0].n).toBe(0);

    expect(await login("wp@example.com", "wrong-pass")).toEqual({ ok: false, reason: "invalid" });
    const ok = await login("WP@example.com", "secret-pass-1");
    expect(ok).toMatchObject({ ok: true, email: "wp@example.com", session_epoch: 0 });
    const row = (await getPool().query("select password_hash, legacy_password_hash from customers where email = 'wp@example.com'")).rows[0];
    expect(row.legacy_password_hash).toBeNull();
    expect(row.password_hash).toMatch(/^\$2a\$10\$/);
    // 保存し直した後も同じパスワードで入れる
    expect(await login("wp@example.com", "secret-pass-1")).toMatchObject({ ok: true });
    // WordPress は保存時に前後の空白を落としている
    expect(await login("ja@example.com", " パスワード日本語 ")).toMatchObject({ ok: true });
    expect(await login("plain@example.com", "plain-pass-2")).toMatchObject({ ok: true });

    // Banto のパスワードを決めた会員は、取り込みで上書きしない
    expect(await importRows([{ email: "wp@example.com", hash: PLAIN_2Y }])).toMatchObject({ imported: 0, skipped_has_password: 1 });
  });

  it("同じ人に 15 分で 5 回失敗すると、正しいパスワードでもしばらく入れない（locked）。IP ごとの上限も", async () => {
    await importRows([{ email: "lock@example.com", hash: PLAIN_2Y }]);
    for (let i = 0; i < 5; i++) expect(await login("lock@example.com", `nope-${i}`)).toEqual({ ok: false, reason: "invalid" });
    expect(await login("lock@example.com", "plain-pass-2")).toEqual({ ok: false, reason: "locked" });
    // いない会員でも失敗として数え、同じ応答（登録の有無が分からない）
    expect(await login("nobody@example.com", "whatever")).toEqual({ ok: false, reason: "invalid" });

    for (let i = 0; i < 30; i++) await login(`ip${i}@example.com`, "x", "198.51.100.7");
    expect(await login("plain@example.com", "plain-pass-2", "198.51.100.7")).toEqual({ ok: false, reason: "locked" });
    expect(await login("plain@example.com", "plain-pass-2", "198.51.100.8")).toMatchObject({ ok: true });
  });

  it("0016: ログインに成功したら知らせの送信元（メール通知プラグインの設定）も返す。無効なら null", async () => {
    await importRows([{ email: "notice@example.com", hash: PLAIN_2Y }]);
    expect(await login("notice@example.com", "plain-pass-2")).toMatchObject({ ok: true, mail_from: null });
    await getPool().query("insert into hook_endpoints (shop_id, name, url, events, enabled, settings) values ($1, 'mail', 'https://banto.invalid/plugins/email_resend', '{}', true, $2)", [f.shopId, { from: "Shop <s@example.com>" }]);
    expect(await login("notice@example.com", "plain-pass-2")).toMatchObject({ ok: true, mail_from: "Shop <s@example.com>" });
    expect(await login("notice@example.com", "wrong-pass")).toEqual({ ok: false, reason: "invalid" });
    await getPool().query("update hook_endpoints set enabled = false where shop_id = $1", [f.shopId]);
    expect(await login("notice@example.com", "plain-pass-2")).toMatchObject({ ok: true, mail_from: null });
  });

  it("パスワードを決める: 8 文字以上。世代を上げ（ほかの端末をログアウト）、WordPress のハッシュを捨てる。店の設定が OFF なら使えない", async () => {
    const id = (await getPool().query("select id, session_epoch from customers where email = 'plain@example.com'")).rows[0];
    const set = (epoch: number, pw: string) => asService(async (c) => (await c.query<{ r: number | null }>("select member_set_password($1, $2, $3, $4) as r", [f.shopId, id.id, epoch, pw])).rows[0]!.r);
    expect(await expectDbError(() => set(id.session_epoch, "short"))).toMatch(/weak_password/);
    expect(await set(id.session_epoch + 9, "new-password-1")).toBeNull();
    expect(await set(id.session_epoch, "new-password-1")).toBe(id.session_epoch + 1);
    expect(await login("plain@example.com", "plain-pass-2")).toEqual({ ok: false, reason: "invalid" });
    expect(await login("plain@example.com", "new-password-1")).toMatchObject({ ok: true, session_epoch: id.session_epoch + 1 });

    await getPool().query("update shops set settings = settings || '{\"members_password\": false}' where id = $1", [f.shopId]);
    expect(await login("plain@example.com", "new-password-1")).toEqual({ ok: false, reason: "disabled" });
    expect(await expectDbError(() => set(id.session_epoch + 1, "another-pass-2"))).toMatch(/password_disabled/);
    await getPool().query("update shops set settings = settings || '{\"members_password\": true}' where id = $1", [f.shopId]);
  });

  type O = R & { reason?: string };
  const oauth = (sub: string, email: string | null, verified: boolean, link: { id: string; epoch: number } | null = null) =>
    asService(async (c) => (await c.query<{ r: O }>("select member_oauth_login($1, 'line', $2, $3, $4, $5, $6) as r", [f.shopId, sub, email, verified, link?.id ?? null, link?.epoch ?? null])).rows[0]!.r);

  it("LINE: 初回は会員登録、2 回目は同じ会員。確認済みのアドレスなら既存の会員に結びつく。未確認なら結びつけない", async () => {
    const first = await oauth("U-new", null, false);
    expect(first).toMatchObject({ ok: true, created: true, linked: true, email: null });
    expect(await oauth("U-new", null, false)).toMatchObject({ ok: true, created: false, linked: false, customer_id: first.customer_id });

    const existing = (await getPool().query("select id from customers where email = 'wp@example.com'")).rows[0].id;
    expect(await oauth("U-wp", "WP@example.com", true)).toMatchObject({ ok: true, created: false, customer_id: existing });
    // 未確認のアドレスでは結びつけず、アドレスなしの新しい会員にする（他人のアドレスで乗っ取られないように）
    const unverified = await oauth("U-evil", "ja@example.com", false);
    expect(unverified).toMatchObject({ ok: true, created: true, email: null });
    expect(unverified.customer_id).not.toBe((await getPool().query("select id from customers where email = 'ja@example.com'")).rows[0].id);
  });

  it("LINE: ログイン中の会員が連携する。別の会員に結びついた LINE・世代違いは不可。外すのはメールアドレスがある会員だけ", async () => {
    const ja = (await getPool().query("select id, session_epoch from customers where email = 'ja@example.com'")).rows[0];
    expect(await oauth("U-ja", null, false, { id: ja.id, epoch: ja.session_epoch + 5 })).toEqual({ ok: false, reason: "session" });
    expect(await oauth("U-new", null, false, { id: ja.id, epoch: ja.session_epoch })).toEqual({ ok: false, reason: "already_linked" });
    expect(await oauth("U-ja", null, false, { id: ja.id, epoch: ja.session_epoch })).toMatchObject({ ok: true, linked: true, customer_id: ja.id });
    expect(await oauth("U-ja2", null, false, { id: ja.id, epoch: ja.session_epoch })).toEqual({ ok: false, reason: "other_linked" });
    const get = (id: string, epoch: number) => asService(async (c) => (await c.query<{ r: { customer: Record<string, unknown> } | null }>("select member_get($1, $2, $3) as r", [f.shopId, id, epoch])).rows[0]!.r);
    expect((await get(ja.id, ja.session_epoch))!.customer).toMatchObject({ providers: ["line"], has_password: true });

    const unlink = (id: string, epoch: number) => asService(async (c) => (await c.query("select member_unlink_identity($1, $2, $3, 'line') as ok", [f.shopId, id, epoch])).rows[0].ok);
    expect(await unlink(ja.id, ja.session_epoch)).toBe(true);
    const lineOnly = await oauth("U-only", null, false);
    expect(await expectDbError(() => unlink(lineOnly.customer_id!, 0))).toMatch(/last_login_method/);

    // モジュールが OFF なら使えない
    await getPool().query("update shops set settings = jsonb_set(settings, '{modules,line_login}', 'false') where id = $1", [f.shopId]);
    expect(await oauth("U-new", null, false)).toEqual({ ok: false, reason: "disabled" });
    await getPool().query("update shops set settings = jsonb_set(settings, '{modules,line_login}', 'true') where id = $1", [f.shopId]);
  });

  it("ヘッドレスの引き換え券: 1 回限り・2 分・トークンが合うときだけ。世代が変われば使えない", async () => {
    const m = await oauth("U-handoff", null, false);
    const create = () => asService(async (c) => (await c.query<{ id: string }>("select member_handoff_create($1, $2, $3, $4) as id", [f.shopId, m.customer_id, m.session_epoch, h("tok")])).rows[0]!.id);
    const redeem = (id: string, token: string) => asService(async (c) => (await c.query<{ r: R }>("select member_handoff_redeem($1, $2, $3) as r", [f.shopId, id, h(token)])).rows[0]!.r);
    const id = await create();
    expect(await redeem(id, "wrong")).toEqual({ ok: false, reason: "expired" });
    const id2 = await create();
    expect(await redeem(id2, "tok")).toMatchObject({ ok: true, customer_id: m.customer_id });
    expect(await redeem(id2, "tok")).toEqual({ ok: false, reason: "expired" });
    const id3 = await create();
    await getPool().query("update member_handoffs set expires_at = now() - interval '1 second' where id = $1", [id3]);
    expect(await redeem(id3, "tok")).toEqual({ ok: false, reason: "expired" });
  });

  it("ショップごとの提供元の設定: 運営者が保存（設定に client_id を写す）、暗号文の列は運営者にも見えない。他人のショップには書けない", async () => {
    const other = await createShopFixture({ email: "other-owner@example.com", slug: "other" });
    const save = (owner: string, shopId: string, box: string | null) => asUser(owner, (c) => c.query("select shop_oauth_client_save($1, 'google', ' abc.apps.googleusercontent.com ', $2)", [shopId, box]));
    expect(await expectDbError(() => save(f.ownerId, f.shopId, null))).toMatch(/secret_required/);
    await save(f.ownerId, f.shopId, "v1.aaaa.bbbb");
    expect(await expectDbError(() => save(other.ownerId, f.shopId, "v1.cccc.dddd"))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => save(f.ownerId, f.shopId, "plaintext-secret"))).toMatch(/check constraint/);
    const settings = (await getPool().query("select settings->'oauth' as o, settings->'modules' as m from shops where id = $1", [f.shopId])).rows[0];
    expect(settings.o).toEqual({ google: { client_id: "abc.apps.googleusercontent.com" } });
    expect(settings.m).toMatchObject({ line_login: true });
    // 運営者は client_id は読めるが、暗号文の列は読めない
    expect((await asUser(f.ownerId, (c) => c.query("select provider, client_id from shop_oauth_clients"))).rows).toEqual([{ provider: "google", client_id: "abc.apps.googleusercontent.com" }]);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select secret_box from shop_oauth_clients")))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update shop_oauth_clients set secret_box = 'v1.x.y'")))).toMatch(/permission denied/);
    expect((await asUser(other.ownerId, (c) => c.query("select client_id from shop_oauth_clients"))).rowCount).toBe(0);
    // service_role だけが暗号文を読む
    expect(await asService(async (c) => (await c.query("select shop_oauth_client($1, 'google') as r", [f.shopId])).rows[0].r)).toEqual({ client_id: "abc.apps.googleusercontent.com", secret_box: "v1.aaaa.bbbb" });
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select shop_oauth_client($1, 'google')", [f.shopId])))).toMatch(/permission denied/);
    await asUser(f.ownerId, (c) => c.query("select shop_oauth_client_delete($1, 'google')", [f.shopId]));
    expect((await getPool().query("select settings->'oauth' as o from shops where id = $1", [f.shopId])).rows[0].o).toEqual({});
  });

  it("Google の結びつけ: line と google は別々に持てる", async () => {
    const m = (await getPool().query("select id, session_epoch from customers where email = 'plain@example.com'")).rows[0];
    const r = await asService(async (c) => (await c.query<{ r: R }>("select member_oauth_login($1, 'google', 'G-plain', 'plain@example.com', true, null, null) as r", [f.shopId])).rows[0]!.r);
    expect(r).toMatchObject({ ok: true, customer_id: m.id, linked: true });
  });

  it("service_role 以外は呼べない・表は見えない", async () => {
    expect(await expectDbError(() => asAnon((c) => c.query("select member_password_login($1, 'a@example.com', 'x', null)", [f.shopId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select import_member_passwords($1, '[]'::jsonb)", [f.shopId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select member_oauth_login($1, 'line', 'x', null, false, null, null)", [f.shopId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asAnon((c) => c.query("select banto_wp_password_matches('a', 'b')")))).toMatch(/permission denied/);
    for (const t of ["member_identities", "member_handoffs", "member_login_failures"]) {
      expect((await asUser(f.ownerId, (c) => c.query(`select * from ${t}`))).rowCount, t).toBe(0);
    }
    // 運営者は会員のハッシュを読めない列も含めて customers を読めるが、owner の RLS 経路はこれまでどおり
    expect(await asService(async (c) => (await c.query("select member_login_cleanup() as n")).rows[0].n)).toBeGreaterThanOrEqual(0);
  });
});
