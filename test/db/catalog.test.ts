import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { asAnon, asService, asUser, closePool, createShopFixture, CUSTOMER_COLUMNS, dbAvailable, expectDbError, resetDatabase, type Fixture } from "./harness";

describe.skipIf(!dbAvailable)("商品マスタの拡張（0008_catalog）", () => {
  let a: Fixture;
  let b: Fixture;

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "cat-a@example.com", slug: "cat-a", publish: true, stock: 3 });
    b = await createShopFixture({ email: "cat-b@example.com", slug: "cat-b", publish: true, stock: 3 });
  });
  afterAll(closePool);

  const insertCategory = (f: Fixture, slug: string, parent: string | null = null) =>
    asUser(f.ownerId, async (c) => (await c.query<{ id: string }>("insert into categories (shop_id, slug, name, parent_id) values ($1, $2, $3, $4) returning id", [f.shopId, slug, slug.toUpperCase(), parent])).rows[0]!.id);

  it("カテゴリー: owner が書け、公開中のショップなら anon が読める。他人のショップには書けない", async () => {
    const top = await insertCategory(a, "wear");
    const rows = await asAnon(async (c) => (await c.query<{ slug: string }>("select slug from categories where shop_id = $1", [a.shopId])).rows);
    expect(rows.map((r) => r.slug)).toEqual(["wear"]);
    expect(await expectDbError(() => asUser(b.ownerId, (c) => c.query("insert into categories (shop_id, slug, name) values ($1, 'x', 'X')", [a.shopId])))).toMatch(/row-level security/);
    // 他のショップのカテゴリーを親にはできない（複合外部キー）
    expect(await expectDbError(() => asUser(b.ownerId, (c) => c.query("insert into categories (shop_id, slug, name, parent_id) values ($1, 'y', 'Y', $2)", [b.shopId, top])))).toMatch(/foreign key/);
  });

  it("3 段まで。循環させない。親を消すと子は最上位、商品は未分類になる", async () => {
    const l1 = await insertCategory(a, "l1");
    const l2 = await insertCategory(a, "l2", l1);
    const l3 = await insertCategory(a, "l3", l2);
    expect(await expectDbError(() => insertCategory(a, "l4", l3))).toMatch(/category_too_deep/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("update categories set parent_id = $2 where id = $1", [l1, l3])))).toMatch(/category_cycle|category_too_deep/);
    // 子孫ごと別の 2 段目の下に付け替えると 4 段になるので拒否
    const other = await insertCategory(a, "other");
    const otherChild = await insertCategory(a, "other-child", other);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("update categories set parent_id = $2 where id = $1", [l2, otherChild])))).toMatch(/category_too_deep/);

    await asUser(a.ownerId, (c) => c.query("update products set category_id = $2 where id = $1", [a.productId, l2]));
    await asUser(a.ownerId, (c) => c.query("delete from categories where id = $1", [l2]));
    const p = await asUser(a.ownerId, async (c) => (await c.query<{ category_id: string | null }>("select category_id from products where id = $1", [a.productId])).rows[0]!);
    expect(p.category_id).toBeNull();
    const child = await asUser(a.ownerId, async (c) => (await c.query<{ parent_id: string | null }>("select parent_id from categories where id = $1", [l3])).rows[0]!);
    expect(child.parent_id).toBeNull();
  });

  it("商品と SKU の拡張列の制約", async () => {
    const bCat = await insertCategory(b, "b-only");
    // 他のショップのカテゴリーは付けられない
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("update products set category_id = $2 where id = $1", [a.productId, bCat])))).toMatch(/foreign key/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("update products set attributes = '[1]' where id = $1", [a.productId])))).toMatch(/check constraint/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("update skus set gtin = '123' where id = $1", [a.skuId])))).toMatch(/check constraint/);
    const price = await asUser(a.ownerId, async (c) => (await c.query<{ price_jpy: number }>("select price_jpy from skus where id = $1", [a.skuId])).rows[0]!.price_jpy);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("update skus set compare_at_price_jpy = $2 where id = $1", [a.skuId, price])))).toMatch(/check constraint/);
    await asUser(a.ownerId, (c) => c.query("update skus set gtin = '4901234567894', compare_at_price_jpy = $2, options = '{\"サイズ\": \"M\"}' where id = $1", [a.skuId, price + 500]));
    await asUser(a.ownerId, (c) => c.query("update products set brand = 'Banto', attributes = '{\"material\": \"綿\"}' where id = $1", [a.productId]));
  });

  it("AI 用 API: カテゴリーの作成・一覧、商品とSKUの拡張項目、不明なカテゴリーは拒否", async () => {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    const hash = createHash("sha256").update(raw).digest("hex");
    await asUser(a.ownerId, (c) =>
      c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [a.shopId, a.ownerId, hash, raw.slice(0, 12), ["products:read", "products:write"]]),
    );
    const rpc = <T>(fn: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);

    const parent = await rpc<{ id: string; slug: string }>("api_category_save", [hash, { slug: "shoes", name: "靴" }]);
    const child = await rpc<{ parent_id: string }>("api_category_save", [hash, { slug: "sneakers", name: "スニーカー", parent: "shoes" }]);
    expect(child.parent_id).toBe(parent.id);
    // 同じ slug なら更新
    const renamed = await rpc<{ name: string }>("api_category_save", [hash, { slug: "sneakers", name: "スニーカー（新）" }]);
    expect(renamed.name).toBe("スニーカー（新）");
    const list = await rpc<{ slug: string }[]>("api_categories_list", [hash]);
    expect(list.map((x) => x.slug)).toEqual(expect.arrayContaining(["shoes", "sneakers"]));

    const created = await rpc<{ id: string; category: { slug: string }; brand: string; attributes: Record<string, unknown> }>("api_product_create", [
      hash,
      { slug: "runner", name: "ランナー", category: "sneakers", brand: " Banto ", attributes: { material: "メッシュ", weight: 280, nested: { x: 1 }, "": "bad" } },
    ]);
    expect(created).toMatchObject({ category: { slug: "sneakers" }, brand: "Banto", attributes: { material: "メッシュ", weight: 280 } });
    expect(created.attributes).not.toHaveProperty("nested");
    expect(await expectDbError(() => rpc("api_product_update", [hash, created.id, { category: "nope" }]))).toMatch(/category_not_found/);
    const cleared = await rpc<{ category: unknown }>("api_product_update", [hash, created.id, { category: "" }]);
    expect(cleared.category).toBeNull();

    const withSku = await rpc<{ skus: { options: Record<string, unknown>; gtin: string; compare_at_price_jpy: number }[] }>("api_sku_create", [
      hash,
      created.id,
      { code: "RUN-26", price_jpy: 9000, compare_at_price_jpy: 12000, gtin: "4901234567894", options: { サイズ: "26cm", 色: "白" } },
    ]);
    expect(withSku.skus[0]).toMatchObject({ options: { サイズ: "26cm", 色: "白" }, gtin: "4901234567894", compare_at_price_jpy: 12000 });
  });

  it("restore_catalog はカテゴリー（親子）と拡張列を slug / code で戻す。service_role だけが呼べる", async () => {
    const tables = await asUser(a.ownerId, async (c) => {
      const out: Record<string, unknown[]> = {};
      for (const t of ["categories", "products", "skus", "inventory", "product_images", "orders", "order_items", "customers", "hook_endpoints"]) out[t] = (await c.query(`select ${t === "customers" ? CUSTOMER_COLUMNS : "*"} from ${t} where shop_id = $1`, [a.shopId])).rows;
      return out;
    });
    const dst = await asUser(a.ownerId, async (c) => (await c.query<{ id: string }>("insert into shops (owner_id, slug, name) values ($1, 'cat-dst', 'Dst') returning id", [a.ownerId])).rows[0]!.id);
    await asService((c) => c.query("select restore_shop_data($1, $2::jsonb)", [dst, JSON.stringify(tables)]));
    const counts = await asService(async (c) => (await c.query<{ r: Record<string, number> }>("select restore_catalog($1, $2::jsonb) as r", [dst, JSON.stringify(tables)])).rows[0]!.r);
    expect(counts.categories).toBe(tables["categories"]!.length);

    const runner = await asUser(a.ownerId, async (c) =>
      (await c.query<{ brand: string; attributes: Record<string, unknown>; cat: string | null }>("select p.brand, p.attributes, c.slug as cat from products p left join categories c on c.id = p.category_id where p.shop_id = $1 and p.slug = 'runner'", [dst])).rows[0]!,
    );
    expect(runner).toMatchObject({ brand: "Banto", attributes: { material: "メッシュ" }, cat: null });
    const sneakers = await asUser(a.ownerId, async (c) =>
      (await c.query<{ parent: string }>("select p.slug as parent from categories c join categories p on p.id = c.parent_id where c.shop_id = $1 and c.slug = 'sneakers'", [dst])).rows[0]!,
    );
    expect(sneakers.parent).toBe("shoes");
    const sku = await asUser(a.ownerId, async (c) => (await c.query<{ gtin: string; compare_at_price_jpy: number; options: Record<string, unknown> }>("select gtin, compare_at_price_jpy, options from skus where shop_id = $1 and code = 'RUN-26'", [dst])).rows[0]!);
    expect(sku).toMatchObject({ gtin: "4901234567894", compare_at_price_jpy: 12000, options: { サイズ: "26cm" } });

    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select restore_catalog($1, '{}'::jsonb)", [dst])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asAnon((c) => c.query("select api_categories_list('x')")))).toMatch(/permission denied/);
  });
});
