import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, appWith, memberMail } from "./helpers";
import { ipHash } from "../src/members/auth";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { canonicalIp, parseRelayIps } from "../src/commerce/checkout";
import { publicShopSettings } from "../src/storefront/data";

/**
 * 0033_relay_limits / 0034_relay_ips_private の Worker 側: 信頼する中継元（settings.headless.relay_ips、公開しない）から来た通信だけ X-Banto-Client-IP を購入者の IP として使う。
 * DB の判定（per_ip_per_hour・api_shop_update）は test/db/。ここは Worker が正しい IP を材料として渡すことを確かめる。
 */
const WP = "https://wp.example.com";
const RELAY = "198.51.100.1";
const SECRET = "test-session-secret";

function setup(headless: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) {
  const sb = new FakeSupabase();
  const stripe = new FakeStripe();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "S",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    stripe_account_id: "acct_connected",
    settings: { members_enabled: true, headless: { return_origins: [WP], ...headless }, ...settings },
  });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "T", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", price_jpy: 3000, available: 50 });
  const app = appWith(sb, { RESEND_API_KEY: "re_test" }, undefined, stripe);
  const api = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: WP, ...headers }, body: JSON.stringify(body) });
  /** 配送先を入れて quote を取り、確定まで。email は同じ人の上限（3）に当たらないように変える */
  const order = async (email: string, headers: Record<string, string>) => {
    const cart = (await (await api("/api/shops/my-shop/cart", { op: "add", sku_id: sku.id, qty: 1 })).json()) as { cart: string };
    const q = (await (await api("/api/shops/my-shop/checkout/quote", { cart: cart.cart, provider: "stripe", address: { ...ADDRESS, customer_email: email } })).json()) as { quote: string };
    return api("/api/shops/my-shop/checkout", { quote: q.quote }, headers);
  };
  return { sb, shop, sku, app, api, order, ownerId: owner.id };
}
const hashes = (sb: FakeSupabase) => sb.tables.reservations.map((r) => r["ip_hash"]);

