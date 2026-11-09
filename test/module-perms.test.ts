import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith, externalHosts } from "./helpers";
import { MODULES } from "../src/modules/registry";

/**
 * 同梱モジュールの管理画面の権限: ショップ設定の近道（ShopNav）に出す項目と、画面の入口（loadShop）が求める項目が同じであること。
 * 正はモジュールの一覧（src/modules/registry.ts の perm）。ずれると「近道は出るのに開けない」「開けるのに近道が出ない」になる
 */
const hosts: string[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) externalHosts.delete(h);
});

function setup() {
  const sb = new FakeSupabase();
  // お問い合わせの担当者の一覧（0068）は偽の Supabase に無い。中身は test/inquiries.test.ts と test/db/ で確かめている
  const assignees = `${sb.url}/rest/v1/rpc/inquiry_assignees`;
  externalHosts.set(assignees, () => new Response("[]", { headers: { "content-type": "application/json" } }));
  hosts.push(assignees);
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const modules = Object.fromEntries(MODULES.map((m) => [m.id, true]));
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules, members_enabled: true } });
  return { sb, shop, app: appWith(sb) };
}

async function staff(sb: FakeSupabase, app: ReturnType<typeof appWith>, shopId: string, email: string, perms: string[]) {
  const u = sb.addUser(email, "password-123");
  const org = String(sb.tables.shops.find((s) => s["id"] === shopId)!["org_id"]);
  sb.orgMembers.push({ org_id: org, user_id: u.id, role: "member", created_at: new Date().toISOString() });
  sb.orgMemberShops.push({ org_id: org, user_id: u.id, shop_id: shopId, perms });
  return Browser.loggedIn(app, email, "password-123");
}

describe("同梱モジュールの管理画面の権限（近道と画面の入口）", () => {
  const withPage = MODULES.filter((m) => m.adminPath);

  it("モジュールの権限の項目は、DB の対応表（0129 の banto_shop_settings_perm、ON / OFF を書ける人）と同じ", () => {
    const sql = readFileSync(new URL("../supabase/migrations/0129_security_hardening_5.sql", import.meta.url), "utf8");
    const body = sql.slice(sql.indexOf("when p_key = 'modules' then case p_module"), sql.indexOf("else null end"));
    const db = new Map([...body.matchAll(/when '([a-z_]+)' then '([a-z_]+)'/g)].map((m) => [m[1]!, m[2]!]));
    // 表に無いモジュールは settings の項目だけでよい（null）
    expect(Object.fromEntries(MODULES.map((m) => [m.id, m.perm]))).toEqual(Object.fromEntries(MODULES.map((m) => [m.id, db.get(m.id) ?? "settings"])));
  });

  // 用途の近い設定の画面から入るモジュール（メンテナの決定 2026-11-08）。ほかはショップの画面（左の目次か近道）から
  const entry: Record<string, string> = { delivery_time: "/settings/shipping", line_login: "/settings/members", google_login: "/settings/members" };
  for (const m of withPage) {
    it(`${m.id}: 「${m.perm}」の項目だけの人に入口が出て、画面も開ける`, async () => {
      const { sb, shop, app } = setup();
      const b = await staff(sb, app, shop.id, `${m.id}@example.com`, [m.perm]);
      const href = `/admin/shops/${shop.id}/modules/${m.adminPath}`;
      expect(await (await b.get(`/admin/shops/${shop.id}${entry[m.id] ?? ""}`)).text()).toContain(`href="${href}"`);
      expect((await b.get(href)).status).toBe(200);
    });
  }

  it("項目を持たない人には近道を出さない（ページは content の項目だけ）", async () => {
    const { sb, shop, app } = setup();
    const b = await staff(sb, app, shop.id, "catalog@example.com", ["catalog"]);
    const html = await (await b.get(`/admin/shops/${shop.id}`)).text();
    expect(html).not.toContain(`/admin/shops/${shop.id}/modules/pages"`);
    expect(html).toContain(`/admin/shops/${shop.id}/modules/embed"`);
  });

  it("上のタブ（お問い合わせ・ページ・ブログ）も同じ項目で出し分ける", async () => {
    const { sb, shop, app } = setup();
    const b = await staff(sb, app, shop.id, "support@example.com", ["support"]);
    const html = await (await b.get(`/admin/shops/${shop.id}/modules/inquiries`)).text();
    expect(html).toContain(`<a href="/admin/shops/${shop.id}/modules/inquiries" aria-current="page">`);
    expect(html).not.toContain(`href="/admin/shops/${shop.id}/modules/pages"`);
  });
});

describe("機能の ON / OFF の画面（settings に加えてモジュールの項目も要る。DB の banto_shops_guard と同じ）", () => {
  it("settings の項目だけの人: settings で切り替えられるモジュールのボタンは出し、ページには何が要るかを出す。押しても変えない", async () => {
    const { sb, shop, app } = setup();
    const before = JSON.stringify(sb.tables.shops.find((s) => s["id"] === shop.id)!["settings"]);
    const b = await staff(sb, app, shop.id, "settings@example.com", ["settings"]);
    const html = await (await b.get(`/admin/shops/${shop.id}/modules`)).text();
    expect(html).toContain(`action="/admin/shops/${shop.id}/modules/receipt/enabled"`);
    expect(html).not.toContain(`action="/admin/shops/${shop.id}/modules/pages/enabled"`);
    expect(html).toContain("切り替えるには「ページ」の項目が要ります");
    const res = await b.post(`/admin/shops/${shop.id}/modules/pages/enabled`, { enabled: "off" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/modules?flash=forbidden`);
    expect(JSON.stringify(sb.tables.shops.find((s) => s["id"] === shop.id)!["settings"])).toBe(before);
  });

  it("settings と content の項目を持つ人はページを切り替えられる", async () => {
    const { sb, shop, app } = setup();
    const b = await staff(sb, app, shop.id, "content@example.com", ["settings", "content"]);
    expect(await (await b.get(`/admin/shops/${shop.id}/modules`)).text()).toContain(`action="/admin/shops/${shop.id}/modules/pages/enabled"`);
    const res = await b.post(`/admin/shops/${shop.id}/modules/pages/enabled`, { enabled: "off" });
    expect(res.headers.get("location")).toBe(`/admin/shops/${shop.id}/modules?flash=saved`);
    const mods = (sb.tables.shops.find((s) => s["id"] === shop.id)!["settings"] as Record<string, Record<string, boolean>>)["modules"]!;
    expect(mods["pages"]).toBe(false);
  });
});
