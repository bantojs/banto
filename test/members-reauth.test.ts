import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, memberLogin, memberMail } from "./helpers";

/**
 * 会員の再認証（0090）: 退会・全端末ログアウト・連携の解除・パスキーの削除は、ログインを確かめてから 15 分以内のセッションだけ。
 * 盗まれた Cookie / トークンから本人を締め出したり消したりできない。退会は本人に知らせる。
 * 入る手段を足す・消す操作（パスワード・連携・退会・パスキーの追加）はフォームの送信だけ受ける
 * （Liquid のテーマの JS はお店の画面と同じオリジンで動くので、fetch からの POST は 403。docs/themes.md）。
 * セッションを作り直す（パスワードの設定）ときも「ログインを確かめた時刻」を引き継ぎ、15 分の起点が若返らない
 */
let disposers: (() => void)[] = [];
afterEach(() => {
  disposers.forEach((d) => d());
  disposers = [];
});

function setup(opts: { migrated?: boolean } = {}) {
  const sb = new FakeSupabase(opts.migrated === false ? { appliedMigrations: ["0083_api_content", "0089_security_hardening_3"] } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "マイショップ",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    settings: { members_enabled: true, members_password: true, headless: { return_origins: ["https://wp.example.com"] } },
  });
  const mail = memberMail(sb, shop.id);
  disposers.push(mail.dispose);
  const app = appWith(sb, { RESEND_API_KEY: "re_test" });
  const age = (minutes: number) => {
    for (const ms of sb.memberSessions) ms["created_at"] = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  };
  return { sb, shop, mail, app, b: new Browser(app), age };
}

describe("同梱テーマ: 退会・全端末ログアウトの再認証と知らせ", () => {
  it("退会はログインしてから 15 分以内だけ。過ぎていれば入り直し（会員は残る）。受け付けたら本人に知らせる", async () => {
    const { sb, mail, b, age } = setup();
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    age(16);
    let res = await b.post("/my-shop/account/delete", {});
    expect(res.headers.get("location")).toBe("/my-shop/account/login?error=reauth");
    expect(sb.tables.customers.find((x) => x["email"] === "member@example.com")).toBeDefined();
    expect((await b.get("/my-shop/account")).headers.get("location")).toBe("/my-shop/account/login");
    expect(await (await b.get("/my-shop/account/login?error=reauth")).text()).toContain("もう一度ログインしてください");
    expect(mail.sent.some((m) => m.subject.includes("退会"))).toBe(false);

    // 入り直した直後なら退会できる。本人に「退会を受け付けました」が届く（マイページへのリンクは無い）
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    res = await b.post("/my-shop/account/delete", {});
    expect(res.headers.get("location")).toBe("/my-shop");
    expect(sb.tables.customers.find((x) => x["email"] === "member@example.com")).toBeUndefined();
    const notice = mail.sent.find((m) => m.subject.includes("退会を受け付けました"));
    expect(notice?.to).toBe("member@example.com");
    expect(notice?.text).toContain("退会を受け付けました");
    expect(notice?.text).not.toContain("/account");
  });

  it("全端末ログアウトも 15 分以内だけ（盗まれた Cookie から本人を締め出せない）", async () => {
    const { sb, mail, app, b, age } = setup();
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    const other = new Browser(app);
    await memberLogin(other, mail, "/my-shop", "member@example.com");
    const epoch = sb.tables.customers[0]!["session_epoch"];
    sb.memberSessions[0]!["created_at"] = new Date(Date.now() - 16 * 60 * 1000).toISOString(); // b の端末だけ 15 分を過ぎた
    const res = await b.post("/my-shop/account/logout-all", {});
    expect(res.headers.get("location")).toBe("/my-shop/account/login?error=reauth");
    expect(sb.tables.customers[0]!["session_epoch"]).toBe(epoch); // 世代は上がらない
    expect((await other.get("/my-shop/account")).status).toBe(200); // ほかの端末は続く
    // 新しい端末からなら全端末ログアウトできる
    age(0);
    expect((await other.post("/my-shop/account/logout-all", {})).headers.get("location")).toBe("/my-shop/account/login?info=logged_out_all");
    expect(sb.tables.customers[0]!["session_epoch"]).toBe(Number(epoch) + 1);
  });

  it("退会・パスワード・連携・パスキーの追加は画面の遷移（フォームの送信）だけ受ける。Sec-Fetch-Mode が navigate でなければ 403", async () => {
    const { sb, mail, b } = setup();
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    const cors = { headers: { "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" } };
    for (const path of ["/my-shop/account/delete", "/my-shop/account/password", "/my-shop/account/oauth/line/link", "/my-shop/account/passkey/add"]) {
      const res = await b.post(path, { password: "new-password-1" }, cors);
      expect(res.status, path).toBe(403);
    }
    expect(sb.tables.customers).toHaveLength(1);
    expect(sb.tables.customers[0]!["password_hash"]).toBeUndefined();
    // ブラウザのフォームの送信（navigate）とヘッダーの無い古いブラウザは通る
    expect((await b.post("/my-shop/account/password", { password: "new-password-1" }, { headers: { "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" } })).headers.get("location")).toBe("/my-shop/account?flash=password_saved");
    expect((await b.post("/my-shop/account/delete", {})).headers.get("location")).toBe("/my-shop");
  });
});

