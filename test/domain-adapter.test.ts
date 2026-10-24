import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, memoryAdapters } from "./helpers";
import { createApp } from "../src/app";
import type { DomainAdapter, DomainAttachResult, DomainState } from "../src/adapters/types";

/**
 * 独自ドメインの提供元（DomainAdapter。ホスティングの提供者の Cloudflare for SaaS などが入る継ぎ目）。
 * 無いときの挙動（案内だけ・保存）は test/shop-domain.test.ts。ここは「あるとき」: 保存の前に attach、外した・変えたら detach、状態の表示。
 */
class FakeDomains implements DomainAdapter {
  calls: string[] = [];
  attachResult: DomainAttachResult = { ok: true, state: { status: "pending", instructions: [{ type: "cname", name: "shop.example.jp", value: "customers.hosting.example" }] } };
  state: DomainState | null = { status: "pending", instructions: [{ type: "cname", name: "shop.example.jp", value: "customers.hosting.example" }], message: "DNS を待っています" };
  async attach(domain: string, shop: { slug: string }): Promise<DomainAttachResult> {
    this.calls.push(`attach:${domain}:${shop.slug}`);
    return this.attachResult;
  }
  async detach(domain: string, shop: { slug: string }): Promise<void> {
    this.calls.push(`detach:${domain}:${shop.slug}`);
  }
  async status(domain: string): Promise<DomainState | null> {
    this.calls.push(`status:${domain}`);
    return this.state;
  }
}

function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "main", name: "本店", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  const domains = new FakeDomains();
  const adapters = { ...memoryAdapters({ SUPABASE_URL: sb.url, SUPABASE_ANON_KEY: sb.anonKey, SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey, SESSION_SECRET: "test-session-secret", PUBLIC_BASE_URL: BASE, MEDIA_BASE_URL: `${BASE}/media` }), domain: domains };
  const app = createApp(() => adapters, { fetch: (input, init) => sb.fetch(input, init) });
  return { sb, shop, domains, app };
}

describe("独自ドメインの提供元（DomainAdapter）", () => {
  it("保存の前に attach を呼び、通れば保存する。変えたら前のドメインを detach、外しても detach", async () => {
    const { sb, shop, domains, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    let res = await admin.post(`/admin/shops/${shop.id}/domain`, { domain: "shop.example.jp" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=domain_saved#domain`);
    expect(sb.tables.shops[0]!["domain"]).toBe("shop.example.jp");
    expect(domains.calls).toEqual(["attach:shop.example.jp:main"]);

    // 同じ値で保存し直しても提供元には聞かない
    domains.calls = [];
    await admin.post(`/admin/shops/${shop.id}/domain`, { domain: "shop.example.jp" });
    expect(domains.calls).toEqual([]);

    // 変える: 新しい方を attach、前の方を detach
    res = await admin.post(`/admin/shops/${shop.id}/domain`, { domain: "store.example.jp" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=domain_saved#domain`);
    expect(domains.calls).toEqual(["attach:store.example.jp:main", "detach:shop.example.jp:main"]);

    // 外す: attach は無し、detach だけ
    domains.calls = [];
    res = await admin.post(`/admin/shops/${shop.id}/domain`, { domain: "" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=domain_saved#domain`);
    expect(sb.tables.shops[0]!["domain"]).toBeNull();
    expect(domains.calls).toEqual(["detach:store.example.jp:main"]);
  });

  it("提供元が断れば保存しない（理由と文言）。提供元に届かなければ unavailable", async () => {
    const { sb, shop, domains, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    domains.attachResult = { ok: false, reason: "unverified", message: "TXT record not found" };
    let res = await admin.post(`/admin/shops/${shop.id}/domain`, { domain: "shop.example.jp" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=domain_unverified&detail=TXT%20record%20not%20found#domain`);
    expect(sb.tables.shops[0]!["domain"] ?? null).toBeNull();
    const page = await (await admin.get(`/admin/shops/${shop.id}?flash=domain_unverified&detail=TXT%20record%20not%20found`)).text();
    expect(page).toContain("所有を確かめられませんでした");
    expect(page).toContain("TXT record not found");

    domains.attachResult = { ok: false, reason: "taken" };
    res = await admin.post(`/admin/shops/${shop.id}/domain`, { domain: "shop.example.jp" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=domain_taken#domain`);

    domains.attach = async () => {
      throw new Error("boom");
    };
    res = await admin.post(`/admin/shops/${shop.id}/domain`, { domain: "shop.example.jp" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}?flash=domain_unavailable#domain`);
    expect(sb.tables.shops[0]!["domain"] ?? null).toBeNull();
  });

  it("設定画面: 提供元があれば手順の代わりに提供元の説明を出し、ドメインがあれば状態と DNS の指示を出す", async () => {
    const { sb, shop, domains, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    let page = await (await admin.get(`/admin/shops/${shop.id}`)).text();
    expect(page).toContain("このサービスがドメインの登録と証明書を扱います");
    expect(page).not.toContain("「カスタムドメイン」として追加します");
    expect(domains.calls).toEqual([]); // ドメインが無ければ聞かない

    sb.tables.shops[0]!["domain"] = "shop.example.jp";
    page = await (await admin.get(`/admin/shops/${shop.id}`)).text();
    expect(domains.calls).toEqual(["status:shop.example.jp"]);
    expect(page).toContain("DNS の設定か確認の待ちです。 DNS を待っています");
    expect(page).toContain("<td>CNAME</td>");
    expect(page).toContain("customers.hosting.example");

    domains.state = { status: "active" };
    page = await (await admin.get(`/admin/shops/${shop.id}`)).text();
    expect(page).toContain("提供元で有効です。");
    expect(page).not.toContain("<td>CNAME</td>");

    // 提供元が落ちていても画面は出る
    domains.status = async () => {
      throw new Error("down");
    };
    page = await (await admin.get(`/admin/shops/${shop.id}`)).text();
    expect(page).toContain("独自ドメイン");
    expect(page).not.toContain("提供元で有効です。");
  });
});
