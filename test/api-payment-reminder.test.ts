import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { openResumeToken } from "../src/commerce/payment-resume";

/** お支払いのお願いの中身を外部プラグインが読む口（0182、docs/ai-access.md）。本物の判定は test/db/payment-reminder-api.test.ts */

async function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const token = async (scopes: string[]) => {
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: `tok-${sb.tables.api_tokens.length + 1}`, shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    return raw;
  };
  const expires = new Date(Date.now() + 40 * 3600_000).toISOString();
  sb.tables.reservations.push({ id: "11111111-1111-4111-8111-111111111111", shop_id: shop.id, status: "pending", items: [{ sku_id: "sku-1", qty: 2, unit_price_jpy: 1500 }], shipping_jpy: 500, expires_at: expires, created_at: new Date(Date.now() - 25 * 3600_000).toISOString(), payment_session: { provider: "komoju", id: "ses_1" }, customer: { customer_email: "buyer@example.com", customer_name: "山田 太郎" } });
  const app = appWith(sb);
  const get = (raw: string, id = "11111111-1111-4111-8111-111111111111") => app.request(`${BASE}/api/v1/reservations/${id}/payment-reminder`, { headers: { authorization: `Bearer ${raw}` } });
  return { sb, shop, app, token, get, expires };
}

describe("GET /api/v1/reservations/{id}/payment-reminder（0182）", () => {
  it("orders:contact があれば宛先・お名前と、お支払いに進むリンク（同梱プラグインと同じ券）", async () => {
    const { app, token, get, shop } = await setup();
    const res = await get(await token(["orders:read", "orders:contact"]));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const b = (await res.json()) as Record<string, unknown>;
    expect(b).toMatchObject({ reservation_id: "11111111-1111-4111-8111-111111111111", total_jpy: 3500, email: "buyer@example.com", name: "山田 太郎", items: [{ qty: 2, unit_price_jpy: 1500 }], pay_until: expect.any(String) });
    expect(b).not.toHaveProperty("shop");
    expect(b).not.toHaveProperty("shop_id");
    const link = new URL(String(b["payment_link"]));
    expect(`${link.origin}${link.pathname}`).toBe(`${BASE}/my-shop/checkout/resume`);
    expect(await openResumeToken("test-session-secret", shop.id, link.searchParams.get("t")!)).toEqual({ reservationId: "11111111-1111-4111-8111-111111111111" });
    // リンクの先でお支払いに進む・取りやめるの画面が開く
    expect(await (await new Browser(app).get(`${link.pathname}${link.search}`)).text()).toContain("お支払いに進む");
  });

  it("orders:read だけなら宛先・お名前・リンクは返さない。スコープが無ければ 401 / 403、無い・払えない予約は 404", async () => {
    const { sb, token, get } = await setup();
    const b = (await (await get(await token(["orders:read"]))).json()) as Record<string, unknown>;
    expect(b).toMatchObject({ total_jpy: 3500 });
    expect(b).not.toHaveProperty("email");
    expect(b).not.toHaveProperty("name");
    expect(b).not.toHaveProperty("payment_link");
    expect((await get(await token(["products:read"]))).status).toBeGreaterThanOrEqual(401);
    const raw = await token(["orders:read", "orders:contact"]);
    expect((await get(raw, "not-a-uuid")).status).toBe(404);
    expect((await get(raw, "22222222-2222-4222-8222-222222222222")).status).toBe(404);
    sb.tables.reservations[0]!["status"] = "released";
    expect((await get(raw)).status).toBe(404);
  });
});
