import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** 0092_image_processing: 差し替えで中間の段とサムネイルの横幅も入れ替える・画像の設定を読む・API の商品に段が載る */
describe.skipIf(!dbAvailable)("商品画像の変換を外部プラグインに任せる（0092）", () => {
  let a: Fixture;
  let write: string;
  let read: string;
  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
  function issue(f: Fixture, scopes: string[]) {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    return asUser(f.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [f.shopId, f.ownerId, sha(raw), raw.slice(0, 12), scopes])).then(() => sha(raw));
  }
  const key = (name: string) => `shops/${a.shopId}/products/${a.productId}/${name}`;
  const K1 = "0123456789abcdef01234567";
  const K2 = "fedcba9876543210fedcba98";
  const K3 = "aaaaaaaaaaaaaaaaaaaaaaaa";

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "ip-a@example.com", slug: "ip-a" });
    write = await issue(a, ["products:write"]);
    read = await issue(a, ["products:read"]);
  });
  afterAll(closePool);

  it("差し替えで段と横幅を入れ替え、前の段を返す。段は本画像より狭いものだけ・横幅はサムネイルがあるときだけ", async () => {
    const added = await rpc<{ image_id: string }>("api_image_add_file", [write, a.productId, key(`${K1}.jpg`), null, 4000, 3000]);
    const r = await rpc<{ previous: { variants: number[] }; product: { images: { variants: number[]; thumb_width: number | null }[] } }>("api_image_replace_file", [
      write, added.image_id, key(`${K2}.webp`), key(`${K2}.thumb.webp`), 2048, 1536, [800, 1600], 400,
    ]);
    expect(r.previous.variants).toEqual([]);
    expect(r.product.images[0]).toMatchObject({ variants: [800, 1600], thumb_width: 400 });
    const again = await rpc<{ previous: { variants: number[] } }>("api_image_replace_file", [write, added.image_id, key(`${K3}.webp`), null, 1600, 1200]);
    expect(again.previous.variants).toEqual([800, 1600]);
    expect((await getPool().query("select variants, thumb_width from product_images where id = $1", [added.image_id])).rows[0]).toEqual({ variants: [], thumb_width: null });
    expect(await expectDbError(() => rpc("api_image_replace_file", [write, added.image_id, key(`${K1}.webp`), null, 1600, 1200, [1600], null]))).toMatch(/invalid_variants/);
    expect(await expectDbError(() => rpc("api_image_replace_file", [write, added.image_id, key(`${K1}.webp`), null, 1600, 1200, [900], null]))).toMatch(/check/);
    expect(await expectDbError(() => rpc("api_image_replace_file", [write, added.image_id, key(`${K1}.webp`), null, 1600, 1200, [], 400]))).toMatch(/invalid_thumb_width/);
  });

  it("画像の設定は products:read で読める。壊れた値は既定", async () => {
    expect(await rpc("api_image_settings", [read])).toEqual({ max_width: 1600, max_height: 4096, thumb_width: 400, variant_widths: [800, 1600, 2048, 2560], processing: "browser" });
    await getPool().query(`update shops set settings = settings || '{"images":{"max_width":2560,"processing":"plugin"}}' where id = $1`, [a.shopId]);
    expect(await rpc("api_image_settings", [read])).toMatchObject({ max_width: 2560, processing: "plugin" });
    await getPool().query(`update shops set settings = settings || '{"images":{"max_width":999,"processing":"x"}}' where id = $1`, [a.shopId]);
    expect(await rpc("api_image_settings", [read])).toMatchObject({ max_width: 1600, processing: "browser" });
  });
});
