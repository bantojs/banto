import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { legacyKeyRole, supabaseHeaders, supabaseKeyKind, supabaseKeyMisplaced } from "../src/db/api-keys";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";

/** Supabase の新しい API キー（sb_publishable_ / sb_secret_）と今までの JWT のキー（src/db/api-keys.ts、docs/env.md「Supabase のキー」） */

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const legacy = (role: string) => `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${b64({ iss: "supabase", role })}.c2ln`;

describe("キーの形と見出し", () => {
  it("形を見分ける。今までのキーは payload の role を読む", () => {
    expect(supabaseKeyKind("sb_publishable_abc")).toBe("publishable");
    expect(supabaseKeyKind("sb_secret_abc")).toBe("secret");
    expect(supabaseKeyKind(legacy("anon"))).toBe("legacy");
    expect(supabaseKeyKind("anon-key")).toBe("unknown");
    expect(legacyKeyRole(legacy("service_role"))).toBe("service_role");
    expect(legacyKeyRole("eyJx.!!!.y")).toBeNull();
  });

  it("新しいキーは apikey だけ（ログインの JWT があれば Bearer に）、今までのキーは Bearer にも載せる", () => {
    expect(supabaseHeaders("sb_secret_abc")).toEqual({ apikey: "sb_secret_abc" });
    expect(supabaseHeaders("sb_publishable_abc", "user.jwt")).toEqual({ apikey: "sb_publishable_abc", Authorization: "Bearer user.jwt" });
    expect(supabaseHeaders(legacy("anon"))).toEqual({ apikey: legacy("anon"), Authorization: `Bearer ${legacy("anon")}` });
    expect(supabaseHeaders(legacy("anon"), "user.jwt")).toEqual({ apikey: legacy("anon"), Authorization: "Bearer user.jwt" });
  });

  it("取り違えに気づく（公開側に秘密のキー・秘密の欄に公開のキー）", () => {
    expect(supabaseKeyMisplaced("sb_publishable_a", "sb_secret_b")).toBeNull();
    expect(supabaseKeyMisplaced(legacy("anon"), legacy("service_role"))).toBeNull();
    expect(supabaseKeyMisplaced("sb_publishable_a", legacy("service_role"))).toBeNull();
    expect(supabaseKeyMisplaced("sb_secret_b", "sb_secret_b")).toBe("SUPABASE_ANON_KEY");
    expect(supabaseKeyMisplaced(legacy("service_role"), legacy("service_role"))).toBe("SUPABASE_ANON_KEY");
    expect(supabaseKeyMisplaced("sb_publishable_a", "sb_publishable_a")).toBe("SUPABASE_SERVICE_ROLE_KEY");
    expect(supabaseKeyMisplaced(legacy("anon"), legacy("anon"))).toBe("SUPABASE_SERVICE_ROLE_KEY");
  });
});

function setup(keys: { anonKey: string; serviceRoleKey: string }) {
  const sb = new FakeSupabase(keys);
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  sb.addSku(shop.id, String(tee["id"]), { code: "TEE", price_jpy: 3000, available: 5 });
  return { sb, owner, shop, app: appWith(sb, {}, new MemoryStorage(`${BASE}/media`)) };
}

describe("新しいキーで動く（Bearer に sb_ のキーを載せると入口が断る写し）", () => {
  it("お店の画面・運営者のログインと管理画面・AI 用 API（service_role の経路）", async () => {
    const { sb, owner, shop, app } = setup({ anonKey: "sb_publishable_test", serviceRoleKey: "sb_secret_test" });
    expect((await new Browser(app, BASE).get("/my-shop/products/tee")).status).toBe(200);
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect(await (await admin.get(`/admin/shops/${shop.id}/products`)).text()).toContain("Tシャツ");
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: "tok-1", shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes: ["products:read"], expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    const res = await app.request(`${BASE}/api/v1/products`, { headers: { authorization: `Bearer ${raw}` } });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain("tee");
  });

  it("今までのキーもそのまま動く", async () => {
    const { app, shop } = setup({ anonKey: legacy("anon"), serviceRoleKey: legacy("service_role") });
    expect((await new Browser(app, BASE).get("/my-shop/products/tee")).status).toBe(200);
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect((await admin.get(`/admin/shops/${shop.id}/products`)).status).toBe(200);
  });

  it("公開側に秘密のキーがあると動かさず、管理画面はセットアップの画面で直し方を出す", async () => {
    const { app } = setup({ anonKey: "sb_secret_test", serviceRoleKey: "sb_secret_test" });
    const b = new Browser(app, BASE);
    expect((await b.get("/my-shop/products/tee")).status).toBe(500);
    const login = await b.post("/admin/login", { email: "owner@example.com", password: "password-123" });
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/admin/setup");
    const html = await (await b.get("/admin/setup")).text();
    expect(html).toContain("取り違え");
    expect(html).toContain("秘密のキー（sb_secret_ か service_role）が入っています");
  });
});
