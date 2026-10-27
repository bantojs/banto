import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith, memoryAdapters } from "./helpers";
import { createApp } from "../src/app";
import { createPrivilegedDb } from "../src/db/privileged";
import { actorHeader, auditKeepDays } from "../src/audit";
import { registerJobs } from "../src/jobs";
import type { ScheduledJob } from "../src/adapters/types";

/** 監査ログ（0051）の Worker 側: 管理画面の一覧、特権経路の名乗り、Cron の掃除。本物の記録は test/db/audit-log.test.ts */
function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "main", name: "本店" });
  const orgId = String(shop["org_id"]);
  const app = appWith(sb);
  return { sb, owner, shop, orgId, app };
}

describe("監査ログ（0051、管理画面）", () => {
  it("組織の owner に一覧が出る: 誰が（メンバーのメール）・出来事・対象・ショップ。detail はそのまま出さず、メールアドレスはハッシュの先頭だけ", async () => {
    const { sb, owner, shop, orgId, app } = setup();
    const staff = sb.addUser("staff@example.com", "password-123");
    sb.tables.audit_log.push(
      { id: 1, org_id: orgId, shop_id: shop.id, actor_kind: "user", actor_id: owner.id, action: "customer.email_changed", target_type: "customer", target_id: "cust-1", detail: { old_email_hash: "0123456789abcdef", new_email_hash: "fedcba9876543210" }, created_at: "2026-10-23T01:02:03Z" },
      { id: 2, org_id: orgId, shop_id: shop.id, actor_kind: "api_token", actor_id: "11111111-2222-3333-4444-555555555555", action: "order.status_changed", target_type: "order", target_id: "order-1", detail: { number: 1005, from: "paid", to: "cancelled" }, created_at: "2026-10-23T01:03:03Z" },
      { id: 3, org_id: orgId, shop_id: null, actor_kind: "system", actor_id: null, action: "org_member.added", target_type: "user", target_id: staff.id, detail: { role: "member" }, created_at: "2026-10-23T01:04:03Z" },
      { id: 4, org_id: orgId, shop_id: shop.id, actor_kind: "user", actor_id: owner.id, action: "shop.published_changed", target_type: "shop", target_id: shop.id, detail: { published: true }, created_at: "2026-10-23T01:05:03Z" },
      { id: 5, org_id: "other-org", shop_id: null, actor_kind: "system", actor_id: null, action: "org_member.added", target_type: "user", target_id: "u-x", detail: { role: "owner" }, created_at: "2026-10-23T01:06:03Z" },
    );
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const page = await (await admin.get("/admin/org/audit")).text();
    expect(page).toContain("監査ログ");
    expect(page).toContain("会員のメールアドレスを変更（01234567 → fedcba98）");
    expect(page).toContain("注文の状態を変更: 支払い済み → キャンセル");
    expect(page).toContain("#1005");
    expect(page).toContain("AI 用トークン 11111111");
    expect(page).toContain("システム（Webhook・定期処理）");
    expect(page).toContain("メンバーを追加（member）");
    expect(page).toContain("ショップの公開を変更: 公開");
    expect(page).toContain("本店");
    expect(page).toContain("owner@example.com");
    expect(page).not.toContain("u-x"); // 別の組織の行は出ない
    expect(page).toContain("365 日");
    // 組織の画面からリンク
    expect(await (await admin.get("/admin/org")).text()).toContain(`/admin/org/audit?org=${orgId}`);
  });

  it("組織の owner / admin でなければ見られない（member はダッシュボードへ）", async () => {
    const { sb, shop, orgId, app } = setup();
    const staff = sb.addUser("staff@example.com", "password-123");
    sb.orgMembers.push({ org_id: orgId, user_id: staff.id, role: "member", created_at: "2026-10-23T00:00:00Z" });
    sb.orgMemberShops.push({ org_id: orgId, user_id: staff.id, shop_id: shop.id, perms: ["catalog", "orders", "customers", "settings", "integrations"] });
    const b = await Browser.loggedIn(app, "staff@example.com", "password-123");
    const res = await b.get("/admin/org/audit");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin?flash=forbidden");
  });
});

