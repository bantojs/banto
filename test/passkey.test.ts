import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, memberLogin, memberMail } from "./helpers";
import { createCredential, getAssertion, b64u, type FakeCredential } from "./webauthn-authenticator";
import { userHandleOf } from "../src/members/webauthn";

const DOMAIN = "shop.example.jp";
const SHOP_URL = `https://${DOMAIN}`;
const EXPECTED = { origin: SHOP_URL, rpId: DOMAIN };

let disposers: (() => void)[] = [];
afterEach(() => {
  disposers.forEach((d) => d());
  disposers = [];
  vi.useRealTimers();
});

function setup(opts: { module?: boolean; domain?: string | null } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, {
    slug: "my-shop",
    name: "マイショップ",
    published: true,
    legal_notice: "a",
    privacy_policy: "b",
    return_policy: "c",
    domain: opts.domain === undefined ? DOMAIN : opts.domain,
    settings: { members_enabled: true, modules: { passkey: opts.module ?? true }, headless: { return_origins: ["https://wp.example.com"] } },
  });
  const mail = memberMail(sb, shop.id);
  disposers.push(mail.dispose);
  const app = appWith(sb, { RESEND_API_KEY: "re_test" });
  return { sb, shop, mail, app, b: new Browser(app, SHOP_URL) };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** ログイン中の Browser でパスキーを追加する */
async function addPasskey(b: Browser, sb: FakeSupabase, opts: { step?: number } = {}): Promise<FakeCredential> {
  const o = await json(await b.postJson("/account/passkey/register/options", {}));
  const pk = o["publicKey"] as { challenge: string; user: { id: string } };
  const { credential, response } = await createCredential(pk.challenge, new Uint8Array(Buffer.from(pk.user.id, "base64url")), { ...EXPECTED, step: opts.step ?? 0 });
  const r = await json(await b.postJson("/account/passkey/register", { challenge_id: o["challenge_id"], credential: response }));
  expect(r).toEqual({ redirect: "/account/passkeys?flash=added" });
  expect(sb.memberPasskeys.length).toBeGreaterThan(0);
  return credential;
}

async function passkeyLogin(b: Browser, cred: FakeCredential, o: { step?: number; returnTo?: string; mutate?: (r: Record<string, unknown>) => Record<string, unknown>; origin?: string; userHandle?: Uint8Array | null } = {}) {
  const opt = await json(await b.postJson("/account/passkey/login/options", {}));
  const challenge = (opt["publicKey"] as { challenge: string }).challenge;
  let credential = await getAssertion(cred, challenge, { ...EXPECTED, ...(o.origin ? { origin: o.origin } : {}), step: o.step ?? 0, ...(o.userHandle !== undefined ? { userHandle: o.userHandle } : {}) });
  if (o.mutate) credential = o.mutate(credential);
  const body = { challenge_id: opt["challenge_id"], credential, ...(o.returnTo ? { return_to: o.returnTo } : {}) };
  const res = await b.postJson("/account/passkey/login", body);
  return { status: res.status, json: await json(res), body };
}

