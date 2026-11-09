import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, closePool, createShopFixture, dbAvailable, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0132_admin_search: 管理画面の一覧の検索を広げた admin_search_ids。キーワード 1 つで番号・電話・送り状番号・品番・JAN を読み取り、
 * 注文は支払い方法・日付・金額・印、商品はカテゴリー・在庫で絞り、古い順にも並べる
 */
describe.skipIf(!dbAvailable)("管理画面の検索を広げる（0132）", () => {
  let a: Fixture;
  let b: Fixture;
  let cat: string;
  const search = (uid: string, shopId: string, kind: string, q: string, filters: Record<string, string> = {}, after: [string, string] | null = null, limit = 50) =>
    asUser(uid, async (c) => (await c.query<{ r: string[] }>("select admin_search_ids($1, $2, $3, $4, $5, $6, $7) as r", [shopId, kind, q, JSON.stringify(filters), after?.[0] ?? null, after?.[1] ?? null, limit])).rows[0]!.r);
  const numbers = async (ids: string[]) => (await getPool().query<{ number: number }>("select number from orders where id = any($1) order by array_position($1, id)", [ids])).rows.map((r) => r.number);
  const slugs = async (ids: string[]) => (await getPool().query<{ slug: string }>("select slug from products where id = any($1) order by array_position($1, id)", [ids])).rows.map((r) => r.slug);

  beforeAll(async () => {
    await resetDatabase();
    // フィクスチャの商品 tee（TEE-M）は在庫あり
    a = await createShopFixture({ email: "as-a@example.com", slug: "as-a", publish: true, stock: 5 });
    b = await createShopFixture({ email: "as-b@example.com", slug: "as-b", publish: true });
    const pool = getPool();
    // 注文: 日本時間の 11/1・11/2・11/3 の 0:30（UTC では前の日の 15:30）
    await pool.query(
      `insert into orders (shop_id, number, status, total_jpy, shipping_jpy, customer_email, customer_name, payment_provider, payment_ref, shipping_address, tracking_carrier, tracking_number, tags, created_at) values
       ($1, 1001, 'paid', 3000, 0, 'yamada@example.com', '山田', 'stripe', 'pi_1', '{"phone": "090-1234-5678"}', null, null, '{ギフト}', '2026-10-31T15:30:00Z'),
       ($1, 1002, 'shipped', 8000, 0, 'sato@example.com', '佐藤', 'komoju', 'kj_2', '{"phone": "03-1111-2222"}', 'yamato', '123456789012', '{}', '2026-11-01T15:30:00Z'),
       ($1, 1003, 'paid', 12000, 0, 'suzuki@example.com', '鈴木', 'amazon_pay', 'ch_3', '{"phone": "+81 80 9999 0000"}', null, null, '{ギフト,要確認}', '2026-11-02T15:30:00Z')`,
      [a.shopId],
    );
    await pool.query("insert into orders (shop_id, number, status, total_jpy, shipping_jpy, customer_email, customer_name, shipping_address) values ($1, 1001, 'paid', 100, 0, 'x@example.com', '他', '{\"phone\": \"090-1234-5678\"}')", [b.shopId]);
    // 商品: カテゴリーは主か追加。在庫は SKU ごと（skus への insert で inventory の行がトリガーで作られる）
    cat = (await pool.query<{ id: string }>("insert into categories (shop_id, slug, name) values ($1, 'shirts', 'シャツ') returning id", [a.shopId])).rows[0]!.id;
    const prod = async (slug: string, opts: { category?: string | null; extra?: string[]; created: string }) =>
      (await pool.query<{ id: string }>("insert into products (shop_id, slug, name, published, category_id, extra_category_ids, created_at) values ($1, $2, $2, true, $3, $4, $5) returning id", [a.shopId, slug, opts.category ?? null, opts.extra ?? [], opts.created])).rows[0]!.id;
    const linen = await prod("linen", { category: cat, created: "2026-11-01T00:00:00Z" });
    const wool = await prod("wool", { extra: [cat], created: "2026-11-02T00:00:00Z" });
    const mug = await prod("mug", { created: "2026-11-03T00:00:00Z" });
    const sku = async (product: string, code: string, gtin: string | null, stock: number) => {
      const id = (await pool.query<{ id: string }>("insert into skus (shop_id, product_id, code, name, price_jpy, gtin) values ($1, $2, $3, $3, 1000, $4) returning id", [a.shopId, product, code, gtin])).rows[0]!.id;
      await pool.query("update inventory set available = $2 where sku_id = $1", [id, stock]);
    };
    await sku(linen, "LS-NV-M", "4901234567894", 0);
    await sku(linen, "LS-NV-L", null, 0);
    await sku(wool, "WM-GR", null, 3);
    await sku(mug, "MG-1", null, 0);
  });
  afterAll(closePool);

  it("注文のキーワード: #番号、電話番号（区切りを無視、数字だけで一致）、送り状番号（ハイフンを無視）。他のショップは出さない", async () => {
    expect(await numbers(await search(a.ownerId, a.shopId, "orders", "#1002"))).toEqual([1002]);
    expect(await numbers(await search(a.ownerId, a.shopId, "orders", "09012345678"))).toEqual([1001]);
    expect(await numbers(await search(a.ownerId, a.shopId, "orders", "090-1234-5678"))).toEqual([1001]);
    expect(await numbers(await search(a.ownerId, a.shopId, "orders", "+81 80 9999 0000"))).toEqual([1003]);
    // 日本の国番号の書き方が違っても当たる（+81 ↔ 0）
    expect(await numbers(await search(a.ownerId, a.shopId, "orders", "080-9999-0000"))).toEqual([1003]);
    expect(await numbers(await search(a.ownerId, a.shopId, "orders", "+81 90-1234-5678"))).toEqual([1001]);
    expect(await numbers(await search(a.ownerId, a.shopId, "orders", "819012345678"))).toEqual([1001]);
    // 電話番号は完全一致（一部では探さない）
    expect(await search(a.ownerId, a.shopId, "orders", "1234-5678")).toEqual([]);
    expect(await numbers(await search(a.ownerId, a.shopId, "orders", "1234-5678-9012"))).toEqual([1002]);
    expect(await numbers(await search(a.ownerId, a.shopId, "orders", "123456789012"))).toEqual([1002]);
  });

  it("注文の条件: 支払い方法・日本時間の日付の範囲・金額・印。形の違う条件は無視する", async () => {
    expect(await numbers(await search(a.ownerId, a.shopId, "orders", "", { payment: "komoju" }))).toEqual([1002]);
    expect(await numbers(await search(a.ownerId, a.shopId, "orders", "", { from: "2026-11-02", to: "2026-11-03" }))).toEqual([1003, 1002]);
    expect(await numbers(await search(a.ownerId, a.shopId, "orders", "", { to: "2026-11-01" }))).toEqual([1001]);
    expect(await numbers(await search(a.ownerId, a.shopId, "orders", "", { min: "5000", max: "12000" }))).toEqual([1003, 1002]);
    expect(await numbers(await search(a.ownerId, a.shopId, "orders", "", { tag: "ギフト" }))).toEqual([1003, 1001]);
    expect(await numbers(await search(a.ownerId, a.shopId, "orders", "", { tag: "要確認", status: "paid" }))).toEqual([1003]);
    expect(await search(a.ownerId, a.shopId, "orders", "", { payment: "cash'; drop table orders; --", from: "yesterday", min: "-1" })).toHaveLength(3);
  });

  it("古い順: 並びとキーセットの向きが逆になる", async () => {
    expect(await numbers(await search(a.ownerId, a.shopId, "orders", "", { sort: "old" }))).toEqual([1001, 1002, 1003]);
    const first = await search(a.ownerId, a.shopId, "orders", "", { sort: "old" }, null, 1);
    const row = (await getPool().query("select created_at, id from orders where id = $1", [first[0]])).rows[0];
    expect(await numbers(await search(a.ownerId, a.shopId, "orders", "", { sort: "old" }, [row.created_at.toISOString(), row.id]))).toEqual([1002, 1003]);
  });

  it("商品: 品番・JAN の完全一致、カテゴリー（主か追加）、在庫の有無", async () => {
    expect(await slugs(await search(a.ownerId, a.shopId, "products", "LS-NV-L"))).toEqual(["linen"]);
    expect(await slugs(await search(a.ownerId, a.shopId, "products", "4901234567894"))).toEqual(["linen"]);
    expect(await search(a.ownerId, a.shopId, "products", "LS-NV")).toEqual([]);
    expect(await slugs(await search(a.ownerId, a.shopId, "products", "", { category: cat }))).toEqual(["wool", "linen"]);
    expect(await slugs(await search(a.ownerId, a.shopId, "products", "", { stock: "out" }))).toEqual(["mug", "linen"]);
    expect((await slugs(await search(a.ownerId, a.shopId, "products", "", { stock: "in" }))).sort()).toEqual(["tee", "wool"]);
    expect(await slugs(await search(a.ownerId, a.shopId, "products", "", { category: "not-a-uuid" }))).toHaveLength(4);
    // 他のショップの品番では出さない
    expect(await search(b.ownerId, b.shopId, "products", "LS-NV-L")).toEqual([]);
  });
});
