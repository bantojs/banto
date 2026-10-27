import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * 0063_sku_images: 画像を SKU の options の一部に結ぶ。
 * 列の形の検査・取り込みの対応表（目印 → options）とトリガー・項目の確認・AI 用 API・復元を確かめる。
 */
describe.skipIf(!dbAvailable)("SKU ごとの画像（0063）", () => {
  let a: Fixture;
  let b: Fixture;
  let stranger: string;
  let token: string;

  const insertImage = (f: Fixture, key: string, options?: Record<string, unknown>) =>
    asUser(f.ownerId, async (c) =>
      (await c.query<{ id: string; options: Record<string, string> }>(
        `insert into product_images (shop_id, product_id, storage_key${options ? ", options" : ""}) values ($1, $2, $3${options ? ", $4" : ""}) returning id, options`,
        options ? [f.shopId, f.productId, key, JSON.stringify(options)] : [f.shopId, f.productId, key],
      )).rows[0]!,
    );
  const slugOf = (f: Fixture) => getPool().query<{ slug: string }>("select slug from products where id = $1", [f.productId]).then((r) => r.rows[0]!.slug);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "si-a@example.com", slug: "si-a", publish: true, stock: 5 });
    b = await createShopFixture({ email: "si-b@example.com", slug: "si-b", publish: true, stock: 5 });
    stranger = await createAuthUser("si-x@example.com");
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    token = sha(raw);
    await asUser(a.ownerId, (c) =>
      c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [a.shopId, a.ownerId, token, raw.slice(0, 12), ["products:read", "products:write"]]),
    );
  });
  afterAll(closePool);

  it("既定は {}（商品全体）。owner は options を付けられ、形の違う値は CHECK で弾く", async () => {
    expect((await insertImage(a, "shops/a/whole.webp")).options).toEqual({});
    expect((await insertImage(a, "shops/a/red.webp", { color: "レッド" })).options).toEqual({ color: "レッド" });
    for (const bad of [{ color: 1 }, { color: "" }, { "": "x" }, { color: "x".repeat(61) }, { a: "1", b: "1", c: "1", d: "1", e: "1", f: "1" }]) {
      expect(await expectDbError(() => insertImage(a, "shops/a/bad.webp", bad))).toMatch(/product_images_options_check/);
    }
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("update product_images set options = '[]'::jsonb where shop_id = $1", [a.shopId])))).toMatch(/product_images_options_check/);
  });

  it("公開中の商品の options は anon も読める（お店の画面の並べ替えに使う）", async () => {
    const rows = await asAnon(async (c) => (await c.query<{ options: Record<string, string> }>("select options from product_images where product_id = $1 and storage_key = 'shops/a/red.webp'", [a.productId])).rows);
    expect(rows).toEqual([{ options: { color: "レッド" } }]);
  });

  it("取り込みの対応表: 先にある画像にも写し、あとから入った画像にはトリガーが写す。options を明示した行は変えない", async () => {
    const slug = await slugOf(a);
    const early = await insertImage(a, `shops/${a.shopId}/products/${a.productId}/wc-abc123.webp`);
    const keep = await insertImage(a, `shops/${a.shopId}/products/${a.productId}/wc-keep1.webp`, { size: "M" });
    const r = await asUser(a.ownerId, async (c) =>
      (await c.query<{ r: { hints: number; applied: number } }>("select product_image_hints_set($1, $2) as r", [
        a.shopId,
        JSON.stringify([
          { slug, tag: "/wc-abc123.", options: { color: "ブルー" } },
          { slug, tag: "/wc-late99.", options: { color: "グリーン", size: "L" } },
          { slug, tag: "/wc-keep1.", options: { color: "ブルー" } },
          { slug: "no-such-product", tag: "/wc-zzz.", options: { color: "x" } },
        ]),
      ])).rows[0]!.r,
    );
    expect(r).toEqual({ hints: 3, applied: 1 });
    const opts = (id: string) => getPool().query<{ o: Record<string, string> }>("select options as o from product_images where id = $1", [id]).then((x) => x.rows[0]!.o);
    expect(await opts(early.id)).toEqual({ color: "ブルー" });
    expect(await opts(keep.id)).toEqual({ size: "M" });
    expect((await insertImage(a, `shops/${a.shopId}/products/${a.productId}/wc-late99.jpg`)).options).toEqual({ color: "グリーン", size: "L" });
    // 裏の取り込み（service_role）で入った行にも写る
    const viaService = await asService(async (c) =>
      (await c.query<{ o: Record<string, string> }>("insert into product_images (shop_id, product_id, storage_key) values ($1, $2, $3) returning options as o", [a.shopId, a.productId, `shops/${a.shopId}/products/${a.productId}/wc-late99.png`])).rows[0]!.o,
    );
    expect(viaService).toEqual({ color: "グリーン", size: "L" });
    // {} で対応表から外す
    await asUser(a.ownerId, (c) => c.query("select product_image_hints_set($1, $2)", [a.shopId, JSON.stringify([{ slug, tag: "/wc-late99.", options: {} }])]));
    expect((await insertImage(a, `shops/${a.shopId}/products/${a.productId}/wc-late99.gif`)).options).toEqual({});
  });

  it("対応表: catalog の項目が要る。他人のショップの商品には置けない。形の違う目印は拒否。ほかの人は表を読めない", async () => {
    const slug = await slugOf(a);
    expect(await expectDbError(() => asUser(stranger, (c) => c.query("select product_image_hints_set($1, $2)", [a.shopId, JSON.stringify([{ slug, tag: "/wc-x1.", options: { color: "x" } }])])))).toMatch(/forbidden/);
    // b の owner が a の商品の slug を指しても、自分のショップの商品しか引かない
    const r = await asUser(b.ownerId, async (c) => (await c.query<{ r: { hints: number } }>("select product_image_hints_set($1, $2) as r", [b.shopId, JSON.stringify([{ slug: "no-such", tag: "/wc-x1.", options: { color: "x" } }])])).rows[0]!.r);
    expect(r.hints).toBe(0);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select product_image_hints_set($1, $2)", [a.shopId, JSON.stringify([{ slug, tag: "wc-x1", options: { color: "x" } }])])))).toMatch(/invalid_items/);
    expect(await asUser(b.ownerId, async (c) => (await c.query("select * from product_image_hints")).rowCount)).toBe(0);
    expect(await asUser(a.ownerId, async (c) => (await c.query("select * from product_image_hints")).rowCount)).toBeGreaterThan(0);
    expect(await expectDbError(() => asAnon((c) => c.query("select product_image_hints_set($1, '[]'::jsonb)", [a.shopId])))).toMatch(/permission denied/);
  });

  it("AI 用 API: api_image_set_options で結び、api_product_get の画像に options が出る。他のショップの画像は not_found", async () => {
    const img = await insertImage(a, "shops/a/api.webp");
    const other = await insertImage(b, "shops/b/other.webp");
    const product = await asService(async (c) =>
      (await c.query<{ r: { images: { id: string; options: Record<string, string> }[] } }>("select api_image_set_options($1, $2, $3) as r", [token, img.id, JSON.stringify({ color: "レッド", size: "S" })])).rows[0]!.r,
    );
    expect(product.images.find((i) => i.id === img.id)!.options).toEqual({ color: "レッド", size: "S" });
    expect(await expectDbError(() => asService((c) => c.query("select api_image_set_options($1, $2, $3)", [token, img.id, JSON.stringify({ color: 3 })])))).toMatch(/invalid_options/);
    expect(await expectDbError(() => asService((c) => c.query("select api_image_set_options($1, $2, $3)", [token, other.id, "{}"])))).toMatch(/not_found/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select api_image_set_options($1, $2, $3)", [token, img.id, "{}"])))).toMatch(/permission denied/);
  });

  it("AI 用 API: 登録と同時に結ぶ（api_image_add / api_image_add_file の p_options）。形が違えば画像の行を作らない。省略は商品全体", async () => {
    const hex = "0123456789abcdef01234567";
    const prefix = `shops/${a.shopId}/products/${a.productId}/`;
    const call = <T>(sql: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(sql, args)).rows[0]!.r);
    const r = await call<{ image_id: string }>("select api_image_add_file($1, $2, $3, null, null, null, $4) as r", [token, a.productId, `${prefix}${hex}.webp`, JSON.stringify({ color: "レッド" })]);
    const opts = (id: string) => getPool().query<{ o: Record<string, string> }>("select options as o from product_images where id = $1", [id]).then((x) => x.rows[0]!.o);
    expect(await opts(r.image_id)).toEqual({ color: "レッド" });
    const plain = await call<{ image_id: string }>("select api_image_add_file($1, $2, $3) as r", [token, a.productId, `${prefix}${hex.replace("0", "f")}.png`]);
    expect(await opts(plain.image_id)).toEqual({});
    const count = () => getPool().query("select count(*)::int as n from product_images where product_id = $1", [a.productId]).then((x) => x.rows[0]!.n as number);
    const before = await count();
    expect(await expectDbError(() => call("select api_image_add_file($1, $2, $3, null, null, null, $4) as r", [token, a.productId, `${prefix}${hex.replace("1", "e")}.png`, '{"color":1}']))).toMatch(/invalid_options/);
    const viaUrl = await call<{ images: { storage_key: string; options: Record<string, string> }[] }>("select api_image_add($1, $2, $3, null, $4) as r", [token, a.productId, `shops/${a.shopId}/url.webp`, JSON.stringify({ size: "M" })]);
    expect(viaUrl.images.find((i) => i.storage_key === `shops/${a.shopId}/url.webp`)!.options).toEqual({ size: "M" });
    expect(await expectDbError(() => call("select api_image_add($1, $2, $3, null, $4) as r", [token, a.productId, `shops/${a.shopId}/bad.webp`, "[]"]))).toMatch(/invalid_options/);
    expect(await count()).toBe(before + 1);
    // 引数を足す前の呼び方（p_options なし）も通る
    await call("select api_image_add($1, $2, $3) as r", [token, a.productId, `shops/${a.shopId}/old.webp`]);
  });

  it("復元: restore_product_image_options は同じショップの同じキーの画像にだけ写す（service_role のみ）", async () => {
    await insertImage(a, "shops/a/restore.webp");
    await insertImage(b, "shops/a/restore.webp");
    const r = await asService(async (c) =>
      (await c.query<{ r: { product_image_options: number } }>("select restore_product_image_options($1, $2) as r", [a.shopId, JSON.stringify([{ storage_key: "shops/a/restore.webp", options: { color: "白" } }, { storage_key: "shops/a/none.webp", options: { color: "白" } }, { storage_key: "shops/a/restore.webp", options: { color: 1 } }])])).rows[0]!.r,
    );
    expect(r).toEqual({ product_image_options: 1 });
    const rows = (await getPool().query<{ shop_id: string; o: Record<string, string> }>("select shop_id, options as o from product_images where storage_key = 'shops/a/restore.webp'")).rows;
    expect(rows.find((x) => x.shop_id === a.shopId)!.o).toEqual({ color: "白" });
    expect(rows.find((x) => x.shop_id === b.shopId)!.o).toEqual({});
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select restore_product_image_options($1, '[]'::jsonb)", [a.shopId])))).toMatch(/permission denied/);
  });
});
