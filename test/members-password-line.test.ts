import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, externalHosts, memberLogin, memberMail } from "./helpers";
import { wooImporter } from "../src/modules/woo-import/client";

const WP68 = "$wp$2y$04$LbPQKS0GYZkujhJfiXGPYuVhBv.W.pfX642dRDefV8RHGhyAgUzP6";
const PLAIN_2Y = "$2y$04$yVrPNwUYByYeSfH7HyRxgeP3sZIfYq.3l7L5FunvOXnyan3vxnaJC";

let disposers: (() => void)[] = [];
afterEach(() => {
  disposers.forEach((d) => d());
  disposers = [];
});

/** 偽の LINE と Google（トークン・検証の API）。code → 利用者。クライアントの ID とシークレットはショップごと */
function fakeProviders(users: Record<string, { sub: string; email?: string; verified?: boolean }>, clients: Record<string, string>) {
  const calls: { url: string; form: Record<string, string> }[] = [];
  const nonces = new Map<string, string>();
  const ok = (form: Record<string, string>) => clients[form["client_id"]!] === form["client_secret"] && Boolean(form["code_verifier"]) && Boolean(users[form["code"]!]);
  externalHosts.set("https://api.line.me/", async (req) => {
    const form = Object.fromEntries(new URLSearchParams(await req.text()));
    calls.push({ url: req.url, form });
    if (req.url.endsWith("/oauth2/v2.1/token")) return ok(form) ? Response.json({ id_token: `idt-${form["code"]}` }) : new Response("{}", { status: 400 });
    const code = (form["id_token"] ?? "").replace(/^idt-/, "");
    const u = users[code];
    if (!u) return new Response("{}", { status: 400 });
    return Response.json({ iss: "https://access.line.me", sub: u.sub, aud: form["client_id"], nonce: form["nonce"], ...(u.email ? { email: u.email } : {}) });
  });
  externalHosts.set("https://oauth2.googleapis.com/", async (req) => {
    const form = Object.fromEntries(new URLSearchParams(await req.text()));
    calls.push({ url: req.url, form });
    if (!ok(form)) return new Response("{}", { status: 400 });
    const u = users[form["code"]!]!;
    const payload = { iss: "https://accounts.google.com", aud: form["client_id"], sub: u.sub, nonce: nonces.get(form["code"]!), exp: Math.floor(Date.now() / 1000) + 3600, ...(u.email ? { email: u.email, email_verified: u.verified ?? true } : {}) };
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return Response.json({ id_token: `${b64({ alg: "RS256" })}.${b64(payload)}.sig` });
  });
  disposers.push(() => {
    externalHosts.delete("https://api.line.me/");
    externalHosts.delete("https://oauth2.googleapis.com/");
  });
  return { calls, nonces };
}

function setup(opts: { password?: boolean; line?: boolean } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "マイショップ",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    settings: { members_enabled: true, members_password: opts.password ?? true, modules: { line_login: opts.line ?? true, google_login: opts.line ?? true, woo_import: true }, headless: { return_origins: ["https://wp.example.com"] } },
  });
  const mail = memberMail(sb, shop.id);
  disposers.push(mail.dispose);
  const app = appWith(sb, { RESEND_API_KEY: "re_test" });
  return { sb, shop, mail, app, b: new Browser(app) };
}

/** 運営者が管理画面でショップの提供元を設定する */
async function configure(app: ReturnType<typeof appWith>, shopId: string, p: "line" | "google", clientId: string, secret: string): Promise<Browser> {
  const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
  const res = await admin.post(`/admin/shops/${shopId}/modules/${p}-login`, { client_id: clientId, client_secret: secret });
  expect(res.headers.get("location")).toBe(`/admin/shops/${shopId}/modules/${p}-login?flash=saved`);
  return admin;
}

