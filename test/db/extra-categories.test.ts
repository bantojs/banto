import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, CUSTOMER_COLUMNS, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * 0042_product_extra_categories: 商品の追加カテゴリー（複数）と、クーポンのタグの条件。
 * 同じショップのカテゴリーだけ・主カテゴリーと重ねない・カテゴリーを消したら外れる・取り込み・復元・AI 用 API を確かめる。
 */
describe.skipIf(!dbAvailable)("追加カテゴリーとクーポンのタグの条件（0042）", () => {
  let a: Fixture;
  let b: Fixture;
  let tops: string;
  let sale: string;
  let gift: string;
  let bCat: string;
  let token: string;

  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
  const insertCategory = (f: Fixture, slug: string) =>
    asUser(f.ownerId, async (c) => (await c.query<{ id: string }>("insert into categories (shop_id, slug, name) values ($1, $2, $3) returning id", [f.shopId, slug, slug.toUpperCase()])).rows[0]!.id);
  const extras = (productId: string) => getPool().query<{ e: string[] }>("select extra_category_ids as e from products where id = $1", [productId]).then((r) => r.rows[0]!.e);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "xc-a@example.com", slug: "xc-a", publish: true, stock: 5 });
    b = await createShopFixture({ email: "xc-b@example.com", slug: "xc-b", publish: true, stock: 5 });
    await getPool().query(`update shops set settings = settings || '{"modules":{"coupons":true}}'::jsonb where id = $1`, [a.shopId]);
    tops = await insertCategory(a, "tops");
    sale = await insertCategory(a, "sale");
    gift = await insertCategory(a, "gift");
    bCat = await insertCategory(b, "b-only");
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    token = sha(raw);
    await asUser(a.ownerId, (c) =>
      c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [a.shopId, a.ownerId, token, raw.slice(0, 12), ["products:read", "products:write", "coupons:read", "coupons:write"]]),
    );
  });
  afterAll(closePool);

  it("owner が付けられる。重複と主カテゴリーは外し、他のショップのカテゴリーは拒否。公開中なら anon が読める", async () => {
    await asUser(a.ownerId, (c) => c.query("update products set category_id = $2, extra_category_ids = array[$3, $3, $2, $4]::uuid[] where id = $1", [a.productId, tops, sale, gift]));
    expect(await extras(a.productId)).toEqual([sale, gift]);
    // 主カテゴリーを追加カテゴリーのひとつに変えると、追加カテゴリーからは外れる
    await asUser(a.ownerId, (c) => c.query("update products set category_id = $2 where id = $1", [a.productId, sale]));
    expect(await extras(a.productId)).toEqual([gift]);
    await asUser(a.ownerId, (c) => c.query("update products set category_id = $2, extra_category_ids = array[$3, $4]::uuid[] where id = $1", [a.productId, tops, sale, gift]));

    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("update products set extra_category_ids = array[$2]::uuid[] where id = $1", [a.productId, bCat])))).toMatch(/category_not_found/);
    // 他人は書けない（RLS で 0 行）
    const r = await asUser(b.ownerId, (c) => c.query("update products set extra_category_ids = '{}' where id = $1", [a.productId]));
    expect(r.rowCount).toBe(0);
    const anon = await asAnon(async (c) => (await c.query<{ e: string[] }>("select extra_category_ids as e from products where id = $1", [a.productId])).rows[0]!.e);
    expect(anon).toEqual([sale, gift]);
  });

  it("カテゴリーを消すと追加カテゴリーから外れる。ショップごと消しても止まらない", async () => {
    const tmp = await insertCategory(a, "tmp");
    await asUser(a.ownerId, (c) => c.query("update products set extra_category_ids = extra_category_ids || $2::uuid where id = $1", [a.productId, tmp]));
    expect(await extras(a.productId)).toContain(tmp);
    await asUser(a.ownerId, (c) => c.query("delete from categories where id = $1", [tmp]));
    expect(await extras(a.productId)).toEqual([sale, gift]);

    const shop = await asUser(b.ownerId, async (c) => (await c.query<{ id: string }>("insert into shops (owner_id, slug, name) values ($1, 'xc-gone', 'Gone') returning id", [b.ownerId])).rows[0]!.id);
    const [c1, c2] = [await insertCategory({ ...b, shopId: shop }, "g1"), await insertCategory({ ...b, shopId: shop }, "g2")];
    await asUser(b.ownerId, (c) => c.query("insert into products (shop_id, slug, name, category_id, extra_category_ids) values ($1, 'p', 'P', $2, array[$3]::uuid[])", [shop, c1, c2]));
    await asUser(b.ownerId, (c) => c.query("delete from shops where id = $1", [shop]));
    expect((await getPool().query("select 1 from products where shop_id = $1", [shop])).rowCount).toBe(0);
  });

  it("AI 用 API: slug で付け外しし、商品の JSON に extra_categories を返す", async () => {
    const created = await rpc<{ id: string; extra_categories: { slug: string }[] }>("api_product_create", [token, { slug: "xc-api", name: "API", category: "tops", extra_categories: ["gift", "sale", "tops"] }]);
    expect(created.extra_categories.map((x) => x.slug)).toEqual(["gift", "sale"]);
    expect(await expectDbError(() => rpc("api_product_update", [token, created.id, { extra_categories: ["nope"] }]))).toMatch(/category_not_found/);
    expect(await expectDbError(() => rpc("api_product_update", [token, created.id, { extra_categories: "sale" }]))).toMatch(/invalid_extra_categories/);
    expect(await expectDbError(() => rpc("api_product_update", [token, created.id, { extra_categories: ["b-only"] }]))).toMatch(/category_not_found/);
    // 鍵が無ければ変えない。空配列で外す
    const kept = await rpc<{ extra_categories: unknown[] }>("api_product_update", [token, created.id, { name: "API2" }]);
    expect(kept.extra_categories).toHaveLength(2);
    const cleared = await rpc<{ extra_categories: unknown[] }>("api_product_update", [token, created.id, { extra_categories: [] }]);
    expect(cleared.extra_categories).toEqual([]);
  });

  it("import_catalog: extra_category_slugs で付け、鍵が無ければ既存の値を残す。知らない slug は飛ばす", async () => {
    const run = (batch: unknown) => asUser(a.ownerId, async (c) => (await c.query<{ r: { errors: unknown[] } }>("select import_catalog($1, $2::jsonb) as r", [a.shopId, JSON.stringify(batch)])).rows[0]!.r);
    const product = { slug: "xc-imp", name: "取り込み", category_slug: "tops", skus: [{ code: "XC-IMP", price_jpy: 1000, available: 1 }] };
    const r = await run({ categories: [{ slug: "new-shelf", name: "新しい棚" }], products: [{ ...product, extra_category_slugs: ["new-shelf", "sale", "unknown"] }] });
    expect(r.errors).toEqual([]);
    const id = (await getPool().query<{ id: string }>("select id from products where shop_id = $1 and slug = 'xc-imp'", [a.shopId])).rows[0]!.id;
    const shelf = (await getPool().query<{ id: string }>("select id from categories where shop_id = $1 and slug = 'new-shelf'", [a.shopId])).rows[0]!.id;
    expect(await extras(id)).toEqual([shelf, sale]);
    await run({ products: [product] });
    expect(await extras(id)).toEqual([shelf, sale]);
    await run({ products: [{ ...product, extra_category_slugs: [] }] });
    expect(await extras(id)).toEqual([]);
  });

  it("restore_catalog は追加カテゴリーの id を振り直す", async () => {
    const tables = await asUser(a.ownerId, async (c) => {
      const out: Record<string, unknown[]> = {};
      for (const t of ["categories", "products", "skus", "inventory", "product_images", "orders", "order_items", "customers", "hook_endpoints"]) out[t] = (await c.query(`select ${t === "customers" ? CUSTOMER_COLUMNS : "*"} from ${t} where shop_id = $1`, [a.shopId])).rows;
      return out;
    });
    const dst = await asUser(a.ownerId, async (c) => (await c.query<{ id: string }>("insert into shops (owner_id, slug, name) values ($1, 'xc-dst', 'Dst') returning id", [a.ownerId])).rows[0]!.id);
    await asService((c) => c.query("select restore_shop_data($1, $2::jsonb)", [dst, JSON.stringify(tables)]));
    await asService((c) => c.query("select restore_catalog($1, $2::jsonb)", [dst, JSON.stringify(tables)]));
    const slugs = await getPool().query<{ slugs: string[] }>(
      "select array(select c.slug from unnest(p.extra_category_ids) with ordinality x(id, o) join categories c on c.id = x.id order by x.o) as slugs from products p where p.shop_id = $1 and p.slug = $2",
      [dst, (await getPool().query<{ slug: string }>("select slug from products where id = $1", [a.productId])).rows[0]!.slug],
    );
    expect(slugs.rows[0]!.slugs).toEqual(["sale", "gift"]);
  });

  it("クーポンの条件: tags / exclude_tags を受け付けて正規化する。形が違えば invalid_conditions_tags", async () => {
    const r = await rpc<{ conditions: Record<string, unknown> }>("api_coupon_create", [token, { name: "タグ", kind: "percent", value: 10, conditions: { tags: [" セール ", "セール", "冬"], exclude_tags: ["福袋"] } }]);
    expect(r.conditions).toEqual({ tags: ["セール", "冬"], exclude_tags: ["福袋"] });
    expect(await expectDbError(() => rpc("api_coupon_create", [token, { name: "x", kind: "percent", value: 10, conditions: { tags: "セール" } }]))).toMatch(/invalid_conditions_tags/);
    expect(await expectDbError(() => rpc("api_coupon_create", [token, { name: "x", kind: "percent", value: 10, conditions: { exclude_tags: [1] } }]))).toMatch(/invalid_conditions_exclude_tags/);
  });
});
