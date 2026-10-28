import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, getPool, resetDatabase, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/**
 * 0069_headless_account_page: 会員ページの URL（公開の settings）・試着のお知らせの storefront・AI 用 API の GET /shop のヘッドレス連携の設定
 */
describe.skipIf(!dbAvailable)("会員ページを連携サイトに（0069）", () => {
  let a: Fixture;
  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "ap@example.com", slug: "ap-shop", publish: true, stock: 5 });
    await getPool().query(
      `update shops set settings = settings || '{"headless":{"return_origins":["https://wp.example.com"],"order_page_url":"https://wp.example.com/order/","account_page_url":"https://wp.example.com/my/","relay_ips":["203.0.113.1"],"legal_links":{"legal":"https://wp.example.com/legal/","check_hours":24}},"storefront":{"mode":"off","site_url":"https://wp.example.com/"}}'::jsonb where id = $1`,
      [a.shopId],
    );
  });
  afterAll(closePool);

  it("公開の settings に会員ページの URL が出る（中継元の IP は出さない）", async () => {
    const pub = await asAnon(async (c) => (await c.query<{ r: { settings: { headless: J } } }>("select shop_public_get('ap-shop', null) as r")).rows[0]!.r);
    expect(pub.settings.headless).toEqual({ return_origins: ["https://wp.example.com"], order_page_url: "https://wp.example.com/order/", account_page_url: "https://wp.example.com/my/" });
  });

  it("AI 用 API の GET /shop（shop:read）がヘッドレス連携とお店の画面の使い方を返す", async () => {
    const raw = `banto_${Math.random().toString(36).slice(2)}`;
    await asUser(a.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [a.shopId, a.ownerId, hash(raw), raw.slice(0, 12), ["shop:read"]]));
    const r = await asService(async (c) => (await c.query<{ r: J }>("select api_shop_get($1) as r", [hash(raw)])).rows[0]!.r);
    expect(r["headless"]).toEqual({ return_origins: ["https://wp.example.com"], relay_ips: ["203.0.113.1"], order_page_url: "https://wp.example.com/order/", account_page_url: "https://wp.example.com/my/", legal_links: { legal: "https://wp.example.com/legal/" } });
    expect(r["storefront"]).toEqual({ mode: "off", site_url: "https://wp.example.com/", product_url: null });
  });

  it("試着のお知らせの材料に storefront が入る", async () => {
    const pool = getPool();
    const store = (await pool.query<{ id: string }>("insert into stores (org_id, name) select org_id, '本店' from shops where id = $1 returning id", [a.shopId])).rows[0]!.id;
    const req = (await pool.query<{ id: string }>("insert into tryon_requests (shop_id, store_id, number, customer_email, customer_name) values ($1, $2, 1, 't@example.com', '試着') returning id", [a.shopId, store])).rows[0]!.id;
    const r = await asService(async (c) => (await c.query<{ r: { shop: J } }>("select tryon_contact($1, $2) as r", [req, a.shopId])).rows[0]!.r);
    expect(r.shop["storefront"]).toEqual({ mode: "off", site_url: "https://wp.example.com/" });
  });
});
