import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, closePool, dbAvailable, expectDbError, createShopFixture, getPool, resetDatabase, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * 0142_security_hardening_6: 守りの締め直し 6。
 * - hooks の送信先の URL の形（URL パーサーと DB で別のホストに読める書き方を受けない）、つないだ連携のホストはその書き方でも変えられない
 * - 送信先を足したときの監査ログ
 * - low_stock_threshold は 0 以上の整数だけ（誤った値で注文の確定が止まらない）
 * - inventory.low は同じ送信先・同じ SKU の未配信があれば積まない
 * - enqueue_hook の id の確かめは大文字の UUID にも
 * - checkout_status は refunded を released で返す
 */
describe.skipIf(!dbAvailable)("セキュリティの締め直し 6（0142_security_hardening_6）", () => {
  let f: Fixture;
  let other: Fixture;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "h6-owner@example.com", slug: "h6-shop", publish: true, stock: 10 });
    other = await createShopFixture({ email: "h6-other@example.com", slug: "h6-other", publish: true, stock: 10 });
  });
  afterAll(closePool);

  const ins = (url: string) => asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'x', $2, '{}') returning id", [f.shopId, url]));

  it("URL パーサーが別のホストに読む書き方の送信先は足せない。ふつうの URL は足せる", async () => {
    for (const url of [
      "https://evil.example\\@plugin.example/hook",
      "http://127.0.0.1\\@evil.example/",
      "https://user@plugin.example/hook",
      "http://１２７.０.０.１/",
      "http://%31%32%37.0.0.1/",
      "http://loc%61lhost/",
      "http://127.0\t.0.1/",
      "https://plugin.example/a b",
      "https://plugin.example/a\nb",
    ]) {
      expect(await expectDbError(() => ins(url)), url).toMatch(/invalid_url/);
    }
    for (const url of ["https://plugin.example/hook", "https://plugin.example:8443/hook?a=1&b=%20", "https://xn--eckwd4c7c.example/h", "http://[2001:db8::1]/x"]) {
      expect((await ins(url)).rowCount, url).toBe(1);
    }
  });

  it("つないだ連携の送信先は、バックスラッシュを使ってもホストを変えられない。前からある行のほかの列は変えられる", async () => {
    const ep = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events, app_handle) values ($1, 'reviews', 'https://plugin.example/hook', '{order.shipped}', 'reviews6') returning id", [f.shopId]))).rows[0]!.id;
    await asUser(f.ownerId, (c) => c.query("select app_connect_begin($1, $2, $3, $4)", [f.shopId, ep, ["app_data:write"], hash("h6-ticket")]));
    await asService((c) => c.query("select app_connect_exchange($1, $2, $3, $4)", [hash("h6-ticket"), hash("h6-tok"), "banto_h6tok", "v1.aaaa.bbbb"]));
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update hook_endpoints set url = 'https://evil.example\\@plugin.example/hook' where id = $1", [ep])))).toMatch(/invalid_url/);
    expect((await getPool().query<{ url: string }>("select url from hook_endpoints where id = $1", [ep])).rows[0]!.url).toBe("https://plugin.example/hook");
    // 0142 より前に入った、形の合わない行（トリガーを通さずに置く）も、URL 以外の列は今までどおり変えられる
    await getPool().query("alter table hook_endpoints disable trigger user");
    const old = (await getPool().query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'old', 'https://user@old.example/h', '{}') returning id", [f.shopId])).rows[0]!.id;
    await getPool().query("alter table hook_endpoints enable trigger user");
    await asUser(f.ownerId, (c) => c.query("update hook_endpoints set enabled = false where id = $1", [old]));
  });

  it("送信先を足すと監査ログに残る（名前・ホスト・出来事）", async () => {
    await getPool().query("delete from audit_log where action = 'hook_endpoint.created'");
    const id = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'crm', 'https://new-dest.example/h', '{order.created,order.paid}') returning id", [f.shopId]))).rows[0]!.id;
    const rows = (await getPool().query<{ target_id: string; detail: Record<string, unknown> }>("select target_id, detail from audit_log where action = 'hook_endpoint.created'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target_id).toBe(id);
    expect(rows[0]!.detail).toMatchObject({ name: "crm", host: "new-dest.example", events: ["order.created", "order.paid"] });
  });

  it("low_stock_threshold に数でない値は入らず、注文の確定は止まらない", async () => {
    const patch = (v: unknown) => asUser(f.ownerId, (c) => c.query("update shops set settings = settings || $2::jsonb where id = $1", [f.shopId, JSON.stringify({ low_stock_threshold: v })]));
    for (const bad of ["abc", 99999999999, 3.5, -1, null, [1]]) expect(await expectDbError(() => patch(bad)), String(bad)).toMatch(/shops_low_stock_threshold/);
    await patch(5);
    await patch("7");
    const price = (await getPool().query<{ price_jpy: number }>("select price_jpy from skus where id = $1", [f.skuId])).rows[0]!.price_jpy;
    const res = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb, 900, null, null, null) as id", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: 1 }])])).rows[0]!.id);
    const order = await asService(async (c) => (await c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [res, f.shopId, JSON.stringify({ payment_provider: "stripe", payment_ref: "pi_h6", amount_paid_jpy: price, currency: "jpy" })])).rows[0]!.id);
    expect(order).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("入出庫をくり返しても、inventory.low は同じ SKU の未配信が 1 件あるあいだ積まれない", async () => {
    await asUser(f.ownerId, (c) => c.query("update shops set settings = settings - 'low_stock_threshold' where id = $1", [f.shopId]));
    await asUser(f.ownerId, (c) => c.query("insert into hook_endpoints (shop_id, name, url, events) values ($1, 'stock', 'https://stock.example/h', '{inventory.low}')", [f.shopId]));
    const available = (await getPool().query<{ available: number }>("select available from inventory where sku_id = $1", [f.skuId])).rows[0]!.available;
    const down = available - 2;
    const lines = Array.from({ length: 40 }, (_, i) => ({ sku_id: f.skuId, delta: i % 2 === 0 ? -down : down }));
    await asUser(f.ownerId, (c) => c.query("select stock_adjust($1, $2::jsonb)", [f.shopId, JSON.stringify(lines)]));
    const n = (await getPool().query<{ n: number }>("select count(*)::int as n from hook_deliveries where shop_id = $1 and event = 'inventory.low'", [f.shopId])).rows[0]!.n;
    expect(n).toBe(1);
    expect((await getPool().query<{ available: number }>("select available from inventory where sku_id = $1", [f.skuId])).rows[0]!.available).toBe(available);
    // 未配信の知らせがあるあいだに売り切れた → 重ねては積まないが、中身は最後の数（0）になる（受け手は available が 0 かで売り切れを見分ける）
    await asUser(f.ownerId, (c) => c.query("select stock_adjust($1, $2::jsonb)", [f.shopId, JSON.stringify([{ sku_id: f.skuId, delta: -(available - 2) }, { sku_id: f.skuId, delta: available - 2 }, { sku_id: f.skuId, delta: -available }])]));
    const rows = (await getPool().query<{ payload: { available: number } }>("select payload from hook_deliveries where shop_id = $1 and event = 'inventory.low'", [f.shopId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.available).toBe(0);
    await asUser(f.ownerId, (c) => c.query("select stock_adjust($1, $2::jsonb)", [f.shopId, JSON.stringify([{ sku_id: f.skuId, delta: available }])]));
  });

  it("enqueue_hook: 大文字・ハイフンなし・{…} で書いた別のショップの商品の id も受けない", async () => {
    for (const id of [other.productId.replace(/-/g, ""), `{${other.productId}}`, "x"]) {
      expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select enqueue_hook($1, 'product.updated', $2::jsonb)", [f.shopId, JSON.stringify({ product_id: id })]))), id).toMatch(/invalid_payload/);
    }
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select enqueue_hook($1, 'product.updated', $2::jsonb)", [f.shopId, JSON.stringify({ product_id: other.productId.toUpperCase() })])))).toMatch(/invalid_payload/);
    await asUser(f.ownerId, (c) => c.query("select enqueue_hook($1, 'product.updated', $2::jsonb)", [f.shopId, JSON.stringify({ product_id: f.productId.toUpperCase() })]));
  });

  it("checkout_status: 返金して済んだ予約は released で返す", async () => {
    const res = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb, 900, 'quote-h6-0001', null, null) as id", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: 1 }])])).rows[0]!.id);
    await asService((c) => c.query("select reservation_mark_refunded($1, $2, 'stripe', 'evt_h6')", [res, f.shopId]));
    const st = await asService(async (c) => (await c.query<{ r: { status: string } }>("select checkout_status($1, 'quote-h6-0001') as r", [f.shopId])).rows[0]!.r);
    expect(st.status).toBe("released");
  });
});
