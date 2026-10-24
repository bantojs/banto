import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** 0037_api_image_upload: ファイルで送った画像の登録。置き場所のキーの形と、他のショップの商品を確かめる */
describe.skipIf(!dbAvailable)("商品画像のファイルの登録（0037_api_image_upload）", () => {
  let a: Fixture;
  let b: Fixture;
  let write: string;
  let readOnly: string;

  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
  function issue(f: Fixture, scopes: string[]) {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    return asUser(f.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [f.shopId, f.ownerId, sha(raw), raw.slice(0, 12), scopes])).then(() => sha(raw));
  }
  const key = (f: Fixture, name: string) => `shops/${f.shopId}/products/${f.productId}/${name}`;
  const hex = "0123456789abcdef01234567";

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "iu-a@example.com", slug: "iu-a" });
    b = await createShopFixture({ email: "iu-b@example.com", slug: "iu-b" });
    write = await issue(a, ["products:write"]);
    readOnly = await issue(a, ["products:read"]);
  });
  afterAll(closePool);

  it("products:write だけで登録でき、サムネイルと寸法を残す。並び順は末尾", async () => {
    const r = await rpc<{ image_id: string; product: { images: { thumb_key: string; width: number }[] } }>("api_image_add_file", [write, a.productId, key(a, `${hex}.webp`), key(a, `${hex}.thumb.webp`), 1600, 1200]);
    expect(r.product.images[0]).toMatchObject({ thumb_key: key(a, `${hex}.thumb.webp`), width: 1600 });
    const r2 = await rpc<{ image_id: string }>("api_image_add_file", [write, a.productId, key(a, `${hex.replace("0", "f")}.png`), null, null, null]);
    const rows = await getPool().query<{ sort_order: number }>("select sort_order from product_images where id = $1", [r2.image_id]);
    expect(rows.rows[0]!.sort_order).toBe(1);
  });

  it("キーはこのショップのこの商品の下だけ。サムネイルは本画像の隣だけ。寸法は両方か無し", async () => {
    const bad: [string, string | null, number | null, number | null, RegExp][] = [
      [`shops/${b.shopId}/products/${a.productId}/${hex}.png`, null, null, null, /invalid_storage_key/],
      [`shops/${a.shopId}/products/${b.productId}/${hex}.png`, null, null, null, /invalid_storage_key/],
      [key(a, `../../${hex}.png`), null, null, null, /invalid_storage_key/],
      [key(a, `${hex}.svg`), null, null, null, /invalid_storage_key/],
      [key(a, `${hex}.png`), key(a, `ffffffffffffffffffffffff.thumb.png`), null, null, /invalid_thumb_key/],
      [key(a, `${hex}.png`), null, 100, null, /invalid_dimensions/],
      [key(a, `${hex}.png`), null, 0, 10, /invalid_dimensions/],
    ];
    for (const [k, t, w, h, err] of bad) expect(await expectDbError(() => rpc("api_image_add_file", [write, a.productId, k, t, w, h]))).toMatch(err);
  });

  it("他のショップの商品は not_found、読み取りのトークンは unauthorized、service_role 以外は呼べない", async () => {
    expect(await expectDbError(() => rpc("api_image_add_file", [write, b.productId, `shops/${a.shopId}/products/${b.productId}/${hex}.png`, null, null, null]))).toMatch(/not_found/);
    expect(await expectDbError(() => rpc("api_image_add_file", [readOnly, a.productId, key(a, `${hex}.png`), null, null, null]))).toMatch(/unauthorized/);
    expect(await expectDbError(() => withRole("authenticated", { sub: a.ownerId }, (c) => c.query("select api_image_add_file($1, $2, $3)", [write, a.productId, key(a, `${hex}.png`)])))).toMatch(/permission denied/);
  });
});
