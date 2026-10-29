import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, externalHosts, memberMail } from "./helpers";
import { planLimitHit, planLimitOf } from "../src/plan/limits";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";

afterEach(() => externalHosts.clear());

/** プランの上限（0052）の Worker 側: 「超えた」の印を文言と API のエラーに直す。判定の本物は test/db/plan-limits.test.ts */
function setup(limits: Record<string, number>) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "main", name: "本店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  sb.siteSettings = { plan_limits: limits };
  const app = appWith(sb, { RESEND_API_KEY: "re_test" });
  return { sb, owner, shop, app };
}

describe("プランの上限（0052、Worker）", () => {
  it("planLimitHit / planLimitOf: DB の印を種類と上限に直す。関係ない文字列は null", () => {
    expect(planLimitHit("plan_limit_exceeded:products:1000")).toEqual({ kind: "products", limit: 1000 });
    expect(planLimitHit("plan_limit_exceeded:theme_versions:0")).toEqual({ kind: "theme_versions", limit: 0 });
    expect(planLimitHit("P0001: plan_limit_exceeded:members:5 (context)")).toEqual({ kind: "members", limit: 5 });
    expect(planLimitHit("plan_limit_exceeded:orders:1")).toBeNull();
    expect(planLimitHit("duplicate key")).toBeNull();
    expect(planLimitOf({ dbMessage: "plan_limit_exceeded:shops:2" })).toEqual({ kind: "shops", limit: 2 });
    expect(planLimitOf(new Error("plan_limit_exceeded:customers:9"))).toEqual({ kind: "customers", limit: 9 });
    expect(planLimitOf(null)).toBeNull();
  });

  it("/admin/site に上限と今の数が出る（読み取り専用）", async () => {
    const { app } = setup({ shops: 3, products: 100 });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = await (await admin.get("/admin/site")).text();
    expect(page).toContain("プランの上限");
    expect(page).toMatch(/ショップ<\/td>\s*<td>1<\/td>\s*<td>3<\/td>/);
    expect(page).toMatch(/商品<\/td>\s*<td>0<\/td>\s*<td>100<\/td>/);
    expect(page).toMatch(/会員<\/td>\s*<td>0<\/td>\s*<td>上限なし<\/td>/);
    expect(page).toContain("site_settings_set(&#39;plan_limits&#39;");
  });

  it("ショップの追加・商品の追加が上限で止まり、文言が出る", async () => {
    const { shop, app } = setup({ shops: 1, products: 1 });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const res = await admin.post("/admin/shops", { name: "2 号店", slug: "second" });
    expect(res.headers.get("location")).toBe("/admin?flash=plan_limit");
    expect(await (await admin.get("/admin?flash=plan_limit")).text()).toContain("ショップの数の上限に達しています");

    await admin.post(`/admin/shops/${shop.id}/products/new`, { name: "1 つ目", slug: "first" });
    const second = await admin.post(`/admin/shops/${shop.id}/products/new`, { name: "2 つ目", slug: "second" });
    expect(second.headers.get("location")).toBe(`/admin/shops/${shop.id}/products/new?flash=plan_limit`);
    expect(await (await admin.get(`/admin/shops/${shop.id}/products/new?flash=plan_limit`)).text()).toContain("商品の数の上限に達しています");
  });

  it("会員の初回ログイン（会員の作成）が上限で止まると、ログイン画面に文言を出す。API は 409 plan_limit_exceeded", async () => {
    const { sb, shop, app } = setup({ customers: 0 });
    sb.tables.shops.find((s) => s["id"] === shop.id)!["settings"] = { members_enabled: true };
    const mail = memberMail(sb, shop.id);
    const b = new Browser(app);
    await b.post("/main/account/login", { email: "new@example.com" });
    const res = await b.post("/main/account/code", { code: mail.code("new@example.com") });
    expect(res.headers.get("location")).toBe("/main/account/login?error=limit");
    expect(await (await b.get("/main/account/login?error=limit")).text()).toContain("新しい会員登録を受け付けていません");

    // ヘッドレス
    const start = await (await app.request(`${BASE}/api/shops/main/members/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "api@example.com" }) })).json();
    const verify = await app.request(`${BASE}/api/shops/main/members/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge_id: (start as { challenge_id: string }).challenge_id, code: mail.code("api@example.com") }) });
    expect(verify.status).toBe(409);
    expect(await verify.json()).toEqual({ error: "plan_limit_exceeded" });
  });

  it("AI 用 API の会員の作成は 409 plan_limit_exceeded", async () => {
    const { sb, owner, shop, app } = setup({ customers: 0 });
    const token = generateApiToken();
    sb.tables.api_tokens.push({ id: "tok-1", shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(token), prefix: tokenPrefix(token), scopes: ["customers:read", "customers:write"], expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    const res = await app.request(`${BASE}/api/v1/customers`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ email: "x@example.com" }) });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).toContain("plan_limit_exceeded");
    expect(body.error.message).toContain("0 customers");
  });

  it("組織の招待の受け入れが上限で止まると、受け入れ画面に文言を出す", async () => {
    const { sb, shop, app } = setup({ members: 1 });
    const mail = memberMail(sb, shop.id);
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const orgId = String(shop["org_id"]);
    await admin.post(`/admin/org/invite?org=${orgId}`, { email: "staff@example.com", role: "admin" });
    const b = new Browser(app);
    const token = new URL(mail.link("staff@example.com")).searchParams.get("token")!;
    const res = await b.post("/admin/invite", { token, password: "password-123" });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("組織のメンバーの数の上限に達している");
  });

  it("1 日のメールの上限（0053）: ログインのコードを送れないときの文言、API は 429、招待は画面の文言、/admin/site に今日の数", async () => {
    const { sb, shop, app } = setup({ mail_per_day: 1 });
    sb.tables.shops.find((s) => s["id"] === shop.id)!["settings"] = { members_enabled: true };
    const mail = memberMail(sb, shop.id);
    const b = new Browser(app);
    let res = await b.post("/main/account/login", { email: "one@example.com" });
    expect(res.headers.get("location")).toBe("/main/account/code");
    res = await b.post("/main/account/login", { email: "two@example.com" });
    expect(res.headers.get("location")).toBe("/main/account/login?error=mail_limit");
    expect(await (await b.get("/main/account/login?error=mail_limit")).text()).toContain("ログインのメールを送れません");
    expect(mail.sent).toHaveLength(1);

    const api = await app.request(`${BASE}/api/shops/main/members/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "three@example.com" }) });
    expect(api.status).toBe(429);
    expect(await api.json()).toEqual({ error: "plan_limit_exceeded" });

    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const orgId = String(shop["org_id"]);
    const inv = await admin.post(`/admin/org/invite?org=${orgId}`, { email: "staff@example.com", role: "admin" });
    expect(inv.headers.get("location")).toBe(`/admin/org?org=${orgId}&flash=plan_limit`);
    expect(await (await admin.get(`/admin/org?org=${orgId}&flash=plan_limit`)).text()).toContain("1 日に送れるメール");
    expect(await (await admin.get("/admin/site")).text()).toMatch(/今日のメール[^<]*<\/td>\s*<td>1<\/td>\s*<td>1<\/td>/);
  });
});
