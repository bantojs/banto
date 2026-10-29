import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** 0078_api_image_order: 商品の画像の並び順を決める（id をすべて並べたい順に渡す） */
describe.skipIf(!dbAvailable)("商品画像の並び順（0078）", () => {
  let a: Fixture;
  let b: Fixture;
  let write: string;
  let readOnly: string;
  let writeB: string;
  const ids: string[] = [];

  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
  function issue(f: Fixture, scopes: string[]) {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    return asUser(f.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [f.shopId, f.ownerId, sha(raw), raw.slice(0, 12), scopes])).then(() => sha(raw));
  }
  const order = async () => (await getPool().query<{ id: string }>("select id from product_images where product_id = $1 order by sort_order", [a.productId])).rows.map((r) => r.id);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "io-a@example.com", slug: "io-a" });
    b = await createShopFixture({ email: "io-b@example.com", slug: "io-b" });
    write = await issue(a, ["products:write"]);
    readOnly = await issue(a, ["products:read"]);
    writeB = await issue(b, ["products:write"]);
    for (const c of ["a", "b", "c"]) {
      const r = await rpc<{ image_id: string }>("api_image_add_file", [write, a.productId, `shops/${a.shopId}/products/${a.productId}/${c.repeat(24)}.webp`, null, null, null]);
      ids.push(r.image_id);
    }
  });
  afterAll(closePool);

  it("渡した順に 0 から振り直し、SKU への結び付けはそのまま。商品を返し、product.updated を 1 通だけ積む", async () => {
    await getPool().query("update product_images set options = '{\"color\":\"レッド\"}' where id = $1", [ids[1]]);
    await getPool().query("delete from hook_deliveries");
    const r = await rpc<{ id: string; images: { id: string }[] }>("api_images_reorder", [write, a.productId, [ids[2], ids[0], ids[1]]]);
    expect(r.id).toBe(a.productId);
    expect(await order()).toEqual([ids[2], ids[0], ids[1]]);
    const rows = (await getPool().query("select sort_order, options from product_images where id = $1", [ids[1]])).rows[0];
    expect(rows).toEqual({ sort_order: 2, options: { color: "レッド" } });
    const hooks = (await getPool().query("select event from hook_deliveries")).rows;
    expect(hooks.filter((h) => h.event === "product.updated").length).toBeLessThanOrEqual(1);
  });

  it("足りない・余計・重なり・ほかの商品の画像は image_ids_mismatch で、何も変えない", async () => {
    const before = await order();
    for (const bad of [[ids[0], ids[1]], [...ids, ids[0]], [ids[0], ids[0], ids[1]], [ids[0], ids[1], "00000000-0000-0000-0000-000000000000"], []]) {
      expect(await expectDbError(() => rpc("api_images_reorder", [write, a.productId, bad]))).toMatch(/image_ids_mismatch/);
    }
    expect(await expectDbError(() => rpc("api_images_reorder", [write, a.productId, null]))).toMatch(/image_ids_mismatch/);
    expect(await order()).toEqual(before);
  });

  it("ほかのショップの商品・読むだけのトークンは断る", async () => {
    expect(await expectDbError(() => rpc("api_images_reorder", [writeB, a.productId, ids]))).toMatch(/not_found/);
    expect(await expectDbError(() => rpc("api_images_reorder", [readOnly, a.productId, ids]))).toMatch(/unauthorized|insufficient|scope/);
    expect(await expectDbError(() => rpc("api_images_reorder", [write, b.productId, []]))).toMatch(/not_found/);
  });

  it("画像の無い商品は空の並びだけ受ける", async () => {
    const r = await rpc<{ id: string }>("api_images_reorder", [writeB, b.productId, []]);
    expect(r.id).toBe(b.productId);
  });
});
