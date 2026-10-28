import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/**
 * 0072_theme_api: AI 用トークンでテーマを取り込む（theme:write）・公開する（theme:publish）。どちらも項目 design。
 * 版はトークンのショップのものだけ。公開は置き終えた版・独自ドメインのあるショップだけ。だれがは監査ログにトークンで残る
 */
describe.skipIf(!dbAvailable)("テーマの AI 用 API（0072）", () => {
  let f: Fixture;
  let other: Fixture;
  let orgId: string;
  let designer: string;
  let catalogOnly: string;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "ta-owner@example.com", slug: "ta-shop", publish: true });
    other = await createShopFixture({ email: "ta-other@example.com", slug: "ta-other", publish: true });
    const pool = getPool();
    orgId = (await pool.query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    designer = await createAuthUser("ta-design@example.com");
    catalogOnly = await createAuthUser("ta-catalog@example.com");
    for (const [uid, email, perms] of [[designer, "ta-design@example.com", ["design", "integrations"]], [catalogOnly, "ta-catalog@example.com", ["catalog", "integrations"]]] as const) {
      await asUser(f.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, email, JSON.stringify([{ shop_id: f.shopId, perms }]), hash(`t-${email}`)]));
      await withRole("authenticated", { sub: uid, email }, (c) => c.query("select org_invitation_accept($1)", [hash(`t-${email}`)]));
    }
    await pool.query("update shops set domain = 'ta.example.com' where id = $1", [f.shopId]);
  });
  afterAll(closePool);

  const issue = async (uid: string, shopId: string, scopes: string[]) => {
    const raw = `banto_${randomUUID()}`;
    await asUser(uid, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [shopId, uid, hash(raw), raw.slice(0, 12), scopes]));
    return hash(raw);
  };
  const api = <T>(fn: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);
  const create = (tok: string, name = "版") => api<J>("api_theme_create", [tok, randomUUID(), name, 1200, 5, JSON.stringify({ theme_name: "T" })]);

  it("theme:write で足す・置き終える・一覧・1 件。版はトークンのショップのもの。ほかのショップの版は見えない", async () => {
    const tok = await issue(designer, f.shopId, ["theme:write"]);
    const v = await create(tok, "最初");
    expect(v).toMatchObject({ name: "最初", complete: false, published: false, shop_id: f.shopId, storage_key: `themes/${f.shopId}/${v["id"]}/bundle.json`, manifest: { theme_name: "T" } });
    const list = await api<{ items: J[]; published_id: string | null; domain: string; site_plan: string; max_versions: number; shop_published: boolean }>("api_themes_list", [tok]);
    expect(list).toMatchObject({ published_id: null, domain: "ta.example.com", site_plan: "free", max_versions: 20, shop_published: true });
    expect(list.items.map((x) => x["id"])).toEqual([v["id"]]);
    expect(await api<J>("api_theme_complete", [tok, v["id"]])).toMatchObject({ complete: true });
    expect(await api<J>("api_theme_get", [tok, v["id"]])).toMatchObject({ complete: true, shop_id: f.shopId });
    // 作った人は発行者
    expect((await getPool().query<{ created_by: string }>("select created_by from theme_versions where id = $1", [v["id"]])).rows[0]!.created_by).toBe(designer);
    // ほかのショップの版
    const otherTok = await issue(other.ownerId, other.shopId, ["theme:write", "theme:publish"]);
    expect(await expectDbError(() => api("api_theme_get", [otherTok, v["id"]]))).toMatch(/not_found/);
    expect(await expectDbError(() => api("api_theme_complete", [otherTok, v["id"]]))).toMatch(/not_found/);
    expect(await expectDbError(() => api("api_theme_delete", [otherTok, v["id"]]))).toMatch(/not_found/);
    expect(await expectDbError(() => api("api_theme_publish", [otherTok, v["id"]]))).toMatch(/not_found/);
    expect(await expectDbError(() => api("api_theme_preview", [otherTok, v["id"]]))).toMatch(/not_found/);
  });

  it("公開は theme:publish だけ。置き終えていない版・独自ドメインの無いショップは断る。監査ログの「だれが」はトークン", async () => {
    const write = await issue(designer, f.shopId, ["theme:write"]);
    const both = await issue(designer, f.shopId, ["theme:write", "theme:publish"]);
    const v = await create(write);
    expect(await expectDbError(() => api("api_theme_publish", [write, v["id"]]))).toMatch(/unauthorized/);
    expect(await expectDbError(() => api("api_theme_publish", [both, v["id"]]))).toMatch(/theme_incomplete/);
    await api("api_theme_complete", [write, v["id"]]);
    await getPool().query("update shops set domain = null where id = $1", [f.shopId]);
    expect(await expectDbError(() => api("api_theme_publish", [both, v["id"]]))).toMatch(/theme_requires_domain/);
    expect(await expectDbError(() => api("api_theme_preview", [write, v["id"]]))).toMatch(/theme_requires_domain/);
    await getPool().query("update shops set domain = 'ta.example.com' where id = $1", [f.shopId]);
    expect(await api<J>("api_theme_publish", [both, v["id"]])).toEqual({ published_id: v["id"] });
    expect((await getPool().query<{ theme_version_id: string }>("select theme_version_id from shops where id = $1", [f.shopId])).rows[0]!.theme_version_id).toBe(v["id"]);
    // 公開中は消せない。取り下げてから
    expect(await expectDbError(() => api("api_theme_delete", [write, v["id"]]))).toMatch(/theme_published/);
    expect((await api<{ items: J[] }>("api_themes_list", [write])).items.find((x) => x["id"] === v["id"])).toMatchObject({ published: true });
    expect(await api<J>("api_theme_publish", [both, null])).toEqual({ published_id: null });
    expect(await api<string>("api_theme_delete", [write, v["id"]])).toBe(`themes/${f.shopId}/${v["id"]}/`);
    const tokenId = (await getPool().query<{ id: string }>("select id from api_tokens where token_hash = $1", [both])).rows[0]!.id;
    const rows = (await getPool().query<{ actor_kind: string; actor_id: string; detail: J }>("select actor_kind, actor_id, detail from audit_log where shop_id = $1 and action = 'shop.theme_published' order by id", [f.shopId])).rows;
    expect(rows.slice(-2)).toEqual([
      { actor_kind: "api_token", actor_id: tokenId, detail: { from: null, to: v["id"] } },
      { actor_kind: "api_token", actor_id: tokenId, detail: { from: v["id"], to: null } },
    ]);
  });

  it("プレビューは監査ログに残す。公開前のショップでは出さない", async () => {
    const tok = await issue(designer, f.shopId, ["theme:write"]);
    const v = await create(tok);
    expect(await api<J>("api_theme_preview", [tok, v["id"]])).toEqual({ shop_id: f.shopId, slug: "ta-shop", domain: "ta.example.com" });
    const row = (await getPool().query<{ actor_kind: string; detail: J }>("select actor_kind, detail from audit_log where shop_id = $1 and action = 'shop.theme_previewed' order by id desc limit 1", [f.shopId])).rows[0]!;
    expect(row).toEqual({ actor_kind: "api_token", detail: { version: v["id"] } });
    await getPool().query("update shops set published = false where id = $1", [f.shopId]);
    expect(await expectDbError(() => api("api_theme_preview", [tok, v["id"]]))).toMatch(/shop_unpublished/);
    await getPool().query("update shops set published = true where id = $1", [f.shopId]);
  });

  it("スコープは design の項目を持つ人だけが付けられる。項目を外すとトークンも効かなくなる。版の数の上限", async () => {
    expect(await expectDbError(() => issue(catalogOnly, f.shopId, ["theme:write"]))).toMatch(/scope_not_permitted/);
    const tok = await issue(designer, f.shopId, ["theme:write"]);
    // 上限まで足す（既存の版を含めて 20）
    const have = (await getPool().query<{ n: number }>("select count(*)::int as n from theme_versions where shop_id = $1", [f.shopId])).rows[0]!.n;
    for (let i = have; i < 20; i++) await create(tok, `v${i}`);
    expect(await expectDbError(() => create(tok))).toMatch(/theme_versions_full/);
    // 項目を外す
    await asUser(f.ownerId, (c) => c.query("select org_member_set($1, $2, 'member', $3::jsonb)", [orgId, designer, JSON.stringify([{ shop_id: f.shopId, perms: ["integrations"] }])]));
    expect(await expectDbError(() => api("api_themes_list", [tok]))).toMatch(/unauthorized/);
    // 直接は呼べない
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select api_themes_list($1)", [tok])))).toMatch(/permission denied/);
  });
});
