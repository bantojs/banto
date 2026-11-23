import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";
import { BASE, Browser, appWith, memberLogin, memberMail } from "./helpers";
import { maskEmail } from "../src/members/email-change";

/**
 * 会員が自分でメールアドレスを変える（0166、メンテナの決定 2026-11-23）。
 * 新しいアドレスに届いたコードで変わる。ログインしてから 15 分以内のセッションだけ。
 * 変わったら前後のアドレスに知らせ、ほかの端末はログアウト、今の端末は続く。
 * ほかの会員が使っているアドレスには送らない（応答・後始末・数え方は同じ）。コードは始めたセッションだけで使える。
 * 前のアドレスへの知らせでは新しいアドレスを伏せる。コードのメールは応答の後に送る。0166 の前は出さない
 */
let disposers: (() => void)[] = [];
afterEach(() => {
  disposers.forEach((d) => d());
  disposers = [];
});

function setup(opts: { migrated?: boolean } = {}) {
  const sb = new FakeSupabase(opts.migrated === false ? { appliedMigrations: BUNDLED_MIGRATIONS.filter((v) => v < "0166_member_email_change") } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "マイショップ",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    settings: { members_enabled: true, headless: { return_origins: ["https://wp.example.com"] } },
  });
  const mail = memberMail(sb, shop.id);
  disposers.push(mail.dispose);
  const app = appWith(sb, { RESEND_API_KEY: "re_test" });
  const age = (minutes: number) => {
    for (const ms of sb.memberSessions) ms["created_at"] = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  };
  return { sb, shop, mail, app, b: new Browser(app), age };
}

const customer = (sb: FakeSupabase, id: string) => sb.tables.customers.find((c) => c["id"] === id)!;

