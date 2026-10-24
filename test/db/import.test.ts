import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

describe.skipIf(!dbAvailable)("一括取り込み import_catalog（0009）", () => {
  let a: Fixture;
  let b: Fixture;
  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "imp-a@example.com", slug: "imp-a", publish: true, stock: 1 });
    b = await createShopFixture({ email: "imp-b@example.com", slug: "imp-b", publish: true, stock: 1 });
  });
  afterAll(closePool);

  const run = (f: Fixture, batch: unknown) => asUser(f.ownerId, async (c) => (await c.query<{ r: Record<string, unknown> }>("select import_catalog($1, $2::jsonb) as r", [f.shopId, JSON.stringify(batch)])).rows[0]!.r);
  const stockOf = async (code: string) => (await getPool().query<{ available: number }>("select i.available from inventory i join skus k on k.id = i.sku_id where k.code = $1", [code])).rows[0]?.available;

  const batch = {
    categories: [
      { slug: "c-tops", name: "トップス" },
      { slug: "c-knit", name: "ニット", parent_slug: "c-tops" },
    ],
    products: [
      {
        slug: "hccbd-s55",
        name: "ドルマンニット",
        description: "説明",
        published: true,
        tags: ["NEW", "NEW", "オンライン先行"],
        brand: "プレミアムバリュー",
        attributes: { material: "ウール100％", nested: { x: 1 } },
        category_slug: "c-knit",
        skus: [
          { code: "HCCBD-S5501", name: "Blue / S", price_jpy: 7990, compare_at_price_jpy: 9990, gtin: "2000005221484", options: { Color: "Blue", Size: "01(S)" }, available: 2 },
          { code: "HCCBD-S5502", price_jpy: 7990, compare_at_price_jpy: 7990, gtin: "123", available: 0 },
        ],
      },
      { slug: "broken", name: "", skus: [{ code: "BROKEN-1", price_jpy: 100 }] },
    ],
    overwrite_stock: true,
  };

  it("カテゴリー・商品・SKU・在庫を作る。不備のある商品だけ飛ばしてエラーで返す", async () => {
    const r = await run(a, batch);
    expect(r).toMatchObject({ categories: 2, products_created: 1, products_updated: 0, skus_created: 2, skus_updated: 0 });
    expect(r["errors"]).toEqual([expect.objectContaining({ slug: "broken" })]);
    const p = (await getPool().query("select p.*, c.slug as cat from products p left join categories c on c.id = p.category_id where p.slug = 'hccbd-s55'")).rows[0];
    expect(p).toMatchObject({ name: "ドルマンニット", published: true, tags: ["NEW", "オンライン先行"], brand: "プレミアムバリュー", attributes: { material: "ウール100％" }, cat: "c-knit" });
    const knit = (await getPool().query("select c.slug, p.slug as parent from categories c join categories p on p.id = c.parent_id where c.slug = 'c-knit'")).rows[0];
    expect(knit).toMatchObject({ parent: "c-tops" });
    const skus = (await getPool().query("select code, compare_at_price_jpy, gtin, options from skus where code like 'HCCBD%' order by code")).rows;
    // 通常価格が販売価格以下、JAN の形が違うものは捨てる（取り込み自体は止めない）
    expect(skus).toEqual([
      { code: "HCCBD-S5501", compare_at_price_jpy: 9990, gtin: "2000005221484", options: { Color: "Blue", Size: "01(S)" } },
      { code: "HCCBD-S5502", compare_at_price_jpy: null, gtin: null, options: {} },
    ]);
    expect(await stockOf("HCCBD-S5501")).toBe(2);
    expect((await getPool().query("select count(*)::int as n from products where slug = 'broken'")).rows[0].n).toBe(0);
  });

  it("同じ内容をもう一度取り込んでも重複しない。在庫の上書きは選べる。カスタム項目はマージ", async () => {
    await getPool().query("update products set attributes = attributes || '{\"memo\": \"手で入れた\"}' where slug = 'hccbd-s55'");
    await getPool().query("update inventory set available = 9 where sku_id = (select id from skus where code = 'HCCBD-S5501')");
    const again = await run(a, { ...batch, products: [batch.products[0]], overwrite_stock: false });
    expect(again).toMatchObject({ products_created: 0, products_updated: 1, skus_created: 0, skus_updated: 2, errors: [] });
    expect(await stockOf("HCCBD-S5501")).toBe(9);
    expect((await getPool().query("select attributes from products where slug = 'hccbd-s55'")).rows[0].attributes).toEqual({ material: "ウール100％", memo: "手で入れた" });
    await run(a, { products: [batch.products[0]], overwrite_stock: true });
    expect(await stockOf("HCCBD-S5501")).toBe(2);
    expect((await getPool().query("select count(*)::int as n from skus where code like 'HCCBD%'")).rows[0].n).toBe(2);
  });

  it("他のショップの SKU コードと衝突したら、その商品だけエラー。他人のショップや anon からは呼べない", async () => {
    const r = await run(a, { products: [{ slug: "other", name: "別の商品", skus: [{ code: "HCCBD-S5501", price_jpy: 1 }] }] });
    expect((r["errors"] as { message: string }[])[0]!.message).toMatch(/sku_belongs_to_other_product/);
    expect(await expectDbError(() => asUser(b.ownerId, (c) => c.query("select import_catalog($1, '{}'::jsonb)", [a.shopId])))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => asAnon((c) => c.query("select import_catalog($1, '{}'::jsonb)", [a.shopId])))).toMatch(/permission denied/);
  });
});
