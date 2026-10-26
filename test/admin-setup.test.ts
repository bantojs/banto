import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith } from "./helpers";
import { SESSION_COOKIE } from "../src/auth/session";

describe("セットアップウィザード（Step 3）", () => {
  it("環境変数が足りなければ、名前と画面上の設定場所を出し、値は出さない", async () => {
    const sb = new FakeSupabase();
    const b = new Browser(appWith(sb, { SUPABASE_SERVICE_ROLE_KEY: undefined, SESSION_SECRET: undefined }));
    const res = await b.get("/admin/setup");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("変数とシークレット");
    expect(html).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(html).toContain("API Keys → service_role");
    expect(html).toContain("npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY"); // 開発者向けの折りたたみ
    expect(html).toContain("SESSION_SECRET"); // 新しい導入では必須（2026-10-18）。貼る値をその場で作って出す
    expect(html).toMatch(/<pre>[A-Za-z0-9_-]{40,}<\/pre>/);
    expect(html).not.toContain(sb.anonKey);
    expect(html).toContain("先に上の項目を解決してください");
    expect(html).not.toContain('action="/admin/setup/owner"');
  });

  it("マイグレーション未適用を検出する", async () => {
    const sb = new FakeSupabase({ migrationsApplied: false });
    const b = new Browser(appWith(sb));
    const html = await (await b.get("/admin/setup")).text();
    expect(html).toContain("マイグレーションが適用されていません");
    expect(html).toContain('action="/admin/setup/migrate"');
    expect(html).not.toContain('action="/admin/setup/owner"');
  });

  it("未適用のマイグレーションがあれば一覧を出す", async () => {
    const sb = new FakeSupabase({ appliedMigrations: [] });
    const b = new Browser(appWith(sb));
    const html = await (await b.get("/admin/setup")).text();
    expect(html).toContain("未適用のマイグレーションがあります");
    expect(html).toContain("0001_init");
  });

  it("Supabase に届かなければ接続エラーを出す", async () => {
    const sb = new FakeSupabase();
    const b = new Browser(appWith(sb, { SUPABASE_URL: "https://other.supabase.co" }));
    const html = await (await b.get("/admin/setup")).text();
    expect(html).toContain("Supabase に接続できません");
  });

  it("owner 作成 → ショップ作成 → ダッシュボード、の一気通貫", async () => {
    const sb = new FakeSupabase();
    const b = new Browser(appWith(sb));

    let html = await (await b.get("/admin/setup")).text();
    expect(html).toContain('action="/admin/setup/owner"');

    // 短いパスワードは拒否
    let res = await b.post("/admin/setup/owner", { email: "owner@example.com", password: "short" });
    expect(res.headers.get("location")).toBe("/admin/setup?error=generic");
    expect(sb.users.size).toBe(0);

    res = await b.post("/admin/setup/owner", { email: "owner@example.com", password: "correct horse battery" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/setup");
    expect(b.cookies.has(SESSION_COOKIE)).toBe(true);
    expect(sb.owners.size).toBe(1);

    html = await (await b.get("/admin/setup")).text();
    expect(html).toContain("運営者は登録済みです");
    expect(html).toContain('action="/admin/setup/shop"');

    res = await b.post("/admin/setup/shop", { name: "テスト商店", slug: "Bad Slug" });
    expect(res.headers.get("location")).toBe("/admin/setup?error=invalid_slug");

    res = await b.post("/admin/setup/shop", { name: "テスト商店", slug: "test-shop" });
    expect(res.headers.get("location")).toBe("/admin");
    expect(sb.shops).toHaveLength(1);
    expect(sb.shops[0]).toMatchObject({ owner_id: sb.shops[0]!.owner_id, slug: "test-shop", published: false });

    res = await b.get("/admin");
    expect(res.status).toBe(200);
    html = await res.text();
    expect(html).toContain("テスト商店");
    expect(html).toContain("test-shop");
    expect(html).toContain("owner@example.com");

    // 完了後のウィザードはフォームを出さない
    html = await (await b.get("/admin/setup")).text();
    expect(html).toContain("セットアップは完了しています");
    expect(html).not.toContain("<form");
  });

  it("owner が既にいれば 2人目は作れない", async () => {
    const sb = new FakeSupabase();
    sb.addUser("first@example.com", "password-1", { owner: true });
    const b = new Browser(appWith(sb));
    const res = await b.post("/admin/setup/owner", { email: "second@example.com", password: "password-2" });
    expect(res.headers.get("location")).toBe("/admin/setup?error=blocked");
    expect(sb.users.size).toBe(1);
  });

  it("最初の運営者の Auth ユーザーが消えても、ショップか組織のメンバーが残っていれば運営者登録は再び開かない（0030、監査 M1）", async () => {
    const sb = new FakeSupabase();
    const first = sb.addUser("first@example.com", "password-1", { owner: true });
    sb.addShop(first.id, { slug: "s", name: "S" });
    // Supabase の画面でユーザーを消した（owners は cascade で消える）
    sb.owners.delete(first.id);
    const b = new Browser(appWith(sb));
    expect((await b.get("/admin/setup/status.json")).status).toBe(404);
    const res = await b.post("/admin/setup/owner", { email: "intruder@example.com", password: "password-2" });
    expect(res.headers.get("location")).toBe("/admin/setup?error=blocked");
    expect([...sb.users.values()].some((u) => u.email === "intruder@example.com")).toBe(false);
  });

  it("Supabase 側で signup が無効でも、確認メールが有効でも、運営者は Admin API で確認済みとして作られ即ログインする", async () => {
    for (const opts of [{ signupsAllowed: false }, { confirmEmail: true }]) {
      const sb = new FakeSupabase(opts);
      const b = new Browser(appWith(sb));
      const res = await b.post("/admin/setup/owner", { email: "o@example.com", password: "password-123" });
      expect(res.headers.get("location")).toBe("/admin/setup");
      expect(b.cookies.has(SESSION_COOKIE)).toBe(true);
      expect(sb.owners.size).toBe(1);
      expect([...sb.users.values()][0]!.confirmed).toBe(true);
      expect(sb.calls.some((c) => c.includes("/auth/v1/admin/users"))).toBe(true);
      expect(sb.calls.some((c) => c.includes("/auth/v1/signup"))).toBe(false);
    }
  });

  it("同じメールが Supabase に既にある場合: パスワードが合えば進み、未確認なら案内、違えば案内", async () => {
    const sb = new FakeSupabase();
    sb.addUser("o@example.com", "password-123", { confirmed: true });
    const b = new Browser(appWith(sb));
    let res = await b.post("/admin/setup/owner", { email: "o@example.com", password: "wrong-password" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("すでに Supabase に登録されています");
    expect(sb.owners.size).toBe(0);
    res = await b.post("/admin/setup/owner", { email: "o@example.com", password: "password-123" });
    expect(res.headers.get("location")).toBe("/admin/setup");
    expect(sb.owners.size).toBe(1);

    const sb2 = new FakeSupabase();
    sb2.addUser("u@example.com", "password-123", { confirmed: false });
    const b2 = new Browser(appWith(sb2));
    res = await b2.post("/admin/setup/owner", { email: "u@example.com", password: "password-123" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("メール確認が済んでいません");
  });

  it("Origin: null・Sec-Fetch-Site: cross-site の POST は 403。管理画面は埋め込めず、全ページに nosniff と Referrer-Policy（0031）", async () => {
    const sb = new FakeSupabase();
    sb.addUser("owner@example.com", "password-123", { owner: true });
    const app = appWith(sb);
    const b = new Browser(app);
    expect((await b.post("/admin/login", { email: "owner@example.com", password: "password-123" }, { origin: "null" })).status).toBe(403);
    expect((await app.request(`${BASE}/admin/login`, { method: "POST", headers: { origin: BASE, "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" }, body: "email=a&password=b" })).status).toBe(403);
    const page = await b.get("/admin/login");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    const front = await app.request(`${BASE}/`);
    expect(front.headers.get("x-frame-options")).toBeNull();
    expect(front.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("他オリジンからの POST は 403", async () => {
    const sb = new FakeSupabase();
    const b = new Browser(appWith(sb));
    const res = await b.post("/admin/setup/owner", { email: "o@example.com", password: "password-123" }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(sb.users.size).toBe(0);
  });
});

describe("ログイン / セッション", () => {
  it("誤ったパスワードは弾き、正しければダッシュボードへ", async () => {
    const sb = new FakeSupabase();
    sb.addUser("owner@example.com", "password-123", { owner: true });
    const b = new Browser(appWith(sb));
    let res = await b.post("/admin/login", { email: "owner@example.com", password: "wrong" });
    expect(res.headers.get("location")).toBe("/admin/login?error=failed");
    expect(b.cookies.has(SESSION_COOKIE)).toBe(false);

    res = await b.post("/admin/login", { email: "owner@example.com", password: "password-123" });
    expect(res.headers.get("location")).toBe("/admin");
    const cookie = res.headers.getSetCookie()[0]!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/admin");
    expect((await b.get("/admin")).status).toBe(200);

    // ログアウトで Cookie が消え、以後はログインへ
    res = await b.post("/admin/logout", {});
    expect(res.headers.get("location")).toBe("/admin/login");
    expect(b.cookies.has(SESSION_COOKIE)).toBe(false);
    expect((await b.get("/admin")).headers.get("location")).toBe("/admin/login");
  });

  it("DB の準備が済んでいない・Supabase に届かないときは、ログインの処理に進まずセットアップの画面へ（500 にしない）", async () => {
    const fresh = new FakeSupabase({ migrationsApplied: false });
    fresh.addUser("owner@example.com", "password-123", {});
    let res = await new Browser(appWith(fresh)).post("/admin/login", { email: "owner@example.com", password: "password-123" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/setup");
    expect(fresh.calls.some((c) => c.includes("grant_type=password"))).toBe(false);

    const down = new FakeSupabase();
    down.addUser("owner@example.com", "password-123", { owner: true });
    down.failNextRequests = 1;
    res = await new Browser(appWith(down)).post("/admin/login", { email: "owner@example.com", password: "password-123" });
    expect(res.headers.get("location")).toBe("/admin/setup");
  });

  it("owner でない認証ユーザーは入れない", async () => {
    const sb = new FakeSupabase();
    sb.addUser("owner@example.com", "password-123", { owner: true });
    sb.addUser("staff@example.com", "password-456");
    const b = new Browser(appWith(sb));
    const res = await b.post("/admin/login", { email: "staff@example.com", password: "password-456" });
    expect(res.headers.get("location")).toBe("/admin/login?error=not_owner");
    expect(b.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  it("回数の制限（0030）: 同じアドレスで 5 回失敗したら、正しいパスワードでも 15 分は入れない（Supabase には問い合わせない）。成功すれば失敗は消える", async () => {
    const sb = new FakeSupabase();
    sb.addUser("owner@example.com", "password-123", { owner: true });
    const b = new Browser(appWith(sb));
    for (let i = 0; i < 5; i++) expect((await b.post("/admin/login", { email: "Owner@example.com", password: `wrong-${i}` })).headers.get("location")).toBe("/admin/login?error=failed");
    sb.calls.length = 0;
    const locked = await b.post("/admin/login", { email: "owner@example.com", password: "password-123" });
    expect(locked.headers.get("location")).toBe("/admin/login?error=locked");
    expect(sb.calls.some((c) => c.includes("grant_type=password"))).toBe(false);
    expect(await (await b.get("/admin/login?error=locked")).text()).toContain("ログインの失敗が続いたため");
    // 別のアドレスは影響を受けない。15 分経てば入れる
    sb.addUser("other@example.com", "password-456", {});
    expect((await b.post("/admin/login", { email: "other@example.com", password: "password-456" })).headers.get("location")).toBe("/admin/login?error=not_owner");
    for (const a of sb.adminLoginAttempts) a.at -= 16 * 60_000;
    expect((await b.post("/admin/login", { email: "owner@example.com", password: "password-123" })).headers.get("location")).toBe("/admin");
    expect(sb.adminLoginAttempts.filter((a) => !a.success)).toHaveLength(0);
  });

  it("ログアウトで世代が上がり、他の端末の Cookie も使えなくなる（0030）。Cookie は暗号文で refresh_token が読めない", async () => {
    const sb = new FakeSupabase();
    sb.addUser("owner@example.com", "password-123", { owner: true });
    const app = appWith(sb);
    const a = new Browser(app);
    const b = new Browser(app);
    await a.post("/admin/login", { email: "owner@example.com", password: "password-123" });
    await b.post("/admin/login", { email: "owner@example.com", password: "password-123" });
    const cookie = a.cookies.get(SESSION_COOKIE)!;
    expect(cookie).toMatch(/^v1\./);
    expect(cookie).not.toContain("refresh");
    expect((await b.get("/admin")).status).toBe(200);
    await a.post("/admin/logout", {});
    // 端末 b の Cookie はまだ期限内だが、世代が古いので入れない
    expect((await b.get("/admin")).headers.get("location")).toBe("/admin/login");
    // a の古い Cookie を戻しても入れない
    a.cookies.set(SESSION_COOKIE, cookie);
    expect((await a.get("/admin")).headers.get("location")).toBe("/admin/login");
    // ログインし直せば入れる
    await a.post("/admin/login", { email: "owner@example.com", password: "password-123" });
    expect((await a.get("/admin")).status).toBe(200);
  });

  it("改ざんした Cookie は無効", async () => {
    const sb = new FakeSupabase();
    sb.addUser("owner@example.com", "password-123", { owner: true });
    const b = new Browser(appWith(sb));
    await b.post("/admin/login", { email: "owner@example.com", password: "password-123" });
    const v = b.cookies.get(SESSION_COOKIE)!;
    b.cookies.set(SESSION_COOKIE, v.slice(0, -2) + (v.endsWith("AA") ? "BB" : "AA"));
    const res = await b.get("/admin");
    expect(res.headers.get("location")).toBe("/admin/login");
  });

  it("SESSION_SECRET が違えば既存 Cookie は無効", async () => {
    const sb = new FakeSupabase();
    sb.addUser("owner@example.com", "password-123", { owner: true });
    const b = new Browser(appWith(sb));
    await b.post("/admin/login", { email: "owner@example.com", password: "password-123" });
    const b2 = new Browser(appWith(sb, { SESSION_SECRET: "another-secret" }));
    b2.cookies = b.cookies;
    expect((await b2.get("/admin")).headers.get("location")).toBe("/admin/login");
  });

  it("SESSION_SECRET が無くても service_role キーから導出してログインできる。両方無ければ案内", async () => {
    const sb = new FakeSupabase();
    sb.addUser("owner@example.com", "password-123", { owner: true });
    const b = new Browser(appWith(sb, { SESSION_SECRET: undefined }));
    let res = await b.post("/admin/login", { email: "owner@example.com", password: "password-123" });
    expect(res.headers.get("location")).toBe("/admin");
    expect((await b.get("/admin")).status).toBe(200);

    // 明示的な SESSION_SECRET を後から設定すると既存セッションは無効（別の秘密になる）
    const b2 = new Browser(appWith(sb, { SESSION_SECRET: "explicit" }));
    b2.cookies = b.cookies;
    expect((await b2.get("/admin")).headers.get("location")).toBe("/admin/login");

    const none = new Browser(appWith(sb, { SESSION_SECRET: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined }));
    res = await none.post("/admin/login", { email: "owner@example.com", password: "password-123" });
    expect(res.headers.get("location")).toBe("/admin/login?error=secret_missing");
  });

  it("期限が近いセッションは refresh_token で更新される", async () => {
    const sb = new FakeSupabase();
    sb.addUser("owner@example.com", "password-123", { owner: true });
    const b = new Browser(appWith(sb));
    await b.post("/admin/login", { email: "owner@example.com", password: "password-123" });
    const before = b.cookies.get(SESSION_COOKIE);

    // 時計を 1 時間進める
    const realNow = Date.now;
    Date.now = () => realNow() + 3600 * 1000;
    try {
      const res = await b.get("/admin");
      expect(res.status).toBe(200);
      expect(sb.calls.some((c) => c.includes("grant_type=refresh_token"))).toBe(true);
      expect(b.cookies.get(SESSION_COOKIE)).not.toBe(before);
    } finally {
      Date.now = realNow;
    }
  });
});
