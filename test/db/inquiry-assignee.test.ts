import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/**
 * 0068_mod_inquiries_assignee: お問い合わせの担当者。担当者にできるのは support の項目を持つ人だけ。
 * 割り当てたら本人に知らせる（自分で自分なら知らせない）。未割り当てに運営者が最初に返事をしたらその人が担当。AI 用トークンからも読む・変える
 */
describe.skipIf(!dbAvailable)("お問い合わせの担当者（0068）", () => {
  let f: Fixture;
  let other: Fixture;
  let orgId: string;
  let support: string;
  let support2: string;
  let catalogOnly: string;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "as-owner@example.com", slug: "as-shop", publish: true });
    other = await createShopFixture({ email: "as-other@example.com", slug: "as-other", publish: true });
    const pool = getPool();
    await pool.query("update shops set settings = settings || '{\"modules\":{\"inquiries\":true}}'::jsonb where id = $1", [f.shopId]);
    await pool.query("insert into hook_endpoints (shop_id, name, url, events, settings) values ($1, 'mail', 'https://banto.invalid/plugins/email_resend', '{}', '{\"from\": \"Shop <shop@example.com>\"}')", [f.shopId]);
    await pool.query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'x', 'https://example.com/h', '{inquiry.updated}')", [f.shopId]);
    orgId = (await pool.query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    support = await createAuthUser("as-support@example.com");
    support2 = await createAuthUser("as-support2@example.com");
    catalogOnly = await createAuthUser("as-catalog@example.com");
    for (const [uid, email, perms] of [[support, "as-support@example.com", ["support"]], [support2, "as-support2@example.com", ["support"]], [catalogOnly, "as-catalog@example.com", ["catalog"]]] as const) {
      await asUser(f.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, email, JSON.stringify([{ shop_id: f.shopId, perms }]), hash(`t-${email}`)]));
      await withRole("authenticated", { sub: uid, email }, (c) => c.query("select org_invitation_accept($1)", [hash(`t-${email}`)]));
    }
  });
  afterAll(closePool);

  const create = async () => {
    const r = await asService(async (c) => (await c.query<{ r: J }>("select inquiry_create($1, $2::jsonb, $3, $4) as r", [f.shopId, JSON.stringify({ basis: "form", category: "other", body: "質問です", email: "q@example.com" }), hash(`l-${Math.random()}`), null])).rows[0]!.r);
    return r as { id: string; number: number };
  };
  const assignee = async (id: string) => (await getPool().query<{ assignee_id: string | null }>("select assignee_id from inquiries where id = $1", [id])).rows[0]!.assignee_id;
  const assign = (uid: string, id: string, to: string | null) => asUser(uid, async (c) => (await c.query<{ r: J }>("select inquiry_assign($1, $2) as r", [id, to])).rows[0]!.r);
  const mails = async (id: string) => (await getPool().query<{ kind: string }>("select kind from inquiry_mails where inquiry_id = $1 and kind = 'assign'", [id])).rows.length;

  it("担当者にできるのは support の項目を持つ人（owner / admin を含む）。support の無い人は一覧にも割り当てにも出ない", async () => {
    const list = (await asUser(support, async (c) => (await c.query<{ r: { user_id: string; email: string }[] }>("select inquiry_assignees($1) as r", [f.shopId])).rows[0]!.r)).map((x) => x.email);
    expect(list).toEqual(["as-owner@example.com", "as-support2@example.com", "as-support@example.com"].sort());
    expect(await expectDbError(() => asUser(catalogOnly, (c) => c.query("select inquiry_assignees($1)", [f.shopId])))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => asAnon((c) => c.query("select inquiry_assignees($1)", [f.shopId])))).toMatch(/permission denied/);
    const r = await create();
    expect(await expectDbError(() => assign(support, r.id, catalogOnly))).toMatch(/invalid_assignee/);
    expect(await expectDbError(() => assign(support, r.id, other.ownerId))).toMatch(/invalid_assignee/);
    expect(await expectDbError(() => assign(catalogOnly, r.id, support))).toMatch(/inquiry_not_found/);
    // 表は直接書けない
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update inquiries set assignee_id = $2 where id = $1", [r.id, support])))).toMatch(/permission denied/);
  });

  it("割り当てたら本人に知らせる（自分で自分なら知らせない）。同じ人なら何もしない。外せる。hooks は change = assignee だけ", async () => {
    const r = await create();
    let res = await assign(f.ownerId, r.id, support);
    expect(res).toMatchObject({ number: r.number, send: true, to: "as-support@example.com", mail_from: "Shop <shop@example.com>" });
    expect(await assignee(r.id)).toBe(support);
    expect(await assign(f.ownerId, r.id, support)).toMatchObject({ send: false });
    res = await assign(support2, r.id, support2);
    expect(res).toMatchObject({ send: false, to: null });
    expect(await assignee(r.id)).toBe(support2);
    expect(await mails(r.id)).toBe(1);
    await assign(support2, r.id, null);
    expect(await assignee(r.id)).toBeNull();
    const hooks = (await getPool().query<{ payload: J }>("select payload from hook_deliveries where shop_id = $1 and payload->>'change' = 'assignee' and payload->>'inquiry_id' = $2", [f.shopId, r.id])).rows;
    expect(hooks).toHaveLength(3);
    expect(JSON.stringify(hooks)).not.toContain(support);
    expect(JSON.stringify(hooks)).not.toContain("@example.com");
  });

  it("未割り当てのチケットに最初に返事をした運営者が担当になる。すでに担当がいれば変えない", async () => {
    const r = await create();
    await asUser(support, (c) => c.query("select inquiry_reply($1, '確認します', $2)", [r.id, hash(`rl-${Math.random()}`)]));
    expect(await assignee(r.id)).toBe(support);
    await asUser(support2, (c) => c.query("select inquiry_reply($1, '追って', $2)", [r.id, hash(`rl-${Math.random()}`)]));
    expect(await assignee(r.id)).toBe(support);
    expect(await mails(r.id)).toBe(0);
    expect(await asUser(support, async (c) => (await c.query<{ r: J }>("select inquiry_admin_get($1) as r", [r.id])).rows[0]!.r)).toMatchObject({ assignee_id: support });
  });

  it("AI 用トークン: 担当者の一覧・割り当て（inquiries:write）・一覧の絞り込み。AI の割り当ては必ず知らせる", async () => {
    const raw = `banto_${Math.random().toString(36).slice(2)}`;
    const tok = hash(raw);
    await asUser(f.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [f.shopId, f.ownerId, tok, raw.slice(0, 12), ["inquiries:read", "inquiries:write"]]));
    const readRaw = `banto_${Math.random().toString(36).slice(2)}`;
    await asUser(f.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [f.shopId, f.ownerId, hash(readRaw), readRaw.slice(0, 12), ["inquiries:read"]]));
    const api = <T>(fn: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
    await getPool().query("update inquiries set assignee_id = null where shop_id = $1", [f.shopId]);
    const r = await create();
    expect((await api<{ email: string }[]>("api_inquiry_assignees", [hash(readRaw)])).map((x) => x.email)).toContain("as-support@example.com");
    const out = await api<{ inquiry: J; mail: J }>("api_inquiry_assign", [tok, r.number, support]);
    expect(out.inquiry).toMatchObject({ number: r.number, assignee: { user_id: support, email: "as-support@example.com" } });
    expect(out.mail).toMatchObject({ send: true, to: "as-support@example.com" });
    expect(await expectDbError(() => api("api_inquiry_assign", [hash(readRaw), r.number, support]))).toMatch(/unauthorized/);
    expect(await expectDbError(() => api("api_inquiry_assign", [tok, r.number, catalogOnly]))).toMatch(/invalid_assignee/);
    const mine = await api<{ items: J[]; total: number }>("api_inquiries_list", [tok, null, 50, 0, support]);
    expect(mine.items.map((i) => i["number"])).toEqual([r.number]);
    const none = await api<{ items: J[]; total: number }>("api_inquiries_list", [tok, null, 50, 0, "none"]);
    expect(none.items.map((i) => i["number"])).not.toContain(r.number);
    expect(none.total).toBeGreaterThan(0);
    expect(await expectDbError(() => api("api_inquiries_list", [tok, null, 50, 0, "x"]))).toMatch(/invalid_assignee/);
  });
});