describe("監査ログ（0051、特権経路と Cron）", () => {
  it("createPrivilegedDb に actor を渡すと X-Banto-Actor で名乗る。渡さなければ付けない", async () => {
    const seen: Record<string, string | null>[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const h = new Headers(init?.headers);
      seen.push({ url: String(input), actor: h.get("x-banto-actor"), auth: h.get("authorization") });
      return new Response("3", { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const named = createPrivilegedDb({ url: "https://db.example", serviceRoleKey: "srv", fetch: fetchImpl, actor: actorHeader("user", "00000000-0000-0000-0000-000000000001") });
    expect(await named.pruneAuditLog(400)).toBe(3);
    const plain = createPrivilegedDb({ url: "https://db.example", serviceRoleKey: "srv", fetch: fetchImpl });
    await plain.pruneAuditLog();
    expect(seen).toEqual([
      { url: "https://db.example/rest/v1/rpc/prune_audit_log", actor: "user:00000000-0000-0000-0000-000000000001", auth: "Bearer srv" },
      { url: "https://db.example/rest/v1/rpc/prune_audit_log", actor: null, auth: "Bearer srv" },
    ]);
  });

  it("管理画面のキャンセルは運営者を名乗って cancel_order を呼ぶ", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "main", name: "本店" });
    sb.tables.orders.push({ id: "order-1", shop_id: shop.id, number: 1001, status: "paid", payment_provider: "free", payment_ref: null, total_jpy: 0, shipping_jpy: 0, created_at: "2026-10-23T00:00:00Z" });
    const actors: (string | null)[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/rpc/cancel_order")) actors.push(new Headers(init?.headers).get("x-banto-actor"));
      return sb.fetch(input, init);
    };
    const app = createApp(() => memoryAdapters({ SUPABASE_URL: sb.url, SUPABASE_ANON_KEY: sb.anonKey, SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey, SESSION_SECRET: "test-session-secret", PUBLIC_BASE_URL: BASE, MEDIA_BASE_URL: `${BASE}/media` }), { fetch: fetchImpl });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const res = await admin.post(`/admin/shops/${shop.id}/orders/order-1/status`, { status: "cancelled" });
    expect(res.headers.get("location")).toContain("flash=cancelled");
    expect(actors).toEqual([`user:${owner.id}`]);
    expect(sb.tables.orders[0]!["status"]).toBe("cancelled");
  });

  it("AUDIT_LOG_KEEP_DAYS は数字だけ受け、既定は 365。Cron の mask_shipped_orders が prune_audit_log も呼ぶ", async () => {
    expect(auditKeepDays(undefined)).toBe(365);
    expect(auditKeepDays("90")).toBe(90);
    expect(auditKeepDays("abc")).toBe(365);

    const run = async () => {
      const sb = new FakeSupabase();
      const vars = { SUPABASE_URL: sb.url, SUPABASE_ANON_KEY: sb.anonKey, SUPABASE_SERVICE_ROLE_KEY: sb.serviceRoleKey, SESSION_SECRET: "s", PUBLIC_BASE_URL: "https://b.example", AUDIT_LOG_KEEP_DAYS: "90" };
      const jobs = new Map<string, ScheduledJob>();
      const adapters = { ...memoryAdapters(vars), scheduler: { register: (name: string, job: ScheduledJob) => void jobs.set(name, job), runAll: async () => undefined } };
      const pruned: unknown[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/rpc/prune_audit_log")) {
          pruned.push(JSON.parse(String(init?.body)));
          return new Response("0", { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return sb.fetch(input, init);
      };
      registerJobs(adapters, { fetch: fetchImpl });
      await jobs.get("mask_shipped_orders")!();
      return pruned;
    };
    expect(await run()).toEqual([{ p_days: 90 }]);
  });
});
