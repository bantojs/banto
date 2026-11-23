import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** 0165: 注文は会員だけ。reserve_stock が会員でない予約を断る（お店の画面・ヘッドレス・どの支払い方法も通る一本道） */
describe.skipIf(!dbAvailable)("注文は会員だけ（0165）", () => {
  let f: Fixture;
  let customerId: string;
  const reserve = (customer: string | null) =>
    asService(async (c) => (await c.query<{ r: string }>("select reserve_stock($1, $2, 900, null, null, null, $3) as r", [f.shopId, JSON.stringify([{ sku_id: f.skuId, qty: 1 }]), customer])).rows[0]!.r);
  const settings = (s: Record<string, unknown>) => getPool().query("update shops set settings = settings || $2::jsonb where id = $1", [f.shopId, JSON.stringify(s)]);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "mo-owner@example.com", slug: "mo-shop", publish: true, stock: 10 });
    customerId = (await getPool().query<{ id: string }>("insert into customers (shop_id, email) values ($1, 'm@example.com') returning id", [f.shopId])).rows[0]!.id;
  });
  afterAll(closePool);

  it("会員機能が ON で checkout_members_only が true なら、会員でない予約を member_required で断る。会員は予約できる", async () => {
    await settings({ members_enabled: true, checkout_members_only: true });
    expect(await expectDbError(() => reserve(null))).toMatch(/member_required/);
    expect(await reserve(customerId)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("会員機能が OFF・設定が文字の true・設定が無いときはゲストも予約できる（今までどおり）", async () => {
    for (const s of [{ members_enabled: false, checkout_members_only: true }, { members_enabled: true, checkout_members_only: "true" }, { members_enabled: true, checkout_members_only: false }]) {
      await settings(s);
      expect([s, typeof (await reserve(null))]).toEqual([s, "string"]);
    }
  });

  it("お客様の画面に渡す settings に載る。設定の鍵は owner / admin の項目", async () => {
    await settings({ members_enabled: true, checkout_members_only: true });
    const slug = (await getPool().query<{ slug: string }>("select slug from shops where id = $1", [f.shopId])).rows[0]!.slug;
    const shop = await asAnon(async (c) => (await c.query<{ r: { settings: Record<string, unknown> } }>("select shop_public_get($1) as r", [slug])).rows[0]!.r);
    expect(shop.settings["checkout_members_only"]).toBe(true);
    expect((await getPool().query<{ p: string }>("select banto_shop_settings_perm('checkout_members_only', null) as p")).rows[0]!.p).toBe("admin");
  });
});
