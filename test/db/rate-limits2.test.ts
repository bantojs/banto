import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const h = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * 0056_rate_limits_2: 2026-10-25 の監査（回数・資源の上限の穴）。
 */
describe.skipIf(!dbAvailable)("回数の上限の締め直し（0056_rate_limits_2）", () => {
  let f: Fixture;
  const items = (qty: number) => JSON.stringify([{ sku_id: f.skuId, qty }]);
  const reserve = (opts: { subject?: string; ip?: string } = {}) =>
    asService(async (c) =>
      (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb, 900, $3, $4, $5) as id", [f.shopId, items(1), `q-${Math.random()}`, opts.subject ? h(opts.subject) : null, opts.ip ? h(opts.ip) : null])).rows[0]!.id,
    );
  const confirmFree = (id: string) =>
    asService((c) => c.query("select confirm_reservation($1, $2, $3::jsonb)", [id, f.shopId, JSON.stringify({ payment_provider: "free", payment_ref: `free-${id}`, amount_paid_jpy: 0 })]));

  type Start = { send: boolean; challenge_id: string };
  type Verify = { ok: boolean; reason?: string };
  const start = (email: string, code: string, ip: string) =>
    asService(async (c) => (await c.query<{ r: Start }>("select member_login_start($1, $2, $3, $4, $5, null) as r", [f.shopId, email, h(`code:${code}`), h(`link:${code}`), h(ip)])).rows[0]!.r);
  const verify = (id: string, code: string) =>
    asService(async (c) => (await c.query<{ r: Verify }>("select member_login_verify($1, $2, $3, null) as r", [f.shopId, id, h(`code:${code}`)])).rows[0]!.r);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "rl2@example.com", slug: "rl2-shop", publish: true, stock: 100 });
    await getPool().query("update skus set price_jpy = 0 where id = $1", [f.skuId]);
    await getPool().query("update shops set settings = settings || '{\"members_enabled\": true, \"members_password\": true}' where id = $1", [f.shopId]);
    await getPool().query("insert into hook_endpoints (shop_id, name, url, events, settings) values ($1, 'mail', 'https://banto.invalid/plugins/email_resend', '{}', '{\"from\": \"Shop <shop@example.com>\"}')", [f.shopId]);
  });
  afterAll(closePool);

  it("0 円の注文（その場で確定）も、同じ人・同じ IP の上限に数える", async () => {
    for (let i = 0; i < 3; i++) await confirmFree(await reserve({ subject: "buyer@example.com" }));
    expect(await expectDbError(() => reserve({ subject: "buyer@example.com" }))).toMatch(/too_many_reservations/);
    // 1 時間より前の確定は数えない
    await getPool().query("update reservations set created_at = now() - interval '2 hours' where shop_id = $1", [f.shopId]);
    await confirmFree(await reserve({ subject: "buyer@example.com" }));
    // 決済ありの確定は数えない
    await getPool().query("update skus set price_jpy = 100 where id = $1", [f.skuId]);
    for (let i = 0; i < 3; i++) {
      const id = await reserve({ ip: "203.0.113.5" });
      await asService((c) => c.query("select confirm_reservation($1, $2, $3::jsonb)", [id, f.shopId, JSON.stringify({ payment_provider: "stripe", payment_ref: `pi_${i}`, amount_paid_jpy: 100, currency: "jpy" })]));
    }
    for (let i = 0; i < 20; i++) await reserve({ ip: "203.0.113.5" });
    expect(await expectDbError(() => reserve({ ip: "203.0.113.5" }))).toMatch(/too_many_reservations/);
    await getPool().query("update skus set price_jpy = 0 where id = $1", [f.skuId]);
  });

  it("会員ログインの照合: 第三者の失敗は本人のチャレンジを止めない", async () => {
    // 攻撃者の IP から 10 枚出して 5 回ずつ外す（50 回）
    for (let i = 0; i < 10; i++) {
      await getPool().query("update member_login_challenges set created_at = created_at - interval '20 minutes' where shop_id = $1", [f.shopId]);
      const s = await start("victim@example.com", "000000", "198.51.100.1");
      if (!s.send) continue;
      for (let j = 0; j < 5; j++) await verify(s.challenge_id, "999999");
    }
    const sum = (await getPool().query<{ n: string }>("select coalesce(sum(attempts), 0)::text as n from member_login_challenges where shop_id = $1 and email = 'victim@example.com'", [f.shopId])).rows[0]!.n;
    expect(Number(sum)).toBeGreaterThanOrEqual(50);
    // 本人（別の IP）の正しいコードは通る
    const mine = await start("victim@example.com", "123456", "203.0.113.77");
    expect(mine.send).toBe(true);
    expect(await verify(mine.challenge_id, "123456")).toMatchObject({ ok: true });
  });

  it("運営者のログインのロックは「同じ IP から同じアドレスへ」が先。別の IP からは入れる", async () => {
    const check = (email: string, ip: string | null) => asService(async (c) => (await c.query<{ r: { allowed: boolean } }>("select admin_login_check($1, $2) as r", [h(email), ip ? h(ip) : null])).rows[0]!.r);
    const record = (email: string, ip: string | null, ok: boolean) => asService((c) => c.query("select admin_login_record($1, $2, $3)", [h(email), ip ? h(ip) : null, ok]));
    for (let i = 0; i < 5; i++) await record("owner@example.com", "198.51.100.1", false);
    expect((await check("owner@example.com", "198.51.100.1")).allowed).toBe(false);
    expect((await check("owner@example.com", "203.0.113.77")).allowed).toBe(true);
    // アドレス全体で 20 回を超えたらどこからも入れない
    for (let i = 0; i < 15; i++) await record("owner@example.com", `198.51.100.${i + 10}`, false);
    expect((await check("owner@example.com", "203.0.113.77")).allowed).toBe(false);
  });

  it("会員のパスワードのロックも「同じ IP から同じアドレスへ」が先", async () => {
    await getPool().query("insert into customers (shop_id, email, password_hash) values ($1, 'pw@example.com', crypt('correct-horse', gen_salt('bf', 4)))", [f.shopId]);
    const login = (password: string, ip: string) =>
      asService(async (c) => (await c.query<{ r: { ok: boolean; reason?: string } }>("select member_password_login($1, 'pw@example.com', $2, $3) as r", [f.shopId, password, h(ip)])).rows[0]!.r);
    for (let i = 0; i < 5; i++) expect(await login("wrong", "198.51.100.1")).toMatchObject({ ok: false, reason: "invalid" });
    expect(await login("correct-horse", "198.51.100.1")).toMatchObject({ ok: false, reason: "locked" });
    expect(await login("correct-horse", "203.0.113.77")).toMatchObject({ ok: true });
  });

  it("hooks の配信は無料プランでは 1 回 12 件まで。paid なら呼び手の上限まで", async () => {
    const ep = (await getPool().query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'ext', 'https://hooks.example/in', '{order.paid}') returning id", [f.shopId])).rows[0]!.id;
    for (let i = 0; i < 15; i++) await getPool().query("insert into hook_deliveries (shop_id, endpoint_id, event, payload) values ($1, $2, 'order.paid', '{}')", [f.shopId, ep]);
    const claim = () => asService(async (c) => (await c.query("select * from claim_hook_deliveries(50)")).rows);
    expect(await claim()).toHaveLength(12);
    await asUser(f.ownerId, (c) => c.query("select site_settings_set('workers_plan', '\"paid\"')"));
    expect(await claim()).toHaveLength(3);
  });
});
