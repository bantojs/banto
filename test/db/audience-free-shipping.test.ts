import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";
import { audienceFreeRules, publicShipping } from "../../src/commerce/shipping";

type J = Record<string, unknown>;

/**
 * 0171_audience_free_shipping: 会員の条件ごとの送料無料の金額。会員が条件に合うかは DB の最新の独自項目と banto_audience_ok で決め、
 * いちばん低い金額を返す（送料の計算は Worker の shipping.ts）
 */
describe.skipIf(!dbAvailable)("会員の条件ごとの送料無料（0171）", () => {
  let f: Fixture;
  let other: Fixture;
  const ids: Record<string, string> = {};
  const sids: Record<string, string> = {};
  const setSettings = (shopId: string, s: J) => getPool().query("update shops set settings = settings || $2::jsonb where id = $1", [shopId, JSON.stringify(s)]);
  // セッション（世代・行）を確かめる（ほかの member_* と同じ）
  const over = (shopId: string, customerId: string, epoch = 0, sid = sids[customerId]!) =>
    asService(async (c) => (await c.query<{ v: number | null }>("select member_free_shipping_over($1, $2, $3, $4) as v", [shopId, customerId, epoch, sid])).rows[0]!.v);
  const session = async (shopId: string, customerId: string) => (sids[customerId] = await asService(async (c) => (await c.query<{ r: string }>("select member_session_start($1, $2, 0, 'web', 'x', 3600) as r", [shopId, customerId])).rows[0]!.r));
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
    for (const k of ["cGold", "cSilver", "cRegular"]) await session(f.shopId, ids[k]!);
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
    // ほかのショップの会員 id は引けない（セッションもそのショップのものではない）
    expect(await over(other.shopId, ids["cGold"]!)).toBeNull();
  });

  it("shop_audiences_render（カートの目安）: 決まりのある条件だけ free_over_jpy。表示用の条件・ほかのショップの条件の id・決まりの無いショップ・モジュール OFF には付けない", async () => {
    const render = (shopId: string) => asService(async (c) => (await c.query<{ r: J[] }>("select shop_audiences_render($1) as r", [shopId])).rows[0]!.r);
    const byId = (rows: J[]) => Object.fromEntries(rows.map((r) => [String(r["id"]), r]));
    const mine = byId(await render(f.shopId));
    expect(mine[ids["gold"]!]!["free_over_jpy"]).toBe(0);
    expect(mine[ids["silver"]!]!["free_over_jpy"]).toBe(3000);
    // 表示用の条件（URL のパラメータ）は決まりがあっても付けない
    expect(mine[ids["param"]!]).toBeDefined();
    expect("free_over_jpy" in mine[ids["param"]!]!).toBe(false);
    // ほかのショップの条件は一覧に出ない。ほかのショップの一覧では、こちらの決まりが指していても付かない（決まりの無いショップ）
    expect(mine[ids["otherGold"]!]).toBeUndefined();
    const theirs = byId(await render(other.shopId));
    expect(theirs[ids["otherGold"]!]).toBeDefined();
    expect("free_over_jpy" in theirs[ids["otherGold"]!]!).toBe(false);
    // モジュール OFF なら一覧そのものが空
    const off = await createShopFixture({ email: "afs-render-off@example.com", slug: "afs-render-off", publish: true });
    await setSettings(off.shopId, { customer_fields: [{ key: "rank", label: "ランク", type: "select", options: ["gold", "silver", "regular"] }] });
    const offAud = await audience(off.shopId, "ゴールド", { attr: "rank", in: ["gold"] });
    await setSettings(off.shopId, { modules: { audiences: false }, shipping: { mode: "flat", flat_fee_jpy: 800, free_over_jpy: null, by_prefecture: {}, free_over_by_audience: [{ audience_id: offAud, free_over_jpy: 0 }] } });
    expect(await render(off.shopId)).toEqual([]);
    // ON でも決まりが無ければ付かない
    await setSettings(off.shopId, { modules: { audiences: true }, shipping: { mode: "flat", flat_fee_jpy: 800, free_over_jpy: null, by_prefecture: {} } });
    const noRules = await render(off.shopId);
    expect(noRules.map((r) => r["id"])).toEqual([offAud]);
    expect("free_over_jpy" in noRules[0]!).toBe(false);
  });

  it("セッションを確かめる: 世代が違う・取り消した・ほかの会員のセッションなら null（送料がかかる）", async () => {
    expect(await over(f.shopId, ids["cGold"]!, 1)).toBeNull();
    expect(await over(f.shopId, ids["cGold"]!, 0, sids[ids["cSilver"]!]!)).toBeNull();
    const cid = await customer(f.shopId, "g2@example.com", { rank: "gold" });
    await session(f.shopId, cid);
    expect(await over(f.shopId, cid)).toBe(0);
    await getPool().query("update customers set session_epoch = session_epoch + 1 where id = $1", [cid]);
    expect(await over(f.shopId, cid)).toBeNull();
    expect(await over(f.shopId, cid, 1)).toBeNull();
    const cid2 = await customer(f.shopId, "g3@example.com", { rank: "gold" });
    await session(f.shopId, cid2);
    await getPool().query("update member_sessions set revoked_at = now() where id = $1", [sids[cid2]]);
    expect(await over(f.shopId, cid2)).toBeNull();
  });

  it("決まりの読み方は Worker（audienceFreeRules）と同じ: 形の違う行を捨ててから 10 件、大文字の id、1,000,000 円まで", async () => {
    const shop = await createShopFixture({ email: "afs-parse@example.com", slug: "afs-parse", publish: true });
    await setSettings(shop.shopId, { customer_fields: [{ key: "rank", label: "ランク", type: "select", options: ["gold", "silver", "regular"] }], modules: { audiences: true } });
    const gold = await audience(shop.shopId, "ゴールド", { attr: "rank", in: ["gold"] });
    const cid = await customer(shop.shopId, "p@example.com", { rank: "gold" });
    await session(shop.shopId, cid);
    const junk = Array.from({ length: 11 }, (_, i) => (i % 2 === 0 ? { audience_id: "nope", free_over_jpy: 0 } : { audience_id: gold, free_over_jpy: 2_000_000 }));
    const rules = [...junk, { audience_id: gold.toUpperCase(), free_over_jpy: 1500, label: " ゴールド " }];
    await setSettings(shop.shopId, { shipping: { mode: "flat", flat_fee_jpy: 800, free_over_jpy: null, by_prefecture: {}, free_over_by_audience: rules } });
    expect(await over(shop.shopId, cid)).toBe(1500);
    // DB の読み方と Worker の読み方が同じ
    const db = await asService(async (c) => (await c.query<{ r: unknown }>("select banto_audience_free_rules($1::jsonb) as r", [JSON.stringify(rules)])).rows[0]!.r);
    expect(db).toEqual(audienceFreeRules(rules));
    // 公開の設定: 名前を付けた決まりの名前と金額だけ（会員の条件の id は出さない）。Worker の publicShipping と同じ
    const pub = await asAnon(async (c) => (await c.query<{ r: { settings: J } }>("select shop_public_get('afs-parse') as r")).rows[0]!.r.settings["shipping"] as J);
    expect(pub["free_over_by_audience"]).toEqual([{ label: "ゴールド", free_over_jpy: 1500, exclude_sale: false }]);
    expect(pub["member_free"]).toBe(true);
    expect(JSON.stringify(pub)).not.toContain(gold);
    expect(pub).toEqual(publicShipping({ mode: "flat", flat_fee_jpy: 800, free_over_jpy: null, by_prefecture: {}, free_over_by_audience: rules }));
  });

  it("公開の設定: 名前の無い決まりの金額・会員の条件の id は出さない。決まりが無ければ member_free も無い", async () => {
    const pub = await asAnon(async (c) => (await c.query<{ r: { settings: J } }>("select shop_public_get('afs-shop') as r")).rows[0]!.r.settings["shipping"] as J);
    expect(pub["member_free"]).toBe(true);
    expect(pub["free_over_by_audience"]).toEqual([{ label: "ゴールド会員", free_over_jpy: 0, exclude_sale: false }]);
    expect(JSON.stringify(pub)).not.toContain(ids["silver"]!);
    const none = await asAnon(async (c) => (await c.query<{ r: { settings: J } }>("select shop_public_get('afs-other') as r")).rows[0]!.r.settings);
    expect(none["shipping"] === undefined || !("member_free" in (none["shipping"] as J))).toBe(true);
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
    expect(await expectDbError(() => asAnon((c) => c.query("select member_free_shipping_over($1, $2, 0, $3)", [f.shopId, ids["cGold"], sids[ids["cGold"]!]])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select member_free_shipping_over($1, $2, 0, $3)", [f.shopId, ids["cGold"], sids[ids["cGold"]!]])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asAnon((c) => c.query("select banto_audience_free_rules('[]'::jsonb)")))).toMatch(/permission denied/);
  });

  it("0183: member_free_shipping は当てはまる決まりを金額とセール商品を含まない印つきで返す。お店の画面の一覧にも印", async () => {
    // 前のテストで消したゴールドの条件を作り直す
    ids["gold"] = await audience(f.shopId, "ゴールド2", { all: [{ member: true }, { attr: "rank", in: ["gold"] }] });
    await setSettings(f.shopId, { shipping: { mode: "flat", flat_fee_jpy: 800, free_over_by_audience: [{ audience_id: ids["gold"], free_over_jpy: 1, exclude_sale: true, label: "ゴールド会員" }, { audience_id: ids["silver"], free_over_jpy: 3000 }] } });
    const rules = (cid: string) => asService(async (c) => (await c.query<{ v: unknown }>("select member_free_shipping($1, $2, 0, $3) as v", [f.shopId, cid, sids[cid]])).rows[0]!.v);
    // ゴールドの会員はシルバーの条件（rank が silver か gold）にも当てはまる
    expect(await rules(ids["cGold"]!)).toEqual([{ free_over_jpy: 1, exclude_sale: true }, { free_over_jpy: 3000, exclude_sale: false }]);
    expect(await rules(ids["cSilver"]!)).toEqual([{ free_over_jpy: 3000, exclude_sale: false }]);
    // 前のテストでシルバーに変えた会員を元に戻す
    await getPool().query("update customers set attributes = $2::jsonb where id = $1", [ids["cRegular"], JSON.stringify({ rank: "regular" })]);
    expect(await rules(ids["cRegular"]!)).toEqual([]);
    const render = await asService(async (c) => (await c.query<{ v: { id: string; free_over_excludes_sale?: boolean }[] }>("select shop_audiences_render($1) as v", [f.shopId])).rows[0]!.v);
    expect(render.find((a) => a.id === ids["gold"])).toMatchObject({ free_over_jpy: 1, free_over_excludes_sale: true });
    expect(render.find((a) => a.id === ids["silver"])).toMatchObject({ free_over_jpy: 3000, free_over_excludes_sale: false });
    const pub = await asService(async (c) => (await c.query<{ v: Record<string, unknown> }>("select banto_public_shipping($1::jsonb) as v", [JSON.stringify({ free_over_jpy: 11000, free_over_excludes_sale: true, free_over_by_audience: [{ audience_id: ids["gold"], free_over_jpy: 1, exclude_sale: true, label: "ゴールド会員" }] })])).rows[0]!.v);
    expect(pub).toMatchObject({ free_over_excludes_sale: true, free_over_by_audience: [{ label: "ゴールド会員", free_over_jpy: 1, exclude_sale: true }] });
    expect(await expectDbError(() => asAnon((c) => c.query("select member_free_shipping($1, $2, 0, $3)", [f.shopId, ids["cGold"], sids[ids["cGold"]!]])))).toMatch(/permission denied/);
  });
});
