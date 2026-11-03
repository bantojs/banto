import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** 0101_page_layouts・0102_page_layouts_product: 固定ページをトップ・記事のひな形に割り当てる（page_layouts_set）と、公開の settings の page_layouts */
describe.skipIf(!dbAvailable)("ひな形の割り当て（0101）", () => {
  let a: Fixture;
  let b: Fixture;
  let stranger: string;
  let page: string;
  let otherPage: string;
  let blog: string;
  const set = (uid: string, shopId: string, layouts: unknown) => asUser(uid, async (c) => (await c.query("select page_layouts_set($1, $2) as r", [shopId, JSON.stringify(layouts)])).rows[0].r);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "pl-a@example.com", slug: "pl-a", publish: true });
    b = await createShopFixture({ email: "pl-b@example.com", slug: "pl-b", publish: true });
    stranger = await createAuthUser("pl-x@example.com");
    const pool = getPool();
    page = (await pool.query("insert into pages (shop_id, handle, title, body, published) values ($1, 'tpl', 'ひな形', '::: current part=content', true) returning id", [a.shopId])).rows[0].id;
    otherPage = (await pool.query("insert into pages (shop_id, handle, title, body, published) values ($1, 'tpl', 'よそ', 'x', true) returning id", [b.shopId])).rows[0].id;
    blog = (await pool.query("insert into blogs (shop_id, handle, title) values ($1, 'news', 'お知らせ') returning id", [a.shopId])).rows[0].id;
  });
  afterAll(closePool);

  it("自分のショップのページ・ブログだけ。置いた値は公開の settings に出る", async () => {
    expect(await set(a.ownerId, a.shopId, { home: page, articles: { [blog]: page } })).toEqual({ home: page, articles: { [blog]: page } });
    const pub = await asAnon(async (c) => (await c.query("select shop_public_get('pl-a') as s")).rows[0].s);
    expect(pub.settings.page_layouts).toEqual({ home: page, articles: { [blog]: page } });
    // ほかのショップのページ・知らない鍵・形の違う値は断る
    expect(await expectDbError(() => set(a.ownerId, a.shopId, { home: otherPage }))).toMatch(/invalid_page_layouts/);
    expect(await expectDbError(() => set(a.ownerId, a.shopId, { cart: page }))).toMatch(/invalid_page_layouts/);
    expect(await expectDbError(() => set(a.ownerId, a.shopId, { articles: { [blog]: otherPage } }))).toMatch(/invalid_page_layouts/);
    expect(await expectDbError(() => set(a.ownerId, a.shopId, { home: 1 }))).toMatch(/invalid_page_layouts/);
    // 空にすると鍵ごと消える
    expect(await set(a.ownerId, a.shopId, { home: null, articles: {} })).toEqual({});
    expect((await getPool().query("select settings ? 'page_layouts' as has from shops where id = $1", [a.shopId])).rows[0].has).toBe(false);
  });

  it("商品詳細（0102）: ショップ全体とカテゴリーごと。よそのカテゴリー・ページは断る", async () => {
    const pool = getPool();
    const cat = (await pool.query("insert into categories (shop_id, slug, name) values ($1, 'tops', 'トップス') returning id", [a.shopId])).rows[0].id;
    const other = (await pool.query("insert into categories (shop_id, slug, name) values ($1, 'tops', 'よそ') returning id", [b.shopId])).rows[0].id;
    expect(await set(a.ownerId, a.shopId, { product: page, product_categories: { [cat]: page } })).toEqual({ product: page, product_categories: { [cat]: page } });
    const pub = await asAnon(async (c) => (await c.query("select shop_public_get('pl-a') as s")).rows[0].s);
    expect(pub.settings.page_layouts).toEqual({ product: page, product_categories: { [cat]: page } });
    expect(await expectDbError(() => set(a.ownerId, a.shopId, { product_categories: { [other]: page } }))).toMatch(/invalid_page_layouts/);
    expect(await expectDbError(() => set(a.ownerId, a.shopId, { product: otherPage }))).toMatch(/invalid_page_layouts/);
    expect(await set(a.ownerId, a.shopId, {})).toEqual({});
  });

  it("ゴミ箱のページは割り当てられない。content の項目の無い人・匿名は呼べない", async () => {
    await getPool().query("update pages set deleted_at = now() where id = $1", [page]);
    expect(await expectDbError(() => set(a.ownerId, a.shopId, { home: page }))).toMatch(/invalid_page_layouts/);
    await getPool().query("update pages set deleted_at = null where id = $1", [page]);
    expect(await expectDbError(() => set(stranger, a.shopId, { home: page }))).toMatch(/forbidden|permission/);
    expect(await expectDbError(() => asAnon((c) => c.query("select page_layouts_set($1, '{}'::jsonb)", [a.shopId])))).toMatch(/permission denied/);
  });
});
