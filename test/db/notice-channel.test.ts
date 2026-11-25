import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { asService, asUser, closePool, createShopFixture, dbAvailable, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0176_notice_channel: 注文・お店で試着のお知らせを「LINE だけ」で受け取る。
 * 選ぶのは本人だけ（member_set_notice_channel）。効くのは LINE と結びつき、ショップが「LINE で購入者に知らせる」を使っているときだけ。
 * 決めるのは hooks を積むとき（payload の notice_line_only）。届けられなければメール通知に配り直す（プラグインか DB のトリガー）
 */
describe.skipIf(!dbAvailable)("お知らせの受け取り方（0176）", () => {
  let f: Fixture;
  let member: string;
  let guestOrder: string;
  let memberOrder: string;
  let lineEp: string;
  let mailEp: string;
  let request: string;
  const LINE_URL = "https://banto.invalid/plugins/line_buyer_notify";
  const MAIL_URL = "https://banto.invalid/plugins/email_resend";
  const svc = <T>(sql: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(sql, args)).rows[0]!.r);
  const setChannel = (ch: string, epoch = 0) => svc<string>("select member_set_notice_channel($1, $2, $3, $4) as r", [f.shopId, member, epoch, ch]);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "nc-owner@example.com", slug: "nc-shop", publish: true });
    const pool = getPool();
    member = (await pool.query<{ id: string }>("insert into customers (shop_id, email, name) values ($1, 'm@example.com', '会員') returning id", [f.shopId])).rows[0]!.id;
    const order = async (n: number, customer: string | null) =>
      (await pool.query<{ id: string }>(
        "insert into orders (shop_id, number, status, total_jpy, shipping_jpy, customer_email, customer_name, payment_provider, payment_ref, customer_id) values ($1, $2, 'paid', 100, 0, 'm@example.com', '会員', 'stripe', $3, $4) returning id",
        [f.shopId, n, `pi_${n}`, customer],
      )).rows[0]!.id;
    memberOrder = await order(1001, member);
    guestOrder = await order(1002, null);
    lineEp = (await pool.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'LINE', $2, '{order.paid,order.shipped,tryon.requested,tryon.updated,order.created}') returning id", [f.shopId, LINE_URL])).rows[0]!.id;
    mailEp = (await pool.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'メール', $2, '{order.paid,order.shipped}') returning id", [f.shopId, MAIL_URL])).rows[0]!.id;
    const orgId = (await pool.query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    const store = (await pool.query<{ id: string }>("insert into stores (org_id, name) values ($1, '本店') returning id", [orgId])).rows[0]!.id;
    request = (await pool.query<{ id: string }>("insert into tryon_requests (shop_id, store_id, number, customer_email, customer_name, customer_id) values ($1, $2, 1, 'm@example.com', '会員', $3) returning id", [f.shopId, store, member])).rows[0]!.id;
  });
  afterAll(closePool);

  const mark = async (event: string, payload: Record<string, unknown>) => {
    await svc<number>("select enqueue_hook($1, $2, $3) as r", [f.shopId, event, payload]);
    const r = await getPool().query<{ endpoint_id: string; payload: Record<string, unknown> }>(
      "select endpoint_id, payload from hook_deliveries where shop_id = $1 and event = $2 order by created_at desc, id desc limit 1", [f.shopId, event]);
    return r.rows[0]!.payload;
  };
  const lineDelivery = async (event: string) =>
    (await getPool().query<{ id: string }>("select id from hook_deliveries where endpoint_id = $1 and event = $2 order by created_at desc, id desc limit 1", [lineEp, event])).rows[0]!.id;
  const fallbacksOf = async (id: string) =>
    (await getPool().query<{ endpoint_id: string; payload: Record<string, unknown> }>("select endpoint_id, payload from hook_deliveries where payload->>'fallback_of' = $1", [id])).rows;

  it("LINE と結びついていない会員は LINE だけを選べない。世代が違えば invalid", async () => {
    expect(await setChannel("line")).toBe("line_unavailable");
    expect(await setChannel("all", 9)).toBe("invalid");
    await expect(setChannel("sms")).rejects.toThrow(/invalid_notice_channel/);
  });

  it("選べれば、積むときに印を付ける（ゲスト・受け取らない出来事には付けない）。member_get にも出る", async () => {
    await getPool().query("insert into member_identities (shop_id, provider, subject, customer_id) values ($1, 'line', 'U123', $2)", [f.shopId, member]);
    const rec = await svc<{ customer: Record<string, unknown> }>("select member_get($1, $2, 0) as r", [f.shopId, member]);
    expect(rec.customer).toMatchObject({ notice_channel: "all", notice_line_available: true });
    expect((await mark("order.paid", { order_id: memberOrder }))["notice_line_only"]).toBeUndefined();
    expect(await setChannel("line")).toBe("ok");
    expect(await mark("order.paid", { order_id: memberOrder })).toMatchObject({ notice_line_only: true });
    expect((await mark("order.paid", { order_id: guestOrder }))["notice_line_only"]).toBeUndefined();
    expect(await mark("tryon.requested", { request_id: request })).toMatchObject({ notice_line_only: true });
    // LINE のプラグインがその出来事を受け取らないなら付けない（メールで送る）
    await getPool().query("update hook_endpoints set events = '{order.paid,tryon.requested,tryon.updated,order.created}' where id = $1", [lineEp]);
    expect((await mark("order.shipped", { order_id: memberOrder }))["notice_line_only"]).toBeUndefined();
    await getPool().query("update hook_endpoints set events = '{order.paid,order.shipped,tryon.requested,tryon.updated,order.created}' where id = $1", [lineEp]);
  });

  it("配り直し: 印のある LINE の配信をメール通知にだけ 1 回（受け取らない出来事・LINE 以外・印の無い配信は 0）", async () => {
    await mark("order.paid", { order_id: memberOrder });
    const d = await lineDelivery("order.paid");
    expect(await svc<number>("select notice_line_fallback($1) as r", [d])).toBe(1);
    expect(await svc<number>("select notice_line_fallback($1) as r", [d])).toBe(0);
    const re = await fallbacksOf(d);
    expect(re).toHaveLength(1);
    expect(re[0]).toMatchObject({ endpoint_id: mailEp, payload: { order_id: memberOrder, notice_line_only: true, line_fallback: true, fallback_of: d } });
    // 同じ元の配信の行は索引で 1 つだけ
    await expect(getPool().query("insert into hook_deliveries (shop_id, endpoint_id, event, payload) values ($1, $2, 'order.paid', $3)", [f.shopId, mailEp, { fallback_of: d }])).rejects.toThrow(/duplicate/);
    // メール通知がその出来事を受け取らない（tryon.requested）
    await mark("tryon.requested", { request_id: request });
    expect(await svc<number>("select notice_line_fallback($1) as r", [await lineDelivery("tryon.requested")])).toBe(0);
    // 印の無い（ゲストの）配信
    await mark("order.paid", { order_id: guestOrder });
    expect(await svc<number>("select notice_line_fallback($1) as r", [await lineDelivery("order.paid")])).toBe(0);
  });

  it("再送の末に failed になった印のある LINE の配信は、DB がメールへ配り直す", async () => {
    await mark("order.shipped", { order_id: memberOrder });
    const d = await lineDelivery("order.shipped");
    await getPool().query("update hook_deliveries set status = 'failed' where id = $1", [d]);
    expect(await fallbacksOf(d)).toHaveLength(1);
  });

  it("LINE のプラグインを止めたら、まだ送っていない印のある配信を failed にしてメールへ。消したときも", async () => {
    const pool = getPool();
    await mark("order.shipped", { order_id: memberOrder });
    const d1 = await lineDelivery("order.shipped");
    await pool.query("update hook_endpoints set enabled = false where id = $1", [lineEp]);
    expect((await pool.query<{ status: string }>("select status from hook_deliveries where id = $1", [d1])).rows[0]!.status).toBe("failed");
    expect(await fallbacksOf(d1)).toHaveLength(1);
    // 止めているあいだは印を付けない
    expect((await mark("order.paid", { order_id: memberOrder }))["notice_line_only"]).toBeUndefined();
    const rec = await svc<{ customer: Record<string, unknown> }>("select member_get($1, $2, 0) as r", [f.shopId, member]);
    expect(rec.customer).toMatchObject({ notice_channel: "line", notice_line_available: false });
    await pool.query("update hook_endpoints set enabled = true where id = $1", [lineEp]);
    await mark("order.shipped", { order_id: memberOrder });
    const d2 = await lineDelivery("order.shipped");
    await pool.query("delete from hook_endpoints where id = $1", [lineEp]);
    expect(await fallbacksOf(d2)).toHaveLength(1);
    lineEp = (await pool.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'LINE', $2, '{order.paid,order.shipped,tryon.requested,tryon.updated,order.created}') returning id", [f.shopId, LINE_URL])).rows[0]!.id;
  });

  it("運営者は見られるが書けない。AI 用 API の会員にも出る。関数は anon・authenticated から呼べない", async () => {
    const pool = getPool();
    const seen = await asUser(f.ownerId, (c) => c.query<{ notice_channel: string }>("select notice_channel from customers where id = $1", [member]));
    expect(seen.rows[0]!.notice_channel).toBe("line");
    // 書き込みの許しが無い（RLS で 0 行）か、権限で断られる。どちらでも値は変わらない
    const upd = await asUser(f.ownerId, (c) => c.query("update customers set notice_channel = 'all' where id = $1", [member])).catch(() => null);
    expect(upd?.rowCount ?? 0).toBe(0);
    expect((await pool.query<{ n: string }>("select notice_channel as n from customers where id = $1", [member])).rows[0]!.n).toBe("line");
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    const sha = createHash("sha256").update(raw).digest("hex");
    await asUser(f.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, '{customers:read}')", [f.shopId, f.ownerId, sha, raw.slice(0, 12)]));
    expect((await svc<Record<string, unknown>>("select api_customer_get($1, $2) as r", [sha, member]))["notice_channel"]).toBe("line");
    for (const role of ["anon", "authenticated"]) {
      for (const fn of ["member_set_notice_channel(uuid, uuid, integer, text)", "notice_line_fallback(uuid)", "banto_notice_line_fallback(uuid)", "banto_notice_line_only(uuid, uuid, text)", "banto_notice_line_ready(uuid, uuid, text)"]) {
        const r = await pool.query<{ ok: boolean }>(`select has_function_privilege($1, '${fn}', 'execute') as ok`, [role]);
        expect(r.rows[0]!.ok, `${role} ${fn}`).toBe(false);
      }
    }
  });

  it("LINE だけから戻せる（戻した後は印を付けない）", async () => {
    expect(await setChannel("all")).toBe("ok");
    expect((await mark("order.paid", { order_id: memberOrder }))["notice_line_only"]).toBeUndefined();
  });
});
