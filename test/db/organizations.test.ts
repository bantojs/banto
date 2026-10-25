import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

describe.skipIf(!dbAvailable)("組織・メンバー・権限の項目（0024_organizations）", () => {
  let f: Fixture;
  let other: Fixture;
  let orgId: string;
  let staff: string;
  let admin: string;
  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "org-owner@example.com", slug: "org-shop", publish: true, stock: 5 });
    other = await createShopFixture({ email: "other-owner@example.com", slug: "org-other", publish: true });
    orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    staff = await createAuthUser("staff@example.com");
    admin = await createAuthUser("admin@example.com");
  });
  afterAll(closePool);

  const accept = (uid: string, email: string, token: string) =>
    withRole("authenticated", { sub: uid, email }, async (c) => (await c.query<{ r: string }>("select org_invitation_accept($1) as r", [hash(token)])).rows[0]!.r);

  it("owner ができると組織ができ、ショップに組織が入る。組織は自分のものだけ見える", async () => {
    expect(orgId).toBeTruthy();
    const role = (await getPool().query("select role from org_members where org_id = $1 and user_id = $2", [orgId, f.ownerId])).rows[0];
    expect(role).toEqual({ role: "owner" });
    expect((await asUser(f.ownerId, (c) => c.query("select id from organizations"))).rows).toEqual([{ id: orgId }]);
    expect((await asUser(other.ownerId, (c) => c.query("select id from organizations where id = $1", [orgId]))).rows).toHaveLength(0);
    const shops = await asUser(f.ownerId, async (c) => (await c.query<{ r: { id: string }[] }>("select banto_my_shops() as r")).rows[0]!.r);
    expect(shops.map((s) => s.id)).toEqual([f.shopId]);
  });

  it("招待: owner / admin が招待し、本人（同じメールアドレス）だけが受け入れられる。7 日・1 回限り", async () => {
    await asUser(f.ownerId, (c) => c.query("select org_invite($1, 'Staff@Example.com', 'member', $2::jsonb, $3)", [orgId, JSON.stringify([{ shop_id: f.shopId, perms: ["catalog", "bogus"] }, { shop_id: other.shopId, perms: ["orders"] }]), hash("t-staff")]));
    // 他人は招待できない・読めない
    expect(await expectDbError(() => asUser(other.ownerId, (c) => c.query("select org_invite($1, 'x@example.com', 'member', '[]', $2)", [orgId, hash("t-x")])))).toMatch(/org_not_found/);
    expect((await asUser(other.ownerId, (c) => c.query("select id from org_invitations"))).rows).toHaveLength(0);
    const peek = await asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select org_invitation_peek($1) as r", [hash("t-staff")])).rows[0]!.r);
    expect(peek).toMatchObject({ email: "staff@example.com", role: "member", valid: true, user_exists: true });
    expect(await expectDbError(() => accept(admin, "admin@example.com", "t-staff"))).toMatch(/invitation_email_mismatch/);
    expect(await accept(staff, "staff@example.com", "t-staff")).toBe(orgId);
    expect(await expectDbError(() => accept(staff, "staff@example.com", "t-staff"))).toMatch(/invitation_invalid/);
    // 他の組織のショップ・決まっていない項目は入らない
    const shops = (await getPool().query("select shop_id, perms from org_member_shops where user_id = $1", [staff])).rows;
    expect(shops).toEqual([{ shop_id: f.shopId, perms: ["catalog"] }]);
  });

  it("member: 割り当てた項目のテーブルだけ読み書きできる（catalog は商品、orders は無し）。関数も項目で確かめる", async () => {
    await getPool().query("insert into orders (shop_id, total_jpy, customer_email, number) values ($1, 1000, 'buyer@example.com', 7001)", [f.shopId]);
    const view = await asUser(staff, async (c) => (await c.query<{ r: { role: string; perms: string[] } }>("select banto_admin_shop($1) as r", [f.shopId])).rows[0]!.r);
    expect(view).toMatchObject({ role: "member", perms: ["catalog"] });
    expect(await asUser(staff, async (c) => (await c.query("select banto_admin_shop($1) as r", [other.shopId])).rows[0].r)).toBeNull();
    // 商品は読み書きできる・在庫は set_stock で入れられる
    await asUser(staff, (c) => c.query("update products set name = 'スタッフが直した' where id = $1", [f.productId]));
    expect((await asUser(staff, (c) => c.query("select set_stock($1, 9) as n", [f.skuId]))).rows[0].n).toBe(9);
    // 注文・会員・ショップの設定・トークンは見えない / 変えられない
    expect((await asUser(staff, (c) => c.query("select id from orders where shop_id = $1", [f.shopId]))).rows).toHaveLength(0);
    expect((await asUser(staff, (c) => c.query("update shops set name = 'x' where id = $1 returning id", [f.shopId]))).rows).toHaveLength(0);
    expect(await expectDbError(() => asUser(staff, (c) => c.query("select mask_customer($1, 'buyer@example.com')", [f.shopId])))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => asUser(staff, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 'x', $3, 'bnt_x', '{products:read}')", [f.shopId, staff, hash("tok")])))).toMatch(/row-level security|scope_not_permitted/);
    // ショップは作れない・消せない
    expect(await expectDbError(() => asUser(staff, (c) => c.query("insert into shops (slug, name) values ('staff-shop', 'S')")))).toMatch(/row-level security|org_required/);
    // 項目を足すと次のリクエストから効く
    await asUser(f.ownerId, (c) => c.query("select org_member_set($1, $2, 'member', $3::jsonb)", [orgId, staff, JSON.stringify([{ shop_id: f.shopId, perms: ["catalog", "orders", "settings"] }])]));
    expect((await asUser(staff, (c) => c.query("select id from orders where shop_id = $1", [f.shopId]))).rows).toHaveLength(1);
    expect((await asUser(staff, (c) => c.query("update shops set name = 'Shop org-shop' where id = $1 returning id", [f.shopId]))).rows).toHaveLength(1);
    // settings だけでは入金先（Stripe の接続先）を変えられない
    expect(await expectDbError(() => asUser(staff, (c) => c.query("update shops set stripe_account_id = 'acct_evil' where id = $1", [f.shopId])))).toMatch(/integrations_required/);
  });

  it("役割の規則: admin は owner を作れない・最後の owner は外せない。外したら見えなくなる", async () => {
    await asUser(f.ownerId, (c) => c.query("select org_invite($1, 'admin@example.com', 'admin', '[]', $2)", [orgId, hash("t-admin")]));
    await accept(admin, "admin@example.com", "t-admin");
    // admin は全ショップの全権（注文も見える）
    expect((await asUser(admin, (c) => c.query("select id from orders where shop_id = $1", [f.shopId]))).rows).toHaveLength(1);
    expect(await expectDbError(() => asUser(admin, (c) => c.query("select org_member_set($1, $2, 'owner', '[]')", [orgId, staff])))).toMatch(/owner_only/);
    expect(await expectDbError(() => asUser(admin, (c) => c.query("select org_member_remove($1, $2)", [orgId, f.ownerId])))).toMatch(/owner_only/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select org_member_set($1, $2, 'admin', '[]')", [orgId, f.ownerId])))).toMatch(/last_owner/);
    const list = await asUser(admin, async (c) => (await c.query<{ r: { email: string; role: string }[] }>("select org_members_list($1) as r", [orgId])).rows[0]!.r);
    expect(list.map((m) => [m.email, m.role])).toEqual([["org-owner@example.com", "owner"], ["staff@example.com", "member"], ["admin@example.com", "admin"]]);
    expect(await expectDbError(() => asUser(staff, (c) => c.query("select org_members_list($1)", [orgId])))).toMatch(/org_not_found/);
    // admin が作ったショップは同じ組織に入る
    const created = (await asUser(admin, (c) => c.query<{ org_id: string; owner_id: string | null }>("insert into shops (slug, name) values ('admin-shop', 'A') returning org_id, owner_id"))).rows[0]!;
    expect(created).toEqual({ org_id: orgId, owner_id: null });
    await asUser(admin, (c) => c.query("select org_member_remove($1, $2)", [orgId, staff]));
    expect((await asUser(staff, (c) => c.query("select id from products where shop_id = $1 and published = false", [f.shopId]))).rows).toHaveLength(0);
    expect(await asUser(staff, async (c) => (await c.query("select banto_admin_shop($1) as r", [f.shopId])).rows[0].r)).toBeNull();
    // 組織は変えられない
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update shops set org_id = (select org_id from shops where id = $2) where id = $1", [f.shopId, other.shopId])))).toMatch(/org_immutable|row-level security/);
    // 購入者（anon）は組織を何も読めない
    expect((await asAnon((c) => c.query("select id from organizations"))).rows).toHaveLength(0);
    expect(await expectDbError(() => asAnon((c) => c.query("select org_invitation_accept('x')")))).toMatch(/permission denied/);
  });
});
