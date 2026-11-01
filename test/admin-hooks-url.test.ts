import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith, externalHosts } from "./helpers";

/**
 * 連携（hooks の送信先）の URL は、新規の登録でも更新でも公開のアドレスだけを受け付ける（docs/hooks.md §5）。
 * 私設の IP・localhost・社内の名前には書き換えられず、同梱プラグインの内部 URL（banto.invalid）にも変えられない。
 * 登録の検査を通らずに入った行（直叩き・復元）があっても、テスト送信は行き先を確かめて送らない。
 */
afterEach(() => externalHosts.clear());

function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
  return { sb, shop, app: appWith(sb) };
}

describe("連携の URL の行き先", () => {
  it("更新でも私設のアドレス・banto.invalid には書き換えられない。テスト送信は公開の行き先にだけ届く", async () => {
    const { sb, shop, app } = setup();
    const received: string[] = [];
    externalHosts.set("https://plugin.example/", async (req) => {
      received.push(`${req.method} ${req.url}`);
      return req.method === "GET" ? new Response(JSON.stringify({ name: "CRM", events: ["order.paid"] }), { status: 200 }) : new Response("ok");
    });
    externalHosts.set("http://10.0.0.5/", async (req) => {
      received.push(`${req.method} ${req.url}`);
      return new Response("ok", { status: 200 });
    });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");

    // 新規登録は私設のアドレスを断る
    let res = await b.post(`/admin/shops/${shop.id}/hooks`, { url: "http://10.0.0.5/hook", name: "x", events: "order.paid", enabled: "on" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/hooks?flash=invalid_url`);
    expect(received).toEqual([]);

    // 公開の URL で登録
    res = await b.post(`/admin/shops/${shop.id}/hooks`, { url: "https://plugin.example/banto", name: "CRM", events: "order.paid", enabled: "on" });
    const ep = sb.tables.hook_endpoints[0]!;
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/hooks/${ep["id"]}?flash=saved`);

    // 更新で私設のアドレス・localhost・社内の名前・banto.invalid に書き換えようとしても保存されない
    for (const url of ["http://10.0.0.5/hook", "http://localhost:8080/hook", "http://crm.internal/hook", "http://[::1]/hook", "https://banto.invalid/plugins/email_resend"]) {
      res = await b.post(`/admin/shops/${shop.id}/hooks/${ep["id"]}`, { url, name: "CRM", events: "order.paid", enabled: "on" });
      expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/hooks/${ep["id"]}?flash=invalid_url`);
      expect(ep["url"]).toBe("https://plugin.example/banto");
    }

    // 公開の別の URL には変えられる
    res = await b.post(`/admin/shops/${shop.id}/hooks/${ep["id"]}`, { url: "https://plugin.example/banto2", name: "CRM", events: "order.paid", enabled: "on" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/hooks/${ep["id"]}?flash=saved`);
    expect(ep["url"]).toBe("https://plugin.example/banto2");

    // テスト送信は公開の行き先に署名付きで届く
    received.length = 0;
    res = await b.post(`/admin/shops/${shop.id}/hooks/${ep["id"]}/test`, {});
    expect(res.headers.get("location")).toContain("flash=test_ok");
    expect(received).toEqual(["POST https://plugin.example/banto2"]);

    // 登録の検査を通らずに入った行（直叩き・復元）は、テスト送信でも送らない
    received.length = 0;
    ep["url"] = "http://10.0.0.5/hook";
    res = await b.post(`/admin/shops/${shop.id}/hooks/${ep["id"]}/test`, {});
    expect(res.headers.get("location")).toContain("flash=test_failed");
    // 更新の画面でも、マニフェストを取りに行かない
    res = await b.post(`/admin/shops/${shop.id}/hooks/${ep["id"]}`, { url: "https://plugin.example/banto2", name: "CRM", events: "order.paid", enabled: "on" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/hooks/${ep["id"]}?flash=saved`);
    expect(received).toEqual([]);
  });
});
