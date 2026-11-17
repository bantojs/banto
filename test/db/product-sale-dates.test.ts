import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/** 0148_product_sale_dates: 発売日の前は買えない（Coming Soon）・商品の予約公開（publish_at と Cron） */
describe.skipIf(!dbAvailable)("発売日と公開日（0148）", () => {
  let f: Fixture;
  let tok: string;
  const reserve = (skuId: string) =>
    asService((c) => c.query("select reserve_stock($1, $2, 900)", [f.shopId, JSON.stringify([{ sku_id: skuId, qty: 1 }])]));

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "psd-owner@example.com", slug: "psd-shop", publish: true, stock: 5 });
    tok = `banto_${randomUUID()}`;
    await asUser(f.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, '{products:read,products:write}')", [f.shopId, f.ownerId, hash(tok), tok.slice(0, 12)]));
  });
  afterAll(closePool);

  it("在庫の予約: 発売日が未来なら sku_not_available、過去・無しなら引ける", async () => {
    const pool = getPool();
    await pool.query("update products set released_at = now() + interval '1 day' where id = $1", [f.productId]);
    expect(await expectDbError(() => reserve(f.skuId))).toMatch(/sku_not_available/);
    await pool.query("update products set released_at = now() - interval '1 minute' where id = $1", [f.productId]);
    await reserve(f.skuId);
    await pool.query("update products set released_at = null where id = $1", [f.productId]);
    await reserve(f.skuId);
  });

  it("会員のカートの SKU（product_member_skus）の商品に released_at が載る", async () => {
    const pool = getPool();
    await pool.query("update products set released_at = '2030-01-01T00:00:00Z' where id = $1", [f.productId]);
    const rows = await asService(async (c) => (await c.query<{ r: { product: J }[] }>("select product_member_skus($1, $2, 0, $3, $4) as r", [f.shopId, randomUUID(), randomUUID(), [f.skuId]])).rows[0]!.r);
    expect(new Date(rows[0]!.product["released_at"] as string).toISOString()).toBe("2030-01-01T00:00:00.000Z");
    await pool.query("update products set released_at = null where id = $1", [f.productId]);
  });

  it("公開日: 非公開の商品だけに残り、Cron が過ぎたものを公開する。公開すると消える", async () => {
    const pool = getPool();
    const ins = async (slug: string, at: string) =>
      (await pool.query<{ id: string }>("insert into products (shop_id, slug, name, published, publish_at) values ($1, $2, $2, false, $3) returning id", [f.shopId, slug, at])).rows[0]!.id;
    const due = await ins("due", new Date(Date.now() - 60_000).toISOString());
    const later = await ins("later", new Date(Date.now() + 86_400_000).toISOString());
    const n = await asService(async (c) => (await c.query<{ n: number }>("select publish_scheduled_products() as n")).rows[0]!.n);
    expect(n).toBe(1);
    const rows = (await pool.query<{ id: string; published: boolean; publish_at: Date | null }>("select id, published, publish_at from products where id = any($1)", [[due, later]])).rows;
    expect(rows.find((r) => r.id === due)).toMatchObject({ published: true, publish_at: null });
    expect(rows.find((r) => r.id === later)).toMatchObject({ published: false });
    expect(rows.find((r) => r.id === later)!.publish_at).not.toBeNull();
    // 手で公開したら予約は消える
    await pool.query("update products set published = true where id = $1", [later]);
    expect((await pool.query<{ p: Date | null }>("select publish_at as p from products where id = $1", [later])).rows[0]!.p).toBeNull();
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select publish_scheduled_products()")))).toMatch(/permission denied/);
  });

  it("復元: 非公開の商品の公開日を URL の名前で戻す（公開中の商品・形の違う値は飛ばす）", async () => {
    const pool = getPool();
    await pool.query("insert into products (shop_id, slug, name, published) values ($1, 'r-sched', 'r', false), ($1, 'r-pub', 'r', true)", [f.shopId]);
    const r = await asService(async (c) => (await c.query<{ r: J }>("select restore_product_publish_at($1, $2) as r", [f.shopId, JSON.stringify([{ slug: "r-sched", publish_at: "2031-01-01T00:00:00Z" }, { slug: "r-pub", publish_at: "2031-01-01T00:00:00Z" }, { slug: "r-sched", publish_at: "tomorrow" }])])).rows[0]!.r);
    expect(r).toEqual({ products_publish_at: 1 });
  });

  it("AI 用 API の publish_at: 受けて返す、形の違いは断る", async () => {
    const at = "2031-01-01T00:00:00+09:00";
    const p = await asService(async (c) => (await c.query<{ r: J }>("select api_product_create($1, $2) as r", [hash(tok), JSON.stringify({ slug: "sched", name: "sched", publish_at: at })])).rows[0]!.r);
    expect(new Date(p["publish_at"] as string).toISOString()).toBe("2030-12-31T15:00:00.000Z");
    for (const bad of ["tomorrow", "2999-01-01T00:00:00Z", 1]) {
      expect(await expectDbError(() => asService((c) => c.query("select api_product_update($1, $2, $3)", [hash(tok), p["id"], JSON.stringify({ publish_at: bad })])))).toMatch(/invalid_publish_at/);
    }
    const pub = await asService(async (c) => (await c.query<{ r: J }>("select api_product_update($1, $2, $3) as r", [hash(tok), p["id"], JSON.stringify({ published: true })])).rows[0]!.r);
    expect(pub["publish_at"]).toBeNull();
  });
});
