import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const ALL_SCOPES = ["products:read", "products:write", "orders:read", "orders:pii", "orders:write", "shop:read", "shop:write", "stats:read"];

function makeToken(): { raw: string; hash: string } {
  const raw = `banto_${randomBytes(32).toString("base64url")}`;
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
}

describe.skipIf(!dbAvailable)("AI 用トークンと api_* RPC（0003_api）", () => {
  let a: Fixture;
  let b: Fixture;
  let full: { raw: string; hash: string };
  let readOnly: { raw: string; hash: string };
  let bToken: { raw: string; hash: string };

  async function issue(f: Fixture, scopes: string[], extra: Record<string, unknown> = {}) {
    const t = makeToken();
    await asUser(f.ownerId, (c) =>
      c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes, expires_at, revoked_at) values ($1, $2, 'test', $3, $4, $5, $6, $7)", [
        f.shopId,
        f.ownerId,
        t.hash,
        t.raw.slice(0, 12),
        scopes,
        extra["expires_at"] ?? null,
        extra["revoked_at"] ?? null,
      ]),
    );
    return t;
  }
  const rpc = <T = unknown>(fn: string, args: unknown[]) =>
    asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "a@example.com", slug: "shop-a", publish: true, stock: 5 });
    b = await createShopFixture({ email: "b@example.com", slug: "shop-b", publish: true, stock: 5 });
    full = await issue(a, ALL_SCOPES);
    readOnly = await issue(a, ["products:read", "orders:read", "stats:read", "shop:read"]);
    bToken = await issue(b, ALL_SCOPES);
  });
  afterAll(closePool);

  describe("トークンの検証", () => {
    it("RLS: owner は自ショップのトークンだけ管理でき、他人の shop には発行できない", async () => {
      await asUser(a.ownerId, async (c) => {
        const r = await c.query("select count(*)::int as n from api_tokens");
        expect(r.rows[0].n).toBe(2);
      });
      const t = makeToken();
      const msg = await expectDbError(() =>
        asUser(b.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 'x', $3, 'banto_xx', '{products:read}')", [a.shopId, b.ownerId, t.hash])),
      );
      expect(msg).toMatch(/row-level security|scope_not_permitted/);
      const bad = await expectDbError(() =>
        asUser(a.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 'x', $3, 'banto_xx', '{admin:all}')", [a.shopId, a.ownerId, makeToken().hash])),
      );
      expect(bad).toMatch(/api_tokens_scopes_valid/);
      await asAnon(async (c) => {
        const r = await c.query("select count(*)::int as n from api_tokens");
        expect(r.rows[0].n).toBe(0);
      });
    });

    it("存在しない・失効・期限切れ・スコープ不足はすべて同じ unauthorized", async () => {
      const revoked = await issue(a, ALL_SCOPES, { revoked_at: new Date().toISOString() });
      const expired = await issue(a, ALL_SCOPES, { expires_at: new Date(Date.now() - 1000).toISOString() });
      for (const h of [makeToken().hash, revoked.hash, expired.hash]) {
        const msg = await expectDbError(() => rpc("api_shop_get", [h]));
        expect(msg).toMatch(/unauthorized/);
      }
      const noScope = await expectDbError(() => rpc("api_product_create", [readOnly.hash, { slug: "x", name: "x" }]));
      expect(noScope).toMatch(/unauthorized/);
      // 生トークンをそのまま渡しても通らない（ハッシュのみ）
      const raw = await expectDbError(() => rpc("api_shop_get", [full.raw]));
      expect(raw).toMatch(/unauthorized/);
    });

    it("api_* は service_role 専用。owner や anon からは呼べない", async () => {
      for (const run of [() => asUser(a.ownerId, (c) => c.query("select api_shop_get($1)", [full.hash])), () => asAnon((c) => c.query("select api_shop_get($1)", [full.hash]))]) {
        expect(await expectDbError(run)).toMatch(/permission denied/);
      }
    });

    it("last_used_at が更新される", async () => {
      await rpc("api_shop_get", [full.hash]);
      const r = await getPool().query("select last_used_at from api_tokens where token_hash = $1", [full.hash]);
      expect(r.rows[0].last_used_at).not.toBeNull();
    });
  });

  describe("ショップ", () => {
    it("参照・更新。公開には法務3項目が要る。settings 全体や stripe は触れない", async () => {
      const shop = (await rpc<Record<string, unknown>>("api_shop_get", [full.hash]))!;
      expect(shop).toMatchObject({ slug: "shop-a", published: true, low_stock_threshold: 3, stripe_connected: false });
      expect(shop).not.toHaveProperty("settings");
      const updated = await rpc<Record<string, unknown>>("api_shop_update", [full.hash, { name: "新店名", low_stock_threshold: 10, stripe_account_id: "acct_evil" }]);
      expect(updated).toMatchObject({ name: "新店名", low_stock_threshold: 10, stripe_connected: false, max_pending_per_ip: 20, login_per_ip_per_hour: 30 });
      // 0033: IP ごとの上限。settings の同じ節のほかの値は残る
      await getPool().query("update shops set settings = settings || '{\"checkout\": {\"max_pending_per_customer\": \"5\"}}' where id = $1", [a.shopId]);
      const limits = await rpc<Record<string, unknown>>("api_shop_update", [full.hash, { max_pending_per_ip: 200, login_per_ip_per_hour: "500" }]);
      expect(limits).toMatchObject({ max_pending_per_ip: 200, login_per_ip_per_hour: 500 });
      expect((await getPool().query("select settings->'checkout' as c, settings->'members_login_limits' as m from shops where id = $1", [a.shopId])).rows[0]).toEqual({ c: { max_pending_per_customer: "5", max_pending_per_ip: 200 }, m: { per_ip_per_hour: 500 } });
      expect(await expectDbError(() => rpc("api_shop_update", [full.hash, { max_pending_per_ip: 0 }]))).toMatch(/invalid_max_pending_per_ip/);
      expect(await expectDbError(() => rpc("api_shop_update", [full.hash, { login_per_ip_per_hour: 10000 }]))).toMatch(/invalid_login_per_ip_per_hour/);
      const msg = await expectDbError(() => rpc("api_shop_update", [full.hash, { legal_notice: "", published: true }]));
      expect(msg).toMatch(/shops_publish_requires_legal/);
      expect(await expectDbError(() => rpc("api_shop_update", [readOnly.hash, { name: "x" }]))).toMatch(/unauthorized/);
    });

    it("購入前の確認画面の文言（checkout_terms）: 渡した鍵だけ変え、null か空文字で消す。ほかの settings は触らない", async () => {
      const before = (await getPool().query("select settings from shops where slug = 'shop-a'")).rows[0].settings as Record<string, unknown>;
      let shop = (await rpc<Record<string, unknown>>("api_shop_get", [full.hash]))!;
      expect(shop["checkout_terms"]).toEqual({ delivery: null, cancellation: null, payment_note: null });

      shop = (await rpc<Record<string, unknown>>("api_shop_update", [full.hash, { checkout_terms: { delivery: " 3 営業日以内に発送します。\r\n2 行目 ", cancellation: "キャンセル不可", other: "無視" } }]))!;
      expect(shop["checkout_terms"]).toEqual({ delivery: "3 営業日以内に発送します。\n2 行目", cancellation: "キャンセル不可", payment_note: null });
      shop = (await rpc<Record<string, unknown>>("api_shop_update", [full.hash, { checkout_terms: { cancellation: null, payment_note: "振込は 7 日以内" } }]))!;
      expect(shop["checkout_terms"]).toEqual({ delivery: "3 営業日以内に発送します。\n2 行目", cancellation: null, payment_note: "振込は 7 日以内" });
      shop = (await rpc<Record<string, unknown>>("api_shop_update", [full.hash, { checkout_terms: { payment_note: "  " } }]))!;
      expect((shop["checkout_terms"] as Record<string, unknown>)["payment_note"]).toBeNull();

      const after = (await getPool().query("select settings from shops where slug = 'shop-a'")).rows[0].settings as Record<string, unknown>;
      expect(after["checkout_terms"]).toEqual({ delivery: "3 営業日以内に発送します。\n2 行目", cancellation: "", payment_note: "" });
      expect({ ...after, checkout_terms: null }).toEqual({ ...before, checkout_terms: null });

      for (const bad of [{ checkout_terms: "x" }, { checkout_terms: { delivery: 1 } }, { checkout_terms: { delivery: "x".repeat(2001) } }]) {
        expect(await expectDbError(() => rpc("api_shop_update", [full.hash, bad]))).toMatch(/invalid_checkout_terms/);
      }
      expect(await expectDbError(() => rpc("api_shop_update", [readOnly.hash, { checkout_terms: { delivery: "x" } }]))).toMatch(/unauthorized/);
      await getPool().query("update shops set settings = $1 where slug = 'shop-a'", [before]);
    });
  });

  describe("商品・SKU・画像", () => {
    let productId: string;
    it("作成 → 一覧/検索 → 更新 → SKU → 画像。他ショップのトークンからは見えない", async () => {
      const created = await rpc<Record<string, unknown>>("api_product_create", [full.hash, { slug: "mug", name: "マグカップ", description: "  陶器  " }]);
      productId = created!["id"] as string;
      expect(created).toMatchObject({ slug: "mug", name: "マグカップ", description: "陶器", published: false, skus: [], images: [] });
      const hooks = await getPool().query("select event from hook_deliveries");
      void hooks; // 送信先が無いので 0 件でよい

      const list = await rpc<{ items: Record<string, unknown>[]; total: number }>("api_products_list", [full.hash, "マグ", null, 10, 0]);
      expect(list!.total).toBe(1);
      expect(list!.items[0]!["slug"]).toBe("mug");
      const all = await rpc<{ total: number }>("api_products_list", [full.hash, null, null, 500, 0]);
      expect(all!.total).toBe(2); // fixture の tee + mug

      // 他ショップのトークンでは not_found / 一覧にも出ない
      expect(await expectDbError(() => rpc("api_product_get", [bToken.hash, productId, null]))).toMatch(/not_found/);
      const bList = await rpc<{ items: { slug: string }[] }>("api_products_list", [bToken.hash, "mug", null, 10, 0]);
      expect(bList!.items).toHaveLength(0);
      expect(await expectDbError(() => rpc("api_product_update", [bToken.hash, productId, { name: "乗っ取り" }]))).toMatch(/not_found/);

      const updated = await rpc<Record<string, unknown>>("api_product_update", [full.hash, productId, { published: true, description: "" }]);
      expect(updated).toMatchObject({ published: true, description: null });
      const bySlug = await rpc<Record<string, unknown>>("api_product_get", [full.hash, null, "mug"]);
      expect(bySlug!["id"]).toBe(productId);

      const withSku = await rpc<{ skus: Record<string, unknown>[] }>("api_sku_create", [full.hash, productId, { code: "MUG-W", name: "白", price_jpy: 1500, available: 7 }]);
      expect(withSku!.skus[0]).toMatchObject({ code: "MUG-W", price_jpy: 1500, available: 7 });
      const skuId = withSku!.skus[0]!["id"] as string;
      const afterUpdate = await rpc<{ skus: Record<string, unknown>[] }>("api_sku_update", [full.hash, skuId, { price_jpy: 1800, available: 0 }]);
      expect(afterUpdate!.skus[0]).toMatchObject({ price_jpy: 1800, available: 0 });
      expect(await expectDbError(() => rpc("api_sku_update", [full.hash, skuId, { available: -1 }]))).toMatch(/invalid_available/);
      expect(await expectDbError(() => rpc("api_sku_update", [bToken.hash, skuId, { price_jpy: 1 }]))).toMatch(/not_found/);
      expect(await expectDbError(() => rpc("api_sku_create", [full.hash, productId, { code: "MUG-W", price_jpy: 1 }]))).toMatch(/duplicate key/);

      // 画像: storage_key は自ショップの接頭辞のみ
      const img = await rpc<{ images: Record<string, unknown>[] }>("api_image_add", [full.hash, productId, `shops/${a.shopId}/products/${productId}/abc.png`, null]);
      expect(img!.images[0]).toMatchObject({ sort_order: 0 });
      expect(await expectDbError(() => rpc("api_image_add", [full.hash, productId, `shops/${b.shopId}/x.png`, null]))).toMatch(/invalid_storage_key/);
      const keys = await rpc<{ storage_key: string; thumb_key: string | null }>("api_image_delete", [full.hash, img!.images[0]!["id"]]);
      const key = keys!.storage_key;
      expect(keys!.thumb_key).toBeNull();
      expect(key).toBe(`shops/${a.shopId}/products/${productId}/abc.png`);
      expect(await expectDbError(() => rpc("api_image_delete", [full.hash, img!.images[0]!["id"]]))).toMatch(/not_found/);

      const afterDelete = await rpc<{ skus: unknown[] }>("api_sku_delete", [full.hash, skuId]);
      expect(afterDelete!.skus).toHaveLength(0);
    });
  });

  describe("注文・集計", () => {
    const paidOrder = async (f: Fixture, qty: number, email: string) => {
      const resId = await asService(async (c) => (await c.query<{ id: string }>("select reserve_stock($1, $2::jsonb) as id", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty }])])).rows[0]!.id);
      return asService(async (c) =>
        (await c.query<{ id: string }>("select confirm_reservation($1, $2, $3::jsonb) as id", [resId, f.shopId, JSON.stringify({ customer_email: email, customer_name: "山田 太郎", shipping_address: { state: "東京都", line1: "秘密の住所" }, payment_provider: "stripe", payment_ref: "pi" })])).rows[0]!.id,
      );
    };

    it("orders:read は個人情報をマスクし、orders:pii で含める。他ショップは見えない", async () => {
      await getPool().query("update inventory set available = 50");
      const o1 = await paidOrder(a, 2, "buyer@example.com");
      await paidOrder(b, 1, "other@example.com");

      const masked = await rpc<{ items: Record<string, unknown>[]; total: number; pii: boolean }>("api_orders_list", [readOnly.hash, null, null, null, 50, 0]);
      expect(masked!.total).toBe(1);
      expect(masked!.pii).toBe(false);
      expect(masked!.items[0]!["customer"]).toEqual({ masked: true, prefecture: "東京都" });
      expect(JSON.stringify(masked)).not.toContain("buyer@example.com");
      expect(JSON.stringify(masked)).not.toContain("秘密の住所");
      expect(masked!.items[0]!["items"]).toEqual([expect.objectContaining({ qty: 2, unit_price_jpy: 3000, sku_code: "TEE-M" })]);

      const withPii = await rpc<{ items: Record<string, unknown>[] }>("api_orders_list", [full.hash, null, null, null, 50, 0]);
      expect(withPii!.items[0]!["customer"]).toEqual({ email: "buyer@example.com", name: "山田 太郎", shipping_address: { state: "東京都", line1: "秘密の住所" } });

      expect(await expectDbError(() => rpc("api_order_get", [bToken.hash, o1]))).toMatch(/not_found/);

      // 発送済みにする（orders:write）。再度は not_found（paid のみ対象）
      const shipped = await rpc<Record<string, unknown>>("api_order_update_status", [full.hash, o1, "shipped"]);
      expect(shipped).toMatchObject({ status: "shipped" });
      expect(shipped!["shipped_at"]).toBeTruthy();
      expect(await expectDbError(() => rpc("api_order_update_status", [full.hash, o1, "shipped"]))).toMatch(/not_found/);
      expect(await expectDbError(() => rpc("api_order_update_status", [full.hash, o1, "refunded"]))).toMatch(/invalid_status/);
      expect(await expectDbError(() => rpc("api_order_update_status", [full.hash, o1, "cancelled"]))).toMatch(/invalid_status/); // キャンセルは api_order_cancel
      expect(await expectDbError(() => rpc("api_order_cancel", [readOnly.hash, o1, false]))).toMatch(/unauthorized/);
    });

    it("売上集計: day / month / product。キャンセルは除外。owner RPC は他人のショップを拒否", async () => {
      const o2 = await paidOrder(a, 1, "c@example.com");
      await rpc("api_order_cancel", [full.hash, o2, false]);
      await paidOrder(a, 3, "d@example.com");
      const from = new Date(Date.now() - 86400_000).toISOString();
      const to = new Date(Date.now() + 86400_000).toISOString();

      const day = await rpc<{ total: Record<string, number>; rows: Record<string, unknown>[] }>("api_sales_summary", [full.hash, from, to, "day"]);
      expect(day!.total).toMatchObject({ orders: 2, revenue_jpy: 15000, items: 5, avg_order_jpy: 7500 });
      expect(day!.rows).toHaveLength(1);
      expect(day!.rows[0]).toMatchObject({ orders: 2, revenue_jpy: 15000 });
      expect(day!.rows[0]!["period"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const product = await rpc<{ rows: Record<string, unknown>[] }>("api_sales_summary", [full.hash, from, to, "product"]);
      expect(product!.rows).toEqual([expect.objectContaining({ sku_code: "TEE-M", qty: 5, revenue_jpy: 15000 })]);
      expect(await expectDbError(() => rpc("api_sales_summary", [full.hash, from, to, "week"]))).toMatch(/invalid_group_by/);

      const owner = await asUser(a.ownerId, async (c) => (await c.query<{ r: { total: { orders: number } } }>("select sales_summary($1, $2, $3, 'month') as r", [a.shopId, from, to])).rows[0]!.r);
      expect(owner.total.orders).toBe(2);
      expect(await expectDbError(() => asUser(b.ownerId, (c) => c.query("select sales_summary($1, $2, $3, 'day')", [a.shopId, from, to])))).toMatch(/shop_not_found/);
      expect(await expectDbError(() => asAnon((c) => c.query("select sales_summary($1, $2, $3, 'day')", [a.shopId, from, to])))).toMatch(/permission denied/);
    });

    it("注文履歴のある SKU は削除できない（外部キー）", async () => {
      expect(await expectDbError(() => rpc("api_sku_delete", [full.hash, a.skuId]))).toMatch(/foreign key/);
    });

    it("在庫僅少一覧", async () => {
      await getPool().query("update inventory set available = 2 where sku_id = $1", [a.skuId]);
      const low = await rpc<Record<string, unknown>[]>("api_inventory_low", [full.hash, null]);
      expect(low).toEqual([expect.objectContaining({ sku_code: "TEE-M", available: 2 })]);
      const none = await rpc<unknown[]>("api_inventory_low", [full.hash, 1]);
      expect(none).toEqual([]);
      const bLow = await rpc<unknown[]>("api_inventory_low", [bToken.hash, 100]);
      expect(bLow).toHaveLength(1); // b のショップだけ
    });
  });
});
