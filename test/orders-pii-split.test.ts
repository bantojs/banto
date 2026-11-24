import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";

/** 購入者の個人情報のスコープを分ける（0173: orders:contact / orders:address）。DB の規則は test/db/orders-pii-split.test.ts */
function setup(opts: { migrations?: string[] } = {}) {
  const sb = new FakeSupabase(opts.migrations ? { appliedMigrations: opts.migrations } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "s", name: "分けるお店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const now = new Date().toISOString();
  sb.tables.orders.push({ id: "order-1", shop_id: shop.id, reservation_id: null, number: 1001, status: "paid", total_jpy: 6000, customer_email: "buyer@example.com", customer_name: "山田", shipping_address: { state: "東京都", line1: "秘密の住所", phone: "03-0000-0000", company: "秘密の会社" }, payment_provider: "stripe", payment_ref: "pi_1", shipped_at: null, created_at: now, updated_at: now });
  const app = appWith(sb);
  const issue = async (scopes: string[]) => {
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: `tok-${sb.tables.api_tokens.length + 1}`, shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    return raw;
  };
  return { sb, shop, app, issue };
}

type Listing = { items: { customer: Record<string, unknown> }[]; pii: boolean; pii_parts?: Record<string, boolean> };
const orders = async (app: ReturnType<typeof appWith>, token: string) =>
  (await (await app.request(`${BASE}/api/v1/orders`, { headers: { authorization: `Bearer ${token}` } })).json()) as Listing;

describe("REST /api/v1/orders", () => {
  it("orders:contact は氏名・メール・電話、orders:address は氏名・住所（電話なし）、両方か orders:pii で全部", async () => {
    const { app, issue } = setup();
    let body = await orders(app, await issue(["orders:read", "orders:contact"]));
    expect(body.items[0]!.customer).toEqual({ name: "山田", email: "buyer@example.com", phone: "03-0000-0000", prefecture: "東京都" });
    expect(JSON.stringify(body)).not.toContain("秘密の住所");
    expect(body.pii_parts).toEqual({ contact: true, address: false, note: false });

    body = await orders(app, await issue(["orders:read", "orders:address"]));
    expect(body.items[0]!.customer).toEqual({ name: "山田", shipping_address: { state: "東京都", line1: "秘密の住所" } });
    expect(JSON.stringify(body)).not.toContain("buyer@example.com");
    expect(JSON.stringify(body)).not.toContain("03-0000-0000");
    expect(JSON.stringify(body)).not.toContain("秘密の会社");

    body = await orders(app, await issue(["orders:read", "orders:contact", "orders:address"]));
    expect(body.items[0]!.customer).toMatchObject({ email: "buyer@example.com", name: "山田" });
    expect(body.pii).toBe(true);
    expect(body.pii_parts).toEqual({ contact: true, address: true, note: false });

    body = await orders(app, await issue(["orders:read", "orders:pii"]));
    expect(body.pii_parts).toEqual({ contact: true, address: true, note: true });
  });
});

describe("REST /api/v1/tryon-requests", () => {
  it("名前・メール・電話は orders:contact、名前は orders:address でも、自由記入は orders:pii だけ", async () => {
    const { sb, shop, app, issue } = setup();
    const store = { id: "store-1", org_id: shop["org_id"], name: "本店" };
    sb.tables.stores.push(store);
    sb.tables.tryon_requests.push({ id: "tr-1", shop_id: shop.id, store_id: store.id, number: 1, status: "requested", customer_email: "t@example.com", customer_name: "試着", customer_phone: "090-1111-1111", note: "自由記入", created_at: new Date().toISOString() });
    const get = async (scopes: string[]) => ((await (await app.request(`${BASE}/api/v1/tryon-requests/1`, { headers: { authorization: `Bearer ${await issue(["orders:read", ...scopes])}` } })).json()) as { customer?: Record<string, unknown> }).customer;
    expect(await get([])).toBeUndefined();
    expect(await get(["orders:contact"])).toEqual({ email: "t@example.com", phone: "090-1111-1111", name: "試着" });
    expect(await get(["orders:address"])).toEqual({ name: "試着" });
    expect(await get(["orders:pii"])).toEqual({ email: "t@example.com", phone: "090-1111-1111", name: "試着", note: "自由記入" });
  });
});

describe("発行の画面", () => {
  it("orders:contact・orders:address を選べる（個人情報の印つき）。0173 の前は出さない", async () => {
    const s = setup();
    const b = await Browser.loggedIn(s.app, "owner@example.com", "password-123");
    const html = await (await b.get(`/admin/shops/${s.shop.id}/tokens`)).text();
    expect(html).toContain('value="orders:contact"');
    expect(html).toContain('value="orders:address"');
    expect(html).toContain("氏名・メール・電話");
    expect(html).not.toMatch(/value="orders:contact" checked/);
    const old = setup({ migrations: BUNDLED_MIGRATIONS.filter((m) => m !== "0173_orders_pii_split") });
    const b2 = await Browser.loggedIn(old.app, "owner@example.com", "password-123");
    const oldHtml = await (await b2.get(`/admin/shops/${old.shop.id}/tokens`)).text();
    expect(oldHtml).not.toContain('value="orders:contact"');
    expect(oldHtml).not.toContain('value="orders:address"');
    expect(oldHtml).toContain('value="orders:pii"');
  });

  it("0173 の前の DB では新しいスコープを付けて発行できない", async () => {
    const form = "name=x&scopes=orders%3Aread&scopes=orders%3Acontact&expires_days=30";
    const cur = setup();
    const b1 = await Browser.loggedIn(cur.app, "owner@example.com", "password-123");
    await b1.postRaw(`/admin/shops/${cur.shop.id}/tokens`, form, "application/x-www-form-urlencoded");
    expect(cur.sb.tables.api_tokens.map((t) => t["scopes"])).toEqual([["orders:read", "orders:contact"]]);
    const old = setup({ migrations: BUNDLED_MIGRATIONS.filter((m) => m !== "0173_orders_pii_split") });
    const b = await Browser.loggedIn(old.app, "owner@example.com", "password-123");
    await b.postRaw(`/admin/shops/${old.shop.id}/tokens`, form, "application/x-www-form-urlencoded");
    expect(old.sb.tables.api_tokens.some((t) => (t["scopes"] as string[]).includes("orders:contact"))).toBe(false);
  });
});
