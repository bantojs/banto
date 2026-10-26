import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0058_product_listing: 商品の一覧を DB で絞り込み・並べ替え・ページ送りする。
 * いちばん安い SKU の価格・タグとカテゴリーの件数（トリガーで差分）・product_public_list のキーセット・検索・絞り込みを確かめる。
 */
describe.skipIf(!dbAvailable)("商品の一覧の DB 化（0058）", () => {
  let a: Fixture;
  let b: Fixture;

  type Item = { id: string; slug: string; name: string; min_price_jpy: number | null; compare_at_price_jpy: number | null; image: { storage_key: string } | null; tags: string[] };
  type Page = { items: Item[]; next: { k: unknown; id: string } | null; total?: number; total_capped?: boolean };
  type Args = { sort?: string; limit?: number; after?: unknown; offset?: number; tag?: string; categories?: string[] | null; brand?: string; q?: string; since?: string; count?: boolean };

  const list = (shopId: string, o: Args = {}) =>
    asAnon(async (c) =>
      (
        await c.query<{ r: Page }>("select product_public_list($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as r", [
          shopId, o.sort ?? "new", o.limit ?? 24, o.after === undefined ? null : JSON.stringify(o.after), o.offset ?? 0, o.tag ?? null,
          o.categories ?? null, o.brand ?? null, o.q ?? null, o.since ?? null, o.count ?? false,
        ])
      ).rows[0]!.r,
    );
  const facets = (shopId: string) =>
    asAnon(async (c) => (await c.query<{ r: { tags: { tag: string; count: number }[]; categories: Record<string, number> } }>("select product_public_facets($1) as r", [shopId])).rows[0]!.r);
  const owner = <T>(f: Fixture, sql: string, params: unknown[] = []) => asUser(f.ownerId, async (c) => (await c.query(sql, params)).rows as T[]);
  const addProduct = async (f: Fixture, slug: string, fields: { name?: string; tags?: string[]; brand?: string; category_id?: string | null; extra?: string[]; published?: boolean; price?: number; description?: string } = {}) => {
    const [p] = await owner<{ id: string }>(
      f,
      "insert into products (shop_id, slug, name, tags, brand, category_id, extra_category_ids, published, description) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id",
      [f.shopId, slug, fields.name ?? slug, fields.tags ?? [], fields.brand ?? null, fields.category_id ?? null, fields.extra ?? [], fields.published ?? true, fields.description ?? null],
    );
    if (fields.price !== undefined) await owner(f, "insert into skus (shop_id, product_id, code, price_jpy) values ($1, $2, $3, $4)", [f.shopId, p!.id, `${slug}-1`, fields.price]);
    return p!.id;
  };
  const category = async (f: Fixture, slug: string, parent: string | null = null) =>
    (await owner<{ id: string }>(f, "insert into categories (shop_id, slug, name, parent_id) values ($1, $2, $2, $3) returning id", [f.shopId, slug, parent]))[0]!.id;
  /** 件数の表が、作り直した結果と一致するか（差分のトリガーの検算） */
  const facetsConsistent = async (shopId: string) => {
    const pool = getPool();
    const before = (await pool.query("select kind, key, count from product_facets where shop_id = $1 order by 1, 2", [shopId])).rows;
    await pool.query("select banto_product_facets_rebuild($1)", [shopId]);
    const after = (await pool.query("select kind, key, count from product_facets where shop_id = $1 order by 1, 2", [shopId])).rows;
    expect(before).toEqual(after);
  };

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "pl-a@example.com", slug: "pl-a", publish: true, stock: 5 });
    b = await createShopFixture({ email: "pl-b@example.com", slug: "pl-b", publish: false, stock: 5 });
  });
  afterAll(closePool);

  it("いちばん安い SKU の価格と通常価格を商品に持つ（追加・変更・削除で追従）", async () => {
    const id = await addProduct(a, "price", { price: 5000 });
    const read = async () => (await getPool().query("select list_price_jpy as p, list_compare_at_jpy as c from products where id = $1", [id])).rows[0];
    expect(await read()).toEqual({ p: 5000, c: null });
    await owner(a, "insert into skus (shop_id, product_id, code, price_jpy, compare_at_price_jpy) values ($1, $2, 'price-2', 3000, 4000)", [a.shopId, id]);
    expect(await read()).toEqual({ p: 3000, c: 4000 });
    await owner(a, "update skus set price_jpy = 6000, compare_at_price_jpy = 7000 where code = 'price-2' and shop_id = $1", [a.shopId]);
    expect(await read()).toEqual({ p: 5000, c: null });
    await owner(a, "delete from skus where product_id = $1", [id]);
    expect(await read()).toEqual({ p: null, c: null });
  });

  it("タグとカテゴリーの件数: 公開中だけ、子孫を含み 1 商品は 1 回。公開の切り替え・付け替え・木の変更・削除に追従", async () => {
    const top = await category(a, "fc-top");
    const s1 = await category(a, "fc-s1", top);
    const s2 = await category(a, "fc-s2", top);
    const other = await category(a, "fc-other");
    const p1 = await addProduct(a, "fc-1", { tags: ["赤", "セール"], category_id: s1, extra: [s2] });
    await addProduct(a, "fc-2", { tags: ["赤"], category_id: s2 });
    await addProduct(a, "fc-3", { tags: ["赤"], category_id: s1, published: false });
    let f = await facets(a.shopId);
    expect(f.tags.find((t) => t.tag === "赤")?.count).toBe(2);
    expect(f.categories[top]).toBe(2);
    expect(f.categories[s1]).toBe(1);
    expect(f.categories[s2]).toBe(2);
    await facetsConsistent(a.shopId);

    await owner(a, "update products set published = false where id = $1", [p1]);
    f = await facets(a.shopId);
    expect(f.tags.find((t) => t.tag === "セール")).toBeUndefined();
    expect(f.categories[top]).toBe(1);
    await owner(a, "update products set published = true, tags = array['青'] where id = $1", [p1]);
    await facetsConsistent(a.shopId);

    // 木の付け替え: s2 を other の下へ
    await owner(a, "update categories set parent_id = $2 where id = $1", [s2, other]);
    f = await facets(a.shopId);
    expect(f.categories[other]).toBe(2);
    expect(f.categories[top]).toBe(1);
    await facetsConsistent(a.shopId);

    // カテゴリーの削除（子は最上位に、追加カテゴリーからは外れる）
    await owner(a, "delete from categories where id = $1", [other]);
    await facetsConsistent(a.shopId);
    expect((await facets(a.shopId)).categories[other]).toBeUndefined();
  });

  it("ショップを消しても件数の表で止まらない。他人と非公開のショップの件数・一覧は見えない", async () => {
    const c = await category(b, "b-cat");
    await addProduct(b, "b-1", { tags: ["x"], category_id: c });
    expect(await facets(b.shopId)).toEqual({ tags: [], categories: {} });
    expect((await list(b.shopId)).items).toEqual([]);
    const own = await asUser(b.ownerId, async (cl) => (await cl.query("select count(*)::int as n from product_facets where shop_id = $1", [b.shopId])).rows[0]!.n);
    expect(own).toBeGreaterThan(0);
    const others = await asUser(a.ownerId, async (cl) => (await cl.query("select count(*)::int as n from product_facets where shop_id = $1", [b.shopId])).rows[0]!.n);
    expect(others).toBe(0);
    expect(await expectDbError(() => asUser(b.ownerId, (cl) => cl.query("insert into product_facets values ($1, 'tag', 'z', 1)", [b.shopId])))).toMatch(/permission|row-level/);
    await asUser(b.ownerId, (cl) => cl.query("delete from shops where id = $1", [b.shopId]));
    expect((await getPool().query("select 1 from product_facets where shop_id = $1", [b.shopId])).rowCount).toBe(0);
  });

  it("キーセットで全件を重複・欠けなく辿れる（並べ替えごと）。offset は 10,000 まで", async () => {
    const shop = await createShopFixture({ email: "pl-c@example.com", slug: "pl-c", publish: true });
    const names = ["b", "a", "c", "a", "e", "d", "f", "b", "h", "g"];
    for (let i = 0; i < names.length; i++) await addProduct(shop, `k-${i}`, { name: names[i], price: (i % 4) * 1000 + 500 });
    await addProduct(shop, "k-noprice", { name: "z" });
    // 同じ時刻の行を作って、並べ替えの値が同じでも id で切れることを確かめる
    await getPool().query("update products set created_at = '2026-01-01T00:00:00Z' where shop_id = $1 and slug in ('k-1', 'k-2', 'k-3')", [shop.shopId]);
    const total = 12; // フィクスチャの tee を含む
    for (const sort of ["new", "updated", "price_asc", "price_desc", "name"]) {
      const seen: string[] = [];
      let after: unknown = undefined;
      for (let guard = 0; guard < 20; guard++) {
        const page = await list(shop.shopId, { sort, limit: 5, after });
        seen.push(...page.items.map((x) => x.slug));
        if (!page.next) break;
        after = page.next;
      }
      expect(new Set(seen).size, sort).toBe(total);
      expect(seen, sort).toHaveLength(total);
      const all = (await list(shop.shopId, { sort, limit: 100 })).items.map((x) => x.slug);
      expect(seen, sort).toEqual(all);
    }
    const asc = (await list(shop.shopId, { sort: "price_asc", limit: 100 })).items;
    expect(asc.at(-1)!.slug).toBe("k-noprice");
    expect(asc.map((x) => x.min_price_jpy).slice(0, -1)).toEqual([...asc.map((x) => x.min_price_jpy).slice(0, -1)].sort((x, y) => x! - y!));
    const desc = (await list(shop.shopId, { sort: "price_desc", limit: 100 })).items;
    expect(desc.at(-1)!.slug).toBe("k-noprice");
    expect((await list(shop.shopId, { offset: 10, limit: 5 })).items).toHaveLength(2);
    expect(await expectDbError(() => list(shop.shopId, { offset: 10001 }))).toMatch(/offset_too_large/);
    // 検索の語があるときは 1,000 まで
    expect(await expectDbError(() => list(shop.shopId, { offset: 1001, q: "k-1" }))).toMatch(/offset_too_large/);
    expect((await list(shop.shopId, { offset: 1000, q: "k-1" })).items).toEqual([]);
    expect(await expectDbError(() => list(shop.shopId, { sort: "x" }))).toMatch(/invalid_sort/);
    const counted = await list(shop.shopId, { limit: 3, count: true });
    expect(counted).toMatchObject({ total, total_capped: false });
  });

  it("絞り込み: タグ・カテゴリー（どれか 1 つ）・ブランド・検索（日本語・記号はそのまま）・更新日時。返す列に attributes は無い", async () => {
    const shop = await createShopFixture({ email: "pl-d@example.com", slug: "pl-d", publish: true });
    const c1 = await category(shop, "d-c1");
    const c2 = await category(shop, "d-c2");
    await addProduct(shop, "d-1", { name: "麦わら帽子", tags: ["夏"], brand: "ACME", category_id: c1, description: "日よけに 100% 綿" });
    await addProduct(shop, "d-2", { name: "Wool Cap", tags: ["冬"], brand: "acme2", extra: [c2] });
    await addProduct(shop, "d-3", { name: "ニット帽", tags: ["冬", "セール"], category_id: c2 });
    await owner(shop, "update products set attributes = '{\"secret\":1}' where slug = 'd-1' and shop_id = $1", [shop.shopId]);
    const slugs = async (o: Args) => (await list(shop.shopId, { ...o, limit: 100 })).items.map((x) => x.slug).sort();
    expect(await slugs({ tag: "冬" })).toEqual(["d-2", "d-3"]);
    expect(await slugs({ categories: [c2] })).toEqual(["d-2", "d-3"]);
    expect(await slugs({ categories: [c1, c2] })).toEqual(["d-1", "d-2", "d-3"]);
    expect(await slugs({ categories: [] })).toEqual([]);
    expect(await slugs({ brand: "ACME" })).toEqual(["d-1"]);
    expect(await slugs({ q: "麦わら帽子" })).toEqual(["d-1"]);
    expect(await slugs({ q: "wool" })).toEqual(["d-2"]);
    expect(await slugs({ q: "セール" })).toEqual(["d-3"]);
    expect(await slugs({ q: "100%" })).toEqual(["d-1"]);
    expect(await slugs({ q: "0% 綿" })).toEqual(["d-1"]);
    expect(await slugs({ q: "_x_" })).toEqual([]);
    // 2 文字以下は、タグ・カテゴリー・ブランドで絞っているときだけ（インデックスが効かず全件を見るため）
    expect(await expectDbError(() => slugs({ q: "帽子" }))).toMatch(/q_too_short/);
    expect(await expectDbError(() => slugs({ q: "%" }))).toMatch(/q_too_short/);
    expect(await slugs({ q: "帽", categories: [c1, c2] })).toEqual(["d-1", "d-3"]);
    expect(await slugs({ q: "帽子", tag: "夏" })).toEqual(["d-1"]);
    expect(await slugs({ q: "%", brand: "ACME" })).toEqual(["d-1"]);
    expect(await slugs({ tag: "冬", q: "ニット" })).toEqual(["d-3"]);
    expect(await slugs({ since: "2999-01-01T00:00:00Z" })).toEqual([]);
    const one = (await list(shop.shopId, { q: "麦わら" })).items[0]!;
    expect(one).not.toHaveProperty("attributes");
    expect(one).not.toHaveProperty("description");
  });

  it("商品フィードの 1 ページは、モジュールが ON のショップだけ", async () => {
    const shop = await createShopFixture({ email: "pl-g@example.com", slug: "pl-g", publish: true });
    const page = () => asAnon(async (c) => (await c.query<{ r: { products: unknown[] } }>("select product_feed_page($1, null, 10) as r", [shop.shopId])).rows[0]!.r);
    expect((await page()).products).toEqual([]);
    await getPool().query(`update shops set settings = settings || '{"modules":{"product_feed":true}}'::jsonb where id = $1`, [shop.shopId]);
    const r = (await page()) as unknown as { products: unknown[]; inventory: Record<string, unknown>[] };
    expect(r.products).toHaveLength(1);
    // 在庫は「あり / なし」だけ（正確な数は返さない）
    expect(r.inventory).toEqual([{ sku_id: shop.skuId, in_stock: false }]);
    await asUser(shop.ownerId, (c) => c.query("select set_stock($1, 7)", [shop.skuId]));
    expect(((await page()) as unknown as { inventory: Record<string, unknown>[] }).inventory).toEqual([{ sku_id: shop.skuId, in_stock: true }]);
  });

  it("workers_plan は払い出しの自動化（service_role・JWT の無い直接の SQL）からも書ける。anon と member は書けない", async () => {
    const set = (v: string) => `select site_settings_set('workers_plan', '"${v}"') as r`;
    const plan = async () => (await getPool().query<{ p: string }>("select banto_site_plan() as p")).rows[0]!.p;
    await asService((c) => c.query(set("paid")));
    expect(await plan()).toBe("paid");
    await getPool().query(set("free"));
    expect(await plan()).toBe("free");
    expect(await expectDbError(() => asAnon((c) => c.query(set("paid"))))).toMatch(/permission denied|forbidden/);
    const stranger = await createAuthUser("pl-plan@example.com");
    expect(await expectDbError(() => asUser(stranger, (c) => c.query(set("paid"))))).toMatch(/forbidden/);
    expect(await expectDbError(() => asService((c) => c.query(set("enterprise"))))).toMatch(/invalid_value/);
    // plan_limits は今までどおり owner には書けない
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query(`select site_settings_set('plan_limits', '{}')`)))).toMatch(/forbidden/);
  });

  it("画像は並び順の最初の 1 枚", async () => {
    const shop = await createShopFixture({ email: "pl-e@example.com", slug: "pl-e", publish: true });
    await owner(shop, "insert into product_images (shop_id, product_id, storage_key, sort_order) values ($1, $2, 'b.webp', 2), ($1, $2, 'a.webp', 1)", [shop.shopId, shop.productId]);
    expect((await list(shop.shopId)).items[0]!.image).toMatchObject({ storage_key: "a.webp" });
  });

  it("検索・並べ替えはインデックスを使う（大量の行で seq scan にならない）", async () => {
    const pool = getPool();
    const shop = await createShopFixture({ email: "pl-f@example.com", slug: "pl-f", publish: true });
    await pool.query(
      `insert into products (shop_id, slug, name, published, tags, list_price_jpy)
       select $1, 'bulk-' || g, '商品' || g || case when g % 97 = 0 then ' 麦わら帽子' else '' end, true, array['t' || (g % 50)], g % 10000
         from generate_series(1, 20000) g`,
      [shop.shopId],
    );
    await pool.query("analyze products");
    const plan = async (sql: string, params: unknown[]) => (await pool.query(`explain ${sql}`, params)).rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
    for (const sort of [
      "p.created_at desc, p.id desc",
      "coalesce(p.list_price_jpy, 2147483647), p.id",
      "coalesce(p.list_price_jpy, -1) desc, p.id desc",
      "p.name, p.id",
    ]) {
      const text = await plan(`select p.id from products p where p.shop_id = $1 and p.published order by ${sort} limit 25`, [shop.shopId]);
      expect(text, sort).toMatch(/Index Scan|Index Only Scan/);
      expect(text, sort).not.toMatch(/Seq Scan/);
    }
    const search = await plan("select p.id from products p where p.shop_id = $1 and p.published and banto_product_search_text(p.name, p.brand, p.tags, p.description) like $2", [shop.shopId, "%麦わら帽子%"]);
    expect(search).toMatch(/products_search_trgm/);
    const hits = await list(shop.shopId, { q: "麦わら帽子", limit: 100, count: true });
    expect(hits.total).toBe(Math.floor(20000 / 97));
  });
});
