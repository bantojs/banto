import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

interface AuditRow {
  org_id: string;
  shop_id: string | null;
  actor_kind: string;
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  detail: Record<string, unknown>;
}

/**
 * 0051_audit_log: 監査ログ。
 * - 書くのはトリガーだけ。会員のメール・注文の状態・組織のメンバーと項目・AI 用トークン・ショップのドメイン / Stripe / 公開
 * - 誰が: api_require が置く banto.actor → service_role の X-Banto-Actor ヘッダ → auth.uid() → system
 * - 個人情報を入れない（メールはハッシュの先頭 16 桁）。読めるのは組織の owner / admin だけ。prune_audit_log は service_role だけ
 */
describe.skipIf(!dbAvailable)("監査ログ（0051_audit_log）", () => {
  let a: Fixture;
  let b: Fixture;
  let orgId: string;
  let token: string;
  let tokenId: string;
  const rows = async (where = "", args: unknown[] = []) =>
    (await getPool().query<AuditRow & { id: number }>(`select * from audit_log ${where ? `where ${where}` : ""} order by id`, args)).rows;
  const items = (skuId: string, qty: number) => JSON.stringify([{ sku_id: skuId, qty }]);

  async function order(shop: Fixture): Promise<{ id: string; number: number }> {
    const resId = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [shop.shopId, items(shop.skuId, 1)])).rows[0]!.id);
    await asService((c) => c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [resId, shop.shopId, JSON.stringify({ customer_email: "buyer@example.com", customer_name: "買い手", shipping_address: {}, shipping_jpy: 0 })]));
    const id = await asService(async (c) => (await c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [resId, shop.shopId, JSON.stringify({ payment_provider: "stripe", payment_ref: `pi_${resId}` })])).rows[0]!.id);
    const number = (await getPool().query<{ number: number }>("select number from orders where id = $1", [id])).rows[0]!.number;
    return { id, number };
  }

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "audit-a@example.com", slug: "audit-a", publish: true, stock: 50 });
    b = await createShopFixture({ email: "audit-b@example.com", slug: "audit-b", publish: true, stock: 50 });
    orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [a.shopId])).rows[0]!.org_id;
    await getPool().query(`update shops set settings = settings || '{"members_enabled": true}'::jsonb where id = $1`, [a.shopId]);
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    token = sha(raw);
    tokenId = await asUser(a.ownerId, async (c) =>
      (await c.query<{ id: string }>("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 'ai', $3, $4, $5) returning id", [a.shopId, a.ownerId, token, raw.slice(0, 12), ["orders:read", "orders:write", "customers:read", "customers:write"]])).rows[0]!.id,
    );
  });
  afterAll(closePool);

  it("最初の運営者と組織・AI 用トークンの発行が残る（発行は運営者の JWT = user）", async () => {
    const added = await rows("action = 'org_member.added' and org_id = $1", [orgId]);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ target_type: "user", target_id: a.ownerId, detail: { role: "owner" } });
    const issued = await rows("action = 'api_token.issued'");
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ org_id: orgId, shop_id: a.shopId, actor_kind: "user", actor_id: a.ownerId, target_id: tokenId, detail: { name: "ai", scopes: ["orders:read", "orders:write", "customers:read", "customers:write"] } });
    // 生のトークンやハッシュは残らない
    expect(JSON.stringify(issued[0]!.detail)).not.toContain(token);
  });

  it("会員のメールアドレスの変更: 運営者の操作が user で残り、アドレスそのものは残らない（ハッシュの先頭 16 桁）。削除も残る", async () => {
    const memberId = (await asService(async (c) => (await c.query<{ r: { id: string } }>("select api_customer_create($1, $2::jsonb) as r", [token, JSON.stringify({ email: "member@example.com" })])).rows[0]!.r)).id;
    await asUser(a.ownerId, (c) => c.query("select member_set_email($1, $2, 'Renamed@Example.com')", [a.shopId, memberId]));
    const changed = await rows("action = 'customer.email_changed'");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      org_id: orgId,
      shop_id: a.shopId,
      actor_kind: "user",
      actor_id: a.ownerId,
      target_type: "customer",
      target_id: memberId,
      detail: { old_email_hash: sha("member@example.com").slice(0, 16), new_email_hash: sha("renamed@example.com").slice(0, 16) },
    });
    await asUser(a.ownerId, (c) => c.query("delete from customers where shop_id = $1 and id = $2", [a.shopId, memberId]));
    const deleted = await rows("action = 'customer.deleted'");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ actor_kind: "user", actor_id: a.ownerId, target_id: memberId, detail: { email_hash: sha("renamed@example.com").slice(0, 16) } });
  });

  it("注文の状態: 管理画面の JWT は user、AI 用トークン経由は api_token（api_require が置く）、Worker の特権経路はヘッダで名乗り、名乗らなければ system", async () => {
    // 発送（運営者の JWT で status を更新。0028 が許す遷移）
    const o1 = await order(a);
    await asUser(a.ownerId, (c) => c.query("update orders set status = 'shipped', shipped_at = now() where id = $1", [o1.id]));
    expect(await rows("action = 'order.status_changed' and target_id = $1", [o1.id])).toMatchObject([
      { actor_kind: "user", actor_id: a.ownerId, shop_id: a.shopId, detail: { number: o1.number, from: "paid", to: "shipped" } },
    ]);
    // AI 用トークンでキャンセル
    const o2 = await order(a);
    await asService((c) => c.query("select api_order_cancel($1, $2, false)", [token, o2.id]));
    expect(await rows("action = 'order.status_changed' and target_id = $1", [o2.id])).toMatchObject([{ actor_kind: "api_token", actor_id: tokenId, detail: { from: "paid", to: "cancelled" } }]);
    // 管理画面のキャンセル（返金 → cancel_order は service_role。Worker が X-Banto-Actor で名乗る）
    const o3 = await order(a);
    await asService(async (c) => {
      await c.query("select set_config('request.headers', $1, true)", [JSON.stringify({ "x-banto-actor": `user:${a.ownerId}`, "user-agent": "test" })]);
      await c.query("select cancel_order($1, $2, true)", [o3.id, a.shopId]);
    });
    expect(await rows("action = 'order.status_changed' and target_id = $1", [o3.id])).toMatchObject([{ actor_kind: "user", actor_id: a.ownerId, detail: { from: "paid", to: "refunded" } }]);
    // 名乗らない特権経路（Webhook・Cron）は system
    const o4 = await order(a);
    await asService((c) => c.query("select cancel_order($1, $2, false)", [o4.id, a.shopId]));
    expect(await rows("action = 'order.status_changed' and target_id = $1", [o4.id])).toMatchObject([{ actor_kind: "system", actor_id: null }]);
    // 利用者の JWT のヘッダは読まない（偽れない）
    const o5 = await order(a);
    await withRole("authenticated", { sub: a.ownerId, email: "audit-a@example.com" }, async (c) => {
      await c.query("select set_config('request.headers', $1, true)", [JSON.stringify({ "x-banto-actor": `user:${b.ownerId}` })]);
      await c.query("update orders set status = 'shipped', shipped_at = now() where id = $1", [o5.id]);
    });
    expect(await rows("action = 'order.status_changed' and target_id = $1", [o5.id])).toMatchObject([{ actor_kind: "user", actor_id: a.ownerId }]);
  });

  it("組織のメンバー: 役割の変更・ショップごとの項目・削除が残る", async () => {
    const staff = await createAuthUser("audit-staff@example.com");
    await getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", [orgId, staff]);
    await asUser(a.ownerId, (c) => c.query("select org_member_set($1, $2, 'member', $3::jsonb)", [orgId, staff, JSON.stringify([{ shop_id: a.shopId, perms: ["catalog", "orders"] }])]));
    await asUser(a.ownerId, (c) => c.query("select org_member_set($1, $2, 'admin', '[]'::jsonb)", [orgId, staff]));
    await asUser(a.ownerId, (c) => c.query("select org_member_remove($1, $2)", [orgId, staff]));
    const log = await rows("target_type = 'user' and target_id = $1", [staff]);
    expect(log.map((r) => [r.action, r.actor_kind, r.detail])).toEqual([
      ["org_member.added", "system", { role: "member" }],
      ["org_member.shop_perms", "user", { from: null, to: ["catalog", "orders"] }],
      ["org_member.role_changed", "user", { from: "member", to: "admin" }],
      ["org_member.shop_perms", "user", { from: ["catalog", "orders"], to: null }],
      ["org_member.removed", "user", { role: "admin" }],
    ]);
    expect(log.find((r) => r.action === "org_member.shop_perms")!.shop_id).toBe(a.shopId);
    expect(log.every((r) => r.org_id === orgId)).toBe(true);
  });

  it("ショップの独自ドメイン・Stripe の接続先・公開の変更と、AI 用トークンの失効が残る。それ以外の列の更新は残らない", async () => {
    await asUser(a.ownerId, (c) => c.query("update shops set domain = 'shop.example.jp', name = '名前だけ変更' where id = $1", [a.shopId]));
    await asUser(a.ownerId, (c) => c.query("update shops set published = false where id = $1", [a.shopId]));
    await asUser(a.ownerId, (c) => c.query("update shops set name = '名前だけ再び変更' where id = $1", [a.shopId]));
    await getPool().query("update shops set stripe_account_id = 'acct_1' where id = $1", [a.shopId]);
    const shop = await rows("target_type = 'shop' and target_id = $1", [a.shopId]);
    expect(shop.map((r) => [r.action, r.actor_kind, r.detail])).toEqual([
      ["shop.domain_changed", "user", { from: null, to: "shop.example.jp" }],
      ["shop.published_changed", "user", { published: false }],
      ["shop.stripe_account_changed", "system", { from: null, to: "acct_1" }],
    ]);
    await asUser(a.ownerId, (c) => c.query("update api_tokens set revoked_at = now() where id = $1", [tokenId]));
    await asUser(a.ownerId, (c) => c.query("update api_tokens set revoked_at = now() where id = $1", [tokenId])); // 2 回目は変化なし
    expect(await rows("action = 'api_token.revoked'")).toMatchObject([{ actor_kind: "user", actor_id: a.ownerId, target_id: tokenId, detail: { name: "ai" } }]);
  });

  it("どの行の detail にもメールアドレスが入っていない", async () => {
    const all = await rows();
    expect(all.length).toBeGreaterThan(5);
    for (const r of all) expect(JSON.stringify(r.detail), r.action).not.toMatch(/@/);
  });

  it("RLS: 読めるのは組織の owner / admin だけ。別の組織・member・anon は読めず、誰も insert / update / delete できない", async () => {
    const mine = await asUser(a.ownerId, (c) => c.query("select org_id from audit_log"));
    expect(mine.rows.length).toBeGreaterThan(5);
    expect(mine.rows.every((r) => r.org_id === orgId)).toBe(true);
    const theirs = await asUser(b.ownerId, (c) => c.query("select org_id from audit_log"));
    expect(theirs.rows.every((r) => r.org_id !== orgId)).toBe(true);
    const member = await createAuthUser("audit-member@example.com");
    await getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", [orgId, member]);
    await getPool().query("insert into org_member_shops (org_id, user_id, shop_id, perms) values ($1, $2, $3, '{catalog,orders,customers,settings,integrations}')", [orgId, member, a.shopId]);
    expect((await asUser(member, (c) => c.query("select id from audit_log"))).rows).toHaveLength(0);
    expect(await expectDbError(() => asAnon((c) => c.query("select id from audit_log")))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("insert into audit_log (org_id, actor_kind, action, target_type) values ($1, 'user', 'x', 'y')", [orgId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("delete from audit_log where org_id = $1", [orgId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("update audit_log set action = 'x' where org_id = $1", [orgId])))).toMatch(/permission denied/);
    // 書く側の関数は anon / authenticated から呼べない
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select banto_audit($1, null, 'x', 'y', null, '{}')", [orgId])))).toMatch(/permission denied/);
  });

  it("prune_audit_log: service_role だけ。既定 365 日より古い行を消し、30 日より短くはできない", async () => {
    const n = (await getPool().query<{ n: string }>("select count(*)::text as n from audit_log")).rows[0]!.n;
    await getPool().query("update audit_log set created_at = now() - interval '400 days' where id = (select min(id) from audit_log)");
    await getPool().query("update audit_log set created_at = now() - interval '40 days' where id = (select max(id) from audit_log)");
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select prune_audit_log(1)")))).toMatch(/permission denied/);
    expect(await expectDbError(() => asAnon((c) => c.query("select prune_audit_log(1)")))).toMatch(/permission denied/);
    const pruned = await asService(async (c) => (await c.query<{ r: number }>("select prune_audit_log(1) as r")).rows[0]!.r); // 1 日 → 30 日に切り上げ
    expect(pruned).toBe(2);
    expect((await getPool().query<{ n: string }>("select count(*)::text as n from audit_log")).rows[0]!.n).toBe(String(Number(n) - 2));
    expect(await asService(async (c) => (await c.query<{ r: number }>("select prune_audit_log() as r")).rows[0]!.r)).toBe(0);
  });

  it("組織を消すとログも消え、ショップを消しても残る", async () => {
    const c = await createShopFixture({ email: "audit-c@example.com", slug: "audit-c", publish: true });
    const cOrg = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [c.shopId])).rows[0]!.org_id;
    await asUser(c.ownerId, (q) => q.query("update shops set published = false where id = $1", [c.shopId]));
    expect(await rows("org_id = $1", [cOrg])).toHaveLength(2); // owner の追加 + 公開の変更
    await getPool().query("delete from shops where id = $1", [c.shopId]);
    expect(await rows("org_id = $1 and shop_id = $2", [cOrg, c.shopId])).toHaveLength(1);
    await getPool().query("delete from organizations where id = $1", [cOrg]);
    expect(await rows("org_id = $1", [cOrg])).toHaveLength(0);
  });
});
