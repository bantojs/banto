import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, CUSTOMER_COLUMNS, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * 0028_security_hardening: 監査（2026-10-18 のコード監査）の H1 / M3 / M4 / M5 / M6 / M11。
 * 「できる」と「できない」の両方を、攻撃側の役割（他の組織の運営者・項目の少ないスタッフ・anon）から確かめる。
 */
describe.skipIf(!dbAvailable)("セキュリティの締め直し（0028_security_hardening）", () => {
  let f: Fixture;
  let other: Fixture;
  let orgId: string;
  let staff: string; // integrations だけ
  let clerk: string; // orders だけ
  let orderId: string;
  let customerId: string;

  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);

  async function invite(uid: string, email: string, perms: string[]) {
    const token = `inv-${email}`;
    await asUser(f.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, email, JSON.stringify([{ shop_id: f.shopId, perms }]), sha(token)]));
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
    f = await createShopFixture({ email: "h-owner@example.com", slug: "h-shop", publish: true, stock: 5 });
    other = await createShopFixture({ email: "h-other@example.com", slug: "h-other", publish: true });
    orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    await getPool().query(
      `update shops set stripe_account_id = 'acct_secret', settings = '{"theme_settings":{"accent":"#123456"},"notice":"hi","shipping":{"mode":"flat","flat_fee_jpy":500},"modules":{"coupons":true},
        "contact_email":"owner@example.com","low_stock_threshold":2,"headless":{"return_origins":["https://wp.example"],"other":"x"},
        "oauth":{"line":{"client_id":"lineid","bot_prompt":"aggressive","extra":"no"}},"shipping_labels":{"yamato":"secret"}}'::jsonb where id = $1`,
      [f.shopId],
    );
    orderId = (await getPool().query<{ id: string }>("insert into orders (shop_id, total_jpy, customer_email, customer_name, number, shipping_address) values ($1, 1000, 'buyer@example.com', '買主', 1001, '{\"state\":\"東京都\"}') returning id", [f.shopId])).rows[0]!.id;
    customerId = (await getPool().query<{ id: string }>("insert into customers (shop_id, email, name, password_hash, legacy_password_hash) values ($1, 'member@example.com', '会員', '$2a$10$hash', '$wp$2y$10$legacy') returning id", [f.shopId])).rows[0]!.id;
    staff = await createAuthUser("h-staff@example.com");
    clerk = await createAuthUser("h-clerk@example.com");
    await invite(staff, "h-staff@example.com", ["integrations"]);
    await invite(clerk, "h-clerk@example.com", ["orders"]);
  });
  afterAll(closePool);

  describe("H1: AI 用トークンのスコープは発行者の項目まで", () => {
    it("integrations だけのスタッフは orders:pii 等のトークンを発行できない。持っている項目のスコープだけ発行できる", async () => {
      expect(await expectDbError(() => issue(staff, ["orders:pii"]))).toMatch(/scope_not_permitted/);
      expect(await expectDbError(() => issue(staff, ["products:read", "orders:read"]))).toMatch(/scope_not_permitted/);
      const h = await issue(staff, ["shop:read"]);
      expect(await rpc("api_has_scope", [h, "shop:read"])).toBe(true);
      // 自分の JWT で PostgREST に直接 insert しても同じ（トリガー）。既存のトークンのスコープも広げられない
      expect(await expectDbError(() => asUser(staff, (c) => c.query("update api_tokens set scopes = '{orders:pii}' where token_hash = $1", [h])))).toMatch(/scope_not_permitted|token_immutable/);
    });

    it("項目を外すと、そのスコープだけ使えなくなる（他のスコープは残る）。owner / admin は全部出せる", async () => {
      await setPerms(staff, ["integrations", "catalog", "orders"]);
      const h = await issue(staff, ["products:read", "orders:read"]);
      expect(await rpc("api_has_scope", [h, "orders:read"])).toBe(true);
      await setPerms(staff, ["integrations", "catalog"]);
      expect(await rpc("api_has_scope", [h, "orders:read"])).toBe(false);
      expect(await rpc("api_has_scope", [h, "products:read"])).toBe(true);
      expect(await expectDbError(() => rpc("api_orders_list", [h]))).toMatch(/unauthorized/);
      expect((await rpc<{ total: number }>("api_products_list", [h])).total).toBe(1);
      await setPerms(staff, ["integrations"]);
      const all = ["products:read", "products:write", "orders:read", "orders:pii", "orders:write", "shop:read", "shop:write", "stats:read"];
      const o = await issue(f.ownerId, all);
      expect(await rpc("api_has_scope", [o, "orders:pii"])).toBe(true);
    });

    it("orders:write だけでは返金・キャンセルできない（orders_cancel の項目が要る）", async () => {
      await setPerms(staff, ["integrations", "orders"]);
      const h = await issue(staff, ["orders:read", "orders:write"]);
      expect(await rpc("api_order_update_status", [h, orderId, "shipped"])).toMatchObject({ status: "shipped" });
      expect(await expectDbError(() => rpc("api_order_payment_info", [h, orderId]))).toMatch(/unauthorized/);
      expect(await expectDbError(() => rpc("api_order_cancel", [h, orderId, false]))).toMatch(/unauthorized/);
      await setPerms(staff, ["integrations", "orders", "orders_cancel"]);
      expect(await rpc("api_order_payment_info", [h, orderId])).toMatchObject({ status: "shipped" });
      await getPool().query("update orders set status = 'paid' where id = $1", [orderId]);
      await setPerms(staff, ["integrations"]);
    });
  });

  describe("M3: orders の直接更新", () => {
    it("orders の項目で変えられるのは status / shipped_at だけ。遷移は paid → shipped だけ", async () => {
      for (const sql of [
        "update orders set total_jpy = 1 where id = $1",
        "update orders set customer_email = 'x@example.com' where id = $1",
        "update orders set shipping_address = '{}' where id = $1",
        "update orders set number = 1 where id = $1",
        "update orders set shop_id = $2 where id = $1",
      ]) {
        expect(await expectDbError(() => asUser(clerk, (c) => c.query(sql, sql.includes("$2") ? [orderId, other.shopId] : [orderId]))), sql).toMatch(/permission denied/);
      }
      expect(await expectDbError(() => asUser(clerk, (c) => c.query("update orders set status = 'cancelled' where id = $1", [orderId])))).toMatch(/use_cancel_order/);
      expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update orders set status = 'refunded' where id = $1", [orderId])))).toMatch(/use_cancel_order/);
      const r = await asUser(clerk, (c) => c.query("update orders set status = 'shipped', shipped_at = now() where id = $1 and status = 'paid' returning status", [orderId]));
      expect(r.rows).toEqual([{ status: "shipped" }]);
      expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update orders set status = 'paid' where id = $1", [orderId])))).toMatch(/use_cancel_order/);
      // service_role（cancel_order・api_order_update_status）は制限されない
      await asService((c) => c.query("update orders set status = 'paid', shipped_at = null where id = $1", [orderId]));
    });
  });

  describe("M4: customers の秘密の列", () => {
    it("owner・customers の項目でもパスワードのハッシュ・世代は読めない。一覧の列は読める。会員の RPC は影響を受けない", async () => {
      await setPerms(clerk, ["orders", "customers"]);
      for (const uid of [f.ownerId, clerk]) {
        expect(await expectDbError(() => asUser(uid, (c) => c.query("select password_hash from customers")))).toMatch(/permission denied/);
        expect(await expectDbError(() => asUser(uid, (c) => c.query("select legacy_password_hash, session_epoch from customers")))).toMatch(/permission denied/);
        expect(await expectDbError(() => asUser(uid, (c) => c.query("select * from customers")))).toMatch(/permission denied/);
        const rows = (await asUser(uid, (c) => c.query(`select ${CUSTOMER_COLUMNS} from customers where shop_id = $1`, [f.shopId]))).rows;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ email: "member@example.com", name: "会員" });
      }
      expect(await expectDbError(() => asAnon((c) => c.query("select id from customers")))).toMatch(/permission denied/);
      const m = await rpc<{ customer: { has_password: boolean } }>("member_get", [f.shopId, customerId, 0, false]);
      expect(m.customer).toMatchObject({ has_password: true });
      await setPerms(clerk, ["orders"]);
    });
  });

  describe("M5: anon に見せる shops の列", () => {
    it("anon は settings / stripe_account_id / order_seq / owner_id を読めない。他の組織の運営者は公開ショップの行を読めない", async () => {
      for (const col of ["settings", "stripe_account_id", "order_seq", "tryon_seq", "owner_id", "org_id"]) {
        expect(await expectDbError(() => asAnon((c) => c.query(`select ${col} from shops`))), col).toMatch(/permission denied/);
      }
      expect(await expectDbError(() => asAnon((c) => c.query("select * from shops")))).toMatch(/permission denied/);
      const rows = (await asAnon((c) => c.query("select slug, name, legal_notice, domain from shops order by slug"))).rows;
      expect(rows.map((r) => r.slug)).toEqual(["h-other", "h-shop"]);
      expect((await asUser(other.ownerId, (c) => c.query("select id from shops where id = $1", [f.shopId]))).rows).toHaveLength(0);
      expect((await asUser(f.ownerId, (c) => c.query("select settings->>'contact_email' as e from shops where id = $1", [f.shopId]))).rows).toEqual([{ e: "owner@example.com" }]);
    });

    it("shop_public_get / shop_public_list は公開の settings だけ返す（headless は戻り先だけ、oauth は client_id と bot_prompt だけ）", async () => {
      const s = await asAnon(async (c) => (await c.query<{ r: Record<string, unknown> }>("select shop_public_get($1) as r", ["h-shop"])).rows[0]!.r);
      expect(s).toMatchObject({ slug: "h-shop", name: "Shop h-shop", published: true, legal_notice: "特商法表記", stripe_connected: true, domain: null });
      expect(s["stripe_account_id"]).toBeUndefined();
      expect(s["settings"]).toEqual({
        theme_settings: { accent: "#123456" },
        notice: "hi",
        shipping: { mode: "flat", flat_fee_jpy: 500 },
        modules: { coupons: true },
        headless: { return_origins: ["https://wp.example"] },
        oauth: { line: { client_id: "lineid", bot_prompt: "aggressive" } },
      });
      // 0034: 中継元の IP（連携側のサーバーの素の IP）は公開の settings に含めない。service_role は shops.settings から読める
      await getPool().query(`update shops set settings = jsonb_set(settings, '{headless,relay_ips}', '["198.51.100.1"]') where id = $1`, [f.shopId]);
      const withRelay = await asAnon(async (c) => (await c.query<{ r: Record<string, unknown> }>("select shop_public_get($1) as r", ["h-shop"])).rows[0]!.r);
      expect((withRelay["settings"] as Record<string, unknown>)["headless"]).toEqual({ return_origins: ["https://wp.example"] });
      expect(JSON.stringify(withRelay)).not.toContain("198.51.100.1");
      expect((await asService((c) => c.query<{ h: Record<string, unknown> }>("select settings->'headless' as h from shops where id = $1", [f.shopId]))).rows[0]!.h).toMatchObject({ relay_ips: ["198.51.100.1"] });
      const none = await asAnon(async (c) => (await c.query<{ r: unknown }>("select shop_public_get($1) as r", ["nope"])).rows[0]!.r);
      expect(none).toBeNull();
      await getPool().query("update shops set domain = 'shop.example.jp' where id = $1", [f.shopId]);
      const byDomain = await asAnon(async (c) => (await c.query<{ r: Record<string, unknown> }>("select shop_public_get(null, $1) as r", ["shop.example.jp"])).rows[0]!.r);
      expect(byDomain).toMatchObject({ slug: "h-shop", domain: "shop.example.jp" });
      const list = await asAnon(async (c) => (await c.query<{ r: Record<string, unknown>[] }>("select shop_public_list() as r")).rows[0]!.r);
      expect(list.map((x) => x["slug"])).toEqual(["h-shop", "h-other"]);
      // 非公開のショップは出ない
      await getPool().query("update shops set published = false where id = $1", [other.shopId]);
      expect((await asAnon(async (c) => (await c.query<{ r: Record<string, unknown>[] }>("select shop_public_list() as r")).rows[0]!.r)).map((x) => x["slug"])).toEqual(["h-shop"]);
      await getPool().query("update shops set published = true where id = $1", [other.shopId]);
    });
  });

  describe("M6: shop_payment_options", () => {
    it("決済プラグイン（stripe / komoju）の表示に要る設定だけ。メール・LINE 通知の設定は出ない", async () => {
      await asUser(f.ownerId, async (c) => {
        for (const [id, settings] of [
          ["komoju", { payment_types: "credit_card,konbini", reservation_hours: "2", secret_like: "x" }],
          ["stripe", {}],
          ["email_resend", { from: "shop@example.com", bcc_owner: true }],
          ["line_notify", { to: "Uowner" }],
        ] as const) {
          await c.query("insert into hook_endpoints (shop_id, name, url, events, enabled, settings) values ($1, $2, $3, '{order.paid}', true, $4)", [f.shopId, id, `https://banto.invalid/plugins/${id}`, JSON.stringify(settings)]);
        }
      });
      const opts = await asAnon(async (c) => (await c.query<{ r: { id: string; settings: Record<string, unknown> }[] }>("select shop_payment_options($1) as r", [f.shopId])).rows[0]!.r);
      expect(opts.map((o) => o.id).sort()).toEqual(["komoju", "stripe"]);
      expect(opts.find((o) => o.id === "komoju")!.settings).toEqual({ payment_types: "credit_card,konbini", reservation_hours: "2" });
      expect(JSON.stringify(opts)).not.toMatch(/Uowner|shop@example.com|secret_like/);
    });
  });

  describe("M11: enqueue_hook", () => {
    it("catalog は product.updated だけ、orders は order.shipped だけ。注文の確定などは積めない", async () => {
      await setPerms(staff, ["integrations", "catalog"]);
      await asUser(f.ownerId, (c) => c.query("insert into hook_endpoints (shop_id, name, url, events, enabled) values ($1, 'crm', 'https://crm.example/hook', '{order.paid,order.shipped,product.updated,tryon.requested}', true)", [f.shopId]));
      expect(await rpc("enqueue_hook", [f.shopId, "tryon.requested", {}])).toBe(1); // service_role（DB の中からの確定）はよい
      expect(await asUser(staff, async (c) => (await c.query<{ n: number }>("select enqueue_hook($1, 'product.updated', '{}') as n", [f.shopId])).rows[0]!.n)).toBe(1);
      for (const ev of ["order.paid", "order.shipped", "tryon.requested", "order.created"]) {
        expect(await expectDbError(() => asUser(staff, (c) => c.query("select enqueue_hook($1, $2, '{}')", [f.shopId, ev]))), ev).toMatch(/event_not_permitted|shop_not_found/);
      }
      expect(await asUser(clerk, async (c) => (await c.query<{ n: number }>("select enqueue_hook($1, 'order.shipped', '{}') as n", [f.shopId])).rows[0]!.n)).toBe(1);
      expect(await expectDbError(() => asUser(clerk, (c) => c.query("select enqueue_hook($1, 'product.updated', '{}')", [f.shopId])))).toMatch(/shop_not_found/);
      expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select enqueue_hook($1, 'order.paid', '{}')", [f.shopId])))).toMatch(/event_not_permitted/);
      await setPerms(staff, ["integrations"]);
    });
  });
});