/** 提供元の同意画面から戻ってきたことにする */
async function oauthCallback(b: Browser, start: Response, code: string, fake: { nonces: Map<string, string> }): Promise<Response> {
  const auth = new URL(start.headers.get("location")!);
  const p = auth.hostname === "access.line.me" ? "line" : "google";
  expect(auth.origin + auth.pathname).toBe(p === "line" ? "https://access.line.me/oauth2/v2.1/authorize" : "https://accounts.google.com/o/oauth2/v2/auth");
  expect(auth.searchParams.get("redirect_uri")).toBe(`${BASE}/_oauth/${p}/callback`);
  expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
  fake.nonces.set(code, auth.searchParams.get("nonce")!);
  return b.get(`/_oauth/${p}/callback?code=${code}&state=${auth.searchParams.get("state")}`);
}

describe("会員のパスワード（店ごと、0013）", () => {
  it("取り込んだ WordPress のパスワードでログインできる。間違いが続くとしばらく入れない（コードでは入れる）", async () => {
    const { sb, shop, mail, b, app } = setup();
    sb.legacyPasswords.set(WP68, "secret-pass-1");
    sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: shop.id, email: "wp@example.com", name: null, default_address: null, session_epoch: 0, legacy_password_hash: WP68 });

    const html = await (await b.get("/my-shop/account/login")).text();
    expect(html).toContain('action="/my-shop/account/password-login"');
    expect(html).toContain('autocomplete="current-password"');

    let res = await b.post("/my-shop/account/password-login", { email: "wp@example.com", password: "wrong" });
    expect(res.headers.get("location")).toBe("/my-shop/account/login?error=password&email=wp%40example.com");
    expect(await (await b.get(res.headers.get("location")!)).text()).toContain("メールアドレスかパスワードが正しくありません");
    res = await b.post("/my-shop/account/password-login", { email: "WP@example.com", password: "secret-pass-1" });
    expect(res.headers.get("location")).toBe("/my-shop/account");
    expect(await (await b.get("/my-shop/account")).text()).toContain("パスワードを変える");

    const c = new Browser(app);
    for (let i = 0; i < 5; i++) await c.post("/my-shop/account/password-login", { email: "wp@example.com", password: `x${i}` });
    res = await c.post("/my-shop/account/password-login", { email: "wp@example.com", password: "secret-pass-1" });
    expect(res.headers.get("location")).toContain("error=locked");
    expect(await (await c.get("/my-shop/account/login?error=locked")).text()).toContain("メールのコードでログインしてください");
    await memberLogin(c, mail, "/my-shop", "wp@example.com");
  });

  it("マイページでパスワードを決める（8 文字以上）。ほかの端末はログアウトし、この端末は続く", async () => {
    const { mail, app, b } = setup();
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    const other = new Browser(app);
    await memberLogin(other, mail, "/my-shop", "member@example.com");
    expect(await (await b.get("/my-shop/account")).text()).toContain("パスワードを決める");
    expect((await b.post("/my-shop/account/password", { password: "short" })).headers.get("location")).toBe("/my-shop/account?error=weak");
    expect((await b.post("/my-shop/account/password", { password: "new-password-1" })).headers.get("location")).toBe("/my-shop/account?flash=password_saved");
    expect((await b.get("/my-shop/account")).status).toBe(200);
    expect((await other.get("/my-shop/account")).headers.get("location")).toBe("/my-shop/account/login");
    expect((await new Browser(app).post("/my-shop/account/password-login", { email: "member@example.com", password: "new-password-1" })).headers.get("location")).toBe("/my-shop/account");
  });

  it("パスワードでのログインを知らせる（0016）: 初めての端末だけ。コードでログインした端末からは送らない。ヘッドレスは毎回", async () => {
    const { mail, app, b } = setup();
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    await b.post("/my-shop/account/password", { password: "new-password-1" });
    const notices = () => mail.sent.filter((m) => m.subject.includes("パスワードでログインしました"));

    // コードでログインしたことのある端末: 知らせない
    await b.post("/my-shop/account/logout", {});
    expect((await b.post("/my-shop/account/password-login", { email: "member@example.com", password: "new-password-1" })).headers.get("location")).toBe("/my-shop/account");
    expect(notices()).toHaveLength(0);

    // 初めての端末: 知らせる。2 回目からは知らせない
    const other = new Browser(app);
    await other.post("/my-shop/account/password-login", { email: "member@example.com", password: "new-password-1" });
    expect(notices()).toHaveLength(1);
    const n = notices()[0]!;
    expect(n.to).toBe("member@example.com");
    expect(n.text).toContain("http://localhost:8787/my-shop/account");
    expect(n.html).toContain("パスワードでログインしました");
    await other.post("/my-shop/account/logout", {});
    await other.post("/my-shop/account/password-login", { email: "member@example.com", password: "new-password-1" });
    expect(notices()).toHaveLength(1);

    // 失敗では送らない
    await new Browser(app).post("/my-shop/account/password-login", { email: "member@example.com", password: "wrong-password" });
    expect(notices()).toHaveLength(1);

    // ヘッドレス: 毎回
    const api = await app.request(`${BASE}/api/shops/my-shop/members/password-login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "member@example.com", password: "new-password-1" }) });
    expect(api.status).toBe(200);
    expect(notices()).toHaveLength(2);
  });

  it("ログインのメールは HTML も付ける（ショップの色・ロゴ、値はエスケープ）", async () => {
    const { sb, shop, mail, b } = setup();
    const row = sb.tables.shops.find((x) => x["id"] === shop.id)!;
    row["name"] = "<b>店</b>";
    row["settings"] = { ...(row["settings"] as Record<string, unknown>), theme_settings: { accent_color: "#ff0066", logo_url: "https://cdn.example.com/logo.png" } };
    await b.post("/my-shop/account/login", { email: "m@example.com" });
    const m = mail.sent.at(-1)!;
    const code = mail.code("m@example.com");
    expect(m.text).toContain(code);
    expect(m.html).toContain(code);
    expect(m.html).toContain("#ff0066");
    expect(m.html).toContain('src="https://cdn.example.com/logo.png"');
    expect(m.html).toContain("&lt;b&gt;店&lt;/b&gt;");
    expect(m.html).not.toContain("<b>店</b>");
    expect(m.html).toContain('href="http://localhost:8787/my-shop/account/verify?c=');
  });

  it("店の設定が OFF ならパスワードの画面も経路も無い", async () => {
    const { mail, b } = setup({ password: false });
    expect(await (await b.get("/my-shop/account/login")).text()).not.toContain("password-login");
    expect((await b.post("/my-shop/account/password-login", { email: "a@example.com", password: "x" })).status).toBe(404);
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    expect(await (await b.get("/my-shop/account")).text()).not.toContain('name="password"');
  });

  it("ヘッドレス: password-login でトークン、password で決め直すと新しいトークン", async () => {
    const { sb, shop, app } = setup();
    sb.legacyPasswords.set(PLAIN_2Y, "plain-pass-2");
    sb.tables.customers.push({ id: crypto.randomUUID(), shop_id: shop.id, email: "h@example.com", session_epoch: 0, legacy_password_hash: PLAIN_2Y });
    const api = async (path: string, body: unknown, token?: string) => {
      const res = await app.request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    expect(await api("/api/shops/my-shop/members/password-login", { email: "h@example.com", password: "bad" })).toEqual({ status: 401, json: { error: "invalid_password" } });
    const r = await api("/api/shops/my-shop/members/password-login", { email: "h@example.com", password: "plain-pass-2" });
    expect(r.status).toBe(200);
    const r2 = await api("/api/shops/my-shop/members/password", { password: "brand-new-pass" }, r.json["access_token"] as string);
    expect(r2.status).toBe(200);
    // 古いトークンは世代が変わったので会員の読み取りに使えない
    const me = await app.request(`${BASE}/api/shops/my-shop/members/me`, { headers: { authorization: `Bearer ${r.json["access_token"]}` } });
    expect(me.status).toBe(401);
    const me2 = await app.request(`${BASE}/api/shops/my-shop/members/me`, { headers: { authorization: `Bearer ${r2.json["access_token"]}` } });
    expect(me2.status).toBe(200);
  });

  it("WooCommerce の取り込み: wp_users の CSV から bcrypt の形式だけを送る。設定が OFF なら 409", async () => {
    const w = wooImporter();
    const csv = `"ID","user_login","user_pass","user_email"\r\n"1","a","${WP68}","A@example.com"\r\n"2","b","$P$Bxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","b@example.com"\r\n"3","c","${PLAIN_2Y}","c@example.com"\r\n"4","d","${PLAIN_2Y}","a@example.com"\r\n`;
    expect(w.passwordRows(csv)).toEqual({ rows: [{ email: "a@example.com", hash: WP68 }, { email: "c@example.com", hash: PLAIN_2Y }], old: 1 });
    expect(w.passwordRows("x,y\r\n1,2\r\n")).toBeNull();

    const { sb, shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/woo-import`;
    expect(await (await admin.get(base)).text()).toContain('data-wc-passwords=""');
    const res = await admin.postJson(`${base}/customers/passwords`, { rows: [{ email: "a@example.com", hash: WP68 }, { email: "old@example.com", hash: "$P$Bxxxx" }] });
    expect(await res.json()).toMatchObject({ imported: 1, created: 1, skipped_format: 1 });
    expect(sb.tables.customers.find((c) => c["email"] === "a@example.com")).toMatchObject({ legacy_password_hash: WP68 });

    const off = setup({ password: false });
    const admin2 = await Browser.loggedIn(off.app, "owner@example.com", "password-123");
    const base2 = `/admin/shops/${off.shop.id}/modules/woo-import`;
    expect(await (await admin2.get(base2)).text()).not.toContain('data-wc-passwords=""');
    expect((await admin2.postJson(`${base2}/customers/passwords`, { rows: [{ email: "a@example.com", hash: WP68 }] })).status).toBe(409);
  });
});

