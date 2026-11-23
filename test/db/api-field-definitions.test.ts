import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";
import { fieldDefinitions } from "../../src/products/fields";
import { customerFields } from "../../src/customers/fields";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/** 0145_api_field_definitions: 商品・会員の項目の定義を AI 用 API で読み書きする。形の検査は DB、読み手は管理画面と同じ fieldDefinitions */
describe.skipIf(!dbAvailable)("項目の定義の AI 用 API（0145）", () => {
  let f: Fixture;
  let other: Fixture;
  const tokens: Record<string, string> = {};

  async function issue(fx: Fixture, scopes: string[]): Promise<string> {
    const raw = `banto_${randomUUID()}`;
    await asUser(fx.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [fx.shopId, fx.ownerId, hash(raw), raw.slice(0, 12), scopes]));
    return raw;
  }
  const get = (tok: string, kind: string) => asService(async (c) => (await c.query<{ r: { fields: J[] } }>("select api_field_defs_get($1, $2) as r", [hash(tok), kind])).rows[0]!.r);
  const set = (tok: string, kind: string, fields: unknown) => asService(async (c) => (await c.query<{ r: { fields: J[] } }>("select api_field_defs_set($1, $2, $3) as r", [hash(tok), kind, JSON.stringify(fields)])).rows[0]!.r);
  const norm = (p: unknown, kind: string) => asService(async (c) => (await c.query<{ r: J[] }>("select banto_field_defs_norm($1, $2) as r", [JSON.stringify(p), kind])).rows[0]!.r);
  const settings = async (shopId: string) => (await getPool().query<{ s: J }>("select settings as s from shops where id = $1", [shopId])).rows[0]!.s;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "afd-owner@example.com", slug: "afd-shop", publish: true });
    other = await createShopFixture({ email: "afd-other@example.com", slug: "afd-other", publish: true });
    tokens["pw"] = await issue(f, ["products:read", "products:write"]);
    tokens["pr"] = await issue(f, ["products:read"]);
    tokens["cw"] = await issue(f, ["customers:read", "customers:write"]);
    tokens["cr"] = await issue(f, ["customers:read"]);
    tokens["cwo"] = await issue(f, ["customers:write"]);
    tokens["cl"] = await issue(f, ["customers:links"]);
    tokens["pwo"] = await issue(f, ["products:write"]);
  });
  afterAll(closePool);

  it("商品の項目: 丸ごと置き換え、管理画面と同じ形に組み直す（前後の空白・既定値）。ほかの settings とよそのショップは変えない", async () => {
    await getPool().query("update shops set settings = settings || '{\"members_enabled\": true}' where id = $1", [f.shopId]);
    const r = await set(tokens["pw"]!, "product", [
      { key: "material", label: " 素材 ", type: "text", card: true },
      { key: "origin", type: "select", options: [" 日本 ", "中国"] },
      { key: "cost", label: "原価", type: "number", public: false },
    ]);
    expect(r.fields).toEqual([
      { key: "material", label: "素材", type: "text", public: true, card: true },
      { key: "origin", label: "origin", type: "select", options: ["日本", "中国"], public: true },
      { key: "cost", label: "原価", type: "number", public: false },
    ]);
    const s = await settings(f.shopId);
    expect(s["product_fields"]).toEqual(r.fields);
    expect(s["members_enabled"]).toBe(true);
    expect((await settings(other.shopId))["product_fields"]).toBeUndefined();
    expect((await get(tokens["pr"]!, "product")).fields).toEqual(r.fields);
    expect((await set(tokens["pw"]!, "product", [])).fields).toEqual([]);
  });

  it("会員の項目: image・public・card は断る。public は false で保存し、値の検査（banto_customer_attributes）がその鍵を受け付ける", async () => {
    const r = await set(tokens["cw"]!, "customer", [{ key: "rank", label: "ランク", type: "select", options: ["gold", "silver"] }, { key: "staff", type: "text", public: false }]);
    expect(r.fields).toEqual([
      { key: "rank", label: "ランク", type: "select", options: ["gold", "silver"], public: false },
      { key: "staff", label: "staff", type: "text", public: false },
    ]);
    expect((await get(tokens["cr"]!, "customer")).fields).toEqual(r.fields);
    const attrs = await asService(async (c) => (await c.query<{ r: J }>("select banto_customer_attributes($1, $2) as r", [f.shopId, JSON.stringify({ rank: "gold" })])).rows[0]!.r);
    expect(attrs).toEqual({ rank: "gold" });
    expect(await expectDbError(() => set(tokens["cw"]!, "customer", [{ key: "photo", type: "image" }]))).toMatch(/invalid_fields:1:type/);
    expect(await expectDbError(() => set(tokens["cw"]!, "customer", [{ key: "rank", type: "text", public: true }]))).toMatch(/invalid_fields:1:public/);
    expect(await expectDbError(() => set(tokens["cw"]!, "customer", [{ key: "rank", type: "text", card: true }]))).toMatch(/invalid_fields:1:card/);
  });

  it("形の違いは何番目の何かを返して断り、何も変えない", async () => {
    await set(tokens["pw"]!, "product", [{ key: "keep", type: "text" }]);
    const cases: [unknown, RegExp][] = [
      [{ key: "a", type: "text" }, /invalid_fields:not_array/],
      [Array.from({ length: 151 }, (_, i) => ({ key: `k${i}`, type: "text" })), /invalid_fields:too_many/],
      [["text"], /invalid_fields:1:not_object/],
      [[{ key: "a", type: "text", color: "red" }], /invalid_fields:1:unknown_property/],
      [[{ key: "a", type: "text" }, { key: "B", type: "text" }], /invalid_fields:2:key/],
      [[{ key: "1a", type: "text" }], /invalid_fields:1:key/],
      [[{ key: "a".repeat(41), type: "text" }], /invalid_fields:1:key/],
      [[{ key: "a", type: "text" }, { key: "a", type: "number" }], /invalid_fields:2:duplicate_key/],
      [[{ key: "a", type: "date" }], /invalid_fields:1:type/],
      [[{ key: "a" }], /invalid_fields:1:type/],
      [[{ key: "a", type: "text", label: "" }], /invalid_fields:1:label/],
      [[{ key: "a", type: "text", label: "x".repeat(61) }], /invalid_fields:1:label/],
      [[{ key: "a", type: "text", options: ["x"] }], /invalid_fields:1:options_not_select/],
      [[{ key: "a", type: "select", options: "x" }], /invalid_fields:1:options/],
      [[{ key: "a", type: "select", options: [""] }], /invalid_fields:1:options/],
      [[{ key: "a", type: "select", options: Array.from({ length: 51 }, (_, i) => `o${i}`) }], /invalid_fields:1:options/],
      [[{ key: "a", type: "text", public: "yes" }], /invalid_fields:1:public/],
      [[{ key: "a", type: "text", public: false, card: true }], /invalid_fields:1:card/],
    ];
    for (const [body, re] of cases) expect(await expectDbError(() => set(tokens["pw"]!, "product", body))).toMatch(re);
    expect((await settings(f.shopId))["product_fields"]).toEqual([{ key: "keep", label: "keep", type: "text", public: true }]);
  });

  it("全角スペース付きの選択肢も、管理画面と同じ値で保存し、会員の値の検査（banto_customer_attributes）と食い違わない", async () => {
    const r = await set(tokens["cw"]!, "customer", [{ key: "rank", type: "select", options: ["ゴールド\u3000", "\tシルバー"] }]);
    expect(r.fields[0]!["options"]).toEqual(["ゴールド", "シルバー"]);
    const attrs = await asService(async (c) => (await c.query<{ r: J }>("select banto_customer_attributes($1, $2) as r", [f.shopId, JSON.stringify({ rank: "ゴールド" })])).rows[0]!.r);
    expect(attrs).toEqual({ rank: "ゴールド" });
    // 61 文字（コードポイント）は断る。絵文字 60 個はちょうど通る
    expect(await expectDbError(() => set(tokens["pw"]!, "product", [{ key: "x", type: "text", label: "🍣".repeat(61) }]))).toMatch(/invalid_fields:1:label/);
    expect((await set(tokens["pw"]!, "product", [{ key: "x", type: "text", label: "🍣".repeat(60) }])).fields[0]!["label"]).toBe("🍣".repeat(60));
  });

  it("スコープ: 読み取りだけのトークン・逆の種類のトークンでは書けない。匿名・運営者の JWT からは呼べない", async () => {
    expect(await expectDbError(() => set(tokens["pr"]!, "product", []))).toMatch(/insufficient_scope|unauthorized|forbidden/);
    expect(await expectDbError(() => set(tokens["cr"]!, "customer", []))).toMatch(/insufficient_scope|unauthorized|forbidden/);
    expect(await expectDbError(() => set(tokens["cw"]!, "product", []))).toMatch(/insufficient_scope|unauthorized|forbidden/);
    expect(await expectDbError(() => get(tokens["pw"]!, "customer"))).toMatch(/insufficient_scope|unauthorized|forbidden/);
    expect(await expectDbError(() => asAnon((c) => c.query("select api_field_defs_set($1, 'product', '[]')", [hash(tokens["pw"]!)])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select banto_field_defs_norm('[]', 'product')")))).toMatch(/permission denied/);
  });

  it("読み取り（0169）: 定義は書き込みのスコープでも、会員は customers:links でも読める。種類が違えば読めない", async () => {
    await set(tokens["cw"]!, "customer", [{ key: "card_no", label: "会員カード", type: "text" }]);
    for (const t of ["cr", "cwo", "cl"]) expect((await get(tokens[t]!, "customer")).fields.map((x) => x["key"])).toEqual(["card_no"]);
    expect(Array.isArray((await get(tokens["pwo"]!, "product")).fields)).toBe(true);
    expect(await expectDbError(() => get(tokens["cl"]!, "product"))).toMatch(/unauthorized/);
    expect(await expectDbError(() => get(tokens["pwo"]!, "customer"))).toMatch(/unauthorized/);
    expect(await expectDbError(() => get(tokens["cwo"]!, "product"))).toMatch(/unauthorized/);
    expect(await expectDbError(() => get("no-such-token", "customer"))).toMatch(/unauthorized/);
    expect(await expectDbError(() => asAnon((c) => c.query("select api_field_defs_get($1, 'customer')", [hash(tokens["cl"]!)])))).toMatch(/permission denied/);
    // 取り消したトークンは書き込み・結びつけのスコープでも読めない
    await getPool().query("update api_tokens set revoked_at = now() where token_hash = $1", [hash(tokens["cl"]!)]);
    expect(await expectDbError(() => get(tokens["cl"]!, "customer"))).toMatch(/unauthorized/);
  });

  it("答え合わせ: DB が組み直した定義は、管理画面の読み手（fieldDefinitions / customerFields）を通しても変わらない", async () => {
    const inputs: unknown[] = [
      [{ key: "a", type: "text" }],
      [{ key: "a", label: "  A  ", type: "textarea", public: true, card: true }, { key: "b_2", type: "url", public: false }],
      [{ key: "s", type: "select", options: [" x ", "y"], card: false }, { key: "n", type: "number", label: null, options: null }],
      [{ key: "img", type: "image", public: true }],
      [{ key: "e", type: "select", options: [] }],
      // 全角スペース・タブ・改行・NBSP・BOM（JS の trim と同じに落とす）と、サロゲートの組（コードポイントで数える）
      [{ key: "w", label: "\u3000ランク\t", type: "select", options: ["ゴールド\u3000", "\u00a0シルバー\n", "\ufeffブロンズ"] }],
      [{ key: "u", label: "a" + "🍣".repeat(59), type: "select", options: ["b" + "🍣".repeat(59)] }],
    ];
    for (const p of inputs) {
      const out = await norm(p, "product");
      expect(fieldDefinitions(out)).toEqual(out);
    }
    for (const p of inputs.slice(0, 3).concat([[{ key: "s", type: "select", options: ["x"] }]])) {
      const clean = (p as J[]).map(({ public: _p, card: _c, ...r }) => r);
      const out = await norm(clean, "customer");
      expect(customerFields({ customer_fields: out })).toEqual(out);
    }
  });
});
