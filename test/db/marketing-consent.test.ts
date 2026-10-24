import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * 0050_marketing_consent: 「お得な情報やセールの案内を受け取る」の同意。
 * - レジの選択（予約の購入者情報）が注文の行に写り、会員なら customers にも写る（トリガー。confirm_reservation は触らない）
 * - 会員ページ（member_set_marketing_consent）は本人の行為なので true も false も。API は false だけ（true は consent_requires_person）
 * - 運営者は外せるだけ（customer_marketing_consent_withdraw）。hooks の customer.* に同意が載り、同意の変化でも customer.updated
 * - member_get と api_customer_json に同意が出る。api_customers_list で絞れる。復元で戻る
 */
describe.skipIf(!dbAvailable)("案内メールの同意（0050_marketing_consent）", () => {
  let a: Fixture;
  let b: Fixture;
  let token: string;
  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
  const items = (skuId: string, qty: number) => JSON.stringify([{ sku_id: skuId, qty }]);
  const consentOf = async (id: string) => (await getPool().query("select marketing_consent, marketing_consent_source from customers where id = $1", [id])).rows[0];

  async function checkout(shop: Fixture, customer: Record<string, unknown>) {
    const resId = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [shop.shopId, items(shop.skuId, 1)])).rows[0]!.id);
    await asService((c) => c.query("select attach_reservation_customer($1, $2, $3::jsonb)", [resId, shop.shopId, JSON.stringify({ customer_email: "x@example.com", customer_name: "x", shipping_address: {}, shipping_jpy: 0, ...customer })]));
    const orderId = await asService(async (c) => (await c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [resId, shop.shopId, JSON.stringify({ payment_provider: "stripe", payment_ref: `pi_${resId}` })])).rows[0]!.id);
    return (await getPool().query("select marketing_consent, customer_id from orders where id = $1", [orderId])).rows[0]!;
  }

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "mc-a@example.com", slug: "mc-a", publish: true, stock: 50 });
    b = await createShopFixture({ email: "mc-b@example.com", slug: "mc-b", publish: true, stock: 50 });
    await getPool().query(`update shops set settings = settings || '{"members_enabled": true, "marketing_consent": true}'::jsonb where id = $1`, [a.shopId]);
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    token = sha(raw);
    await asUser(a.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [a.shopId, a.ownerId, token, raw.slice(0, 12), ["customers:read", "customers:write"]]));
    await asUser(a.ownerId, (c) => c.query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'ma', 'https://ma.example/hook', $2)", [a.shopId, ["customer.created", "customer.updated"]]));
  });
  afterAll(closePool);
  beforeEach(() => getPool().query("delete from hook_deliveries"));

  it("レジの選択が注文に写る（ゲスト）。会員の注文なら customers にも写り、source は checkout。選ばなかったときは未回答のまま", async () => {
    expect(await checkout(a, { marketing_consent: true })).toMatchObject({ marketing_consent: true, customer_id: null });
    expect(await checkout(a, { marketing_consent: false })).toMatchObject({ marketing_consent: false });
    expect(await checkout(a, {})).toMatchObject({ marketing_consent: null });

    const memberId = (await rpc<{ id: string }>("api_customer_create", [token, { email: "member@example.com" }])).id;
    expect(await consentOf(memberId)).toEqual({ marketing_consent: null, marketing_consent_source: null });
    await getPool().query("delete from hook_deliveries");
    expect(await checkout(a, { marketing_consent: true, customer_id: memberId, customer_epoch: 0 })).toMatchObject({ marketing_consent: true, customer_id: memberId });
    expect(await consentOf(memberId)).toEqual({ marketing_consent: true, marketing_consent_source: "checkout" });
    // 同意の変化は customer.updated で知らせ、ペイロードに同意が載る（個人情報は無い）
    const rows = (await getPool().query<{ event: string; payload: Record<string, unknown> }>("select event, payload from hook_deliveries")).rows;
    expect(rows.map((r) => r.event)).toEqual(["customer.updated"]);
    expect(rows[0]!.payload).toEqual({ customer_id: memberId, shop_id: a.shopId, external_ref: null, marketing_consent: true });
    // 同じ値の注文では積まない。欄の無い注文（未回答）では会員の同意を変えない
    await getPool().query("delete from hook_deliveries");
    await checkout(a, { marketing_consent: true, customer_id: memberId, customer_epoch: 0 });
    await checkout(a, { customer_id: memberId, customer_epoch: 0 });
    expect((await getPool().query("select count(*)::int as n from hook_deliveries")).rows[0]!.n).toBe(0);
    expect(await consentOf(memberId)).toMatchObject({ marketing_consent: true });
  });

  it("会員ページは本人の行為（true も false も、世代を確かめる）。API は false だけ。運営者は外すだけ。anon からは呼べない", async () => {
    const id = (await rpc<{ id: string }>("api_customer_create", [token, { email: "self@example.com" }])).id;
    expect(await rpc("member_set_marketing_consent", [a.shopId, id, 0, true])).toBe(true);
    expect(await consentOf(id)).toEqual({ marketing_consent: true, marketing_consent_source: "account" });
    expect(await rpc("member_set_marketing_consent", [a.shopId, id, 9, false])).toBe(false); // 世代違い
    expect(await consentOf(id)).toMatchObject({ marketing_consent: true });
    expect(await expectDbError(() => rpc("member_set_marketing_consent", [a.shopId, id, 0, null]))).toMatch(/invalid_marketing_consent/);

    // API: 取り下げだけ
    expect(await expectDbError(() => rpc("api_customer_update", [token, id, { marketing_consent: true }]))).toMatch(/consent_requires_person/);
    expect(await expectDbError(() => rpc("api_customer_update", [token, id, { marketing_consent: "yes" }]))).toMatch(/invalid_marketing_consent/);
    const updated = await rpc<{ marketing_consent: boolean; marketing_consent_source: string }>("api_customer_update", [token, id, { marketing_consent: false }]);
    expect(updated).toMatchObject({ marketing_consent: false, marketing_consent_source: "api" });
    expect(await expectDbError(() => rpc("api_customer_upsert", [token, { email: "self@example.com", marketing_consent: true }]))).toMatch(/consent_requires_person/);
    const created = await rpc<{ marketing_consent: boolean; marketing_consent_source: string }>("api_customer_create", [token, { email: "new@example.com", marketing_consent: false }]);
    expect(created).toMatchObject({ marketing_consent: false, marketing_consent_source: "api" });
    expect((await rpc<{ marketing_consent: unknown }>("api_customer_create", [token, { email: "none@example.com" }])).marketing_consent).toBeNull();

    // 運営者: 外すだけ（付ける関数は無い）。他のショップの運営者は不可
    await rpc("member_set_marketing_consent", [a.shopId, id, 0, true]);
    expect(await asUser(a.ownerId, async (c) => (await c.query<{ r: boolean }>("select customer_marketing_consent_withdraw($1, $2) as r", [a.shopId, id])).rows[0]!.r)).toBe(true);
    expect(await consentOf(id)).toEqual({ marketing_consent: false, marketing_consent_source: "admin" });
    expect(await expectDbError(() => asUser(b.ownerId, (c) => c.query("select customer_marketing_consent_withdraw($1, $2)", [a.shopId, id])))).toMatch(/shop_not_found|permission denied/);
    expect(await expectDbError(() => asAnon((c) => c.query("select customer_marketing_consent_withdraw($1, $2)", [a.shopId, id])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asAnon((c) => c.query("select member_set_marketing_consent($1, $2, 0, true)", [a.shopId, id])))).toMatch(/permission denied/);
  });

  it("member_get と一覧に同意が出て、api_customers_list で絞れる。復元で同意も戻る", async () => {
    const yes = (await rpc<{ id: string }>("api_customer_create", [token, { email: "list-yes@example.com" }])).id;
    const no = (await rpc<{ id: string }>("api_customer_create", [token, { email: "list-no@example.com", marketing_consent: false }])).id;
    await rpc("member_set_marketing_consent", [a.shopId, yes, 0, true]);
    const me = await rpc<{ customer: { marketing_consent: boolean } }>("member_get", [a.shopId, yes, 0, false]);
    expect(me.customer.marketing_consent).toBe(true);
    const opted = await rpc<{ items: { id: string }[] }>("api_customers_list", [token, null, null, 100, 0, null, null, null, true]);
    expect(opted.items.map((x) => x.id)).toContain(yes);
    expect(opted.items.map((x) => x.id)).not.toContain(no);
    const out = await rpc<{ items: { id: string }[] }>("api_customers_list", [token, null, null, 100, 0, null, null, null, false]);
    expect(out.items.map((x) => x.id)).toContain(no);
    // 8 引数の呼び出しもそのまま動く（絞らない）
    const all = await rpc<{ total: number }>("api_customers_list", [token, null, null, 100, 0, null, null, null]);
    expect(all.total).toBeGreaterThanOrEqual(2);

    // 復元: id で突き合わせて同意・時刻・source を戻す。形の違う値は飛ばす
    const target = (await rpc<{ id: string }>("api_customer_create", [token, { email: "restore@example.com" }])).id;
    const counts = await rpc<{ customer_master: number }>("restore_customer_master", [a.shopId, { customers: [{ id: target, marketing_consent: true, marketing_consent_at: "2026-10-01T00:00:00Z", marketing_consent_source: "account" }, { id: yes, marketing_consent: "yes" }] }]);
    expect(counts).toEqual({ customer_master: 1 });
    expect((await getPool().query("select marketing_consent, marketing_consent_source, marketing_consent_at from customers where id = $1", [target])).rows[0]).toMatchObject({ marketing_consent: true, marketing_consent_source: "account" });
  });
});
