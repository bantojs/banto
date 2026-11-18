import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

type J = Record<string, unknown>;
type Page = { items: { slug: string }[]; total?: number };

/** 0153_product_option_stock: 一覧の絞り込みの段 2（SKU の選択肢で、在庫のあるものに絞る）と、件数の options */
describe.skipIf(!dbAvailable)("選択肢の絞り込み（0153）", () => {
  let f: Fixture;
  const skus: Record<string, string> = {};
  const list = (args: J) =>
    asAnon(async (c) => {
      const keys = Object.keys(args);
      const named = keys.map((k, i) => `, ${k} => $${i + 2}`).join("");
      return (await c.query<{ r: Page }>(`select product_public_list(p_shop_id => $1${named}) as r`, [f.shopId, ...keys.map((k) => (k === "p_options" ? JSON.stringify(args[k]) : args[k]))])).rows[0]!.r;
    });
  const slugs = async (options: J, extra: J = {}) => (await list({ p_options: options, ...extra })).items.map((i) => i.slug).sort();
  const setStock = (code: string, n: number) => asUser(f.ownerId, (c) => c.query("select set_stock($1, $2)", [skus[code], n]));
  const add = async (slug: string, variants: { code: string; options: J; stock: number }[]) => {
    const id = await asUser(f.ownerId, async (c) => (await c.query<{ id: string }>("insert into products (shop_id, slug, name, published) values ($1, $2, $2, true) returning id", [f.shopId, slug])).rows[0]!.id);
    for (const v of variants) {
      skus[v.code] = await asUser(f.ownerId, async (c) => (await c.query<{ id: string }>("insert into skus (shop_id, product_id, code, price_jpy, options) values ($1, $2, $3, 1000, $4) returning id", [f.shopId, id, v.code, JSON.stringify(v.options)])).rows[0]!.id);
      if (v.stock > 0) await setStock(v.code, v.stock);
    }
    return id;
  };

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "pos-owner@example.com", slug: "pos-shop", publish: true });
    await asUser(f.ownerId, (c) => c.query("update products set published = false where id = $1", [f.productId]));
    await add("shirt", [
      { code: "TEE-RED-S", options: { color: "red", size: "S" }, stock: 0 },
      { code: "TEE-RED-M", options: { color: "red", size: "M" }, stock: 2 },
      { code: "TEE-BLUE-S", options: { color: "blue", size: "S" }, stock: 1 },
    ]);
    await add("cap", [{ code: "CAP-RED", options: { color: "red" }, stock: 0 }]);
    await add("bag", [{ code: "BAG-BLUE", options: { color: "blue" }, stock: 3 }]);
  });
  afterAll(closePool);

  it("在庫のある SKU の選択肢だけ。同じ鍵はどれか、鍵どうしはすべて（鍵ごとに見る）", async () => {
    expect(await slugs({ color: ["red"] })).toEqual(["shirt"]);
    expect(await slugs({ color: ["red", "blue"] })).toEqual(["bag", "shirt"]);
    expect(await slugs({ color: ["blue"], size: ["S"] })).toEqual(["shirt"]);
    expect(await slugs({ size: ["L"] })).toEqual([]);
    // 空の値は条件にしない
    expect(await slugs({ color: [] })).toEqual(["bag", "cap", "shirt"]);
  });

  it("在庫が 0 をまたいだときに表が変わる。SKU の選択肢を直したときも", async () => {
    await setStock("CAP-RED", 1);
    expect(await slugs({ color: ["red"] })).toEqual(["cap", "shirt"]);
    await setStock("CAP-RED", 0);
    expect(await slugs({ color: ["red"] })).toEqual(["shirt"]);
    await setStock("TEE-RED-M", 0);
    expect(await slugs({ color: ["red"] })).toEqual([]);
    await setStock("TEE-RED-M", 2);
    await asUser(f.ownerId, (c) => c.query("update skus set options = '{\"color\": \"green\", \"size\": \"M\"}' where id = $1", [skus["TEE-RED-M"]]));
    expect(await slugs({ color: ["green"] })).toEqual(["shirt"]);
    expect(await slugs({ color: ["red"] })).toEqual([]);
  });

  it("予約（reserve_stock）で最後の 1 点が出ると表から外れ、解放で戻る", async () => {
    await setStock("BAG-BLUE", 1);
    expect(await slugs({ color: ["blue"] })).toEqual(["bag", "shirt"]);
    const res = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb, 900) as id", [f.shopId, JSON.stringify([{ sku_id: skus["BAG-BLUE"], qty: 1 }])])).rows[0]!.id);
    expect(await slugs({ color: ["blue"] })).toEqual(["shirt"]);
    await asService((c) => c.query("select release_reservation($1, $2)", [res, f.shopId]));
    expect(await slugs({ color: ["blue"] })).toEqual(["bag", "shirt"]);
  });

  it("短い検索の語は選択肢だけでは探せない（索引の効かない探し方で全件を見ないように）", async () => {
    expect(await expectDbError(() => list({ p_q: "a", p_options: { size: ["S"] } }))).toMatch(/q_too_short/);
  });

  it("形の違う条件は invalid_options。鍵は 3 つまで・値は 10 まで", async () => {
    for (const bad of [["x"], { "Color!": ["a"] }, { color: "red" }, { a: ["1"], b: ["1"], c: ["1"], d: ["1"] }, { color: Array.from({ length: 11 }, (_, i) => `v${i}`) }]) {
      expect(await expectDbError(() => list({ p_options: bad }))).toMatch(/invalid_options/);
    }
  });

  it("件数の options は鍵 × 値ごとの在庫のある公開の商品の数", async () => {
    const r = await asAnon(async (c) => (await c.query<{ r: { options: { key: string; value: string; count: number }[] } }>("select product_public_facets($1) as r", [f.shopId])).rows[0]!.r);
    expect(r.options).toEqual(
      expect.arrayContaining([
        { key: "color", value: "blue", count: 2 },
        { key: "color", value: "green", count: 1 },
        { key: "size", value: "S", count: 1 },
        { key: "size", value: "M", count: 1 },
      ]),
    );
    expect(r.options.find((o) => o.value === "red")).toBeUndefined();
  });

  it("表は運営者（catalog）だけが読める。匿名は読めず、だれも直接は書けない", async () => {
    expect(await expectDbError(() => asAnon((c) => c.query("select * from product_option_stock")))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("insert into product_option_stock (shop_id, product_id, key, value) values ($1, $2, 'x', 'y')", [f.shopId, f.productId])))).toMatch(/permission denied/);
    const rows = await getPool().query("select count(*)::int as n from product_option_stock where shop_id = $1", [f.shopId]);
    expect(rows.rows[0]!.n).toBeGreaterThan(0);
  });
});
