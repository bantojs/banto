import { describe, expect, it } from "vitest";
import { FakeSupabase } from "./fake-supabase";
import { BASE, Browser, appWith } from "./helpers";
import { generateApiToken, hashApiToken, tokenPrefix } from "../src/api/tokens";
import { productCategoryIds } from "../src/products/categories";

/**
 * 商品の追加カテゴリー（0042）とクーポンのタグの条件の、Worker 側。
 * 同じショップのカテゴリーだけ・カテゴリーの削除で外れる・取り込みと復元は test/db/extra-categories.test.ts（実 PostgreSQL）。
 */
const MIGRATION = "0042_product_extra_categories";

function setup(opts: { migrated?: boolean } = {}) {
  const sb = new FakeSupabase();
  if (opts.migrated === false) sb.appliedMigrations = sb.appliedMigrations.filter((v) => v !== MIGRATION);
  const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
  const shop = sb.addShop(owner.id, { slug: "my-shop", name: "マイショップ", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c", settings: { modules: { coupons: true, woo_import: true } } });
  const wear = sb.addCategory(shop.id, { slug: "wear", name: "ウェア", sort_order: 0 });
  const tops = sb.addCategory(shop.id, { slug: "tops", name: "トップス", parent_id: wear.id });
  const sale = sb.addCategory(shop.id, { slug: "sale", name: "セール", sort_order: 1 });
  const goods = sb.addCategory(shop.id, { slug: "goods", name: "雑貨", sort_order: 2 });
  // マグは雑貨が主カテゴリーで、トップス（ウェアの子）とセールにも並ぶ
  const mug = sb.addProduct(shop.id, { slug: "mug", name: "マグ", published: true, category_id: goods.id, extra_category_ids: [tops.id, sale.id] });
  sb.addSku(shop.id, mug.id, { code: "MUG", price_jpy: 1500, available: 3 });
  const tee = sb.addProduct(shop.id, { slug: "tee", name: "Tシャツ", published: true, category_id: tops.id });
  sb.addSku(shop.id, tee.id, { code: "TEE", price_jpy: 3000, available: 3 });
  const app = appWith(sb);
  const issue = async (scopes: string[]) => {
    const raw = generateApiToken();
    sb.tables.api_tokens.push({ id: `tok-${sb.tables.api_tokens.length + 1}`, shop_id: shop.id, owner_id: owner.id, name: "t", token_hash: await hashApiToken(raw), prefix: tokenPrefix(raw), scopes, expires_at: null, revoked_at: null, last_used_at: null, created_at: "" });
    return raw;
  };
  return { sb, shop, app, issue, wear, tops, sale, goods, mug, tee };
}

const rest = async (app: ReturnType<typeof appWith>, token: string, method: string, path: string, body?: unknown) => {
  const res = await app.request(`${BASE}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> & { error?: { code: string; message: string } } };
};

describe("追加カテゴリー: お店の画面と公開 API", () => {
  it("productCategoryIds は主カテゴリーを先に、重複なしで返す", () => {
    expect(productCategoryIds({ category_id: "a", extra_category_ids: ["b", "a", "c"] })).toEqual(["a", "b", "c"]);
    expect(productCategoryIds({ category_id: null })).toEqual([]);
  });

  it("カテゴリー別一覧は追加カテゴリーでも出る（親のカテゴリーでも）。パンくずは主カテゴリーだけ", async () => {
    const { app } = setup();
    const b = new Browser(app);
    let html = await (await b.get("/my-shop?category=sale")).text();
    expect(html).toContain("マグ");
    expect(html).not.toContain("Tシャツ");
    html = await (await b.get("/my-shop?category=wear")).text();
    expect(html).toContain("マグ");
    expect(html).toContain("Tシャツ");
    html = await (await b.get("/my-shop/p/mug")).text();
    expect(html).toContain('<a href="/my-shop?category=goods">雑貨</a>');
    expect(html).not.toContain('<a href="/my-shop?category=sale">');
  });

  it("公開 API: ?category= の絞り込み・件数・extra_categories", async () => {
    const { app } = setup();
    const list = async (qs: string) => ((await (await app.request(`${BASE}/api/shops/my-shop/products${qs}`)).json()) as { products: { slug: string; extra_categories: unknown[] }[] }).products;
    expect((await list("?category=sale")).map((p) => p.slug)).toEqual(["mug"]);
    expect((await list("?category=tops")).map((p) => p.slug).sort()).toEqual(["mug", "tee"]);
    expect((await list("")).find((p) => p.slug === "mug")!.extra_categories).toEqual([
      { slug: "tops", name: "トップス" },
      { slug: "sale", name: "セール" },
    ]);
    const tree = (await (await app.request(`${BASE}/api/shops/my-shop/categories`)).json()) as { categories: { slug: string; count: number }[] };
    expect(tree.categories.map((c) => [c.slug, c.count])).toEqual([
      ["wear", 2],
      ["sale", 1],
      ["goods", 1],
    ]);
    const detail = (await (await app.request(`${BASE}/api/shops/my-shop/products/mug`)).json()) as { product: Record<string, unknown> };
    expect(detail.product).toMatchObject({ category: { slug: "goods" }, category_path: [{ slug: "goods", name: "雑貨" }], extra_categories: [{ slug: "tops" }, { slug: "sale" }] });
  });
});

describe("追加カテゴリー: 管理画面と AI 用 API", () => {
  it("商品の編集画面でチェックを付けて保存する。0042 より前の DB では出さず、列も送らない", async () => {
    const { sb, shop, app, sale, goods, tee } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/products/${tee.id}`;
    expect(await (await admin.get(base)).text()).toContain(`name="xcat_${sale.id}"`);
    const res = await admin.post(base, { name: "Tシャツ", slug: "tee", category_id: String(tee["category_id"]), [`xcat_${sale.id}`]: "on", [`xcat_${goods.id}`]: "on", published: "on" });
    expect(res.headers.get("location")).toContain("flash=saved");
    expect(sb.tables.products.find((p) => p["id"] === tee.id)!["extra_category_ids"]).toEqual([sale.id, goods.id]);

    const old = setup({ migrated: false });
    const oldAdmin = await Browser.loggedIn(old.app, "owner@example.com", "password-123");
    const oldBase = `/admin/shops/${old.shop.id}/products/${old.mug.id}`;
    expect(await (await oldAdmin.get(oldBase)).text()).not.toContain("xcat_");
    await oldAdmin.post(oldBase, { name: "マグ", slug: "mug", category_id: String(old.goods.id), published: "on" });
    // 送らないので、既存の値（DB に列があれば）も変えない
    expect(old.sb.tables.products.find((p) => p["id"] === old.mug.id)!["extra_category_ids"]).toEqual([old.tops.id, old.sale.id]);
  });

  it("REST: extra_categories を slug で付け外しする。0042 より前の DB では 409 migration_required", async () => {
    const { app, issue, tee } = setup();
    const tok = await issue(["products:read", "products:write"]);
    let r = await rest(app, tok, "PATCH", `/products/${tee.id}`, { extra_categories: ["sale", "goods"] });
    expect(r.status).toBe(200);
    expect((r.json["extra_categories"] as { slug: string }[]).map((c) => c.slug)).toEqual(["sale", "goods"]);
    r = await rest(app, tok, "PATCH", `/products/${tee.id}`, { extra_categories: ["nope"] });
    expect(r.status).toBe(400);
    expect(r.json.error!.message).toMatch(/category_not_found/);

    const old = setup({ migrated: false });
    const oldTok = await old.issue(["products:read", "products:write"]);
    r = await rest(old.app, oldTok, "PATCH", `/products/${old.tee.id}`, { extra_categories: ["sale"] });
    expect(r.status).toBe(409);
    expect(r.json.error!.code).toBe("migration_required");
    // 項目を書けないトークンには DB の版を明かさない
    const readOnly = await old.issue(["products:read"]);
    expect((await rest(old.app, readOnly, "PATCH", `/products/${old.tee.id}`, { extra_categories: ["sale"] })).status).toBe(401);
    // 追加カテゴリーを使わない更新はそのまま通る
    expect((await rest(old.app, oldTok, "PATCH", `/products/${old.tee.id}`, { name: "T" })).status).toBe(200);
  });

  it("WooCommerce の取り込み: 0042 より前の DB では追加カテゴリーをタグに写す", async () => {
    const { sb, shop, app } = setup({ migrated: false });
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const res = await admin.postJson(`/admin/shops/${shop.id}/modules/woo-import/batch`, {
      products: [{ slug: "wc-1", name: "取り込み", tags: ["NEW"], category_slug: "goods", extra_category_slugs: ["sale"], extra_category_names: ["セール"], skus: [{ code: "WC-1", price_jpy: 100, available: 1 }] }],
      overwrite_stock: true,
    });
    expect(await res.json()).toMatchObject({ products_created: 1, errors: [] });
    const p = sb.tables.products.find((x) => x["slug"] === "wc-1")!;
    expect(p["tags"]).toEqual(["NEW", "セール"]);
    expect(p["extra_category_ids"] ?? []).toEqual([]);
  });
});

