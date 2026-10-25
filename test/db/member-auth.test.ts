import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** 本番は Worker が HMAC（サイトの秘密）を渡す。DB から見れば 64 桁の 16 進なら何でもよい */
const h = (s: string) => createHash("sha256").update(s).digest("hex");

describe.skipIf(!dbAvailable)("会員のログイン（0012_member_auth）", () => {
  let a: Fixture;
  let b: Fixture;
  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "owner-a@example.com", slug: "shop-a", publish: true, stock: 10 });
    b = await createShopFixture({ email: "owner-b@example.com", slug: "shop-b", publish: true });
    for (const f of [a, b]) {
      await getPool().query("update shops set settings = settings || '{\"members_enabled\": true}' where id = $1", [f.shopId]);
      await getPool().query("insert into hook_endpoints (shop_id, name, url, events, settings) values ($1, 'mail', 'https://banto.invalid/plugins/email_resend', '{}', '{\"from\": \"Shop <shop@example.com>\"}')", [f.shopId]);
    }
  });
  beforeEach(async () => {
    await getPool().query("delete from member_login_challenges");
  });
  afterAll(closePool);

  type Start = { send: boolean; challenge_id: string; mail_from: string };
  type Verify = { ok: boolean; reason?: string; customer_id?: string; session_epoch?: number; created?: boolean; email?: string; return_to?: string | null };
  const start = (shopId: string, email: string, code: string, opts: { ip?: string; returnTo?: string } = {}) =>
    asService(async (c) => (await c.query<{ r: Start }>("select member_login_start($1, $2, $3, $4, $5, $6) as r", [shopId, email, h(`code:${code}`), h(`link:${code}`), opts.ip ? h(opts.ip) : null, opts.returnTo ?? null])).rows[0]!.r);
  const verify = (shopId: string, id: string, code: string | null, link: string | null = null) =>
    asService(async (c) => (await c.query<{ r: Verify }>("select member_login_verify($1, $2, $3, $4) as r", [shopId, id, code === null ? null : h(`code:${code}`), link === null ? null : h(`link:${link}`)])).rows[0]!.r);

  it("コードで入ると会員になる（初回が会員登録）。2 回目は同じ会員。リンクのトークンでも入れる。使ったら終わり", async () => {
    const s1 = await start(a.shopId, " Hanako@Example.com ", "111111");
    expect(s1).toMatchObject({ send: true, mail_from: "Shop <shop@example.com>" });
    const v1 = await verify(a.shopId, s1.challenge_id, "111111");
    expect(v1).toMatchObject({ ok: true, created: true, email: "hanako@example.com", session_epoch: 0 });
    // 使用済み
    expect(await verify(a.shopId, s1.challenge_id, "111111")).toEqual({ ok: false, reason: "expired" });

    const s2 = await start(a.shopId, "hanako@example.com", "222222", { returnTo: "https://wp.example/login" });
    const v2 = await verify(a.shopId, s2.challenge_id, null, "222222");
    expect(v2).toMatchObject({ ok: true, created: false, customer_id: v1.customer_id, return_to: "https://wp.example/login" });
    expect((await getPool().query("select count(*)::int as n, max(last_login_at) is not null as seen from customers where shop_id = $1", [a.shopId])).rows[0]).toEqual({ n: 1, seen: true });
  });

  it("5 回間違えたら正しいコードでも通らない。新しいコードを出しても直近 3 つは有効（4 つ目で一番古いものが無効、0029）。期限切れも通らない", async () => {
    const s = await start(a.shopId, "brute@example.com", "123456");
    for (let i = 0; i < 4; i++) expect(await verify(a.shopId, s.challenge_id, String(100000 + i))).toEqual({ ok: false, reason: "invalid" });
    expect(await verify(a.shopId, s.challenge_id, "999999")).toEqual({ ok: false, reason: "expired" });
    expect(await verify(a.shopId, s.challenge_id, "123456")).toEqual({ ok: false, reason: "expired" });

    const c1 = await start(a.shopId, "brute@example.com", "333333", { ip: "198.51.100.1" });
    const c2 = await start(a.shopId, "brute@example.com", "444444", { ip: "198.51.100.2" });
    const c3 = await start(a.shopId, "brute@example.com", "555555", { ip: "198.51.100.3" });
    const c4 = await start(a.shopId, "brute@example.com", "666666", { ip: "198.51.100.4" });
    expect(await verify(a.shopId, c1.challenge_id, "333333")).toEqual({ ok: false, reason: "expired" }); // 4 つ目で一番古いものが無効
    expect(await verify(a.shopId, c2.challenge_id, "444444")).toMatchObject({ ok: true }); // 届いたばかりの前のコードは生きている
    expect(await verify(a.shopId, c3.challenge_id, "555555")).toMatchObject({ ok: true });
    expect(await verify(a.shopId, c4.challenge_id, "666666")).toMatchObject({ ok: true });
    // 照合の失敗は「同じ IP が出したチャレンジ」ごとに 1 日 50 回まで（有効なチャレンジが 3 つでも総当たりの回数は増えない）。
    // 第三者の失敗は本人の（別の IP の）チャレンジを止めない（0056）
    await getPool().query("insert into member_login_challenges (shop_id, email, code_hash, link_hash, attempts, created_at, expires_at, consumed_at, ip_hash) select $1, 'brute@example.com', $2, $2, 6, now() - interval '3 hours', now(), now(), $3 from generate_series(1, 9)", [a.shopId, h("x"), h("198.51.100.5")]);
    const c5 = await start(a.shopId, "brute@example.com", "777777", { ip: "198.51.100.5" });
    expect(await verify(a.shopId, c5.challenge_id, "777777")).toEqual({ ok: false, reason: "expired" });
    const c6 = await start(a.shopId, "brute@example.com", "888888", { ip: "198.51.100.6" });
    expect(await verify(a.shopId, c6.challenge_id, "888888")).toMatchObject({ ok: true });

    const late = await start(a.shopId, "late@example.com", "555555");
    await getPool().query("update member_login_challenges set expires_at = now() - interval '1 second' where id = $1", [late.challenge_id]);
    expect(await verify(a.shopId, late.challenge_id, "555555")).toEqual({ ok: false, reason: "expired" });
  });

  it("店ごとに別の会員。他店のチャレンジ・コードは通らない", async () => {
    const sa = await start(a.shopId, "both@example.com", "121212");
    expect(await verify(b.shopId, sa.challenge_id, "121212")).toEqual({ ok: false, reason: "invalid" });
    const va = await verify(a.shopId, sa.challenge_id, "121212");
    const sb = await start(b.shopId, "both@example.com", "343434");
    const vb = await verify(b.shopId, sb.challenge_id, "343434");
    expect(va.ok && vb.ok).toBe(true);
    expect(va.customer_id).not.toBe(vb.customer_id);
  });

  it("同じリンクを同時に 10 回照合しても、成功は 1 回だけ", async () => {
    const s = await start(a.shopId, "race@example.com", "565656");
    const results = await Promise.all(Array.from({ length: 10 }, () => verify(a.shopId, s.challenge_id, null, "565656")));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await getPool().query("select count(*)::int as n from customers where shop_id = $1 and email = 'race@example.com'", [a.shopId])).rows[0].n).toBe(1);
  });

  it("発行の上限（0029）: 同じ IP から同じ人へは 15 分に 3 回・1 日 10 回、同じ IP から誰へでも 1 時間に 30 回。超えても応答の形は同じで、送らない", async () => {
    for (let i = 0; i < 3; i++) expect((await start(a.shopId, "spam@example.com", `70000${i}`, { ip: "203.0.113.1" })).send).toBe(true);
    const limited = await start(a.shopId, "spam@example.com", "700009", { ip: "203.0.113.1" });
    expect(limited).toMatchObject({ send: false, mail_from: "Shop <shop@example.com>" });
    expect(limited.challenge_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await verify(a.shopId, limited.challenge_id, "700009")).toEqual({ ok: false, reason: "invalid" });
    // 他人が枠を使い切っても、本人（別の IP）は申し込める。IP が分からなければアドレスだけで 15 分に 5 回
    expect((await start(a.shopId, "spam@example.com", "700010", { ip: "203.0.113.2" })).send).toBe(true);
    expect((await start(a.shopId, "spam@example.com", "700011")).send).toBe(true);
    expect((await start(a.shopId, "spam@example.com", "700012")).send).toBe(false);
    // 同じ IP から同じ人へ 1 日 10 回（15 分の枠の外に 9 回分）
    await getPool().query("insert into member_login_challenges (shop_id, email, code_hash, link_hash, ip_hash, created_at, expires_at, consumed_at) select $1, 'daily@example.com', $2, $2, $3, now() - interval '2 hours', now(), now() from generate_series(1, 9)", [a.shopId, h("x"), h("203.0.113.3")]);
    expect((await start(a.shopId, "daily@example.com", "710000", { ip: "203.0.113.3" })).send).toBe(true);
    expect((await start(a.shopId, "daily@example.com", "720000", { ip: "203.0.113.3" })).send).toBe(false);
    expect((await start(a.shopId, "daily@example.com", "720001", { ip: "203.0.113.4" })).send).toBe(true);

    for (let i = 0; i < 30; i++) expect((await start(a.shopId, `ip${i}@example.com`, "800000", { ip: "203.0.113.9" })).send).toBe(true);
    expect((await start(a.shopId, "ip-last@example.com", "800000", { ip: "203.0.113.9" })).send).toBe(false);
    expect((await start(a.shopId, "ip-last@example.com", "800000", { ip: "203.0.113.10" })).send).toBe(true);
    // 0033: 同じ IP からの 1 時間の回数はショップの設定で変えられる（連携側のサーバーが中継する構成）
    await getPool().query("update shops set settings = settings || '{\"members_login_limits\": {\"per_ip_per_hour\": 31}}' where id = $1", [a.shopId]);
    expect((await start(a.shopId, "ip-more@example.com", "800001", { ip: "203.0.113.9" })).send).toBe(true);
    expect((await start(a.shopId, "ip-more2@example.com", "800002", { ip: "203.0.113.9" })).send).toBe(false);
    await getPool().query("update shops set settings = settings - 'members_login_limits' where id = $1", [a.shopId]);
  });

  it("発行の上限（0029）: アドレス全体で 1 日 30 通、ショップ全体で 1 時間 100 通・1 日 500 通（settings.members_login_limits で変更）", async () => {
    await getPool().query("insert into member_login_challenges (shop_id, email, code_hash, link_hash, ip_hash, created_at, expires_at, consumed_at) select $1, 'bomb@example.com', $2, $2, md5(g::text) || md5((g * 7)::text), now() - interval '2 hours', now(), now() from generate_series(1, 30) g", [a.shopId, h("x")]);
    expect((await start(a.shopId, "bomb@example.com", "730000", { ip: "203.0.113.50" })).send).toBe(false);
    expect((await start(a.shopId, "someone-else@example.com", "730001", { ip: "203.0.113.50" })).send).toBe(true);
    await getPool().query("delete from member_login_challenges");
    await getPool().query("update shops set settings = settings || '{\"members_login_limits\": {\"per_hour\": \"2\"}}' where id = $1", [a.shopId]);
    expect((await start(a.shopId, "s1@example.com", "740000")).send).toBe(true);
    expect((await start(a.shopId, "s2@example.com", "740001")).send).toBe(true);
    expect((await start(a.shopId, "s3@example.com", "740002")).send).toBe(false);
    expect((await start(b.shopId, "s3@example.com", "740002")).send).toBe(true); // 他のショップは別勘定
    await getPool().query("update shops set settings = settings - 'members_login_limits' where id = $1", [a.shopId]);
  });

  it("会員機能が OFF・メールの送信元が無い・不正なアドレスは始められない", async () => {
    await getPool().query("update shops set settings = settings || '{\"members_enabled\": false}' where id = $1", [b.shopId]);
    expect(await expectDbError(() => start(b.shopId, "x@example.com", "1"))).toMatch(/members_disabled/);
    await getPool().query("update shops set settings = settings || '{\"members_enabled\": true}' where id = $1", [b.shopId]);
    await getPool().query("update hook_endpoints set enabled = false where shop_id = $1", [b.shopId]);
    expect(await expectDbError(() => start(b.shopId, "x@example.com", "1"))).toMatch(/mail_not_configured/);
    await getPool().query("update hook_endpoints set enabled = true where shop_id = $1", [b.shopId]);
    expect(await expectDbError(() => start(a.shopId, "not-an-email", "1"))).toMatch(/invalid_email/);
  });

  it("世代: 全端末からログアウトすると古い世代では読めず、予約にも付けられない", async () => {
    const s = await start(a.shopId, "epoch@example.com", "909090");
    const v = await verify(a.shopId, s.challenge_id, "909090");
    const get = (epoch: number) => asService(async (c) => (await c.query<{ r: unknown }>("select member_get($1, $2, $3, true) as r", [a.shopId, v.customer_id, epoch])).rows[0]!.r);
    expect(await get(0)).toMatchObject({ customer: { email: "epoch@example.com" }, orders: [] });
    expect(await asService(async (c) => (await c.query("select member_save_address($1, $2, 0, '会員 花子', '{\"state\":\"東京都\"}') as ok", [a.shopId, v.customer_id])).rows[0].ok)).toBe(true);

    const res = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2, 900) as id", [a.shopId, JSON.stringify([{ sku_id: a.skuId, qty: 1 }])])).rows[0]!.id);
    const attach = (epoch: number) => asService((c) => c.query("select attach_reservation_customer($1, $2, $3)", [res, a.shopId, JSON.stringify({ customer_email: "epoch@example.com", customer_id: v.customer_id, customer_epoch: epoch, shipping_jpy: 0 })]));
    expect(await expectDbError(() => attach(1))).toMatch(/member_session_invalid/);
    await attach(0);
    const stored = (await getPool().query("select customer, customer_id from reservations where id = $1", [res])).rows[0];
    expect(stored).toEqual({ customer: { customer_email: "epoch@example.com" }, customer_id: v.customer_id });

    expect(await asService(async (c) => (await c.query("select member_logout_all($1, $2, 0) as ok", [a.shopId, v.customer_id])).rows[0].ok)).toBe(true);
    expect(await get(0)).toBeNull();
    expect(await get(1)).toMatchObject({ customer: { name: "会員 花子", default_address: { state: "東京都" } } });
    expect(await expectDbError(() => attach(0))).toMatch(/member_session_invalid/);
    expect(await asService(async (c) => (await c.query("select member_withdraw($1, $2, 0) as ok", [a.shopId, v.customer_id])).rows[0].ok)).toBe(false);
    expect(await asService(async (c) => (await c.query("select member_withdraw($1, $2, 1) as ok", [a.shopId, v.customer_id])).rows[0].ok)).toBe(true);
  });

  it("運営者によるメールアドレスの変更: 自分の店だけ。重複は不可。世代が上がり、未使用のコードは無効", async () => {
    const s = await start(a.shopId, "lost@example.com", "131313");
    const v = await verify(a.shopId, s.challenge_id, "131313");
    const o = await start(a.shopId, "other@example.com", "161616");
    await verify(a.shopId, o.challenge_id, "161616");
    const pending = await start(a.shopId, "lost@example.com", "141414");
    const set = (owner: string, email: string) => asUser(owner, async (c) => (await c.query<{ r: unknown }>("select member_set_email($1, $2, $3) as r", [a.shopId, v.customer_id, email])).rows[0]!.r);
    expect(await expectDbError(() => set(b.ownerId, "new@example.com"))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => set(a.ownerId, "Other@example.com"))).toMatch(/email_taken/);
    expect(await set(a.ownerId, "New@Example.com")).toEqual({ old_email: "lost@example.com", new_email: "new@example.com" });
    expect((await getPool().query("select email, session_epoch from customers where id = $1", [v.customer_id])).rows[0]).toEqual({ email: "new@example.com", session_epoch: 1 });
    expect(await verify(a.shopId, pending.challenge_id, "141414")).toEqual({ ok: false, reason: "expired" });
  });

  it("取り込み: メールアドレスで引いて無ければ作る。足りない項目だけ埋める。不正なアドレスは飛ばす", async () => {
    const run = (rows: unknown[]) => asService(async (c) => (await c.query<{ r: unknown }>("select import_members($1, $2::jsonb) as r", [b.shopId, JSON.stringify(rows)])).rows[0]!.r);
    expect(await run([{ email: "Imp@example.com", name: "取り込み 太郎", default_address: { state: "北海道" } }, { email: "bad" }])).toEqual({ created: 1, updated: 0, skipped: 1 });
    expect(await run([{ email: "imp@example.com", name: "別の名前" }])).toEqual({ created: 0, updated: 1, skipped: 0 });
    expect((await getPool().query("select name, default_address from customers where shop_id = $1 and email = 'imp@example.com'", [b.shopId])).rows[0]).toEqual({ name: "取り込み 太郎", default_address: { state: "北海道" } });
    // 取り込んだ会員はコードで入れる（同じ会員になる）
    const s = await start(b.shopId, "imp@example.com", "151515");
    expect(await verify(b.shopId, s.challenge_id, "151515")).toMatchObject({ ok: true, created: false });
    expect(await expectDbError(() => run(Array.from({ length: 101 }, () => ({}))))).toMatch(/too_many_rows/);
  });

  it("service_role 以外は呼べない・表も読めない", async () => {
    expect(await expectDbError(() => asAnon((c) => c.query("select member_login_start($1, 'a@example.com', $2, $2, null, null)", [a.shopId, h("x")])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select member_login_verify($1, gen_random_uuid(), null, null)", [a.shopId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select member_get($1, gen_random_uuid(), 0)", [a.shopId])))).toMatch(/permission denied/);
    await start(a.shopId, "secret@example.com", "1");
    expect((await asUser(a.ownerId, (c) => c.query("select * from member_login_challenges"))).rowCount).toBe(0);
    expect((await asAnon((c) => c.query("select * from member_login_challenges"))).rowCount).toBe(0);
    expect(await asService(async (c) => (await c.query("select member_login_cleanup() as n")).rows[0].n)).toBe(0);
  });

  it("Supabase Auth 版の会員の経路は無い（RLS の customers_self・0011 の関数）。復元は会員を Auth と突き合わせずに戻す", async () => {
    const policies = (await getPool().query("select policyname from pg_policies where tablename in ('customers', 'orders', 'order_items')")).rows.map((r) => r.policyname);
    expect(policies).not.toContain("customers_self");
    expect(policies).not.toContain("orders_customer_select");
    expect((await getPool().query("select count(*)::int as n from pg_proc where proname in ('banto_users_by_email', 'import_customers')")).rows[0].n).toBe(0);

    const s = await start(a.shopId, "restore@example.com", "171717");
    const v = await verify(a.shopId, s.challenge_id, "171717");
    const dst = await asUser(a.ownerId, async (c) => (await c.query<{ id: string }>("insert into shops (owner_id, slug, name) values ($1, 'restore-dst', 'Dst') returning id", [a.ownerId])).rows[0]!.id);
    const data = { customers: [{ id: v.customer_id, email: "restore@example.com", name: "復元", default_address: null }, { id: v.customer_id, email: "Restore@example.com" }, { id: v.customer_id, email: null }] };
    const counts = await asService(async (c) => (await c.query<{ r: Record<string, number> }>("select restore_shop_data($1, $2::jsonb) as r", [dst, JSON.stringify(data)])).rows[0]!.r);
    expect(counts).toMatchObject({ customers: 1, customers_skipped: 2 });
    const r = await start(dst, "restore@example.com", "181818").catch((e: Error) => e.message);
    expect(String(r)).toMatch(/members_disabled/);
  });
});
