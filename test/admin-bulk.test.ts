import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { Browser, appWith } from "./helpers";
import { BUNDLED_MIGRATIONS } from "../src/db/migrations";

/**
 * 商品のまとめて編集（src/routes/admin/bulk.tsx、0137）。変えたマスだけを開いたときの値と一緒に送り、誤りがあれば何も変えずに描き直す。
 * 形の決まり・全部か無しか・食い違いの本物は test/db/catalog-bulk.test.ts
 */
function setup(opts: { migrations?: string[] } = {}) {
  const sb = new FakeSupabase(opts.migrations ? { appliedMigrations: opts.migrations } : {});
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ" });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", tags: ["夏"] });
  const cap = sb.addProduct(shop.id, { slug: "cap", name: "キャップ" });
  const teeM = sb.addSku(shop.id, tee.id, { code: "TEE-M", price_jpy: 3000, options: { size: "M" } });
  const capA = sb.addSku(shop.id, cap.id, { code: "CAP-1", price_jpy: 2000 });
  const org = String(sb.tables.shops.find((s) => s["id"] === shop.id)!["org_id"]);
  const app = appWith(sb);
  const member = async (email: string, perms: string[]) => {
    const u = sb.addUser(email, "password-123");
    sb.orgMembers.push({ org_id: org, user_id: u.id, role: "member", created_at: new Date().toISOString() });
    sb.orgMemberShops.push({ org_id: org, user_id: u.id, shop_id: shop.id, perms });
    return Browser.loggedIn(app, email, "password-123");
  };
  const base = `/admin/shops/${shop.id}/products`;
  return { sb, shop, app, member, tee, cap, teeM, capA, base };
}

