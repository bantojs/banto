import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, MemoryStorage, appWith } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { CARE_CODES, careOf, careView, resolveCare } from "../src/care-labels/care";
import { ja } from "../src/i18n/ja";
import { productFromDetail } from "../src/themes/liquid/objects";

/** 洗濯表示（同梱モジュール care_labels、0127、docs/care-labels.md）。形の本物の検査は test/db/care-labels.test.ts */

/** 幅・高さだけを持つ PNG（IHDR まで） */
function png(w: number, h: number): Uint8Array<ArrayBuffer> {
  const be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ..."IHDR"].map((c) => (typeof c === "string" ? c.charCodeAt(0) : c)).concat(be(w), be(h), [8, 6, 0, 0, 0], [0, 0, 0, 0]));
}

function setup(opts: { on?: boolean } = {}) {
  const sb = new FakeSupabase();
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { care_labels: opts.on ?? true } } });
  const tops = sb.addCategory(shop.id, { id: crypto.randomUUID(), slug: "tops", name: "トップス", care: { symbols: ["130", "200"], notes: ["ネット使用"] } });
  const tees = sb.addCategory(shop.id, { id: crypto.randomUUID(), slug: "tees", name: "T シャツ", parent_id: tops.id });
  const product = sb.addProduct(shop.id, { id: crypto.randomUUID(), slug: "tee", name: "T", published: true, category_id: tees.id });
  sb.addSku(shop.id, product.id, { code: "TEE-M", available: 3 });
  const storage = new MemoryStorage(`${BASE}/media`);
  return { sb, owner, shop, tops, tees, product, storage, app: appWith(sb, {}, storage) };
}

describe("部品", () => {
  it("番号表は DB と同じ 43 個。どの番号にも意味の文がある", () => {
    expect(CARE_CODES).toHaveLength(43);
    for (const code of CARE_CODES) expect(ja[`care.sym.${code}` as keyof typeof ja]).toBeTruthy();
  });

  it("形: 知らない番号・同じ区分の 2 つ目は捨て、表示の順に。商品に無ければ親へたどる", () => {
    expect(careOf({ symbols: ["445", "999", "141", "140"], notes: [" 裏返し ", ""] })).toEqual({ symbols: ["141", "445"], notes: ["裏返し"] });
    expect(careOf({ symbols: [], notes: [] })).toBeNull();
    const cats = [
      { id: "a", parent_id: null, care: { symbols: ["130"] } },
      { id: "b", parent_id: "a", care: null },
    ];
    expect(resolveCare({ care: null, category_id: "b" }, cats)).toEqual({ symbols: ["130"], notes: [] });
    expect(resolveCare({ care: { symbols: ["110"] }, category_id: "b" }, cats)).toEqual({ symbols: ["110"], notes: [] });
    expect(resolveCare({ care: null, category_id: null }, cats)).toBeNull();
    const v = careView({ symbols: ["130"], notes: [] }, { "130": { key: "care/s/aaaaaaaa.png", width: 64, height: 64 } }, "https://m.example");
    expect(v!.symbols[0]).toMatchObject({ code: "130", group: "1", image: { url: "https://m.example/care/s/aaaaaaaa.png" } });
    // Liquid の product.care はルートが決めたものそのまま
    const p = productFromDetail({ shopPath: "", mediaBaseUrl: "" }, { product: { id: "p", shop_id: "s", slug: "tee", name: "T", published: true, created_at: "", updated_at: "" }, images: [], skus: [], care: v } as unknown as Parameters<typeof productFromDetail>[1]);
    expect(p.care).toEqual(v);
  });
});

describe("お店の画面・ヘッドレス", () => {
  it("商品ページ: 商品に無ければ親のカテゴリーのもの。絵の無い記号は意味の文。モジュールが OFF なら出さない", async () => {
    const s = setup();
    s.sb.tables.shops[0]!["care_symbols"] = { "130": { key: `care/${s.shop.id}/aaaaaaaa.png`, width: 64, height: 64 } };
    const html = await (await new Browser(s.app, BASE).get("/my-shop/products/tee")).text();
    expect(html).toContain('class="banto-care"');
    expect(html).toContain(`/care/${s.shop.id}/aaaaaaaa.png`);
    expect(html).toContain("液温30℃まで、洗濯機で通常の洗濯ができる");
    expect(html).toContain("漂白剤は使えない");
    expect(html).toContain("ネット使用");
    const off = setup({ on: false });
    expect(await (await new Browser(off.app, BASE).get("/my-shop/products/tee")).text()).not.toContain("banto-care");
  });

  it("ヘッドレスの商品: care（番号・区分・意味の文・絵）。商品で決めればそちら", async () => {
    const s = setup();
    s.product["care"] = { symbols: ["111", "511"] };
    const r = (await (await s.app.request(`${BASE}/api/shops/my-shop/products/tee`)).json()) as { product: { care: { symbols: { code: string; image: unknown }[]; notes: string[] } } };
    expect(r.product.care.symbols.map((x) => x.code)).toEqual(["111", "511"]);
    expect(r.product.care.symbols[0]!.image).toBeNull();
    const off = setup({ on: false });
    expect(((await (await off.app.request(`${BASE}/api/shops/my-shop/products/tee`)).json()) as { product: { care: unknown } }).product.care).toBeNull();
  });
});

