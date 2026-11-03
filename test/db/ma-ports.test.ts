import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * 0105_ma_ports: 外部プラグイン向けの口。
 *   A. LINE で送る口（line:send、項目 marketing）: LINE の利用者 ID は Worker にだけ返し、冪等のキー・月の上限・状態を DB が持つ
 *   B. 注文の一覧を会員で絞る・更新順に取りこぼしなく読む
 *   C. hooks checkout.abandoned（会員の予約の期限切れだけ）
 */
describe.skipIf(!dbAvailable)("外部プラグイン向けの口（0105_ma_ports）", () => {
  let a: Fixture;
  let b: Fixture;
  let orgId: string;
  let lineTok: string;
  let bTok: string;
  let ordersTok: string;
  let member: string;
  let noLine: string;
  let bMember: string;

  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);

  function issue(uid: string, shopId: string, scopes: string[]) {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    const hash = sha(raw);
    return asUser(uid, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [shopId, uid, hash, raw.slice(0, 12), scopes])).then(() => hash);
  }
  const begin = (tok: string, cust: string, key: string) => rpc<Record<string, unknown>>("api_line_message_begin", [tok, cust, key]);
  const finish = (tok: string, id: unknown, status: string) => rpc<Record<string, unknown>>("api_line_message_finish", [tok, id, status]);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "ma-a@example.com", slug: "ma-a", publish: true, stock: 20 });
    b = await createShopFixture({ email: "ma-b@example.com", slug: "ma-b", publish: true, stock: 5 });
    orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [a.shopId])).rows[0]!.org_id;
    lineTok = await issue(a.ownerId, a.shopId, ["line:send"]);
    bTok = await issue(b.ownerId, b.shopId, ["line:send"]);
    ordersTok = await issue(a.ownerId, a.shopId, ["orders:read"]);
    const pool = getPool();
    member = (await pool.query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'line@example.com') returning id", [a.shopId])).rows[0]!.id;
    noLine = (await pool.query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'mail@example.com') returning id", [a.shopId])).rows[0]!.id;
    bMember = (await pool.query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'b@example.com') returning id", [b.shopId])).rows[0]!.id;
    await pool.query("insert into member_identities (shop_id, provider, subject, customer_id) values ($1, 'line', 'U-member', $2)", [a.shopId, member]);
    await pool.query("insert into member_identities (shop_id, provider, subject, customer_id) values ($1, 'line', 'U-b', $2)", [b.shopId, bMember]);
  });
  afterAll(closePool);

  describe("A. LINE で送る口", () => {
    it("line:send は marketing の項目の人だけが付けられる", async () => {
      const staff = await createAuthUser("ma-staff@example.com");
      const token = "inv-ma-staff";
      await asUser(a.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, "ma-staff@example.com", JSON.stringify([{ shop_id: a.shopId, perms: ["integrations"] }]), sha(token)]));
      await withRole("authenticated", { sub: staff, email: "ma-staff@example.com" }, (c) => c.query("select org_invitation_accept($1)", [sha(token)]));
      expect(await expectDbError(() => issue(staff, a.shopId, ["line:send"]))).toMatch(/scope_not_permitted/);
      await asUser(a.ownerId, (c) => c.query("select org_member_set($1, $2, 'member', $3::jsonb)", [orgId, staff, JSON.stringify([{ shop_id: a.shopId, perms: ["integrations", "marketing"] }])]));
      expect(await issue(staff, a.shopId, ["line:send"])).toMatch(/^[0-9a-f]{64}$/);
      // ほかのスコープでは呼べない
      expect(await expectDbError(() => begin(ordersTok, member, "key-00000001"))).toMatch(/unauthorized/);
    });

    it("送るときだけ LINE の利用者 ID と再送キーを返す。同じキーは送り直さない。決まったら記録に ID は残らない", async () => {
      const r = await begin(lineTok, member, "key-00000002");
      expect(r).toMatchObject({ status: "pending", done: false, line_user_id: "U-member" });
      expect(r["retry_key"]).toBe(r["id"]);
      // まだ pending なら同じ再送キーで送り直せる
      expect(await begin(lineTok, member, "key-00000002")).toMatchObject({ id: r["id"], status: "pending", line_user_id: "U-member" });
      expect(await finish(lineTok, r["id"], "sent")).toMatchObject({ status: "sent" });
      expect(await begin(lineTok, member, "key-00000002")).toEqual({ id: r["id"], status: "sent", done: true });
      // 別の会員に同じキーは使えない
      expect(await expectDbError(() => begin(lineTok, noLine, "key-00000002"))).toMatch(/idempotency_key_reused/);
      // 決まった行は変えられない
      expect(await expectDbError(() => finish(lineTok, r["id"], "failed"))).toMatch(/not_found/);
      const cols = (await getPool().query("select * from line_messages where id = $1", [r["id"]])).rows[0];
      expect(JSON.stringify(cols)).not.toContain("U-member");
    });

    it("LINE と結んでいない会員は no_line（ID を返さない）。ほかのショップの会員・トークンは not_found", async () => {
      expect(await begin(lineTok, noLine, "key-00000003")).toMatchObject({ status: "no_line", done: true });
      expect(await expectDbError(() => begin(lineTok, bMember, "key-00000004"))).toMatch(/not_found/);
      const r = await begin(lineTok, member, "key-00000005");
      expect(await expectDbError(() => finish(bTok, r["id"], "sent"))).toMatch(/not_found/);
      expect(await finish(lineTok, r["id"], "not_friend")).toMatchObject({ status: "not_friend" });
      expect(await expectDbError(() => begin(lineTok, member, "short"))).toMatch(/invalid_idempotency_key/);
    });

    it("宣伝の月の上限（failed・no_line・not_friend は数えない）。上限は settings.line_marketing_limit", async () => {
      // ここまでの今月の数: sent 1（not_friend・no_line は数えない）
      expect(await rpc("api_line_usage", [lineTok])).toMatchObject({ count: 1, limit: 150 });
      await getPool().query(`update shops set settings = settings || '{"line_marketing_limit": 2}'::jsonb where id = $1`, [a.shopId]);
      const r = await begin(lineTok, member, "key-00000006");
      expect(await finish(lineTok, r["id"], "failed")).toMatchObject({ status: "failed" });
      expect((await rpc<{ count: number }>("api_line_usage", [lineTok])).count).toBe(1);
      // failed は同じキーで送り直せる
      expect(await begin(lineTok, member, "key-00000006")).toMatchObject({ id: r["id"], status: "pending" });
      expect(await begin(lineTok, member, "key-00000007")).toMatchObject({ status: "quota", done: true, limit: 2, count: 2 });
      await getPool().query(`update shops set settings = settings || '{"line_marketing_limit": 0}'::jsonb where id = $1`, [a.shopId]);
      expect(await begin(lineTok, member, "key-00000008")).toMatchObject({ status: "quota" });
      await getPool().query(`update shops set settings = settings - 'line_marketing_limit' where id = $1`, [a.shopId]);
    });

    it("記録は marketing の項目の人だけが読める。api_* は service_role だけ。退会で会員 ID を外す", async () => {
      expect((await asUser(a.ownerId, (c) => c.query("select id from line_messages"))).rows.length).toBeGreaterThan(0);
      expect((await asUser(b.ownerId, (c) => c.query("select id from line_messages where shop_id = $1", [a.shopId]))).rows).toHaveLength(0);
      for (const role of ["anon", "authenticated"] as const) {
        expect(await expectDbError(() => withRole(role, role === "anon" ? {} : { sub: a.ownerId }, (c) => c.query("select api_line_message_begin($1, $2, 'key-00000009')", [lineTok, member])))).toMatch(/permission denied/);
      }
      await getPool().query("delete from customers where id = $1", [member]);
      expect((await getPool().query("select count(*)::int as n from line_messages where customer_id = $1", [member])).rows[0].n).toBe(0);
      expect((await getPool().query("select count(*)::int as n from line_messages where shop_id = $1", [a.shopId])).rows[0].n).toBeGreaterThan(0);
    });
  });

  describe("B. 注文の一覧", () => {
    it("会員で絞る。更新順に cursor で読むと、同じ時刻の行も読み落とさない", async () => {
      const pool = getPool();
      const cust = (await pool.query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'o@example.com') returning id", [a.shopId])).rows[0]!.id;
      const t0 = "2026-11-01T00:00:00Z";
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = (await pool.query<{ id: string }>("insert into orders (shop_id, total_jpy, customer_id, number) values ($1, 1000, $2, $3) returning id", [a.shopId, i < 3 ? cust : null, 9001 + i])).rows[0]!.id;
        ids.push(id);
      }
      // 3 件を同じ時刻に
      await pool.query("alter table orders disable trigger orders_updated_at");
      await pool.query("update orders set updated_at = $2 where id = any($1)", [ids.slice(0, 3), t0]);
      await pool.query("update orders set updated_at = $2::timestamptz + interval '1 minute' where id = any($1)", [ids.slice(3), t0]);
      await pool.query("alter table orders enable trigger orders_updated_at");

      const mine = await rpc<{ items: { id: string }[]; total: number }>("api_orders_list", [ordersTok, null, null, null, 50, 0, null, cust, null, null]);
      expect(mine.total).toBe(3);
      expect(mine.items.map((o) => o.id).sort()).toEqual(ids.slice(0, 3).sort());

      const seen: string[] = [];
      let cursor: { updated_since: string; after: string } | null = null;
      let page: { items: { id: string }[]; cursor: { updated_since: string; after: string } | null; has_more: boolean };
      do {
        page = await rpc("api_orders_list", [ordersTok, null, null, null, 2, 0, null, null, cursor?.updated_since ?? t0, cursor?.after ?? null]);
        seen.push(...page.items.map((o) => o.id));
        cursor = page.cursor;
      } while (page.has_more);
      expect(seen).toHaveLength(5);
      expect(new Set(seen)).toEqual(new Set(ids));
      // 最後のページの続きは空
      const last = await rpc<{ items: unknown[]; cursor: unknown; has_more: boolean }>("api_orders_list", [ordersTok, null, null, null, 2, 0, null, null, cursor!.updated_since, cursor!.after]);
      expect(last).toMatchObject({ items: [], cursor: null, has_more: false });
      // after だけは受けない
      expect(await expectDbError(() => rpc("api_orders_list", [ordersTok, null, null, null, 2, 0, null, null, null, ids[0]]))).toMatch(/invalid_cursor/);
      // 今までの呼び方はそのまま
      expect((await rpc<{ total: number }>("api_orders_list", [ordersTok, null, null, null, 50, 0])).total).toBe(5);
    });
  });

  describe("C. checkout.abandoned", () => {
    async function endpoint(shopId: string) {
      await getPool().query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'ma', 'https://example.com/hook', $2)", [shopId, ["checkout.abandoned"]]);
    }
    async function reserve(customerId: string | null) {
      const id = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb, 900) as id", [a.shopId, JSON.stringify([{ sku_id: a.skuId, qty: 2 }])])).rows[0]!.id);
      if (customerId) await getPool().query("update reservations set customer_id = $2 where id = $1", [id, customerId]);
      return id;
    }
    const deliveries = async () => (await getPool().query<{ payload: Record<string, unknown> }>("select payload from hook_deliveries where event = 'checkout.abandoned' order by created_at")).rows.map((r) => r.payload);

    it("会員の予約の期限切れ（Cron・決済ページの期限切れ）だけ。ゲスト・ただの解放・二重の解放は積まない。個人情報を載せない", async () => {
      await endpoint(a.shopId);
      const cust = (await getPool().query<{ id: string }>("insert into customers (shop_id, email, name) values ($1, 'ab@example.com', '山田') returning id", [a.shopId])).rows[0]!.id;
      const viaCron = await reserve(cust);
      const guest = await reserve(null);
      await getPool().query("update reservations set expires_at = now() - interval '1 second' where id = any($1)", [[viaCron, guest]]);
      await asService((c) => c.query("select release_expired_reservations()"));
      let d = await deliveries();
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({ reservation_id: viaCron, customer_id: cust, reason: "expired", subtotal_jpy: expect.any(Number) });
      expect(d[0]!["items"]).toEqual([expect.objectContaining({ sku_id: a.skuId, product_id: a.productId, qty: 2 })]);
      expect(JSON.stringify(d[0])).not.toMatch(/ab@example|山田/);

      const viaWebhook = await reserve(cust);
      expect(await asService(async (c) => (await c.query<{ r: boolean }>("select release_reservation_abandoned($1, $2) as r", [viaWebhook, a.shopId])).rows[0]!.r)).toBe(true);
      expect(await asService(async (c) => (await c.query<{ r: boolean }>("select release_reservation_abandoned($1, $2) as r", [viaWebhook, a.shopId])).rows[0]!.r)).toBe(false);
      const plain = await reserve(cust);
      await asService((c) => c.query("select release_reservation($1, $2)", [plain, a.shopId]));
      d = await deliveries();
      expect(d.map((x) => x["reservation_id"])).toEqual([viaCron, viaWebhook]);
      expect(await expectDbError(() => withRole("authenticated", { sub: a.ownerId }, (c) => c.query("select release_reservation_abandoned($1, $2)", [plain, a.shopId])))).toMatch(/permission denied|service_role only/);
    });
  });
});
