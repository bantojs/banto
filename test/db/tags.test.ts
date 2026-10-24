import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, resetDatabase, type Fixture } from "./harness";

describe.skipIf(!dbAvailable)("商品のタグ（0007_tags）", () => {
  let f: Fixture;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "tags@example.com", slug: "tag-shop", publish: true, stock: 3 });
  });
  afterAll(closePool);

  it("owner は管理画面の経路（RLS）でタグを書ける。制約に反する値は弾く。公開中なら anon から読める", async () => {
    await asUser(f.ownerId, (c) => c.query("update products set tags = $2 where id = $1", [f.productId, ["Tシャツ", "夏物"]]));
    const rows = await asAnon(async (c) => (await c.query<{ tags: string[] }>("select tags from products where id = $1", [f.productId])).rows);
    expect(rows[0]!.tags).toEqual(["Tシャツ", "夏物"]);

    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update products set tags = $2 where id = $1", [f.productId, ["a,b"]])))).toMatch(/check constraint/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update products set tags = $2 where id = $1", [f.productId, ["x".repeat(41)]])))).toMatch(/check constraint/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update products set tags = $2 where id = $1", [f.productId, Array.from({ length: 21 }, (_, i) => `t${i}`)])))).toMatch(/check constraint/);
  });

  it("api_product_create / update はタグを正規化して保存し、JSON に載せる", async () => {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    const hash = createHash("sha256").update(raw).digest("hex");
    await asUser(f.ownerId, (c) =>
      c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [f.shopId, f.ownerId, hash, raw.slice(0, 12), ["products:read", "products:write"]]),
    );
    const rpc = <T>(fn: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);

    const created = await rpc<{ id: string; tags: string[] }>("api_product_create", [hash, { slug: "cap", name: "キャップ", tags: [" 帽子 ", "帽子", "", "新作,", "x".repeat(50)] }]);
    expect(created.tags).toEqual(["帽子", "新作", "x".repeat(40)]);
    // tags を省略した更新では変わらない、渡せば丸ごと置き換え
    let updated = await rpc<{ tags: string[] }>("api_product_update", [hash, created.id, { name: "キャップ2" }]);
    expect(updated.tags).toEqual(["帽子", "新作", "x".repeat(40)]);
    updated = await rpc<{ tags: string[] }>("api_product_update", [hash, created.id, { tags: ["夏物"] }]);
    expect(updated.tags).toEqual(["夏物"]);
    updated = await rpc<{ tags: string[] }>("api_product_update", [hash, created.id, { tags: [] }]);
    expect(updated.tags).toEqual([]);
  });

  it("restore_product_tags は slug で突き合わせてタグを戻す。service_role だけが呼べる", async () => {
    const dstId = await asUser(f.ownerId, async (c) => (await c.query<{ id: string }>("insert into shops (owner_id, slug, name) values ($1, 'tag-dst', 'Dst') returning id", [f.ownerId])).rows[0]!.id);
    const products = await asUser(f.ownerId, async (c) => (await c.query("select * from products where shop_id = $1", [f.shopId])).rows);
    await asService((c) => c.query("select restore_shop_data($1, $2::jsonb)", [dstId, JSON.stringify({ products, skus: [], inventory: [], product_images: [], orders: [], order_items: [], customers: [], hook_endpoints: [] })]));
    // 0006 の復元だけではタグは入らない
    const before = await asUser(f.ownerId, async (c) => (await c.query<{ slug: string; tags: string[] }>("select slug, tags from products where shop_id = $1 order by slug", [dstId])).rows);
    expect(before.every((r) => r.tags.length === 0)).toBe(true);

    const n = await asService(async (c) => (await c.query<{ n: number }>("select restore_product_tags($1, $2::jsonb) as n", [dstId, JSON.stringify(products)])).rows[0]!.n);
    expect(n).toBe(1);
    const after = await asUser(f.ownerId, async (c) => (await c.query<{ tags: string[] }>("select tags from products where shop_id = $1 and tags <> '{}'", [dstId])).rows);
    expect(after.map((r) => r.tags)).toEqual([["Tシャツ", "夏物"]]);

    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select restore_product_tags($1, '[]'::jsonb)", [dstId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asAnon((c) => c.query("select restore_product_tags($1, '[]'::jsonb)", [dstId])))).toMatch(/permission denied/);
  });
});
