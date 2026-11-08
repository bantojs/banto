import { describe, expect, it } from "vitest";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { parseShopBlock, shopBlockLine } from "../src/pages/shop-blocks";
import { formatStoreFieldRows, parseStoreFieldRows, storeFieldDefs, storeFieldView, storeFieldsForDb } from "../src/stores/fields";

/** 実店舗の独自項目（0126、メンテナの決定 2026-11-07）: 定義は組織ごと、値は stores.fields、公開の分だけお店の画面へ */
const DEFS = [
  { key: "parking", label: "駐車場", type: "select", options: ["あり", "なし"] },
  { key: "brands", label: "取扱ブランド", type: "text" },
  { key: "site", label: "店舗のページ", type: "url" },
  { key: "manager", label: "担当者", type: "text", private: true },
];

function setup(defs: Record<string, unknown>[] = DEFS) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { pages: true, store_tryon: true } } });
  const org = String(sb.tables.shops.find((x) => x["id"] === shop.id)!["org_id"]);
  sb.organizations.find((o) => o["id"] === org)!["store_fields"] = defs;
  const stores = [
    { name: "渋谷店", fields: { parking: "あり", brands: "A / B", site: "https://ex.example/shibuya", manager: "山田" } },
    { name: "新宿店", fields: { parking: "なし" } },
  ].map((s, i) => {
    const id = crypto.randomUUID();
    sb.tables.stores.push({ id, org_id: org, name: s.name, hours: {}, special_days: [], note: null, active: true, sort_order: i, fields: s.fields });
    sb.tables.shop_stores.push({ shop_id: shop.id, store_id: id, tryon: false, sort_order: i });
    return id;
  });
  return { sb, shop, org, owner, stores, app: appWith(sb, {}, new MemoryStorage(`${BASE}/media`)) };
}

let n = 0;
async function page(s: ReturnType<typeof setup>, body: string) {
  const handle = `sf-${++n}`;
  s.sb.addPage(s.shop.id, { id: crypto.randomUUID(), handle, title: "店舗", body, published: true });
  return (await new Browser(s.app, BASE).get(`/my-shop/pages/${handle}`)).text();
}

describe("::: stores show=field:<key>", () => {
  it("選んだ公開の項目だけを書いた順で。非公開の項目・値の無い項目は出さない。url はリンク", async () => {
    const s = setup();
    const html = await page(s, "::: stores show=field:brands,field:parking,field:manager,field:site");
    const shibuya = html.slice(html.indexOf("渋谷店"), html.indexOf("新宿店"));
    expect([...shibuya.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1])).toEqual(["取扱ブランド", "駐車場", "店舗のページ"]);
    expect(shibuya).toContain('<a href="https://ex.example/shibuya" rel="noopener">');
    expect(html).not.toContain("山田");
    const shinjuku = html.slice(html.indexOf("新宿店"));
    expect([...shinjuku.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1])).toEqual(["駐車場"]);
    // show が無ければ項目を出さない（今までの見た目のまま）
    expect(await page(s, "::: stores")).not.toContain("banto-store__fields");
  });

  it("書き方の読み書き。field: で始まらない・11 個以上は捨てる", () => {
    const b = parseShopBlock("::: stores show=field:parking,field:brands");
    expect(b).toMatchObject({ kind: "stores" });
    expect(shopBlockLine(b!)).toContain("show=field:parking,field:brands");
    expect(parseShopBlock("::: stores show=parking")!.attrs["show"]).toBeUndefined();
    expect(parseShopBlock(`::: stores show=${Array.from({ length: 11 }, (_, i) => `field:k${i}`).join(",")}`)!.attrs["show"]).toBeUndefined();
  });

  it("ヘッドレスの店舗の一覧に公開の項目（表示名つき）。外部コードは出さない", async () => {
    const s = setup();
    s.sb.tables.stores[0]!["external_ref"] = "S-001";
    const r = (await (await s.app.request(`${BASE}/api/shops/my-shop/stores`)).json()) as { stores: Record<string, unknown>[] };
    expect(r.stores[0]!["fields"]).toEqual([
      { key: "parking", label: "駐車場", type: "select", value: "あり" },
      { key: "brands", label: "取扱ブランド", type: "text", value: "A / B" },
      { key: "site", label: "店舗のページ", type: "url", value: "https://ex.example/shibuya" },
    ]);
    expect(JSON.stringify(r)).not.toContain("S-001");
    expect(JSON.stringify(r)).not.toContain("山田");
  });
});

