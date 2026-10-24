import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith } from "./helpers";

/**
 * 運営者の二段階認証（0054）の管理画面の流れ。DB での強制そのもの（aal1 の JWT が止まる）は test/db/operator-mfa.test.ts。
 * 偽の Supabase は banto_pre_request と同じく、登録済みの人の aal1 の JWT を 'mfa_required:challenge' で止める。
 */
function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "main", name: "本店" });
  const orgId = String(shop["org_id"]);
  const app = appWith(sb);
  return { sb, owner, shop, orgId, app };
}

const code = FakeSupabase.TOTP_CODE;

describe("運営者の二段階認証（管理画面）", () => {
  it("登録: QR と手入力の文字を出し、正しい 6 桁で有効になる。次のログインは 6 桁を求める", async () => {
    const { app, sb, owner } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = await (await b.get("/admin/mfa/setup")).text();
    expect(page).toContain("登録を始める");

    const enroll = await (await b.post("/admin/mfa/setup", {})).text();
    expect(enroll).toContain("FAKESECRET");
    expect(enroll).toContain("data:image/svg+xml;charset=utf-8,");
    const factorId = /name="factor_id" value="([^"]+)"/.exec(enroll)![1]!;
    // 違う 6 桁ではだめ
    expect((await b.post("/admin/mfa/setup/verify", { factor_id: factorId, code: "000000" })).headers.get("location")).toBe("/admin/mfa/setup?error=code");
    // 途中でやめた登録は、もう一度始めると消してから作り直す
    const again = await (await b.post("/admin/mfa/setup", {})).text();
    const factorId2 = /name="factor_id" value="([^"]+)"/.exec(again)![1]!;
    expect(sb.users.get(owner.id)!.factors!.map((f) => f.id)).toEqual([factorId2]);
    expect((await b.post("/admin/mfa/setup/verify", { factor_id: factorId2, code })).headers.get("location")).toBe("/admin/mfa/setup?flash=enabled");
    expect(await (await b.get("/admin/mfa/setup?flash=enabled")).text()).toContain("二段階認証を有効にしました");
    // 登録した本人のセッションは aal2 なので、そのまま使える
    expect((await b.get("/admin")).status).toBe(200);

    // 次のログイン: パスワードだけでは入れず、6 桁の画面へ
    const next = new Browser(app);
    expect((await next.post("/admin/login", { email: "owner@example.com", password: "password-123" })).headers.get("location")).toBe("/admin/mfa");
    expect((await next.get("/admin")).headers.get("location")).toBe("/admin/mfa");
    expect(await (await next.get("/admin/mfa")).text()).toContain("6 桁");
    expect((await next.post("/admin/mfa", { code: "999999" })).headers.get("location")).toBe("/admin/mfa?error=code");
    expect((await next.post("/admin/mfa", { code })).headers.get("location")).toBe("/admin");
    expect((await next.get("/admin")).status).toBe(200);
  });

  it("6 桁の試行はパスワードと同じ回数の制限で止まる", async () => {
    const { app, sb, owner } = setup();
    sb.addFactor(owner.id);
    const b = new Browser(app);
    await b.post("/admin/login", { email: "owner@example.com", password: "password-123" });
    let last = "";
    for (let i = 0; i < 12; i++) last = (await b.post("/admin/mfa", { code: "000000" })).headers.get("location") ?? "";
    expect(last).toBe("/admin/mfa?error=locked");
    // 正しい 6 桁でも、止まっているあいだは入れない
    expect((await b.post("/admin/mfa", { code })).headers.get("location")).toBe("/admin/mfa?error=locked");
  });

  it("解除は 6 桁を済ませたセッションだけ", async () => {
    const { app, sb, owner } = setup();
    sb.addFactor(owner.id);
    const b = new Browser(app);
    await b.post("/admin/login", { email: "owner@example.com", password: "password-123" });
    // 6 桁の前は設定の画面も開けない
    expect((await b.get("/admin/mfa/setup")).headers.get("location")).toBe("/admin/mfa");
    await b.post("/admin/mfa", { code });
    expect(await (await b.get("/admin/mfa/setup")).text()).toContain("二段階認証を外す");
    expect((await b.post("/admin/mfa/disable", {})).headers.get("location")).toBe("/admin/mfa/setup?flash=disabled");
    expect(sb.users.get(owner.id)!.factors).toEqual([]);
    expect((await Browser.loggedIn(app, "owner@example.com", "password-123")).constructor).toBe(Browser);
  });

  it("組織の全員必須: owner は自分が有効にしてから。未登録のメンバーは登録の画面へ回される", async () => {
    const { app, sb, owner, orgId } = setup();
    const staff = sb.addUser("staff@example.com", "staff-pass-1");
    sb.orgMembers.push({ org_id: orgId, user_id: staff.id, role: "admin", created_at: "2026-01-01T00:00:00Z" });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect((await b.post(`/admin/org/mfa?org=${orgId}`, { required: "1" })).headers.get("location")).toBe(`/admin/org?org=${orgId}&flash=mfa_self_first`);
    // owner が有効にする → 必須にできる
    const enroll = await (await b.post("/admin/mfa/setup", {})).text();
    await b.post("/admin/mfa/setup/verify", { factor_id: /name="factor_id" value="([^"]+)"/.exec(enroll)![1]!, code });
    expect((await b.post(`/admin/org/mfa?org=${orgId}`, { required: "1" })).headers.get("location")).toBe(`/admin/org?org=${orgId}&flash=mfa_saved`);
    expect(await (await b.get(`/admin/org?org=${orgId}`)).text()).toContain("全員に二段階認証を求めています");

    // 未登録のメンバー: ログインすると登録の画面へ。登録すれば使える
    const s = new Browser(app);
    expect((await s.post("/admin/login", { email: "staff@example.com", password: "staff-pass-1" })).headers.get("location")).toBe("/admin/mfa");
    expect((await s.get("/admin/mfa")).headers.get("location")).toBe("/admin/mfa/setup");
    expect(await (await s.get("/admin/mfa/setup")).text()).toContain("必須にしています");
    expect((await s.get("/admin")).headers.get("location")).toBe("/admin/mfa");
    const e2 = await (await s.post("/admin/mfa/setup", {})).text();
    await s.post("/admin/mfa/setup/verify", { factor_id: /name="factor_id" value="([^"]+)"/.exec(e2)![1]!, code });
    expect((await s.get("/admin")).status).toBe(200);
  });

  it("認証アプリをなくしたメンバーの登録を、同じ組織の owner が外せる（自分は外せない・admin は owner を外せない）", async () => {
    const { app, sb, owner, orgId } = setup();
    const staff = sb.addUser("staff@example.com", "staff-pass-1");
    sb.orgMembers.push({ org_id: orgId, user_id: staff.id, role: "admin", created_at: "2026-01-01T00:00:00Z" });
    sb.addFactor(staff.id);
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = await (await b.get(`/admin/org?org=${orgId}`)).text();
    expect(page).toContain(`/admin/org/members/${staff.id}/mfa-reset`);
    expect(page).not.toContain(`/admin/org/members/${owner.id}/mfa-reset`);
    expect((await b.post(`/admin/org/members/${staff.id}/mfa-reset?org=${orgId}`, {})).headers.get("location")).toBe(`/admin/org?org=${orgId}&flash=mfa_reset`);
    expect(sb.users.get(staff.id)!.factors).toEqual([]);
    // 外されたメンバーはパスワードだけで入れる
    expect((await Browser.loggedIn(app, "staff@example.com", "staff-pass-1")).constructor).toBe(Browser);

    // admin は owner の登録を外せない
    sb.addFactor(owner.id);
    const a = await Browser.loggedIn(app, "staff@example.com", "staff-pass-1");
    expect((await a.post(`/admin/org/members/${owner.id}/mfa-reset?org=${orgId}`, {})).headers.get("location")).toBe(`/admin/org?org=${orgId}&flash=forbidden`);
    expect(sb.users.get(owner.id)!.factors).toHaveLength(1);
  });
});