describe("クーポンのタグの条件", () => {
  it("管理画面で対象のタグ・除くタグを入れると、正規化して条件に入る", async () => {
    const { sb, shop, app } = setup();
    const admin = await Browser.loggedIn(app, "owner@example.com", "password-123");
    const base = `/admin/shops/${shop.id}/modules/coupons`;
    const res = await admin.post(base, { name: "冬", code: "WINTER", kind: "percent", value: "10", active: "on", audience: "public", cond_tags: " 冬、セール, 冬 ", cond_exclude_tags: "福袋" });
    expect(res.headers.get("location")).toMatch(/flash=saved$/);
    expect(sb.tables.coupon_campaigns[0]!["conditions"]).toEqual({ tags: ["冬", "セール"], exclude_tags: ["福袋"] });
    const html = await (await admin.get(`${base}/${sb.tables.coupon_campaigns[0]!["id"]}`)).text();
    expect(html).toContain('value="冬, セール"');
  });

  it("REST: 0042 より前の DB でタグの条件を送ると 409 migration_required", async () => {
    const { app, issue } = setup({ migrated: false });
    const tok = await issue(["coupons:read", "coupons:write"]);
    const r = await rest(app, tok, "POST", "/coupons", { name: "冬", kind: "percent", value: 10, conditions: { tags: ["冬"] } });
    expect(r.status).toBe(409);
    expect(r.json.error!.message).toMatch(/conditions\.tags/);
  });
});
