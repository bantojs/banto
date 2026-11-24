import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/** 0146_product_released_at: 商品の発売日。新着順は coalesce(released_at, created_at)、AI 用 API・匿名の読み取り・復元 */
describe.skipIf(!dbAvailable)("商品の発売日（0146）", () => {
  let f: Fixture;
  let tok: string;
  const create = (values: J) => asService(async (c) => (await c.query<{ r: J }>("select api_product_create($1, $2) as r", [hash(tok), JSON.stringify(values)])).rows[0]!.r);
  const update = (id: string, values: J) => asService(async (c) => (await c.query<{ r: J }>("select api_product_update($1, $2, $3) as r", [hash(tok), id, JSON.stringify(values)])).rows[0]!.r);
  const listNew = async (after?: unknown) =>
    (await asAnon(async (c) => (await c.query<{ r: { items: J[]; next: unknown } }>("select product_public_list($1, 'new', 2, $2) as r", [f.shopId, after === undefined ? null : JSON.stringify(after)])).rows[0]!.r));

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "pra-owner@example.com", slug: "pra-shop", publish: true });
    tok = `banto_${randomUUID()}`;
    await asUser(f.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, '{products:read,products:write}')", [f.shopId, f.ownerId, hash(tok), tok.slice(0, 12)]));
  });
  afterAll(closePool);

  it("AI 用 API: 作るときも直すときも受け、null で外す。形の違い・範囲の外は断る", async () => {
    const p = await create({ slug: "old-tee", name: "old", published: true, released_at: "2019-04-01T10:00:00+09:00" });
    expect(new Date(p["released_at"] as string).toISOString()).toBe("2019-04-01T01:00:00.000Z");
    const id = p["id"] as string;
    expect(new Date((await update(id, { released_at: "2020-01-01" }))["released_at"] as string).toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect((await update(id, { name: "old2" }))["released_at"]).not.toBeNull();
    // 時差の無い日時は、DB の時間帯に関係なく UTC として読む
    await getPool().query("set timezone to 'Asia/Tokyo'");
    try {
      expect(new Date((await update(id, { released_at: "2020-01-01T10:00" }))["released_at"] as string).toISOString()).toBe("2020-01-01T10:00:00.000Z");
    } finally {
      await getPool().query("reset timezone");
    }
    expect((await update(id, { released_at: null }))["released_at"]).toBeNull();
    for (const bad of ["yesterday", "epoch", "2020-13-01", 20200101, "1980-01-01T00:00:00Z", "2999-01-01T00:00:00Z"]) {
      expect(await expectDbError(() => update(id, { released_at: bad }))).toMatch(/invalid_released_at/);
    }
    expect(await expectDbError(() => create({ slug: "bad", name: "bad", released_at: {} }))).toMatch(/invalid_released_at/);
  });

  it("新着順: 発売日があればその日、無ければ作成日。続きの位置（キーセット）も同じ鍵で", async () => {
    const pool = getPool();
    await pool.query("update products set published = false where shop_id = $1", [f.shopId]);
    // 作成日は a が最も新しいが、発売日で c → a → b の順になるようにする
    const ins = async (slug: string, created: string, released: string | null) =>
      (await pool.query<{ id: string }>("insert into products (shop_id, slug, name, published, created_at, released_at) values ($1, $2, $2, true, $3, $4) returning id", [f.shopId, slug, created, released])).rows[0]!.id;
    await ins("a", "2026-11-01T00:00:00Z", null);
    await ins("b", "2026-11-02T00:00:00Z", "2018-05-01T00:00:00Z");
    await ins("c", "2026-10-01T00:00:00Z", "2026-11-10T00:00:00Z");
    const first = await listNew();
    expect(first.items.map((i) => i["slug"])).toEqual(["c", "a"]);
    expect(first.items[0]!["released_at"]).not.toBeNull();
    expect(first.items[1]!["released_at"]).toBeNull();
    const second = await listNew(first.next);
    expect(second.items.map((i) => i["slug"])).toEqual(["b"]);
  });

  it("匿名でも released_at の列を読め、商品の詳細（product_public_get）に載る", async () => {
    const rows = (await asAnon((c) => c.query<{ released_at: string | null }>("select released_at from products where shop_id = $1 and slug = 'c'", [f.shopId]))).rows;
    expect(rows[0]!.released_at).not.toBeNull();
    const d = await asAnon(async (c) => (await c.query<{ r: J }>("select product_public_get($1, 'c') as r", [f.shopId])).rows[0]!.r);
    expect(d["released_at"]).not.toBeNull();
  });

  it("範囲は書き込みの経路を問わず DB が確かめる（管理画面の JWT で直接書いても断る）", async () => {
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update products set released_at = '1985-04-01' where shop_id = $1 and slug = 'a'", [f.shopId])))).toMatch(/invalid_released_at/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update products set released_at = now() + interval '11 years' where shop_id = $1 and slug = 'a'", [f.shopId])))).toMatch(/invalid_released_at/);
  });

  it("復元: URL の名前で発売日を戻す。形の違う値は飛ばす。service_role だけ", async () => {
    const r = await asService(async (c) => (await c.query<{ r: J }>("select restore_product_released_at($1, $2) as r", [f.shopId, JSON.stringify([{ slug: "a", released_at: "2017-01-01T00:00:00Z" }, { slug: "b", released_at: "x" }, { slug: "none", released_at: "2017-01-01T00:00:00Z" }])])).rows[0]!.r);
    expect(r).toEqual({ products_released_at: 1 });
    const at = (await getPool().query<{ t: Date }>("select released_at as t from products where shop_id = $1 and slug = 'a'", [f.shopId])).rows[0]!.t;
    expect(at.toISOString()).toBe("2017-01-01T00:00:00.000Z");
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select restore_product_released_at($1, '[]')", [f.shopId])))).toMatch(/permission denied/);
  });
});
