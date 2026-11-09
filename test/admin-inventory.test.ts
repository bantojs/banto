import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith } from "./helpers";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";

/**
 * 在庫の画面（src/routes/admin/inventory.tsx、0136）。入荷・出荷は差、棚卸しは開いたときの数と一緒に送る。
 * 形の決まり・全部か無しか・同時の更新の本物は test/db/inventory-ops.test.ts
 */
function setup(opts: { migrations?: string[] } = {}) {
  const sb = new FakeSupabase(opts.migrations ? { appliedMigrations: opts.migrations } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ" });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ" });
  const cap = sb.addProduct(shop.id, { slug: "cap", name: "キャップ" });
  const teeM = sb.addSku(shop.id, tee.id, { code: "TEE-M", available: 10, gtin: "4900000000001", options: { size: "M" } });
  const capA = sb.addSku(shop.id, cap.id, { code: "CAP-1", available: 0 });
  const org = String(sb.tables.shops.find((s) => s["id"] === shop.id)!["org_id"]);
  const app = appWith(sb);
  const member = async (email: string, perms: string[]) => {
    const u = sb.addUser(email, "password-123");
    sb.orgMembers.push({ org_id: org, user_id: u.id, role: "member", created_at: new Date().toISOString() });
    sb.orgMemberShops.push({ org_id: org, user_id: u.id, shop_id: shop.id, perms });
    return Browser.loggedIn(app, email, "password-123");
  };
  const stock = (id: string) => Number(sb.tables.inventory.find((i) => i["sku_id"] === id)!["available"]);
  return { sb, shop, app, member, teeM, capA, stock, base: `/admin/shops/${shop.id}/inventory` };
}

describe("在庫の画面", () => {
  it("全 SKU を品番の順に並べ、品番・JAN・商品名で絞る。在庫切れだけはチップ。商品の目次の中のタブ", async () => {
    const { app, base } = setup();
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await b.get(base)).text();
    expect(html.indexOf("CAP-1")).toBeLessThan(html.indexOf("TEE-M"));
    expect(html).toContain('class="subtabs"');
    expect(html).toContain(`<a href="${base}" aria-current="page">在庫</a>`);
    expect(html).toContain("size: M");
    const byJan = await (await b.get(`${base}?q=4900000000001`)).text();
    expect(byJan).toContain("TEE-M");
    expect(byJan).not.toContain("CAP-1");
    const out = await (await b.get(`${base}?stock=out`)).text();
    expect(out).toContain("CAP-1");
    expect(out).not.toContain("TEE-M");
    expect(out).toContain('class="chip"');
    expect(out).toContain("在庫切れだけ");
  });

  it("入荷・出荷: 入れた欄だけ足す・引く（全角も読む）。足りなければ何も変えず、入れた値を残して描き直す", async () => {
    const { member, base, teeM, capA, stock } = setup();
    const b = await member("stock@example.com", ["catalog"]);
    const r = await b.post(`${base}/adjust`, { back: "?q=&stock=", [`d_${teeM.id}`]: "＋５", [`d_${capA.id}`]: "" });
    expect(r.headers.get("location")).toBe(`${base}?flash=adjusted&n=1`);
    expect(stock(teeM.id)).toBe(15);
    expect(await (await b.get(r.headers.get("location")!)).text()).toContain("1 件の SKU の在庫を変えました");
    const ng = await b.post(`${base}/adjust`, { back: "", [`d_${teeM.id}`]: "-1", [`d_${capA.id}`]: "-2" });
    expect(ng.status).toBe(409);
    const html = await ng.text();
    expect(html).toContain("品番 CAP-1 の在庫が足りない");
    expect(html).toContain(`name="d_${capA.id}" value="-2"`);
    expect(stock(teeM.id)).toBe(15);
    expect((await b.post(`${base}/adjust`, { back: "", [`d_${teeM.id}`]: "1.5" })).status).toBe(400);
    expect((await b.post(`${base}/adjust`, { back: "", [`d_${teeM.id}`]: "" })).headers.get("location")).toBe(`${base}?flash=nothing`);
  });

  it("棚卸し: 開いたときの数が今と同じなら置き換える。開いてから売れていれば、何も変えずに今の数で描き直す", async () => {
    const { sb, member, base, teeM, capA, stock } = setup();
    const b = await member("stock@example.com", ["catalog"]);
    const page = await (await b.get(`${base}?mode=count`)).text();
    expect(page).toContain(`name="e_${teeM.id}" value="10"`);
    const r = await b.post(`${base}/count`, { back: "?mode=count", [`e_${teeM.id}`]: "10", [`c_${teeM.id}`]: "8", [`e_${capA.id}`]: "0", [`c_${capA.id}`]: "" });
    expect(r.headers.get("location")).toBe(`${base}?mode=count&flash=counted&n=1`);
    expect(stock(teeM.id)).toBe(8);
    // 開いた（8）あとに 1 つ売れた
    sb.tables.inventory.find((i) => i["sku_id"] === teeM.id)!["available"] = 7;
    const ng = await b.post(`${base}/count`, { back: "?mode=count", [`e_${teeM.id}`]: "8", [`c_${teeM.id}`]: "20", [`e_${capA.id}`]: "0", [`c_${capA.id}`]: "4" });
    expect(ng.status).toBe(409);
    const html = await ng.text();
    expect(html).toContain("開いてから在庫が動いた SKU があるため");
    expect(html).toContain(`name="e_${teeM.id}" value="7"`);
    expect(html).toContain(`name="c_${teeM.id}" value="20"`);
    expect(stock(teeM.id)).toBe(7);
    expect(stock(capA.id)).toBe(0);
  });

  it("項目 catalog の無い人は開けない。戻り先は条件の名前だけを残す", async () => {
    const { member, base, teeM } = setup();
    const ship = await member("ship@example.com", ["orders"]);
    expect((await ship.get(base)).status).toBe(404);
    expect((await ship.post(`${base}/adjust`, { [`d_${teeM.id}`]: "1" })).status).toBe(404);
    const b = await member("stock@example.com", ["catalog"]);
    expect((await b.post(`${base}/adjust`, { back: "?q=x&next=https://evil.example/", [`d_${teeM.id}`]: "1" })).headers.get("location")).toBe(`${base}?q=x&flash=adjusted&n=1`);
  });

  it("0136 を当てる前の DB: 表を出さずにアップデートを案内する", async () => {
    const { app, base } = setup({ migrations: BUNDLED_MIGRATIONS.filter((v) => v !== "0136_inventory_ops") });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const html = await (await b.get(base)).text();
    expect(html).toContain("データベースのアップデートを適用すると使えます");
    expect(html).not.toContain("TEE-M");
  });
});
