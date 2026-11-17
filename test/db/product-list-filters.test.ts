import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, resetDatabase, type Fixture } from "./harness";

type J = Record<string, unknown>;
type Page = { items: { slug: string }[]; next: unknown; total?: number };

/** 0150_product_list_filters: 一覧の絞り込みの段 1（複数のタグ = すべてを持つ・価格の上下限）と、件数の price_max */
describe.skipIf(!dbAvailable)("一覧の絞り込み（0150）", () => {
  let f: Fixture;
  const list = (args: J) =>
    asAnon(async (c) => {
      const keys = Object.keys(args);
      const named = keys.map((k, i) => `, ${k} => $${i + 2}`).join("");
      return (await c.query<{ r: Page }>(`select product_public_list(p_shop_id => $1${named}) as r`, [f.shopId, ...keys.map((k) => args[k])])).rows[0]!.r;
    });
  const slugs = async (args: J) => (await list(args)).items.map((i) => i.slug).sort();
  const add = async (slug: string, tags: string[], price: number | null) => {
    const id = await asUser(f.ownerId, async (c) => (await c.query<{ id: string }>("insert into products (shop_id, slug, name, tags, published) values ($1, $2, $2, $3, true) returning id", [f.shopId, slug, tags])).rows[0]!.id);
    if (price !== null) await asUser(f.ownerId, (c) => c.query("insert into skus (shop_id, product_id, code, price_jpy) values ($1, $2, $3, $4)", [f.shopId, id, `${slug}-1`, price]));
  };

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "plf-owner@example.com", slug: "plf-shop", publish: true });
    // 土台の商品（タグなし）を一覧から外す
    await asUser(f.ownerId, (c) => c.query("update products set published = false where id = $1", [f.productId]));
    await add("red-s", ["red", "sale"], 1000);
    await add("red", ["red"], 3000);
    await add("blue-s", ["blue", "sale"], 8000);
    await add("free", ["red", "sale"], null);
  });
  afterAll(closePool);

  it("複数のタグはすべてを持つ商品だけ。今までの p_tag と合わせても同じ。空・重なりは除く", async () => {
    expect(await slugs({ p_tags: ["red", "sale"] })).toEqual(["free", "red-s"]);
    expect(await slugs({ p_tag: "sale", p_tags: ["red"] })).toEqual(["free", "red-s"]);
    expect(await slugs({ p_tags: ["red", " red ", ""] })).toEqual(["free", "red", "red-s"]);
    expect(await slugs({ p_tag: "red" })).toEqual(["free", "red", "red-s"]);
    expect(await expectDbError(() => list({ p_tags: ["a", "b", "c", "d", "e", "f"] }))).toMatch(/too_many_tags/);
  });

  it("価格の上下限（一覧の価格 = いちばん安い SKU）。価格の無い商品は上下限があれば出さない。件数も同じ条件", async () => {
    expect(await slugs({ p_price_min: 1000, p_price_max: 3000 })).toEqual(["red", "red-s"]);
    expect(await slugs({ p_price_min: 3001 })).toEqual(["blue-s"]);
    expect(await slugs({ p_price_max: 999 })).toEqual([]);
    expect(await slugs({ p_price_min: 5000, p_price_max: 100 })).toEqual([]);
    expect((await list({ p_tags: ["sale"], p_price_max: 5000, p_count: true })).total).toBe(1);
    expect(await expectDbError(() => list({ p_price_min: -1 }))).toMatch(/invalid_price_filter/);
  });

  it("価格順のキーセットのページ送りも絞り込みを保つ", async () => {
    const first = await list({ p_sort: "price_asc", p_limit: 1, p_tags: ["sale"] });
    expect(first.items.map((i) => i.slug)).toEqual(["red-s"]);
    const second = await list({ p_sort: "price_asc", p_limit: 1, p_tags: ["sale"], p_after: JSON.stringify(first.next) });
    expect(second.items.map((i) => i.slug)).toEqual(["blue-s"]);
  });

  it("短い検索の語は、複数のタグで絞っていれば探せる", async () => {
    expect(await slugs({ p_q: "re", p_tags: ["sale"] })).toEqual(["free", "red-s"]);
    expect(await expectDbError(() => list({ p_q: "re" }))).toMatch(/q_too_short/);
  });

  it("会員の一覧（product_member_list）も同じ絞り込みを受ける", async () => {
    const r = await asService(async (c) =>
      (await c.query<{ r: Page }>("select product_member_list(p_shop_id => $1, p_customer_id => $2, p_epoch => 0, p_session_id => $3, p_tags => $4, p_price_max => 5000) as r", [f.shopId, crypto.randomUUID(), crypto.randomUUID(), ["sale"]])).rows[0]!.r,
    );
    expect(r.items.map((i) => i.slug)).toEqual(["red-s"]);
  });

  it("件数の price_max は公開の一覧に出る商品のいちばん高い一覧の価格", async () => {
    const facets = async () => await asAnon(async (c) => (await c.query<{ r: J }>("select product_public_facets($1) as r", [f.shopId])).rows[0]!.r);
    expect((await facets())["price_max"]).toBe(8000);
    await asUser(f.ownerId, (c) => c.query("update products set published = false where shop_id = $1 and slug = 'blue-s'", [f.shopId]));
    expect((await facets())["price_max"]).toBe(3000);
  });
});
