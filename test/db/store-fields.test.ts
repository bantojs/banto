import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/** 0126_store_fields: 実店舗の独自項目（定義は組織ごと）と外部コード、公開の値、AI 用 API（stores:write） */
describe.skipIf(!dbAvailable)("実店舗の独自項目（0126）", () => {
  let f: Fixture;
  let other: Fixture;
  let org: string;
  let store: string;
  let unused: string;
  let member: string;
  const defs = [
    { key: "parking", label: "駐車場", type: "select", options: ["あり", "なし"] },
    { key: "brands", label: "取扱ブランド", type: "text" },
    { key: "seats", label: "試着室", type: "number" },
    { key: "site", label: "店舗のページ", type: "url" },
    { key: "manager", label: "担当者", type: "text", private: true },
  ];
  const api = <T>(fn: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "sf-owner@example.com", slug: "sf-shop", publish: true });
    other = await createShopFixture({ email: "sf-other@example.com", slug: "sf-other", publish: true });
    const pool = getPool();
    org = (await pool.query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    store = (await pool.query<{ id: string }>("insert into stores (org_id, name) values ($1, '渋谷店') returning id", [org])).rows[0]!.id;
    unused = (await pool.query<{ id: string }>("insert into stores (org_id, name) values ($1, '使わない店') returning id", [org])).rows[0]!.id;
    await pool.query("insert into shop_stores (shop_id, store_id) values ($1, $2)", [f.shopId, store]);
    member = await createAuthUser("sf-member@example.com");
    await asUser(f.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [org, "sf-member@example.com", JSON.stringify([{ shop_id: f.shopId, perms: ["stores", "integrations"] }]), hash("t-m")]));
    await withRole("authenticated", { sub: member, email: "sf-member@example.com" }, (c) => c.query("select org_invitation_accept($1)", [hash("t-m")]));
  });
  afterAll(closePool);

  it("定義: 組織の owner / admin だけが書ける。形の違う定義は断る", async () => {
    expect(await expectDbError(() => asUser(member, (c) => c.query("select store_fields_set($1, $2)", [org, JSON.stringify(defs)])))).toMatch(/org_not_found|permission/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select store_fields_set($1, $2)", [org, JSON.stringify([{ key: "x", label: "x", type: "date" }])])))).toMatch(/store_fields_invalid/);
    await asUser(f.ownerId, (c) => c.query("select store_fields_set($1, $2)", [org, JSON.stringify(defs)]));
  });

  it("値: 定義にある鍵だけ・形を整える。公開の一覧には private を出さない", async () => {
    const row = await asUser(f.ownerId, async (c) => (await c.query<{ fields: J }>("update stores set fields = $2 where id = $1 returning fields", [store, JSON.stringify({ parking: "あり", brands: " A / B ", seats: "3", site: "https://ex.example/shibuya", manager: "山田", unknown: "x" })])).rows[0]!.fields);
    expect(row).toEqual({ parking: "あり", brands: "A / B", seats: 3, site: "https://ex.example/shibuya", manager: "山田" });
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update stores set fields = $2 where id = $1", [store, JSON.stringify({ parking: "たぶん" })])))).toMatch(/store_field_invalid:parking/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update stores set fields = $2 where id = $1", [store, JSON.stringify({ site: "javascript:alert(1)" })])))).toMatch(/store_field_invalid:site/);
    const pub = await asAnon(async (c) => (await c.query<{ r: J[] }>("select shop_store_list($1) as r", [f.shopId])).rows[0]!.r);
    expect(pub[0]!["fields"]).toEqual({ parking: "あり", brands: "A / B", seats: 3, site: "https://ex.example/shibuya" });
    expect((pub[0]!["field_defs"] as J[]).map((d) => d["key"])).toEqual(["parking", "brands", "seats", "site"]);
    expect(pub[0]).not.toHaveProperty("external_ref");
  });

  it("AI 用 API: 一覧に private と外部コード。stores:write は使っている店舗の値と外部コードだけ（id か ext:<コード>）", async () => {
    const raw = `banto_${randomUUID()}`;
    await asUser(member, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, '{shop:read,stores:write}')", [f.shopId, member, hash(raw), raw.slice(0, 12)]));
    const t = hash(raw);
    const r = await api<J>("api_store_update", [t, store, JSON.stringify({ external_ref: "S-001", fields: { brands: "C", manager: null } })]);
    expect(r).toMatchObject({ id: store, external_ref: "S-001", fields: { parking: "あり", brands: "C", seats: 3, site: "https://ex.example/shibuya" } });
    expect(await api<J>("api_store_update", [t, "ext:S-001", JSON.stringify({ fields: { seats: 4 } })])).toMatchObject({ fields: { seats: 4 } });
    expect(((await api<J[]>("api_stores_list", [t]))[0]!)).toMatchObject({ external_ref: "S-001", fields: { seats: 4 } });
    // 使っていない店舗・よそ・決まった欄・知らない項目は書けない
    expect(await expectDbError(() => api("api_store_update", [t, unused, JSON.stringify({ fields: { brands: "x" } })]))).toMatch(/not_found/);
    expect(await expectDbError(() => api("api_store_update", [t, store, JSON.stringify({ name: "改名" })]))).toMatch(/invalid_store_values/);
    expect(await expectDbError(() => api("api_store_update", [t, store, JSON.stringify({ fields: { nothing: 1 } })]))).toMatch(/store_field_invalid:nothing/);
    // 外部コードは組織の中で重ならない
    await getPool().query("update stores set external_ref = 'S-002' where id = $1", [unused]);
    expect(await expectDbError(() => api("api_store_update", [t, store, JSON.stringify({ external_ref: "S-002" })]))).toMatch(/external_ref_taken/);
    // stores の項目の無い人は発行できない
    expect(await expectDbError(() => asUser(other.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, 'x', '{stores:write}')", [f.shopId, other.ownerId, hash("y")])))).toMatch(/.+/);
  });
});
