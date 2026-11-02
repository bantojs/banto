import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

type Chart = { axis: string | null; axis_name: string | null; columns: { key: string; label: string; unit: string | null }[]; rows: { value: string; cells: Record<string, string> }[]; note: string | null; image: { key: string; width: number; height: number } | null; sources: { columns: string; rows: string | null } };

/** 0095_mod_size_charts: 採寸表（ショップ → カテゴリー → 商品、表示するときに近い段から決める） */
describe.skipIf(!dbAvailable)("採寸表（0095）", () => {
  let a: Fixture;
  let b: Fixture;
  let stranger: string;
  let parent: string;
  let child: string;
  const as = <T>(sql: string, args: unknown[] = []) => asUser(a.ownerId, async (c) => (await c.query<{ r: T }>(sql, args)).rows[0]!.r);
  const set = (cat: string | null, prod: string | null, data: unknown) => as<Record<string, unknown>>("select size_chart_set($1, $2, $3, $4) as r", [a.shopId, cat, prod, JSON.stringify(data)]);
  const get = (cat: string | null, prod: string | null) => as<{ own: Record<string, unknown> | null; effective: Chart | null; inherited: Chart | null }>("select size_chart_get($1, $2, $3) as r", [a.shopId, cat, prod]);
  const pub = () => asAnon(async (c) => (await c.query<{ r: { size_chart: Chart | null } }>("select product_public_get($1, 'tee') as r", [a.shopId])).rows[0]!.r.size_chart);
  const modules = (on: boolean) => getPool().query("update shops set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{modules}', $2::jsonb) where id = $1", [a.shopId, JSON.stringify({ size_charts: on })]);

  beforeAll(async () => {
    await resetDatabase();
    a = await createShopFixture({ email: "sc-a@example.com", slug: "sc-a", publish: true, stock: 5 });
    b = await createShopFixture({ email: "sc-b@example.com", slug: "sc-b", publish: true, stock: 5 });
    stranger = await createAuthUser("sc-x@example.com");
    await asUser(a.ownerId, (c) => c.query("update skus set options = $2 where id = $1", [a.skuId, JSON.stringify({ サイズ: "M" })]));
    parent = (await getPool().query<{ id: string }>("insert into categories (shop_id, slug, name) values ($1, 'tops', 'トップス') returning id", [a.shopId])).rows[0]!.id;
    child = (await getPool().query<{ id: string }>("insert into categories (shop_id, slug, name, parent_id) values ($1, 'tees', 'Tシャツ', $2) returning id", [a.shopId, parent])).rows[0]!.id;
    await getPool().query("update products set category_id = $2 where id = $1", [a.productId, child]);
  });
  afterAll(closePool);

  it("形を組み直す: 列に key を振り、空の値を落とし、軸は名前でも key に。知らない軸・重なる行・長すぎる値は断る", async () => {
    const r = await set(null, null, { axis: "サイズ", columns: [{ label: "着丈", unit: "cm" }, { label: "身幅", unit: " cm " }, { label: "号数" }], rows: [{ value: "M", cells: { c1: "70", c2: 52, c3: "" } }], note: "  平置きで測っています ", extra: 1 });
    expect(r).toMatchObject({ level: "shop", axis: "size", columns: [{ key: "c1", label: "着丈", unit: "cm" }, { key: "c2", label: "身幅", unit: "cm" }, { key: "c3", label: "号数", unit: null }], rows: [{ value: "M", cells: { c1: "70", c2: "52" } }], note: "平置きで測っています", hidden: false });
    expect(r).not.toHaveProperty("extra");
    for (const bad of [{ axis: "色" }, { rows: [{ value: "M" }, { value: "m" }] }, { columns: [{ label: "x".repeat(41) }] }, { rows: [{ value: "M", cells: { c1: "x".repeat(41) } }] }, { columns: Array.from({ length: 13 }, (_, i) => ({ label: `c${i}` })) }, { image: { key: `size-charts/${b.shopId}/a.webp`, width: 10, height: 10 } }]) {
      expect(await expectDbError(() => set(null, null, bad))).toMatch(/invalid_size_chart/);
    }
    // ショップ・カテゴリーの段では隠せない
    expect(await expectDbError(() => set(parent, null, { hidden: true }))).toMatch(/invalid_size_chart_hidden/);
  });

  it("近い段から決める: 列と図はカテゴリー、行は商品。商品の行が無ければカテゴリーの行。列の段より上の行は使わない", async () => {
    await set(parent, null, { columns: [{ key: "length", label: "着丈", unit: "cm" }, { key: "chest", label: "身幅", unit: "cm" }], rows: [{ value: "F", cells: { length: "60" } }], image: { key: `size-charts/${a.shopId}/how.webp`, width: 800, height: 600 } });
    let eff = (await get(null, a.productId)).effective!;
    expect(eff).toMatchObject({ axis: null, columns: [{ key: "length" }, { key: "chest" }], rows: [{ value: "F" }], image: { key: `size-charts/${a.shopId}/how.webp`, width: 800 }, sources: { columns: "category", rows: "category" }, note: null });
    await set(null, a.productId, { axis: "size", rows: [{ value: "S", cells: { length: "66", chest: "48" } }, { value: "M", cells: { length: "70", chest: "52" } }] });
    const got = await get(null, a.productId);
    eff = got.effective!;
    expect(eff.rows.map((x) => x.value)).toEqual(["S", "M"]);
    expect(eff.sources).toEqual({ columns: "category", rows: "product" });
    // 軸は列の段のもの（商品の段の軸は列を持たないので使わない）
    expect(eff.axis).toBeNull();
    expect(got.inherited!.rows.map((x) => x.value)).toEqual(["F"]);
    // 子のカテゴリーで列を決め直すと、親の行は使わない（列と合わないため）。ショップの注記は列の段より上なので使わない
    await set(child, null, { axis: "サイズ", columns: [{ key: "waist", label: "ウエスト", unit: "cm" }] });
    await getPool().query("update size_charts set rows = null where product_id = $1", [a.productId]);
    eff = (await get(null, a.productId)).effective!;
    expect(eff).toMatchObject({ axis: "size", axis_name: "サイズ", columns: [{ key: "waist" }], rows: [], note: null, image: null, sources: { columns: "category", rows: null } });
    await set(child, null, {});
    expect(await getPool().query("select 1 from size_charts where category_id = $1", [child]).then((x) => x.rowCount)).toBe(0);
  });

  it("お客様の画面: モジュールが ON のときだけ product_public_get に出る。商品の段で隠せる", async () => {
    await set(null, a.productId, { rows: [{ value: "M", cells: { length: "70" } }] });
    expect(await pub()).toBeNull();
    await modules(true);
    expect((await pub())!.rows).toEqual([{ value: "M", cells: { length: "70" } }]);
    await set(null, a.productId, { hidden: true, rows: [{ value: "M", cells: { length: "70" } }] });
    expect(await pub()).toBeNull();
    await set(null, a.productId, { rows: [{ value: "M", cells: { length: "70" } }] });
    expect(await pub()).not.toBeNull();
  });

  it("書けるのは catalog の項目を持つ人で RPC だけ。表を直接は書けない・他のショップの段は書けない", async () => {
    expect(await expectDbError(() => asUser(stranger, (c) => c.query("select size_chart_set($1, null, null, '{}')", [a.shopId])))).toMatch(/forbidden/);
    expect(await expectDbError(() => asUser(stranger, (c) => c.query("select size_chart_get($1, null, null)", [a.shopId])))).toMatch(/forbidden/);
    expect(await expectDbError(() => as("insert into size_charts (shop_id) values ($1) returning id as r", [a.shopId]))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(b.ownerId, (c) => c.query("select size_chart_set($1, null, $2, $3)", [b.shopId, a.productId, JSON.stringify({ rows: [{ value: "M" }] })])))).toMatch(/not_found/);
    expect(await expectDbError(() => asAnon((c) => c.query("select * from size_charts")))).toMatch(/permission denied/);
    expect((await asUser(b.ownerId, (c) => c.query("select * from size_charts"))).rowCount).toBe(0);
  });

  it("AI 用 API: products:read で読み、products:write で書く。図は API では変わらない", async () => {
    const raw = `banto_${randomBytes(32).toString("base64url")}`;
    await asUser(a.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [a.shopId, a.ownerId, sha(raw), raw.slice(0, 12), ["products:read", "products:write"]]));
    const rpc = <T>(fn: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
    const r = await rpc<{ image: unknown; columns: unknown }>("api_size_chart_set", [sha(raw), parent, null, JSON.stringify({ columns: [{ key: "length", label: "着丈", unit: "cm" }], image: null })]);
    expect(r.image).toEqual({ key: `size-charts/${a.shopId}/how.webp`, width: 800, height: 600 });
    const g = await rpc<{ own: { columns: unknown }; effective: Chart }>("api_size_chart_get", [sha(raw), null, a.productId]);
    expect(g.effective.columns).toEqual([{ key: "length", label: "着丈", unit: "cm" }]);
    expect(await expectDbError(() => rpc("api_size_chart_get", [sha(raw), null, b.productId]))).toMatch(/not_found/);
    // 商品・カテゴリーを消すとその段も消える
    await getPool().query("delete from categories where id = $1", [parent]);
    expect((await getPool().query("select 1 from size_charts where category_id = $1", [parent])).rowCount).toBe(0);
  });
});
