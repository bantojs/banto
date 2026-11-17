import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith } from "./helpers";
import { MODULES, MODULE_CATEGORIES } from "../src/modules/registry";
import { ja } from "../src/i18n/ja";
import { en } from "../src/i18n/en";

/**
 * 「機能を追加」の画面（src/routes/admin/modules.tsx）: 使う仕事ごとのまとまりで並べ、ON / OFF だけ。
 * 画面の言葉に内部の言葉（モジュール・コアの一本道・マイグレーションの名前）を出さない（メンテナの決定 2026-11-08）
 */
describe("機能を追加の分類と言葉", () => {
  it("どの機能もまとまりに入り、まとまりの名前がある", () => {
    for (const m of MODULES) expect(MODULE_CATEGORIES).toContain(m.category);
    for (const c of MODULE_CATEGORIES) {
      expect(ja[`modcat.${c}` as keyof typeof ja]).toBeTruthy();
      expect(en[`modcat.${c}` as keyof typeof en]).toBeTruthy();
    }
  });

  it("画面の文言に「モジュール」・コアの一本道・マイグレーションの名前を出さない", () => {
    for (const [k, v] of Object.entries(ja)) {
      expect(v, k).not.toMatch(/モジュール|一本道|\b0\d{3}_[a-z_]+/);
    }
    for (const m of MODULES) expect(en[m.description as keyof typeof en], m.id).not.toMatch(/\bmodule\b|core's single path/i);
  });

  it("画面はまとまりの見出しの下に並ぶ（ON / OFF と開くだけ）", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", settings: { modules: { coupons: true } } });
    const b = await Browser.loggedIn(appWith(sb), "owner@example.com", "password-123");
    const html = await (await b.get(`/admin/shops/${shop.id}/modules`)).text();
    expect(html).toContain("<h1>機能を追加</h1>");
    const at = (s: string) => html.indexOf(s);
    expect(at('<h2 id="modcat-orders">注文・発送</h2>')).toBeGreaterThan(0);
    expect(at('<h2 id="modcat-orders">')).toBeLessThan(at('data-module="shipping_labels"'));
    expect(at('<h2 id="modcat-marketing">集客</h2>')).toBeLessThan(at('data-module="coupons"'));
    expect(at('data-module="shipping_labels"')).toBeLessThan(at('<h2 id="modcat-catalog">'));
  });
});
