import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

type Item = { id: string; title: string; read: boolean };
type List = { items: Item[]; unread: number };

/**
 * 0155_mod_member_news: 会員へのお知らせと既読。見えるのは本人あてと、全員向けで会員の条件に合うもの（期間の中だけ）。
 * 書くのは管理画面（項目 marketing・全員向けだけ）と AI 用 API（member_news:write・連携ごとに分かれる）。読むのは本人（service_role）
 */
describe.skipIf(!dbAvailable)("会員へのお知らせ（0155）", () => {
  let f: Fixture;
  let other: Fixture;
  let cid: string;
  let cid2: string;
  let sid: string;
  let sid2: string;
  let gold: string;
  let marketer: string;
  let ordersOnly: string;
  let ep: string;
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const svc = <T>(sql: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(sql, args)).rows[0]!.r);
  const list = (c = cid, s = sid) => svc<List | null>("select member_news_list($1, $2, 0, $3) as r", [f.shopId, c, s]);
  const read = (ids: string[] | null, c = cid, s = sid) => svc<number | null>("select member_news_read($1, $2, 0, $3, $4) as r", [f.shopId, c, s, ids]);
  const save = (uid: string, id: string | null, v: Record<string, unknown>, shopId = f.shopId) =>
    asUser(uid, async (c) => (await c.query<{ r: string }>("select member_news_save($1, $2, $3::jsonb) as r", [shopId, id, JSON.stringify(v)])).rows[0]!.r);
  const member = async (email: string, perms: string[]) => {
    const uid = await createAuthUser(email);
    const org = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    await getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", [org, uid]);
    await getPool().query("insert into org_member_shops (org_id, user_id, shop_id, perms) values ($1, $2, $3, $4)", [org, uid, f.shopId, perms]);
    return uid;
  };
  async function issue(scopes: string[], endpoint: string | null = null) {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    await asUser(f.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes, endpoint_id) values ($1, $2, 't', $3, $4, $5, $6)", [f.shopId, f.ownerId, sha(raw), raw.slice(0, 12), scopes, endpoint]));
    return sha(raw);
  }
  const api = <T = unknown>(fn: string, args: unknown[]) => svc<T>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "mn-owner@example.com", slug: "mn-shop", publish: true });
    other = await createShopFixture({ email: "mn-other@example.com", slug: "mn-other", publish: true });
    const pool = getPool();
    await pool.query(`update shops set settings = settings || '{"members_enabled": true, "modules": {"member_news": true, "audiences": true}, "customer_fields": [{"key": "rank", "label": "rank", "type": "text"}]}' where id = $1`, [f.shopId]);
    cid = (await pool.query<{ id: string }>(`insert into customers (shop_id, email, attributes) values ($1, 'mn1@example.com', '{"rank": "gold"}') returning id`, [f.shopId])).rows[0]!.id;
    cid2 = (await pool.query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'mn2@example.com') returning id", [f.shopId])).rows[0]!.id;
    sid = await svc<string>("select member_session_start($1, $2, 0, 'web', 'x', 3600) as r", [f.shopId, cid]);
    sid2 = await svc<string>("select member_session_start($1, $2, 0, 'web', 'x', 3600) as r", [f.shopId, cid2]);
    gold = (await pool.query<{ id: string }>(`insert into audiences (shop_id, name, condition) values ($1, 'gold', '{"attr": "rank", "in": ["gold"]}') returning id`, [f.shopId])).rows[0]!.id;
    marketer = await member("mn-mkt@example.com", ["marketing"]);
    ordersOnly = await member("mn-orders@example.com", ["orders"]);
    ep = (await pool.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'MA', 'https://ma.example.com/hook', '{}') returning id", [f.shopId])).rows[0]!.id;
  });
  afterAll(closePool);

  it("見える範囲: 本人あて・全員向け（会員の条件に合うもの）・期間の中。新しい順と未読の数。生きていないセッションは null", async () => {
    await save(marketer, null, { title: "全員へ", starts_at: "2026-01-01T00:00:00Z" });
    await save(f.ownerId, null, { title: "ゴールドの方へ", audience_id: gold, starts_at: "2026-01-02T00:00:00Z" });
    await save(f.ownerId, null, { title: "予約", starts_at: "2099-01-01T00:00:00Z" });
    await save(f.ownerId, null, { title: "終わった", starts_at: "2020-01-01T00:00:00Z", ends_at: "2020-01-02T00:00:00Z" });
    await getPool().query("insert into member_news (shop_id, customer_id, title, starts_at) values ($1, $2, '1 人あて', '2026-01-03T00:00:00Z')", [f.shopId, cid2]);
    expect(await list()).toMatchObject({ unread: 2, items: [{ title: "ゴールドの方へ", read: false }, { title: "全員へ", read: false }] });
    expect((await list(cid2, sid2))!.items.map((x) => x.title)).toEqual(["1 人あて", "全員へ"]);
    expect(await list(cid, sid2)).toBeNull();
  });

  it("既読: 選んだもの・見えるものすべて。ほかの人あて・期間の外は既読にならない", async () => {
    const items = (await list())!.items;
    expect(await read([items[1]!.id])).toBe(1);
    expect((await list())!.unread).toBe(1);
    const theirs = (await list(cid2, sid2))!.items.find((x) => x.title === "1 人あて")!.id;
    expect(await read([theirs])).toBe(0);
    expect(await read(null)).toBe(1);
    expect(await read(null)).toBe(0);
    expect((await list())!.unread).toBe(0);
    expect((await list(cid2, sid2))!.unread).toBe(2);
  });

  it("管理画面の保存: 項目 marketing。形の確かめ（見出し・リンク・日時・知らない鍵・1 人あて・よその条件）", async () => {
    expect(await expectDbError(() => save(ordersOnly, null, { title: "x" }))).toMatch(/marketing_required/);
    expect(await expectDbError(() => save(f.ownerId, null, { title: "x" }, other.shopId))).toMatch(/marketing_required/);
    expect(await expectDbError(() => save(f.ownerId, null, { title: "  " }))).toMatch(/invalid_member_news:title/);
    expect(await expectDbError(() => save(f.ownerId, null, { title: "x", url: "javascript:alert(1)" }))).toMatch(/invalid_member_news:url/);
    expect(await expectDbError(() => save(f.ownerId, null, { title: "x", url: "//evil.example" }))).toMatch(/invalid_member_news:url/);
    expect(await expectDbError(() => save(f.ownerId, null, { title: "x", url: "http://example.com" }))).toMatch(/invalid_member_news:url/);
    expect(await expectDbError(() => save(f.ownerId, null, { title: "x", starts_at: "2026-01-02T00:00:00Z", ends_at: "2026-01-01T00:00:00Z" }))).toMatch(/invalid_member_news:date/);
    expect(await expectDbError(() => save(f.ownerId, null, { title: "x", starts_at: "きのう" }))).toMatch(/invalid_member_news:date/);
    expect(await expectDbError(() => save(f.ownerId, null, { title: "x", html: "<b>" }))).toMatch(/invalid_member_news:unknown_field:html/);
    expect(await expectDbError(() => save(f.ownerId, null, { title: "x", customer_id: cid }))).toMatch(/unknown_field:customer_id/);
    const otherAud = (await getPool().query<{ id: string }>(`insert into audiences (shop_id, name, condition) values ($1, 'x', '{"member": true}') returning id`, [other.shopId])).rows[0]!.id;
    expect(await expectDbError(() => save(f.ownerId, null, { title: "x", audience_id: otherAud }))).toMatch(/invalid_member_news:audience/);
    const id = await save(f.ownerId, null, { title: "直す前", url: "/products/tee", body: "a\r\nb" });
    await save(f.ownerId, id, { title: "直した", url: "https://example.com/x" });
    expect((await getPool().query("select title, url, body from member_news where id = $1", [id])).rows[0]).toEqual({ title: "直した", url: "https://example.com/x", body: "" });
    // 1 人あて・プラグインのものは管理画面では直せない（消すのはできる）
    const theirs = (await getPool().query<{ id: string }>("select id from member_news where customer_id = $1", [cid2])).rows[0]!.id;
    expect(await expectDbError(() => save(f.ownerId, theirs, { title: "x" }))).toMatch(/not_found/);
    expect(await asUser(marketer, async (c) => (await c.query<{ r: boolean }>("select member_news_delete($1, $2) as r", [f.shopId, theirs])).rows[0]!.r)).toBe(true);
  });

  it("読み書きの権限: marketing の人だけ読める。anon と別の項目の人は読めない。直接は書けない", async () => {
    expect((await asUser(marketer, (c) => c.query("select 1 from member_news where shop_id = $1", [f.shopId]))).rowCount).toBeGreaterThan(0);
    expect((await asUser(ordersOnly, (c) => c.query("select 1 from member_news where shop_id = $1", [f.shopId]))).rowCount).toBe(0);
    expect(await expectDbError(() => asAnon((c) => c.query("select 1 from member_news")))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("insert into member_news (shop_id, title) values ($1, 'x')", [f.shopId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("insert into member_news_reads (shop_id, customer_id, news_id) select shop_id, $2, id from member_news where shop_id = $1 limit 1", [f.shopId, cid])))).toMatch(/permission denied/);
    // 本人の読み取りは service_role だけ（運営者の JWT からは呼べない）
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select member_news_list($1, $2, 0, $3)", [f.shopId, cid, sid])))).toMatch(/permission denied|service_role only/);
  });

  it("AI 用 API: 1 人あて・全員向けを置く。連携ごとに分かれる。モジュールが OFF・スコープ違いは断る。1 人 200 件を超えたら古いものから消える", async () => {
    const plugin = await issue(["member_news:write"], ep);
    const op = await issue(["member_news:write"]);
    const made = await api<{ id: string; customer_id: string }>("api_member_news_create", [plugin, JSON.stringify({ customer_id: cid, title: "お取り置きが届きました", url: "/account" })]);
    expect(made.customer_id).toBe(cid);
    expect((await getPool().query("select endpoint_id from member_news where id = $1", [made.id])).rows[0]).toEqual({ endpoint_id: ep });
    // 運営者のトークン（連携に結ばない）が見るのは連携に結ばないもの（管理画面で書いたものを含む）だけ
    expect((await api<{ items: { id: string }[] }>("api_member_news_list", [op, null])).items.map((x) => x.id)).not.toContain(made.id);
    expect((await api<{ items: { id: string }[] }>("api_member_news_list", [plugin, null])).items.map((x) => x.id)).toEqual([made.id]);
    expect(await expectDbError(() => api("api_member_news_delete", [op, made.id]))).toMatch(/not_found/);
    expect(await expectDbError(() => api("api_member_news_create", [plugin, JSON.stringify({ customer_id: cid, title: "x", audience_id: gold })]))).toMatch(/invalid_member_news:audience/);
    expect(await expectDbError(() => api("api_member_news_create", [plugin, JSON.stringify({ customer_id: "nobody", title: "x" })]))).toMatch(/invalid_member_news:customer/);
    const otherCustomer = (await getPool().query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'x@example.com') returning id", [other.shopId])).rows[0]!.id;
    expect(await expectDbError(() => api("api_member_news_create", [plugin, JSON.stringify({ customer_id: otherCustomer, title: "x" })]))).toMatch(/invalid_member_news:customer/);
    const dialogsOnly = await issue(["dialogs:write"]);
    expect(await expectDbError(() => api("api_member_news_create", [dialogsOnly, JSON.stringify({ title: "x" })]))).toBeTruthy();
    for (let i = 0; i < 201; i++) await api("api_member_news_create", [plugin, JSON.stringify({ customer_id: cid2, title: `n${i}`, starts_at: new Date(Date.UTC(2025, 0, 1) + i * 60000).toISOString() })]);
    const titles = (await getPool().query<{ title: string }>("select title from member_news where customer_id = $1 order by starts_at", [cid2])).rows.map((r) => r.title);
    expect(titles).toHaveLength(200);
    expect(titles[0]).toBe("n1");
    expect(await api<{ deleted: boolean }>("api_member_news_delete", [plugin, made.id])).toEqual({ deleted: true });
    // 連携を外すと、その連携が置いたお知らせも消える
    await getPool().query("delete from hook_endpoints where id = $1", [ep]);
    expect((await getPool().query("select 1 from member_news where customer_id = $1", [cid2])).rowCount).toBe(0);
    await getPool().query(`update shops set settings = jsonb_set(settings, '{modules,member_news}', 'false') where id = $1`, [f.shopId]);
    expect(await expectDbError(() => api("api_member_news_list", [op, null]))).toMatch(/module_disabled/);
  });

  it("会員の条件: 使っている条件は消せない。表示用の条件・よそのショップの条件・モジュールが OFF なら付けられない", async () => {
    const id = await save(f.ownerId, null, { title: "ゴールド限定", audience_id: gold });
    expect(await expectDbError(() => getPool().query("delete from audiences where id = $1", [gold]))).toMatch(/foreign key|violates/);
    await getPool().query("delete from member_news where id = $1", [id]);
    const display = (await getPool().query<{ id: string }>(`insert into audiences (shop_id, name, condition) values ($1, 'url', '{"param": "utm_source", "in": ["x"]}') returning id`, [f.shopId])).rows[0]?.id;
    if (display) expect(await expectDbError(() => save(f.ownerId, null, { title: "x", audience_id: display }))).toMatch(/invalid_member_news:audience/);
    await getPool().query(`update shops set settings = jsonb_set(settings, '{modules,audiences}', 'false') where id = $1`, [f.shopId]);
    expect(await expectDbError(() => save(f.ownerId, null, { title: "x", audience_id: gold }))).toMatch(/module_disabled:audiences/);
    await getPool().query(`update shops set settings = jsonb_set(settings, '{modules,audiences}', 'true') where id = $1`, [f.shopId]);
  });

  it("リンク: \\ と制御文字を含むパスは断る", async () => {
    expect(await expectDbError(() => save(f.ownerId, null, { title: "x", url: "/\\evil.example/" }))).toMatch(/invalid_member_news:url/);
    expect(await expectDbError(() => save(f.ownerId, null, { title: "x", url: "/a\tb" }))).toMatch(/invalid_member_news:url/);
  });

  it("1 人あての上限は書き手ごと・置いた順。開始日の古い行を足しても消えず、ほかの書き手の行は消さない", async () => {
    const ep2 = (await getPool().query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'B', 'https://b.example.com/hook', '{}') returning id", [f.shopId])).rows[0]!.id;
    await getPool().query(`update shops set settings = jsonb_set(settings, '{modules,member_news}', 'true') where id = $1`, [f.shopId]);
    const a = await issue(["member_news:write"], ep2);
    const op = await issue(["member_news:write"]);
    const opRow = await api<{ id: string }>("api_member_news_create", [op, JSON.stringify({ customer_id: cid2, title: "運営者から" })]);
    for (let i = 0; i < 200; i++) await api("api_member_news_create", [a, JSON.stringify({ customer_id: cid2, title: `a${i}`, starts_at: "2099-01-01T00:00:00Z" })]);
    const old = await api<{ id: string }>("api_member_news_create", [a, JSON.stringify({ customer_id: cid2, title: "古い開始日", starts_at: "2000-01-01T00:00:00Z" })]);
    const rows = (await getPool().query<{ id: string; title: string }>("select id, title from member_news where customer_id = $1", [cid2])).rows;
    expect(rows.some((r) => r.id === old.id)).toBe(true);
    expect(rows.some((r) => r.id === opRow.id)).toBe(true);
    expect(rows.some((r) => r.title === "a0")).toBe(false);
    expect(rows.filter((r) => r.title !== "運営者から")).toHaveLength(200);
  });

  it("運営者が読めるのは、全員向けは marketing、1 人あてと既読は customers", async () => {
    const custOnly = await member("mn-cust@example.com", ["customers"]);
    const perMember = async (uid: string) => (await asUser(uid, (c) => c.query("select 1 from member_news where shop_id = $1 and customer_id is not null", [f.shopId]))).rowCount;
    expect(await perMember(marketer)).toBe(0);
    expect(await perMember(custOnly)).toBeGreaterThan(0);
    expect((await asUser(custOnly, (c) => c.query("select 1 from member_news where shop_id = $1 and customer_id is null", [f.shopId]))).rowCount).toBe(0);
  });

  it("全員向けは 100 件まで。会員を消すと本人あてと既読も消える", async () => {
    await getPool().query("delete from member_news where shop_id = $1", [f.shopId]);
    await getPool().query("insert into member_news (shop_id, title) select $1, 'n' || g from generate_series(1, 100) g", [f.shopId]);
    expect(await expectDbError(() => save(f.ownerId, null, { title: "101" }))).toMatch(/member_news_full/);
    await getPool().query("delete from member_news where shop_id = $1", [f.shopId]);
    const n = (await getPool().query<{ id: string }>("insert into member_news (shop_id, customer_id, title) values ($1, $2, 'x') returning id", [f.shopId, cid])).rows[0]!.id;
    await getPool().query("insert into member_news_reads (shop_id, customer_id, news_id) values ($1, $2, $3)", [f.shopId, cid, n]);
    await getPool().query("delete from customers where id = $1", [cid]);
    expect((await getPool().query("select 1 from member_news where id = $1", [n])).rowCount).toBe(0);
    expect((await getPool().query("select 1 from member_news_reads where news_id = $1", [n])).rowCount).toBe(0);
  });
});