describe("同梱テーマ: 会員ページでメールアドレスを変える", () => {
  it("新しいアドレスに届いたコードで変わる。前後のアドレスに知らせ、ほかの端末はログアウト・この端末は続く", async () => {
    const { sb, mail, app, b } = setup();
    await memberLogin(b, mail, "/my-shop", "old@example.com");
    const other = new Browser(app);
    await memberLogin(other, mail, "/my-shop", "old@example.com");
    const id = String(sb.tables.customers[0]!["id"]);

    // 会員ページにアドレスの欄がある
    let html = await (await b.get("/my-shop/account")).text();
    expect(html).toContain('action="/my-shop/account/email"');

    let res = await b.post("/my-shop/account/email", { email: "New@Example.com" });
    expect(res.headers.get("location")).toBe("/my-shop/account?flash=email_code#email-change");
    const codeMail = mail.sent.at(-1)!;
    expect(codeMail.to).toBe("new@example.com");
    expect(codeMail.subject).toContain("メールアドレスの確認のコード");
    expect(customer(sb, id)["email"]).toBe("old@example.com"); // コードを入れるまで変わらない
    html = await (await b.get("/my-shop/account?flash=email_code")).text();
    expect(html).toContain('action="/my-shop/account/email/verify"');

    const before = mail.sent.length;
    res = await b.post("/my-shop/account/email/verify", { code: mail.code("new@example.com") });
    expect(res.headers.get("location")).toBe("/my-shop/account?flash=email_changed");
    expect(customer(sb, id)["email"]).toBe("new@example.com");
    // 前後のアドレスに知らせる（前のアドレスには新しいアドレスとお店への連絡を）
    const notices = mail.sent.slice(before);
    expect(notices.map((m) => m.to).sort()).toEqual(["new@example.com", "old@example.com"]);
    const toOld = notices.find((m) => m.to === "old@example.com")!;
    expect(toOld.subject).toContain("メールアドレスが変更されました");
    // 新しいアドレスは伏せる（頭の 1 文字と @ 以降だけ）
    expect(toOld.text).toContain("n***@example.com");
    expect(toOld.text).not.toContain("new@example.com");
    expect(toOld.html ?? "").not.toContain("new@example.com");
    expect(toOld.text).toContain("お店へご連絡ください");

    // この端末は続く（新しいアドレスで）。ほかの端末はログアウト
    const page = await b.get("/my-shop/account");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("new@example.com");
    expect((await other.get("/my-shop/account")).headers.get("location")).toBe("/my-shop/account/login");

    // 新しいアドレスでログインできる（同じ会員）
    const third = new Browser(app);
    await memberLogin(third, mail, "/my-shop", "new@example.com");
    expect(sb.tables.customers).toHaveLength(1);
  });

  it("ログインしてから 15 分を過ぎたセッションでは送らず、入り直してもらう（確かめも同じ）", async () => {
    const { sb, mail, b, age } = setup();
    await memberLogin(b, mail, "/my-shop", "old@example.com");
    age(16);
    const before = mail.sent.length;
    const res = await b.post("/my-shop/account/email", { email: "new@example.com" });
    expect(res.headers.get("location")).toBe("/my-shop/account/login?error=reauth");
    expect(mail.sent.length).toBe(before);
    expect(sb.memberEmailChanges).toHaveLength(0);

    // コードを送った後に 15 分を過ぎても、確かめで止まる
    await memberLogin(b, mail, "/my-shop", "old@example.com");
    await b.post("/my-shop/account/email", { email: "new@example.com" });
    const code = mail.code("new@example.com");
    age(16);
    expect((await b.post("/my-shop/account/email/verify", { code })).headers.get("location")).toBe("/my-shop/account/login?error=reauth");
    expect(sb.tables.customers[0]!["email"]).toBe("old@example.com");
  });

  it("コードを 5 回間違えると使えなくなる（正しいコードでも期限切れ）", async () => {
    const { sb, mail, b } = setup();
    await memberLogin(b, mail, "/my-shop", "old@example.com");
    await b.post("/my-shop/account/email", { email: "new@example.com" });
    const code = mail.code("new@example.com");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) {
      expect((await b.post("/my-shop/account/email/verify", { code: wrong })).headers.get("location")).toBe("/my-shop/account?error=email_code_invalid#email-change");
    }
    expect((await b.post("/my-shop/account/email/verify", { code: wrong })).headers.get("location")).toBe("/my-shop/account?error=email_code_expired#email-change");
    expect((await b.post("/my-shop/account/email/verify", { code })).headers.get("location")).toBe("/my-shop/account?error=email_code_expired#email-change");
    expect(sb.tables.customers[0]!["email"]).toBe("old@example.com");
    // 間違いのあとはコードの欄を出し続ける
    expect(await (await b.get("/my-shop/account?error=email_code_invalid")).text()).toContain("コードが違います");
  });

  it("ほかの会員が使っているアドレスには送らない。応答・前のコードの無効化・回数の数え方は送ったときと同じ。同じアドレス・形の誤りは断る", async () => {
    const { sb, app, mail, b } = setup();
    const taken = new Browser(app);
    await memberLogin(taken, mail, "/my-shop", "taken@example.com");
    await memberLogin(b, mail, "/my-shop", "old@example.com");
    // 先に自分のアドレスへコードを受け取っておく
    await b.post("/my-shop/account/email", { email: "mine@example.com" });
    const ownCode = mail.code("mine@example.com");
    const before = mail.sent.length;
    const res = await b.post("/my-shop/account/email", { email: "taken@example.com" });
    expect(res.headers.get("location")).toBe("/my-shop/account?flash=email_code#email-change");
    expect(mail.sent.length).toBe(before);
    // 行は作る（誰にも合わないコード）。前の行は使えなくなる
    expect(sb.memberEmailChanges).toHaveLength(2);
    expect(sb.memberEmailChanges.filter((r) => !r["consumed_at"])).toHaveLength(1);
    // 前のコードで確かめても「違う」（使われているかどうかの手がかりにならない）
    expect((await b.post("/my-shop/account/email/verify", { code: ownCode })).headers.get("location")).toBe("/my-shop/account?error=email_code_invalid#email-change");
    expect(sb.tables.customers.some((c) => c["email"] === "old@example.com")).toBe(true);
    // 回数に数える（15 分に 3 回まで: 自分のアドレス・使われているアドレスで 2 回、3 回目は送る、4 回目は送らない）
    await b.post("/my-shop/account/email", { email: "third@example.com" });
    expect(mail.sent.at(-1)!.to).toBe("third@example.com");
    const n = mail.sent.length;
    expect((await b.post("/my-shop/account/email", { email: "fourth@example.com" })).headers.get("location")).toBe("/my-shop/account?flash=email_code#email-change");
    expect(mail.sent.length).toBe(n);

    expect((await b.post("/my-shop/account/email", { email: "OLD@example.com" })).headers.get("location")).toBe("/my-shop/account?error=email_same#email-change");
    expect((await b.post("/my-shop/account/email", { email: "not-an-email" })).headers.get("location")).toBe("/my-shop/account?error=invalid_email#email-change");
  });

  it("コードを送った後に、ほかの会員がそのアドレスを使い始めたら変えない（unavailable）", async () => {
    const { sb, mail, b } = setup();
    await memberLogin(b, mail, "/my-shop", "old@example.com");
    await b.post("/my-shop/account/email", { email: "new@example.com" });
    const code = mail.code("new@example.com");
    sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: sb.tables.customers[0]!["shop_id"], email: "new@example.com", session_epoch: 0 });
    expect((await b.post("/my-shop/account/email/verify", { code })).headers.get("location")).toBe("/my-shop/account?error=email_unavailable#email-change");
    expect(sb.tables.customers[0]!["email"]).toBe("old@example.com");
  });

  it("コードは始めたセッションだけで使える（同じ会員のほかの端末からは使えない）", async () => {
    const { sb, app, mail, b } = setup();
    await memberLogin(b, mail, "/my-shop", "old@example.com");
    const other = new Browser(app);
    await memberLogin(other, mail, "/my-shop", "old@example.com");
    await b.post("/my-shop/account/email", { email: "new@example.com" });
    const code = mail.code("new@example.com");
    expect((await other.post("/my-shop/account/email/verify", { code })).headers.get("location")).toBe("/my-shop/account?error=email_code_expired#email-change");
    expect(sb.tables.customers[0]!["email"]).toBe("old@example.com");
    // 始めた端末では使える（ほかの端末の試しで消えていない）
    expect((await b.post("/my-shop/account/email/verify", { code })).headers.get("location")).toBe("/my-shop/account?flash=email_changed");
    expect(sb.tables.customers[0]!["email"]).toBe("new@example.com");
  });

  it("前のアドレスへの知らせに出す新しいアドレスは、頭の 1 文字と @ 以降だけ", () => {
    expect(maskEmail("new@example.com")).toBe("n***@example.com");
    expect(maskEmail("あいう@example.jp")).toBe("あ***@example.jp");
    expect(maskEmail("broken")).toBe("***");
  });

  it("フォームの送信（navigate）だけ受ける", async () => {
    const { sb, mail, b } = setup();
    await memberLogin(b, mail, "/my-shop", "old@example.com");
    const cors = { headers: { "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" } };
    expect((await b.post("/my-shop/account/email", { email: "new@example.com" }, cors)).status).toBe(403);
    expect((await b.post("/my-shop/account/email/verify", { code: "123456" }, cors)).status).toBe(403);
    expect(sb.memberEmailChanges).toHaveLength(0);
  });

  it("0166 の前は欄を出さず、送っても 404", async () => {
    const { mail, b } = setup({ migrated: false });
    await memberLogin(b, mail, "/my-shop", "old@example.com");
    const html = await (await b.get("/my-shop/account")).text();
    expect(html).not.toContain("/account/email");
    expect((await b.post("/my-shop/account/email", { email: "new@example.com" })).status).toBe(404);
    expect((await b.post("/my-shop/account/email/verify", { code: "123456" })).status).toBe(404);
  });
});