describe("パスキー（同梱モジュール passkey、0046）", () => {
  it("ログイン中に追加 → 知らせのメール → ログアウト → パスキーでログイン（ショップのドメインの上）", async () => {
    const { sb, mail, b } = setup();
    await memberLogin(b, mail, "", "m@example.com");
    const cid = String(sb.tables.customers[0]!["id"]);
    let html = await (await b.get("/account")).text();
    expect(html).toContain('href="/account/passkeys"');
    html = await (await b.get("/account/passkeys")).text();
    expect(html).toContain('data-banto-passkey="register"');
    expect(html).toContain('src="/account/passkey.js"');
    const js = await b.get("/account/passkey.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).toContain("navigator.credentials.create");

    const o = await json(await b.postJson("/account/passkey/register/options", {}));
    expect(o["publicKey"]).toMatchObject({
      rp: { id: DOMAIN, name: "マイショップ" },
      user: { id: b64u(userHandleOf(cid)), name: "m@example.com" },
      attestation: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: [],
    });
    const cred = await addPasskey(b, sb);
    expect(mail.sent.at(-1)).toMatchObject({ to: "m@example.com", subject: "【マイショップ】パスキーを追加しました" });
    // 2 つ目の登録のときは、同じ認証器に重ねて作らないよう、今あるものを伝える
    const o2 = await json(await b.postJson("/account/passkey/register/options", {}));
    expect((o2["publicKey"] as { excludeCredentials: { id: string }[] }).excludeCredentials).toEqual([{ type: "public-key", id: b64u(cred.id) }]);
    expect(await (await b.get("/account/passkeys?flash=added")).text()).toContain("パスキーを追加しました");

    await b.post("/account/logout", {});
    html = await (await b.get("/account/login")).text();
    expect(html).toContain('data-banto-passkey="login"');
    const r = await passkeyLogin(b, cred);
    expect(r).toMatchObject({ status: 200, json: { redirect: "/account" } });
    expect((await b.get("/account")).status).toBe(200);
    expect(sb.memberSessions.filter((x) => !x["revoked_at"])).toHaveLength(1);
    expect(sb.memberPasskeys[0]!["last_used_at"]).toBeTruthy();
  });

  it("通さないもの: 違うオリジン・同じ challenge の使い回し・ほかの会員の ID・署名の回数の巻き戻り・消したパスキー", async () => {
    const { sb, mail, app, b } = setup();
    await memberLogin(b, mail, "", "m@example.com");
    const cred = await addPasskey(b, sb, { step: 1 });
    const fresh = () => new Browser(app, SHOP_URL);

    expect((await passkeyLogin(fresh(), cred, { origin: "https://evil.example" })).json).toEqual({ error: "failed" });
    // 同じ応答をもう一度送る（challenge は 1 回限り）
    const ok = await passkeyLogin(fresh(), cred, { step: 1 });
    expect(ok.status).toBe(200);
    const replay = await fresh().postJson("/account/passkey/login", ok.body);
    expect(await json(replay)).toEqual({ error: "expired" });
    // 認証器が返す利用者の ID が、そのパスキーの会員と違う
    expect((await passkeyLogin(fresh(), cred, { step: 1, userHandle: userHandleOf("00000000-0000-4000-8000-000000000000") })).json).toEqual({ error: "failed" });
    // 署名の回数が前より進んでいない（複製の疑い）。DB には 2 が残っている
    expect(sb.memberPasskeys[0]!["sign_count"]).toBe(2);
    cred.counter = 1;
    expect((await passkeyLogin(fresh(), cred, { step: 0 })).json).toEqual({ error: "failed" });
    expect((await passkeyLogin(fresh(), cred, { step: 1 })).json).toEqual({ error: "failed" });
    cred.counter = 2;
    // 応答の一部を壊す
    expect((await passkeyLogin(fresh(), cred, { step: 1, mutate: (x) => ({ ...x, type: "password" }) })).status).toBe(400);

    const id = String(sb.memberPasskeys[0]!["id"]);
    const del = await b.post(`/account/passkeys/${id}/delete`, {});
    expect(del.headers.get("location")).toBe("/account/passkeys?flash=deleted");
    expect((await passkeyLogin(fresh(), cred, { step: 1 })).json).toEqual({ error: "failed" });
  });

  it("追加はログインしてから 15 分以内だけ。過ぎていたらコードで確かめてから戻る", async () => {
    const { sb, mail, b } = setup();
    await memberLogin(b, mail, "", "m@example.com");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 20 * 60 * 1000);
    const html = await (await b.get("/account/passkeys")).text();
    expect(html).not.toContain('data-banto-passkey="register"');
    expect(html).toContain('name="next" value="passkeys"');
    expect(await json(await b.postJson("/account/passkey/register/options", {}))).toEqual({ error: "reauth" });

    await b.post("/account/login", { email: "m@example.com", next: "passkeys" });
    const res = await b.post("/account/code", { code: mail.code("m@example.com") });
    expect(res.headers.get("location")).toBe("/account/passkeys");
    // ログインし直した端末の前のセッションは取り消す
    expect(sb.memberSessions.filter((x) => !x["revoked_at"])).toHaveLength(1);
    expect(await (await b.get("/account/passkeys")).text()).toContain('data-banto-passkey="register"');
    await addPasskey(b, sb);
  });

  it("出さないもの: 独自ドメインの無いショップ・Banto の URL・モジュールが OFF・0046 の前", async () => {
    const noDomain = setup({ domain: null });
    const base = new Browser(noDomain.app);
    await memberLogin(base, noDomain.mail, "/my-shop", "m@example.com");
    expect(await (await base.get("/my-shop/account")).text()).not.toContain("/account/passkeys");
    expect((await base.get("/my-shop/account/passkeys")).status).toBe(404);
    expect((await base.postJson("/my-shop/account/passkey/login/options", {})).status).toBe(404);
    expect((await base.get("/my-shop/account/passkey.js")).status).toBe(404);
    disposers.forEach((d) => d());
    disposers = [];

    const off = setup({ module: false });
    expect(await (await off.b.get("/account/login")).text()).not.toContain("data-banto-passkey");
    expect((await off.b.postJson("/account/passkey/login/options", {})).status).toBe(404);
    disposers.forEach((d) => d());
    disposers = [];

    const old = setup();
    old.sb.appliedMigrations.splice(old.sb.appliedMigrations.indexOf("0046_mod_passkey"), 1);
    expect((await old.b.postJson("/account/passkey/login/options", {})).status).toBe(404);
    expect((await old.b.get("/account/passkey.js")).status).toBe(404);
  });

  it("ヘッドレス: ショップのドメインのパスキーの画面へ送り、引き換え券で連携サイトへ戻す", async () => {
    const { sb, mail, app, b } = setup();
    await memberLogin(b, mail, "", "m@example.com");
    const cred = await addPasskey(b, sb);
    const api = (path: string, init?: RequestInit) => app.request(`${BASE}${path}`, { ...init, headers: { origin: "https://wp.example.com", ...(init?.headers ?? {}) } });

    expect(((await (await api("/api/shops/my-shop/members/config")).json()) as { login: string[] }).login).toContain("passkey");
    expect((await api("/api/shops/my-shop/members/passkey?return_to=https://evil.example/cb")).status).toBe(400);
    const go = await api("/api/shops/my-shop/members/passkey?return_to=https://wp.example.com/cb");
    expect(go.status).toBe(302);
    const loc = new URL(go.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(`${SHOP_URL}/account/passkey`);

    const page = new Browser(app, SHOP_URL);
    const html = await (await page.get(`${loc.pathname}${loc.search}`)).text();
    expect(html).toContain('data-return-to="https://wp.example.com/cb"');
    // 許可リストに無い戻り先は、画面でも、ログインの本文でも使わない
    expect((await page.get("/account/passkey?return_to=https://evil.example/cb")).status).toBe(400);
    const r = await passkeyLogin(page, cred, { returnTo: "https://wp.example.com/cb" });
    const back = new URL(String(r.json["redirect"]));
    expect(`${back.origin}${back.pathname}`).toBe("https://wp.example.com/cb");
    const handoff = back.searchParams.get("banto_handoff")!;
    expect(page.cookies.size).toBe(0);

    const v = await api("/api/shops/my-shop/members/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handoff }) });
    expect(v.status).toBe(200);
    expect((await v.json()) as Record<string, unknown>).toMatchObject({ member: { email: "m@example.com" } });
    const evil = await passkeyLogin(new Browser(app, SHOP_URL), cred, { returnTo: "https://evil.example/cb" });
    expect(evil.json).toEqual({ redirect: "/account" });
  });

  it("管理画面: 会員のパスキーを全部消す（乗っ取られた会員の救済）", async () => {
    const { sb, mail, app, b, shop } = setup();
    await memberLogin(b, mail, "", "m@example.com");
    await addPasskey(b, sb);
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const cid = String(sb.tables.customers[0]!["id"]);
    expect(await (await admin.get(`/admin/shops/${shop.id}/customers`)).text()).toContain(`/customers/${cid}/passkeys/reset`);
    const res = await admin.post(`/admin/shops/${shop.id}/customers/${cid}/passkeys/reset`, {});
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/customers?flash=passkeys_reset`);
    expect(sb.memberPasskeys).toHaveLength(0);
  });
});
