import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, externalHosts, memoryAdapters } from "./helpers";
import type { ScheduledJob } from "../src/adapters/types";
import { registerJobs } from "../src/jobs";
import { checkLegalUrl, legalLinksOf, parseLegalUrl } from "../src/storefront/legal-links";

/** 法務のページを連携サイトに向ける（0062、docs/headless.md「法務のページ」） */
const WP = "https://wp.example";

const html = (status = 200) => new Response("<html></html>", { status, headers: { "content-type": "text/html; charset=utf-8" } });

function setup(legalLinks: Record<string, unknown> | null = null, state: Record<string, unknown> = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const settings = { headless: { return_origins: [WP], ...(legalLinks ? { legal_links: legalLinks } : {}) } };
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "販売業者: テスト", privacy_policy: "p", return_policy: "r", settings });
  sb.tables.shops.find((s) => s["id"] === shop.id)!["legal_links_state"] = state;
  const app = appWith(sb);
  return { sb, shop, app };
}

afterEach(() => {
  externalHosts.delete(`${WP}/`);
});

describe("法務のページの外の URL（0062）", () => {
  it("入力は https で、決済後の戻り先として許可したサイトだけ。空は使わない", () => {
    expect(parseLegalUrl("", [WP])).toEqual({ ok: true, url: null });
    expect(parseLegalUrl(" https://wp.example/legal ", [WP])).toEqual({ ok: true, url: "https://wp.example/legal" });
    expect(parseLegalUrl("http://wp.example/legal", [WP])).toEqual({ ok: false, reason: "bad_url" });
    expect(parseLegalUrl("https://user:pw@wp.example/legal", [WP])).toEqual({ ok: false, reason: "bad_url" });
    expect(parseLegalUrl("https://evil.example/legal", [WP])).toEqual({ ok: false, reason: "origin_not_allowed" });
    expect(parseLegalUrl("javascript:alert(1)", [WP])).toEqual({ ok: false, reason: "bad_url" });
    // 間隔は 1・6・24・168 時間だけ。既定は 1 日
    expect(legalLinksOf({ headless: { legal_links: { legal: `${WP}/legal`, privacy: "http://x", check_hours: 5 } } })).toEqual({ urls: { legal: `${WP}/legal` }, check_hours: 24 });
    expect(legalLinksOf({ headless: { legal_links: { check_hours: 168 } } }).check_hours).toBe(168);
  });

  it("生きているか: 2xx の HTML だけ。リダイレクトは行き先ごとに確かめ、社内のアドレス・http・HTML でないもの・届かないものは落ちているとみなす", async () => {
    const pages: Record<string, () => Response> = {
      [`${WP}/ok`]: () => html(),
      [`${WP}/missing`]: () => html(404),
      [`${WP}/json`]: () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      [`${WP}/moved`]: () => new Response(null, { status: 301, headers: { location: "/ok" } }),
      [`${WP}/internal`]: () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/admin" } }),
      [`${WP}/plain`]: () => new Response(null, { status: 302, headers: { location: "http://wp.example/ok" } }),
      [`${WP}/loop`]: () => new Response(null, { status: 302, headers: { location: "/loop" } }),
    };
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      const page = pages[url];
      if (!page) throw new TypeError("network");
      return page();
    };
    expect(await checkLegalUrl(`${WP}/ok`, fetchImpl)).toBe(true);
    expect(await checkLegalUrl(`${WP}/moved`, fetchImpl)).toBe(true);
    expect(await checkLegalUrl(`${WP}/missing`, fetchImpl)).toBe(false);
    expect(await checkLegalUrl(`${WP}/json`, fetchImpl)).toBe(false);
    expect(await checkLegalUrl(`${WP}/internal`, fetchImpl)).toBe(false);
    expect(await checkLegalUrl(`${WP}/plain`, fetchImpl)).toBe(false);
    expect(await checkLegalUrl(`${WP}/loop`, fetchImpl)).toBe(false);
    expect(await checkLegalUrl(`${WP}/down`, fetchImpl)).toBe(false);
    expect(await checkLegalUrl("https://10.0.0.1/legal", fetchImpl)).toBe(false);
    // 社内のアドレスへは取りに行っていない
    expect(seen.some((u) => u.includes("127.0.0.1") || u.includes("10.0.0.1"))).toBe(false);
  });

  it("お店の画面: 最後の確認で生きていれば外のページへ 302、落ちている・設定が変わってまだ確かめていなければ Banto のページ", async () => {
    const links = { legal: `${WP}/legal`, privacy: `${WP}/privacy`, returns: `${WP}/returns-new`, check_hours: 24 };
    const at = new Date().toISOString();
    const { app } = setup(links, {
      legal: { url: `${WP}/legal`, ok: true, checked_at: at },
      privacy: { url: `${WP}/privacy`, ok: false, checked_at: at },
      returns: { url: `${WP}/returns-old`, ok: true, checked_at: at },
    });
    const legal = await app.request(`${BASE}/my-shop/legal`);
    expect(legal.status).toBe(302);
    expect(legal.headers.get("location")).toBe(`${WP}/legal`);
    const privacy = await app.request(`${BASE}/my-shop/privacy`);
    expect(privacy.status).toBe(200);
    expect(await privacy.text()).toContain("プライバシーポリシー");
    expect((await app.request(`${BASE}/my-shop/returns`)).status).toBe(200);
    // 公開 API は本文と、生きている外の URL だけを返す
    const api = (await (await app.request(`${BASE}/api/shops/my-shop`)).json()) as { shop: { legal_notice: string; legal_links: Record<string, string> } };
    expect(api.shop.legal_notice).toBe("販売業者: テスト");
    expect(api.shop.legal_links).toEqual({ legal: `${WP}/legal` });
  });

  it("管理画面: 許可したサイトの URL だけ保存でき、保存したときに確かめる。今すぐ確かめるで結果が変わる。戻り先から外したサイトの URL は外れる", async () => {
    const { sb, shop, app } = setup();
    let up = true;
    externalHosts.set(`${WP}/`, () => (up ? html() : html(503)));
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    let page = await (await b.get(`/admin/shops/${shop.id}`)).text();
    expect(page).toContain('id="legal-links"');
    expect(page).toContain("1 日に 1 回（既定）");

    // 許可していないサイトは断る
    let res = await b.post(`/admin/shops/${shop.id}/legal-links`, { url_legal: "https://evil.example/legal", url_privacy: "", url_returns: "", check_hours: "24" });
    expect(res.headers.get("location")).toContain("flash=legal_links_invalid");
    expect(legalLinksOf(sb.tables.shops[0]!["settings"] as Record<string, unknown>).urls).toEqual({});

    res = await b.post(`/admin/shops/${shop.id}/legal-links`, { url_legal: `${WP}/legal`, url_privacy: "", url_returns: `${WP}/returns`, check_hours: "6" });
    expect(res.headers.get("location")).toContain("flash=legal_links_saved");
    expect(legalLinksOf(sb.tables.shops[0]!["settings"] as Record<string, unknown>)).toEqual({ urls: { legal: `${WP}/legal`, returns: `${WP}/returns` }, check_hours: 6 });
    expect((await app.request(`${BASE}/my-shop/legal`)).headers.get("location")).toBe(`${WP}/legal`);
    page = await (await b.get(`/admin/shops/${shop.id}`)).text();
    expect(page).toContain("生きています");

    // 落ちたら、今すぐ確かめるで Banto のページに戻る
    up = false;
    res = await b.post(`/admin/shops/${shop.id}/legal-links/check`, {});
    expect(res.headers.get("location")).toContain("flash=legal_links_checked");
    expect((await app.request(`${BASE}/my-shop/legal`)).status).toBe(200);
    expect(await (await b.get(`/admin/shops/${shop.id}`)).text()).toContain("届きませんでした");

    // ヘッドレス連携の保存は法務の URL を残す。戻り先から外したサイトの URL だけ外れる
    await b.post(`/admin/shops/${shop.id}/headless`, { return_origins: WP, relay_ips: "" });
    expect(legalLinksOf(sb.tables.shops[0]!["settings"] as Record<string, unknown>).urls).toEqual({ legal: `${WP}/legal`, returns: `${WP}/returns` });
    await b.post(`/admin/shops/${shop.id}/headless`, { return_origins: "https://other.example", relay_ips: "" });
    expect(legalLinksOf(sb.tables.shops[0]!["settings"] as Record<string, unknown>).urls).toEqual({});
  });

  it("連携の項目（integrations）の無いスタッフには欄を出さず、保存も断る", async () => {
    const { sb, shop, app } = setup();
    const staff = sb.addUser("staff@example.com", "password-123");
    const orgId = String(sb.tables.shops[0]!["org_id"]);
    sb.orgMembers.push({ org_id: orgId, user_id: staff.id, role: "member", created_at: "2026-10-27T00:00:00Z" });
    sb.orgMemberShops.push({ org_id: orgId, user_id: staff.id, shop_id: shop.id, perms: ["settings"] });
    const b = await Browser.loggedIn(app, "staff@example.com", "password-123");
    expect(await (await b.get(`/admin/shops/${shop.id}`)).text()).not.toContain('id="legal-links"');
    expect((await b.post(`/admin/shops/${shop.id}/legal-links`, { url_legal: `${WP}/legal`, check_hours: "24" })).status).toBe(404);
  });

  it("Cron: 期限の来たショップを 1 回に 1 つ確かめて結果を書く", async () => {
    const run = async () => {
      const { sb } = setup({ legal: `${WP}/legal`, check_hours: 24 });
      const vars = { SUPABASE_URL: sb.url, SUPABASE_ANON_KEY: sb.anonKey, SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey, SESSION_SECRET: "s", PUBLIC_BASE_URL: "https://b.example" };
      const jobs = new Map<string, ScheduledJob>();
      const adapters = { ...memoryAdapters(vars), scheduler: { register: (name: string, job: ScheduledJob) => void jobs.set(name, job), runAll: async () => undefined } };
      const fetchImpl: typeof fetch = async (input, init) => (String(input).startsWith(`${WP}/`) ? html() : sb.fetch(input, init));
      registerJobs(adapters, { fetch: fetchImpl });
      await jobs.get("legal_links")!();
      return sb;
    };
    const sb = await run();
    expect(sb.legalLinkRecords).toHaveLength(1);
    expect((sb.tables.shops[0]!["legal_links_state"] as Record<string, { ok: boolean }>)["legal"]!.ok).toBe(true);
  });
});
