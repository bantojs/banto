import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, memberMail } from "./helpers";

/**
 * ヘッドレスのパスキーの追加（0070）で券を使った端末に作るログインは、追加のためだけのもの。
 * 登録をやめても、その端末に会員ページ・パスワードの変更が使えるログインを残さない（20 分・印つき。登録とログアウトだけに通す）。
 */
const DOMAIN = "shop.example.jp";
const SHOP_URL = `https://${DOMAIN}`;

let disposers: (() => void)[] = [];
afterEach(() => {
  disposers.forEach((d) => d());
  disposers = [];
});

function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "マイショップ",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    domain: DOMAIN,
    settings: { members_enabled: true, members_password: true, modules: { passkey: true }, headless: { return_origins: ["https://wp.example.com"] } },
  });
  const mail = memberMail(sb, shop.id);
  disposers.push(mail.dispose);
  const app = appWith(sb, { RESEND_API_KEY: "re_test" });
  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
  const api = (path: string, body: unknown, token?: string) =>
    app.request(`${BASE}${path}`, { method: "POST", headers: { origin: "https://wp.example.com", "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { sb, app, mail, json, api };
}

/** 会員トークン → 券 → ショップのドメインで「続ける」を押したところまで */
async function ticketUsed() {
  const { sb, app, mail, json, api } = setup();
  const ch = (await json(await api("/api/shops/my-shop/members/login", { email: "h@example.com" })))["challenge_id"];
  const access = String((await json(await api("/api/shops/my-shop/members/verify", { challenge_id: ch, code: mail.code("h@example.com") })))["access_token"]);
  const r = await json(await api("/api/shops/my-shop/members/passkey/add", { return_to: "https://wp.example.com/my/" }, access));
  const url = new URL(String(r["url"]));
  const page = new Browser(app, SHOP_URL);
  const res = await page.post("/account/passkey/add", { t: url.searchParams.get("t")!, return_to: "https://wp.example.com/my/" });
  expect(res.status).toBe(200);
  return { sb, page, html: await res.text() };
}

describe("ヘッドレスのパスキーの追加のためだけのログイン（0070）", () => {
  it("券を使っただけで登録しない端末では、会員ページもパスワードの設定も使えない（登録の API だけ通る）", async () => {
    const { sb, page, html } = await ticketUsed();
    // 登録のボタンと「やめる」（ログアウトのフォーム）
    expect(html).toContain('data-banto-passkey="register"');
    expect(html).toContain('action="/account/logout"');
    // 行は web だが、短い期限と印つき
    const web = sb.memberSessions.filter((x) => x["kind"] === "web");
    expect(web).toHaveLength(1);
    expect(String(web[0]!["label"])).toMatch(/^passkey-add/);
    expect(Number(web[0]!["expires_at"]) - Date.now()).toBeLessThanOrEqual(20 * 60_000);
    // 会員ページは開けない（ログインへ）
    const account = await page.get("/account");
    expect(account.status).not.toBe(200);
    expect(account.headers.get("location")).toBe("/account/login");
    // パスワードの設定も通らない（0057 の 15 分の決まりを満たす新しい行でも）
    const pw = await page.post("/account/password", { password: "attacker-password-1" });
    expect(pw.headers.get("location")).toBe("/account/login");
    expect(sb.tables.customers.find((c) => c["email"] === "h@example.com")?.["password_hash"] ?? null).toBeNull();
    expect((await page.get("/account/sessions")).headers.get("location")).toBe("/account/login");
    // 登録の options は通る（このセッションの用途）
    expect((await page.postJson("/account/passkey/register/options", {})).status).toBe(200);
  });

  it("「やめて元のサイトに戻る」でこの端末のログインを取り消し、連携サイトへ戻す", async () => {
    const { sb, page } = await ticketUsed();
    const res = await page.post("/account/logout", { return_to: "https://wp.example.com/my/" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://wp.example.com/my/");
    expect(sb.memberSessions.filter((x) => x["kind"] === "web" && x["revoked_at"] === null)).toHaveLength(0);
    // 許可リストの外へは戻さない
    const { page: p2 } = await ticketUsed();
    expect((await p2.post("/account/logout", { return_to: "https://evil.example/" })).headers.get("location")).toBe("/");
  });
});
