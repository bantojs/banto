import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, closePool, createShopFixture, dbAvailable, expectDbError, resetDatabase, type Fixture } from "./harness";

/** 0091_image_variants: 商品画像の中間の段（長辺）の列と、一覧（product_public_list）が返すこと */
describe.skipIf(!dbAvailable)("商品画像の中間の段（0091）", () => {
  let a: Fixture;
  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "iv-a@example.com", slug: "iv-a", publish: true, stock: 5 });
  });
  afterAll(closePool);

  const insert = (variants: string) =>
    asUser(a.ownerId, (c) =>
      c.query(`insert into product_images (shop_id, product_id, storage_key, thumb_key, width, height, variants) values ($1, $2, $3, $4, 2560, 1920, ${variants}) returning id`, [
        a.shopId, a.productId, `shops/${a.shopId}/products/${a.productId}/x${Math.random().toString(16).slice(2)}.webp`, null,
      ]),
    );

  it("決まった長辺だけ・4 つまで。既定は空", async () => {
    await insert("'{800,1600,2048}'");
    await insert("default");
    expect(await expectDbError(() => insert("'{900}'"))).toMatch(/check/);
    expect(await expectDbError(() => insert("'{3200}'"))).toMatch(/check/);
    expect(await expectDbError(() => insert("'{800,1600,2048,2560,800}'"))).toMatch(/check/);
  });

  it("一覧の画像に variants が入る（anon）", async () => {
    const r = await asAnon(async (c) => (await c.query<{ r: { items: { slug: string; image: { variants: number[] } | null }[] } }>("select product_public_list($1) as r", [a.shopId])).rows[0]!.r);
    const item = r.items.find((x) => x.image);
    expect(item?.image?.variants).toEqual([800, 1600, 2048]);
  });
});
