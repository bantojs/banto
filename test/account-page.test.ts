import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith } from "./helpers";
import { memberAccountUrl } from "../src/storefront/urls";

/** 会員ページを連携サイトに（0069）: 会員へのお知らせのメールのリンクと、管理画面の設定 */
describe("会員ページの URL", () => {
  const shop = (headless: Record<string, unknown>) => ({ slug: "my-shop", domain: null, settings: { headless } });

  it("許可リストのサイトの https なら会員ページ、無い・外れていれば Banto の /account", () => {
    expect(memberAccountUrl(BASE, shop({ return_origins: ["https://wp.example.com"], account_page_url: "https://wp.example.com/my/" }))).toBe("https://wp.example.com/my/");
    expect(memberAccountUrl(BASE, shop({ return_origins: [], account_page_url: "https://wp.example.com/my/" }))).toBe(`${BASE}/my-shop/account`);
    expect(memberAccountUrl(BASE, shop({ return_origins: ["https://wp.example.com"] }))).toBe(`${BASE}/my-shop/account`);
    expect(memberAccountUrl(BASE, { slug: "my-shop", domain: "shop.example.com" })).toBe("https://shop.example.com/account");
  });

  it("管理画面: 許可リストのサイトの https だけ保存できる", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const s = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ" });
    const admin = await Browser.loggedIn(appWith(sb), "owner@example.com", "password-123");
    expect(await (await admin.get(`/admin/shops/${s.id}`)).text()).toContain('name="account_page_url"');
    let res = await admin.post(`/admin/shops/${s.id}/headless`, { return_origins: "https://wp.example.com", account_page_url: "https://evil.example.com/my/" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${s.id}?flash=account_page_invalid#headless`);
    res = await admin.post(`/admin/shops/${s.id}/headless`, { return_origins: "https://wp.example.com", account_page_url: "https://wp.example.com/my/" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${s.id}?flash=headless_saved`);
    const headless = () => (sb.shops[0]!["settings"] as Record<string, Record<string, unknown>>)["headless"]!;
    expect(headless()["account_page_url"]).toBe("https://wp.example.com/my/");
    await admin.post(`/admin/shops/${s.id}/headless`, { return_origins: "https://wp.example.com", account_page_url: "" });
    expect(headless()["account_page_url"]).toBeUndefined();
  });
});
