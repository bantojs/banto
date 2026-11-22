import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, closePool, createShopFixture, dbAvailable, getPool, resetDatabase, type Fixture } from "./harness";

/** 0162: ブランドごとの公開の商品の数（product_facets の brand、product_public_facets の brands）。文単位のトリガーが差分で数える */
describe.skipIf(!dbAvailable)("ブランドの件数（0162）", () => {
  let f: Fixture;
  const brands = async () => (await asAnon(async (c) => (await c.query<{ r: { brands: { brand: string; count: number }[] } }>("select product_public_facets($1) as r", [f.shopId])).rows[0]!.r)).brands;
  const owner = (sql: string, params: unknown[] = []) => asUser(f.ownerId, (c) => c.query(sql, params));
  const add = async (slug: string, brand: string | null, published = true) =>
    (await getPool().query<{ id: string }>("insert into products (shop_id, slug, name, brand, published) values ($1, $2, $2, $3, $4) returning id", [f.shopId, slug, brand, published])).rows[0]!.id;
  /** 差分の件数が作り直した結果と同じか */
  const consistent = async () => {
    const read = async () => (await getPool().query("select kind, key, count from product_facets where shop_id = $1 order by 1, 2", [f.shopId])).rows;
    const before = await read();
    await getPool().query("select banto_product_facets_rebuild($1)", [f.shopId]);
    expect(await read()).toEqual(before);
  };

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "vf-owner@example.com", slug: "vf-shop", publish: true });
  });
  afterAll(closePool);

  it("公開の商品だけ、多い順。ブランドの変更・非公開・削除で追従する", async () => {
    const base = await brands();
    const a1 = await add("a1", "ACME");
    await add("a2", "ACME");
    const b1 = await add("b1", "Beta");
    await add("hidden", "Hidden", false);
    await add("none", null);
    expect(await brands()).toEqual([...base, { brand: "ACME", count: 2 }, { brand: "Beta", count: 1 }].sort((x, y) => y.count - x.count || (x.brand < y.brand ? -1 : 1)));
    await owner("update products set brand = 'Beta' where id = $1", [a1]);
    expect((await brands()).filter((x) => x.brand !== "ACME" || x.count > 0)).toEqual(expect.arrayContaining([{ brand: "ACME", count: 1 }, { brand: "Beta", count: 2 }]));
    await owner("update products set published = false where id = $1", [b1]);
    expect(await brands()).toEqual(expect.arrayContaining([{ brand: "Beta", count: 1 }]));
    await owner("delete from products where id = $1", [a1]);
    const now = await brands();
    expect(now.find((x) => x.brand === "Beta")).toBeUndefined();
    expect(now.find((x) => x.brand === "Hidden")).toBeUndefined();
    await consistent();
  });

  it("会員だけに見せる商品（hide）は数えない", async () => {
    const aud = (await getPool().query<{ id: string }>("insert into audiences (shop_id, name, condition) values ($1, 'vip', '{\"member\":true}'::jsonb) returning id", [f.shopId])).rows[0]!.id;
    const p = await add("vip", "Secret");
    expect((await brands()).some((x) => x.brand === "Secret")).toBe(true);
    await getPool().query("update products set audience_id = $1, audience_mode = 'hide' where id = $2", [aud, p]);
    expect((await brands()).some((x) => x.brand === "Secret")).toBe(false);
    await consistent();
  });

  it("非公開のショップは空。運営者は product_facets を読めるが書けない", async () => {
    const other = await createShopFixture({ email: "vf-other@example.com", slug: "vf-other", publish: false });
    expect((await asAnon(async (c) => (await c.query<{ r: { brands: unknown[] } }>("select product_public_facets($1) as r", [other.shopId])).rows[0]!.r)).brands).toEqual([]);
    await expect(owner("insert into product_facets (shop_id, kind, key, count) values ($1, 'brand', 'x', 1)", [f.shopId])).rejects.toThrow(/permission denied/);
  });
});
