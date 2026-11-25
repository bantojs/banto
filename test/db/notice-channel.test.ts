import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { asService, asUser, closePool, createShopFixture, dbAvailable, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0176_notice_channel: 注文・お店で試着のお知らせを「LINE だけ」で受け取る。
 * 選ぶのは本人だけ（member_set_notice_channel）。効くのは LINE と結びつき、ショップが「LINE で購入者に知らせる」を使っているときだけ。
 * メール通知は order_contact・tryon_contact の notice_line_only を見て、LINE のプラグインは送れなければ notice_line_fallback で配り直す
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
  const contact = (orderId: string) => svc<Record<string, unknown>>("select order_contact($1, $2) as r", [orderId, f.shopId]);

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

  it("LINE と結びついていない会員は LINE だけを選べない。世代が違えば invalid", async () => {
    expect(await setChannel("line")).toBe("line_unavailable");
    expect(await setChannel("all", 9)).toBe("invalid");
    await expect(setChannel("sms")).rejects.toThrow(/invalid_notice_channel/);
    expect((await contact(memberOrder))["notice_line_only"]).toBe(false);
  });

  it("LINE と結びつき、ショップが LINE で知らせていれば選べて効く。ゲストの注文には効かない", async () => {
    await getPool().query("insert into member_identities (shop_id, provider, subject, customer_id) values ($1, 'line', 'U123', $2)", [f.shopId, member]);
    const rec = await svc<{ customer: Record<string, unknown> }>("select member_get($1, $2, 0) as r", [f.shopId, member]);
    expect(rec.customer).toMatchObject({ notice_channel: "all", notice_line_available: true });
    expect(await setChannel("line")).toBe("ok");
    expect((await contact(memberOrder))["notice_line_only"]).toBe(true);
    expect((await contact(guestOrder))["notice_line_only"]).toBe(false);
    expect((await svc<Record<string, unknown>>("select tryon_contact($1, $2) as r", [request, f.shopId]))["notice_line_only"]).toBe(true);
    expect((await svc<Record<string, unknown>>("select order_line_recipient($1, $2) as r", [memberOrder, f.shopId]))["line_only"]).toBe(true);
    expect((await svc<Record<string, unknown>>("select tryon_line_recipient($1, $2) as r", [request, f.shopId]))["line_only"]).toBe(true);
  });

  it("LINE のプラグインを止めたら効かない（メールも送る）。戻せばまた効く", async () => {
    const pool = getPool();
    await pool.query("update hook_endpoints set enabled = false where id = $1", [lineEp]);
    expect((await contact(memberOrder))["notice_line_only"]).toBe(false);
    const rec = await svc<{ customer: Record<string, unknown> }>("select member_get($1, $2, 0) as r", [f.shopId, member]);
    expect(rec.customer).toMatchObject({ notice_channel: "line", notice_line_available: false });
    await pool.query("update hook_endpoints set enabled = true where id = $1", [lineEp]);
    expect((await contact(memberOrder))["notice_line_only"]).toBe(true);
  });

  it("LINE で送れなかった知らせは、メール通知にだけ 1 回配り直す（受け取らない出来事・LINE 以外の配信は 0）", async () => {
    const pool = getPool();
    const delivery = async (ep: string, event: string) =>
      (await pool.query<{ id: string }>("insert into hook_deliveries (shop_id, endpoint_id, event, payload) values ($1, $2, $3, $4) returning id", [f.shopId, ep, event, { order_id: memberOrder }])).rows[0]!.id;
    const d = await delivery(lineEp, "order.paid");
    expect(await svc<number>("select notice_line_fallback($1) as r", [d])).toBe(1);
    expect(await svc<number>("select notice_line_fallback($1) as r", [d])).toBe(0);
    const re = await pool.query<{ endpoint_id: string; event: string; payload: Record<string, unknown> }>("select endpoint_id, event, payload from hook_deliveries where payload->>'fallback_of' = $1", [d]);
    expect(re.rows).toHaveLength(1);
    expect(re.rows[0]).toMatchObject({ endpoint_id: mailEp, event: "order.paid", payload: { order_id: memberOrder, line_fallback: true, fallback_of: d } });
    // メール通知がその出来事を受け取らない
    expect(await svc<number>("select notice_line_fallback($1) as r", [await delivery(lineEp, "tryon.requested")])).toBe(0);
    // LINE の送信先の配信でなければ何もしない
    expect(await svc<number>("select notice_line_fallback($1) as r", [await delivery(mailEp, "order.shipped")])).toBe(0);
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
    const got = await svc<Record<string, unknown>>("select api_customer_get($1, $2) as r", [sha, member]);
    expect(got["notice_channel"]).toBe("line");
    for (const role of ["anon", "authenticated"]) {
      for (const fn of ["member_set_notice_channel(uuid, uuid, integer, text)", "notice_line_fallback(uuid)", "banto_notice_line_only(uuid, uuid)", "banto_notice_line_ready(uuid, uuid)"]) {
        const r = await pool.query<{ ok: boolean }>(`select has_function_privilege($1, '${fn}', 'execute') as ok`, [role]);
        expect(r.rows[0]!.ok, `${role} ${fn}`).toBe(false);
      }
    }
  });

  it("LINE だけから戻せる", async () => {
    expect(await setChannel("all")).toBe("ok");
    expect((await contact(memberOrder))["notice_line_only"]).toBe(false);
  });
});
