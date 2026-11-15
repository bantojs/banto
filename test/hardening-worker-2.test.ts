import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith, memoryAdapters } from "./helpers";
import { createApp, bodyLimitFor } from "../src/app";
import { onShopDomain } from "../src/routes/storefront/domain";
import { carryShopDomainMark, markShopDomainRequest, shopDomainOfRequest } from "../src/routes/shop-domain-request";
import type { Ctx } from "../src/routes/common";
import type { DomainAdapter, DomainAttachResult, DomainState } from "../src/adapters/types";

/** 入口の守りの締め直し（ショップのドメインの判定・/media のキー・商品の画像の削除・独自ドメインの保存・本文の上限） */
function setup(storage?: MemoryStorage) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", domain: "shop.example.jp" });
  const other = sb.addShop(owner.id, { slug: "other", name: "ほかの店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", domain: "other.example.jp" });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const org = String(sb.tables.shops.find((s) => s["id"] === shop.id)!["org_id"]);
  const app = appWith(sb, {}, storage);
  const member = (a: ReturnType<typeof appWith>, email: string, perms: string[]) => {
    const u = sb.addUser(email, "password-123");
    sb.orgMembers.push({ org_id: org, user_id: u.id, role: "member", created_at: new Date().toISOString() });
    sb.orgMemberShops.push({ org_id: org, user_id: u.id, shop_id: shop.id, perms });
    return Browser.loggedIn(a, email, "password-123");
  };
  return { sb, shop, other, tee, app, member };
}

describe("ショップのドメインの判定", () => {
  it("運営者と連携の入口は、パスを符号化してもショップのドメインでは 404", async () => {
    const { app } = setup();
    for (const path of ["/api/v1/shop", "/api/%761/shop", "/api/v%31/shop", "/api/%761/products/%ff", "/%6dcp", "/%77ebhooks/stripe"]) {
      const res = await app.request(`https://shop.example.jp${path}`, { headers: { authorization: "Bearer banto_x" } });
      expect(res.status, path).toBe(404);
    }
  });

  it("Banto 自身のホストは、ショップの domain に入っていてもショップのドメインとして扱わない", () => {
    const ctx = (url: string) => ({ req: { url }, get: () => ({ config: { get: (k: string) => (k === "PUBLIC_BASE_URL" ? "https://banto.example.com" : undefined) } }) }) as unknown as Ctx;
    expect(onShopDomain(ctx("https://shop.example.jp/"), { domain: "shop.example.jp" })).toBe(true);
    expect(onShopDomain(ctx("https://banto.example.com/my-shop"), { domain: "banto.example.com" })).toBe(false);
    expect(onShopDomain(ctx("https://x.workers.dev/my-shop"), { domain: "x.workers.dev" })).toBe(false);
    expect(onShopDomain(ctx("https://shop.example.jp/"), { domain: null })).toBe(false);
  });
});

describe("/media のキー", () => {
  it("区切りを重ねたキー・バックスラッシュ・.type の添えのファイルは配らない", async () => {
    const storage = new MemoryStorage(`${BASE}/media`);
    const { app } = setup(storage);
    // ローカルの置き場は /themes/… を themes/… に畳んで読む。メモリの置き場ではその鍵に直接置いて同じ状況を作る
    await storage.put("/themes/s/v/assets/app.js", new TextEncoder().encode("x").buffer as ArrayBuffer, "text/javascript");
    await storage.put("products/a.webp", new TextEncoder().encode("x").buffer as ArrayBuffer, "image/webp");
    await storage.put("products/a.webp.type", new TextEncoder().encode("image/webp").buffer as ArrayBuffer, "text/plain");
    expect((await app.request(`${BASE}/media/products/a.webp`)).status).toBe(200);
    for (const path of ["/media//themes/s/v/assets/app.js", "/media/themes/s/v/assets/app.js", "/media/products//a.webp", "/media/products/a.webp.type", "/media/%5Cthemes/s/v/assets/app.js"]) {
      expect((await app.request(`${BASE}${path}`)).status, path).toBe(404);
    }
  });
});

describe("商品の画像・SKU の入口", () => {
  it("商品を扱えない人は、公開中の商品の画像を消せない（置き場のファイルも残る）。扱える人は消せる", async () => {
    const storage = new MemoryStorage(`${BASE}/media`);
    const { sb, shop, tee, app, member } = setup(storage);
    await storage.put("products/x.webp", new TextEncoder().encode("x").buffer as ArrayBuffer, "image/webp");
    sb.tables.product_images.push({ id: "img-a", shop_id: shop.id, product_id: tee.id, storage_key: "products/x.webp", thumb_key: null, width: null, height: null, sort_order: 0, alt: null, options: {}, variants: [] });
    const path = `/admin/shops/${shop.id}/products/${tee.id}/images/img-a`;
    const staff = await member(app, "orders@example.com", ["orders"]);
    for (const action of ["delete", "sort", "options"]) expect((await staff.post(`${path}/${action}`, { sort_order: "5" })).status, action).toBe(404);
    expect(storage.objects.has("products/x.webp")).toBe(true);
    expect(sb.tables.product_images).toHaveLength(1);
    const catalog = await member(app, "catalog@example.com", ["catalog"]);
    expect((await catalog.post(`${path}/delete`, {})).status).toBe(302);
    expect(storage.objects.has("products/x.webp")).toBe(false);
    expect(sb.tables.product_images).toHaveLength(0);
  });
});

