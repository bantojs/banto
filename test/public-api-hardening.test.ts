import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { BASE, Browser, MemoryStorage, WEBHOOK_SECRET, appWith, checkout, externalHosts, memberLogin, memberMail, memoryAdapters } from "./helpers";
import { createApp } from "../src/app";
import { memoryRateLimit } from "../src/adapters/rate-limit";
import { fetchLatestRelease, RELEASES_PAGE } from "../src/updates/releases";
import type { CacheAdapter } from "../src/adapters/types";

/**
 * 公開 API と入口の守り:
 * - 公開 API（/api/shops/...）の JSON の本文は 64 KiB まで（超えると 413）
 * - メモリの回数制限は、鍵があふれても全員の窓を消さない（古い順に必要な数だけ）
 * - TRUSTED_PROXY_HOPS が X-Forwarded-For の要素より多ければ IP を取らない（先頭の値を信じない）
 * - 二段階認証の登録の確かめは、6 桁を求められている途中では受け付けない
 * - WooCommerce の元の画像の中継（GET）は、ほかのサイトからの遷移では動かない
 * - Connect の別アカウントからのイベントはログに残す
 * - 最新リリースのリンクは Banto のリリースの URL だけ
 * - 独自ドメインの保存には PUBLIC_BASE_URL が要る
 * - お店の行動の中継は Node では publicFetch を通る
 */
afterEach(() => {
  externalHosts.clear();
  vi.restoreAllMocks();
});

function shopSetup(settings: Record<string, unknown> = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", stripe_account_id: "acct_connected", settings: { members_enabled: true, ...settings } });
  const p = sb.addProduct(shop.id, { slug: "tee", name: "T", published: true });
  const sku = sb.addSku(shop.id, p.id, { code: "TEE", price_jpy: 3000, available: 5 });
  return { sb, owner, shop, p, sku };
}

describe("公開 API の本文の上限", () => {
  it("カート・会員のログイン・お問い合わせ・注文照会・試着の POST は 64 KiB を超えると 413。収まれば今までどおり", async () => {
    const { sb, sku } = shopSetup({ modules: { inquiries: true, store_tryon: true } });
    const app = appWith(sb, { RESEND_API_KEY: "re_test" });
    const big = JSON.stringify({ op: "add", sku_id: sku.id, qty: 1, pad: "x".repeat(64 * 1024) });
    const post = (path: string, body: string) => app.request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
    for (const path of ["/api/shops/my-shop/cart", "/api/shops/my-shop/members/login", "/api/shops/my-shop/inquiries", "/api/shops/my-shop/orders/lookup", "/api/shops/my-shop/tryon", "/api/shops/my-shop/checkout/quote"]) {
      const res = await post(path, big);
      expect(res.status, path).toBe(413);
      expect(await res.json()).toEqual({ error: "too_large" });
    }
    // 申告の長さが上限を超えていれば、本文を読まずに 413
    const declared = await app.request(`${BASE}/api/shops/my-shop/cart`, { method: "POST", headers: { "content-type": "application/json", "content-length": String(1024 * 1024) }, body: "{}" });
    expect(declared.status).toBe(413);
    const ok = await post("/api/shops/my-shop/cart", JSON.stringify({ op: "add", sku_id: sku.id, qty: 1 }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { count: number }).count).toBe(1);
    // 壊れた JSON は今までどおり 400 か空（413 ではない）
    expect((await post("/api/shops/my-shop/tryon", "not json")).status).toBe(400);
  });
});

describe("メモリの回数制限", () => {
  it("鍵が上限（10,000）に達しても、期限内の窓は古い順に必要な数だけ消え、全部は消えない", async () => {
    let t = 1_000_000;
    const limiter = memoryRateLimit(() => t);
    // 被害者の窓を使い切る
    for (let i = 0; i < 3; i++) expect(await limiter.hit("victim", 3, 60)).toBe(true);
    expect(await limiter.hit("victim", 3, 60)).toBe(false);
    // 攻撃者が 10,000 通りの鍵を送る（窓の中）
    t += 1000;
    for (let i = 0; i < 10_000; i++) await limiter.hit(`attacker-${i}`, 3, 60);
    // あふれたときに消えるのは古い順に必要な数（ここでは最初の 1 つ）だけ。ほかの窓は残る
    // （全部消す作りだと、鍵を大量に送った後はどの鍵も新しい窓で通ってしまう）
    expect(await limiter.hit("attacker-0", 1, 60)).toBe(false);
    expect(await limiter.hit("attacker-9998", 1, 60)).toBe(false);
    // 期限切れの窓は消して空きを作る（新しい鍵が入る）
    t += 61_000;
    expect(await limiter.hit("fresh", 3, 60)).toBe(true);
  });
});

