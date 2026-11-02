import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, closePool, createShopFixture, dbAvailable, expectDbError, resetDatabase, type Fixture } from "./harness";

/** 0091_image_variants: 商品画像の中間の段（横幅）・サムネイルの横幅の列と、一覧（product_public_list）が返すこと */
describe.skipIf(!dbAvailable)("商品画像の中間の段（0091）", () => {
  let a: Fixture;
  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "iv-a@example.com", slug: "iv-a", publish: true, stock: 5 });
  });
  afterAll(closePool);

  const insert = (variants: string, thumbWidth = "400") =>
    asUser(a.ownerId, (c) =>
      c.query(`insert into product_images (shop_id, product_id, storage_key, thumb_key, width, height, variants, thumb_width) values ($1, $2, $3, $4, 2560, 1920, ${variants}, ${thumbWidth}) returning id`, [
        a.shopId, a.productId, `shops/${a.shopId}/products/${a.productId}/x${Math.random().toString(16).slice(2)}.webp`, null,
      ]),
    );

  it("決まった横幅だけ・4 つまで。既定は空", async () => {
    await insert("'{800,1600,2048}'");
    await insert("default");
    expect(await expectDbError(() => insert("'{900}'"))).toMatch(/check/);
    expect(await expectDbError(() => insert("'{3200}'"))).toMatch(/check/);
    expect(await expectDbError(() => insert("'{800,1600,2048,2560,800}'"))).toMatch(/check/);
    // サムネイルの横幅は 400 まで（null は前からあるもの）
    await insert("default", "null");
    expect(await expectDbError(() => insert("default", "401"))).toMatch(/check/);
  });

  it("一覧の画像に variants が入る（anon）", async () => {
    const r = await asAnon(async (c) => (await c.query<{ r: { items: { slug: string; image: { variants: number[]; thumb_width: number | null } | null }[] } }>("select product_public_list($1) as r", [a.shopId])).rows[0]!.r);
    const item = r.items.find((x) => x.image);
    expect(item?.image?.variants).toEqual([800, 1600, 2048]);
    expect(item?.image?.thumb_width).toBe(400);
  });
});
