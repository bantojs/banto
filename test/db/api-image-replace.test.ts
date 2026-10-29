import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** 0077_api_image_replace: 画像のファイルだけを差し替える（行・並び順・SKU への結び付けはそのまま） */
describe.skipIf(!dbAvailable)("商品画像のファイルの差し替え（0077）", () => {
  let a: Fixture;
  let b: Fixture;
  let write: string;
  let readOnly: string;
  let writeB: string;

  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
  function issue(f: Fixture, scopes: string[]) {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    return asUser(f.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [f.shopId, f.ownerId, sha(raw), raw.slice(0, 12), scopes])).then(() => sha(raw));
  }
  const key = (f: Fixture, name: string) => `shops/${f.shopId}/products/${f.productId}/${name}`;
  const OLD = "0123456789abcdef01234567";
  const NEW = "fedcba9876543210fedcba98";

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "ir-a@example.com", slug: "ir-a" });
    b = await createShopFixture({ email: "ir-b@example.com", slug: "ir-b" });
    write = await issue(a, ["products:write"]);
    readOnly = await issue(a, ["products:read"]);
    writeB = await issue(b, ["products:write"]);
  });
  afterAll(closePool);

  it("商品の id を返し、キー・サムネイル・寸法だけを差し替えて前のキーを返す。並び順・SKU への結び付けはそのまま", async () => {
    await rpc("api_image_add_file", [write, a.productId, key(a, `${"a".repeat(24)}.jpg`), null, null, null]);
    const added = await rpc<{ image_id: string }>("api_image_add_file", [write, a.productId, key(a, `${OLD}.png`), null, 800, 600]);
    await getPool().query("update product_images set options = '{\"color\":\"レッド\"}' where id = $1", [added.image_id]);
    const target = await rpc<{ product_id: string; shop_id: string }>("api_image_target", [write, added.image_id]);
    expect(target).toEqual({ product_id: a.productId, shop_id: a.shopId });
    const r = await rpc<{ image_id: string; previous: { storage_key: string; thumb_key: string | null } }>("api_image_replace_file", [write, added.image_id, key(a, `${NEW}.webp`), key(a, `${NEW}.thumb.webp`), 1600, 1200]);
    expect(r.image_id).toBe(added.image_id);
    expect(r.previous).toEqual({ storage_key: key(a, `${OLD}.png`), thumb_key: null });
    const row = (await getPool().query("select storage_key, thumb_key, width, height, sort_order, options from product_images where id = $1", [added.image_id])).rows[0];
    expect(row).toEqual({ storage_key: key(a, `${NEW}.webp`), thumb_key: key(a, `${NEW}.thumb.webp`), width: 1600, height: 1200, sort_order: 1, options: { color: "レッド" } });
  });

  it("ほかのショップの画像・読むだけのトークンは断る。キーはその画像の商品の下・前と違うものだけ", async () => {
    const img = (await getPool().query<{ id: string }>("select id from product_images where shop_id = $1 order by sort_order desc limit 1", [a.shopId])).rows[0]!.id;
    expect(await expectDbError(() => rpc("api_image_target", [writeB, img]))).toMatch(/not_found/);
    expect(await expectDbError(() => rpc("api_image_replace_file", [writeB, img, key(b, `${OLD}.webp`), null, null, null]))).toMatch(/not_found/);
    expect(await expectDbError(() => rpc("api_image_replace_file", [readOnly, img, key(a, `${OLD}.webp`), null, null, null]))).toMatch(/unauthorized|insufficient|scope/);
    expect(await expectDbError(() => rpc("api_image_replace_file", [write, img, key(b, `${OLD}.webp`), null, null, null]))).toMatch(/invalid_storage_key/);
    expect(await expectDbError(() => rpc("api_image_replace_file", [write, img, key(a, `${NEW}.webp`), null, null, null]))).toMatch(/invalid_storage_key/);
    expect(await expectDbError(() => rpc("api_image_replace_file", [write, img, key(a, `${OLD}.webp`), key(a, `${NEW}.thumb.webp`), null, null]))).toMatch(/invalid_thumb_key/);
    expect(await expectDbError(() => rpc("api_image_replace_file", [write, img, key(a, `${OLD}.webp`), null, 10, null]))).toMatch(/invalid_dimensions/);
  });
});
