import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
function makeToken() {
  const raw = `banto_${randomBytes(32).toString("base64url")}`;
  return { raw, hash: sha(raw) };
}

describe.skipIf(!dbAvailable)("お店で試着を AI 用トークン・会員から（0026_tryon_api）と発行者の確認", () => {
  let f: Fixture;
  let orgId: string;
  let store: string;
  let customer: string;
  const rpc = <T = unknown>(fn: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
  async function issue(uid: string, scopes: string[]) {
    const t = makeToken();
    await asUser(uid, (c) =>
      c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [f.shopId, uid, t.hash, t.raw.slice(0, 12), scopes]),
    );
    return t;
  }

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "ta@example.com", slug: "ta-shop", publish: true, stock: 5 });
    orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    store = (await asUser(f.ownerId, (c) => c.query<{ id: string }>('insert into stores (org_id, name, hours) values ($1, \'渋谷店\', \'{"1":[["10:00","20:00"]]}\') returning id', [orgId]))).rows[0]!
      .id;
    await asUser(f.ownerId, (c) => c.query("insert into shop_stores (shop_id, store_id) values ($1, $2)", [f.shopId, store]));
    customer = (await getPool().query<{ id: string }>("insert into customers (shop_id, email, name) values ($1, 'member@example.com', '会員') returning id", [f.shopId])).rows[0]!.id;
    const req = (cid: string | null) =>
      rpc("tryon_request", [
        f.shopId,
        store,
        JSON.stringify([{ sku_id: f.skuId, qty: 1 }]),
        JSON.stringify({ customer_email: "member@example.com", customer_name: "会員", customer_phone: "0312345678", customer_id: cid }),
        null,
      ]);
    await req(customer);
    await req(null);
  });
  afterAll(closePool);

  it("AI: orders:read で一覧と 1 件、連絡先は orders:pii のときだけ。orders:write で状態を進める（在庫は戻さない）", async () => {
    const read = await issue(f.ownerId, ["orders:read"]);
    const list = await rpc<{ items: Record<string, unknown>[]; total: number; pii: boolean }>("api_tryon_requests_list", [read.hash, null, null, 50, 0]);
    expect(list.total).toBe(2);
    expect(list.pii).toBe(false);
    expect(list.items[0]).toMatchObject({ number: 2, status: "requested", store_name: "渋谷店", items: [{ product_name: "Tシャツ", qty: 1 }] });
    expect(list.items[0]!["customer"]).toBeUndefined();
    const pii = await issue(f.ownerId, ["orders:read", "orders:pii", "orders:write"]);
    expect(await rpc("api_tryon_request_get", [pii.hash, 1])).toMatchObject({ number: 1, customer: { email: "member@example.com", phone: "0312345678" } });
    expect(await expectDbError(() => rpc("api_tryon_request_update", [read.hash, 1, "sent", null]))).toMatch(/unauthorized/);
    expect(await rpc("api_tryon_request_update", [pii.hash, 1, "ready", "2099-01-10"])).toMatchObject({ status: "ready", hold_until: "2099-01-10" });
    expect(await expectDbError(() => rpc("api_tryon_request_update", [pii.hash, 1, "sent", null]))).toMatch(/invalid_transition/);
    expect(await expectDbError(() => rpc("api_tryon_request_update", [pii.hash, 1, "expired", null]))).toMatch(/invalid_status/);
    expect(await expectDbError(() => rpc("api_tryon_request_get", [pii.hash, 99]))).toMatch(/not_found/);
    // 在庫を EC に戻す（orders:write、終わった申し込みだけ、1 回だけ）
    const stock = async () => (await getPool().query<{ available: number }>("select available from inventory where sku_id = $1", [f.skuId])).rows[0]!.available;
    expect(await expectDbError(() => rpc("api_tryon_request_restock", [pii.hash, 1]))).toMatch(/not_restockable/);
    expect(await expectDbError(() => rpc("api_tryon_request_restock", [read.hash, 1]))).toMatch(/unauthorized/);
    await rpc("api_tryon_request_update", [pii.hash, 1, "not_purchased", null]);
    const before = await stock();
    expect(await rpc("api_tryon_request_restock", [pii.hash, 1])).toMatchObject({ number: 1, restocked: true, restocked_skus: 1 });
    expect(await stock()).toBe(before + 1);
    expect(await rpc("api_tryon_request_restock", [pii.hash, 1])).toMatchObject({ restocked: true, restocked_skus: 0 });
    expect(await stock()).toBe(before + 1);
    await getPool().query("update tryon_requests set status = 'ready', restocked = false where shop_id = $1 and number = 1", [f.shopId]);
    // 実店舗の一覧は shop:read
    const shopRead = await issue(f.ownerId, ["shop:read"]);
    expect(await rpc<{ name: string; tryon: boolean }[]>("api_stores_list", [shopRead.hash])).toMatchObject([{ name: "渋谷店", tryon: true }]);
    expect(await expectDbError(() => rpc("api_stores_list", [read.hash]))).toMatch(/unauthorized/);
  });

  it("会員: 自分の申し込みだけ読め、取り置きが終わる前なら取り消せる。世代が違えば読めない", async () => {
    const mine = await rpc<{ number: number; status: string; store_name: string }[] | null>("member_tryon_requests", [f.shopId, customer, 0]);
    expect(mine!.map((r) => [r.number, r.status, r.store_name])).toEqual([[1, "ready", "渋谷店"]]);
    expect(await rpc("member_tryon_requests", [f.shopId, customer, 5])).toBeNull();
    expect(await rpc("member_tryon_cancel", [f.shopId, customer, 0, 2])).toEqual({ ok: false, reason: "not_found" }); // ゲストの申し込み
    expect(await rpc("member_tryon_cancel", [f.shopId, customer, 5, 1])).toEqual({ ok: false, reason: "session" });
    expect(await rpc("member_tryon_cancel", [f.shopId, customer, 0, 1])).toEqual({ ok: true });
    expect(await rpc("member_tryon_cancel", [f.shopId, customer, 0, 1])).toEqual({ ok: false, reason: "not_cancellable" });
    expect((await getPool().query("select status from tryon_requests where shop_id = $1 and number = 1", [f.shopId])).rows[0]).toEqual({ status: "cancelled" });
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select member_tryon_requests($1, $2, 0)", [f.shopId, customer])))).toMatch(/permission denied/);
  });

  it("AI 用トークンは、発行した人が integrations の項目を持つ間だけ使える（メンバーを外す・項目を外すと使えない）", async () => {
    const staff = await createAuthUser("ta-staff@example.com");
    await asUser(f.ownerId, (c) =>
      c.query("select org_invite($1, 'ta-staff@example.com', 'member', $2::jsonb, $3)", [orgId, JSON.stringify([{ shop_id: f.shopId, perms: ["integrations", "orders"] }]), sha("inv")]),
    );
    await withRole("authenticated", { sub: staff, email: "ta-staff@example.com" }, (c) => c.query("select org_invitation_accept($1)", [sha("inv")]));
    const t = await issue(staff, ["orders:read"]);
    expect((await rpc<{ total: number }>("api_tryon_requests_list", [t.hash, null, null, 50, 0])).total).toBe(2);
    expect(await rpc("api_has_scope", [t.hash, "orders:read"])).toBe(true);
    await asUser(f.ownerId, (c) => c.query("select org_member_set($1, $2, 'member', $3::jsonb)", [orgId, staff, JSON.stringify([{ shop_id: f.shopId, perms: ["orders"] }])]));
    expect(await expectDbError(() => rpc("api_tryon_requests_list", [t.hash, null, null, 50, 0]))).toMatch(/unauthorized/);
    expect(await rpc("api_has_scope", [t.hash, "orders:read"])).toBe(false);
    expect(await expectDbError(() => rpc("api_token_shop", [t.hash]))).toMatch(/unauthorized/);
    // integrations だけに戻すと、orders:read に対応する項目（orders）が無いので使えない（0028）
    await asUser(f.ownerId, (c) => c.query("select org_member_set($1, $2, 'member', $3::jsonb)", [orgId, staff, JSON.stringify([{ shop_id: f.shopId, perms: ["integrations"] }])]));
    expect(await rpc("api_has_scope", [t.hash, "orders:read"])).toBe(false);
    await asUser(f.ownerId, (c) => c.query("select org_member_set($1, $2, 'member', $3::jsonb)", [orgId, staff, JSON.stringify([{ shop_id: f.shopId, perms: ["integrations", "orders"] }])]));
    expect(await rpc("api_has_scope", [t.hash, "orders:read"])).toBe(true);
    await asUser(f.ownerId, (c) => c.query("select org_member_remove($1, $2)", [orgId, staff]));
    expect(await rpc("api_has_scope", [t.hash, "orders:read"])).toBe(false);
  });
});
