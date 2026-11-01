import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONFIRM_SQL, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const h = (s: string) => createHash("sha256").update(s).digest("hex");
type J = Record<string, unknown>;

/**
 * 0090_security_hardening_4: 守りの締め直し 4。
 * - 会員の「ログインしてから 15 分以内」は authenticated_at で数え、セッションを作り直しても若返らない
 * - 退会・連携の解除・パスキーの削除・全端末ログアウトは 15 分以内のセッションだけ（p_session_id を渡したとき）
 * - ログインのコードの発行: 宛先の枠が埋まっても、新しい IP からの最初の 1 通は 1 日 5 通まで
 * - 注文の確定: 支払額と通貨は必須、free は 0 円だけ、payment_account、解放済みの予約の quote_superseded / coupon_exhausted_after_release
 * - お店で試着: 申し込んだまま 14 日過ぎたものは期限切れにして在庫を戻す
 */
describe.skipIf(!dbAvailable)("セキュリティの締め直し 4（0090_security_hardening_4）", () => {
  let f: Fixture;
  let cid: string;
  let store: string;

  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
  const sessionStart = (epoch: number, authenticatedAt: string | null = null, kind = "web") =>
    asService(async (c) => (await c.query<{ r: string }>("select member_session_start($1, $2, $3, $4, 'dev', 86400, $5::timestamptz) as r", [f.shopId, cid, epoch, kind, authenticatedAt])).rows[0]!.r);
  const age = (sid: string, minutes: number) => getPool().query("update member_sessions set authenticated_at = now() - make_interval(mins => $2) where id = $1", [sid, minutes]);
  const recent = (epoch: number, sid: string | null) => rpc<boolean>("banto_member_recent_auth", [f.shopId, cid, epoch, sid, 15]);
  const epochOf = async () => (await getPool().query<{ e: number }>("select session_epoch as e from customers where id = $1", [cid])).rows[0]!.e;

  const items = (qty: number, sku = f.skuId) => JSON.stringify([{ sku_id: sku, qty }]);
  const reserve = (qty: number, opts: { quote?: string; sku?: string } = {}) =>
    asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb, 900, $3, null, null) as id", [f.shopId, items(qty, opts.sku), opts.quote ?? null])).rows[0]!.id);
  const release = (id: string) => asService((c) => c.query("select release_reservation($1, $2)", [id, f.shopId]));
  /** 支払額・通貨を足さない素の confirm_reservation */
  const confirmRaw = (id: string, order: J) => asService(async (c) => (await c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [id, f.shopId, JSON.stringify(order)])).rows[0]!.id);
  const confirm = (id: string, order: J = { payment_provider: "stripe", payment_ref: `pi_${id}` }) =>
    asService(async (c) => (await c.query<{ id: string }>(CONFIRM_SQL, [id, f.shopId, JSON.stringify(order)])).rows[0]!.id);
  const available = async (sku = f.skuId) => (await getPool().query<{ available: number }>("select available from inventory where sku_id = $1", [sku])).rows[0]!.available;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "h4-owner@example.com", slug: "h4-shop", publish: true, stock: 100 });
    const pool = getPool();
    await pool.query("update shops set settings = settings || '{\"members_enabled\": true, \"members_password\": true, \"modules\": {\"google_login\": true, \"passkey\": true}}' where id = $1", [f.shopId]);
    await pool.query("insert into hook_endpoints (shop_id, name, url, events, settings) values ($1, 'mail', 'https://banto.invalid/plugins/email_resend', '{}', '{\"from\": \"Shop <shop@example.com>\"}')", [f.shopId]);
    await pool.query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'x', 'https://example.com/h', '{tryon.requested,tryon.updated}')", [f.shopId]);
    cid = (await pool.query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'member@example.com') returning id", [f.shopId])).rows[0]!.id;
    const orgId = (await pool.query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    store = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into stores (org_id, name) values ($1, '店') returning id", [orgId]))).rows[0]!.id;
    await asUser(f.ownerId, (c) => c.query("insert into shop_stores (shop_id, store_id) values ($1, $2)", [f.shopId, store]));
  });
  afterAll(closePool);

  // ---------- 1. authenticated_at ----------
  it("セッション: ログインを確かめた時刻を引き継げ、15 分の判定はその時刻で。未来の時刻は今に丸める。既定は今", async () => {
    const fresh = await sessionStart(0);
    expect(await recent(0, fresh)).toBe(true);
    await age(fresh, 16);
    expect(await recent(0, fresh)).toBe(false);
    // 作り直しても起点は若返らない（created_at は今でも authenticated_at は前の値）
    const inherited = await sessionStart(0, "2020-01-01T00:00:00Z");
    const row = (await getPool().query<{ a: Date; c: Date }>("select authenticated_at as a, created_at as c from member_sessions where id = $1", [inherited])).rows[0]!;
    expect(row.a.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(row.c.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await recent(0, inherited)).toBe(false);
    const future = await sessionStart(0, new Date(Date.now() + 3_600_000).toISOString());
    expect((await getPool().query<{ ok: boolean }>("select authenticated_at <= now() as ok from member_sessions where id = $1", [future])).rows[0]!.ok).toBe(true);
    expect(await recent(0, future)).toBe(true);
  });

  it("パスワードの変更は authenticated_at を返し、同じ行の authenticated_at を変えない（ヘッドレスが新しいトークンに引き継ぐ）", async () => {
    const sid = await sessionStart(0, null, "api");
    await age(sid, 10);
    const r = await rpc<J>("member_set_password", [f.shopId, cid, 0, "new-password-1", sid]);
    expect(r).toMatchObject({ ok: true, epoch: 1, email: "member@example.com", mail_from: "Shop <shop@example.com>" });
    const a = (await getPool().query<{ a: Date }>("select authenticated_at as a from member_sessions where id = $1", [sid])).rows[0]!.a;
    expect(new Date(r["authenticated_at"] as string).getTime()).toBe(a.getTime());
    expect(a.getTime()).toBeLessThan(Date.now() - 9 * 60_000);
    // 返った時刻で作り直した新しいセッションは、あと 5 分で reauth になる
    const next = await sessionStart(1, r["authenticated_at"] as string, "api");
    expect(await recent(1, next)).toBe(true);
    await age(next, 16);
    expect(await recent(1, next)).toBe(false);
  });

  // ---------- 2. 再認証 ----------
  it("全端末ログアウト・連携の解除・パスキーの削除: 15 分を過ぎたセッションでは reauth_required。15 分以内ならできる。p_session_id 無しは従来どおり", async () => {
    let epoch = await epochOf();
    await getPool().query("insert into member_identities (shop_id, provider, subject, customer_id) values ($1, 'google', 'sub-1', $2)", [f.shopId, cid]);
    const key = (await getPool().query<{ id: string }>(
      "insert into member_passkeys (shop_id, customer_id, credential_id, public_key, alg, rp_id) values ($1, $2, 'AAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBBBB', -7, 'shop.example') returning id",
      [f.shopId, cid],
    )).rows[0]!.id;
    const stale = await sessionStart(epoch);
    await age(stale, 16);
    expect(await expectDbError(() => rpc("member_unlink_identity", [f.shopId, cid, epoch, "google", stale]))).toMatch(/reauth_required/);
    expect(await expectDbError(() => rpc("member_passkey_delete", [f.shopId, cid, epoch, key, stale]))).toMatch(/reauth_required/);
    expect(await expectDbError(() => rpc("member_logout_all", [f.shopId, cid, epoch, stale]))).toMatch(/reauth_required/);
    expect(await expectDbError(() => rpc("member_withdraw", [f.shopId, cid, epoch, stale]))).toMatch(/reauth_required/);
    // 取り消された・世代の違うセッションも通らない
    const revoked = await sessionStart(epoch);
    await rpc("member_session_revoke", [f.shopId, cid, epoch, revoked, "logout"]);
    expect(await expectDbError(() => rpc("member_logout_all", [f.shopId, cid, epoch, revoked]))).toMatch(/reauth_required/);
    expect((await getPool().query("select 1 from member_identities where customer_id = $1", [cid])).rowCount).toBe(1);
    expect((await getPool().query("select 1 from member_passkeys where id = $1", [key])).rowCount).toBe(1);
    expect(await epochOf()).toBe(epoch);

    const fresh = await sessionStart(epoch);
    expect(await rpc<boolean>("member_unlink_identity", [f.shopId, cid, epoch, "google", fresh])).toBe(true);
    expect(await rpc<boolean>("member_passkey_delete", [f.shopId, cid, epoch, key, fresh])).toBe(true);
    expect(await rpc<boolean>("member_logout_all", [f.shopId, cid, epoch, fresh])).toBe(true);
    epoch = await epochOf();
    // 古い Worker（p_session_id 無し）は世代だけで確かめる
    expect(await rpc<boolean>("member_logout_all", [f.shopId, cid, epoch])).toBe(true);
    expect(await rpc<boolean>("member_logout_all", [f.shopId, cid, epoch])).toBe(false);
  });

  it("退会: 15 分以内のセッションで消え、本人に知らせるための email と送信元が返る。世代が合わなければ { ok: false }", async () => {
    const epoch = await epochOf();
    expect(await rpc<J>("member_withdraw", [f.shopId, cid, epoch - 1])).toEqual({ ok: false });
    const fresh = await sessionStart(epoch);
    expect(await rpc<J>("member_withdraw", [f.shopId, cid, epoch, fresh])).toEqual({ ok: true, email: "member@example.com", mail_from: "Shop <shop@example.com>" });
    expect((await getPool().query("select 1 from customers where id = $1", [cid])).rowCount).toBe(0);
    // 行ごと消えたのでセッションも無い
    expect((await getPool().query("select 1 from member_sessions where customer_id = $1", [cid])).rowCount).toBe(0);
  });

  // ---------- 3. ログインのコードの発行 ----------
  it("ログインのコード: 宛先の 1 日 30 通が埋まっても、まだ出していない IP からの最初の 1 通は 1 日 5 通まで通る。IP が無ければ通らない", async () => {
    const start = (email: string, ip: string | null) =>
      rpc<{ send: boolean }>("member_login_start", [f.shopId, email, h(`code:${Math.random()}`), h(`link:${Math.random()}`), ip ? h(ip) : null, null]);
    await getPool().query(
      "insert into member_login_challenges (shop_id, email, code_hash, link_hash, ip_hash, created_at, expires_at, consumed_at) select $1, 'bomb@example.com', $2, $2, md5(g::text) || md5((g * 7)::text), now() - interval '2 hours', now(), now() from generate_series(1, 30) g",
      [f.shopId, h("x")],
    );
    expect((await start("bomb@example.com", null)).send).toBe(false);
    expect((await start("bomb@example.com", "198.51.100.1")).send).toBe(true);
    expect((await start("bomb@example.com", "198.51.100.1")).send).toBe(false);
    for (let i = 2; i <= 5; i++) expect((await start("bomb@example.com", `198.51.100.${i}`)).send).toBe(true);
    expect((await start("bomb@example.com", "198.51.100.6")).send).toBe(false);
    // ほかの宛先には関係ない
    expect((await start("other@example.com", "198.51.100.6")).send).toBe(true);
    await getPool().query("delete from member_login_challenges");
  });

  // ---------- 4. 注文の確定 ----------
  it("確定: 支払額が無い・整数でない・通貨が無い・jpy でないと amount_mismatch。合えば確定し payment_account が残る", async () => {
    const r = await reserve(1);
    const base = { payment_provider: "stripe", payment_ref: "pi_a" };
    expect(await expectDbError(() => confirmRaw(r, base))).toMatch(/amount_mismatch/);
    expect(await expectDbError(() => confirmRaw(r, { ...base, amount_paid_jpy: "abc", currency: "jpy" }))).toMatch(/amount_mismatch/);
    expect(await expectDbError(() => confirmRaw(r, { ...base, amount_paid_jpy: 3000.5, currency: "jpy" }))).toMatch(/amount_mismatch/);
    expect(await expectDbError(() => confirmRaw(r, { ...base, amount_paid_jpy: 3000 }))).toMatch(/amount_mismatch/);
    expect(await expectDbError(() => confirmRaw(r, { ...base, amount_paid_jpy: 3000, currency: "" }))).toMatch(/amount_mismatch/);
    expect(await expectDbError(() => confirmRaw(r, { ...base, amount_paid_jpy: 3000, currency: "usd" }))).toMatch(/amount_mismatch/);
    expect(await expectDbError(() => confirmRaw(r, { ...base, amount_paid_jpy: 2999, currency: "jpy" }))).toMatch(/amount_mismatch/);
    expect((await getPool().query("select 1 from orders where reservation_id = $1", [r])).rowCount).toBe(0);
    const oid = await confirmRaw(r, { ...base, amount_paid_jpy: 3000, currency: "JPY", payment_account: " acct_123 " });
    expect((await getPool().query("select payment_provider, amount_paid_jpy, payment_account from orders where id = $1", [oid])).rows[0]).toEqual({ payment_provider: "stripe", amount_paid_jpy: 3000, payment_account: "acct_123" });
    // 同じ予約の 2 回目は額が違っても同じ注文を返す（冪等）
    expect(await confirmRaw(r, base)).toBe(oid);
    // payment_account は運営者の JWT から書けない
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update orders set payment_account = 'x' where id = $1", [oid])))).toMatch(/permission denied/);
  });

  it("確定: 0 円の確定（free）は合計が 0 のときだけ", async () => {
    const r = await reserve(1);
    expect(await expectDbError(() => confirmRaw(r, { payment_provider: "free", payment_ref: "free_1", amount_paid_jpy: 0, currency: "jpy" }))).toMatch(/amount_mismatch/);
    expect(await expectDbError(() => confirmRaw(r, { payment_provider: "free", payment_ref: "free_1", amount_paid_jpy: 3000, currency: "jpy" }))).toMatch(/amount_mismatch/);
    const zero = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into skus (shop_id, product_id, code, price_jpy) values ($1, $2, 'FREE-1', 0) returning id", [f.shopId, f.productId]))).rows[0]!.id;
    await asUser(f.ownerId, (c) => c.query("select set_stock($1, 5)", [zero]));
    const r0 = await reserve(1, { sku: zero });
    const oid = await confirmRaw(r0, { payment_provider: "free", payment_ref: "free_2", amount_paid_jpy: 0, currency: "jpy" });
    expect((await getPool().query("select total_jpy, payment_provider, payment_account from orders where id = $1", [oid])).rows[0]).toEqual({ total_jpy: 0, payment_provider: "free", payment_account: null });
  });

  it("確定: 解放済みの予約は、同じ見積もりで出し直した予約が生きていれば quote_superseded（在庫は動かない）", async () => {
    const r1 = await reserve(2, { quote: "quote-superseded" });
    await release(r1);
    const before = await available();
    const r2 = await reserve(2, { quote: "quote-superseded" });
    expect(await expectDbError(() => confirm(r1))).toMatch(/quote_superseded/);
    expect(await available()).toBe(before - 2);
    expect((await getPool().query("select status from reservations where id = $1", [r1])).rows[0]).toEqual({ status: "released" });
    await confirm(r2);
    expect(await expectDbError(() => confirm(r1))).toMatch(/quote_superseded/);
    // 出し直しが解放されていれば、遅れた決済でも確定できる（在庫を引き直す）
    const r3 = await reserve(1, { quote: "quote-released-again" });
    await release(r3);
    const r4 = await reserve(1, { quote: "quote-released-again" });
    await release(r4);
    const b2 = await available();
    await confirm(r3);
    expect(await available()).toBe(b2 - 1);
  });

  it("確定: 解放済みの予約は、クーポンの先着枠が残っていなければ coupon_exhausted_after_release（在庫も戻る）", async () => {
    const campaign = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into coupon_campaigns (shop_id, name, code, kind, value, usage_limit) values ($1, '先着 1 名', 'FIRST1', 'fixed', 500, 1) returning id", [f.shopId]))).rows[0]!.id;
    const apply = (res: string, subject: string) =>
      rpc("apply_reservation_discounts", [res, f.shopId, subject, JSON.stringify({ total_jpy: 500, lines: [{ sku_id: f.skuId, discount_jpy: 500 }], applied: [{ campaign_id: campaign, code: "FIRST1", name: "先着 1 名", kind: "fixed", amount_jpy: 500 }] })]);
    const r1 = await reserve(1);
    await apply(r1, `e:${h("a@example.com")}`);
    await release(r1);
    const r2 = await reserve(1);
    await apply(r2, `e:${h("b@example.com")}`);
    const before = await available();
    expect(await expectDbError(() => confirm(r1))).toMatch(/coupon_exhausted_after_release/);
    expect(await available()).toBe(before);
    expect((await getPool().query("select status, count(*)::int as n from coupon_slots where campaign_id = $1 group by status", [campaign])).rows).toEqual([{ status: "held", n: 1 }]);
    // 枠が戻れば確定できる
    await release(r2);
    await confirm(r1);
    expect((await getPool().query("select status from coupon_redemptions where reservation_id = $1", [r1])).rows[0]).toEqual({ status: "used" });
  });

  // ---------- 5. お店で試着 ----------
  it("お店で試着: 申し込んだまま 14 日（settings.store_tryon.request_days）過ぎたものは期限切れにして在庫を戻し、tryon.updated を出す", async () => {
    const request = () =>
      rpc<{ id: string }>("tryon_request", [f.shopId, store, JSON.stringify([{ sku_id: f.skuId, qty: 2 }]), JSON.stringify({ customer_email: `t${Math.random()}@example.com`, customer_name: "山田", ip_hash: h("ip") }), null]);
    const before = await available();
    const old = (await request()).id;
    const young = (await request()).id;
    expect(await available()).toBe(before - 4);
    await getPool().query("update tryon_requests set created_at = now() - interval '15 days' where id = $1", [old]);
    await getPool().query("update tryon_requests set created_at = now() - interval '13 days' where id = $1", [young]);
    expect(await rpc<number>("tryon_expire", [new Date().toISOString().slice(0, 10)])).toBe(1);
    expect((await getPool().query("select id, status, restocked, closed_at is not null as closed from tryon_requests where id in ($1, $2) order by created_at", [old, young])).rows).toEqual([
      { id: old, status: "expired", restocked: true, closed: true },
      { id: young, status: "requested", restocked: false, closed: false },
    ]);
    expect(await available()).toBe(before - 2);
    expect((await getPool().query("select payload->>'status' as s from hook_deliveries where shop_id = $1 and event = 'tryon.updated' and payload->>'request_id' = $2", [f.shopId, old])).rows).toEqual([{ s: "expired" }]);
    // 2 回目は何もしない（在庫を二重に戻さない）
    expect(await rpc<number>("tryon_expire", [new Date().toISOString().slice(0, 10)])).toBe(0);
    expect(await available()).toBe(before - 2);
    // 日数はショップの設定で変えられる（店が扱った sent は対象外）
    await getPool().query("update shops set settings = settings || '{\"store_tryon\": {\"request_days\": \"7\"}}' where id = $1", [f.shopId]);
    const sent = (await request()).id;
    await getPool().query("update tryon_requests set created_at = now() - interval '13 days' where id = $1", [sent]);
    await asUser(f.ownerId, (c) => c.query("select tryon_update($1, $2, 'sent', null)", [f.shopId, sent]));
    expect(await rpc<number>("tryon_expire", [new Date().toISOString().slice(0, 10)])).toBe(1);
    expect((await getPool().query("select status from tryon_requests where id in ($1, $2) order by created_at", [young, sent])).rows).toEqual([{ status: "expired" }, { status: "sent" }]);
    expect(await available()).toBe(before - 2);
  });
});
