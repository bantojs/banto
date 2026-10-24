import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith, externalHosts, memberMail } from "./helpers";

afterEach(() => externalHosts.clear());

function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "main", name: "本店" });
  const second = sb.addShop(owner.id, { slug: "outlet", name: "アウトレット" });
  sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ" });
  const orgId = String(shop["org_id"]);
  const app = appWith(sb, { RESEND_API_KEY: "re_test" });
  return { sb, owner, shop, second, orgId, app };
}

/** 招待のメールのリンクから受け入れて、ログインした Browser を返す */
async function accept(app: ReturnType<typeof appWith>, link: string, password: string) {
  const b = new Browser(app);
  const path = link.replace(/^https?:\/\/[^/]+/, "");
  const page = await (await b.get(path)).text();
  const token = new URL(link).searchParams.get("token")!;
  const res = await b.post("/admin/invite", { token, password });
  return { b, page, res };
}

describe("組織とメンバー（0024、管理画面）", () => {
  it("owner がショップごとの項目で招待 → 本人が受け入れ → 割り当てた画面だけ使える", async () => {
    const { sb, shop, second, orgId, app } = setup();
    const mail = memberMail(sb, shop.id);
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = await (await admin.get("/admin/org")).text();
    expect(page).toContain("owner@example.com");
    expect(page).toContain("アウトレット");

    const inv = await admin.post(`/admin/org/invite?org=${orgId}`, { email: "Staff@Example.com", role: "member", [`perm.${shop.id}`]: "catalog", [`tpl.${second.id}`]: "" });
    expect(inv.headers.get("location")).toBe(`/admin/org?org=${orgId}&flash=invited`);
    const m = mail.sent.find((x) => x.to === "staff@example.com")!;
    expect(m.from).toBe("Shop <shop@example.com>");
    expect(m.text).toContain("owner@example.com");
    // DB にはトークンのハッシュだけ
    const link = mail.link("staff@example.com");
    const token = new URL(link).searchParams.get("token")!;
    expect(JSON.stringify(sb.orgInvitations)).not.toContain(token);

    const { b, page: acceptPage, res } = await accept(app, link, "staff-pass-1");
    expect(acceptPage).toContain("staff@example.com");
    expect(res.headers.get("location")).toBe("/admin");
    // 2 回目は使えない
    expect(await (await new Browser(app).get(link.replace(/^https?:\/\/[^/]+/, ""))).text()).toContain("有効期限が切れているか");

    const dash = await (await b.get("/admin")).text();
    expect(dash).toContain("本店");
    expect(dash).not.toContain("アウトレット");
    expect(dash).not.toContain("/admin/org");
    expect(dash).not.toContain(`/admin/shops/${shop.id}/orders`);
    expect((await b.get(`/admin/shops/${shop.id}/products`)).status).toBe(200);
    expect((await b.get(`/admin/shops/${shop.id}/orders`)).status).toBe(404);
    expect((await b.get(`/admin/shops/${shop.id}/tokens`)).status).toBe(404);
    expect((await b.get(`/admin/shops/${second.id}/products`)).status).toBe(404);
    // ショップの設定の項目が無い: メニューだけ
    const overview = await (await b.get(`/admin/shops/${shop.id}`)).text();
    expect(overview).toContain(`/admin/shops/${shop.id}/products`);
    expect(overview).not.toContain('name="legal_notice"');
    // 組織の画面・アップデート・ショップの追加は owner / admin だけ
    expect((await b.get("/admin/org")).headers.get("location")).toBe("/admin?flash=forbidden");
    expect((await b.get("/admin/update")).headers.get("location")).toBe("/admin?flash=forbidden");
    expect((await b.post("/admin/shops", { name: "X", slug: "x-shop" })).headers.get("location")).toBe("/admin?flash=forbidden");
    mail.dispose();
  });

  it("メールを送れないときはリンクを画面に一度だけ出す。項目の変更・外す・最後の owner", async () => {
    const { sb, owner, shop, orgId, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const res = await admin.post(`/admin/org/invite?org=${orgId}`, { email: "ops@example.com", role: "member", [`tpl.${shop.id}`]: "fulfillment" });
    expect(res.status).toBe(200);
    const html = await res.text();
    const link = /(http:\/\/localhost:8787\/admin\/invite\?token=[A-Za-z0-9_%-]+)/.exec(html)![1]!;
    expect(sb.orgInvitations[0]!["shops"]).toEqual([{ shop_id: shop.id, perms: ["orders", "orders_cancel"] }]);
    const { b } = await accept(app, link, "ops-pass-12");
    expect((await b.get(`/admin/shops/${shop.id}/orders`)).status).toBe(200);
    expect((await b.get(`/admin/shops/${shop.id}/products`)).status).toBe(404);

    const ops = [...sb.users.values()].find((u) => u.email === "ops@example.com")!;
    expect((await admin.get(`/admin/org/members/${ops.id}?org=${orgId}`)).status).toBe(200);
    const multi = new URLSearchParams([["role", "member"], [`perm.${shop.id}`, "catalog"], [`perm.${shop.id}`, "reports"], [`perm.${shop.id}`, "bogus"]]).toString();
    await admin.postRaw(`/admin/org/members/${ops.id}?org=${orgId}`, multi, "application/x-www-form-urlencoded");
    expect(sb.orgMemberShops.find((x) => x.user_id === ops.id)!.perms).toEqual(["catalog", "reports"]);
    expect((await b.get(`/admin/shops/${shop.id}/products`)).status).toBe(200);
    expect((await b.get(`/admin/shops/${shop.id}/orders`)).status).toBe(404);

    expect((await admin.post(`/admin/org/members/${owner.id}?org=${orgId}`, { role: "admin" })).headers.get("location")).toContain("flash=last_owner");
    expect((await admin.post(`/admin/org/members/${ops.id}?org=${orgId}`, { remove: "1" })).headers.get("location")).toContain("flash=removed");
    // どの組織にも入っていない人はログインに戻される
    expect((await b.get(`/admin/shops/${shop.id}/products`)).headers.get("location")).toBe("/admin/login?error=not_owner");
  });

  it("招待は本人のアドレスで受け入れる。既にアカウントがある人はそのパスワードで", async () => {
    const { sb, shop, orgId, app } = setup();
    sb.addUser("exists@example.com", "existing-pass");
    const mail = memberMail(sb, shop.id);
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    await admin.post(`/admin/org/invite?org=${orgId}`, { email: "exists@example.com", role: "admin" });
    const link = mail.link("exists@example.com");
    const wrong = await accept(app, link, "not-the-password");
    expect(wrong.res.status).toBe(400);
    const ok = await accept(app, link, "existing-pass");
    expect(ok.res.headers.get("location")).toBe("/admin");
    // admin は全ショップと組織の画面
    expect((await ok.b.get(`/admin/shops/${shop.id}/orders`)).status).toBe(200);
    expect((await ok.b.get("/admin/org")).status).toBe(200);
    // admin は owner を招待できない
    expect((await ok.b.post(`/admin/org/invite?org=${orgId}`, { email: "boss@example.com", role: "owner" })).headers.get("location")).toContain("flash=owner_only");
    mail.dispose();
  });
});
