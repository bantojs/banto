import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const h = (t: string) => createHash("sha256").update(t).digest("hex");

/** 0181_payment_reminder: KOMOJU の未払いの予約に、24 時間たって 1 回だけ「お支払いのお願い」（hooks checkout.payment_pending） */
describe.skipIf(!dbAvailable)("お支払いのお願い（0181_payment_reminder）", () => {
  let f: Fixture;
  let member: string;
  const MAIL_URL = "https://banto.invalid/plugins/email_resend";
  const LINE_URL = "https://banto.invalid/plugins/line_buyer_notify";
  const svc = <T>(sql: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(sql, args)).rows[0]!.r);
  const run = () => svc<number>("select enqueue_payment_reminders(50) as r", []);
  const deliveries = async () => (await getPool().query<{ event: string; payload: Record<string, unknown>; url: string }>("select d.event, d.payload, e.url from hook_deliveries d join hook_endpoints e on e.id = d.endpoint_id where d.shop_id = $1 and d.event = 'checkout.payment_pending' order by e.url", [f.shopId])).rows;
  async function reservation(quote: string, opts: { session?: boolean; ageHours?: number; leftHours?: number; customer?: string | null } = {}) {
    const rid = await svc<string>("select reserve_stock($1, $2::jsonb, 3600, $3, $4, null) as r", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: 1 }]), quote, h(quote)]);
    await asService((c) => c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [rid, f.shopId, JSON.stringify({ customer_email: `${quote}@example.com`, customer_name: "山田", shipping_address: { state: "東京都", line1: "一丁目" } })]));
    if (opts.session !== false) await svc("select reservation_set_payment_session($1, $2, $3::jsonb, null) as r", [rid, f.shopId, JSON.stringify({ provider: "komoju", id: `ses_${quote}` })]);
    await getPool().query("update reservations set created_at = now() - $2::numeric * interval '1 hour', expires_at = now() + $3::numeric * interval '1 hour', customer_id = $4 where id = $1", [rid, opts.ageHours ?? 25, opts.leftHours ?? 47, opts.customer ?? null]);
    return rid;
  }

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "rem@example.com", slug: "rem-shop", publish: true, stock: 50 });
    const pool = getPool();
    member = (await pool.query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'member@example.com') returning id", [f.shopId])).rows[0]!.id;
    await pool.query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'メール', $2, '{order.paid}'), ($1, 'LINE', $3, '{order.paid}')", [f.shopId, MAIL_URL, LINE_URL]);
  });
  afterAll(closePool);

  it("ショップの設定が ON のときだけ、24 時間たった未払いの KOMOJU の予約に 1 回。ペイロードに個人情報は無い", async () => {
    const due = await reservation("q-rem-due-01");
    await reservation("q-rem-young-1", { ageHours: 2 });
    await reservation("q-rem-late-01", { leftHours: 0.5 });
    await reservation("q-rem-nosess", { session: false });
    // 設定 OFF（既定）では積まない
    expect(await run()).toBe(0);
    await getPool().query("update shops set settings = coalesce(settings, '{}'::jsonb) || '{\"payment_reminder\": true}' where id = $1", [f.shopId]);
    // 同梱のプラグインの購読（0181 の update で足す。ここでは後から作った送信先なので足しておく）
    await getPool().query("update hook_endpoints set events = array_append(events, 'checkout.payment_pending') where shop_id = $1", [f.shopId]);
    expect(await run()).toBe(1);
    const d = await deliveries();
    expect(d.map((x) => x.url)).toEqual([MAIL_URL, LINE_URL]);
    expect(d[0]!.payload).toMatchObject({ reservation_id: due, shop_id: f.shopId, expires_at: expect.any(String) });
    expect(JSON.stringify(d)).not.toMatch(/@example\.com|山田|一丁目/);
    // 2 回目は積まない（reminded_at）
    expect(await run()).toBe(0);
    expect((await getPool().query("select reminded_at from reservations where id = $1", [due])).rows[0]!.reminded_at).not.toBeNull();
  });

  it("メールの中身（まだ払える予約だけ）と LINE の相手（LINE と結びついた会員だけ）。確定・解放したら null", async () => {
    const rid = await reservation("q-rem-cont-1", { customer: member, ageHours: 1 });
    const contact = await svc<Record<string, unknown>>("select reservation_reminder_contact($1, $2) as r", [rid, f.shopId]);
    expect(contact).toMatchObject({ reservation_id: rid, customer_email: "q-rem-cont-1@example.com", customer_name: "山田", total_jpy: expect.any(Number), items: [{ name: expect.any(String), qty: 1, unit_price_jpy: expect.any(Number) }], shop: { slug: "rem-shop" } });
    expect(JSON.stringify(contact)).not.toMatch(/一丁目|東京都/);
    expect(await svc("select reservation_line_recipient($1, $2) as r", [rid, f.shopId])).toBeNull();
    await getPool().query("insert into member_identities (shop_id, provider, subject, customer_id) values ($1, 'line', 'Urem', $2)", [f.shopId, member]);
    const line = await svc<Record<string, unknown>>("select reservation_line_recipient($1, $2) as r", [rid, f.shopId]);
    expect(line).toMatchObject({ line_user_id: "Urem", reservation_id: rid, total_jpy: expect.any(Number) });
    expect(JSON.stringify(line)).not.toMatch(/@example\.com|山田/);
    await asService((c) => c.query("select release_reservation($1, $2)", [rid, f.shopId]));
    expect(await svc("select reservation_reminder_contact($1, $2) as r", [rid, f.shopId])).toBeNull();
    expect(await svc("select reservation_line_recipient($1, $2) as r", [rid, f.shopId])).toBeNull();
  });

  it("「LINE だけ」の会員の予約には notice_line_only の印（0176 と同じ）", async () => {
    await getPool().query("update customers set notice_channel = 'line' where id = $1", [member]);
    await getPool().query("delete from hook_deliveries where shop_id = $1", [f.shopId]);
    const rid = await reservation("q-rem-line-1", { customer: member });
    expect(await run()).toBe(1);
    const d = await deliveries();
    expect(d.find((x) => x.url === MAIL_URL)!.payload).toMatchObject({ reservation_id: rid, notice_line_only: true });
  });

  it("予約の id だけで引く（お支払いのお願いの券）。文面の種類 payment_reminder はリンクが必須", async () => {
    const rid = await reservation("q-rem-get-01", { ageHours: 1 });
    expect(await svc("select reservation_payment_get($1, null, $2, null, null) as r", [f.shopId, rid])).toMatchObject({ reservation_id: rid, status: "pending" });
    const set = (body: string, channel = "mail") => asUser(f.ownerId, (c) => c.query("select notice_text_set($1, 'payment_reminder', $2, $3, $4)", [f.shopId, channel, channel === "mail" ? "【{{shop_name}}】お支払いのお願い" : null, body]));
    expect(await expectDbError(() => set("お支払いください {{total}}"))).toMatch(/body_missing_tag:payment_link/);
    expect(await expectDbError(() => set("{{customer_name}} {{payment_link}}", "line"))).toMatch(/body_unknown_tag:customer_name/);
    await set("{{customer_name}} 様 {{items}} {{total}} {{pay_until}} {{payment_link}}");
    await set("{{shop_name}} {{total}} {{pay_until}} {{payment_link}}", "line");
  });

  it("service_role 専用（anon・運営者からは呼べない）", async () => {
    for (const sql of ["select enqueue_payment_reminders(1)", "select reservation_reminder_contact(gen_random_uuid(), $1)", "select reservation_line_recipient(gen_random_uuid(), $1)"]) {
      const args = sql.includes("$1") ? [f.shopId] : [];
      expect(await expectDbError(() => asAnon((c) => c.query(sql, args)))).toMatch(/permission denied/);
      expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query(sql, args)))).toMatch(/permission denied/);
    }
  });
});
