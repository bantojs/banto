import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { THEMES_MIGRATION } from "../src/themes/liquid";

/** テーマ（0071）の土台のうち Worker 側: 置き場のテーマのファイルを /media で配らない、権限の項目 design */
describe("テーマの土台（0071）", () => {
  it("/media はテーマのファイル（themes/）を配らない。ほかの画像は今までどおり", async () => {
    const sb = new FakeSupabase();
    const storage = new MemoryStorage(`${BASE}/media`);
    await storage.put("themes/s/v/assets/app.js", new TextEncoder().encode("alert(1)").buffer as ArrayBuffer, "text/javascript");
    await storage.put("products/a.webp", new Uint8Array([1, 2, 3]).buffer as ArrayBuffer, "image/webp");
    const app = appWith(sb, {}, storage);
    expect((await app.request(`${BASE}/media/themes/s/v/assets/app.js`)).status).toBe(404);
    expect((await app.request(`${BASE}/media/products/a.webp`)).status).toBe(200);
  });

  it("組織のメンバーの項目に「デザイン（テーマ）」が出る。0071 が当たるまでは出さない", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    sb.addShop(owner.id, { slug: "main", name: "本店" });
    const admin = await Browser.loggedIn(appWith(sb), "owner@example.com", "password-123");
    expect(await (await admin.get("/admin/org")).text()).toContain("デザイン（テーマ）");
    sb.appliedMigrations = sb.appliedMigrations.filter((v) => v !== THEMES_MIGRATION);
    const old = await Browser.loggedIn(appWith(sb), "owner@example.com", "password-123");
    expect(await (await old.get("/admin/org")).text()).not.toContain("デザイン（テーマ）");
  });
});
