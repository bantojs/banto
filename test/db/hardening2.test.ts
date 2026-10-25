import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * 0055_security_hardening_2: 2026-10-25 の監査（権限の項目の追従漏れ）。
 * 「できる」と「できない」の両方を、攻撃側の役割（項目の少ないスタッフ・降格された初代 owner・anon）から確かめる。
 */
describe.skipIf(!dbAvailable)("セキュリティの締め直し 2（0055_security_hardening_2）", () => {
  let f: Fixture;
  let other: Fixture;
  let orgId: string;
  let staff: string; // integrations + orders + customers（後で customers を外す）
  let clerk: string; // settings だけ
  let picker: string; // catalog だけ
  let packer: string; // orders だけ
  let admin: string; // 組織の admin
  let orderId: string;

  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);

  async function invite(uid: string, email: string, role: "member" | "admin", perms: string[]) {
    const token = `inv-${email}`;
    await asUser(f.ownerId, (c) => c.query("select org_invite($1, $2, $3, $4::jsonb, $5)", [orgId, email, role, JSON.stringify(role === "member" ? [{ shop_id: f.shopId, perms }] : []), sha(token)]));
    await withRole("authenticated", { sub: uid, email }, (c) => c.query("select org_invitation_accept($1)", [sha(token)]));
  }
  const setPerms = (uid: string, perms: string[]) =>
    asUser(f.ownerId, (c) => c.query("select org_member_set($1, $2, 'member', $3::jsonb)", [orgId, uid, JSON.stringify([{ shop_id: f.shopId, perms }])]));
  function issue(uid: string, scopes: string[]) {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    const hash = sha(raw);
    return asUser(uid, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [f.shopId, uid, hash, raw.slice(0, 12), scopes])).then(() => hash);
  }

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "h2-owner@example.com", slug: "h2-shop", publish: true, stock: 5 });
    other = await createShopFixture({ email: "h2-other@example.com", slug: "h2-other", publish: true, stock: 5 });
    orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    await getPool().query(
      `update shops set settings = '{"notice":"hi","product_fields":[{"key":"material","label":"素材","type":"text"},{"key":"cost","label":"原価","type":"number","public":false}],
        "headless":{"return_origins":["https://wp.example"],"relay_ips":["203.0.113.9"]},"oauth":{"google":{"client_id":"gid"}}}'::jsonb where id = $1`,
      [f.shopId],
    );
    await getPool().query("update products set attributes = '{\"material\":\"綿\",\"cost\":300}'::jsonb where id = $1", [f.productId]);
    orderId = (await getPool().query<{ id: string }>("insert into orders (shop_id, total_jpy, customer_email, customer_name, number, status, shipping_address) values ($1, 1000, 'buyer@example.com', '買主', 1001, 'paid', '{\"state\":\"東京都\"}') returning id", [f.shopId])).rows[0]!.id;
    staff = await createAuthUser("h2-staff@example.com");
    clerk = await createAuthUser("h2-clerk@example.com");
    picker = await createAuthUser("h2-picker@example.com");
    packer = await createAuthUser("h2-packer@example.com");
    admin = await createAuthUser("h2-admin@example.com");
    await invite(staff, "h2-staff@example.com", "member", ["integrations", "orders", "customers"]);
    await invite(clerk, "h2-clerk@example.com", "member", ["settings"]);
    await invite(picker, "h2-picker@example.com", "member", ["catalog"]);
    await invite(packer, "h2-packer@example.com", "member", ["orders"]);
    await invite(admin, "h2-admin@example.com", "admin", []);
  });
  afterAll(closePool);

  describe("AI 用トークン: 使うたびに発行者の項目を確かめる（orders:pii を含む）", () => {
    it("customers の項目を外すと、orders:pii のトークンでも個人情報が返らなくなる", async () => {
      const h = await issue(staff, ["orders:read", "orders:pii"]);
      let list = await rpc<{ pii: boolean; items: { customer?: Record<string, unknown> }[] }>("api_orders_list", [h]);
      expect(list.pii).toBe(true);
      expect(list.items[0]!.customer).toBeTruthy();
      await setPerms(staff, ["integrations", "orders"]);
      list = await rpc<{ pii: boolean; items: { customer?: Record<string, unknown> }[] }>("api_orders_list", [h]);
      expect(list.pii).toBe(false);
      expect(list.items[0]!.customer).toMatchObject({ masked: true });
      expect(list.items[0]!.customer!["email"]).toBeUndefined();
      const one = await rpc<{ customer?: Record<string, unknown> }>("api_order_get", [h, orderId]);
      expect(one.customer).toMatchObject({ masked: true });
      expect(one.customer!["email"]).toBeUndefined();
      // 氏名・メールでの検索も効かない
      expect((await rpc<{ total: number }>("api_orders_list", [h, null, null, null, 50, 0, "buyer"])).total).toBe(0);
      await setPerms(staff, ["integrations", "orders", "customers"]);
      expect((await rpc<{ pii: boolean }>("api_orders_list", [h])).pii).toBe(true);
    });
  });

  describe("AI 用トークンの失効・帰属", () => {
    it("組織の owner / admin はスタッフのトークンを失効できる。失効は監査ログに残る", async () => {
      const h = await issue(staff, ["shop:read"]);
      expect(await rpc("api_has_scope", [h, "shop:read"])).toBe(true);
      const n = await asUser(admin, async (c) => (await c.query("update api_tokens set revoked_at = now() where token_hash = $1", [h])).rowCount);
      expect(n).toBe(1);
      expect(await rpc("api_has_scope", [h, "shop:read"])).toBe(false);
      const audit = await getPool().query("select actor_kind, actor_id from audit_log where action = 'api_token.revoked' order by created_at desc limit 1");
      expect(audit.rows[0]).toMatchObject({ actor_kind: "user", actor_id: admin });
      const h2 = await issue(staff, ["shop:read"]);
      expect(await asUser(f.ownerId, async (c) => (await c.query("update api_tokens set revoked_at = now() where token_hash = $1", [h2])).rowCount)).toBe(1);
    });

    it("本人でも失効の取り消し・期限の延長・スコープや帰属の変更・削除はできない", async () => {
      const h = await issue(staff, ["shop:read"]);
      await asUser(staff, (c) => c.query("update api_tokens set revoked_at = now() where token_hash = $1", [h]));
      await asUser(staff, (c) => c.query("update api_tokens set revoked_at = null where token_hash = $1", [h]));
      expect((await getPool().query("select revoked_at from api_tokens where token_hash = $1", [h])).rows[0]!.revoked_at).not.toBeNull();
      expect(await rpc("api_has_scope", [h, "shop:read"])).toBe(false);
      const live = await issue(staff, ["shop:read"]);
      expect(await expectDbError(() => asUser(staff, (c) => c.query("update api_tokens set expires_at = now() + interval '10 years' where token_hash = $1", [live])))).toMatch(/token_immutable/);
      expect(await expectDbError(() => asUser(staff, (c) => c.query("update api_tokens set owner_id = $2 where token_hash = $1", [live, f.ownerId])))).toMatch(/token_immutable/);
      expect(await expectDbError(() => asUser(staff, (c) => c.query("update api_tokens set scopes = '{shop:read,products:read}' where token_hash = $1", [live])))).toMatch(/token_immutable/);
      expect(await expectDbError(() => asUser(staff, (c) => c.query("delete from api_tokens where token_hash = $1", [live])))).toMatch(/permission denied/);
      // 名前は変えられる
      expect(await asUser(staff, async (c) => (await c.query("update api_tokens set name = 'renamed' where token_hash = $1", [live])).rowCount)).toBe(1);
      // 他人は発行できない（自分の名義だけ）
      expect(await expectDbError(() => asUser(staff, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, 'x', '{shop:read}')", [f.shopId, f.ownerId, sha("forged")])))).toMatch(/row-level security/);
    });
  });

  describe("organizations.require_mfa は org_set_require_mfa だけ", () => {
    it("admin も owner も直接 UPDATE できない。name は変えられる", async () => {
      expect(await expectDbError(() => asUser(admin, (c) => c.query("update organizations set require_mfa = true where id = $1", [orgId])))).toMatch(/permission denied/);
      expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update organizations set require_mfa = true where id = $1", [orgId])))).toMatch(/permission denied/);
      expect(await asUser(admin, async (c) => (await c.query("update organizations set name = 'renamed' where id = $1", [orgId])).rowCount)).toBe(1);
      expect((await getPool().query("select require_mfa from organizations where id = $1", [orgId])).rows[0]!.require_mfa).toBe(false);
    });
  });

  describe("非公開の独自項目は anon に見せない", () => {
    it("anon は products.attributes を読めない。公開の列は読める", async () => {
      expect(await expectDbError(() => asAnon((c) => c.query("select attributes from products where id = $1", [f.productId])))).toMatch(/permission denied/);
      expect(await expectDbError(() => asAnon((c) => c.query("select * from products where id = $1", [f.productId])))).toMatch(/permission denied/);
      const rows = await asAnon(async (c) => (await c.query("select id, slug, name, tags, brand, category_id, extra_category_ids, tax_class from products where id = $1", [f.productId])).rows);
      expect(rows).toHaveLength(1);
    });

    it("product_public_get は公開の項目だけを返す。shop_public_get の product_fields も公開の定義だけ", async () => {
      const p = await asAnon(async (c) => (await c.query<{ r: { slug: string; attributes: Record<string, unknown> } }>("select product_public_get($1, 'tee') as r", [f.shopId])).rows[0]!.r);
      expect(p.slug).toBe("tee");
      expect(p.attributes).toEqual({ material: "綿" });
      const s = await asAnon(async (c) => (await c.query<{ r: { settings: { product_fields: { key: string }[] } } }>("select shop_public_get(p_slug => 'h2-shop') as r")).rows[0]!.r);
      expect(s.settings.product_fields.map((x) => x.key)).toEqual(["material"]);
      // 非公開の商品・非公開のショップは null
      await getPool().query("update products set published = false where id = $1", [f.productId]);
      expect(await asAnon(async (c) => (await c.query("select product_public_get($1, 'tee') as r", [f.shopId])).rows[0]!.r)).toBeNull();
      await getPool().query("update products set published = true where id = $1", [f.productId]);
    });
  });

  describe("WordPress のパスワードの取り込み", () => {
    it("既にログインしたことのある会員には書かない", async () => {
      await getPool().query("insert into customers (shop_id, email, last_login_at) values ($1, 'active@example.com', now())", [f.shopId]);
      const hash = "$2y$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ01234"; // 塩 22 + ハッシュ 31 = 53 文字
      const r = await rpc<Record<string, number>>("import_member_passwords", [f.shopId, JSON.stringify([
        { email: "active@example.com", hash },
        { email: "fresh@example.com", hash },
      ])]);
      expect(r).toMatchObject({ imported: 1, created: 1, skipped_active: 1 });
      expect((await getPool().query("select legacy_password_hash from customers where email = 'active@example.com'")).rows[0]!.legacy_password_hash).toBeNull();
    });
  });

  describe("shops の守り", () => {
    it("降格された初代 owner は組織の外にショップを作れない", async () => {
      await asUser(f.ownerId, (c) => c.query("select org_member_set($1, $2, 'owner', '[]'::jsonb)", [orgId, admin]));
      await asUser(admin, (c) => c.query("select org_member_set($1, $2, 'member', '[]'::jsonb)", [orgId, f.ownerId]));
      expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("insert into shops (owner_id, slug, name) values ($1, 'rogue', 'R')", [f.ownerId])))).toMatch(/org_required/);
      await asUser(admin, (c) => c.query("select org_member_set($1, $2, 'owner', '[]'::jsonb)", [orgId, f.ownerId]));
      await asUser(f.ownerId, (c) => c.query("select org_member_set($1, $2, 'admin', '[]'::jsonb)", [orgId, admin]));
    });

    it("settings の項目だけでは headless / oauth を変えられない。ほかの設定は変えられる", async () => {
      expect(await expectDbError(() => asUser(clerk, (c) => c.query("update shops set settings = settings || '{\"headless\":{\"return_origins\":[\"https://evil.example\"]}}' where id = $1", [f.shopId])))).toMatch(/integrations_required/);
      expect(await expectDbError(() => asUser(clerk, (c) => c.query("update shops set settings = settings || '{\"oauth\":{\"google\":{\"client_id\":\"mine\"}}}' where id = $1", [f.shopId])))).toMatch(/integrations_required/);
      expect(await asUser(clerk, async (c) => (await c.query("update shops set settings = settings || '{\"notice\":\"changed\"}' where id = $1", [f.shopId])).rowCount)).toBe(1);
      // settings + integrations なら変えられる
      await setPerms(staff, ["integrations", "orders", "customers", "settings"]);
      expect(await asUser(staff, async (c) => (await c.query("update shops set settings = settings || '{\"headless\":{\"return_origins\":[\"https://ok.example\"]}}' where id = $1", [f.shopId])).rowCount)).toBe(1);
      await setPerms(staff, ["integrations", "orders", "customers"]);
    });
  });

  describe("orders.shipped_at", () => {
    it("orders の項目は発送日時を過去に書けない（180 日マスクの前倒し）。今の時刻は書ける", async () => {
      expect(await expectDbError(() => asUser(packer, (c) => c.query("update orders set status = 'shipped', shipped_at = now() - interval '400 days' where id = $1", [orderId])))).toMatch(/shipped_at_now/);
      expect(await asUser(packer, async (c) => (await c.query("update orders set status = 'shipped', shipped_at = now() where id = $1", [orderId])).rowCount)).toBe(1);
    });
  });

  describe("member_passkeys_reset", () => {
    it("customers の項目では呼べない。owner は呼べる", async () => {
      const cid = (await getPool().query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'pk@example.com') returning id", [f.shopId])).rows[0]!.id;
      expect(await expectDbError(() => asUser(staff, (c) => c.query("select member_passkeys_reset($1, $2)", [f.shopId, cid])))).toMatch(/forbidden/);
      expect(await asUser(f.ownerId, async (c) => (await c.query<{ r: number }>("select member_passkeys_reset($1, $2) as r", [f.shopId, cid])).rows[0]!.r)).toBe(0);
    });
  });

  describe("SKU・画像は同じショップの商品にだけ付く", () => {
    it("catalog の項目で他ショップの商品に SKU を差し込めない", async () => {
      expect(await expectDbError(() => asUser(picker, (c) => c.query("insert into skus (shop_id, product_id, code, price_jpy) values ($1, $2, 'EVIL', 1)", [f.shopId, other.productId])))).toMatch(/foreign key|row-level security/);
      expect(await expectDbError(() => asUser(picker, (c) => c.query("insert into product_images (shop_id, product_id, storage_key) values ($1, $2, 'shops/x/evil.jpg')", [f.shopId, other.productId])))).toMatch(/foreign key|row-level security/);
      expect(await asUser(picker, async (c) => (await c.query("insert into skus (shop_id, product_id, code, price_jpy) values ($1, $2, 'OK', 1)", [f.shopId, f.productId])).rowCount)).toBe(1);
    });
  });

  describe("プランの上限は並行の INSERT でも越えない", () => {
    it("上限 2 のところに 2 本のトランザクションで同時に入れると、片方は plan_limit_exceeded", async () => {
      const before = Number((await getPool().query("select count(*) from shops")).rows[0]!.count);
      await getPool().query("select site_settings_set('plan_limits', $1::jsonb)", [JSON.stringify({ shops: before + 1 })]);
      const a = await getPool().connect();
      const b = await getPool().connect();
      try {
        await a.query("begin");
        await b.query("begin");
        await a.query("insert into shops (owner_id, slug, name) values ($1, 'par-a', 'A')", [f.ownerId]);
        const second = b.query("insert into shops (owner_id, slug, name) values ($1, 'par-b', 'B')", [f.ownerId]);
        await new Promise((r) => setTimeout(r, 100));
        await a.query("commit");
        await expect(second).rejects.toThrow(/plan_limit_exceeded:shops/);
        await b.query("rollback").catch(() => undefined);
      } finally {
        a.release();
        b.release();
      }
      expect(Number((await getPool().query("select count(*) from shops")).rows[0]!.count)).toBe(before + 1);
      await getPool().query("select site_settings_set('plan_limits', '{}'::jsonb)");
    });
  });
});