describe("管理画面", () => {
  it("記号の絵を上げる（PNG）・外す。使われなくなった絵は置き場から消す", async () => {
    const s = setup();
    const admin = await Browser.loggedIn(s.app, "owner@example.com", "password-123");
    const base = `/admin/shops/${s.shop.id}/modules/care-labels`;
    expect(await (await admin.get(base)).text()).toContain('name="file_141"');
    let res = await admin.postMultipart(base, { file_141: new File([png(64, 64)], "x.png", { type: "image/png" }) });
    expect(res.headers.get("location")).toBe(`${base}?flash=saved`);
    const key = String((s.sb.tables.shops[0]!["care_symbols"] as Record<string, { key: string }>)["141"]!.key);
    expect(key).toMatch(new RegExp(`^care/${s.shop.id}/[a-f0-9]+\\.png$`));
    expect(await s.storage.get(key)).not.toBeNull();
    // 大きすぎる絵は断る（ブラウザで縮めていないもの）
    res = await admin.postMultipart(base, { file_210: new File([png(1024, 1024)], "x.png", { type: "image/png" }) });
    expect(res.headers.get("location")).toBe(`${base}?flash=invalid`);
    res = await admin.postMultipart(base, { clear_141: "1" });
    expect(s.sb.tables.shops[0]!["care_symbols"]).toEqual({});
    expect(await s.storage.get(key)).toBeNull();
  });

  it("商品の洗濯表示: カテゴリーのものを使っていると出し、選んで保存。何も選ばなければ null に戻る", async () => {
    const s = setup();
    const admin = await Browser.loggedIn(s.app, "owner@example.com", "password-123");
    const url = `/admin/shops/${s.shop.id}/modules/care-labels/products/${s.product.id}`;
    expect(await (await admin.get(`/admin/shops/${s.shop.id}/products/${s.product.id}`)).text()).toContain(url);
    expect(await (await admin.get(url)).text()).toContain("今はカテゴリー「トップス」の洗濯表示を使っています。");
    await admin.post(url, { care_1: "141", care_4: "445", care_2: "", notes: "裏返し\n" });
    expect(s.product["care"]).toEqual({ symbols: ["141", "445"], notes: ["裏返し"] });
    await admin.post(url, { care_1: "", notes: "" });
    expect(s.product["care"]).toBeNull();
    expect((await admin.post(url, { notes: "あ".repeat(41) })).headers.get("location")).toBe(`${url}?flash=notes`);
  });

  it("0127 が当たるまではモジュールの一覧に出さない", async () => {
    const s = setup({ on: false });
    s.sb.appliedMigrations = s.sb.appliedMigrations.filter((m) => m !== "0127_mod_care_labels");
    const admin = await Browser.loggedIn(s.app, "owner@example.com", "password-123");
    expect(await (await admin.get(`/admin/shops/${s.shop.id}/modules`)).text()).not.toContain("洗濯表示");
  });
});

describe("AI 用 API（products:write）", () => {
  it("PUT /api/v1/products/{ref}/care と categories。{} で外す", async () => {
    const s = setup();
    const raw = generateApiToken();
    s.sb.tables.api_tokens.push({ id: "tok-1", shop_id: s.shop.id, owner_id: s.owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes: ["products:write"], expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    const put = (path: string, body: unknown) => s.app.request(`${BASE}/api/v1${path}`, { method: "PUT", headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(await (await put("/products/tee/care", { symbols: ["141"], notes: ["ネット使用"] })).json()).toMatchObject({ target: "product", care: { symbols: ["141"] } });
    expect(s.product["care"]).toEqual({ symbols: ["141"], notes: ["ネット使用"] });
    await put("/products/tee/care", {});
    expect(s.product["care"]).toBeNull();
    expect((await put("/categories/tops/care", { symbols: ["110"] })).status).toBe(200);
    expect(s.tops["care"]).toEqual({ symbols: ["110"] });
    expect((await put("/products/nothing/care", { symbols: ["110"] })).status).toBe(404);
  });
});
