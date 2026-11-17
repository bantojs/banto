import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0137_catalog_bulk: 商品のまとめて編集の保存（catalog_bulk_update）。変えたマスだけを開いたときの値と一緒に受け取り、
 * 誤り・食い違いが 1 つでもあれば何も変えずにマスを並べて返す。項目 catalog、shop_id で絞る（security definer）
 */
describe.skipIf(!dbAvailable)("商品のまとめて編集（0137）", () => {
  let a: Fixture;
  let b: Fixture;
  let catA: string;
  let catB: string;
  let shipper: string;
  let stocker: string;
  type Change = { kind: "product" | "sku"; id: string; col: string; from: string | null; to: string | null };
  const save = (uid: string, shopId: string, changes: Change[] | unknown) =>
    asUser(uid, async (c) => (await c.query<{ r: { ok: boolean; errors?: { id: string; col: string; error: string; current?: string | null }[]; products?: number; skus?: number } }>("select catalog_bulk_update($1, $2::jsonb) as r", [shopId, JSON.stringify(changes)])).rows[0]!.r);
  const product = async (id: string) => (await getPool().query<{ name: string; published: boolean; category_id: string | null; tags: string[]; brand: string | null; tax_class: string }>("select name, published, category_id, tags, brand, tax_class from products where id = $1", [id])).rows[0]!;
  const sku = async (id: string) => (await getPool().query<{ price_jpy: number; compare_at_price_jpy: number | null; gtin: string | null }>("select price_jpy, compare_at_price_jpy, gtin from skus where id = $1", [id])).rows[0]!;
  const member = async (email: string, perms: string[]) => {
    const uid = await createAuthUser(email);
    const org = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [a.shopId])).rows[0]!.org_id;
    await getPool().query("insert into org_members (org_id, user_id, role) values ($1, $2, 'member')", [org, uid]);
    await getPool().query("insert into org_member_shops (org_id, user_id, shop_id, perms) values ($1, $2, $3, $4)", [org, uid, a.shopId, perms]);
    return uid;
  };

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "bulk-a@example.com", slug: "bulk-a" });
    b = await createShopFixture({ email: "bulk-b@example.com", slug: "bulk-b" });
    catA = (await asUser(a.ownerId, (c) => c.query<{ id: string }>("insert into categories (shop_id, slug, name) values ($1, 'tops', 'トップス') returning id", [a.shopId]))).rows[0]!.id;
    catB = (await asUser(b.ownerId, (c) => c.query<{ id: string }>("insert into categories (shop_id, slug, name) values ($1, 'tops', 'トップス') returning id", [b.shopId]))).rows[0]!.id;
    shipper = await member("bulk-ship@example.com", ["orders"]);
    stocker = await member("bulk-cat@example.com", ["catalog"]);
  });
  afterAll(closePool);

  it("商品と SKU のマスをまとめて変える。価格と通常価格を同時に上げても途中で制約に掛からない", async () => {
    const r = await save(stocker, a.shopId, [
      { kind: "product", id: a.productId, col: "name", from: "Tシャツ", to: " 白T " },
      { kind: "product", id: a.productId, col: "published", from: "false", to: "true" },
      { kind: "product", id: a.productId, col: "category_id", from: null, to: catA },
      { kind: "product", id: a.productId, col: "tags", from: null, to: "夏, 白 ,夏," },
      { kind: "product", id: a.productId, col: "brand", from: null, to: "Banto" },
      { kind: "product", id: a.productId, col: "tax_class", from: "standard", to: "reduced" },
      { kind: "sku", id: a.skuId, col: "price_jpy", from: "3000", to: "5000" },
      { kind: "sku", id: a.skuId, col: "compare_at_price_jpy", from: null, to: "6000" },
      { kind: "sku", id: a.skuId, col: "gtin", from: null, to: "4900000000001" },
    ]);
    expect(r).toEqual({ ok: true, products: 1, skus: 1 });
    expect(await product(a.productId)).toEqual({ name: "白T", published: true, category_id: catA, tags: ["夏", "白"], brand: "Banto", tax_class: "reduced" });
    expect(await sku(a.skuId)).toEqual({ price_jpy: 5000, compare_at_price_jpy: 6000, gtin: "4900000000001" });
    // 空で外す（カテゴリー・タグ・ブランド・通常価格・JAN）
    await save(a.ownerId, a.shopId, [
      { kind: "product", id: a.productId, col: "category_id", from: catA, to: "" },
      { kind: "product", id: a.productId, col: "tags", from: "夏, 白", to: "" },
      { kind: "product", id: a.productId, col: "brand", from: "Banto", to: null },
      { kind: "sku", id: a.skuId, col: "compare_at_price_jpy", from: "6000", to: "" },
      { kind: "sku", id: a.skuId, col: "gtin", from: "4900000000001", to: "" },
    ]);
    expect(await product(a.productId)).toMatchObject({ category_id: null, tags: [], brand: null });
    expect(await sku(a.skuId)).toMatchObject({ compare_at_price_jpy: null, gtin: null });
  });

  it("誤りと食い違いは 1 つでもあれば何も変えず、マスを全部並べて返す", async () => {
    const before = { p: await product(a.productId), s: await sku(a.skuId) };
    const r = await save(stocker, a.shopId, [
      { kind: "product", id: a.productId, col: "name", from: "白T", to: "" },
      { kind: "product", id: a.productId, col: "tax_class", from: "reduced", to: "zero" },
      { kind: "product", id: a.productId, col: "category_id", from: null, to: catB },
      { kind: "product", id: a.productId, col: "brand", from: "違う", to: "x" },
      { kind: "sku", id: a.skuId, col: "price_jpy", from: "5000", to: "1.5" },
      { kind: "sku", id: a.skuId, col: "gtin", from: null, to: "123" },
      { kind: "sku", id: b.skuId, col: "price_jpy", from: "3000", to: "1" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors!.map((e) => [e.col, e.error])).toEqual([
      ["name", "invalid"],
      ["tax_class", "invalid"],
      ["category_id", "invalid"],
      ["brand", "changed"],
      ["price_jpy", "invalid"],
      ["gtin", "invalid"],
      ["price_jpy", "not_found"],
    ]);
    expect(r.errors!.find((e) => e.error === "changed")!.current).toBeNull();
    expect(await product(a.productId)).toEqual(before.p);
    expect(await sku(a.skuId)).toEqual(before.s);
    expect(await sku(b.skuId)).toMatchObject({ price_jpy: 3000 });
  });

  it("通常価格は保存したあとの価格より大きいこと（価格だけ下げずに上げたときも）", async () => {
    await save(a.ownerId, a.shopId, [{ kind: "sku", id: a.skuId, col: "compare_at_price_jpy", from: null, to: "6000" }]);
    let r = await save(a.ownerId, a.shopId, [{ kind: "sku", id: a.skuId, col: "price_jpy", from: "5000", to: "7000" }]);
    expect(r.errors).toEqual([{ kind: "sku", id: a.skuId, col: "price_jpy", error: "compare_at_low" }]);
    r = await save(a.ownerId, a.shopId, [{ kind: "sku", id: a.skuId, col: "compare_at_price_jpy", from: "6000", to: "5000" }]);
    expect(r.errors).toEqual([{ kind: "sku", id: a.skuId, col: "compare_at_price_jpy", error: "compare_at_low" }]);
    expect(await sku(a.skuId)).toMatchObject({ price_jpy: 5000, compare_at_price_jpy: 6000 });
  });

  it("前後に空白のある今の値（API で作った商品など）も、開いたときの値として受け付ける", async () => {
    await getPool().query("update products set name = '商品A ', brand = ' B ' where id = $1", [a.productId]);
    expect(await save(a.ownerId, a.shopId, [{ kind: "product", id: a.productId, col: "name", from: "商品A", to: "商品B" }, { kind: "product", id: a.productId, col: "brand", from: "B", to: "C" }])).toEqual({ ok: true, products: 1, skus: 0 });
    expect(await product(a.productId)).toMatchObject({ name: "商品B", brand: "C" });
    await getPool().query("update products set name = '白T', brand = null where id = $1", [a.productId]);
  });

  it("形の違う変更の並び・項目の無い人・他人のショップ・anon は断る", async () => {
    for (const bad of [{}, [{ kind: "order", id: a.productId, col: "name", from: null, to: "x" }], [{ kind: "product", id: a.productId, col: "slug", from: "tee", to: "x" }], [{ kind: "product", id: a.productId, col: "name", to: "x" }], [{ kind: "product", id: a.productId, col: "name", from: "白T", to: 1 }]]) {
      expect(await expectDbError(() => save(a.ownerId, a.shopId, bad))).toMatch(/invalid_changes/);
    }
    expect(await expectDbError(() => save(shipper, a.shopId, []))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => save(b.ownerId, a.shopId, []))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => asAnon((c) => c.query("select catalog_bulk_update($1, '[]'::jsonb)", [a.shopId])))).toMatch(/permission denied/);
  });
});