describe("ヘッドレスの会員 API: 退会・全端末ログアウトの再認証、パスワードの設定で 15 分の起点を引き継ぐ", () => {
  function api(app: ReturnType<typeof appWith>) {
    return async (path: string, body?: unknown, token?: string) => {
      const res = await app.request(`${BASE}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { origin: "https://wp.example.com", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
  }
  async function login(call: ReturnType<typeof api>, mail: ReturnType<typeof memberMail>, email: string) {
    const r = await call("/api/shops/my-shop/members/login", { email });
    const v = await call("/api/shops/my-shop/members/verify", { challenge_id: r.json["challenge_id"], code: mail.code(email) });
    return String(v.json["access_token"]);
  }

  it("退会・全端末ログアウトは 15 分を過ぎたトークンでは 403 reauth_required。退会は本人に知らせる", async () => {
    const { sb, mail, app, age } = setup();
    const call = api(app);
    const t = await login(call, mail, "m@example.com");
    age(16);
    expect(await call("/api/shops/my-shop/members/logout-all", {}, t)).toMatchObject({ status: 403, json: { error: "reauth_required" } });
    expect(await call("/api/shops/my-shop/members/withdraw", { confirm: true }, t)).toMatchObject({ status: 403, json: { error: "reauth_required" } });
    expect(sb.tables.customers).toHaveLength(1);
    age(1);
    expect(await call("/api/shops/my-shop/members/withdraw", { confirm: true }, t)).toMatchObject({ status: 200, json: { ok: true } });
    expect(sb.tables.customers).toHaveLength(0);
    expect(mail.sent.find((m) => m.subject.includes("退会を受け付けました"))?.to).toBe("m@example.com");
  });

  it("パスワードの設定で作り直したセッションは、前のセッションがログインを確かめた時刻を引き継ぐ（15 分の起点が若返らない）", async () => {
    const { sb, mail, app, age } = setup();
    const call = api(app);
    const t = await login(call, mail, "m@example.com");
    age(10);
    const first = sb.memberSessions[0]!;
    const r = await call("/api/shops/my-shop/members/password", { password: "new-password-1" }, t);
    expect(r.status).toBe(200);
    const next = sb.memberSessions.at(-1)!;
    expect(next["id"]).not.toBe(first["id"]);
    expect(next["authenticated_at"]).toBe(first["created_at"]);
    // 10 分前にログインしたままなので、さらに 6 分たてば 15 分を超える（新しいトークンでも入り直し）
    next["authenticated_at"] = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    expect(await call("/api/shops/my-shop/members/password", { password: "new-password-2" }, String(r.json["access_token"]))).toMatchObject({ status: 403, json: { error: "reauth" } });
    expect(await call("/api/shops/my-shop/members/withdraw", { confirm: true }, String(r.json["access_token"]))).toMatchObject({ status: 403, json: { error: "reauth_required" } });
  });
});
