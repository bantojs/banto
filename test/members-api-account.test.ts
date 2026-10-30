import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, appWith, memberMail } from "./helpers";

/**
 * ヘッドレスの会員 API: 既定の住所・案内メールの同意・退会（会員ページと同じ操作を、会員本人の会員トークンで。メンテナの決定 2026-10-28）。
 * お店の画面を使わないショップでも、会員が自分で住所を直し、案内メールを選び、退会できるように
 */
let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

function setup(settings: Record<string, unknown> = { marketing_consent: true }) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { members_enabled: true, headless: { return_origins: ["https://wp.example.com"] }, storefront: { mode: "off", site_url: "https://wp.example.com/" }, ...settings } });
  const mail = memberMail(sb, shop.id);
  dispose = mail.dispose;
  const app = appWith(sb, { RESEND_API_KEY: "re_test" });
  const call = async (path: string, body?: unknown, token?: string) => {
    const res = await app.request(`${BASE}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin: "https://wp.example.com", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, headers: res.headers, json: (await res.json()) as Record<string, unknown> };
  };
  const login = async (email: string) => {
    const r = await call("/api/shops/my-shop/members/login", { email });
    const v = await call("/api/shops/my-shop/members/verify", { challenge_id: r.json["challenge_id"], code: mail.code(email) });
    return String(v.json["access_token"]);
  };
  return { sb, shop, call, login };
}

describe("ヘッドレスの会員 API: 住所・案内メール・退会", () => {
  it("既定の住所を保存し、me で読める（都道府県でない値は null）。トークンが無ければ 401", async () => {
    const { call, login, sb } = setup();
    const t = await login("m@example.com");
    expect((await call("/api/shops/my-shop/members/me", undefined, t)).json).toMatchObject({ email: "m@example.com", name: null, address: null, marketing_consent: null });
    const r = await call("/api/shops/my-shop/members/address", { customer_name: " 山田 花子 ", phone: "0312345678", postal_code: "100-0001", state: "東京都", city: "千代田区", line1: "千代田1-1", line2: "" }, t);
    expect(r).toMatchObject({ status: 200, json: { ok: true, name: "山田 花子", address: { state: "東京都", city: "千代田区", line2: null, country: "JP" } } });
    expect(sb.tables.customers[0]!["default_address"]).toMatchObject({ postal_code: "100-0001", line1: "千代田1-1" });
    expect((await call("/api/shops/my-shop/members/address", { customer_name: "x", state: "火星" }, t)).json["address"]).toMatchObject({ state: null });
    const me = await call("/api/shops/my-shop/members/me", undefined, t);
    expect(me.json).toMatchObject({ name: "x" });
    expect(me.headers.get("cache-control")).toBe("no-store");
    expect(me.headers.get("access-control-allow-origin")).toBe("https://wp.example.com");
    expect((await call("/api/shops/my-shop/members/address", { customer_name: "x" })).status).toBe(401);
  });

  it("案内メール: 会員本人のトークンで受け取る・受け取らないの両方を選べる。欄を使わないショップでは 404", async () => {
    const { call, login, sb } = setup();
    const t = await login("m@example.com");
    expect(await call("/api/shops/my-shop/members/marketing-consent", { consent: true }, t)).toMatchObject({ status: 200, json: { marketing_consent: true } });
    expect(sb.tables.customers[0]!["marketing_consent"]).toBe(true);
    expect((await call("/api/shops/my-shop/members/me", undefined, t)).json["marketing_consent"]).toBe(true);
    await call("/api/shops/my-shop/members/marketing-consent", { consent: false }, t);
    expect(sb.tables.customers[0]!["marketing_consent"]).toBe(false);
    expect(await call("/api/shops/my-shop/members/marketing-consent", { consent: "yes" }, t)).toMatchObject({ status: 400, json: { error: "invalid_request" } });

    const off = setup({});
    const t2 = await off.login("n@example.com");
    expect(await off.call("/api/shops/my-shop/members/marketing-consent", { consent: true }, t2)).toMatchObject({ status: 404, json: { error: "consent_disabled" } });
    expect((await off.call("/api/shops/my-shop/members/me", undefined, t2)).json).not.toHaveProperty("marketing_consent");
  });

  it("退会: { confirm: true } が要る。退会したらそのトークンは使えない（注文は残る）", async () => {
    const { call, login, sb, shop } = setup();
    const t = await login("m@example.com");
    const cid = sb.tables.customers[0]!["id"];
    sb.tables.orders.push({ id: "o1", shop_id: shop.id, number: 1001, status: "paid", total_jpy: 1000, shipping_jpy: 0, customer_email: "m@example.com", customer_id: cid, created_at: "2026-10-20T00:00:00Z" });
    expect(await call("/api/shops/my-shop/members/withdraw", {}, t)).toMatchObject({ status: 400, json: { error: "confirm_required" } });
    expect(sb.tables.customers).toHaveLength(1);
    expect(await call("/api/shops/my-shop/members/withdraw", { confirm: true }, t)).toMatchObject({ status: 200, json: { ok: true } });
    expect(sb.tables.customers).toHaveLength(0);
    expect(sb.tables.orders).toHaveLength(1);
    expect((await call("/api/shops/my-shop/members/me", undefined, t)).status).toBe(401);
  });
});