class FakeDomains implements DomainAdapter {
  calls: string[] = [];
  async attach(domain: string, shop: { slug: string }): Promise<DomainAttachResult> {
    this.calls.push(`attach:${domain}:${shop.slug}`);
    return { ok: true, state: { status: "pending", instructions: [] } };
  }
  async detach(domain: string, shop: { slug: string }): Promise<void> {
    this.calls.push(`detach:${domain}:${shop.slug}`);
  }
  async status(): Promise<DomainState | null> {
    return null;
  }
}

describe("独自ドメインの保存と提供元", () => {
  it("ほかのショップが使っているドメインは、提供元に頼む前に断る。項目 settings だけの人には保存の入口を開けない", async () => {
    const { sb, shop, other, member } = setup();
    const domains = new FakeDomains();
    const adapters = { ...memoryAdapters({ SUPABASE_URL: sb.url, SUPABASE_ANON_KEY: sb.anonKey, SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey, SESSION_SECRET: "test-session-secret", PUBLIC_BASE_URL: BASE, MEDIA_BASE_URL: `${BASE}/media` }), domain: domains };
    const app = createApp(() => adapters, { fetch: (input, init) => sb.fetch(input, init) }) as ReturnType<typeof appWith>;
    const ownerB = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const res = await ownerB.post(`/admin/shops/${shop.id}/domain`, { domain: "other.example.jp" });
    expect(res.headers.get("location")).toContain("flash=domain_taken");
    const staff = await member(app, "settings@example.com", ["settings"]);
    expect((await staff.post(`/admin/shops/${shop.id}/domain`, { domain: "other.example.jp" })).status).toBe(404);
    expect((await staff.post(`/admin/shops/${shop.id}/domain`, { domain: "new.example.jp" })).status).toBe(404);
    // 提供元には何も頼んでいない（相手のショップの登録を取り消さない）
    expect(domains.calls).toEqual([]);
    expect(sb.tables.shops.find((s) => s["id"] === other.id)!["domain"]).toBe("other.example.jp");
  });
});

describe("本文の上限", () => {
  it("お店の画面のフォームは 2MB、お問い合わせは 20MB まで。超えたら読まずに 413。運営者の入口と Webhook は入口ごとの上限", async () => {
    expect(bodyLimitFor("/my-shop/account/login")).toBe(2 * 1024 * 1024);
    expect(bodyLimitFor("/account/login")).toBe(2 * 1024 * 1024);
    expect(bodyLimitFor("/api/shops/my-shop/inquiries/reply")).toBe(20 * 1024 * 1024);
    expect(bodyLimitFor("/my-shop/inquiries")).toBe(20 * 1024 * 1024);
    for (const p of ["/admin/shops/x/products", "/api/v1/themes", "/mcp", "/webhooks/stripe"]) expect(bodyLimitFor(p), p).toBeNull();
    // 運営者の入口でも、ログインの前に本文を読むものには掛ける
    for (const p of ["/admin/login", "/admin/invite", "/admin/setup/owner", "/admin/mfa"]) expect(bodyLimitFor(p), p).toBe(2 * 1024 * 1024);
    expect(bodyLimitFor("/administrator")).toBe(2 * 1024 * 1024);
    const { app } = setup();
    const big = `email=${"a".repeat(3 * 1024 * 1024)}`;
    const form = (url: string, headers: Record<string, string> = {}) => app.request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(url).origin, ...headers }, body: big });
    expect((await form(`${BASE}/other/account/login`)).status).toBe(413);
    expect((await form("https://shop.example.jp/account/login")).status).toBe(413);
    expect((await form(`${BASE}/admin/login`)).status).toBe(413);
    // 申告の無い（流しながら送る）本文も、読んだ分で止める
    const stream = new Blob([big]).stream();
    const res = await app.request(`${BASE}/other/account/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE }, body: stream, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
  });
});

describe("ショップのドメインの印", () => {
  it("本文の上限が要求を作り直しても、ショップのドメインとして振り分けた印は新しい要求に写る", () => {
    const a = new Request("https://shop.example.jp/x", { method: "POST", body: "a" });
    const b = new Request(a.url, { method: "POST", body: "a" });
    markShopDomainRequest(a, "shop.example.jp");
    carryShopDomainMark(a, b);
    expect(shopDomainOfRequest(b)).toBe("shop.example.jp");
    const c = new Request(a.url);
    carryShopDomainMark(new Request(a.url), c);
    expect(shopDomainOfRequest(c)).toBeNull();
  });
});
