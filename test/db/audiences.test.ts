import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";
import { AUDIENCE_CASES } from "../fixtures/audience-cases";

/** 0097_audiences: 会員の条件（見せる相手）の判定・登録・会員のセッションに載る値 */
describe.skipIf(!dbAvailable)("会員の条件（0097）", () => {
  let a: Fixture;
  let stranger: string;
  const as = <T>(sql: string, args: unknown[] = []) => asUser(a.ownerId, async (c) => (await c.query<{ r: T }>(sql, args)).rows[0]?.r as T);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "au-a@example.com", slug: "au-a", publish: true });
    stranger = await createAuthUser("au-x@example.com");
    await getPool().query("update shops set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{customer_fields}', $2::jsonb) where id = $1", [
      a.shopId,
      JSON.stringify([{ key: "rank", label: "ランク", type: "select", options: ["gold", "silver"] }, { key: "points", label: "ポイント", type: "number" }, { key: "region", label: "地域", type: "text" }, { key: "secret", label: "社内メモ", type: "text" }]),
    ]);
  });
  afterAll(closePool);

  it("答え合わせの表（TS と同じ）", async () => {
    // 覚えた値（remember）は画面の Cookie の話なので DB には流さない
    for (const c of AUDIENCE_CASES.filter((x) => !x.remembered)) {
      const r = (await getPool().query<{ ok: boolean }>("select banto_audience_ok($1::jsonb, $2, $3::jsonb, $4::jsonb) as ok", [c.cond === null ? null : JSON.stringify(c.cond), c.member, JSON.stringify(c.attrs), JSON.stringify(c.params ?? {})])).rows[0]!.ok;
      expect({ name: c.name, ok: r }).toEqual({ name: c.name, ok: c.ok });
    }
  });

  it("登録: 形を組み直す。定義に無い鍵・深すぎる・形の違うものは断る。名前はショップの中で重ならない", async () => {
    const cond = await as<unknown>("insert into audiences (shop_id, name, condition) values ($1, ' ゴールド ', $2) returning condition as r", [a.shopId, JSON.stringify({ all: [{ member: true }, { attr: "rank", in: [" gold ", 1] }] })]);
    expect(cond).toEqual({ all: [{ member: true }, { attr: "rank", in: ["gold", "1"] }] });
    expect(await as<string>("select name as r from audiences where shop_id = $1", [a.shopId])).toBe("ゴールド");
    for (const bad of [{ attr: "nope", in: ["x"] }, { member: false }, { all: [] }, { attr: "rank", in: ["x"], extra: 1 }, { all: [{ all: [{ all: [{ all: [{ member: true }] }] }] }] }, { attr: "points", gte: "10" }, { any: Array.from({ length: 21 }, () => ({ member: true })) }]) {
      expect(await expectDbError(() => as("insert into audiences (shop_id, name, condition) values ($1, $2, $3) returning id as r", [a.shopId, `x${Math.random()}`, JSON.stringify(bad)]))).toMatch(/invalid_audience/);
    }
    expect(await expectDbError(() => as("insert into audiences (shop_id, name, condition) values ($1, 'ゴールド', '{\"member\": true}') returning id as r", [a.shopId]))).toMatch(/duplicate|unique/);
  });

  it("権限: 書けるのは marketing、他人と anon は読めない", async () => {
    expect(await expectDbError(() => asUser(stranger, (c) => c.query("insert into audiences (shop_id, name, condition) values ($1, 'x', '{\"member\": true}')", [a.shopId])))).toMatch(/row-level security|permission/);
    expect((await asUser(stranger, (c) => c.query("select * from audiences"))).rowCount).toBe(0);
    expect(await expectDbError(() => asAnon((c) => c.query("select * from audiences")))).toMatch(/permission denied/);
  });

  it("会員のセッション: 確かめ直すときに、条件で使っている独自項目の値だけを返す", async () => {
    await as("insert into audiences (shop_id, name, condition) values ($1, '1万ポイント', '{\"attr\": \"points\", \"gte\": 10000}') returning id as r", [a.shopId]);
    const cid = (await getPool().query<{ id: string }>("insert into customers (shop_id, email, attributes) values ($1, 'm@example.com', $2) returning id", [a.shopId, JSON.stringify({ rank: "gold", points: 12000, secret: "x", region: "jp" })])).rows[0]!.id;
    const sid = await asService(async (c) => (await c.query<{ r: string }>("select member_session_start($1, $2, 0, 'web', 'x', 3600) as r", [a.shopId, cid])).rows[0]!.r);
    const r = await asService(async (c) => (await c.query<{ r: { ok: boolean; attrs: Record<string, unknown> } }>("select member_session_check_attrs($1, $2, 0, $3) as r", [a.shopId, cid, sid])).rows[0]!.r);
    expect(r).toEqual({ ok: true, attrs: { rank: "gold", points: 12000 } });
    const bad = await asService(async (c) => (await c.query<{ r: { ok: boolean } }>("select member_session_check_attrs($1, $2, 1, $3) as r", [a.shopId, cid, sid])).rows[0]!.r);
    expect(bad).toEqual({ ok: false });
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select member_session_check_attrs($1, $2, 0, $3)", [a.shopId, cid, sid])))).toMatch(/service_role only|permission denied/);
  });

  it("URL のパラメータの条件: 名前は小文字に、形の違う名前は断る。表示用かどうか", async () => {
    const cond = await as<unknown>("insert into audiences (shop_id, name, condition) values ($1, 'インスタ', $2) returning condition as r", [a.shopId, JSON.stringify({ any: [{ param: "Ref", in: [" insta "], remember: true }, { param: "tag", set: true }] })]);
    expect(cond).toEqual({ any: [{ param: "ref", in: ["insta"], remember: true }, { param: "tag", set: true }] });
    expect(await expectDbError(() => as("insert into audiences (shop_id, name, condition) values ($1, 'x1', $2) returning 1 as r", [a.shopId, JSON.stringify({ param: "bad-name", set: true })]))).toMatch(/invalid_audience_param/);
    expect(await expectDbError(() => as("insert into audiences (shop_id, name, condition) values ($1, 'x2', $2) returning 1 as r", [a.shopId, JSON.stringify({ param: "ref", set: true, remember: false })]))).toMatch(/invalid_audience/);
    const only = async (c: unknown) => (await getPool().query<{ r: boolean }>("select banto_audience_display_only($1::jsonb) as r", [JSON.stringify(c)])).rows[0]!.r;
    expect(await only({ all: [{ member: true }, { not: { param: "ref", set: true } }] })).toBe(true);
    expect(await only({ all: [{ member: true }, { attr: "rank", in: ["gold"] }] })).toBe(false);
  });

  it("お店の画面の条件の一覧: モジュールが ON のショップだけ、service_role だけ", async () => {
    const list = () => asService(async (c) => (await c.query<{ r: { id: string; name: string; condition: unknown }[] }>("select shop_audiences_render($1) as r", [a.shopId])).rows[0]!.r);
    const pool = getPool();
    await pool.query("update shops set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{modules}', '{\"audiences\": false}') where id = $1", [a.shopId]);
    expect(await list()).toEqual([]);
    await pool.query("update shops set settings = jsonb_set(settings, '{modules}', '{\"audiences\": true}') where id = $1", [a.shopId]);
    const rows = await list();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty("condition");
    expect(await expectDbError(() => asAnon((c) => c.query("select shop_audiences_render($1)", [a.shopId])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(a.ownerId, (c) => c.query("select shop_audiences_render($1)", [a.shopId])))).toMatch(/permission denied|service_role only/);
  });
});
