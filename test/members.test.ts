import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { FakeStripe } from "./fake-stripe";
import { ADDRESS, BASE, Browser, WEBHOOK_SECRET, appWith, confirmAddress, memberLogin, memberMail } from "./helpers";
import { customerCookieName } from "../src/routes/storefront/members";

let disposers: (() => void)[] = [];
afterEach(() => {
  disposers.forEach((d) => d());
  disposers = [];
});

function setup(opts: { members?: boolean; mail?: boolean } = {}) {
  const sb = new FakeSupabase();
  const stripe = new FakeStripe();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", stripe_account_id: "acct_connected", settings: { members_enabled: opts.members ?? true } });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true });
  const sku = sb.addSku(shop.id, tee.id, { code: "TEE-M", price_jpy: 3000, available: 10 });
  const mail = memberMail(sb, shop.id);
  disposers.push(mail.dispose);
  if (opts.mail === false) sb.tables.hook_endpoints.length = 0;
  const app = appWith(sb, { RESEND_API_KEY: "re_test" }, undefined, stripe);
  return { sb, stripe, shop, sku, app, mail, b: new Browser(app) };
}

describe("会員機能（店ごとのアカウント・パスワードなし）", () => {
  it("無効なら会員ページは 404 でヘッダにも導線が無い", async () => {
    const { b } = setup({ members: false });
    expect((await b.get("/my-shop/account")).status).toBe(404);
    expect((await b.get("/my-shop/account/login")).status).toBe(404);
    expect((await b.post("/my-shop/account/login", { email: "m@example.com" })).status).toBe(404);
    expect(await (await b.get("/my-shop")).text()).not.toContain("/my-shop/account");
  });

  it("メールのコードで入ると会員になる → 住所保存 → チェックアウトに自動入力 → 注文が履歴に出る → 退会", async () => {
    const { sb, stripe, shop, sku, app, mail, b } = setup();
    let html = await (await b.get("/my-shop")).text();
    expect(html).toContain('href="/my-shop/account"');
    expect((await b.get("/my-shop/account")).headers.get("location")).toBe("/my-shop/account/login");

    html = await (await b.get("/my-shop/account/login")).text();
    expect(html).toContain('action="/my-shop/account/login"');
    expect(html).not.toContain('type="password"');
    expect(html).toContain('href="/my-shop/privacy"');

    let res = await b.post("/my-shop/account/login", { email: " Member@Example.com " });
    expect(res.headers.get("location")).toBe("/my-shop/account/code");
    const m = mail.sent.at(-1)!;
    expect(m).toMatchObject({ from: "Shop <shop@example.com>", to: "member@example.com" });
    expect(m.subject).toMatch(/^【マイショップ】ログインのコード：[0-9]{6}$/);
    expect(m.text).toContain(`${BASE}/my-shop/account/verify?c=`);
    html = await (await b.get("/my-shop/account/code")).text();
    expect(html).toContain("member@example.com");
    expect(html).toContain('autocomplete="one-time-code"');

    res = await b.post("/my-shop/account/code", { code: mail.code("member@example.com") });
    expect(res.headers.get("location")).toBe("/my-shop/account");
    const cookie = res.headers.getSetCookie().find((x) => x.startsWith(`${customerCookieName(shop.id)}=`))!;
    expect(cookie).toContain("Path=/my-shop");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain(`Max-Age=${60 * 60 * 24 * 30}`);
    // 会員は owner にならず、Supabase Auth のユーザーも作らない
    expect(sb.owners.size).toBe(1);
    expect(sb.users.size).toBe(1);
    expect(sb.tables.customers).toHaveLength(1);
    expect(sb.tables.customers[0]).toMatchObject({ shop_id: shop.id, email: "member@example.com" });

    res = await b.get("/my-shop/account");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    html = await res.text();
    expect(html).toContain("member@example.com");
    expect(html).toContain("ご注文はまだありません");

    res = await b.post("/my-shop/account/address", { customer_name: "会員 花子", phone: "0901234567", postal_code: "530-0001", state: "大阪府", city: "大阪市北区", line1: "梅田1-1", line2: "" });
    expect(res.headers.get("location")).toBe("/my-shop/account?flash=saved");
    expect(sb.tables.customers[0]).toMatchObject({ name: "会員 花子", default_address: { state: "大阪府", city: "大阪市北区", phone: "0901234567" } });

    await b.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    html = await (await b.post("/my-shop/checkout", { provider: "stripe" })).text();
    expect(html).toContain('value="会員 花子"');
    expect(html).toContain('value="member@example.com"');
    expect(html).toContain('<option value="大阪府" selected');

    res = await confirmAddress(b, "/my-shop", "stripe", { ...ADDRESS, customer_email: "member@example.com", state: "大阪府" });
    expect(res.status).toBe(303);
    expect(sb.tables.reservations[0]!["customer_id"]).toBe(sb.tables.customers[0]!["id"]);
    const [sessionId] = [...stripe.sessions.keys()];
    await stripe.deliver(app, BASE, stripe.event(sessionId!, "checkout.session.completed"), WEBHOOK_SECRET);
    expect(sb.tables.orders[0]!["customer_id"]).toBe(sb.tables.customers[0]!["id"]);
    html = await (await b.get("/my-shop/account")).text();
    expect(html).toContain(String(sb.tables.orders[0]!["number"]));

    // 別の会員には見えない
    const other = new Browser(app);
    await memberLogin(other, mail, "/my-shop", "other@example.com");
    expect(await (await other.get("/my-shop/account")).text()).toContain("ご注文はまだありません");

    res = await b.post("/my-shop/account/delete", {});
    expect(res.headers.get("location")).toBe("/my-shop");
    expect(sb.tables.customers.find((x) => x["email"] === "member@example.com")).toBeUndefined();
    expect(sb.tables.orders).toHaveLength(1); // 注文は残る
    expect((await b.get("/my-shop/account")).headers.get("location")).toBe("/my-shop/account/login");
  });

  it("2 回目のログインは同じ会員。コードを間違えたら言い直せる。5 回で無効になり、送り直しを案内する", async () => {
    const { sb, app, mail, b } = setup();
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    const id = sb.tables.customers[0]!["id"];
    const again = new Browser(app);
    await memberLogin(again, mail, "/my-shop", "member@example.com");
    expect(sb.tables.customers).toHaveLength(1);
    expect(sb.tables.customers[0]!["id"]).toBe(id);

    const c = new Browser(app);
    await c.post("/my-shop/account/login", { email: "member@example.com" });
    const right = mail.code("member@example.com");
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) expect((await c.post("/my-shop/account/code", { code: wrong })).headers.get("location")).toBe("/my-shop/account/code?error=failed");
    expect(await (await c.get("/my-shop/account/code?error=failed")).text()).toContain("コードが正しくありません");
    expect((await c.post("/my-shop/account/code", { code: wrong })).headers.get("location")).toBe("/my-shop/account/login?error=expired");
    // 5 回目で無効。正しいコードでももう入れない（照合中のチャレンジも消える）
    expect((await c.post("/my-shop/account/code", { code: right })).headers.get("location")).toBe("/my-shop/account/login");
    expect(await (await c.get("/my-shop/account/login?error=expired")).text()).toContain("もう一度コードを送ってください");
  });

  it("メールのリンク: GET では使わず確認画面（伏せたアドレス・Referrer-Policy）、ボタンで入る。使ったリンクは無効", async () => {
    const { mail, b, app } = setup();
    await b.post("/my-shop/account/login", { email: "taro@example.com" });
    const link = mail.link("taro@example.com").replace(BASE, "");
    // 別のブラウザ（スマホでメールを開いた）でも入れる
    const phone = new Browser(app);
    let res = await phone.get(link);
    expect(res.status).toBe(200);
    // 外のサイトには Referer を送らない（no-referrer だとフォームの POST が Origin: null になり、csrfGuard に拒まれる）
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const html = await res.text();
    expect(html).toContain("t***@example.com");
    expect(html).not.toContain("taro@example.com");
    expect(html).toContain('action="/my-shop/account/verify"');
    // GET を何度開いても（メールの安全検査）使用済みにならない
    await phone.get(link);
    const q = new URL(`${BASE}${link}`).searchParams;
    res = await phone.post("/my-shop/account/verify", { c: q.get("c")!, t: q.get("t")! });
    expect(res.headers.get("location")).toBe("/my-shop/account");
    expect(await (await phone.get("/my-shop/account")).text()).toContain("taro@example.com");
    // 使ったリンク・でたらめなトークン
    expect((await new Browser(app).get(link)).headers.get("location")).toBe("/my-shop/account/login?error=link");
    expect((await new Browser(app).post("/my-shop/account/verify", { c: q.get("c")!, t: "x".repeat(43) })).headers.get("location")).toBe("/my-shop/account/login?error=link");
    // 同じチャレンジのコードも、もう使えない
    expect((await b.post("/my-shop/account/code", { code: mail.code("taro@example.com") })).headers.get("location")).toBe("/my-shop/account/login?error=expired");
  });

  it("全端末からログアウト: 他の端末の古い Cookie では入れず、会員としての注文にも紐づかない", async () => {
    const { sb, sku, app, mail, b } = setup();
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    const laptop = new Browser(app);
    await memberLogin(laptop, mail, "/my-shop", "member@example.com");
    await laptop.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });

    let res = await b.post("/my-shop/account/logout-all", {});
    expect(res.headers.get("location")).toBe("/my-shop/account/login?info=logged_out_all");
    expect(await (await b.get("/my-shop/account/login?info=logged_out_all")).text()).toContain("すべての端末からログアウトしました");
    expect((await laptop.get("/my-shop/account")).headers.get("location")).toBe("/my-shop/account/login");
    expect(sb.tables.customers[0]!["session_epoch"]).toBe(1);

    // 古い Cookie のままチェックアウトしても、会員として予約に付けない（予約は戻してログインへ）
    const old = new Browser(app);
    await memberLogin(old, mail, "/my-shop", "member@example.com");
    const stale = old.cookies.get(`banto_member_${String(sb.shops[0]!["id"]).replace(/[^a-zA-Z0-9]/g, "")}`)!;
    await old.post("/my-shop/account/logout-all", {});
    old.cookies.set(`banto_member_${String(sb.shops[0]!["id"]).replace(/[^a-zA-Z0-9]/g, "")}`, stale);
    await old.post("/my-shop/cart/add", { sku_id: sku.id, qty: "1" });
    res = await confirmAddress(old, "/my-shop", "stripe", ADDRESS);
    expect(res.headers.get("location")).toBe("/my-shop/account/login");
    expect(sb.tables.reservations.every((r) => r["status"] === "released")).toBe(true);
  });

  it("端末ごとのセッション（0045）: ログアウトした Cookie は数分で使えなくなる。一覧からほかの端末をログアウトさせる", async () => {
    const { sb, shop, app, mail, b } = setup();
    const name = customerCookieName(shop.id);
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    expect(sb.memberSessions).toHaveLength(1);
    expect(sb.memberSessions[0]).toMatchObject({ kind: "web", revoked_at: null });
    const stolen = b.cookies.get(name)!;
    await b.post("/my-shop/account/logout", {});
    expect(sb.memberSessions[0]).toMatchObject({ revoked_reason: "logout" });

    const thief = new Browser(app);
    thief.cookies.set(name, stolen);
    const phone = new Browser(app);
    await memberLogin(phone, mail, "/my-shop", "member@example.com");
    const pc = new Browser(app);
    await memberLogin(pc, mail, "/my-shop", "member@example.com");
    const phoneSid = String(sb.memberSessions.at(-2)!["id"]);
    // 確かめ直すまでの数分は DB に問い合わせない（速度の予算）ので、取り消した Cookie もまだ通る
    expect((await thief.get("/my-shop/account")).status).toBe(200);

    let html = await (await pc.get("/my-shop/account")).text();
    expect(html).toContain('href="/my-shop/account/sessions"');
    html = await (await pc.get("/my-shop/account/sessions")).text();
    expect(html).toContain("ログイン中の端末");
    expect(html).toContain("（この端末）");
    expect(html).toContain(`action="/my-shop/account/sessions/${phoneSid}/revoke"`);
    // 取り消したセッションは一覧に出ない
    expect(html).not.toContain(String(sb.memberSessions[0]!["id"]));
    const res = await pc.post(`/my-shop/account/sessions/${phoneSid}/revoke`, {});
    expect(res.headers.get("location")).toBe("/my-shop/account/sessions?flash=revoked");

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      expect((await thief.get("/my-shop/account")).headers.get("location")).toBe("/my-shop/account/login");
      expect(thief.cookies.has(name)).toBe(false);
      expect((await phone.get("/my-shop/account")).headers.get("location")).toBe("/my-shop/account/login");
      expect((await pc.get("/my-shop/account")).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("0045 より前の Cookie（セッションの行が無い）は、0045 を当てた後はログインし直してもらう", async () => {
    const { sb, shop, mail, b } = setup();
    sb.appliedMigrations.splice(sb.appliedMigrations.indexOf("0045_member_sessions"), 1);
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    expect(sb.memberSessions).toHaveLength(0);
    expect((await b.get("/my-shop/account")).status).toBe(200);
    sb.appliedMigrations.push("0045_member_sessions");
    // 適用済みの版の一覧は isolate に 60 秒覚えるので、新しいアプリで確かめる
    const after = new Browser(appWith(sb, { RESEND_API_KEY: "re_test" }));
    after.cookies.set(customerCookieName(shop.id), b.cookies.get(customerCookieName(shop.id))!);
    expect((await after.get("/my-shop/account")).headers.get("location")).toBe("/my-shop/account/login");
    expect(after.cookies.has(customerCookieName(shop.id))).toBe(false);
  });

  it("改ざんした Cookie・他店の Cookie では入れない。ログアウトで Cookie を消す", async () => {
    const { shop, mail, b } = setup();
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    const name = customerCookieName(shop.id);
    const good = b.cookies.get(name)!;
    b.cookies.set(name, `${good.slice(0, -3)}${good.at(-3) === "A" ? "B" : "A"}${good.slice(-2)}`);
    expect((await b.get("/my-shop/account")).headers.get("location")).toBe("/my-shop/account/login");
    b.cookies.set(name, good);
    expect((await b.get("/my-shop/account")).status).toBe(200);
    const res = await b.post("/my-shop/account/logout", {});
    expect(res.headers.get("location")).toBe("/my-shop");
    expect(b.cookies.has(name)).toBe(false);
  });

  it("メールの送信元が無い・送れない・送りすぎ・形の違うアドレス", async () => {
    let { mail, b } = setup({ mail: false });
    expect((await b.post("/my-shop/account/login", { email: "m@example.com" })).headers.get("location")).toBe("/my-shop/account/login?error=unavailable");
    expect(await (await b.get("/my-shop/account/login?error=unavailable")).text()).toContain("ショップのメールの設定が済んでいません");
    expect(mail.sent).toHaveLength(0);

    ({ mail, b } = setup());
    expect((await b.post("/my-shop/account/login", { email: "not-an-email" })).headers.get("location")).toBe("/my-shop/account/login?error=invalid_email");
    mail.state.status = 403;
    expect((await b.post("/my-shop/account/login", { email: "m@example.com" })).headers.get("location")).toBe("/my-shop/account/login?error=mail_failed");
    expect(await (await b.get("/my-shop/account/login?error=mail_failed")).text()).toContain("メールを送れませんでした");
    mail.state.status = 200;
    for (let i = 0; i < 5; i++) await b.post("/my-shop/account/login", { email: "m@example.com" });
    const before = mail.sent.length;
    // 上限を超えても同じ画面（送らないだけ）
    expect((await b.post("/my-shop/account/login", { email: "m@example.com" })).headers.get("location")).toBe("/my-shop/account/code");
    expect(mail.sent.length).toBe(before);
  });

  it("会員登録・パスワードの画面は無い（ログインが会員登録を兼ねる）", async () => {
    const { b } = setup();
    expect((await b.get("/my-shop/account/signup")).status).toBe(404);
    expect((await b.get("/my-shop/account/password")).status).toBe(404);
    expect((await b.get("/my-shop/account/forgot")).status).toBe(404);
  });

  it("管理画面: 会員一覧・メールアドレスの変更（前後に知らせ、全端末をログアウト）・削除・設定のトグル", async () => {
    const { sb, shop, app, mail, b } = setup();
    await memberLogin(b, mail, "/my-shop", "member@example.com");
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    let html = await (await admin.get(`/admin/shops/${shop.id}/customers`)).text();
    expect(html).toContain("member@example.com");
    const id = sb.tables.customers[0]!["id"] as string;

    await memberLogin(new Browser(app), mail, "/my-shop", "taken@example.com");
    let res = await admin.post(`/admin/shops/${shop.id}/customers/${id}/email`, { email: "Taken@example.com" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/customers?error=email_taken`);
    res = await admin.post(`/admin/shops/${shop.id}/customers/${id}/email`, { email: "New@Example.com" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/customers?flash=email_changed`);
    expect(sb.tables.customers.find((x) => x["id"] === id)).toMatchObject({ email: "new@example.com", session_epoch: 1 });
    const notices = mail.sent.filter((m) => m.subject.includes("メールアドレスを変更しました"));
    expect(notices.map((m) => m.to).sort()).toEqual(["member@example.com", "new@example.com"]);
    expect((await b.get("/my-shop/account")).headers.get("location")).toBe("/my-shop/account/login");

    res = await admin.post(`/admin/shops/${shop.id}/customers/${id}/delete`, {});
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/customers?flash=deleted`);
    expect(sb.tables.customers.find((x) => x["id"] === id)).toBeUndefined();

    html = await (await admin.get(`/admin/shops/${shop.id}`)).text();
    expect(html).toMatch(/name="members_enabled" value="on" checked/);
    await admin.post(`/admin/shops/${shop.id}/shipping`, { mode: "flat", flat_fee_jpy: "0", tax_rate: "10" });
    expect((sb.shops[0]!["settings"] as Record<string, unknown>)["members_enabled"]).toBe(false);
    const fresh = new Browser(appWith(sb, {}, undefined, new FakeStripe()));
    expect((await fresh.get("/my-shop/account")).status).toBe(404);
  });

  it("管理画面: 会員機能が OFF のとき、会員の画面からショップ設定の会員機能へ案内する", async () => {
    const { shop, app } = setup({ members: false });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await admin.get(`/admin/shops/${shop.id}/customers`)).text();
    expect(html).toContain(`href="/admin/shops/${shop.id}#members"`);
    expect(await (await admin.get(`/admin/shops/${shop.id}`)).text()).toContain('id="members"');
  });
});