describe("中継元の IP（0033）", () => {
  it("中継元から来た通信は X-Banto-Client-IP を購入者の IP にする。中継元でなければヘッダーは無視。申告が無い・形が違えば中継元の IP のまま", async () => {
    const { sb, order } = setup({ relay_ips: [RELAY] });
    expect((await order("a@example.com", { "cf-connecting-ip": RELAY, "x-banto-client-ip": "203.0.113.7" })).status).toBe(200);
    expect((await order("b@example.com", { "cf-connecting-ip": RELAY, "x-banto-client-ip": "203.0.113.8" })).status).toBe(200);
    // 中継元でない IP からの申告は無視して、その IP で数える
    expect((await order("c@example.com", { "cf-connecting-ip": "192.0.2.5", "x-banto-client-ip": "203.0.113.7" })).status).toBe(200);
    // 中継元が申告しなければ中継元の IP のまま数える（以前どおりサイト全体で 1 つ）。形が IP でない申告も同じ
    expect((await order("d@example.com", { "cf-connecting-ip": RELAY })).status).toBe(200);
    expect((await order("e@example.com", { "cf-connecting-ip": RELAY, "x-banto-client-ip": "not an ip" })).status).toBe(200);
    expect(hashes(sb)).toEqual([await ipHash(SECRET, "203.0.113.7"), await ipHash(SECRET, "203.0.113.8"), await ipHash(SECRET, "192.0.2.5"), await ipHash(SECRET, RELAY), await ipHash(SECRET, RELAY)]);
    // 中継元の一覧はお客様の画面に渡す公開の settings に含めない（0034。連携側のサーバーの素の IP）
    expect(publicShopSettings({ headless: { return_origins: [WP], relay_ips: [RELAY] } })).toEqual({ headless: { return_origins: [WP] } });
    expect(JSON.stringify(await (await sb.fetch(`${sb.url}/rest/v1/rpc/shop_public_get`, { method: "POST", headers: { apikey: sb.anonKey, "content-type": "application/json" }, body: JSON.stringify({ p_slug: "my-shop" }) })).json())).not.toContain(RELAY);
  });

  it("IPv6 は書き方が違っても同じ IP として一致する（RFC 5952 の省略形にそろえる）。IPv4 の先頭の 0 と IP でないものは落とす", () => {
    expect(canonicalIp("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
    expect(canonicalIp("2001:DB8::1")).toBe("2001:db8::1");
    expect(canonicalIp("2001:db8:0:0:1:0:0:1")).toBe("2001:db8::1:0:0:1");
    expect(canonicalIp("::1")).toBe("::1");
    expect(canonicalIp("::")).toBe("::");
    expect(canonicalIp("fe80::")).toBe("fe80::");
    expect(canonicalIp("::ffff:203.0.113.5")).toBe("::ffff:cb00:7105");
    expect(canonicalIp(" 203.0.113.5 ")).toBe("203.0.113.5");
    for (const bad of ["203.0.113.010", "256.1.1.1", "1.2.3", "2001:db8:::1", "2001:db8::1::2", "2001:db8::1%eth0", "2001:db8::12345", "[2001:db8::1]", "not an ip", ""]) expect(canonicalIp(bad), bad).toBeNull();
    expect(parseRelayIps("198.51.100.1\n 2001:0DB8:0000::0001 , nonsense\n198.51.100.1\n2001:db8::1")).toEqual(["198.51.100.1", "2001:db8::1"]);
  });

  it("保存されている中継元の IP が省略しない形でも、Cloudflare の省略形の送信元と一致する", async () => {
    const { sb, order } = setup({ relay_ips: ["2001:0db8:0000:0000::0001"] });
    expect((await order("a@example.com", { "cf-connecting-ip": "2001:db8::1", "x-banto-client-ip": "2001:0DB8::0002" })).status).toBe(200);
    expect(hashes(sb)).toEqual([await ipHash(SECRET, "2001:db8::2")]);
  });

  it("中継元を宣言しないと購入者全員が中継元の IP として数えられ、宣言すると購入者ごとに数える", async () => {
    const limited = setup({}, { checkout: { max_pending_per_ip: 2 } });
    const hdr = (ip: string) => ({ "cf-connecting-ip": RELAY, "x-banto-client-ip": ip });
    expect((await limited.order("a@example.com", hdr("203.0.113.1"))).status).toBe(200);
    expect((await limited.order("b@example.com", hdr("203.0.113.2"))).status).toBe(200);
    const third = await limited.order("c@example.com", hdr("203.0.113.3"));
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "too_many_reservations" });

    const declared = setup({ relay_ips: [RELAY] }, { checkout: { max_pending_per_ip: 2 } });
    for (const [email, ip] of [["a", "203.0.113.1"], ["b", "203.0.113.2"], ["c", "203.0.113.3"]]) expect((await declared.order(`${email}@example.com`, hdr(ip!))).status).toBe(200);
    expect(declared.sb.tables.reservations).toHaveLength(3);
  });

  it("会員のログインも同じ: 中継元からの申告した IP で数え、1 時間の回数はショップの設定（per_ip_per_hour）", async () => {
    const { sb, shop, api } = setup({ relay_ips: [RELAY] }, { members_login_limits: { per_ip_per_hour: 2 } });
    const mail = memberMail(sb, shop.id);
    try {
      const login = (email: string, ip: string) => api("/api/shops/my-shop/members/login", { email }, { "cf-connecting-ip": RELAY, "x-banto-client-ip": ip });
      expect((await login("m1@example.com", "203.0.113.1")).status).toBe(200);
      expect((await login("m2@example.com", "203.0.113.1")).status).toBe(200);
      expect((await login("m3@example.com", "203.0.113.1")).status).toBe(200); // 応答の形は同じ（送らないだけ）
      expect(mail.sent.map((m) => m.to)).toEqual(["m1@example.com", "m2@example.com"]);
      expect((await login("m4@example.com", "203.0.113.2")).status).toBe(200);
      expect(mail.sent).toHaveLength(3);
      expect(sb.memberChallenges.map((c) => c["ip_hash"])).toEqual([await ipHash(SECRET, "203.0.113.1"), await ipHash(SECRET, "203.0.113.1"), await ipHash(SECRET, "203.0.113.2")]);
    } finally {
      mail.dispose();
    }
  });

  it("管理画面: 中継元の IP と 2 つの上限を保存する（形の違う IP は落とす、範囲外は既定に戻す、ほかの settings は残る）", async () => {
    const { sb, shop, app } = setup({}, { checkout: { max_pending_per_customer: 5 } });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await admin.get(`/admin/shops/${shop.id}`)).text();
    expect(html).toContain('name="relay_ips"');
    expect(html).toContain('name="max_pending_per_ip"');
    let res = await admin.post(`/admin/shops/${shop.id}/headless`, { return_origins: WP, relay_ips: "198.51.100.1\n 2001:0DB8:0000::0001 , nonsense\n198.51.100.1", max_pending_per_ip: "40", login_per_ip_per_hour: "0" });
    expect(res.headers.get("location")).toContain("flash=headless_saved");
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({
      headless: { return_origins: [WP], relay_ips: ["198.51.100.1", "2001:db8::1"] },
      checkout: { max_pending_per_customer: 5, max_pending_per_ip: 40 },
      members_login_limits: { per_ip_per_hour: 30 },
    });
    // 0033 の欄を出していない古い画面（欄なし）で保存しても、中継元の宣言は消えない
    res = await admin.post(`/admin/shops/${shop.id}/headless`, { return_origins: WP });
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({ headless: { return_origins: [WP], relay_ips: ["198.51.100.1", "2001:db8::1"] }, checkout: { max_pending_per_ip: 40 } });
  });

  it("AI 用 API: shop_get に 2 つの上限が出て、shop:write で変えられる。範囲外は断る", async () => {
    const { sb, shop, app, ownerId } = setup();
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: "tok-1", shop_id: shop.id, owner_id: ownerId, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes: ["shop:read", "shop:write"], expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    const rest = (method: string, body?: unknown) =>
      app.request(`${BASE}/api/v1/shop`, { method, headers: { authorization: `Bearer ${raw}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(await (await rest("GET")).json()).toMatchObject({ max_pending_per_ip: 20, login_per_ip_per_hour: 30 });
    expect(await (await rest("PATCH", { max_pending_per_ip: 200, login_per_ip_per_hour: 500 })).json()).toMatchObject({ max_pending_per_ip: 200, login_per_ip_per_hour: 500 });
    expect(sb.tables.shops[0]!["settings"]).toMatchObject({ checkout: { max_pending_per_ip: 200 }, members_login_limits: { per_ip_per_hour: 500 } });
    expect((await rest("PATCH", { max_pending_per_ip: 0 })).status).toBeGreaterThanOrEqual(400);
  });

  it("AI 用 API: GET /relay-check は、この通信を Banto がどの IP として数えるかを返す（連携側のサーバーの接続テスト用）。shop:read が要る", async () => {
    const { sb, shop, app, ownerId } = setup({ relay_ips: [RELAY] });
    const token = async (scopes: string[]) => {
      const raw = generateApiToken();
      sb.tables.api_tokens.push({ id: `tok-${scopes.join("-")}`, shop_id: shop.id, owner_id: ownerId, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
      return raw;
    };
    const check = async (raw: string, headers: Record<string, string>) => {
      const res = await app.request(`${BASE}/api/v1/relay-check`, { headers: { authorization: `Bearer ${raw}`, ...headers } });
      return { status: res.status, body: (await res.json()) as Record<string, unknown>, cache: res.headers.get("cache-control") };
    };
    const ro = await token(["shop:read"]);
    let r = await check(ro, { "cf-connecting-ip": RELAY, "x-banto-client-ip": "203.0.113.7" });
    expect(r).toMatchObject({ status: 200, body: { ip: RELAY, forwarded_ip: "203.0.113.7", trusted_relay: true, effective_ip: "203.0.113.7" }, cache: "no-store" });
    r = await check(ro, { "cf-connecting-ip": "192.0.2.9", "x-banto-client-ip": "203.0.113.7" });
    expect(r.body).toEqual({ ip: "192.0.2.9", forwarded_ip: "203.0.113.7", trusted_relay: false, effective_ip: "192.0.2.9" });
    r = await check(ro, { "cf-connecting-ip": "192.0.2.9" });
    expect(r.body).toEqual({ ip: "192.0.2.9", forwarded_ip: null, trusted_relay: false, effective_ip: "192.0.2.9" });
    // 中継元でも申告が無ければそのまま
    r = await check(ro, { "cf-connecting-ip": RELAY });
    expect(r.body).toMatchObject({ trusted_relay: false, effective_ip: RELAY });
    expect((await check(await token(["products:read"]), { "cf-connecting-ip": RELAY })).status).toBe(401);
    expect((await check("nope", { "cf-connecting-ip": RELAY })).status).toBe(401);
  });

  it("AI 用 API: 0033 より前の DB は 2 つの上限を黙って捨てるので、409 migration_required で断る（ほかの項目も保存しない）", async () => {
    const { sb, shop, app, ownerId } = setup();
    sb.appliedMigrations = sb.appliedMigrations.filter((v) => v !== "0033_relay_limits"); // 版の一覧はキャッシュされるので最初の呼び出しの前に
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: "tok-1", shop_id: shop.id, owner_id: ownerId, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes: ["shop:read", "shop:write"], expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    const rest = (method: string, body?: unknown) =>
      app.request(`${BASE}/api/v1/shop`, { method, headers: { authorization: `Bearer ${raw}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const old = await rest("PATCH", { name: "新店名", login_per_ip_per_hour: 50 });
    expect(old.status).toBe(409);
    expect(((await old.json()) as { error: { code: string } }).error.code).toBe("migration_required");
    expect(sb.tables.shops[0]!["name"]).toBe("S");
    expect(await (await rest("GET")).json()).not.toHaveProperty("max_pending_per_ip");
    expect((await rest("PATCH", { name: "新店名" })).status).toBe(200);
  });
});
