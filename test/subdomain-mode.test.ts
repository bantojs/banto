import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, memoryAdapters } from "./helpers";
import { createApp } from "../src/app";
import type { DomainAdapter, DomainAttachResult, DomainState } from "../src/adapters/types";
import { domainTemplateFrom, isTemplateDomain, parseDomainTemplate, templateDomain, templateSlug } from "../src/storefront/subdomain";

/**
 * サブドメインモード（SHOP_DOMAIN_TEMPLATE、src/storefront/subdomain.ts、docs/custom-domain.md §7）。
 * ショップを作ったときにひな形からドメインを決め、ひな形に合うホストはスラッグで引き、どのショップにも結ばれていないホストは 404。
 */

const TEMPLATE = "{slug}.shops.example.jp";

class FakeDomains implements DomainAdapter {
  calls: string[] = [];
  async attach(domain: string, shop: { slug: string }): Promise<DomainAttachResult> {
    this.calls.push(`attach:${domain}:${shop.slug}`);
    return { ok: true, state: { status: "active" } };
  }
  async detach(domain: string, shop: { slug: string }): Promise<void> {
    this.calls.push(`detach:${domain}:${shop.slug}`);
  }
  async status(domain: string): Promise<DomainState | null> {
    this.calls.push(`status:${domain}`);
    return { status: "active" };
  }
}

function setup(opts: { template?: string | null; domain?: string | null; provider?: boolean } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const template = opts.template === undefined ? TEMPLATE : opts.template;
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "マイショップ",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    domain: opts.domain === undefined ? "my-shop.shops.example.jp" : opts.domain,
  });
  const p = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  sb.addSku(shop.id, p.id, { code: "A", price_jpy: 1000, available: 3 });
  const domains = new FakeDomains();
  const vars = {
    SUPABASE_URL: sb.url,
    SUPABASE_ANON_KEY: sb.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey,
    SESSION_SECRET: "test-session-secret",
    PUBLIC_BASE_URL: BASE,
    MEDIA_BASE_URL: `${BASE}/media`,
    ...(template ? { SHOP_DOMAIN_TEMPLATE: template } : {}),
  };
  const adapters = { ...memoryAdapters(vars), ...(opts.provider ? { domain: domains } : {}) };
  const app = createApp(() => adapters, { fetch: (input, init) => sb.fetch(input, init) });
  const row = () => sb.tables.shops.find((s) => s["id"] === shop.id)!;
  return { sb, shop, app, domains, row };
}

const at = (app: ReturnType<typeof setup>["app"], url: string, init?: RequestInit) => app.request(url, { redirect: "manual", ...init });

describe("ひな形（src/storefront/subdomain.ts）", () => {
  it("読める形は {slug} で始まり、後ろが . か - で始まるドメインのもの", () => {
    expect(parseDomainTemplate(TEMPLATE)).toEqual({ suffix: ".shops.example.jp", labelSuffix: "" });
    expect(parseDomainTemplate(" {SLUG}-Acme.Example.com ")).toEqual({ suffix: "-acme.example.com", labelSuffix: "-acme" });
    for (const bad of [undefined, "", "shop.example.jp", "x{slug}.example.jp", "{slug}example.jp", "{slug}.{slug}.example.jp", "{slug}-.example.jp", "{slug}-a", "{slug}.exa mple.jp"]) {
      expect(parseDomainTemplate(bad), String(bad)).toBeNull();
    }
  });

  it("スラッグからドメインを作る。DNS のラベルにできないものは作らない", () => {
    const tpl = parseDomainTemplate(TEMPLATE)!;
    expect(templateDomain(tpl, "my-shop")).toBe("my-shop.shops.example.jp");
    expect(templateDomain(tpl, "a".repeat(63))).toBe(`${"a".repeat(63)}.shops.example.jp`);
    for (const bad of ["abc-", "xn--abc", "ab--c", "", "Abc", "a_b", "a.b"]) expect(templateDomain(tpl, bad), bad).toBeNull();
    // スラッグと同じラベルに付く文字の分だけ、スラッグは短くなる
    const acme = parseDomainTemplate("{slug}-acme.example.com")!;
    expect(templateDomain(acme, "a".repeat(58))).toBe(`${"a".repeat(58)}-acme.example.com`);
    expect(templateDomain(acme, "a".repeat(59))).toBeNull();
  });

  it("ホストからスラッグを読む（ひな形どおりのものだけ）", () => {
    const tpl = parseDomainTemplate(TEMPLATE)!;
    expect(templateSlug(tpl, "my-shop.shops.example.jp")).toBe("my-shop");
    for (const host of ["shops.example.jp", ".shops.example.jp", "a.b.shops.example.jp", "abc-.shops.example.jp", "my-shop.example.jp", "my-shop.shops.example.jp.evil.com"]) expect(templateSlug(tpl, host), host).toBeNull();
    const acme = parseDomainTemplate("{slug}-acme.example.com")!;
    expect(templateSlug(acme, "foo-bar-acme.example.com")).toBe("foo-bar");
    expect(isTemplateDomain(tpl, { slug: "my-shop", domain: "my-shop.shops.example.jp" })).toBe(true);
    expect(isTemplateDomain(tpl, { slug: "my-shop", domain: "shop.example.jp" })).toBe(false);
    expect(isTemplateDomain(null, { slug: "my-shop", domain: "my-shop.shops.example.jp" })).toBe(false);
  });
});