/** 画面の hidden の開いたときの値をそのまま送り、変えたいマスだけ上書きする */
async function formOf(html: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) out[m[1]!] = m[2]!.replace(/&amp;/g, "&");
  for (const m of html.matchAll(/<input type="text" name="(v:[^"]+)"[^>]* value="([^"]*)"/g)) out[m[1]!] = m[2]!.replace(/&amp;/g, "&");
  for (const m of html.matchAll(/<select name="(v:[^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) out[m[1]!] = /<option value="([^"]*)" selected/.exec(m[2]!)?.[1] ?? "";
  return out;
}

describe("商品のまとめて編集", () => {
  it("一覧で選んだ商品と SKU を表に並べ、変えたマスだけを 1 回で保存する。列は選べる", async () => {
    const { sb, member, tee, cap, teeM, capA, base } = setup();
    const b = await member("cat@example.com", ["catalog"]);
    const list = await (await b.get(base)).text();
    expect(list).toContain(`<input type="checkbox" name="id" value="${tee.id}"`);
    expect(list).toContain("選んだ商品をまとめて編集");
    const page = await (await b.get(`${base}/bulk?id=${tee.id}&id=${cap.id}`)).text();
    expect(page).toContain("TEE-M (size: M)");
    expect(page).toContain(`name="v:sku:${capA.id}:price_jpy"`);
    expect(page).not.toContain(`name="v:sku:${capA.id}:gtin"`);
    const form = await formOf(page);
    form[`v:product:${tee.id}:name`] = "白T";
    form[`v:product:${tee.id}:tags`] = "夏, 白";
    form[`v:sku:${teeM.id}:price_jpy`] = "３,５００";
    form[`v:sku:${capA.id}:compare_at_price_jpy`] = "2500";
    const r = await b.post(`${base}/bulk`, form);
    expect(r.headers.get("location")).toBe(`${base}/bulk?ids=${tee.id},${cap.id}&cols=name,published,category_id,tags,price_jpy,compare_at_price_jpy&flash=saved&p=1&s=2`);
    expect(sb.tables.products.find((p) => p["id"] === tee.id)).toMatchObject({ name: "白T", tags: ["夏", "白"] });
    expect(sb.tables.skus.find((k) => k["id"] === teeM.id)).toMatchObject({ price_jpy: 3500 });
    expect(sb.tables.skus.find((k) => k["id"] === capA.id)).toMatchObject({ compare_at_price_jpy: 2500 });
    expect(await (await b.get(r.headers.get("location")!)).text()).toContain("保存しました（商品 1 件・SKU 2 件）");
    // 列を選ぶ（JAN を足す）
    const withGtin = await (await b.get(`${base}/bulk?ids=${tee.id}&cols=name,gtin`)).text();
    expect(withGtin).toContain(`name="v:sku:${teeM.id}:gtin"`);
    expect(withGtin).not.toContain(`name="v:product:${tee.id}:tags"`);
  });

  it("誤りが 1 つでもあれば何も変えず、入れた値を残して誤りのマスに印を付ける。ほかの人が変えたマスは今の値で知らせる", async () => {
    const { sb, member, tee, teeM, base } = setup();
    const b = await member("cat@example.com", ["catalog"]);
    const form = await formOf(await (await b.get(`${base}/bulk?id=${tee.id}`)).text());
    // 開いたあとに、ほかの人が名前を変えた
    sb.tables.products.find((p) => p["id"] === tee.id)!["name"] = "Tシャツ（新）";
    form[`v:product:${tee.id}:name`] = "白T";
    form[`v:sku:${teeM.id}:price_jpy`] = "-1";
    form[`v:product:${tee.id}:tags`] = "冬";
    const r = await b.post(`${base}/bulk`, form);
    expect(r.status).toBe(409);
    const html = await r.text();
    expect(html).toContain("2 か所に直すところがあるため");
    expect(html).toContain("開いてから、ほかの人が変えました（今: Tシャツ（新））");
    expect(html).toContain("0 以上の整数で入れてください");
    expect(html).toContain(`name="v:sku:${teeM.id}:price_jpy" class="cell chg err"`);
    expect(html).toContain('value="-1"');
    // 名前の開いたときの値は今の値に。そのまま送り直せば上書きできる
    expect(html).toContain(`name="o:product:${tee.id}:name" value="Tシャツ（新）"`);
    expect(sb.tables.products.find((p) => p["id"] === tee.id)).toMatchObject({ name: "Tシャツ（新）", tags: ["夏"] });
    expect(sb.tables.skus.find((k) => k["id"] === teeM.id)).toMatchObject({ price_jpy: 3000 });
    const again = await formOf(html);
    again[`v:sku:${teeM.id}:price_jpy`] = "3200";
    expect((await b.post(`${base}/bulk`, again)).status).toBe(302);
    expect(sb.tables.products.find((p) => p["id"] === tee.id)).toMatchObject({ name: "白T", tags: ["冬"] });
  });

  it("何も変えていなければ保存しない。項目 catalog の無い人は開けない。他のショップの商品は並ばない", async () => {
    const { sb, member, tee, base } = setup();
    const b = await member("cat@example.com", ["catalog"]);
    const form = await formOf(await (await b.get(`${base}/bulk?id=${tee.id}`)).text());
    expect((await b.post(`${base}/bulk`, form)).headers.get("location")).toContain("&flash=nothing");
    const ship = await member("ship@example.com", ["orders"]);
    expect((await ship.get(`${base}/bulk?id=${tee.id}`)).status).toBe(403);
    expect((await ship.post(`${base}/bulk`, form)).status).toBe(404);
    const other = sb.addShop(sb.addUser("o@example.com", "password-123", { owner: true }).id, { slug: "other", name: "ほか" });
    const foreign = sb.addProduct(other.id, { slug: "x", name: "よその商品" });
    expect(await (await b.get(`${base}/bulk?id=${foreign.id}`)).text()).toContain("編集する商品が選ばれていません");
  });

  it("0137 を当てる前の DB: 一覧に選ぶ欄を出さず、まとめて編集はアップデートを案内する", async () => {
    const { app, tee, base } = setup({ migrations: BUNDLED_MIGRATIONS.filter((v) => v !== "0137_catalog_bulk") });
    const b = await Browser.loggedIn(app, "owner@example.com", "password-123");
    expect(await (await b.get(base)).text()).not.toContain('type="checkbox" name="id"');
    expect(await (await b.get(`${base}/bulk?id=${tee.id}`)).text()).toContain("データベースのアップデートを適用すると使えます");
  });
});
