import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/** 0144_api_product_audience: 商品の会員限定（0098）を AI 用 API（api_product_create / update / json、api_audiences_list）で読み書きする */
describe.skipIf(!dbAvailable)("商品の会員限定の AI 用 API（0144）", () => {
  let f: Fixture;
  let other: Fixture;
  let gold: string;
  let lp: string;
  let otherAud: string;
  let write: string;
  let read: string;

  async function issue(fx: Fixture, scopes: string[]): Promise<string> {
    const raw = `banto_${randomUUID()}`;
    await asUser(fx.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [fx.shopId, fx.ownerId, hash(raw), raw.slice(0, 12), scopes]));
    return raw;
  }
  const create = (tok: string, values: J) => asService(async (c) => (await c.query<{ r: J }>("select api_product_create($1, $2) as r", [hash(tok), JSON.stringify(values)])).rows[0]!.r);
  const update = (tok: string, id: string, values: J) => asService(async (c) => (await c.query<{ r: J }>("select api_product_update($1, $2, $3) as r", [hash(tok), id, JSON.stringify(values)])).rows[0]!.r);
  const setModule = (shopId: string, on: boolean) =>
    getPool().query("update shops set settings = settings || jsonb_build_object('modules', coalesce(settings->'modules', '{}') || jsonb_build_object('audiences', $2::boolean)) where id = $1", [shopId, on]);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "apa-owner@example.com", slug: "apa-shop", publish: true });
    other = await createShopFixture({ email: "apa-other@example.com", slug: "apa-other", publish: true });
    const pool = getPool();
    await setModule(f.shopId, true);
    gold = (await pool.query<{ id: string }>("insert into audiences (shop_id, name, condition) values ($1, 'VIP（ブロンズ以上）', $2) returning id", [f.shopId, JSON.stringify({ member: true })])).rows[0]!.id;
    lp = (await pool.query<{ id: string }>("insert into audiences (shop_id, name, condition) values ($1, 'LP', $2) returning id", [f.shopId, JSON.stringify({ param: "ref", set: true })])).rows[0]!.id;
    otherAud = (await pool.query<{ id: string }>("insert into audiences (shop_id, name, condition) values ($1, 'よそ', $2) returning id", [other.shopId, JSON.stringify({ member: true })])).rows[0]!.id;
    write = await issue(f, ["products:read", "products:write"]);
    read = await issue(f, ["products:read"]);
  });
  afterAll(closePool);

  it("作成: 名前でも id でも付けられ、応答に audience・audience_mode・audience_hide が載る。送らなければ条件なし", async () => {
    const plain = await create(write, { slug: "plain", name: "plain" });
    expect(plain["audience"]).toBeNull();
    expect(plain["audience_mode"]).toBe("hide");
    expect(plain["audience_hide"]).toBe(false);

    const byName = await create(write, { slug: "vip-a", name: "vip-a", published: true, audience: "VIP（ブロンズ以上）", audience_hide: true });
    expect(byName["audience"]).toEqual({ id: gold, name: "VIP（ブロンズ以上）" });
    expect(byName["audience_mode"]).toBe("hide");
    expect(byName["audience_hide"]).toBe(true);

    const byId = await create(write, { slug: "vip-b", name: "vip-b", published: true, audience: gold, audience_mode: "buy" });
    expect(byId["audience"]).toEqual({ id: gold, name: "VIP（ブロンズ以上）" });
    expect(byId["audience_mode"]).toBe("buy");

    // 判定は今の RLS のまま: hide は匿名から消え、buy は見える
    const anon = (await asAnon((c) => c.query<{ slug: string }>("select slug from products where shop_id = $1 and slug like 'vip-%'", [f.shopId]))).rows.map((r) => r.slug);
    expect(anon).toEqual(["vip-b"]);
  });

  it("更新: 送った欄だけ変わる。buy にすると存在も隠すは外れ、null で条件を外す", async () => {
    const p = await create(write, { slug: "upd", name: "upd", audience: "VIP（ブロンズ以上）", audience_hide: true });
    const id = p["id"] as string;
    const renamed = await update(write, id, { name: "upd2" });
    expect(renamed["audience"]).toEqual({ id: gold, name: "VIP（ブロンズ以上）" });
    expect(renamed["audience_hide"]).toBe(true);

    const buy = await update(write, id, { audience_mode: "buy" });
    expect(buy["audience_mode"]).toBe("buy");
    expect(buy["audience_hide"]).toBe(false);

    const cleared = await update(write, id, { audience: null });
    expect(cleared["audience"]).toBeNull();

    // 読み取り（products:read）にも載る
    const got = await asService(async (c) => (await c.query<{ r: J }>("select api_product_get($1, $2) as r", [hash(read), id])).rows[0]!.r);
    expect(got["audience"]).toBeNull();
    expect(got["audience_mode"]).toBe("buy");
  });

  it("断る: よその条件・無い名前・表示用の条件・形の違い・hide と buy の食い違い・products:read だけのトークン", async () => {
    const id = (await create(write, { slug: "ng", name: "ng" }))["id"] as string;
    expect(await expectDbError(() => update(write, id, { audience: otherAud }))).toMatch(/audience_not_found/);
    expect(await expectDbError(() => update(write, id, { audience: "よそ" }))).toMatch(/audience_not_found/);
    expect(await expectDbError(() => update(write, id, { audience: "ない" }))).toMatch(/audience_not_found/);
    expect(await expectDbError(() => update(write, id, { audience: lp }))).toMatch(/audience_display_only/);
    expect(await expectDbError(() => update(write, id, { audience: "LP" }))).toMatch(/audience_display_only/);
    expect(await expectDbError(() => update(write, id, { audience: 1 }))).toMatch(/invalid_audience/);
    expect(await expectDbError(() => update(write, id, { audience: " " }))).toMatch(/invalid_audience/);
    expect(await expectDbError(() => update(write, id, { audience: gold, audience_mode: "show" }))).toMatch(/invalid_audience_mode/);
    expect(await expectDbError(() => update(write, id, { audience: gold, audience_hide: "yes" }))).toMatch(/invalid_audience_hide/);
    expect(await expectDbError(() => update(write, id, { audience: gold, audience_mode: "buy", audience_hide: true }))).toMatch(/audience_hide_requires_hide/);
    expect(await expectDbError(() => create(write, { slug: "ng2", name: "ng2", audience: gold, audience_mode: "buy", audience_hide: true }))).toMatch(/audience_hide_requires_hide/);
    expect(await expectDbError(() => update(read, id, { audience: gold }))).toMatch(/insufficient_scope|unauthorized|forbidden/);
    // 断ったときは何も変わっていない
    const row = (await getPool().query<{ audience_id: string | null }>("select audience_id from products where id = $1", [id])).rows[0]!;
    expect(row.audience_id).toBeNull();
  });

  it("モジュールが OFF: 付けるのは module_disabled、外すのは通る。会員の条件と関係のない更新はそのまま", async () => {
    const id = (await create(write, { slug: "off", name: "off", audience: gold }))["id"] as string;
    await setModule(f.shopId, false);
    try {
      expect(await expectDbError(() => update(write, id, { audience_mode: "buy" }))).toMatch(/module_disabled:audiences/);
      expect(await expectDbError(() => create(write, { slug: "off2", name: "off2", audience: gold }))).toMatch(/module_disabled:audiences/);
      expect((await update(write, id, { name: "off-renamed" }))["name"]).toBe("off-renamed");
      expect((await update(write, id, { audience: null }))["audience"]).toBeNull();
      expect(await expectDbError(() => asService((c) => c.query("select api_audiences_list($1)", [hash(read)])))).toMatch(/module_disabled:audiences/);
    } finally {
      await setModule(f.shopId, true);
    }
  });

  it("api_audiences_list: このショップの条件だけ、商品に付けられるかを添えて（中身は返さない）", async () => {
    const r = await asService(async (c) => (await c.query<{ r: { items: J[] } }>("select api_audiences_list($1) as r", [hash(read)])).rows[0]!.r);
    expect(r.items).toEqual([
      { id: lp, name: "LP", product_usable: false },
      { id: gold, name: "VIP（ブロンズ以上）", product_usable: true },
    ]);
    expect(await expectDbError(() => asAnon((c) => c.query("select api_audiences_list($1)", [hash(read)])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select banto_api_product_audience($1, '{}'::jsonb, null::products)", [f.shopId])))).toMatch(/permission denied/);
  });
});