describe("サブドメインモードのホストの振り分け", () => {
  it("ひな形のドメインのショップは、そのホストでお店になる", async () => {
    const { app } = setup();
    const res = await at(app, "https://my-shop.shops.example.jp/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Tシャツ");
  });

  it("どのショップにも結ばれていないホストは、どのパスも 404（管理画面・/mcp・/api/v1 を出さない）", async () => {
    const { app } = setup();
    for (const url of [
      "https://nobody.shops.example.jp/",
      "https://nobody.shops.example.jp/admin",
      "https://nobody.shops.example.jp/admin/login",
      "https://nobody.shops.example.jp/mcp",
      "https://nobody.shops.example.jp/api/v1/products",
      "https://nobody.shops.example.jp/api/shops/my-shop",
      "https://nobody.shops.example.jp/health",
      "https://unrelated.example.com/admin",
      "https://unrelated.example.com/my-shop",
    ]) {
      expect((await at(app, url)).status, url).toBe(404);
    }
    expect((await at(app, "https://nobody.shops.example.jp/admin/login", { method: "POST" })).status).toBe(404);
  });

  it("ショップのホストでは、管理画面と運営者の入口を今までどおり出さない", async () => {
    const { app } = setup();
    const admin = await at(app, "https://my-shop.shops.example.jp/admin");
    expect(admin.status).toBe(302);
    expect(admin.headers.get("location")).toBe(`${BASE}/admin`);
    for (const url of ["https://my-shop.shops.example.jp/mcp", "https://my-shop.shops.example.jp/api/v1/products", "https://my-shop.shops.example.jp/webhooks/stripe"]) {
      expect((await at(app, url)).status, url).toBe(404);
    }
  });

  it("独自ドメインに切り替えたショップのひな形のホストは、新しいドメインへ 302（GET だけ）", async () => {
    const { app } = setup({ domain: "shop.example.jp" });
    const res = await at(app, "https://my-shop.shops.example.jp/products/tee?x=1");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://shop.example.jp/products/tee?x=1");
    expect((await at(app, "https://my-shop.shops.example.jp/cart/add", { method: "POST" })).status).toBe(404);
    expect((await at(app, "https://shop.example.jp/")).status).toBe(200);
  });

  it("ドメインの無いショップのひな形のホストは 404（ひな形を当てるまでは Banto の URL のまま）", async () => {
    const { app } = setup({ domain: null });
    expect((await at(app, "https://my-shop.shops.example.jp/")).status).toBe(404);
    expect((await at(app, `${BASE}/my-shop`)).status).toBe(200);
  });

  it("管理画面の URL（PUBLIC_BASE_URL）が無ければ、ひな形は使わない", () => {
    const get = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] });
    expect(domainTemplateFrom(get({ SHOP_DOMAIN_TEMPLATE: TEMPLATE }))).toBeNull();
    expect(domainTemplateFrom(get({ SHOP_DOMAIN_TEMPLATE: TEMPLATE, PUBLIC_BASE_URL: BASE }))).not.toBeNull();
  });

  it("ひな形が無ければ、知らないホストは今までどおり Banto の URL と同じに通す", async () => {
    const { app } = setup({ template: null, domain: null });
    const res = await at(app, "https://unrelated.example.com/admin/login");
    expect(res.status).not.toBe(404);
  });
});

