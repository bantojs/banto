import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith } from "./helpers";
import { API_SCOPES } from "../src/api/tokens";
import { HOOK_EVENTS } from "../src/hooks/events";
import { EVENT_GROUPS, SCOPE_GROUPS } from "../src/routes/admin/purposes";
import { ja } from "../src/i18n/ja";

/**
 * 外部サービスと連携の詳細（src/routes/admin/purposes.tsx・tokens.tsx・hooks.tsx・connect.tsx）。
 * スコープと出来事を目的の言葉でまとめて見せる（メンテナの決定 2026-11-08）。判定の正は DB のまま
 */
function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ" });
  sb.tables.hook_endpoints.push({ id: "ep-1", shop_id: shop.id, name: "CRM", url: "https://crm.example/hook", events: ["order.paid", "inventory.low"], enabled: true, manifest: null, settings: {}, created_at: "2026-11-01T00:00:00Z" });
  sb.tables.hook_deliveries.push({ id: "d-1", shop_id: shop.id, endpoint_id: "ep-1", event: "order.paid", payload: {}, status: "pending", attempts: 2, last_status: 500, last_error: "boom", created_at: "2026-11-10T01:00:00Z", next_attempt_at: "2026-11-10T01:10:00Z" });
  const org = String(sb.tables.shops.find((s) => s["id"] === shop.id)!["org_id"]);
  const app = appWith(sb);
  const member = async (email: string, perms: string[]) => {
    const u = sb.addUser(email, "password-123");
    sb.orgMembers.push({ org_id: org, user_id: u.id, role: "member", created_at: new Date().toISOString() });
    sb.orgMemberShops.push({ org_id: org, user_id: u.id, shop_id: shop.id, perms });
    return Browser.loggedIn(app, email, "password-123");
  };
  return { sb, shop, app, member, base: `/admin/shops/${shop.id}` };
}

describe("目的の言葉のまとまり", () => {
  it("どのスコープ・出来事もちょうど 1 つのまとまりに入り、出来事には言葉がある", () => {
    expect(SCOPE_GROUPS.flatMap((g) => g.scopes).sort()).toEqual([...API_SCOPES].sort());
    expect(EVENT_GROUPS.flatMap((g) => g.events).sort()).toEqual([...HOOK_EVENTS].sort());
    for (const ev of HOOK_EVENTS) expect(ja[`event.${ev.replace(".", "_")}` as keyof typeof ja]).toBeTruthy();
  });
});

describe("AI 用トークン・知らせる先の画面", () => {
  it("トークン: 目的のひな形から始め、まとまりごとに選ぶ。個人情報には印", async () => {
    const { app, base } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await b.get(`${base}/tokens?preset=catalog`)).text();
    expect(html).toContain(`<a href="${base}/tokens?preset=catalog#issue" aria-current="page">商品の登録</a>`);
    expect(html).toMatch(/<input type="checkbox" name="scopes" value="products:write" checked=""/);
    expect(html).not.toMatch(/<input type="checkbox" name="scopes" value="orders:read" checked=""/);
    expect(html).toContain("<legend>注文</legend>");
    expect(html).toMatch(/orders:pii<\/code><span class="badge warn">個人情報<\/span>/);
    // 既定（自分で選ぶ）は今までどおり読み取りだけ
    expect(await (await b.get(`${base}/tokens`)).text()).toMatch(/value="orders:read" checked=""/);
  });

  it("トークン: 自分の項目に無いスコープは選べず、どの項目が要るかを出す", async () => {
    const { member, base } = setup();
    const b = await member("int@example.com", ["integrations", "catalog"]);
    const html = await (await b.get(`${base}/tokens`)).text();
    expect(html).toMatch(/value="orders:read" disabled=""/);
    expect(html).toContain("この操作には「注文・発送」の項目が要ります。");
  });

  it("知らせる先: 出来事をまとまりと言葉で選び、受け取っている出来事・送り直す時刻・外す（確かめつき）", async () => {
    const { app, base } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await b.get(`${base}/hooks/ep-1`)).text();
    expect(html).toContain("受け取っている出来事");
    expect(html).toContain('<span class="chip" title="order.paid">支払いが済んだ</span>');
    expect(html).toContain("<legend>商品・在庫</legend>");
    expect(html).toMatch(/value="inventory.low" checked=""/);
    expect(html).toContain("次は 2026/11/10 10:10");
    expect(html).toContain('class="card danger-zone"');
    expect(html).toContain("トークン・接続・アプリが置いたデータ");
    const list = await (await b.get(`${base}/hooks`)).text();
    expect(list).toContain("<td>支払いが済んだ・在庫が少なくなった</td>");
  });
});
