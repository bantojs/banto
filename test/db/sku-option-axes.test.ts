import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const COLOR_SIZE = [{ key: "カラー", values: ["レッド", "ブルー"] }, { key: "サイズ", values: ["S", "M", "L"] }];

/**
 * 0065_sku_option_axes: SKU を分ける軸。ショップ → カテゴリー（親から子へ）→ 商品のひな形を写す・SKU の守り・一括で当てる・
 * 取り込みは写さない・AI 用 API・復元を確かめる。
 */
describe.skipIf(!dbAvailable)("SKU を分ける軸（0065）", () => {
  let a: Fixture;
  let stranger: string;
  let wear: string;
  let tops: string;
  let cable: string;
  let token: string;

  const as = <T>(sql: string, args: unknown[] = []) => asUser(a.ownerId, async (c) => (await c.query(sql, args)).rows as T[]);
  const newProduct = async (slug: string, categoryId: string | null) =>
    (await as<{ id: string; option_axes: unknown }>("insert into products (shop_id, slug, name, category_id) values ($1, $2, $3, $4) returning id, option_axes", [a.shopId, slug, slug, categoryId]))[0]!;
  const addSku = (productId: string, code: string, options: Record<string, string>) =>
    as("insert into skus (shop_id, product_id, code, price_jpy, options) values ($1, $2, $3, 1000, $4)", [a.shopId, productId, code, JSON.stringify(options)]);
  const axesOf = (id: string) => getPool().query<{ a: unknown; c: boolean }>("select option_axes as a, option_axes_custom as c from products where id = $1", [id]).then((r) => r.rows[0]!);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "ax-a@example.com", slug: "ax-a", publish: true, stock: 5 });
    stranger = await createAuthUser("ax-x@example.com");
    const cat = async (slug: string, parent: string | null, axes: unknown) =>
      (await as<{ id: string }>("insert into categories (shop_id, slug, name, parent_id, option_axes) values ($1, $2, $3, $4, $5) returning id", [a.shopId, slug, slug, parent, axes === null ? null : JSON.stringify(axes)]))[0]!.id;
    wear = await cat("wear", null, COLOR_SIZE);
    tops = await cat("tops", wear, null);
    cable = await cat("cable", null, [{ key: "型番" }, { key: "長さ", values: ["1m", "3m"] }]);
    await as("update shops set option_axes = '[]'::jsonb where id = $1", [a.shopId]);
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    token = sha(raw);
    await as("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [a.shopId, a.ownerId, token, raw.slice(0, 12), ["products:read", "products:write"]]);
  });
  afterAll(closePool);

  it("形の検査: 3 つまで・鍵は重ならない・値の候補は文字列", async () => {
    for (const bad of [[{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }], [{ key: "a" }, { key: "a" }], [{ key: "" }], [{ key: "a", values: [1] }], [{ key: "a", extra: 1 }], { key: "a" }]) {
      expect(await expectDbError(() => as("update shops set option_axes = $2 where id = $1", [a.shopId, JSON.stringify(bad)]))).toMatch(/shops_option_axes_check/);
    }
  });

  it("ひな形を写す: 子のカテゴリーは親を引き継ぎ、カテゴリーが無ければショップ。あとで上の段を変えても商品は変わらない", async () => {
    expect((await newProduct("shirt", tops)).option_axes).toEqual(COLOR_SIZE);
    expect((await newProduct("ring", null)).option_axes).toEqual([]);
    const usb = await newProduct("usb", cable);
    expect(usb.option_axes).toEqual([{ key: "型番" }, { key: "長さ", values: ["1m", "3m"] }]);
    await as("update categories set option_axes = $2 where id = $1", [cable, JSON.stringify([{ key: "長さ" }])]);
    expect((await axesOf(usb.id)).a).toEqual([{ key: "型番" }, { key: "長さ", values: ["1m", "3m"] }]);
  });

  it("SKU の守り: 鍵が軸とちょうど同じ・値が空でない・同じ組み合わせは 1 つ。品番だけの商品は options が空で、複数の SKU を置ける", async () => {
    const p = await newProduct("hoodie", wear);
    await addSku(p.id, "H-R-M", { カラー: "レッド", サイズ: "M" });
    // 候補に無い値も入れられる
    await addSku(p.id, "H-G-XL", { カラー: "グリーン", サイズ: "XL" });
    expect(await expectDbError(() => addSku(p.id, "H-R-M2", { カラー: "レッド", サイズ: "M" }))).toMatch(/option_combination_exists/);
    expect(await expectDbError(() => addSku(p.id, "H-R", { カラー: "レッド" }))).toMatch(/option_axes_mismatch/);
    expect(await expectDbError(() => addSku(p.id, "H-X", { カラー: "レッド", サイズ: "M", 丈: "長" }))).toMatch(/option_axes_mismatch/);
    expect(await expectDbError(() => addSku(p.id, "H-E", { カラー: "レッド", サイズ: " " }))).toMatch(/option_axes_mismatch/);
    expect(await expectDbError(() => as("update skus set options = '{\"色\":\"赤\",\"サイズ\":\"M\"}' where code = 'H-R-M' and shop_id = $1", [a.shopId]))).toMatch(/option_axes_mismatch/);
    const mug = await newProduct("mug", null);
    await addSku(mug.id, "MUG-1", {});
    await addSku(mug.id, "MUG-2", {});
    expect(await expectDbError(() => addSku(mug.id, "MUG-3", { 色: "白" }))).toMatch(/option_axes_mismatch/);
  });

  it("商品の軸を変える: 今の SKU が合えば変えられ、合わなければ断る。決めていない（null）商品は今までどおり自由", async () => {
    const p = await newProduct("free", null);
    await as("update products set option_axes = null where id = $1", [p.id]);
    await addSku(p.id, "F-1", { 色: "白" });
    await addSku(p.id, "F-2", { 色: "白" });
    expect(await expectDbError(() => as("update products set option_axes = $2 where id = $1", [p.id, JSON.stringify([{ key: "色" }])]))).toMatch(/option_combination_exists/);
    expect(await expectDbError(() => as("update products set option_axes = $2 where id = $1", [p.id, JSON.stringify([{ key: "サイズ" }])]))).toMatch(/option_axes_mismatch/);
    await as("update skus set options = '{\"色\":\"黒\"}' where code = 'F-2' and shop_id = $1", [a.shopId]);
    await as("update products set option_axes = $2, option_axes_custom = true where id = $1", [p.id, JSON.stringify([{ key: "色" }])]);
    expect((await axesOf(p.id)).a).toEqual([{ key: "色" }]);
  });

  it("主カテゴリーを決めたとき: SKU がまだ無く上書きしていなければ写し直す。SKU があれば変えない", async () => {
    const p = await newProduct("later", null);
    expect((await axesOf(p.id)).a).toEqual([]);
    await as("update products set category_id = $2 where id = $1", [p.id, wear]);
    expect((await axesOf(p.id)).a).toEqual(COLOR_SIZE);
    await addSku(p.id, "L-R-S", { カラー: "レッド", サイズ: "S" });
    await as("update products set category_id = $2 where id = $1", [p.id, cable]);
    expect((await axesOf(p.id)).a).toEqual(COLOR_SIZE);
  });

  it("一括で当てる: 上書きしていない商品だけ、SKU が合うものだけ。合わない商品は理由つきで返す。catalog の項目が要る", async () => {
    await as("update categories set option_axes = $2 where id = $1", [wear, JSON.stringify([{ key: "カラー" }, { key: "サイズ" }, { key: "丈" }])]);
    const fits = await newProduct("fits", null);
    await as("update products set option_axes = null, category_id = $2 where id = $1", [fits.id, tops]);
    await addSku(fits.id, "FT-1", { カラー: "白", サイズ: "M", 丈: "長" });
    const custom = await newProduct("custom", tops);
    await as("update products set option_axes = '[]'::jsonb, option_axes_custom = true where id = $1", [custom.id]);
    const r = await asUser(a.ownerId, async (c) => (await c.query<{ r: { applied: number; unchanged: number; skipped: { slug: string; reason: string }[] } }>("select option_axes_apply($1, $2) as r", [a.shopId, wear])).rows[0]!.r);
    // shirt（SKU なし）と fits は当たる。hoodie は SKU が丈を持たない（later は主カテゴリーを cable に変えたので対象外）
    expect(r.applied).toBe(2);
    expect(r.skipped.map((x) => x.slug)).toEqual(["hoodie"]);
    expect(r.skipped.every((x) => /option_axes_mismatch/.test(x.reason))).toBe(true);
    expect((await axesOf(fits.id)).a).toEqual([{ key: "カラー" }, { key: "サイズ" }, { key: "丈" }]);
    expect((await axesOf(custom.id)).a).toEqual([]);
    expect(await expectDbError(() => asUser(stranger, (c) => c.query("select option_axes_apply($1, $2)", [a.shopId, wear])))).toMatch(/forbidden/);
  });

  it("取り込み（import_catalog）は軸を写さない。中身の取り込みは今までどおり", async () => {
    const r = await asUser(a.ownerId, async (c) =>
      (await c.query<{ r: Record<string, unknown> }>("select import_catalog($1, $2) as r", [
        a.shopId,
        JSON.stringify({ categories: [], products: [{ slug: "woo-tee", name: "Woo Tシャツ", category_slug: "wear", skus: [{ code: "WOO-1", price_jpy: 1000, options: { Color: "Red" } }] }] }),
      ])).rows[0]!.r,
    );
    expect(r).toBeTruthy();
    const row = (await getPool().query<{ a: unknown }>("select option_axes as a from products where shop_id = $1 and slug = 'woo-tee'", [a.shopId])).rows[0]!;
    expect(row.a).toBeNull();
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select banto_import_catalog_0042($1, '{}'::jsonb)", [a.shopId])))).toMatch(/permission denied/);
  });

  it("AI 用 API: api_product_set_option_axes で決め、商品の JSON に option_axes が出る。形が違えば invalid_option_axes", async () => {
    const p = await newProduct("api-tee", null);
    const r = await asService(async (c) => (await c.query<{ r: { option_axes: unknown } }>("select api_product_set_option_axes($1, $2, $3) as r", [token, p.id, JSON.stringify([{ key: "サイズ" }])])).rows[0]!.r);
    expect(r.option_axes).toEqual([{ key: "サイズ" }]);
    expect((await axesOf(p.id)).c).toBe(true);
    expect(await expectDbError(() => asService((c) => c.query("select api_product_set_option_axes($1, $2, $3)", [token, p.id, JSON.stringify([{ key: "" }])])))).toMatch(/invalid_option_axes/);
    await asService((c) => c.query("select api_product_set_option_axes($1, $2, null)", [token, p.id]));
    expect(await axesOf(p.id)).toEqual({ a: null, c: false });
  });

  it("復元: restore_option_axes でショップ・カテゴリー・商品の軸を戻す。SKU が合わない商品は飛ばす（service_role だけ）", async () => {
    const b = await createShopFixture({ email: "ax-b@example.com", slug: "ax-b", publish: true, stock: 5 });
    await getPool().query("insert into categories (shop_id, slug, name) values ($1, 'wear', 'wear')", [b.shopId]);
    const r = await asService(async (c) =>
      (await c.query<{ r: Record<string, number> }>("select restore_option_axes($1, $2) as r", [
        b.shopId,
        JSON.stringify({ shop: [], categories: [{ slug: "wear", option_axes: COLOR_SIZE }], products: [{ slug: "tee", option_axes: [{ key: "サイズ" }], option_axes_custom: true }] }),
      ])).rows[0]!.r,
    );
    // fixture の SKU（TEE-M）は options が空なので、サイズの軸には合わない
    expect(r).toEqual({ option_axes_categories: 1, option_axes_products: 0, option_axes_skipped: 1 });
    expect((await getPool().query("select option_axes from shops where id = $1", [b.shopId])).rows[0].option_axes).toEqual([]);
    expect(await expectDbError(() => asUser(b.ownerId, (c) => c.query("select restore_option_axes($1, '{}'::jsonb)", [b.shopId])))).toMatch(/permission denied/);
  });
});
