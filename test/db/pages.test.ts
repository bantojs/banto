import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/**
 * 0079_mod_pages: ショップのページ（同梱モジュール pages）。書けるのは content の項目を持つ人（と owner）だけ。
 * お客様の画面（anon）は公開中のショップの公開中のページだけ。メニューに出すページは shop_public_get の pages_nav（モジュールが ON のときだけ）
 */
describe.skipIf(!dbAvailable)("ショップのページ（0079）", () => {
  let f: Fixture;
  let other: Fixture;
  let writer: string;
  let catalogOnly: string;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "pg-owner@example.com", slug: "pg-shop", publish: true });
    other = await createShopFixture({ email: "pg-other@example.com", slug: "pg-other", publish: true });
    const orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    writer = await createAuthUser("pg-content@example.com");
    catalogOnly = await createAuthUser("pg-catalog@example.com");
    for (const [uid, email, perms] of [[writer, "pg-content@example.com", ["content"]], [catalogOnly, "pg-catalog@example.com", ["catalog"]]] as const) {
      await asUser(f.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, email, JSON.stringify([{ shop_id: f.shopId, perms }]), hash(`t-${email}`)]));
      await withRole("authenticated", { sub: uid, email }, (c) => c.query("select org_invitation_accept($1)", [hash(`t-${email}`)]));
    }
  });
  afterAll(closePool);

  const insert = (uid: string, shopId: string, fields: { handle: string; title?: string; published?: boolean; nav?: string; sort_order?: number }) =>
    asUser(uid, async (c) =>
      (await c.query<{ id: string }>("insert into pages (shop_id, handle, title, body, published, nav, sort_order) values ($1, $2, $3, '# 見出し', $4, $5, $6) returning id", [shopId, fields.handle, fields.title ?? "ページ", fields.published ?? false, fields.nav ?? "none", fields.sort_order ?? 0])).rows[0]!.id,
    );
  const publicShop = async (slug: string) => (await asAnon(async (c) => (await c.query<{ r: J }>("select shop_public_get($1) as r", [slug])).rows[0]!.r));

  it("content の項目を持つ人と owner は書けて、ほかの項目の人・ほかのショップの人は書けない", async () => {
    await insert(writer, f.shopId, { handle: "about", title: "私たちについて", published: true, nav: "header" });
    await insert(f.ownerId, f.shopId, { handle: "faq", title: "よくある質問", published: true, nav: "footer", sort_order: 1 });
    expect(await expectDbError(() => insert(catalogOnly, f.shopId, { handle: "x" }))).toMatch(/row-level security/);
    expect(await expectDbError(() => insert(other.ownerId, f.shopId, { handle: "y" }))).toMatch(/row-level security/);
    // 読めるのも content の人と owner だけ（下書きを含む）
    await insert(writer, f.shopId, { handle: "draft" });
    expect((await asUser(writer, (c) => c.query("select handle from pages where shop_id = $1 order by handle", [f.shopId]))).rows.map((r) => r.handle)).toEqual(["about", "draft", "faq"]);
    expect((await asUser(catalogOnly, (c) => c.query("select handle from pages where shop_id = $1 and not published", [f.shopId]))).rows).toEqual([]);
    // 別のショップへ移せない
    expect(await expectDbError(() => asUser(writer, (c) => c.query("update pages set shop_id = $1 where handle = 'draft' and shop_id = $2", [other.shopId, f.shopId])))).toMatch(/row-level security/);
  });

  it("お客様（anon）は公開中のショップの公開中のページだけ読める。書けない", async () => {
    const rows = (await asAnon((c) => c.query<{ handle: string }>("select handle from pages where shop_id = $1 order by handle", [f.shopId]))).rows;
    expect(rows.map((r) => r.handle)).toEqual(["about", "faq"]);
    expect(await expectDbError(() => asAnon((c) => c.query("insert into pages (shop_id, handle, title) values ($1, 'z', 'z')", [f.shopId])))).toMatch(/permission denied|row-level security/);
    await getPool().query("update shops set published = false where id = $1", [f.shopId]);
    expect((await asAnon((c) => c.query("select handle from pages where shop_id = $1", [f.shopId]))).rows).toEqual([]);
    await getPool().query("update shops set published = true where id = $1", [f.shopId]);
  });

  it("ハンドルの形と予約の名前、長さの上限、ショップの中で重ならない", async () => {
    for (const bad of ["About", "-a", "a-", "a_b", "legal", "shipping", "cart", "x".repeat(65), ""]) {
      expect(await expectDbError(() => insert(f.ownerId, f.shopId, { handle: bad })), bad).toMatch(/check constraint|violates/);
    }
    expect(await expectDbError(() => insert(f.ownerId, f.shopId, { handle: "about" }))).toMatch(/duplicate key/);
    await insert(other.ownerId, other.shopId, { handle: "about" });
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("insert into pages (shop_id, handle, title, body) values ($1, 'long', 't', $2)", [f.shopId, "a".repeat(50001)])))).toMatch(/check constraint/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("insert into pages (shop_id, handle, title, template_suffix) values ($1, 'tpl', 't', '../x')", [f.shopId])))).toMatch(/check constraint/);
  });

  it("メニューに出すページは shop_public_get の pages_nav。モジュールが ON のときだけ、公開中で nav のあるものを並び順で", async () => {
    expect((await publicShop("pg-shop"))["pages_nav"]).toEqual([]);
    await getPool().query("update shops set settings = jsonb_set(settings, '{modules}', '{\"pages\": true}'::jsonb) where id = $1", [f.shopId]);
    expect((await publicShop("pg-shop"))["pages_nav"]).toEqual([
      { handle: "about", title: "私たちについて", nav: "header" },
      { handle: "faq", title: "よくある質問", nav: "footer" },
    ]);
    await asUser(writer, (c) => c.query("update pages set published = false where shop_id = $1 and handle = 'faq'", [f.shopId]));
    expect(((await publicShop("pg-shop"))["pages_nav"] as J[]).map((p) => p["handle"])).toEqual(["about"]);
  });

  it("content は組織のメンバーの項目に入れられる。1 つのショップに 100 まで、プランの上限 pages", async () => {
    expect((await getPool().query<{ a: string[] }>("select banto_shop_perms_all() as a")).rows[0]!.a).toContain("content");
    await getPool().query("select site_settings_set('plan_limits', $1::jsonb)", [JSON.stringify({ pages: 6 })]);
    const n = Number((await getPool().query<{ n: string }>("select count(*) as n from pages")).rows[0]!.n);
    for (let i = n; i < 6; i++) await insert(f.ownerId, f.shopId, { handle: `p${i}` });
    expect(await expectDbError(() => insert(f.ownerId, f.shopId, { handle: "over" }))).toMatch(/plan_limit_exceeded:pages:6/);
    const usage = await asService(async (c) => (await c.query<{ r: { usage: Record<string, number> } }>("select banto_plan_usage() as r")).rows[0]!.r);
    expect(usage.usage["pages"]).toBe(6);
    await getPool().query("select site_settings_set('plan_limits', '{}'::jsonb)");
    const have = Number((await getPool().query<{ n: string }>("select count(*) as n from pages where shop_id = $1", [f.shopId])).rows[0]!.n);
    await getPool().query("insert into pages (shop_id, handle, title) select $1, 'bulk' || g, 't' from generate_series(1, $2) g", [f.shopId, 100 - have]);
    expect(await expectDbError(() => insert(f.ownerId, f.shopId, { handle: "full" }))).toMatch(/pages_full/);
  });
});
