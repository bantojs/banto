import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type Shop = Record<string, unknown>;

/**
 * 0143_shop_columns: ショップを扱う人に見える shops の列。
 * - authenticated は stripe_account_id・連番・legal_links_state を PostgREST から直接は読めない（owner も。管理画面は banto_admin_shop）
 * - banto_admin_shop: owner には全部。member には、決済の接続先は settings / integrations / orders_cancel、法務のリンクは integrations の人にだけ。連番は返さない
 * - 行そのものは見えたまま（商品の公開のポリシーが shops を読む）。書き込みは今までどおり
 */
describe.skipIf(!dbAvailable)("ショップを扱う人に見える列（0143_shop_columns）", () => {
  let f: Fixture;
  let orgId: string;
  const HIDDEN = ["stripe_account_id", "order_seq", "tryon_seq", "inquiry_seq", "legal_links_state"];

  const invite = async (email: string, perms: string[]) => {
    const uid = await createAuthUser(email);
    await asUser(f.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, email, JSON.stringify([{ shop_id: f.shopId, perms }]), hash(`t-${email}`)]));
    await withRole("authenticated", { sub: uid, email }, (c) => c.query("select org_invitation_accept($1)", [hash(`t-${email}`)]));
    return uid;
  };
  const adminShop = async (uid: string) => (await asUser(uid, (c) => c.query<{ r: { shop: Shop; role: string; perms: string[] } | null }>("select banto_admin_shop($1) as r", [f.shopId]))).rows[0]!.r;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "sc-owner@example.com", slug: "sc-shop", publish: true, stock: 5 });
    orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    await getPool().query("update shops set stripe_account_id = 'acct_secret' where id = $1", [f.shopId]);
  });
  afterAll(closePool);

  it("PostgREST から直接は、だれも決済の接続先・連番・法務のリンクの確認の結果を読めない。ほかの列と行は見えたまま", async () => {
    const catalog = await invite("sc-catalog@example.com", ["catalog"]);
    for (const uid of [f.ownerId, catalog]) {
      for (const col of HIDDEN) expect(await expectDbError(() => asUser(uid, (c) => c.query(`select ${col} from shops where id = $1`, [f.shopId]))), col).toMatch(/permission denied/);
      expect(await expectDbError(() => asUser(uid, (c) => c.query("select * from shops where id = $1", [f.shopId])))).toMatch(/permission denied/);
      const row = (await asUser(uid, (c) => c.query<{ id: string; published: boolean }>("select id, slug, name, published, settings, domain from shops where id = $1", [f.shopId]))).rows[0]!;
      expect(row).toMatchObject({ id: f.shopId, published: true });
    }
    // 商品の公開のポリシーは shops を呼び手の権限で読む。member の商品の読み取りは今までどおり
    expect((await asUser(catalog, (c) => c.query("select id from products where shop_id = $1", [f.shopId]))).rowCount).toBeGreaterThan(0);
  });

  it("banto_admin_shop: owner には全部。member には項目に合う列だけ（連番は返さない）", async () => {
    const owner = await adminShop(f.ownerId);
    expect(owner!.shop).toMatchObject({ stripe_account_id: "acct_secret", order_seq: expect.any(Number) });
    const cases: [string, string[], boolean, boolean][] = [
      ["sc-catalog2@example.com", ["catalog"], false, false],
      ["sc-orders@example.com", ["orders"], false, false],
      ["sc-cancel@example.com", ["orders", "orders_cancel"], true, false],
      ["sc-settings@example.com", ["settings"], true, false],
      ["sc-integ@example.com", ["integrations"], true, true],
    ];
    for (const [email, perms, stripe, legal] of cases) {
      const r = await adminShop(await invite(email, perms));
      expect(r!.role, email).toBe("member");
      expect("stripe_account_id" in r!.shop, email).toBe(stripe);
      expect("legal_links_state" in r!.shop, email).toBe(legal);
      for (const seq of ["order_seq", "tryon_seq", "inquiry_seq"]) expect(seq in r!.shop, `${email} ${seq}`).toBe(false);
      expect(r!.shop).toMatchObject({ id: f.shopId, slug: "sc-shop", settings: expect.any(Object) });
    }
    // ほかの組織の人には何も返さない
    const other = await createShopFixture({ email: "sc-other@example.com", slug: "sc-other", publish: true, stock: 1 });
    expect(await adminShop(other.ownerId)).toBeNull();
  });

  it("書き込みは今までどおり: owner は決済の接続先を書け、settings の人は settings を書ける（返す列を絞れば結果も読める）", async () => {
    const r = await asUser(f.ownerId, (c) => c.query<{ id: string }>("update shops set stripe_account_id = 'acct_new' where id = $1 returning id", [f.shopId]));
    expect(r.rows).toEqual([{ id: f.shopId }]);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update shops set name = name where id = $1 returning *", [f.shopId])))).toMatch(/permission denied/);
    const settings = await invite("sc-settings2@example.com", ["settings"]);
    const u = await asUser(settings, (c) => c.query<{ id: string }>("update shops set settings = settings || '{\"shipping\":{\"mode\":\"flat\",\"flat_fee_jpy\":500}}'::jsonb where id = $1 returning id", [f.shopId]));
    expect(u.rowCount).toBe(1);
    const created = await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into shops (owner_id, slug, name) values ($1, 'sc-second', '2 号店') returning id", [f.ownerId]));
    expect(created.rowCount).toBe(1);
  });
});