describe("X-Forwarded-For と TRUSTED_PROXY_HOPS", () => {
  const start = async (app: ReturnType<typeof appWith>, xff: string) =>
    app.request(`${BASE}/api/shops/my-shop/members/login`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": xff }, body: JSON.stringify({ email: "m@example.com" }) });
  it("段数ちょうどなら末尾から数えた値、段数より要素が少なければ IP を取らない（先頭の依頼側の値を信じない）", async () => {
    const { sb, shop } = shopSetup();
    memberMail(sb, shop.id);
    const two = appWith(sb, { RESEND_API_KEY: "re_test", CLIENT_IP_HEADER: "x-forwarded-for", TRUSTED_PROXY_HOPS: "2" });
    expect((await start(two, "203.0.113.9, 198.51.100.1")).status).toBe(200);
    expect(sb.memberChallenges.at(-1)!["ip_hash"]).toBeTruthy();
    const three = appWith(sb, { RESEND_API_KEY: "re_test", CLIENT_IP_HEADER: "x-forwarded-for", TRUSTED_PROXY_HOPS: "3" });
    expect((await start(three, "6.6.6.6, 198.51.100.1")).status).toBe(200);
    expect(sb.memberChallenges.at(-1)!["ip_hash"]).toBeNull();
  });
});

describe("二段階認証の登録の確かめ", () => {
  it("6 桁を求められている途中（パスワードだけで入った状態）では、新しい認証アプリの登録を確かめられない", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    sb.addShop(owner.id, { slug: "main", name: "本店" });
    sb.addFactor(owner.id);
    const app = appWith(sb);
    const b = new Browser(app);
    expect((await b.post("/admin/login", { email: "owner@example.com", password: "password-123" })).headers.get("location")).toBe("/admin/mfa");
    const res = await b.post("/admin/mfa/setup/verify", { factor_id: "00000000-0000-4000-8000-000000000000", code: FakeSupabase.TOTP_CODE });
    expect(res.headers.get("location")).toBe("/admin/mfa");
    expect(sb.users.get(owner.id)!.factors).toHaveLength(1);
  });
});

describe("WooCommerce の元の画像の中継", () => {
  it("ほかのサイトからの遷移（Sec-Fetch-Site: cross-site）では 403。自分の画面からは動く", async () => {
    const { sb, shop } = shopSetup({ modules: { woo_import: true } });
    const app = appWith(sb);
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const path = `/admin/shops/${shop.id}/modules/woo-import/images/original?url=https://shop.example.com/a.jpg`;
    const cross = await admin.get(path, { "sec-fetch-site": "cross-site" });
    expect(cross.status).toBe(403);
    const other = await admin.get(path, { origin: "https://evil.example" });
    expect(other.status).toBe(403);
    externalHosts.set("https://shop.example.com/", () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]), { headers: { "content-type": "image/jpeg" } }));
    const same = await admin.get(path, { "sec-fetch-site": "same-origin" });
    expect(same.status).toBe(200);
  });
});

describe("Stripe Connect の別のアカウントからのイベント", () => {
  it("無視するだけでなく、イベント・ショップ・アカウントをログに残す（個人情報は載せない）", async () => {
    const { sb, sku } = shopSetup();
    const stripe = new FakeStripe();
    const app = appWith(sb, {}, undefined, stripe);
    const b = new Browser(app);
    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    await checkout(b, "/my-shop");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const [sessionId] = [...stripe.sessions.keys()];
    const ev = { ...stripe.event(sessionId!, "checkout.session.completed"), account: "acct_attacker" };
    const wh = await stripe.deliver(app, BASE, ev, WEBHOOK_SECRET);
    expect(await wh.json()).toMatchObject({ ignored: "wrong_account" });
    const line = spy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("wrong") || s.includes("account"))!;
    expect(line).toContain(ev.id);
    expect(line).toContain("acct_attacker");
    expect(line).toContain("acct_connected");
    expect(line).not.toContain("@");
  });
});

