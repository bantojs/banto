import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/**
 * 0071_themes: Liquid のテーマの版。扱えるのは design の項目を持つ人だけ。公開は独自ドメインのあるショップだけ。
 * お客様の画面は shop_public_get の theme で公開中の版を受け取る。公開・取り下げは監査ログに残る
 */
describe.skipIf(!dbAvailable)("テーマ（0071）", () => {
  let f: Fixture;
  let other: Fixture;
  let orgId: string;
  let designer: string;
  let catalogOnly: string;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "th-owner@example.com", slug: "th-shop", publish: true });
    other = await createShopFixture({ email: "th-other@example.com", slug: "th-other", publish: true });
    const pool = getPool();
    orgId = (await pool.query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    designer = await createAuthUser("th-design@example.com");
    catalogOnly = await createAuthUser("th-catalog@example.com");
    for (const [uid, email, perms] of [[designer, "th-design@example.com", ["design"]], [catalogOnly, "th-catalog@example.com", ["catalog"]]] as const) {
      await asUser(f.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, email, JSON.stringify([{ shop_id: f.shopId, perms }]), hash(`t-${email}`)]));
      await withRole("authenticated", { sub: uid, email }, (c) => c.query("select org_invitation_accept($1)", [hash(`t-${email}`)]));
    }
  });
  afterAll(closePool);

  const create = (uid: string, shopId: string, name = "テーマ") =>
    asUser(uid, async (c) => (await c.query<{ id: string }>("select theme_version_create($1, $2, $3, 1200, 5, $4::jsonb, $5::jsonb) as id", [shopId, randomUUID(), name, JSON.stringify({ theme_name: "T" }), JSON.stringify({ accent: "#333" })])).rows[0]!.id);
  const publicTheme = async (slug: string) => (await asAnon(async (c) => (await c.query<{ r: J }>("select shop_public_get($1) as r", [slug])).rows[0]!.r))["theme"];

  it("design の項目を持つ人（と owner）だけが版を足し・読める。置き場の鍵は DB が決める。表は直接書けない", async () => {
    const id = await create(designer, f.shopId);
    const row = (await asUser(designer, (c) => c.query<{ storage_key: string; settings: J }>("select storage_key, settings from theme_versions where id = $1", [id]))).rows[0]!;
    expect(row.storage_key).toBe(`themes/${f.shopId}/${id}/bundle.json`);
    expect(row.settings).toEqual({ accent: "#333" });
    expect((await asUser(f.ownerId, (c) => c.query("select 1 from theme_versions where id = $1", [id]))).rowCount).toBe(1);
    expect((await asUser(catalogOnly, (c) => c.query("select 1 from theme_versions where id = $1", [id]))).rowCount).toBe(0);
    expect((await asUser(other.ownerId, (c) => c.query("select 1 from theme_versions where id = $1", [id]))).rowCount).toBe(0);
    expect(await expectDbError(() => create(catalogOnly, f.shopId))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => create(designer, other.shopId))).toMatch(/shop_not_found/);
    expect(await expectDbError(() => asAnon((c) => c.query("select theme_version_create($1, $2, 'x', 1, 1)", [f.shopId, randomUUID()])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update theme_versions set storage_key = 'x' where id = $1", [id])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("insert into theme_versions (shop_id, name, storage_key, size_bytes, file_count) values ($1, 'x', 'x', 1, 1)", [f.shopId])))).toMatch(/permission denied/);
  });

  it("公開は独自ドメインのあるショップだけ。公開中の版は shop_public_get の theme に出る。ドメインを外すと出なくなる", async () => {
    const id = await create(designer, f.shopId, "公開する版");
    expect(await expectDbError(() => asUser(designer, (c) => c.query("select theme_publish($1, $2)", [f.shopId, id])))).toMatch(/theme_requires_domain/);
    expect(await publicTheme("th-shop")).toBeNull();
    await getPool().query("update shops set domain = 'th.example.com' where id = $1", [f.shopId]);
    await asUser(designer, (c) => c.query("select theme_publish($1, $2)", [f.shopId, id]));
    expect(await publicTheme("th-shop")).toEqual({ id, storage_key: `themes/${f.shopId}/${id}/bundle.json`, settings: { accent: "#333" } });
    // ほかのショップの版は公開できない
    const foreign = await create(other.ownerId, other.shopId);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select theme_publish($1, $2)", [f.shopId, foreign])))).toMatch(/theme_not_found/);
    expect(await expectDbError(() => asUser(catalogOnly, (c) => c.query("select theme_publish($1, null)", [f.shopId])))).toMatch(/shop_not_found/);
    // 設定の値を変えると、そのまま出る
    await asUser(designer, (c) => c.query("select theme_version_set_settings($1, $2::jsonb)", [id, JSON.stringify({ accent: "#c33" })]));
    expect((await publicTheme("th-shop") as J)["settings"]).toEqual({ accent: "#c33" });
    await getPool().query("update shops set domain = null where id = $1", [f.shopId]);
    expect(await publicTheme("th-shop")).toBeNull();
    await getPool().query("update shops set domain = 'th.example.com' where id = $1", [f.shopId]);
    // 公開中の版は消せない。取り下げてから消せる。戻り値は置き場の接頭辞
    expect(await expectDbError(() => asUser(designer, (c) => c.query("select theme_version_delete($1)", [id])))).toMatch(/theme_published/);
    await asUser(designer, (c) => c.query("select theme_publish($1, null)", [f.shopId]));
    expect(await publicTheme("th-shop")).toBeNull();
    const prefix = (await asUser(designer, (c) => c.query<{ p: string }>("select theme_version_delete($1) as p", [id]))).rows[0]!.p;
    expect(prefix).toBe(`themes/${f.shopId}/${id}/`);
  });

  it("公開中の版は theme_publish を通してしか変えられない（settings の項目で shops を直接書き換えても止まる。外すのは消えたときだけ）", async () => {
    const id = await create(designer, f.shopId, "直接");
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update shops set theme_version_id = $2 where id = $1", [f.shopId, id])))).toMatch(/theme_version_readonly/);
    expect(await expectDbError(() => asService((c) => c.query("update shops set theme_version_id = $2 where id = $1", [f.shopId, id])))).toMatch(/theme_version_readonly/);
    // ほかの列の書き換えは今までどおり
    await asUser(f.ownerId, (c) => c.query("update shops set name = name where id = $1", [f.shopId]));
  });

  it("公開・取り下げは監査ログに残る（誰が・どの版から・どの版へ）", async () => {
    const id = await create(designer, f.shopId, "監査");
    await asUser(designer, (c) => c.query("select theme_publish($1, $2)", [f.shopId, id]));
    await asUser(f.ownerId, (c) => c.query("select theme_publish($1, null)", [f.shopId]));
    const rows = (await getPool().query<{ actor_id: string | null; detail: J }>("select actor_id, detail from audit_log where shop_id = $1 and action = 'shop.theme_published' order by created_at, id", [f.shopId])).rows.slice(-2);
    expect(rows.map((r) => r.detail)).toEqual([{ from: null, to: id }, { from: id, to: null }]);
    expect(rows.map((r) => r.actor_id)).toEqual([designer, f.ownerId]);
  });

  it("1 つのショップの版は 20 まで。ショップを消すと版も消える", async () => {
    const n = Number((await getPool().query<{ n: string }>("select count(*) as n from theme_versions where shop_id = $1", [f.shopId])).rows[0]!.n);
    for (let i = n; i < 20; i++) await create(f.ownerId, f.shopId, `v${i}`);
    expect(await expectDbError(() => create(f.ownerId, f.shopId, "21"))).toMatch(/theme_versions_full/);
    // 公開中の版があるショップも消せる（版の連鎖の削除と、公開中の版の守りがぶつからない）
    await getPool().query("update shops set domain = 'th-other.example.com' where id = $1", [other.shopId]);
    const pub = await create(other.ownerId, other.shopId, "公開中");
    await asUser(other.ownerId, (c) => c.query("select theme_publish($1, $2)", [other.shopId, pub]));
    await asService((c) => c.query("delete from shops where id = $1", [other.shopId]));
    expect(Number((await getPool().query<{ n: string }>("select count(*) as n from theme_versions where shop_id = $1", [other.shopId])).rows[0]!.n)).toBe(0);
  });

  it("design は組織のメンバーの項目に入れられる（0024 の検査）", async () => {
    const r = await getPool().query<{ perms: string[] }>("select perms from org_member_shops where user_id = $1 and shop_id = $2", [designer, f.shopId]);
    expect(r.rows[0]!.perms).toEqual(["design"]);
    expect((await getPool().query<{ a: string[] }>("select banto_shop_perms_all() as a")).rows[0]!.a).toContain("design");
  });
});
