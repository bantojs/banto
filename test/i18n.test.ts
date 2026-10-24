import { describe, expect, it } from "vitest";
import { ja } from "../src/i18n/ja";
import { en } from "../src/i18n/en";
import { getLocale, setLocale, t } from "../src/i18n";
import { FakeSupabase } from "./fake-supabase";
import { BASE, appWith } from "./helpers";

describe("i18n", () => {
  it("en.ts は ja.ts と同じキーを持ち、空文字が無い", () => {
    const jaKeys = Object.keys(ja).sort();
    const enKeys = Object.keys(en).sort();
    expect(enKeys).toEqual(jaKeys);
    for (const [k, v] of Object.entries(en)) expect(v.trim(), k).not.toBe("");
  });

  it("setLocale は ja / en だけを受け付け、それ以外は ja に戻る", () => {
    expect(setLocale("en")).toBe("en");
    expect(t("login.title")).toBe("Log in");
    expect(t("login.title", "ja")).toBe("ログイン");
    expect(setLocale("fr")).toBe("ja");
    expect(setLocale(undefined)).toBe("ja");
    expect(getLocale()).toBe("ja");
    expect(t("login.title")).toBe("ログイン");
  });

  it("BANTO_LOCALE=en で管理画面とストアフロントが英語になり、<html lang> も変わる", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("o@example.com", "password-123", { owner: true });
    sb.addShop(owner.id, { slug: "s", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    const app = appWith(sb, { BANTO_LOCALE: "en" });
    const login = await (await app.request(`${BASE}/admin/login`)).text();
    expect(login).toContain('<html lang="en">');
    expect(login).toContain("Log in");
    expect(login).not.toContain("ログイン");
    const store = await (await app.request(`${BASE}/s`)).text();
    expect(store).toContain('<html lang="en">');
    expect(store).toContain("Products");
    // 未設定のアプリに戻ると日本語
    const jaApp = appWith(sb);
    expect(await (await jaApp.request(`${BASE}/admin/login`)).text()).toContain('<html lang="ja">');
  });
});

describe("日時の表示（BANTO_TIMEZONE）", () => {
  it("既定は Asia/Tokyo。不正な時間帯は既定に戻る。英語では YYYY-MM-DD", async () => {
    const { formatDateTime, setTimeZone, getTimeZone } = await import("../src/i18n/time");
    setLocale("ja");
    expect(setTimeZone(undefined)).toBe("Asia/Tokyo");
    expect(formatDateTime("2026-10-15T07:58:44Z")).toBe("2026/10/15 16:58");
    expect(formatDateTime("2026-10-15T07:58:44Z", { dateOnly: true })).toBe("2026/10/15");
    expect(formatDateTime(null)).toBe("-");
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
    expect(setTimeZone("Mars/Olympus")).toBe("Asia/Tokyo");
    expect(setTimeZone("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(formatDateTime("2026-10-15T07:58:44Z")).toBe("2026/10/15 00:58");
    setLocale("en");
    expect(formatDateTime("2026-10-15T07:58:44Z")).toBe("2026-10-15 00:58");
    setLocale("ja");
    setTimeZone("Asia/Tokyo");
    expect(getTimeZone()).toBe("Asia/Tokyo");
  });

  it("BANTO_TIMEZONE が管理画面の配信履歴に反映される", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("o@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "s", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    sb.tables.hook_endpoints.push({ id: "ep-1", shop_id: shop.id, name: "crm", url: "https://crm.example/hook", events: ["order.paid"], enabled: true, manifest: null, settings: {}, created_at: "2026-10-15T07:58:44Z" });
    sb.tables.hook_deliveries.push({ id: "d-1", shop_id: shop.id, endpoint_id: "ep-1", event: "order.paid", payload: {}, status: "pending", attempts: 1, last_status: null, last_error: null, created_at: "2026-10-15T07:58:44Z", next_attempt_at: "2026-10-15T08:00:44Z" });
    const { Browser } = await import("./helpers");
    const b = await Browser.loggedIn(appWith(sb), "o@example.com", "password-123");
    expect(await (await b.get(`/admin/shops/${shop.id}/hooks`)).text()).toContain("2026/10/15 16:58");
    const la = await Browser.loggedIn(appWith(sb, { BANTO_TIMEZONE: "America/Los_Angeles" }), "o@example.com", "password-123");
    expect(await (await la.get(`/admin/shops/${shop.id}/hooks`)).text()).toContain("2026/10/15 00:58");
  });
});
