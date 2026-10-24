import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** ゲストの subject（メールアドレスの SHA-256。メールアドレスそのものは DB に置かない） */
const guest = (email: string) => `e:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`;
const items = (skuId: string, qty: number) => JSON.stringify([{ sku_id: skuId, qty }]);

describe.skipIf(!dbAvailable)("クーポン（0010_coupons）", () => {
  let f: Fixture;
  let other: Fixture;

  const reserve = (qty: number, shop: Fixture = f) =>
    asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [shop.shopId, items(shop.skuId, qty)])).rows[0]!.id);
  const campaign = (fields: Record<string, unknown>, owner: Fixture = f) =>
    asUser(owner.ownerId, async (c) => {
      const cols = Object.keys(fields);
      const r = await c.query<{ id: string }>(
        `insert into coupon_campaigns (shop_id, ${cols.join(", ")}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}) returning id`,
        [owner.shopId, ...cols.map((k) => (typeof fields[k] === "object" && fields[k] !== null ? JSON.stringify(fields[k]) : fields[k]))],
      );
      return r.rows[0]!.id;
    });
  const apply = (resId: string, subject: string, applied: Record<string, unknown>[], total: number, lines: Record<string, unknown>[] = []) =>
    asService(async (c) =>
      (await c.query<{ r: Record<string, unknown> }>("select apply_reservation_discounts($1, $2, $3, $4::jsonb) as r", [resId, f.shopId, subject, JSON.stringify({ total_jpy: total, lines, applied })])).rows[0]!.r,
    );
  const confirm = (resId: string, order: Record<string, unknown> = { payment_provider: "stripe", payment_ref: "pi_1" }) =>
    asService(async (c) => (await c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [resId, f.shopId, JSON.stringify(order)])).rows[0]!.id);
  const release = (resId: string) => asService(async (c) => (await c.query<{ ok: boolean }>("select release_reservation($1, $2) as ok", [resId, f.shopId])).rows[0]!.ok);
  const lookup = (codes: string[], subject: string | null = null, shop: Fixture = f) =>
    asService(async (c) => (await c.query<{ r: Record<string, unknown>[] }>("select coupon_lookup($1, $2, $3) as r", [shop.shopId, codes, subject])).rows[0]!.r);
  const slots = async (campaignId: string) =>
    Object.fromEntries((await getPool().query<{ status: string; n: number }>("select status, count(*)::int as n from coupon_slots where campaign_id = $1 group by status", [campaignId])).rows.map((r) => [r.status, r.n]));

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "owner@example.com", slug: "shop", publish: true, stock: 500 });
    other = await createShopFixture({ email: "other@example.com", slug: "other", publish: true, stock: 20 });
  });
  afterAll(closePool);

  it("キャンペーンは owner だけが管理でき、購入者（anon / 他の owner）は読めない。上限の数だけ枠ができる", async () => {
    const id = await campaign({ name: "夏のセール", code: "SUMMER10", kind: "percent", value: 10, usage_limit: 3 });
    expect(await slots(id)).toEqual({ free: 3 });
    // 上限を変えると枠も合わせる
    await asUser(f.ownerId, (c) => c.query("update coupon_campaigns set usage_limit = 5 where id = $1", [id]));
    expect(await slots(id)).toEqual({ free: 5 });
    await asUser(f.ownerId, (c) => c.query("update coupon_campaigns set usage_limit = 2 where id = $1", [id]));
    expect(await slots(id)).toEqual({ free: 2 });

    expect((await asAnon((c) => c.query("select * from coupon_campaigns"))).rowCount).toBe(0);
    expect((await asUser(other.ownerId, (c) => c.query("select * from coupon_campaigns"))).rowCount).toBe(0);
    expect(await expectDbError(() => campaign({ name: "x", code: "BAD", kind: "fixed", value: 100 }, { ...other, shopId: f.shopId }))).toMatch(/row-level security/);
    // 値の範囲・コードの形
    expect(await expectDbError(() => campaign({ name: "x", code: "TOO", kind: "percent", value: 120 }))).toMatch(/check constraint/);
    expect(await expectDbError(() => campaign({ name: "x", code: "lower", kind: "fixed", value: 100 }))).toMatch(/check constraint/);
    expect(await expectDbError(() => campaign({ name: "x", code: "SUMMER10", kind: "fixed", value: 100 }))).toMatch(/duplicate key/);
    // 判定の材料は service_role だけ
    expect(await expectDbError(() => asAnon((c) => c.query("select coupon_lookup($1, $2)", [f.shopId, ["SUMMER10"]])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select coupon_lookup($1, $2)", [f.shopId, ["SUMMER10"]])))).toMatch(/permission denied/);
    const found = await lookup(["summer10 ", "NOPE"]);
    expect(found).toEqual([expect.objectContaining({ id, code: "SUMMER10", kind: "percent", value: 10, available: true, used_by_subject: 0 })]);
    expect(await lookup(["SUMMER10"], null, other)).toEqual([]);
  });

  it("予約に値引きを付け、確定で使用済み・合計から引く。商品ごとの値引きは明細に残る", async () => {
    const id = await campaign({ name: "500 円引き", code: "OFF500", kind: "fixed", value: 500, usage_limit: 10, per_customer_limit: 1 });
    const r = await reserve(2);
    await asService((c) => c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [r, f.shopId, JSON.stringify({ customer_email: "a@example.com", shipping_jpy: 800 })]));
    await apply(r, guest("a@example.com"), [{ campaign_id: id, code: "OFF500", name: "500 円引き", kind: "fixed", amount_jpy: 500 }], 500, [{ sku_id: f.skuId, discount_jpy: 500 }]);
    expect(await slots(id)).toEqual({ free: 9, held: 1 });
    const o = await confirm(r, { payment_provider: "stripe", payment_ref: "pi_x", amount_paid_jpy: 6300 });
    const order = (await getPool().query("select total_jpy, shipping_jpy, discount_jpy, amount_paid_jpy, discounts from orders where id = $1", [o])).rows[0];
    expect(order).toMatchObject({ total_jpy: 6000 + 800 - 500, shipping_jpy: 800, discount_jpy: 500, amount_paid_jpy: 6300 });
    expect(order.discounts).toEqual([expect.objectContaining({ code: "OFF500", amount_jpy: 500 })]);
    expect((await getPool().query("select discount_jpy from order_items where order_id = $1", [o])).rows).toEqual([{ discount_jpy: 500 }]);
    expect(await slots(id)).toEqual({ free: 9, used: 1 });
    expect((await getPool().query("select status, order_id from coupon_redemptions where reservation_id = $1", [r])).rows).toEqual([{ status: "used", order_id: o }]);
    // hooks に値引き
    const hook = await getPool().query("select payload from hook_deliveries where event = 'order.paid' and payload->>'order_id' = $1", [o]);
    void hook;

    // 1 人あたりの上限: 同じ人はもう使えない（別の人は使える）
    expect(await lookup(["OFF500"], guest("A@example.com "))).toEqual([expect.objectContaining({ used_by_subject: 1 })]);
    const r2 = await reserve(1);
    expect(await expectDbError(() => apply(r2, guest("a@example.com"), [{ campaign_id: id, code: "OFF500", amount_jpy: 500 }], 500))).toMatch(/coupon_limit_reached/);
    // 失敗した呼び出しは何も残さない（取引ごと取り消し）
    expect(await slots(id)).toEqual({ free: 9, used: 1 });
    await apply(r2, guest("b@example.com"), [{ campaign_id: id, code: "OFF500", amount_jpy: 500 }], 500);
    expect(await slots(id)).toEqual({ free: 8, held: 1, used: 1 });
    // 決済ページの期限切れ（解放）で枠と回数が戻る
    expect(await release(r2)).toBe(true);
    expect(await slots(id)).toEqual({ free: 9, used: 1 });
    expect((await getPool().query("select status from coupon_redemptions where reservation_id = $1", [r2])).rows).toEqual([{ status: "released" }]);

    // キャンセルで回数が戻り、同じ人がまた使える
    await asService((c) => c.query("select cancel_order($1, $2, true)", [o, f.shopId]));
    expect(await slots(id)).toEqual({ free: 10 });
    expect(await lookup(["OFF500"], guest("a@example.com"))).toEqual([expect.objectContaining({ used_by_subject: 0 })]);
  });

  it("期間外・無効・合計を超える値引き・他人の予約は受け付けない。service_role 以外は呼べない", async () => {
    const past = await campaign({ name: "終わった", code: "PAST", kind: "fixed", value: 100, ends_at: "2020-01-01T00:00:00Z", starts_at: "2019-01-01T00:00:00Z" });
    const off = await campaign({ name: "停止中", code: "OFF", kind: "fixed", value: 100, active: false });
    const r = await reserve(1);
    expect(await expectDbError(() => apply(r, guest("c@example.com"), [{ campaign_id: past, amount_jpy: 100 }], 100))).toMatch(/coupon_unavailable/);
    expect(await expectDbError(() => apply(r, guest("c@example.com"), [{ campaign_id: off, amount_jpy: 100 }], 100))).toMatch(/coupon_unavailable/);
    expect(await expectDbError(() => apply(r, guest("c@example.com"), [], 999_999))).toMatch(/invalid_discount/);
    expect(await expectDbError(() => apply(r, "e:not-a-hash", [], 0))).toMatch(/invalid_subject/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select apply_reservation_discounts($1, $2, $3, '{}'::jsonb)", [r, f.shopId, guest("c@example.com")])))).toMatch(/permission denied/);
    const ro = await reserve(1, other);
    expect(await expectDbError(() => apply(ro, guest("c@example.com"), [], 0))).toMatch(/reservation_not_found/);
    await release(r);
  });

  it("TTL 切れで解放された後に決済が完了したら、値引きはそのまま有効にし、空き枠を取り直す", async () => {
    const id = await campaign({ name: "先着 1 名", code: "FIRST1", kind: "fixed", value: 300, usage_limit: 1 });
    const r = await reserve(1);
    await apply(r, guest("d@example.com"), [{ campaign_id: id, code: "FIRST1", amount_jpy: 300 }], 300, [{ sku_id: f.skuId, discount_jpy: 300 }]);
    await release(r);
    expect(await slots(id)).toEqual({ free: 1 });
    const o = await confirm(r);
    expect((await getPool().query("select total_jpy, discount_jpy from orders where id = $1", [o])).rows[0]).toEqual({ total_jpy: 2700, discount_jpy: 300 });
    expect(await slots(id)).toEqual({ used: 1 });
    expect((await getPool().query("select status from coupon_redemptions where reservation_id = $1", [r])).rows).toEqual([{ status: "used" }]);
  });

  it("先着: 50 人が同時に申し込んでも、上限ちょうどで止まり 1 枚も超えない（空き枠を SKIP LOCKED で取り合う）", async () => {
    const id = await campaign({ name: "先着 10 名", code: "RUSH10", kind: "fixed", value: 100, usage_limit: 10 });
    const reservations = await Promise.all(Array.from({ length: 50 }, () => reserve(1)));
    const results = await Promise.allSettled(
      reservations.map((r, i) => apply(r, guest(`rush${i}@example.com`), [{ campaign_id: id, code: "RUSH10", amount_jpy: 100 }], 100)),
    );
    const ok = results.filter((x) => x.status === "fulfilled").length;
    const exhausted = results.filter((x) => x.status === "rejected" && String((x as PromiseRejectedResult).reason).includes("coupon_exhausted")).length;
    expect(ok).toBe(10);
    expect(exhausted).toBe(40);
    expect(await slots(id)).toEqual({ held: 10 });
    expect((await getPool().query("select count(*)::int as n from coupon_redemptions where campaign_id = $1", [id])).rows[0].n).toBe(10);
    expect((await lookup(["RUSH10"]))[0]).toMatchObject({ available: false });
    // 期限切れの一括解放でも枠が戻る
    await getPool().query("update reservations set expires_at = now() - interval '1 minute' where id = any($1)", [reservations]);
    await asService((c) => c.query("select release_expired_reservations()"));
    expect(await slots(id)).toEqual({ free: 10 });
  });

  it("同じ人が同時に 2 回申し込んでも、1 人あたりの上限を超えない", async () => {
    const id = await campaign({ name: "1 人 1 回", code: "ONCE", kind: "fixed", value: 100, per_customer_limit: 1 });
    const [a, b] = await Promise.all([reserve(1), reserve(1)]);
    const results = await Promise.allSettled([a, b].map((r) => apply(r, guest("same@example.com"), [{ campaign_id: id, code: "ONCE", amount_jpy: 100 }], 100)));
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(String((results.find((x) => x.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/coupon_limit_reached/);
    await release(a);
    await release(b);
  });

  it("クーポンが数万件・使用の記録が溜まっても、コードと 1 人あたりの回数は索引で引く（全件を読まない）", async () => {
    // 2 万件のキャンペーンと 2 万件の使用の記録
    await getPool().query(
      `insert into coupon_campaigns (shop_id, name, code, kind, value, per_customer_limit)
       select $1, 'bulk ' || g, 'BULK' || g, 'fixed', 100, 1 from generate_series(1, 20000) g`,
      [f.shopId],
    );
    const r = await reserve(1);
    await getPool().query(
      `insert into coupon_redemptions (shop_id, campaign_id, reservation_id, subject, status)
       select $1, c.id, $2, 'e:' || md5(c.code) || md5(c.code), 'used' from coupon_campaigns c where c.code like 'BULK%'`,
      [f.shopId, r],
    );
    await getPool().query("analyze coupon_campaigns; analyze coupon_redemptions; analyze coupon_slots");
    const plan = async (sql: string, params: unknown[]) => (await getPool().query<{ "QUERY PLAN": string }>(`explain ${sql}`, params)).rows.map((x) => x["QUERY PLAN"]).join("\n");
    const byCode = await plan("select * from coupon_campaigns where shop_id = $1 and code = $2", [f.shopId, "BULK777"]);
    expect(byCode).toMatch(/Index Scan|Index Only Scan|Bitmap Index Scan/);
    expect(byCode).not.toMatch(/Seq Scan/);
    const bySubject = await plan("select count(*) from coupon_redemptions where campaign_id = (select id from coupon_campaigns where shop_id = $1 and code = 'BULK777') and subject = $2 and status <> 'released'", [f.shopId, guest("x@example.com")]);
    expect(bySubject).not.toMatch(/Seq Scan on coupon_redemptions/);
    // 上限 3 万回のキャンペーンで、ほとんどの枠が使用済みでも、空き枠は部分索引から探す
    const big = await campaign({ name: "大量", code: "BIG", kind: "fixed", value: 100, usage_limit: 30000 });
    await getPool().query("update coupon_slots set status = 'used' where id in (select id from coupon_slots where campaign_id = $1 limit 29990)", [big]);
    await getPool().query("analyze coupon_slots");
    const freeSlot = await plan("select id from coupon_slots where campaign_id = $1 and status = 'free' limit 1", [big]);
    expect(freeSlot).toMatch(/coupon_slots_free/);
    // 見つけるまでの時間も、件数に関係なく小さい
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) await lookup([`BULK${1000 + i}`], guest("x@example.com"));
    expect(Date.now() - t0).toBeLessThan(2000);
    await release(r);
  });

  it("会員の注文は会員 ID で数える（メールアドレスを変えても回数は同じ人のもの）", async () => {
    const uid = await createAuthUser("member@example.com");
    const id = await campaign({ name: "会員限定", code: "MEMBER", kind: "percent", value: 5, audience: "members", per_customer_limit: 1 });
    const r = await reserve(1);
    await apply(r, `c:${uid}`, [{ campaign_id: id, code: "MEMBER", amount_jpy: 150 }], 150);
    await confirm(r);
    expect(await lookup(["MEMBER"], `c:${uid}`)).toEqual([expect.objectContaining({ audience: "members", used_by_subject: 1 })]);
    // 会員限定はゲストの subject では取れない
    const r2 = await reserve(1);
    expect(await expectDbError(() => apply(r2, guest("member@example.com"), [{ campaign_id: id, code: "MEMBER", amount_jpy: 150 }], 150))).toMatch(/coupon_unavailable/);
    await release(r2);
    await getPool().query("update auth.users set email = 'changed@example.com' where id = $1", [uid]);
    expect(await lookup(["MEMBER"], `c:${uid}`)).toEqual([expect.objectContaining({ used_by_subject: 1 })]);
  });
});