describe("LINE・Google でログイン（ショップごとの設定、0014）", () => {
  it("管理画面で設定する: シークレットは暗号化して保存し、画面に出さない。設定が無いあいだはボタンが出ない", async () => {
    const { sb, shop, app, b } = setup();
    expect(await (await b.get("/my-shop/account/login")).text()).not.toContain("/account/oauth/");
    const admin = await configure(app, shop.id, "line", "1234567890", "line-secret-of-shop");
    const row = sb.oauthClients.find((x) => x["provider"] === "line")!;
    expect(row["client_id"]).toBe("1234567890");
    expect(String(row["secret_box"])).toMatch(/^v1\./);
    expect(String(row["secret_box"])).not.toContain("line-secret-of-shop");
    const page = await (await admin.get(`/admin/shops/${shop.id}/modules/line-login`)).text();
    expect(page).toContain(`${BASE}/_oauth/line/callback`);
    expect(page).not.toContain("line-secret-of-shop");
    expect(page).toContain("設定済み");
    // シークレットを空で保存すると client_id だけ変わる
    await admin.post(`/admin/shops/${shop.id}/modules/line-login`, { client_id: "1234567891", client_secret: "" });
    expect(sb.oauthClients.find((x) => x["provider"] === "line")).toMatchObject({ client_id: "1234567891", secret_box: row["secret_box"] });
    // ストアフロント（ショップ行は 30 秒キャッシュ）: 新しいインスタンスで見る
    const fresh = new Browser(appWith(sb, { RESEND_API_KEY: "re_test" }));
    expect(await (await fresh.get("/my-shop/account/login")).text()).toContain('href="/my-shop/account/oauth/line"');
    await admin.post(`/admin/shops/${shop.id}/modules/line-login/delete`, {});
    expect(sb.oauthClients).toHaveLength(0);
  });

  it("LINE でログイン（初回は会員登録、2 回目は同じ会員）。ショップのシークレットで LINE と話す。state が合わなければ何もしない", async () => {
    const { sb, shop, app } = setup();
    await configure(app, shop.id, "line", "line-channel", "line-secret");
    const fake = fakeProviders({ good: { sub: "U1" } }, { "line-channel": "line-secret" });
    const b = new Browser(appWith(sb, { RESEND_API_KEY: "re_test" }));
    expect(await (await b.get("/my-shop/account/login")).text()).toContain('href="/my-shop/account/oauth/line"');
    let start = await b.get("/my-shop/account/oauth/line");
    expect(start.headers.getSetCookie().find((c) => c.startsWith("banto_oauth="))).toContain("Path=/_oauth");
    const auth = new URL(start.headers.get("location")!);
    expect(auth.searchParams.get("client_id")).toBe("line-channel");
    expect((await new Browser(app).get(`/_oauth/line/callback?code=good&state=${auth.searchParams.get("state")}`)).status).toBe(400);
    expect((await b.get(`/_oauth/line/callback?code=good&state=wrong`)).status).toBe(400);

    start = await b.get("/my-shop/account/oauth/line");
    let res = await oauthCallback(b, start, "good", fake);
    expect(res.headers.get("location")).toBe("/my-shop/account");
    expect(fake.calls.find((c) => c.url.endsWith("/token"))!.form).toMatchObject({ client_id: "line-channel", client_secret: "line-secret", redirect_uri: `${BASE}/_oauth/line/callback` });
    expect(sb.tables.customers).toHaveLength(1);
    expect(await (await b.get("/my-shop/account")).text()).toContain("LINE と連携しています");

    const again = new Browser(appWith(sb, { RESEND_API_KEY: "re_test" }));
    res = await oauthCallback(again, await again.get("/my-shop/account/oauth/line"), "good", fake);
    expect(res.headers.get("location")).toBe("/my-shop/account");
    expect(sb.tables.customers).toHaveLength(1);
    expect((await again.post("/my-shop/account/oauth/line/unlink", {})).headers.get("location")).toBe("/my-shop/account?error=last_method");
  });

  it("Google: 確認済みのアドレスなら既存の会員に結びつく。未確認なら結びつけない。ログイン中の会員は自分で連携・解除できる", async () => {
    const { sb, shop, mail, app } = setup();
    await configure(app, shop.id, "google", "shop-a.apps.googleusercontent.com", "google-secret-a");
    const fake = fakeProviders({ verified: { sub: "G1", email: "member@example.com" }, unverified: { sub: "G2", email: "member@example.com", verified: false } }, { "shop-a.apps.googleusercontent.com": "google-secret-a" });
    const fresh = () => new Browser(appWith(sb, { RESEND_API_KEY: "re_test" }));
    const b = fresh();
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    const id = sb.tables.customers[0]!["id"];

    const viaGoogle = fresh();
    let start = await viaGoogle.get("/my-shop/account/oauth/google");
    expect(new URL(start.headers.get("location")!).searchParams.get("prompt")).toBe("select_account");
    expect((await oauthCallback(viaGoogle, start, "verified", fake)).headers.get("location")).toBe("/my-shop/account");
    expect(sb.memberIdentities[0]).toMatchObject({ customer_id: id, provider: "google", subject: "G1" });

    const other = fresh();
    await oauthCallback(other, await other.get("/my-shop/account/oauth/google"), "unverified", fake);
    expect(sb.tables.customers).toHaveLength(2);
    expect(sb.tables.customers[1]).toMatchObject({ email: null });

    expect((await b.post("/my-shop/account/oauth/google/unlink", {})).headers.get("location")).toBe("/my-shop/account?flash=oauth_unlinked");
    start = await b.post("/my-shop/account/oauth/google/link", {});
    expect((await oauthCallback(b, start, "unverified", fake)).headers.get("location")).toBe("/my-shop/account?error=already_linked");
    start = await b.post("/my-shop/account/oauth/google/link", {});
    expect((await oauthCallback(b, start, "verified", fake)).headers.get("location")).toBe("/my-shop/account?flash=oauth_linked");
  });

  it("シークレットが違う（サイトの秘密が変わった・別のショップの暗号文）ならログインしない", async () => {
    const { sb, shop, app } = setup();
    await configure(app, shop.id, "line", "line-channel", "line-secret");
    const fake = fakeProviders({ good: { sub: "U1" } }, { "line-channel": "line-secret" });
    const changed = new Browser(appWith(sb, { RESEND_API_KEY: "re_test", SESSION_SECRET: "another-site-secret" }));
    const res = await oauthCallback(changed, await changed.get("/my-shop/account/oauth/line"), "good", fake);
    expect(res.headers.get("location")).toBe("/my-shop/account/login?error=oauth");
    expect(fake.calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(0);
  });

  it("ヘッドレス: 許可リストの戻り先に引き換え券を付けて戻し、/members/verify でトークンにする（1 回限り）", async () => {
    const { sb, shop, app } = setup();
    await configure(app, shop.id, "line", "line-channel", "line-secret");
    const fake = fakeProviders({ good: { sub: "U9" } }, { "line-channel": "line-secret" });
    const app2 = appWith(sb, { RESEND_API_KEY: "re_test" });
    const b = new Browser(app2);
    expect((await b.get("/api/shops/my-shop/members/oauth/line?return_to=https://evil.example/cb")).status).toBe(400);
    const res = await oauthCallback(b, await b.get("/api/shops/my-shop/members/oauth/line?return_to=https%3A%2F%2Fwp.example.com%2Fcb"), "good", fake);
    const back = new URL(res.headers.get("location")!);
    expect(back.origin + back.pathname).toBe("https://wp.example.com/cb");
    const handoff = back.searchParams.get("banto_handoff")!;
    const verify = (h: string) => app2.request(`${BASE}/api/shops/my-shop/members/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handoff: h }) });
    const v = await verify(handoff);
    expect(v.status).toBe(200);
    expect(((await v.json()) as Record<string, unknown>)["access_token"]).toMatch(/^bm1\./);
    expect((await verify(handoff)).status).toBe(401);
    const conf = (await (await app2.request(`${BASE}/api/shops/my-shop/members/config`)).json()) as Record<string, unknown>;
    expect(conf["login"]).toEqual(["email_code", "email_link", "password", "line"]);
  });

  it("独自ドメインのショップ（0015）: 戻り先・state の Cookie・会員の Cookie はショップのドメイン。Banto の URL から始めてもドメインへ移る", async () => {
    const { sb, shop, app } = setup();
    const DOMAIN = "https://shop.example.jp";
    sb.tables.shops.find((s) => s["id"] === shop.id)!["domain"] = "shop.example.jp";
    const admin = await configure(app, shop.id, "google", "g-client", "g-secret");
    // 管理画面に出すコールバック URL もショップのドメイン
    expect(await (await admin.get(`/admin/shops/${shop.id}/modules/google-login`)).text()).toContain(`${DOMAIN}/_oauth/google/callback`);
    const fake = fakeProviders({ good: { sub: "G1", email: "d@example.com" } }, { "g-client": "g-secret" });
    const app2 = appWith(sb, { RESEND_API_KEY: "re_test" });

    // Banto の URL のログインの入口・ヘッドレスの入口は、ドメインの同じ入口へ
    const base = new Browser(app2);
    expect((await base.get("/my-shop/account/oauth/google")).headers.get("location")).toBe(`${DOMAIN}/account/oauth/google`);
    expect((await base.get("/api/shops/my-shop/members/oauth/google?return_to=https%3A%2F%2Fwp.example.com%2Fcb")).headers.get("location")).toBe(
      `${DOMAIN}/api/shops/my-shop/members/oauth/google?return_to=https%3A%2F%2Fwp.example.com%2Fcb`,
    );

    const b = new Browser(app2, DOMAIN);
    const start = await b.get("/account/oauth/google");
    const auth = new URL(start.headers.get("location")!);
    expect(auth.searchParams.get("redirect_uri")).toBe(`${DOMAIN}/_oauth/google/callback`);
    expect(start.headers.getSetCookie().some((c) => c.startsWith("banto_oauth=") && c.includes("Path=/_oauth"))).toBe(true);
    fake.nonces.set("good", auth.searchParams.get("nonce")!);
    const back = await b.get(`/_oauth/google/callback?code=good&state=${auth.searchParams.get("state")}`);
    expect(back.headers.get("location")).toBe("/account");
    expect(back.headers.getSetCookie().some((c) => c.startsWith("banto_member_") && c.includes("Path=/;"))).toBe(true);
    // 提供元にも同じ戻り先を渡す（違えば提供元が断る）
    expect(fake.calls.at(-1)!.form["redirect_uri"]).toBe(`${DOMAIN}/_oauth/google/callback`);
    expect(await (await b.get("/account")).text()).toContain("d@example.com");
  });

  it("モジュールが OFF なら設定画面も入口も無い", async () => {
    const { shop, app, b } = setup({ line: false });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect((await admin.get(`/admin/shops/${shop.id}/modules/line-login`)).status).toBe(404);
    expect((await b.get("/my-shop/account/oauth/line")).status).toBe(404);
  });
});
