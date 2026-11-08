import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/** 0127_mod_care_labels: 洗濯表示（JIS L 0001:2024 の記号番号）・記号の絵の表（運営者が持ち込む）・公開のショップ行・AI 用 API */
describe.skipIf(!dbAvailable)("洗濯表示（0127）", () => {
  let f: Fixture;
  let other: Fixture;
  let cat: string;
  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "cl-owner@example.com", slug: "cl-shop", publish: true });
    other = await createShopFixture({ email: "cl-other@example.com", slug: "cl-other", publish: true });
    cat = (await getPool().query<{ id: string }>("insert into categories (shop_id, slug, name) values ($1, 'tops', 'トップス') returning id", [f.shopId])).rows[0]!.id;
  });
  afterAll(closePool);

  it("形: 知っている番号・区分ごとに 1 つ・付記は 1〜40 文字。null は決めていない", async () => {
    const set = (care: unknown) => asUser(f.ownerId, (c) => c.query("update products set care = $2 where id = $1", [f.productId, care === null ? null : JSON.stringify(care)]));
    await set({ symbols: ["141", "210", "300", "445", "511", "621"], notes: ["ネット使用", "裏返し"] });
    await set(null);
    expect(await expectDbError(() => set({ symbols: ["171"] }))).toMatch(/products_care_check/);
    expect(await expectDbError(() => set({ symbols: ["140", "141"] }))).toMatch(/products_care_check/);
    expect(await expectDbError(() => set({ symbols: ["140"], notes: [""] }))).toMatch(/products_care_check/);
    expect(await expectDbError(() => set({ symbols: ["140"], other: 1 }))).toMatch(/products_care_check/);
    await asUser(f.ownerId, (c) => c.query("update categories set care = $2 where id = $1", [cat, JSON.stringify({ symbols: ["130", "200"] })]));
  });

  it("記号の絵の表: catalog の項目だけ・このショップの care/ の画像だけ。使われなくなった鍵を返す", async () => {
    const img = (n: string) => ({ key: `care/${f.shopId}/${n.repeat(8)}.png`, width: 64, height: 64 });
    const r1 = await asUser(f.ownerId, async (c) => (await c.query<{ r: J }>("select care_symbols_set($1, $2) as r", [f.shopId, JSON.stringify({ "141": img("a"), "210": img("b") })])).rows[0]!.r);
    expect(r1["removed_image_keys"]).toEqual([]);
    const r2 = await asUser(f.ownerId, async (c) => (await c.query<{ r: J }>("select care_symbols_set($1, $2) as r", [f.shopId, JSON.stringify({ "141": img("a") })])).rows[0]!.r);
    expect(r2["removed_image_keys"]).toEqual([img("b").key]);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select care_symbols_set($1, $2)", [f.shopId, JSON.stringify({ "999": img("a") })])))).toMatch(/invalid_care_symbols/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select care_symbols_set($1, $2)", [f.shopId, JSON.stringify({ "141": { ...img("a"), key: `care/${other.shopId}/aaaaaaaa.png` } })])))).toMatch(/invalid_care_symbols/);
    expect(await expectDbError(() => asUser(other.ownerId, (c) => c.query("select care_symbols_set($1, $2)", [f.shopId, "{}"])))).toMatch(/forbidden/);
    expect(await expectDbError(() => asAnon((c) => c.query("select care_symbols_set($1, $2)", [f.shopId, "{}"])))).toMatch(/permission denied/);
  });

  it("お客様の画面: 商品と一緒に care、カテゴリーの care は匿名でも読める。絵の表はモジュールが ON のときだけ公開のショップ行に", async () => {
    await asUser(f.ownerId, (c) => c.query("update products set care = $2 where id = $1", [f.productId, JSON.stringify({ symbols: ["141"] })]));
    const slug = (await getPool().query<{ slug: string }>("select slug from products where id = $1", [f.productId])).rows[0]!.slug;
    const p = await asAnon(async (c) => (await c.query<{ r: J }>("select product_public_get($1, $2) as r", [f.shopId, slug])).rows[0]!.r);
    expect(p["care"]).toEqual({ symbols: ["141"] });
    const cats = await asAnon(async (c) => (await c.query<{ care: J }>("select care from categories where id = $1", [cat])).rows);
    expect(cats[0]!.care).toEqual({ symbols: ["130", "200"] });
    const pub = async () => (await asAnon(async (c) => (await c.query<{ r: J }>("select shop_public_get($1) as r", ["cl-shop"])).rows[0]!.r))["care_symbols"];
    expect(await pub()).toEqual({});
    await getPool().query("update shops set settings = settings || jsonb_build_object('modules', coalesce(settings->'modules', '{}') || '{\"care_labels\": true}') where id = $1", [f.shopId]);
    expect(Object.keys((await pub()) as J)).toEqual(["141"]);
  });

  it("AI 用 API（products:write）: 商品・カテゴリーを id か URL の名前で。よそ・形の違いは断る", async () => {
    const raw = `banto_${randomUUID()}`;
    await asUser(f.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, '{products:write}')", [f.shopId, f.ownerId, hash(raw), raw.slice(0, 12)]));
    const call = (target: string, ref: string, care: unknown) => asService(async (c) => (await c.query<{ r: J }>("select api_care_set($1, $2, $3, $4) as r", [hash(raw), target, ref, JSON.stringify(care)])).rows[0]!.r);
    expect(await call("category", "tops", { symbols: ["110"], notes: ["ネット使用"] })).toMatchObject({ target: "category", id: cat, care: { symbols: ["110"] } });
    expect(await call("product", f.productId, null)).toMatchObject({ care: null });
    expect(await expectDbError(() => call("product", other.productId, { symbols: ["110"] }))).toMatch(/not_found/);
    expect(await expectDbError(() => call("product", f.productId, { symbols: ["999"] }))).toMatch(/invalid_care/);
    expect(await expectDbError(() => call("shop", f.productId, null))).toMatch(/invalid_care_target/);
  });
});
