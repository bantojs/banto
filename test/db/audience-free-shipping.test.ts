import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

type J = Record<string, unknown>;

/**
 * 0171_audience_free_shipping: 会員の条件ごとの送料無料の金額。会員が条件に合うかは DB の最新の独自項目と banto_audience_ok で決め、
 * いちばん低い金額を返す（送料の計算は Worker の shipping.ts）
 */
describe.skipIf(!dbAvailable)("会員の条件ごとの送料無料（0171）", () => {
  let f: Fixture;
  let other: Fixture;
  const ids: Record<string, string> = {};
  const setSettings = (shopId: string, s: J) => getPool().query("update shops set settings = settings || $2::jsonb where id = $1", [shopId, JSON.stringify(s)]);
  const over = (shopId: string, customerId: string) => asService(async (c) => (await c.query<{ v: number | null }>("select member_free_shipping_over($1, $2) as v", [shopId, customerId])).rows[0]!.v);
  const customer = async (shopId: string, email: string, attrs: J) => (await getPool().query<{ id: string }>("insert into customers (shop_id, email, attributes) values ($1, $2, $3::jsonb) returning id", [shopId, email, JSON.stringify(attrs)])).rows[0]!.id;
  const audience = async (shopId: string, name: string, condition: J) => (await getPool().query<{ id: string }>("insert into audiences (shop_id, name, condition) values ($1, $2, $3::jsonb) returning id", [shopId, name, JSON.stringify(condition)])).rows[0]!.id;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "afs-owner@example.com", slug: "afs-shop", publish: true });
    other = await createShopFixture({ email: "afs-other@example.com", slug: "afs-other", publish: true });
    const fields = { customer_fields: [{ key: "rank", label: "ランク", type: "select", options: ["gold", "silver", "regular"] }] };
    await setSettings(f.shopId, { ...fields, modules: { audiences: true } });
    await setSettings(other.shopId, { ...fields, modules: { audiences: true } });
    ids["gold"] = await audience(f.shopId, "ゴールド", { all: [{ member: true }, { attr: "rank", in: ["gold"] }] });
    ids["silver"] = await audience(f.shopId, "シルバー", { attr: "rank", in: ["silver", "gold"] });
    ids["param"] = await audience(f.shopId, "広告から", { param: "utm", in: ["ad"] });
    ids["otherGold"] = await audience(other.shopId, "ゴールド", { attr: "rank", in: ["gold"] });
    ids["cGold"] = await customer(f.shopId, "g@example.com", { rank: "gold" });
    ids["cSilver"] = await customer(f.shopId, "s@example.com", { rank: "silver" });
    ids["cRegular"] = await customer(f.shopId, "r@example.com", { rank: "regular" });
    await setSettings(f.shopId, {
      shipping: {
        mode: "flat", flat_fee_jpy: 800, free_over_jpy: null, by_prefecture: {},
        free_over_by_audience: [
          { audience_id: ids["silver"], free_over_jpy: 3000 },
          { audience_id: ids["gold"], free_over_jpy: 0, label: "ゴールド会員" },
          { audience_id: ids["param"], free_over_jpy: 0 },
          { audience_id: ids["otherGold"], free_over_jpy: 0 },
          { audience_id: "00000000-0000-4000-8000-000000000000", free_over_jpy: 0 },
          { audience_id: ids["silver"], free_over_jpy: "1" },
        ],
      },
    });
  });
  afterAll(closePool);

  it("当てはまる決まりのうちいちばん低い金額。合わなければ null。表示用の条件・ほかのショップの条件・無い条件・形の違う行は効かない", async () => {
    expect(await over(f.shopId, ids["cGold"]!)).toBe(0);
    expect(await over(f.shopId, ids["cSilver"]!)).toBe(3000);
    expect(await over(f.shopId, ids["cRegular"]!)).toBeNull();
    // ほかのショップの会員 id は引けない
    expect(await over(other.shopId, ids["cGold"]!)).toBeNull();
  });

  it("DB の最新の独自項目で決める。モジュールが OFF なら null", async () => {
    await getPool().query("update customers set attributes = $2::jsonb where id = $1", [ids["cRegular"], JSON.stringify({ rank: "silver" })]);
    expect(await over(f.shopId, ids["cRegular"]!)).toBe(3000);
    await setSettings(f.shopId, { modules: { audiences: false } });
    expect(await over(f.shopId, ids["cGold"]!)).toBeNull();
    await setSettings(f.shopId, { modules: { audiences: true } });
  });

  it("会員の条件を消すと、その決まりは効かない", async () => {
    await getPool().query("delete from audiences where id = $1", [ids["gold"]]);
    expect(await over(f.shopId, ids["cGold"]!)).toBe(3000);
  });

  it("service_role だけが呼べる", async () => {
    expect(await expectDbError(() => asAnon((c) => c.query("select member_free_shipping_over($1, $2)", [f.shopId, ids["cGold"]])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select member_free_shipping_over($1, $2)", [f.shopId, ids["cGold"]])))).toMatch(/permission denied/);
  });
});
