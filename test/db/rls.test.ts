import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asAnon,
  asService,
  asUser,
  closePool,
  createAuthUser,
  createShopFixture,
  dbAvailable,
  expectDbError,
  getPool,
  resetDatabase,
  type Fixture,
} from "./harness";

describe.skipIf(!dbAvailable)("RLS（CLAUDE.md §3）", () => {
  let a: Fixture; // owner A: 公開ショップ
  let b: Fixture; // owner B: 非公開ショップ

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "a@example.com", slug: "shop-a", publish: true, stock: 5 });
    // owner の自己登録ゲートを迂回して2人目を作る（マルチ owner 時代の隔離テストのため）
    const bId = await createAuthUser("b@example.com");
    await getPool().query("insert into owners (id) values ($1)", [bId]);
    b = await asUser(bId, async (c) => {
      const shop = await c.query<{ id: string }>(
        "insert into shops (owner_id, slug, name) values ($1, 'shop-b', 'Shop B') returning id",
        [bId],
      );
      const shopId = shop.rows[0]!.id;
      const product = await c.query<{ id: string }>(
        "insert into products (shop_id, slug, name) values ($1, 'hidden', '非公開') returning id",
        [shopId],
      );
      const sku = await c.query<{ id: string }>(
        "insert into skus (shop_id, product_id, code, price_jpy) values ($1, $2, 'HID-1', 100) returning id",
        [shopId, product.rows[0]!.id],
      );
      return { ownerId: bId, shopId, productId: product.rows[0]!.id, skuId: sku.rows[0]!.id };
    });
  });

  afterAll(closePool);

  describe("owner の自己登録", () => {
    it("owner が既にいる場合、別の認証ユーザーは owners に insert できない", async () => {
      const intruder = await createAuthUser("intruder@example.com");
      const msg = await expectDbError(() =>
        asUser(intruder, (c) => c.query("insert into owners (id) values ($1)", [intruder])),
      );
      expect(msg).toMatch(/row-level security/);
    });

    it("他人の uid で owners に insert できない", async () => {
      const someone = await createAuthUser("someone@example.com");
      const other = await createAuthUser("other@example.com");
      const msg = await expectDbError(() =>
        asUser(someone, (c) => c.query("insert into owners (id) values ($1)", [other])),
      );
      expect(msg).toMatch(/row-level security/);
    });
  });

  describe("ストアフロント（anon）", () => {
    it("published なショップ・商品・SKU・在庫だけ見える", async () => {
      await asAnon(async (c) => {
        const shops = await c.query<{ slug: string }>("select slug from shops order by slug");
        expect(shops.rows.map((r) => r.slug)).toEqual(["shop-a"]);
        const products = await c.query("select id from products");
        expect(products.rows.map((r) => r.id)).toEqual([a.productId]);
        const skus = await c.query("select id from skus");
        expect(skus.rows.map((r) => r.id)).toEqual([a.skuId]);
        const inv = await c.query<{ available: number }>("select available from inventory");
        expect(inv.rows).toEqual([{ available: 5 }]);
      });
    });

    it("注文・予約・Webhook イベント・owners は一切見えない", async () => {
      await asAnon(async (c) => {
        for (const table of ["order_items", "reservations", "webhook_events", "owners", "banto_migrations"]) {
          const r = await c.query(`select count(*)::int as n from ${table}`);
          expect(r.rows[0].n, table).toBe(0);
        }
      });
      // 0028: 注文と会員は anon から表そのものを読めない（ポリシー以前に権限が無い）
      for (const table of ["orders", "customers"]) {
        expect(await expectDbError(() => asAnon((c) => c.query(`select count(*) from ${table}`))), table).toMatch(/permission denied/);
      }
    });

    it("UPDATE はできない（0055 からは表の権限で拒まれる）", async () => {
      expect(await expectDbError(() => asAnon((c) => c.query("update products set name = 'hacked' where id = $1", [a.productId])))).toMatch(/permission denied/);
      const r = await getPool().query<{ name: string }>("select name from products where id = $1", [a.productId]);
      expect(r.rows[0]!.name).toBe("Tシャツ");
    });

    it("在庫 RPC を呼べない", async () => {
      const msg = await expectDbError(() =>
        asAnon((c) => c.query("select reserve_stock($1, $2::jsonb)", [a.shopId, JSON.stringify([{ sku_id: a.skuId, qty: 1 }])])),
      );
      expect(msg).toMatch(/permission denied/);
    });

    it("inventory を直接 UPDATE できない（ポリシーなし）", async () => {
      await asAnon(async (c) => {
        const r = await c.query("update inventory set available = 999 where sku_id = $1", [a.skuId]);
        expect(r.rowCount).toBe(0);
      });
    });
  });

  describe("管理画面（authenticated owner）", () => {
    it("自分のショップ配下だけ見える", async () => {
      await asUser(a.ownerId, async (c) => {
        const shops = await c.query<{ slug: string }>("select slug from shops order by slug");
        expect(shops.rows.map((r) => r.slug)).toEqual(["shop-a"]);
      });
      await asUser(b.ownerId, async (c) => {
        const shops = await c.query<{ slug: string }>("select slug from shops order by slug");
        // 自分の非公開ショップだけ。他人の公開ショップは anon の経路（shops_public は anon のみ、0028）でしか見えない
        expect(shops.rows.map((r) => r.slug)).toEqual(["shop-b"]);
        const products = await c.query<{ id: string }>("select id from products where shop_id = $1", [b.shopId]);
        expect(products.rows).toHaveLength(1);
      });
    });

    it("他人のショップに商品を追加できない", async () => {
      const msg = await expectDbError(() =>
        asUser(b.ownerId, (c) =>
          c.query("insert into products (shop_id, slug, name) values ($1, 'evil', 'evil')", [a.shopId]),
        ),
      );
      expect(msg).toMatch(/row-level security/);
    });

    it("他人のショップの商品を更新できない（0 行）", async () => {
      await asUser(b.ownerId, async (c) => {
        const r = await c.query("update products set published = false where id = $1", [a.productId]);
        expect(r.rowCount).toBe(0);
      });
    });

    it("他人の SKU の在庫を set_stock できない", async () => {
      const msg = await expectDbError(() => asUser(b.ownerId, (c) => c.query("select set_stock($1, 100)", [a.skuId])));
      expect(msg).toMatch(/sku_not_found/);
      const r = await getPool().query<{ available: number }>("select available from inventory where sku_id = $1", [a.skuId]);
      expect(r.rows[0]!.available).toBe(5);
    });

    it("自分の SKU の在庫は set_stock で変えられ、直接 UPDATE はできない", async () => {
      await asUser(a.ownerId, async (c) => {
        await c.query("select set_stock($1, 7)", [a.skuId]);
        const direct = await c.query("update inventory set available = 999 where sku_id = $1", [a.skuId]);
        expect(direct.rowCount).toBe(0);
        const r = await c.query<{ available: number }>("select available from inventory where sku_id = $1", [a.skuId]);
        expect(r.rows[0]!.available).toBe(7);
        await c.query("select set_stock($1, 5)", [a.skuId]);
      });
    });

    it("service_role 専用 RPC は owner からも呼べない", async () => {
      const msg = await expectDbError(() =>
        asUser(a.ownerId, (c) =>
          c.query("select reserve_stock($1, $2::jsonb)", [a.shopId, JSON.stringify([{ sku_id: a.skuId, qty: 1 }])]),
        ),
      );
      expect(msg).toMatch(/permission denied/);
    });

    it("SKU を作ると在庫行が自動生成される", async () => {
      await asUser(a.ownerId, async (c) => {
        const sku = await c.query<{ id: string }>(
          "insert into skus (shop_id, product_id, code, price_jpy) values ($1, $2, 'TEE-L', 3000) returning id",
          [a.shopId, a.productId],
        );
        const inv = await c.query<{ available: number }>("select available from inventory where sku_id = $1", [sku.rows[0]!.id]);
        expect(inv.rows).toEqual([{ available: 0 }]);
      });
    });

    it("webhook_events と banto_migrations: owner は migrations だけ読める", async () => {
      await asUser(a.ownerId, async (c) => {
        const wh = await c.query("select count(*)::int as n from webhook_events");
        expect(wh.rows[0].n).toBe(0);
        const mig = await c.query<{ version: string }>("select version from banto_migrations");
        expect(mig.rows.map((r) => r.version)).toContain("0001_init");
      });
    });
  });

  describe("公開前チェック（CLAUDE.md §9）", () => {
    it("特商法表記・プライバシーポリシー・返品ポリシーが空のままでは公開できない", async () => {
      const msg = await expectDbError(() =>
        asUser(b.ownerId, (c) => c.query("update shops set published = true where id = $1", [b.shopId])),
      );
      expect(msg).toMatch(/shops_publish_requires_legal/);
    });

    it("3項目を埋めれば公開できる", async () => {
      await asUser(b.ownerId, async (c) => {
        await c.query(
          `update shops set legal_notice = '表記', privacy_policy = 'PP', return_policy = 'RP', published = true where id = $1`,
          [b.shopId],
        );
        await c.query("update shops set published = false where id = $1", [b.shopId]);
      });
    });
  });

  describe("service_role", () => {
    it("RLS を素通りする（RPC 内で shop_id を検証する前提）", async () => {
      await asService(async (c) => {
        const r = await c.query<{ n: number }>("select count(*)::int as n from shops");
        expect(r.rows[0]!.n).toBe(2);
      });
    });
  });
});