describe("最新リリースのリンク", () => {
  const cache = (): CacheAdapter => {
    const store = new Map<string, unknown>();
    return { get: async <T>(k: string) => (store.get(k) as T) ?? null, set: async (k, v) => void store.set(k, v), delete: async (k) => void store.delete(k) };
  };
  it("html_url が Banto のリポジトリの下でなければ、リリースの一覧の URL にする", async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ tag_name: "v9.9.9", html_url: "https://evil.example/phish" }), { status: 200 });
    expect(await fetchLatestRelease({ fetch: fetchImpl, cache: cache() })).toEqual({ version: "9.9.9", url: RELEASES_PAGE });
    const ok: typeof fetch = async () => new Response(JSON.stringify({ tag_name: "v9.9.9", html_url: "https://github.com/bantojs/banto/releases/tag/v9.9.9" }), { status: 200 });
    expect((await fetchLatestRelease({ fetch: ok, cache: cache() }))!.url).toBe("https://github.com/bantojs/banto/releases/tag/v9.9.9");
  });
});

describe("独自ドメインの保存", () => {
  it("PUBLIC_BASE_URL が無ければ保存せず、設定を促す", async () => {
    const { sb, shop } = shopSetup();
    const app = appWith(sb, { PUBLIC_BASE_URL: undefined });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const res = await admin.post(`/admin/shops/${shop.id}/domain`, { domain: "shop.example.jp" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=domain_needs_base_url#domain`);
    expect(sb.tables.shops[0]!["domain"] ?? null).toBeNull();
    expect(await (await admin.get(`/admin/shops/${shop.id}?flash=domain_needs_base_url`)).text()).toContain("PUBLIC_BASE_URL");
    // 外すのは PUBLIC_BASE_URL が無くてもできる
    const clear = await admin.post(`/admin/shops/${shop.id}/domain`, { domain: "" });
    expect(clear.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=domain_saved#domain`);
  });
});

describe("お店の行動の中継の送り先", () => {
  it("Node では publicFetch（引いた先を確かめる fetch）で送る", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { members_enabled: true, modules: { event_relay: true } } });
    const manifest = { name: "MA", events: [], settings: [], storefront_events: { types: ["product_view"], visitors: "members" } };
    sb.tables.hook_endpoints.push({ id: "ep-ma", shop_id: shop.id, name: "MA", url: "https://ma.example.com/hook", events: [], enabled: true, settings: {}, manifest, created_at: "", storefront_events: { types: ["product_view"], visitors: "members" } });
    const mail = memberMail(sb, shop.id);
    const vars = { SUPABASE_URL: sb.url, SUPABASE_ANON_KEY: sb.anonKey, SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey, SESSION_SECRET: "test-session-secret", PUBLIC_BASE_URL: BASE, MEDIA_BASE_URL: `${BASE}/media`, RESEND_API_KEY: "re_test" };
    const adapters = memoryAdapters(vars, new MemoryStorage(`${BASE}/media`));
    const sent: string[] = [];
    const plain: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://ma.example.com/")) {
        sent.push(`plain ${url}`);
        return Promise.resolve(new Response("ok"));
      }
      for (const [prefix, handler] of externalHosts) if (url.startsWith(prefix)) return Promise.resolve(handler(new Request(input, init)));
      return sb.fetch(input, init);
    };
    adapters.publicFetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      sent.push(`public ${url}`);
      return new Response("ok");
    };
    const app = createApp(() => adapters, { fetch: plain });
    const member = new Browser(app);
    await memberLogin(member, mail, "/my-shop", "m@example.com");
    const res = await member.postRaw("/my-shop/_x", JSON.stringify({ events: [{ type: "product_view", product_id: "p-1" }] }), "text/plain");
    expect(res.status).toBe(204);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual(["public https://ma.example.com/hook"]);
  });
});
