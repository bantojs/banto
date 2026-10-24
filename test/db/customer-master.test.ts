import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * 0047_customer_master: 顧客マスタの外部連携の器（docs/knowledge/13-external-customer-master.md）。
 * - customers の変化で customer.created / updated / deleted が積まれ、ペイロードに個人情報が無い
 * - attributes は定義（shops.settings.customer_fields）にある鍵だけ、external_ref はショップ × provider × id で一意
 * - api_customer_upsert はメールアドレスで引き、email は変えない
 * - anon / authenticated から新しい関数は呼べない。復元で external_ref と attributes が戻る
 */
describe.skipIf(!dbAvailable)("顧客マスタの外部連携（0047_customer_master）", () => {
  let a: Fixture;
  let b: Fixture;
  let token: string;
  let readToken: string;
  let bToken: string;

  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
  const deliveries = () => getPool().query<{ event: string; payload: Record<string, unknown> }>("select event, payload from hook_deliveries order by created_at, event");

  async function issue(uid: string, shopId: string, scopes: string[]) {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    const hash = sha(raw);
    await asUser(uid, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [shopId, uid, hash, raw.slice(0, 12), scopes]));
    return hash;
  }

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "cm-a@example.com", slug: "cm-a", publish: true, stock: 5 });
    b = await createShopFixture({ email: "cm-b@example.com", slug: "cm-b", publish: true, stock: 5 });
    const fields = JSON.stringify({
      members_enabled: true,
      customer_fields: [
        { key: "rank", label: "会員ランク", type: "select", options: ["regular", "silver", "gold"] },
        { key: "newsletter", label: "メルマガ", type: "select", options: ["yes", "no"] },
        { key: "score", label: "スコア", type: "number" },
        { key: "memo", label: "メモ", type: "textarea" },
        { key: "site", label: "サイト", type: "url" },
      ],
    });
    await getPool().query("update shops set settings = settings || $2::jsonb where id = $1", [a.shopId, fields]);
    await getPool().query("update shops set settings = settings || '{\"members_enabled\": true}'::jsonb where id = $1", [b.shopId]);
    // ログインのメールの送信元（member_login_start が要る）
    await getPool().query("insert into hook_endpoints (shop_id, name, url, events, settings) values ($1, 'mail', 'https://banto.invalid/plugins/email_resend', '{}', '{\"from\": \"Shop <shop@example.com>\"}')", [a.shopId]);
    token = await issue(a.ownerId, a.shopId, ["customers:read", "customers:write"]);
    readToken = await issue(a.ownerId, a.shopId, ["customers:read"]);
    bToken = await issue(b.ownerId, b.shopId, ["customers:read", "customers:write"]);
    // 会員の出来事を購読する送信先（a だけ）。customer.updated を購読しない送信先も 1 つ
    await asUser(a.ownerId, (c) =>
      c.query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'crm', 'https://crm.example/hook', $2), ($1, 'only-created', 'https://x.example/hook', $3)", [
        a.shopId,
        ["customer.created", "customer.updated", "customer.deleted"],
        ["customer.created"],
      ]),
    );
  });
  afterAll(closePool);
  beforeEach(async () => {
    await getPool().query("delete from hook_deliveries");
    await getPool().query("delete from customers");
  });

  describe("hooks のトリガー", () => {
    it("作成・プロフィールの変更・削除で積む。ペイロードは id と external_ref だけ。ログインの時刻・世代・パスワードでは積まない", async () => {
      const created = await rpc<{ id: string }>("api_customer_create", [token, { email: "Hook@Example.com", name: "秘密 太郎", default_address: { state: "東京都", line1: "秘密の住所" }, external_ref: { provider: "hubspot", id: "c-1" } }]);
      let rows = (await deliveries()).rows;
      expect(rows.map((r) => r.event)).toEqual(["customer.created", "customer.created"]); // 2 つの送信先
      expect(rows[0]!.payload).toEqual({ customer_id: created.id, shop_id: a.shopId, external_ref: { provider: "hubspot", id: "c-1" }, marketing_consent: null });
      expect(JSON.stringify(rows)).not.toMatch(/hook@example.com|秘密/);

      await getPool().query("delete from hook_deliveries");
      // 積まない変更
      await getPool().query("update customers set last_login_at = now(), session_epoch = session_epoch + 1, password_hash = '$2a$10$x' where id = $1", [created.id]);
      expect((await deliveries()).rows).toHaveLength(0);
      // 積む変更（住所）。購読している送信先だけ
      await rpc("api_customer_update", [token, created.id, { default_address: { state: "大阪府" } }]);
      rows = (await deliveries()).rows;
      expect(rows.map((r) => r.event)).toEqual(["customer.updated"]);
      expect(JSON.stringify(rows[0]!.payload)).not.toMatch(/大阪府/);
      // 同じ値で更新しても積まない
      await getPool().query("delete from hook_deliveries");
      await rpc("api_customer_update", [token, created.id, { default_address: { state: "大阪府" } }]);
      expect((await deliveries()).rows).toHaveLength(0);
      // 削除
      await rpc("api_customer_delete", [token, created.id]);
      rows = (await deliveries()).rows;
      expect(rows.map((r) => r.event)).toEqual(["customer.deleted"]);
      expect(rows[0]!.payload).toEqual({ customer_id: created.id, shop_id: a.shopId, external_ref: { provider: "hubspot", id: "c-1" }, marketing_consent: null });
    });

    it("初回のログイン（member_login_verify）と運営者の退会処理でも積む。他のショップの送信先には積まない", async () => {
      // 会員のログインの開始 → 照合で customers 行ができる（0012）
      const code = sha("code");
      const link = sha("link");
      const started = await rpc<{ send: boolean; challenge_id: string }>("member_login_start", [a.shopId, "first@example.com", code, link, null, null]);
      await rpc("member_login_verify", [a.shopId, started.challenge_id, code, null]);
      let rows = (await deliveries()).rows;
      expect(rows.map((r) => r.event)).toEqual(["customer.created", "customer.created"]);
      expect(JSON.stringify(rows)).not.toContain("first@example.com");
      await getPool().query("delete from hook_deliveries");
      // b のショップの会員は a の送信先に積まれない
      await rpc("api_customer_create", [bToken, { email: "b@example.com" }]);
      expect((await deliveries()).rows).toHaveLength(0);
      // 運営者が管理画面で削除（RLS の経路）
      const id = (await getPool().query<{ id: string }>("select id from customers where shop_id = $1 and email = 'first@example.com'", [a.shopId])).rows[0]!.id;
      await asUser(a.ownerId, (c) => c.query("delete from customers where shop_id = $1 and id = $2", [a.shopId, id]));
      rows = (await deliveries()).rows;
      expect(rows.map((r) => r.event)).toEqual(["customer.deleted"]);
    });
  });

  describe("attributes と external_ref", () => {
    it("定義にある鍵だけ。型を確かめ、null で消す。更新は渡した鍵だけ重ねる", async () => {
      const c = await rpc<{ id: string; attributes: Record<string, unknown> }>("api_customer_create", [token, { email: "attr@example.com", attributes: { rank: "gold", score: "12.5", memo: " 長い\nメモ ", site: "https://example.com" } }]);
      expect(c.attributes).toEqual({ rank: "gold", score: 12.5, memo: "長い\nメモ", site: "https://example.com" });
      expect(await expectDbError(() => rpc("api_customer_update", [token, c.id, { attributes: { unknown_key: "x" } }]))).toMatch(/invalid_attribute_unknown_key/);
      expect(await expectDbError(() => rpc("api_customer_update", [token, c.id, { attributes: { rank: "platinum" } }]))).toMatch(/invalid_attribute_rank/);
      expect(await expectDbError(() => rpc("api_customer_update", [token, c.id, { attributes: { score: "abc" } }]))).toMatch(/invalid_attribute_score/);
      expect(await expectDbError(() => rpc("api_customer_update", [token, c.id, { attributes: { site: "javascript:alert(1)" } }]))).toMatch(/invalid_attribute_site/);
      expect(await expectDbError(() => rpc("api_customer_update", [token, c.id, { attributes: { memo: "x".repeat(501) } }]))).toMatch(/invalid_attribute_memo/);
      expect(await expectDbError(() => rpc("api_customer_update", [token, c.id, { attributes: ["rank"] }]))).toMatch(/invalid_attributes/);
      // 失敗しても元のまま
      expect((await rpc<{ attributes: Record<string, unknown> }>("api_customer_get", [readToken, c.id])).attributes).toEqual({ rank: "gold", score: 12.5, memo: "長い\nメモ", site: "https://example.com" });
      // 渡した鍵だけ重ね、null で消す
      const up = await rpc<{ attributes: Record<string, unknown> }>("api_customer_update", [token, c.id, { attributes: { newsletter: "yes", score: null } }]);
      expect(up.attributes).toEqual({ rank: "gold", memo: "長い\nメモ", site: "https://example.com", newsletter: "yes" });
      // 定義の無いショップ（b）ではどの鍵も受け付けない
      expect(await expectDbError(() => rpc("api_customer_create", [bToken, { email: "b2@example.com", attributes: { rank: "gold" } }]))).toMatch(/invalid_attribute_rank/);
    });

    it("external_ref は provider と id の文字列だけ。ショップ × provider × id で一意、他のショップとは重なってよい。null で外す", async () => {
      const c1 = await rpc<{ id: string; external_ref: unknown }>("api_customer_create", [token, { email: "e1@example.com", external_ref: { provider: "hubspot", id: " 101 " } }]);
      expect(c1.external_ref).toEqual({ provider: "hubspot", id: "101" });
      expect(await expectDbError(() => rpc("api_customer_create", [token, { email: "e2@example.com", external_ref: { provider: "hubspot", id: "101" } }]))).toMatch(/external_ref_taken/);
      expect(await expectDbError(() => rpc("api_customer_create", [token, { email: "e2@example.com", external_ref: { provider: "HubSpot", id: "1" } }]))).toMatch(/invalid_external_ref/);
      expect(await expectDbError(() => rpc("api_customer_create", [token, { email: "e2@example.com", external_ref: { provider: "hubspot", id: "1", extra: 1 } }]))).toMatch(/invalid_external_ref/);
      expect(await expectDbError(() => rpc("api_customer_create", [token, { email: "e2@example.com", external_ref: "hubspot:1" }]))).toMatch(/invalid_external_ref/);
      expect(await expectDbError(() => rpc("api_customer_create", [token, { email: "e2@example.com", external_ref: { provider: "hubspot", id: "" } }]))).toMatch(/invalid_external_ref/);
      // 他のショップの同じ ID は別
      const bc = await rpc<{ external_ref: unknown }>("api_customer_create", [bToken, { email: "e1@example.com", external_ref: { provider: "hubspot", id: "101" } }]);
      expect(bc.external_ref).toEqual({ provider: "hubspot", id: "101" });
      // 絞り込み
      const list = await rpc<{ total: number; items: { id: string }[] }>("api_customers_list", [readToken, null, null, 50, 0, "hubspot", "101", null]);
      expect(list.items.map((x) => x.id)).toEqual([c1.id]);
      expect((await rpc<{ total: number }>("api_customers_list", [readToken, null, null, 50, 0, "hubspot", null, null])).total).toBe(1);
      expect((await rpc<{ total: number }>("api_customers_list", [readToken, null, null, 50, 0, "salesforce", null, null])).total).toBe(0);
      expect(await expectDbError(() => rpc("api_customers_list", [readToken, null, null, 50, 0, null, "101", null]))).toMatch(/invalid_external_ref/);
      // 外す → 同じ ID を別の会員に付けられる
      const c2 = await rpc<{ id: string }>("api_customer_create", [token, { email: "e2@example.com" }]);
      await rpc("api_customer_update", [token, c1.id, { external_ref: null }]);
      expect((await rpc<{ external_ref: unknown }>("api_customer_update", [token, c2.id, { external_ref: { provider: "hubspot", id: "101" } }])).external_ref).toEqual({ provider: "hubspot", id: "101" });
      // 直接の insert も制約で止まる
      expect(await expectDbError(() => getPool().query("insert into customers (shop_id, email, external_ref) values ($1, 'x@example.com', '{\"provider\": \"a b\", \"id\": \"1\"}')", [a.shopId]))).toMatch(/customers_external_ref_shape/);
    });

    it("updated_since: その時刻以後に変わった会員だけ、updated_at の昇順", async () => {
      // updated_at は更新のトリガーが now() にするので、insert で過去の時刻を入れる
      const c1 = (await getPool().query<{ id: string }>("insert into customers (shop_id, email, updated_at) values ($1, 'u1@example.com', now() - interval '2 hours') returning id", [a.shopId])).rows[0]!;
      const c2 = (await getPool().query<{ id: string }>("insert into customers (shop_id, email, updated_at) values ($1, 'u2@example.com', now() - interval '1 hour') returning id", [a.shopId])).rows[0]!;
      const since = new Date(Date.now() - 90 * 60 * 1000).toISOString();
      const list = await rpc<{ total: number; items: { id: string }[] }>("api_customers_list", [readToken, null, null, 50, 0, null, null, since]);
      expect(list.items.map((x) => x.id)).toEqual([c2.id]);
      await rpc("api_customer_update", [token, c1.id, { name: "変えた" }]);
      const again = await rpc<{ items: { id: string }[] }>("api_customers_list", [readToken, null, null, 50, 0, null, null, since]);
      expect(again.items.map((x) => x.id)).toEqual([c2.id, c1.id]);
    });
  });

  describe("api_customer_upsert", () => {
    it("無ければ作り（created: true）、あれば渡した鍵だけ更新（created: false）。email は変えない。書き込みのスコープが要る", async () => {
      const first = await rpc<{ id: string; created: boolean; name: string; attributes: Record<string, unknown> }>("api_customer_upsert", [token, { email: "Up@Example.com", name: "最初", attributes: { rank: "silver" }, external_ref: { provider: "hubspot", id: "u-1" } }]);
      expect(first.created).toBe(true);
      expect(first.name).toBe("最初");
      const second = await rpc<{ id: string; created: boolean; name: string; attributes: Record<string, unknown>; external_ref: unknown; email: string }>("api_customer_upsert", [token, { email: "up@example.com", attributes: { rank: "gold", newsletter: "no" } }]);
      expect(second.id).toBe(first.id);
      expect(second.created).toBe(false);
      expect(second.name).toBe("最初"); // 渡していない鍵はそのまま
      expect(second.attributes).toEqual({ rank: "gold", newsletter: "no" });
      expect(second.external_ref).toEqual({ provider: "hubspot", id: "u-1" });
      expect(second.email).toBe("up@example.com");
      expect((await getPool().query("select count(*)::int as n from customers where shop_id = $1", [a.shopId])).rows[0]!.n).toBe(1);
      // 外部でアドレスが変わった → 別の会員になろうとして、同じ external_ref があるので止まる（運営者が管理画面で変える）
      expect(await expectDbError(() => rpc("api_customer_upsert", [token, { email: "new-address@example.com", external_ref: { provider: "hubspot", id: "u-1" } }]))).toMatch(/external_ref_taken/);
      expect(await expectDbError(() => rpc("api_customer_upsert", [token, { email: "up@example.com", session_epoch: 9 }]))).toMatch(/invalid_field_session_epoch/);
      expect(await expectDbError(() => rpc("api_customer_upsert", [token, { email: "not-an-email" }]))).toMatch(/invalid_email/);
      expect(await expectDbError(() => rpc("api_customer_upsert", [readToken, { email: "up@example.com" }]))).toMatch(/unauthorized/);
      // 他のショップのトークンでは、そのショップに作られる
      const other = await rpc<{ created: boolean }>("api_customer_upsert", [bToken, { email: "up@example.com" }]);
      expect(other.created).toBe(true);
    });

    it("同じアドレスへの同時の upsert で 2 人にならない", async () => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => rpc<{ id: string; created: boolean }>("api_customer_upsert", [token, { email: "race@example.com", name: `n${i}` }])));
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
    });
  });

  describe("運営者が管理画面で独自項目を直す（0048 customer_set_attributes）", () => {
    it("項目 customers を持つ人だけ。渡した鍵だけ重ね、null で消す。定義に無い鍵・型違いは断る。他のショップの会員は触れない", async () => {
      const c1 = await rpc<{ id: string }>("api_customer_create", [token, { email: "adm@example.com", attributes: { rank: "silver", memo: "x" } }]);
      const set = (uid: string, shopId: string, id: string, values: unknown) =>
        asUser(uid, async (c) => (await c.query<{ r: Record<string, unknown> }>("select customer_set_attributes($1, $2, $3::jsonb) as r", [shopId, id, JSON.stringify(values)])).rows[0]!.r);
      expect(await set(a.ownerId, a.shopId, c1.id, { rank: "gold", memo: null, newsletter: "yes" })).toEqual({ rank: "gold", newsletter: "yes" });
      expect(await expectDbError(() => set(a.ownerId, a.shopId, c1.id, { nope: "x" }))).toMatch(/invalid_attribute_nope/);
      expect(await expectDbError(() => set(a.ownerId, a.shopId, c1.id, { rank: "platinum" }))).toMatch(/invalid_attribute_rank/);
      expect(await expectDbError(() => set(b.ownerId, a.shopId, c1.id, { rank: "gold" }))).toMatch(/shop_not_found|permission denied/);
      expect(await expectDbError(() => set(a.ownerId, a.shopId, b.shopId, { rank: "gold" }))).toMatch(/customer_not_found/);
      expect(await expectDbError(() => asAnon((c) => c.query("select customer_set_attributes($1, $2, '{}'::jsonb)", [a.shopId, c1.id])))).toMatch(/permission denied/);
      // 変更は hooks で知らせる（customer.updated）
      await getPool().query("delete from hook_deliveries");
      await set(a.ownerId, a.shopId, c1.id, { rank: "regular" });
      expect((await deliveries()).rows.map((r) => r.event)).toEqual(["customer.updated"]);
      // 運営者は customers を直接は更新できない（UPDATE のポリシーが無いので 0 行。値は変わらない）
      const direct = await asUser(a.ownerId, (c) => c.query("update customers set attributes = '{}' where id = $1", [c1.id]).then((r) => r.rowCount, (e: Error) => e.message));
      expect(direct === 0 || /permission denied/.test(String(direct))).toBe(true);
      expect((await getPool().query("select attributes from customers where id = $1", [c1.id])).rows[0]!.attributes).toEqual({ rank: "regular", newsletter: "yes" });
    });
  });

  describe("権限と復元", () => {
    it("anon / authenticated から新しい関数は呼べない。運営者は列を読める", async () => {
      for (const sql of ["select api_customer_upsert('x', '{}'::jsonb)", "select banto_customer_attributes(gen_random_uuid(), '{}'::jsonb)", "select restore_customer_master(gen_random_uuid(), '{}'::jsonb)"]) {
        expect(await expectDbError(() => asAnon((c) => c.query(sql)))).toMatch(/permission denied|service_role only/);
        expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query(sql)))).toMatch(/permission denied|service_role only/);
      }
      await rpc("api_customer_create", [token, { email: "owner-sees@example.com", attributes: { rank: "gold" }, external_ref: { provider: "hubspot", id: "o-1" } }]);
      const row = await asUser(a.ownerId, async (c) => (await c.query("select external_ref, attributes from customers where shop_id = $1", [a.shopId])).rows[0]);
      expect(row).toEqual({ external_ref: { provider: "hubspot", id: "o-1" }, attributes: { rank: "gold" } });
      await asUser(b.ownerId, async (c) => expect((await c.query("select count(*)::int as n from customers where shop_id = $1", [a.shopId])).rows[0]!.n).toBe(0));
    });

    it("restore_customer_master: id で突き合わせて external_ref と attributes を戻す。形の違う external_ref・重なるものは飛ばす", async () => {
      const c1 = await rpc<{ id: string }>("api_customer_create", [token, { email: "r1@example.com" }]);
      const c2 = await rpc<{ id: string }>("api_customer_create", [token, { email: "r2@example.com" }]);
      const c3 = await rpc<{ id: string }>("api_customer_create", [token, { email: "r3@example.com" }]);
      const counts = await rpc<{ customer_master: number }>("restore_customer_master", [
        a.shopId,
        {
          customers: [
            { id: c1.id, external_ref: { provider: "hubspot", id: "r-1" }, attributes: { rank: "gold" } },
            { id: c2.id, external_ref: { provider: "hubspot", id: "r-1" }, attributes: {} }, // 重なる → 飛ばす
            { id: c3.id, external_ref: "bad", attributes: { rank: "silver" } }, // 形が違う ref は外し、attributes だけ
            { id: "not-a-uuid", attributes: { rank: "gold" } },
            { id: b.shopId, attributes: { rank: "gold" } }, // 無い会員
          ],
        },
      ]);
      expect(counts).toEqual({ customer_master: 2 });
      const rows = (await getPool().query<{ email: string; external_ref: unknown; attributes: unknown }>("select email, external_ref, attributes from customers where shop_id = $1 order by email", [a.shopId])).rows;
      expect(rows).toEqual([
        { email: "r1@example.com", external_ref: { provider: "hubspot", id: "r-1" }, attributes: { rank: "gold" } },
        { email: "r2@example.com", external_ref: null, attributes: {} },
        { email: "r3@example.com", external_ref: null, attributes: { rank: "silver" } },
      ]);
    });
  });
});
