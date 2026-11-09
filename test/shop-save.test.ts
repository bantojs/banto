import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith } from "./helpers";

/**
 * shops の行の更新は、member なら RLS（0024 の shops_member_update）が settings の項目を求める。
 * 足りないと 0 行・エラーなしで終わるので、管理画面は src/routes/admin/shop-save.tsx の updateShop を通して「保存できませんでした」と出す
 */
function setup() {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", settings: { modules: { shipping_labels: true, line_login: true, woo_import: true } } });
  const app = appWith(sb);
  const org = String(sb.tables.shops.find((s) => s["id"] === shop.id)!["org_id"]);
  const member = async (email: string, perms: string[]) => {
    const u = sb.addUser(email, "password-123");
    sb.orgMembers.push({ org_id: org, user_id: u.id, role: "member", created_at: new Date().toISOString() });
    sb.orgMemberShops.push({ org_id: org, user_id: u.id, shop_id: shop.id, perms });
    return Browser.loggedIn(app, email, "password-123");
  };
  const settings = () => sb.tables.shops.find((s) => s["id"] === shop.id)!["settings"] as Record<string, unknown>;
  return { sb, shop, app, member, settings };
}

describe("ショップの行の保存（settings の項目が無い member）", () => {
  it("送り状 CSV（orders だけ）: 保存しなかったと知らせる", async () => {
    const { shop, member, settings } = setup();
    const b = await member("orders@example.com", ["orders"]);
    const base = `/admin/shops/${shop.id}/modules/shipping-labels`;
    const res = await b.post(base, { shipper_name: "出荷元" });
    expect(res.headers.get("location")).toBe(`${base}?flash=not_saved`);
    expect(settings()["shipping_labels"]).toBeUndefined();
    expect(await (await b.get(`${base}?flash=not_saved`)).text()).toContain("保存できませんでした");
  });

  it("LINE ログイン（integrations だけ）: 友だち追加の欄を出さず、送っても保存しなかったと知らせる", async () => {
    const { shop, member, settings } = setup();
    const b = await member("integ@example.com", ["integrations"]);
    const base = `/admin/shops/${shop.id}/modules/line-login`;
    expect(await (await b.get(base)).text()).not.toContain(`action="${base}/bot-prompt"`);
    const res = await b.post(`${base}/bot-prompt`, { bot_prompt: "normal" });
    expect(res.headers.get("location")).toBe(`${base}?flash=not_saved`);
    expect(settings()["oauth"]).toBeUndefined();
  });

  it("WooCommerce の項目の取り込み（catalog だけ）: 403 で止める", async () => {
    const { shop, member, settings } = setup();
    const b = await member("catalog@example.com", ["catalog"]);
    const res = await b.postJson(`/admin/shops/${shop.id}/modules/woo-import/fields`, { fields: [{ key: "material", label: "素材", type: "text" }] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_saved" });
    expect(settings()["product_fields"]).toBeUndefined();
  });

  it("LINE の宣伝の月の上限は owner / admin だけ（鍵が owner / admin の項目、0129）。Stripe の接続・解除は settings も要る", async () => {
    const { shop, member } = setup();
    const s = await member("settings@example.com", ["settings", "integrations"]);
    const base = `/admin/shops/${shop.id}/line-messaging`;
    expect(await (await s.get(base)).text()).not.toContain(`action="${base}/limit"`);
    expect((await s.post(`${base}/limit`, { limit: "10" })).status).toBe(404);
    const i = await member("integ@example.com", ["integrations"]);
    expect((await i.post(`/admin/shops/${shop.id}/stripe/disconnect`, {})).status).toBe(404);
    expect((await i.get(`/admin/shops/${shop.id}/stripe/connect`)).status).toBe(404);
  });

  it("管理画面のコードは shops の行を直接更新しない（updateShop を通す。Stripe の戻りは行の数を自分で確かめる）", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(n)) files.push(p);
      }
    };
    walk(new URL("../src", import.meta.url).pathname);
    const direct = files.flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((line, i) => ({ f, i, line }))
        .filter((x) => /from(<[^>]+>)?\("shops"\)\.update\(/.test(x.line)),
    );
    const where = direct.map((x) => x.f.slice(x.f.indexOf("src/")));
    expect(where.sort()).toEqual(["src/routes/admin/shop-save.tsx", "src/routes/admin/stripe.tsx"]);
  });
});
