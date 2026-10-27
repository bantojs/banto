import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

describe.skipIf(!dbAvailable)("お問い合わせ（0061_mod_inquiries）", () => {
  let f: Fixture;
  let other: Fixture;
  let orgId: string;
  let support: string;
  let catalogOnly: string;
  let memberId: string;
  let guestOrder: string;
  let memberOrder: string;
  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "inq@example.com", slug: "inq-shop", publish: true });
    other = await createShopFixture({ email: "inq-o@example.com", slug: "inq-other", publish: true });
    const pool = getPool();
    await pool.query("update shops set settings = settings || '{\"modules\":{\"inquiries\":true},\"contact_email\":\"shop@example.com\"}'::jsonb where id = $1", [f.shopId]);
    await pool.query("insert into hook_endpoints (shop_id, name, url, events, settings) values ($1, 'mail', 'https://banto.invalid/plugins/email_resend', '{}', '{\"from\": \"Shop <shop@example.com>\"}')", [f.shopId]);
    await pool.query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'x', 'https://example.com/h', '{inquiry.created,inquiry.updated}')", [f.shopId]);
    memberId = (await pool.query<{ id: string }>("insert into customers (shop_id, email, name) values ($1, 'Member@Example.com', '会員') returning id", [f.shopId])).rows[0]!.id;
    guestOrder = (await pool.query<{ id: string }>("insert into orders (shop_id, number, status, total_jpy, shipping_jpy, customer_email, customer_name, payment_provider, payment_ref) values ($1, 1001, 'paid', 3000, 0, 'guest@example.com', 'ゲスト', 'stripe', 'pi_1') returning id", [f.shopId])).rows[0]!.id;
    memberOrder = (await pool.query<{ id: string }>("insert into orders (shop_id, number, status, total_jpy, shipping_jpy, customer_email, customer_id, payment_provider, payment_ref) values ($1, 1002, 'paid', 5000, 0, 'member@example.com', $2, 'stripe', 'pi_2') returning id", [f.shopId, memberId])).rows[0]!.id;
    orgId = (await pool.query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    // 問い合わせの担当（support だけ）と、商品の担当（catalog だけ）
    support = await createAuthUser("support@example.com");
    catalogOnly = await createAuthUser("catalog@example.com");
    for (const [uid, email, perms] of [[support, "support@example.com", ["support"]], [catalogOnly, "catalog@example.com", ["catalog"]]] as const) {
      await asUser(f.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, email, JSON.stringify([{ shop_id: f.shopId, perms }]), hash(`t-${email}`)]));
      await withRole("authenticated", { sub: uid, email }, (c) => c.query("select org_invitation_accept($1)", [hash(`t-${email}`)]));
    }
  });
  afterAll(closePool);

  const create = (input: J, link = hash(`link-${Math.random()}`), ip: string | null = hash(`ip-${Math.random()}`), shop = f.shopId) =>
    asService(async (c) => (await c.query<{ r: J }>("select inquiry_create($1, $2::jsonb, $3, $4) as r", [shop, JSON.stringify(input), link, ip])).rows[0]!.r);
  const get = (access: J) => asService(async (c) => (await c.query<{ r: J | null }>("select inquiry_get($1, $2::jsonb) as r", [f.shopId, JSON.stringify(access)])).rows[0]!.r);
  const row = async (id: unknown) => (await getPool().query("select * from inquiries where id = $1", [id])).rows[0] as J;
  const hooks = async () => (await getPool().query<{ event: string; payload: J }>("select event, payload from hook_deliveries where shop_id = $1 and event like 'inquiry.%' order by created_at", [f.shopId])).rows;
  const mails = async (id: unknown) => (await getPool().query<{ kind: string }>("select kind from inquiry_mails where inquiry_id = $1 order by id", [id])).rows.map((r) => r.kind);

  it("権限の項目に support が増え、support の担当だけが運営側で読める。お客様の経路の関数は service_role だけ", async () => {
    expect((await getPool().query("select perms from org_member_shops where user_id = $1", [support])).rows).toEqual([{ perms: ["support"] }]);
    const r = await create({ basis: "form", category: "other", body: "質問です", email: "q@example.com" });
    expect((await asUser(support, (c) => c.query("select number from inquiries where id = $1", [r.id]))).rows).toHaveLength(1);
    expect((await asUser(catalogOnly, (c) => c.query("select number from inquiries where id = $1", [r.id]))).rows).toHaveLength(0);
    expect((await asUser(other.ownerId, (c) => c.query("select number from inquiries where id = $1", [r.id]))).rows).toHaveLength(0);
    expect(await asUser(catalogOnly, async (c) => (await c.query("select inquiry_admin_get($1) as r", [r.id])).rows[0].r)).toBeNull();
    // 運営側も表を直接は書けない（関数だけ）
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update inquiries set status = 'closed' where id = $1", [r.id])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select inquiry_create($1, '{}'::jsonb, $2, null)", [f.shopId, hash("x")])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asAnon((c) => c.query("select inquiry_get($1, '{}'::jsonb)", [f.shopId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asAnon((c) => c.query("select id from inquiries")))).toMatch(/permission denied/);
  });

  it("ゲスト: 確認のメールを送り、リンクで開くまで未確認（hooks・運営者へのお知らせはまだ）。開くと確認済みになり、会員と一致すれば結ぶ", async () => {
    const link = hash("guest-link");
    const r = await create({ basis: "form", category: "account", body: "ログインできません", email: "Member@example.com", name: "会員" }, link);
    expect(r).toMatchObject({ verified: false, send: true, kind: "verify", to: "member@example.com", mail_from: "Shop <shop@example.com>", notify: null });
    expect(await row(r.id)).toMatchObject({ status: "waiting_shop", origin: "form", customer_id: null, email_verified_at: null });
    expect((await hooks()).filter((h) => h.payload.inquiry_id === r.id)).toHaveLength(0);
    // 確認画面（使わない）
    expect(await asService(async (c) => (await c.query("select inquiry_peek($1, $2) as r", [f.shopId, link])).rows[0].r)).toEqual({ number: r.number });
    expect(await asService(async (c) => (await c.query("select inquiry_peek($1, $2) as r", [f.shopId, hash("nope")])).rows[0].r)).toBeNull();
    // 開く
    const opened = await get({ link_hash: link });
    expect(opened!.notify).toEqual({ send: true, to: "shop@example.com" });
    expect(opened!.inquiry).toMatchObject({ number: r.number, verified: true, messages: [{ author: "customer", body: "ログインできません" }] });
    expect(JSON.stringify(opened)).not.toContain("member@example.com");
    expect(await row(r.id)).toMatchObject({ customer_id: memberId });
    const h = (await hooks()).filter((x) => x.payload.inquiry_id === r.id);
    expect(h).toEqual([{ event: "inquiry.created", payload: expect.objectContaining({ number: r.number, customer_id: memberId, category: "account" }) }]);
    expect(JSON.stringify(h)).not.toContain("@");
    // 2 回目は確認済みなので何もしない
    expect((await get({ link_hash: link }))!.notify).toBeNull();
    expect(await mails(r.id)).toEqual(["verify", "shop"]);
    // 他のショップのリンクとしては使えない
    expect(await asService(async (c) => (await c.query("select inquiry_get($1, $2::jsonb) as r", [other.shopId, JSON.stringify({ link_hash: link })])).rows[0].r)).toBeNull();
  });

  it("ゲストの注文番号: 番号とアドレスが合えば注文に結ぶ。合わなければ申告された番号として残す", async () => {
    const ok = await create({ basis: "form", category: "order", body: "届きません", email: "guest@example.com", order_number: "1001" });
    expect(await row(ok.id)).toMatchObject({ order_id: guestOrder, claimed_order_number: null });
    const ng = await create({ basis: "form", category: "order", body: "届きません", email: "someone@example.com", order_number: "1001" });
    expect(await row(ng.id)).toMatchObject({ order_id: null, claimed_order_number: 1001 });
    // 注文を確かめる（要約だけ。住所・アドレスは返さない）
    const check = (n: number, email: string) => asService(async (c) => (await c.query<{ r: J | null }>("select inquiry_order_check($1, $2, $3, $4, $5) as r", [f.shopId, n, email, hash("ip-check"), hash(email)])).rows[0]!.r);
    expect(await check(1001, "Guest@example.com")).toMatchObject({ number: 1001, total_jpy: 3000, status: "paid" });
    expect(JSON.stringify(await check(1001, "guest@example.com"))).not.toContain("guest@example.com");
    expect(await check(1001, "wrong@example.com")).toBeNull();
  });

  it("会員・注文から・購入完了の画面から: 確認メールなしで確認済み。注文時のアドレスに返す。会員は自分の注文だけ結べる", async () => {
    const epoch = (await getPool().query<{ e: number }>("select session_epoch as e from customers where id = $1", [memberId])).rows[0]!.e;
    const m = await create({ basis: "member", category: "order", body: "会員です", customer_id: memberId, epoch, order_number: 1002 });
    expect(m).toMatchObject({ verified: true, kind: "created", to: "member@example.com", notify: { send: true } });
    expect(await row(m.id)).toMatchObject({ origin: "member", customer_id: memberId, order_id: memberOrder });
    const notMine = await create({ basis: "member", category: "order", body: "他人の注文", customer_id: memberId, epoch, order_number: 1001 });
    expect(await row(notMine.id)).toMatchObject({ order_id: null, claimed_order_number: 1001 });
    expect(await expectDbError(() => create({ basis: "member", category: "other", body: "x", customer_id: memberId, epoch: epoch + 1 }))).toMatch(/invalid_member/);

    const o = await create({ basis: "order", category: "order", body: "注文から", order_id: guestOrder });
    expect(o).toMatchObject({ verified: true, to: "guest@example.com" });
    expect(await row(o.id)).toMatchObject({ origin: "order", order_id: guestOrder });
    expect(await expectDbError(() => create({ basis: "order", category: "order", body: "x", order_id: guestOrder }, undefined, null, other.shopId))).toMatch(/inquiries_disabled/);

    const res = (await getPool().query<{ id: string }>("insert into reservations (shop_id, items, expires_at, quote_id) values ($1, '[]'::jsonb, now() + interval '10 minutes', 'quote-123') returning id", [f.shopId])).rows[0]!.id;
    expect(await expectDbError(() => create({ basis: "checkout", category: "order", body: "完了画面", quote_id: "quote-123" }))).toMatch(/order_not_found/);
    await getPool().query("update orders set reservation_id = $2 where id = $1", [guestOrder, res]);
    const ck = await create({ basis: "checkout", category: "order", body: "完了画面", quote_id: "quote-123" });
    expect(await row(ck.id)).toMatchObject({ origin: "checkout", order_id: guestOrder, contact_email: "guest@example.com" });
    const ref = await asService(async (c) => (await c.query("select inquiry_order_ref($1, $2::jsonb) as r", [f.shopId, JSON.stringify({ quote_id: "quote-123" })])).rows[0].r);
    expect(ref).toMatchObject({ number: 1001, order_id: guestOrder });

    // 会員の一覧（確認済みだけ）と、会員のアクセス（番号）で開く
    const list = await asService(async (c) => (await c.query("select inquiry_member_list($1, $2, $3) as r", [f.shopId, memberId, epoch])).rows[0].r as J[]);
    expect(list.map((x) => x.number)).toContain(m.number);
    expect((await get({ customer_id: memberId, epoch, number: m.number }))!.inquiry).toMatchObject({ number: m.number, order: { number: 1002 } });
    expect(await get({ customer_id: memberId, epoch, number: o.number })).toBeNull();
  });

  it("やり取り: お客様が書くと運営者の返事待ち、運営者が返すとお客様の返事待ちで新しいリンク。完了したチケットにはお客様は書けない", async () => {
    const link = hash("thread-link");
    const r = await create({ basis: "form", category: "product", body: "サイズは？", email: "thread@example.com" }, link);
    // 未確認のままでは書けない（リンクで開いて確認してから）
    expect(await expectDbError(() => asService((c) => c.query("select inquiry_customer_reply($1, $2::jsonb, 'x', null)", [f.shopId, JSON.stringify({ link_hash: link })])))).toMatch(/inquiry_not_found/);
    await get({ link_hash: link });
    const replyLink = hash("reply-link");
    const sent = await asUser(support, async (c) => (await c.query<{ r: J }>("select inquiry_reply($1, 'M です', $2) as r", [r.id, replyLink])).rows[0]!.r);
    expect(sent).toMatchObject({ number: r.number, send: true, to: "thread@example.com" });
    expect(await row(r.id)).toMatchObject({ status: "waiting_customer" });
    expect((await getPool().query("select author_user from inquiry_messages where inquiry_id = $1 and author = 'shop'", [r.id])).rows).toEqual([{ author_user: support }]);
    expect(await expectDbError(() => asUser(catalogOnly, (c) => c.query("select inquiry_reply($1, 'x', $2)", [r.id, hash("z")])))).toMatch(/inquiry_not_found/);

    const back = await asService(async (c) => (await c.query<{ r: J }>("select inquiry_customer_reply($1, $2::jsonb, 'ありがとう', $3) as r", [f.shopId, JSON.stringify({ link_hash: replyLink }), hash("ip-1")])).rows[0]!.r);
    expect(back).toMatchObject({ number: r.number, notify: { send: true, to: "shop@example.com" } });
    expect(await row(r.id)).toMatchObject({ status: "waiting_shop" });
    const view = (await get({ link_hash: link }))!.inquiry as { messages: { author: string }[] };
    expect(view.messages.map((x) => x.author)).toEqual(["customer", "shop", "customer"]);

    await asUser(support, (c) => c.query("select inquiry_set_status($1, 'closed')", [r.id]));
    expect(await row(r.id)).toMatchObject({ status: "closed" });
    expect(await expectDbError(() => asService((c) => c.query("select inquiry_customer_reply($1, $2::jsonb, 'まだ', null)", [f.shopId, JSON.stringify({ link_hash: link })])))).toMatch(/inquiry_closed/);
    const updates = (await hooks()).filter((h) => h.payload.inquiry_id === r.id).map((h) => [h.event, h.payload.status]);
    expect(updates).toEqual([["inquiry.created", "waiting_shop"], ["inquiry.updated", "waiting_customer"], ["inquiry.updated", "waiting_shop"], ["inquiry.updated", "closed"]]);
  });

  it("リンクの送り直し: 受付番号とアドレスが合えば新しいリンク。合わなくても応答の形は同じ。同じ宛先への確認のメールは 1 時間 5 通まで", async () => {
    const r = await create({ basis: "form", category: "other", body: "a", email: "resend@example.com" });
    const resend = (n: number, email: string, link: string) =>
      asService(async (c) => (await c.query<{ r: J }>("select inquiry_resend_link($1, $2, $3, $4, $5, $6) as r", [f.shopId, n, email, link, hash(`ip-${Math.random()}`), hash(email)])).rows[0]!.r);
    expect(await resend(r.number as number, "Resend@example.com", hash("r1"))).toMatchObject({ send: true, to: "resend@example.com" });
    expect(await resend(r.number as number, "wrong@example.com", hash("r2"))).toEqual({ send: false, mail_from: "Shop <shop@example.com>", to: null, number: null });
    for (let i = 0; i < 3; i++) await resend(r.number as number, "resend@example.com", hash(`r-more-${i}`));
    // verify 1 + link 4 = 5 通で打ち止め
    expect(await resend(r.number as number, "resend@example.com", hash("r-over"))).toMatchObject({ send: false });
    expect(await mails(r.id)).toEqual(["verify", "link", "link", "link", "link"]);
  });

  it("回数の制限: 同じ IP から 1 時間 10 件、同じアドレスの開いているチケットは 5 件まで。注文を確かめるのは同じ IP から 1 時間 20 回", async () => {
    const ip = hash("ip-flood");
    for (let i = 0; i < 10; i++) await create({ basis: "form", category: "other", body: `${i}`, email: `flood${i}@example.com` }, undefined, ip);
    expect(await expectDbError(() => create({ basis: "form", category: "other", body: "x", email: "flood-x@example.com" }, undefined, ip))).toMatch(/too_many_requests/);
    for (let i = 0; i < 5; i++) await create({ basis: "form", category: "other", body: `${i}`, email: "same@example.com" }, undefined, hash(`ip-same-${i}`));
    expect(await expectDbError(() => create({ basis: "form", category: "other", body: "x", email: "same@example.com" }, undefined, hash("ip-same-x")))).toMatch(/too_many_requests/);
    const ipc = hash("ip-check-flood");
    for (let i = 0; i < 20; i++) await asService((c) => c.query("select inquiry_order_check($1, 9999, 'x@example.com', $2, null)", [f.shopId, ipc]));
    expect(await expectDbError(() => asService((c) => c.query("select inquiry_order_check($1, 9999, 'x@example.com', $2, null)", [f.shopId, ipc])))).toMatch(/too_many_requests/);
    expect(await expectDbError(() => create({ basis: "form", category: "bogus", body: "x", email: "a@example.com" }))).toMatch(/invalid_category/);
    expect(await expectDbError(() => create({ basis: "form", category: "other", body: "  ", email: "a@example.com" }))).toMatch(/invalid_body/);
    expect(await expectDbError(() => create({ basis: "form", category: "other", body: "x", email: "not-an-email" }))).toMatch(/invalid_email/);
  });

  it("個人情報: 顧客の削除の依頼で連絡先と本文を消す。完了から日数が経ったもの・未確認のまま 30 日のものは Cron が消す。メールはプランの 1 日の数に入る", async () => {
    const r = await create({ basis: "form", category: "other", body: "消してください", email: "erase@example.com" });
    await asUser(f.ownerId, (c) => c.query("select mask_customer($1, 'Erase@example.com')", [f.shopId]));
    expect(await row(r.id)).toMatchObject({ contact_email: null, contact_name: "[masked]", status: "closed" });
    expect((await getPool().query("select body from inquiry_messages where inquiry_id = $1", [r.id])).rows).toEqual([{ body: "[masked]" }]);

    const old = await create({ basis: "form", category: "other", body: "古い", email: "old@example.com" });
    await getPool().query("update inquiries set email_verified_at = now(), status = 'closed', closed_at = now() - interval '400 days' where id = $1", [old.id]);
    const spam = await create({ basis: "form", category: "other", body: "未確認", email: "spam@example.com" });
    await getPool().query("update inquiries set created_at = now() - interval '31 days' where id = $1", [spam.id]);
    const n = await asService(async (c) => (await c.query<{ n: number }>("select mask_inquiries(365) as n")).rows[0]!.n);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(await row(old.id)).toMatchObject({ contact_email: null });
    expect(await row(spam.id)).toBeUndefined();
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select mask_inquiries(1)")))).toMatch(/permission denied/);

    const before = Number((await getPool().query<{ n: string }>("select banto_plan_mail_count() as n")).rows[0]!.n);
    await create({ basis: "form", category: "other", body: "数える", email: "count@example.com" });
    expect(Number((await getPool().query<{ n: string }>("select banto_plan_mail_count() as n")).rows[0]!.n)).toBe(before + 1);
    // 削除（support の項目）
    await asUser(support, (c) => c.query("select inquiry_delete($1)", [r.id]));
    expect(await row(r.id)).toBeUndefined();
  });
});