describe("管理画面: サブドメインモード", () => {
  it("セットアップのウィザードで作る 1 店目にも、ひな形のドメインが付く", async () => {
    const sb = new FakeSupabase();
    const app = appWith(sb, { SHOP_DOMAIN_TEMPLATE: TEMPLATE });
    const b = new Browser(app);
    await b.post("/admin/setup/owner", { email: "owner@example.com", password: "correct horse battery" });
    let res = await b.post("/admin/setup/shop", { name: "テスト商店", slug: "test-" });
    expect(res.headers.get("location")).toBe("/admin/setup?error=slug_domain_invalid");
    res = await b.post("/admin/setup/shop", { name: "テスト商店", slug: "test-shop" });
    expect(res.headers.get("location")).toBe("/admin");
    expect(sb.shops[0]).toMatchObject({ slug: "test-shop", domain: "test-shop.shops.example.jp" });
  });

  it("ショップを作るとひな形のドメインが付く。作れないスラッグは断る", async () => {
    const { app, sb } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    let res = await admin.post("/admin/shops", { name: "二号店", slug: "second" });
    expect(res.headers.get("location")).toMatch(/^\/admin\/shops\/[^/]+\?flash=saved$/);
    expect(sb.tables.shops.find((s) => s["slug"] === "second")!["domain"]).toBe("second.shops.example.jp");

    res = await admin.post("/admin/shops", { name: "三号店", slug: "third-" });
    expect(res.headers.get("location")).toBe("/admin?flash=slug_domain_invalid");
    expect(sb.tables.shops.some((s) => s["slug"] === "third-")).toBe(false);
  });

  it("ほかのショップが手で同じドメインを付けていたら、スラッグの重なりと分けて知らせる", async () => {
    const { app, shop, sb } = setup();
    sb.tables.shops.find((s) => s["id"] === shop.id)!["domain"] = "taken.shops.example.jp";
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const res = await admin.post("/admin/shops", { name: "重なる店", slug: "taken" });
    expect(res.headers.get("location")).toBe("/admin?flash=slug_domain_taken");
  });

  it("ドメインの欄を空にして保存すると、ひな形のドメインに戻す。ほかのスラッグのひな形のドメインは付けさせない", async () => {
    const { app, shop, row } = setup({ domain: "shop.example.jp" });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = await (await admin.get(`/admin/shops/${shop.id}/settings/domain`)).text();
    expect(page).toContain("my-shop.shops.example.jp");

    let res = await admin.post(`/admin/shops/${shop.id}/domain`, { domain: "" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/settings/domain?flash=domain_saved`);
    expect(row()["domain"]).toBe("my-shop.shops.example.jp");

    res = await admin.post(`/admin/shops/${shop.id}/domain`, { domain: "someone-else.shops.example.jp" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/settings/domain?flash=domain_invalid`);
    expect(row()["domain"]).toBe("my-shop.shops.example.jp");
  });

  it("ひな形のドメインは提供元（DomainAdapter）に登録しない。独自ドメインとの付け替えでは独自ドメインの分だけ呼ぶ", async () => {
    const { app, shop, row, domains } = setup({ provider: true });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    await admin.get(`/admin/shops/${shop.id}/settings/domain`);
    expect(domains.calls).toEqual([]);

    await admin.post(`/admin/shops/${shop.id}/domain`, { domain: "shop.example.jp" });
    expect(row()["domain"]).toBe("shop.example.jp");
    expect(domains.calls).toEqual(["attach:shop.example.jp:my-shop"]);

    domains.calls = [];
    await admin.post(`/admin/shops/${shop.id}/domain`, { domain: "" });
    expect(row()["domain"]).toBe("my-shop.shops.example.jp");
    expect(domains.calls).toEqual(["detach:shop.example.jp:my-shop"]);
  });

  it("スラッグを変えると、ひな形どおりのドメインも一緒に付け替える。独自ドメインは変えない", async () => {
    const { app, shop, row } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = await (await admin.get(`/admin/shops/${shop.id}`)).text();
    expect(page).toContain("スラッグを変えると、ショップのアドレス");

    const form = { name: "マイショップ", legal_notice: "a", privacy_policy: "b", return_policy: "c", published: "on" };
    let res = await admin.post(`/admin/shops/${shop.id}`, { ...form, slug: "renamed" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=saved`);
    expect(row()["slug"]).toBe("renamed");
    expect(row()["domain"]).toBe("renamed.shops.example.jp");

    res = await admin.post(`/admin/shops/${shop.id}`, { ...form, slug: "bad-" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=slug_domain_invalid`);
    expect(row()["slug"]).toBe("renamed");

    row()["domain"] = "shop.example.jp";
    await admin.post(`/admin/shops/${shop.id}`, { ...form, slug: "again" });
    expect(row()["slug"]).toBe("again");
    expect(row()["domain"]).toBe("shop.example.jp");
  });
});
