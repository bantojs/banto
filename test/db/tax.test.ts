import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

describe.skipIf(!dbAvailable)("軽減税率（0017_tax）", () => {
  let f: Fixture;
  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "tax@example.com", slug: "tax-shop", publish: true });
    await getPool().query("update shops set settings = settings || '{\"tax_rate\": 10, \"tax_rate_reduced\": 8, \"tax_rounding\": \"round\"}' where id = $1", [f.shopId]);
  });
  afterAll(closePool);

  it("商品の区分は standard / reduced / exempt だけ。運営者が変えられる", async () => {
    await asUser(f.ownerId, (c) => c.query("update products set tax_class = 'reduced' where id = $1", [f.productId]));
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update products set tax_class = 'zero' where id = $1", [f.productId])))).toMatch(/products_tax_class_check/);
  });

  it("注文を入れた時点の税率・送料の税率・端数の扱いを残す（後で区分や設定を変えても変わらない）", async () => {
    const pool = getPool();
    const o = (await pool.query<{ id: string; shipping_tax_rate: string; tax_rounding: string }>("insert into orders (shop_id, total_jpy, shipping_jpy, customer_email, number) values ($1, 2820, 660, 'b@example.com', 2001) returning id, shipping_tax_rate, tax_rounding", [f.shopId])).rows[0]!;
    expect(Number(o.shipping_tax_rate)).toBe(10);
    expect(o.tax_rounding).toBe("round");
    const it = (await pool.query<{ tax_rate: string }>("insert into order_items (shop_id, order_id, sku_id, qty, unit_price_jpy) values ($1, $2, $3, 2, 1080) returning tax_rate", [f.shopId, o.id, f.skuId])).rows[0]!;
    expect(Number(it.tax_rate)).toBe(8);
    await pool.query("update products set tax_class = 'standard' where id = $1", [f.productId]);
    await pool.query("update shops set settings = settings || '{\"tax_rate_reduced\": 5}' where id = $1", [f.shopId]);
    expect(Number((await pool.query("select tax_rate from order_items where order_id = $1", [o.id])).rows[0].tax_rate)).toBe(8);

    // 注文照会（anon）に税率が載る。住所は載らない
    const r = await asService(async (c) => (await c.query<{ r: Record<string, unknown> }>("select lookup_order($1, 2001, 'B@example.com') as r", [f.shopId])).rows[0]!.r);
    expect(r).toMatchObject({ number: 2001, tax_rounding: "round", shipping_tax_rate: 10, items: [{ qty: 2, unit_price_jpy: 1080, tax_rate: 8 }] });
    expect(JSON.stringify(r)).not.toContain("shipping_address");
  });

  it("restore_tax: 復元の後で商品の区分を slug で、注文の送料の税率と端数を注文番号で戻し、明細の税率を入れ直す", async () => {
    const pool = getPool();
    const prod = (await pool.query<{ slug: string }>("select slug from products where id = $1", [f.productId])).rows[0]!;
    const r = await asService(async (c) => (await c.query<{ r: Record<string, number> }>("select restore_tax($1, $2::jsonb, $3::jsonb) as r", [f.shopId, JSON.stringify([{ slug: prod.slug, tax_class: "exempt" }, { slug: "nope", tax_class: "bad" }]), JSON.stringify([{ number: 2001, shipping_tax_rate: "10.00", tax_rounding: "ceil" }])])).rows[0]!.r);
    expect(r).toEqual({ tax_classes: 1, order_tax: 1 });
    expect((await pool.query("select tax_class from products where id = $1", [f.productId])).rows[0].tax_class).toBe("exempt");
    expect(Number((await pool.query("select tax_rate from order_items where sku_id = $1 limit 1", [f.skuId])).rows[0].tax_rate)).toBe(0);
    expect((await pool.query("select tax_rounding from orders where shop_id = $1 and number = 2001", [f.shopId])).rows[0].tax_rounding).toBe("ceil");
    expect(await expectDbError(() => asAnon((c) => c.query("select restore_tax($1, '[]', '[]')", [f.shopId])))).toMatch(/permission denied|service_role only/);
  });

  it("member_order: 自分の注文だけ・世代が合うときだけ・service_role だけ", async () => {
    const pool = getPool();
    const cust = (await pool.query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'm@example.com') returning id", [f.shopId])).rows[0]!;
    await pool.query("insert into orders (shop_id, total_jpy, customer_email, customer_id, number) values ($1, 1000, 'm@example.com', $2, 2002)", [f.shopId, cust.id]);
    const get = (cid: string, ep: number, n: number) => asService(async (c) => (await c.query<{ r: Record<string, unknown> | null }>("select member_order($1, $2, $3, $4) as r", [f.shopId, cid, ep, n])).rows[0]!.r);
    expect(await get(cust.id, 0, 2002)).toMatchObject({ number: 2002, total_jpy: 1000 });
    expect(await get(cust.id, 0, 2001)).toBeNull();
    expect(await get(cust.id, 1, 2002)).toBeNull();
    expect(await expectDbError(() => asAnon((c) => c.query("select member_order($1, $2, 0, 2002)", [f.shopId, cust.id])))).toMatch(/permission denied|service_role only/);
  });
});