describe("管理画面（組織の実店舗）", () => {
  it("定義を保存し、店舗の編集で値と外部コードを書ける", async () => {
    const s = setup([]);
    const admin = await Browser.loggedIn(s.app, "owner@example.com", "password-123");
    const list = await (await admin.get(`/admin/stores?org=${s.org}`)).text();
    expect(list).toContain(`action="/admin/stores/fields?org=${s.org}"`);
    await admin.post(`/admin/stores/fields?org=${s.org}`, { rows: "parking | 駐車場 | select | あり/なし\nmanager | 担当者 | text | | private" });
    expect(s.sb.organizations.find((o) => o["id"] === s.org)!["store_fields"]).toEqual([
      { key: "parking", label: "駐車場", type: "select", options: ["あり", "なし"] },
      { key: "manager", label: "担当者", type: "text", private: true },
    ]);
    const edit = await (await admin.get(`/admin/stores/${s.stores[0]}`)).text();
    expect(edit).toContain('name="sf_parking"');
    expect(edit).toContain('name="external_ref"');
    const res = await admin.post(`/admin/stores/${s.stores[0]}`, { name: "渋谷店", h1: "", sort_order: "0", active: "on", fields_present: "1", sf_parking: "なし", sf_manager: "佐藤", external_ref: "S-001" });
    expect(res.status).toBe(302);
    expect(s.sb.tables.stores[0]).toMatchObject({ fields: { parking: "なし", manager: "佐藤" }, external_ref: "S-001" });
  });

  it("ページの編集の画面: 店舗のブロックに独自項目の欄（show）", async () => {
    const s = setup();
    const admin = await Browser.loggedIn(s.app, "owner@example.com", "password-123");
    const html = await (await admin.get(`/admin/shops/${s.shop.id}/modules/pages/new`)).text();
    expect(html).toContain("field:parking,field:brands");
    expect(html).toContain("店舗の独自項目");
  });

  it("0126 が当たるまで欄を出さない", async () => {
    const s = setup();
    s.sb.appliedMigrations = s.sb.appliedMigrations.filter((m) => m !== "0126_store_fields");
    const admin = await Browser.loggedIn(s.app, "owner@example.com", "password-123");
    expect(await (await admin.get(`/admin/stores?org=${s.org}`)).text()).not.toContain("/admin/stores/fields");
    expect(await (await admin.get(`/admin/stores/${s.stores[0]}`)).text()).not.toContain('name="external_ref"');
  });
});

describe("AI 用 API: stores:write", () => {
  it("PATCH /api/v1/stores/{ref}: id か ext:<コード>。null で消す。決まった欄は書けない", async () => {
    const s = setup();
    const raw = generateApiToken();
    s.sb.tables.api_tokens.push({ id: "tok-1", shop_id: s.shop.id, owner_id: s.owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes: ["stores:write"], expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    s.sb.tables.stores[0]!["external_ref"] = "S-001";
    const patch = (ref: string, body: unknown) => s.app.request(`${BASE}/api/v1/stores/${encodeURIComponent(ref)}`, { method: "PATCH", headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const ok = await patch("ext:S-001", { fields: { parking: "なし", site: null } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ external_ref: "S-001", fields: { parking: "なし", brands: "A / B", manager: "山田" } });
    expect((await patch(String(s.stores[1]), { external_ref: "S-002" })).status).toBe(200);
    expect(s.sb.tables.stores[1]!["external_ref"]).toBe("S-002");
    expect((await patch("bad ref!", { fields: {} })).status).toBe(404);
    expect((await patch("ext:S-001", { name: "改名" })).status).toBe(400);
  });
});

describe("部品", () => {
  it("定義の読み書き（private の印）と表示（show の順・公開だけ）", () => {
    const defs = storeFieldDefs(DEFS);
    expect(defs.map((d) => [d.key, d.public])).toEqual([["parking", true], ["brands", true], ["site", true], ["manager", false]]);
    expect(storeFieldsForDb(defs)).toEqual(DEFS);
    expect(parseStoreFieldRows(formatStoreFieldRows(defs))).toEqual(defs);
    const pub = DEFS.filter((d) => !d.private).map(({ key, label, type }) => ({ key, label, type }));
    expect(storeFieldView(pub, { parking: "あり", brands: "A" }, ["brands", "parking", "nothing"]).map((x) => x.key)).toEqual(["brands", "parking"]);
  });
});