describe("ヘッドレスの会員 API: メールアドレスの変更", () => {
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
    return { access: String(v.json["access_token"]), refresh: String(v.json["refresh_token"]) };
  }

  it("{ email } → 202、{ code } → 新しいトークン。ほかの端末のトークンは使えなくなる", async () => {
    const { sb, mail, app } = setup();
    const call = api(app);
    const t = await login(call, mail, "old@example.com");
    const other = await login(call, mail, "old@example.com");

    expect(await call("/api/shops/my-shop/members/email", { email: "new@example.com" }, t.access)).toMatchObject({ status: 202, json: { ok: true } });
    expect(await call("/api/shops/my-shop/members/email/verify", { code: "abc" }, t.access)).toMatchObject({ status: 400, json: { error: "invalid_code" } });
    const before = mail.sent.length;
    const r = await call("/api/shops/my-shop/members/email/verify", { code: mail.code("new@example.com") }, t.access);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ member: { email: "new@example.com" } });
    expect(typeof r.json["access_token"]).toBe("string");
    expect(sb.tables.customers[0]!["email"]).toBe("new@example.com");
    expect(mail.sent.slice(before).map((m) => m.to).sort()).toEqual(["new@example.com", "old@example.com"]);

    // 新しいトークンで続く。前のトークン・ほかの端末は世代が合わない
    expect((await call("/api/shops/my-shop/members/me", undefined, String(r.json["access_token"]))).json).toMatchObject({ email: "new@example.com" });
    expect((await call("/api/shops/my-shop/members/me", undefined, other.access)).status).toBe(401);
    expect((await call("/api/shops/my-shop/members/refresh", { refresh_token: other.refresh })).status).toBe(401);
  });

  it("エラー: reauth_required・invalid_email・same_email・expired・unavailable・429（1 日のメールの上限）", async () => {
    const { sb, mail, app, age } = setup();
    const call = api(app);
    const t = await login(call, mail, "old@example.com");
    expect(await call("/api/shops/my-shop/members/email", { email: "bad" }, t.access)).toMatchObject({ status: 400, json: { error: "invalid_email" } });
    expect(await call("/api/shops/my-shop/members/email", { email: "old@example.com" }, t.access)).toMatchObject({ status: 400, json: { error: "same_email" } });
    expect(await call("/api/shops/my-shop/members/email/verify", { code: "123456" }, t.access)).toMatchObject({ status: 400, json: { error: "expired" } });

    await call("/api/shops/my-shop/members/email", { email: "new@example.com" }, t.access);
    const code = mail.code("new@example.com");
    sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: sb.tables.customers[0]!["shop_id"], email: "new@example.com", session_epoch: 0 });
    expect(await call("/api/shops/my-shop/members/email/verify", { code }, t.access)).toMatchObject({ status: 409, json: { error: "unavailable" } });

    sb.siteSettings["plan_limits"] = { mail_per_day: sb.memberChallenges.length + sb.memberEmailChanges.length };
    expect(await call("/api/shops/my-shop/members/email", { email: "third@example.com" }, t.access)).toMatchObject({ status: 429, json: { error: "plan_limit_exceeded" } });
    delete sb.siteSettings["plan_limits"];

    age(16);
    expect(await call("/api/shops/my-shop/members/email", { email: "third@example.com" }, t.access)).toMatchObject({ status: 403, json: { error: "reauth_required" } });
    expect(await call("/api/shops/my-shop/members/email/verify", { code: "123456" }, t.access)).toMatchObject({ status: 403, json: { error: "reauth_required" } });
    expect(await call("/api/shops/my-shop/members/email", { email: "third@example.com" })).toMatchObject({ status: 401 });
  });

  it("コードのメールは応答の後に送る（Workers の waitUntil）", async () => {
    const { mail, app } = setup();
    const call = api(app);
    const t = await login(call, mail, "old@example.com");
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined, props: {} };
    const before = mail.sent.length;
    const res = await app.request(
      `${BASE}/api/shops/my-shop/members/email`,
      { method: "POST", headers: { origin: "https://wp.example.com", authorization: `Bearer ${t.access}`, "content-type": "application/json" }, body: JSON.stringify({ email: "new@example.com" }) },
      undefined,
      ctx,
    );
    expect(res.status).toBe(202);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(mail.sent.length).toBe(before + 1);
    expect(mail.sent.at(-1)!.to).toBe("new@example.com");
  });

  it("0166 の前は 409 migration_required", async () => {
    const { mail, app } = setup({ migrated: false });
    const call = api(app);
    const t = await login(call, mail, "old@example.com");
    expect(await call("/api/shops/my-shop/members/email", { email: "new@example.com" }, t.access)).toMatchObject({ status: 409, json: { error: "migration_required" } });
    expect(await call("/api/shops/my-shop/members/email/verify", { code: "123456" }, t.access)).toMatchObject({ status: 409, json: { error: "migration_required" } });
  });
});
