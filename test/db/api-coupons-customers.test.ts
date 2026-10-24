import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * 0036_api_coupons_customers: AI 用トークンでのクーポンと会員の操作。
 * 「できる」ことに加えて、他のショップ・スコープ不足・項目を外された発行者・メールアドレスの変更・個人情報の列を確かめる。
 */
describe.skipIf(!dbAvailable)("クーポンと会員の API（0036_api_coupons_customers）", () => {
  let a: Fixture;
  let b: Fixture;
  let orgId: string;
  let marketer: string; // marketing と integrations だけ
  let full: string;
  let readOnly: string;
  let bToken: string;
  let memberId: string;
  let bMemberId: string;
  let categoryId: string;

  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);

  function issue(uid: string, shopId: string, scopes: string[]) {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    const hash = sha(raw);
    return asUser(uid, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [shopId, uid, hash, raw.slice(0, 12), scopes])).then(() => hash);
  }
  const setPerms = (uid: string, perms: string[]) =>
    asUser(a.ownerId, (c) => c.query("select org_member_set($1, $2, 'member', $3::jsonb)", [orgId, uid, JSON.stringify([{ shop_id: a.shopId, perms }])]));

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "cc-a@example.com", slug: "cc-a", publish: true, stock: 5 });
    b = await createShopFixture({ email: "cc-b@example.com", slug: "cc-b", publish: true, stock: 5 });
    for (const s of [a, b]) await getPool().query(`update shops set settings = settings || '{"modules":{"coupons":true},"members_enabled":true}'::jsonb where id = $1`, [s.shopId]);
    orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [a.shopId])).rows[0]!.org_id;
    marketer = await createAuthUser("cc-marketer@example.com");
    const token = "inv-cc-marketer";
    await asUser(a.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, "cc-marketer@example.com", JSON.stringify([{ shop_id: a.shopId, perms: ["integrations", "marketing"] }]), sha(token)]));
    await withRole("authenticated", { sub: marketer, email: "cc-marketer@example.com" }, (c) => c.query("select org_invitation_accept($1)", [sha(token)]));
    full = await issue(a.ownerId, a.shopId, ["coupons:read", "coupons:write", "customers:read", "customers:write", "orders:read"]);
    readOnly = await issue(a.ownerId, a.shopId, ["coupons:read", "customers:read"]);
    bToken = await issue(b.ownerId, b.shopId, ["coupons:read", "coupons:write", "customers:read", "customers:write"]);
    memberId = (await getPool().query<{ id: string }>("insert into customers (shop_id, email, name, password_hash) values ($1, 'Member@Example.com', '会員', '$2a$10$hash') returning id", [a.shopId])).rows[0]!.id;
    bMemberId = (await getPool().query<{ id: string }>("insert into customers (shop_id, email, name) values ($1, 'other@example.com', '他店') returning id", [b.shopId])).rows[0]!.id;
    categoryId = (await getPool().query<{ id: string }>("insert into categories (shop_id, slug, name) values ($1, 'tops', 'トップス') returning id", [a.shopId])).rows[0]!.id;
  });
  afterAll(closePool);

  describe("トークンとスコープ", () => {
    it("新しいスコープは発行者の項目まで（marketing だけのスタッフは customers:* を付けられない）", async () => {
      expect(await expectDbError(() => issue(marketer, a.shopId, ["customers:read"]))).toMatch(/scope_not_permitted/);
      const h = await issue(marketer, a.shopId, ["coupons:read", "coupons:write"]);
      const r = await rpc<{ total: number }>("api_coupons_list", [h, null, null, 50, 0]);
      expect(r.total).toBe(0);
      // 項目を外すと、そのスコープだけ効かなくなる
      await setPerms(marketer, ["integrations"]);
      expect(await expectDbError(() => rpc("api_coupons_list", [h, null, null, 50, 0]))).toMatch(/unauthorized/);
      await setPerms(marketer, ["integrations", "marketing"]);
    });

    it("読み取りのトークンでは書けない。語彙に無いスコープは付けられない", async () => {
      expect(await expectDbError(() => rpc("api_coupon_create", [readOnly, { name: "x", kind: "fixed", value: 100 }]))).toMatch(/unauthorized/);
      expect(await expectDbError(() => rpc("api_customer_create", [readOnly, { email: "x@example.com" }]))).toMatch(/unauthorized/);
      expect(await expectDbError(() => issue(a.ownerId, a.shopId, ["customers:admin"]))).toMatch(/api_tokens_scopes_valid/);
    });

    it("クーポンのモジュールが OFF のショップでは module_disabled", async () => {
      await getPool().query(`update shops set settings = settings || '{"modules":{"coupons":false}}'::jsonb where id = $1`, [a.shopId]);
      expect(await expectDbError(() => rpc("api_coupons_list", [full, null, null, 50, 0]))).toMatch(/module_disabled/);
      await getPool().query(`update shops set settings = settings || '{"modules":{"coupons":true}}'::jsonb where id = $1`, [a.shopId]);
    });

    it("api_* は service_role 以外から呼べない", async () => {
      for (const role of ["anon", "authenticated"] as const) {
        const msg = await expectDbError(() => withRole(role, role === "anon" ? {} : { sub: a.ownerId }, (c) => c.query("select api_customers_list($1)", [full])));
        expect(msg).toMatch(/permission denied/);
      }
    });
  });

  describe("クーポン", () => {
    let couponId: string;

    it("作成: コードは大文字に、条件はこのショップの商品・カテゴリーだけ", async () => {
      const r = await rpc<Record<string, unknown>>("api_coupon_create", [
        full,
        { name: "春の 10%", code: "spring-10", kind: "percent", value: 10, usage_limit: 3, per_customer_limit: 1, conditions: { product_ids: [a.productId], category_ids: [categoryId], min_subtotal_jpy: 3000, exclude_sale: false } },
      ]);
      couponId = r["id"] as string;
      expect(r["code"]).toBe("SPRING-10");
      expect(r["conditions"]).toEqual({ product_ids: [a.productId], category_ids: [categoryId], min_subtotal_jpy: 3000 });
      expect(r["usage"]).toEqual({ used: 0, held: 0 });
      const slots = await getPool().query<{ n: number }>("select count(*)::int as n from coupon_slots where campaign_id = $1", [couponId]);
      expect(slots.rows[0]!.n).toBe(3);
      // 他のショップの商品は条件に入れられない
      expect(await expectDbError(() => rpc("api_coupon_create", [full, { name: "x", kind: "fixed", value: 100, conditions: { product_ids: [b.productId] } }]))).toMatch(/invalid_conditions_unknown_products/);
      // 知らない鍵・範囲外・型の違い
      expect(await expectDbError(() => rpc("api_coupon_create", [full, { name: "x", kind: "fixed", value: 100, shop_id: b.shopId }]))).toMatch(/invalid_field/);
      expect(await expectDbError(() => rpc("api_coupon_create", [full, { name: "x", kind: "percent", value: 150 }]))).toMatch(/invalid_value/);
      expect(await expectDbError(() => rpc("api_coupon_create", [full, { name: "x", kind: "fixed", value: "100" }]))).toMatch(/invalid_value/);
      expect(await expectDbError(() => rpc("api_coupon_create", [full, { name: "x", kind: "fixed", value: 100, conditions: { run: "sql" } }]))).toMatch(/invalid_conditions_unknown_key/);
      expect(await expectDbError(() => rpc("api_coupon_create", [full, { name: "x", kind: "fixed", value: 100, starts_at: "2026-12-01T00:00:00Z", ends_at: "2026-11-01T00:00:00Z" }]))).toMatch(/invalid_ends_at/);
      // 同じコード
      expect(await expectDbError(() => rpc("api_coupon_create", [full, { name: "dup", code: "SPRING-10", kind: "fixed", value: 100 }]))).toMatch(/duplicate key/);
    });

    it("一覧・取得: id かコードで。他のショップのクーポンは見えない", async () => {
      const list = await rpc<{ total: number; items: { id: string }[] }>("api_coupons_list", [readOnly, "spring", null, 50, 0]);
      expect(list.items.map((x) => x.id)).toEqual([couponId]);
      // _ や % は文字として扱う（全件に当たらない）
      expect((await rpc<{ total: number }>("api_coupons_list", [readOnly, "_", null, 50, 0])).total).toBe(0);
      expect((await rpc<{ id: string }>("api_coupon_get", [readOnly, null, "spring-10"])).id).toBe(couponId);
      expect(await expectDbError(() => rpc("api_coupon_get", [bToken, couponId, null]))).toMatch(/not_found/);
      expect(await expectDbError(() => rpc("api_coupon_update", [bToken, couponId, { active: false }]))).toMatch(/not_found/);
      expect(await expectDbError(() => rpc("api_coupon_delete", [bToken, couponId]))).toMatch(/not_found/);
    });

    it("更新: 渡した鍵だけ変わる。free_shipping の値は 0", async () => {
      const r = await rpc<Record<string, unknown>>("api_coupon_update", [full, couponId, { active: false, ends_at: "2027-01-01T00:00:00Z" }]);
      expect(r["active"]).toBe(false);
      expect(r["value"]).toBe(10);
      expect(r["code"]).toBe("SPRING-10");
      const s = await rpc<Record<string, unknown>>("api_coupon_update", [full, couponId, { kind: "free_shipping" }]);
      expect(s["value"]).toBe(0);
      await rpc("api_coupon_update", [full, couponId, { kind: "percent", value: 10, active: true }]);
    });

    it("発行: 会員 ID ごとと使い捨てコード。他のショップの会員・持っている人には発行しない。取り消し", async () => {
      const r = await rpc<{ issued: number; skipped: number; grants: { id: string; code: string; customer_id: string | null }[] }>("api_coupon_grants_issue", [full, couponId, [memberId, bMemberId], 2]);
      expect(r.issued).toBe(3);
      expect(r.skipped).toBe(1);
      expect(r.grants.filter((g) => g.customer_id === memberId)).toHaveLength(1);
      const again = await rpc<{ issued: number; skipped: number }>("api_coupon_grants_issue", [full, couponId, [memberId], 0]);
      expect(again).toMatchObject({ issued: 0, skipped: 1 });
      expect(await expectDbError(() => rpc("api_coupon_grants_issue", [full, couponId, [], 501]))).toMatch(/invalid_count/);
      const list = await rpc<{ total: number }>("api_coupon_grants_list", [readOnly, couponId, "available", 50, 0]);
      expect(list.total).toBe(3);
      const anon = r.grants.find((g) => g.customer_id === null)!;
      expect(await expectDbError(() => rpc("api_coupon_grant_revoke", [bToken, anon.id]))).toMatch(/not_found/);
      expect(await rpc("api_coupon_grant_revoke", [full, anon.id])).toEqual({ id: anon.id, status: "revoked" });
      expect(await rpc("api_coupon_grant_revoke", [full, anon.id])).toEqual({ id: anon.id, status: "revoked" });
    });

    it("削除: 使われたクーポンは消せない（止めるのは active = false）。使われていなければ消せる", async () => {
      const res = await getPool().query<{ id: string }>("insert into reservations (shop_id, items, expires_at) values ($1, '[]'::jsonb, now() + interval '10 minutes') returning id", [a.shopId]);
      await getPool().query("insert into coupon_redemptions (shop_id, campaign_id, reservation_id, subject, status) values ($1, $2, $3, $4, 'used')", [a.shopId, couponId, res.rows[0]!.id, `c:${memberId.replace(/-/g, "")}`]);
      expect(await expectDbError(() => rpc("api_coupon_delete", [full, couponId]))).toMatch(/coupon_in_use/);
      const fresh = await rpc<{ id: string }>("api_coupon_create", [full, { name: "消す", kind: "fixed", value: 100 }]);
      expect(await rpc("api_coupon_delete", [full, fresh.id])).toEqual({ deleted: true, id: fresh.id });
    });
  });

  describe("会員", () => {
    it("一覧・取得: パスワードのハッシュ・世代は返さない。他のショップの会員は見えない", async () => {
      const list = await rpc<{ total: number; items: Record<string, unknown>[] }>("api_customers_list", [readOnly, null, "member@example.com", 50, 0]);
      expect(list.total).toBe(1);
      const m = list.items[0]!;
      expect(Object.keys(m).sort()).toEqual(["attributes", "created_at", "default_address", "email", "external_ref", "id", "last_login_at", "marketing_consent", "marketing_consent_at", "marketing_consent_source", "name", "orders", "updated_at"]);
      expect(JSON.stringify(list)).not.toMatch(/\$2a\$|password|session_epoch/);
      expect((await rpc<{ total: number }>("api_customers_list", [readOnly, "_", null, 50, 0])).total).toBe(0);
      expect(await expectDbError(() => rpc("api_customer_get", [bToken, memberId]))).toMatch(/not_found/);
      // orders:read があるトークンにだけ最近の注文を付ける
      expect(await rpc<Record<string, unknown>>("api_customer_get", [full, memberId])).toHaveProperty("recent_orders");
      expect(await rpc<Record<string, unknown>>("api_customer_get", [readOnly, memberId])).not.toHaveProperty("recent_orders");
    });

    it("作成: メールアドレスは小文字に。同じアドレスは email_taken。住所は決まった鍵だけ", async () => {
      const c = await rpc<Record<string, unknown>>("api_customer_create", [full, { email: " New@Example.com ", name: "新規", default_address: { postal_code: "100-0001", state: "東京都", city: "千代田区", line1: "1-1" } }]);
      expect(c["email"]).toBe("new@example.com");
      expect(await expectDbError(() => rpc("api_customer_create", [full, { email: "new@example.com" }]))).toMatch(/email_taken/);
      expect(await expectDbError(() => rpc("api_customer_create", [full, { email: "not-an-email" }]))).toMatch(/invalid_email/);
      expect(await expectDbError(() => rpc("api_customer_create", [full, { email: "x@example.com", password_hash: "$2a$" }]))).toMatch(/invalid_field/);
      expect(await expectDbError(() => rpc("api_customer_create", [full, { email: "x@example.com", default_address: { script: "x" } }]))).toMatch(/invalid_default_address/);
      // 他のショップには同じアドレスで作れる（会員はショップごと）
      expect((await rpc<Record<string, unknown>>("api_customer_create", [bToken, { email: "new@example.com" }]))["email"]).toBe("new@example.com");
    });

    it("更新: 氏名と住所だけ。メールアドレスは変えられない", async () => {
      const r = await rpc<Record<string, unknown>>("api_customer_update", [full, memberId, { name: "会員 太郎", default_address: null }]);
      expect(r["name"]).toBe("会員 太郎");
      expect(r["email"]).toBe("Member@Example.com");
      expect(await expectDbError(() => rpc("api_customer_update", [full, memberId, { email: "attacker@example.com" }]))).toMatch(/email_change_not_allowed/);
      expect(await expectDbError(() => rpc("api_customer_update", [bToken, memberId, { name: "x" }]))).toMatch(/not_found/);
      const epoch = await getPool().query<{ email: string; session_epoch: number }>("select email, session_epoch from customers where id = $1", [memberId]);
      expect(epoch.rows[0]!.email).toBe("Member@Example.com");
    });

    it("削除（退会）: 他のショップの会員は消せない。注文は残る", async () => {
      const o = await getPool().query<{ id: string }>("insert into orders (shop_id, total_jpy, number, customer_id) values ($1, 1000, 1001, $2) returning id", [a.shopId, memberId]);
      expect(await expectDbError(() => rpc("api_customer_delete", [bToken, memberId]))).toMatch(/not_found/);
      expect(await rpc("api_customer_delete", [full, memberId])).toEqual({ deleted: true, id: memberId });
      expect(await expectDbError(() => rpc("api_customer_delete", [full, memberId]))).toMatch(/not_found/);
      const still = await getPool().query("select 1 from orders where id = $1", [o.rows[0]!.id]);
      expect(still.rowCount).toBe(1);
    });
  });
});
