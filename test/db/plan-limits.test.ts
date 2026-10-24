import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0052_plan_limits: プランの上限。
 * - site_settings の plan_limits は service_role と JWT の無い直接の SQL だけが書ける（組織の owner / admin は forbidden）。値は検査する
 * - 判定は文単位の AFTER INSERT トリガー（shops / products / customers / org_members）。上限が無ければ数えない。超えれば文ごと巻き戻る
 * - banto_plan_usage() で上限と使用量（組織の owner / admin と service_role）
 */
describe.skipIf(!dbAvailable)("プランの上限（0052_plan_limits）", () => {
  let a: Fixture;
  const setLimits = (v: unknown) => getPool().query("select site_settings_set('plan_limits', $1::jsonb)", [JSON.stringify(v)]);
  const count = async (table: string) => Number((await getPool().query<{ n: string }>(`select count(*)::text as n from ${table}`)).rows[0]!.n);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "pl-a@example.com", slug: "pl-a", publish: true, stock: 5 });
    await getPool().query(`update shops set settings = settings || '{"members_enabled": true}'::jsonb where id = $1`, [a.shopId]);
  });
  afterAll(closePool);

  it("書けるのは service_role と直接の SQL だけ。組織の owner は forbidden、anon は呼べない。値は検査する", async () => {
    await setLimits({ shops: 2, products: 3 }); // 直接の SQL（JWT なし）
    expect((await asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select site_settings_set('plan_limits', '{\"shops\": 2, \"products\": 3, \"members\": 2}'::jsonb) as r")).rows[0]!.r))["plan_limits"]).toEqual({ shops: 2, products: 3, members: 2 });
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select site_settings_set('plan_limits', '{}'::jsonb)")))).toMatch(/forbidden/);
    expect(await expectDbError(() => asAnon((c) => c.query("select site_settings_set('plan_limits', '{}'::jsonb)")))).toMatch(/permission denied/);
    // workers_plan は今までどおり組織の owner が書ける
    await asUser(a.ownerId, (c) => c.query("select site_settings_set('workers_plan', '\"paid\"'::jsonb)"));
    for (const bad of [{ orders: 1 }, { shops: 0 }, { shops: -1 }, { shops: 1.5 }, { shops: "3" }, { shops: 1000001 }, [1], "x"]) {
      expect(await expectDbError(() => setLimits(bad)), JSON.stringify(bad)).toMatch(/invalid_value/);
    }
    await setLimits({});
    const settings = (await getPool().query<{ settings: Record<string, unknown> }>("select settings from banto_site_settings")).rows[0]!.settings;
    expect(settings).toMatchObject({ workers_plan: "paid", plan_limits: {} });
  });

  it("上限が無ければ何も止めない。上限があれば超えた文だけ巻き戻る（ショップ・商品）", async () => {
    await asUser(a.ownerId, (c) => c.query("insert into shops (owner_id, slug, name) values ($1, 'pl-a2', 'A2')", [a.ownerId]));
    expect(await count("shops")).toBe(2);
    await setLimits({ shops: 2, products: 3 });
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("insert into shops (owner_id, slug, name) values ($1, 'pl-a3', 'A3')", [a.ownerId])))).toMatch(/plan_limit_exceeded:shops:2/);
    expect(await count("shops")).toBe(2);
    // 商品: 既に 1 つ。2 つ足して 3 = 上限ちょうどは通る、次の 1 つで止まる。複数行の insert は文ごと巻き戻る
    await asUser(a.ownerId, (c) => c.query("insert into products (shop_id, slug, name) values ($1, 'p2', 'P2'), ($1, 'p3', 'P3')", [a.shopId]));
    expect(await count("products")).toBe(3);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("insert into products (shop_id, slug, name) values ($1, 'p4', 'P4')", [a.shopId])))).toMatch(/plan_limit_exceeded:products:3/);
    await getPool().query("delete from products where slug = 'p3'");
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("insert into products (shop_id, slug, name) values ($1, 'p4', 'P4'), ($1, 'p5', 'P5')", [a.shopId])))).toMatch(/plan_limit_exceeded:products:3/);
    expect(await count("products")).toBe(2);
    // 上限を外せばまた入る
    await setLimits({});
    await asUser(a.ownerId, (c) => c.query("insert into products (shop_id, slug, name) values ($1, 'p4', 'P4'), ($1, 'p5', 'P5')", [a.shopId]));
    expect(await count("products")).toBe(4);
  });

  it("会員（customers）: 初回ログインの作成・API の作成・取り込みも同じ一本道で止まる", async () => {
    await setLimits({ customers: 1 });
    await asService((c) => c.query("insert into customers (shop_id, email) values ($1, 'm1@example.com')", [a.shopId]));
    expect(await expectDbError(() => asService((c) => c.query("insert into customers (shop_id, email) values ($1, 'm2@example.com')", [a.shopId])))).toMatch(/plan_limit_exceeded:customers:1/);
    // 取り込み（import_members）は 1 文で複数行 → 超えれば全部入らない
    expect(await expectDbError(() => asService((c) => c.query("select import_members($1, $2::jsonb)", [a.shopId, JSON.stringify([{ email: "m3@example.com" }, { email: "m4@example.com" }])])))).toMatch(/plan_limit_exceeded:customers:1/);
    expect(await count("customers")).toBe(1);
    await setLimits({});
  });

  it("組織のメンバー: 上限に達していれば招待の受け入れ（org_members への insert）が止まる。最初の運営者は通る", async () => {
    const orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [a.shopId])).rows[0]!.org_id;
    await setLimits({ members: 1 });
    const staff = await createAuthUser("pl-staff@example.com");
    expect(await expectDbError(() => getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", [orgId, staff]))).toMatch(/plan_limit_exceeded:members:1/);
    await setLimits({ members: 3 });
    await getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", [orgId, staff]);
    // 新しい運営者（別の組織）も members に数える
    const b = await createShopFixture({ email: "pl-b@example.com", slug: "pl-b" });
    expect(await count("org_members")).toBe(3);
    const c3 = await createAuthUser("pl-c@example.com");
    expect(await expectDbError(() => getPool().query("insert into owners (id) values ($1)", [c3]))).toMatch(/plan_limit_exceeded:members:3/);
    expect(b.ownerId).toBeTruthy();
    await setLimits({});
  });

  it("banto_plan_usage: 上限と使用量。組織の owner / admin と service_role だけ", async () => {
    await setLimits({ shops: 10, products: 100 });
    const usage = await asUser(a.ownerId, async (c) => (await c.query<{ r: { limits: Record<string, number>; usage: Record<string, number> } }>("select banto_plan_usage() as r")).rows[0]!.r);
    expect(usage.limits).toEqual({ shops: 10, products: 100 });
    expect(usage.usage).toMatchObject({ shops: await count("shops"), products: await count("products"), customers: await count("customers"), members: await count("org_members") }); // mail_per_day は 0053 のテストで
    expect(await asService(async (c) => (await c.query<{ r: { limits: Record<string, number> } }>("select banto_plan_usage() as r")).rows[0]!.r.limits)).toEqual({ shops: 10, products: 100 });
    const member = await createAuthUser("pl-member@example.com");
    const orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [a.shopId])).rows[0]!.org_id;
    await getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", [orgId, member]);
    expect(await expectDbError(() => asUser(member, (c) => c.query("select banto_plan_usage()")))).toMatch(/forbidden/);
    expect(await expectDbError(() => asAnon((c) => c.query("select banto_plan_usage()")))).toMatch(/permission denied/);
  });
});
