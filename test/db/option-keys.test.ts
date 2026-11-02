import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** 0094_option_keys: SKU の選択肢の鍵を英字の key と表示名（shops.option_names）に分ける */
describe.skipIf(!dbAvailable)("SKU の選択肢の key と表示名（0094）", () => {
  let a: Fixture;
  let stranger: string;
  const as = <T>(sql: string, args: unknown[] = []) => asUser(a.ownerId, async (c) => (await c.query(sql, args)).rows as T[]);
  const names = async (shopId = a.shopId) => (await getPool().query<{ n: Record<string, string> }>("select option_names as n from shops where id = $1", [shopId])).rows[0]!.n;

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "ok-a@example.com", slug: "ok-a", publish: true, stock: 5 });
    stranger = await createAuthUser("ok-x@example.com");
  });
  afterAll(closePool);

  it("名前で書いても key で置き、名前の表に足す。よくある名前は決まった key、英字はそのまま、ほかは opt1", async () => {
    await as("update skus set options = $2 where id = $1", [a.skuId, JSON.stringify({ サイズ: "M", カラー: "白", 型番: "A1", Finish: "Matte" })]);
    const row = (await getPool().query<{ o: Record<string, string> }>("select options as o from skus where id = $1", [a.skuId])).rows[0]!.o;
    expect(row).toEqual({ size: "M", color: "白", opt1: "A1", finish: "Matte" });
    expect(await names()).toEqual({ size: "サイズ", color: "カラー", opt1: "型番", finish: "Finish" });
    // key でも、名前の大文字小文字が違っても、同じ key
    await as("update skus set options = $2 where id = $1", [a.skuId, JSON.stringify({ size: "L", カラー: "黒", 型番: "A2", finish: "Gloss" })]);
    expect((await getPool().query("select options from skus where id = $1", [a.skuId])).rows[0].options).toEqual({ size: "L", color: "黒", opt1: "A2", finish: "Gloss" });
  });

  it("決まった key がもう別の名前で使われていれば _2。名前と key が同じ key に重なれば断る", async () => {
    await as("update skus set options = $2 where id = $1", [a.skuId, JSON.stringify({ 色: "赤" })]);
    expect((await getPool().query("select options from skus where id = $1", [a.skuId])).rows[0].options).toEqual({ color_2: "赤" });
    expect(await expectDbError(() => as("update skus set options = $2 where id = $1", [a.skuId, JSON.stringify({ size: "M", サイズ: "L" })]))).toMatch(/option_key_conflict/);
  });

  it("軸（ショップ・カテゴリー・商品）と画像の options も key。ショップの軸は自分の行の表に足す", async () => {
    await as("update shops set option_axes = $2 where id = $1", [a.shopId, JSON.stringify([{ key: "素材" }])]);
    expect((await getPool().query("select option_axes from shops where id = $1", [a.shopId])).rows[0].option_axes).toEqual([{ key: "material" }]);
    expect((await names()).material).toBe("素材");
    const [cat] = await as<{ option_axes: unknown }>("insert into categories (shop_id, slug, name, option_axes) values ($1, 'hats', 'hats', $2) returning option_axes", [a.shopId, JSON.stringify([{ key: "サイズ", values: ["S", "M"] }])]);
    expect(cat!.option_axes).toEqual([{ key: "size", values: ["S", "M"] }]);
    const [img] = await as<{ options: unknown }>("insert into product_images (shop_id, product_id, storage_key, options) values ($1, $2, $3, $4) returning options", [a.shopId, a.productId, `shops/${a.shopId}/products/${a.productId}/x.webp`, JSON.stringify({ カラー: "白" })]);
    expect(img!.options).toEqual({ color: "白" });
  });

  it("表示名を変えても key は変わらない（catalog の項目）。重なる名前・知らない key は断る。お客様の画面のショップに名前の表が出る", async () => {
    expect(await as("select option_names_set($1, $2)", [a.shopId, JSON.stringify({ size: "Size（日本）" })])).toBeTruthy();
    expect((await names()).size).toBe("Size（日本）");
    expect((await getPool().query("select options from skus where id = $1", [a.skuId])).rows[0].options).toEqual({ color_2: "赤" });
    expect(await expectDbError(() => as("select option_names_set($1, $2)", [a.shopId, JSON.stringify({ color: "Size（日本）" })]))).toMatch(/invalid_option_names/);
    expect(await expectDbError(() => as("select option_names_set($1, $2)", [a.shopId, JSON.stringify({ nope: "x" })]))).toMatch(/invalid_option_names/);
    expect(await expectDbError(() => asUser(stranger, (c) => c.query("select option_names_set($1, $2)", [a.shopId, JSON.stringify({ size: "x" })])))).toMatch(/forbidden/);
    // 運営者の JWT から列を直接は書けない
    expect(await expectDbError(() => as("update shops set option_names = '{}'::jsonb where id = $1", [a.shopId]))).toMatch(/permission denied/);
    const shop = await asAnon(async (c) => (await c.query<{ r: { option_names: Record<string, string> } }>("select shop_public_get($1) as r", ["ok-a"])).rows[0]!.r);
    expect(shop.option_names.size).toBe("Size（日本）");
  });

  it("既存のデータの書き換え: 名前の鍵の SKU・軸・画像を key にし、軸と SKU が合ったまま", async () => {
    const b = await createShopFixture({ email: "ok-b@example.com", slug: "ok-b", publish: true, stock: 5 });
    const pool = getPool();
    // 0094 より前の形を作る（key に直すトリガーと 0065 の確かめを止めて、名前の鍵で置く）
    for (const t of ["skus.skus_00_option_keys", "skus.skus_option_axes", "products.products_00_option_keys", "products.products_option_axes", "product_images.product_images_zz_option_keys"]) {
      const [table, trig] = t.split(".");
      await pool.query(`alter table ${table} disable trigger ${trig}`);
    }
    try {
      await pool.query("update products set option_axes = $2 where id = $1", [b.productId, JSON.stringify([{ key: "カラー" }, { key: "サイズ" }])]);
      await pool.query("update skus set options = $2 where id = $1", [b.skuId, JSON.stringify({ カラー: "白", サイズ: "M" })]);
      await pool.query("insert into product_images (shop_id, product_id, storage_key, options) values ($1, $2, 'k.webp', $3)", [b.shopId, b.productId, JSON.stringify({ カラー: "白" })]);
    } finally {
      for (const t of ["skus.skus_00_option_keys", "skus.skus_option_axes", "products.products_00_option_keys", "products.products_option_axes", "product_images.product_images_zz_option_keys"]) {
        const [table, trig] = t.split(".");
        await pool.query(`alter table ${table} enable trigger ${trig}`);
      }
    }
    // マイグレーションと同じく、書き換えのあいだは 0065 の確かめ（軸と SKU が一時的に食い違う）を止める
    await pool.query("alter table skus disable trigger skus_option_axes");
    await pool.query("alter table products disable trigger products_option_axes");
    try {
      await pool.query("select banto_option_keys_convert_shop($1)", [b.shopId]);
    } finally {
      await pool.query("alter table skus enable trigger skus_option_axes");
      await pool.query("alter table products enable trigger products_option_axes");
    }
    expect((await pool.query("select option_axes from products where id = $1", [b.productId])).rows[0].option_axes).toEqual([{ key: "color" }, { key: "size" }]);
    expect((await pool.query("select options from skus where id = $1", [b.skuId])).rows[0].options).toEqual({ color: "白", size: "M" });
    expect((await pool.query("select options from product_images where product_id = $1", [b.productId])).rows[0].options).toEqual({ color: "白" });
    expect(await names(b.shopId)).toEqual({ color: "カラー", size: "サイズ" });
    // 書き換えたあとも 0065 の守りが効く（軸に合わない SKU は断る）
    expect(await expectDbError(() => asUser(b.ownerId, (c) => c.query("update skus set options = $2 where id = $1", [b.skuId, JSON.stringify({ カラー: "白" })])))).toMatch(/option_axes_mismatch/);
  });

  it("復元: バックアップの名前の表で上書きする", async () => {
    const c = await createShopFixture({ email: "ok-c@example.com", slug: "ok-c", publish: true, stock: 5 });
    await asUser(c.ownerId, (x) => x.query("update skus set options = $2 where id = $1", [c.skuId, JSON.stringify({ size: "M" })]));
    expect(await names(c.shopId)).toEqual({ size: "size" });
    await getPool().query("set role service_role");
    try {
      await getPool().query("select restore_option_axes($1, $2)", [c.shopId, JSON.stringify({ option_names: { size: "サイズ", color: "カラー" } })]);
    } finally {
      await getPool().query("reset role");
    }
    expect(await names(c.shopId)).toEqual({ size: "サイズ", color: "カラー" });
  });
});
