import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/**
 * 0080_mod_pages_publishing: 予約公開・ゴミ箱・リビジョン・メディアライブラリ。
 * お客様（anon）に見えるのは公開中・公開の日時を過ぎた・ゴミ箱に無いページだけ。リビジョンはトリガーだけが書く
 */
describe.skipIf(!dbAvailable)("ショップのページの予約公開・ゴミ箱・リビジョン（0080）", () => {
  let f: Fixture;
  let catalogOnly: string;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "pp-owner@example.com", slug: "pp-shop", publish: true });
    await getPool().query("update shops set settings = jsonb_set(settings, '{modules}', '{\"pages\": true}'::jsonb) where id = $1", [f.shopId]);
    const orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    catalogOnly = await createAuthUser("pp-catalog@example.com");
    await asUser(f.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, "pp-catalog@example.com", JSON.stringify([{ shop_id: f.shopId, perms: ["catalog"] }]), hash("t-c")]));
    await withRole("authenticated", { sub: catalogOnly, email: "pp-catalog@example.com" }, (c) => c.query("select org_invitation_accept($1)", [hash("t-c")]));
  });
  afterAll(closePool);

  const insert = (fields: { handle: string; published_at?: string | null; nav?: string }) =>
    asUser(f.ownerId, async (c) =>
      (await c.query<{ id: string }>("insert into pages (shop_id, handle, title, body, published, published_at, nav) values ($1, $2, 't', 'b', true, $3, $4) returning id", [f.shopId, fields.handle, fields.published_at ?? null, fields.nav ?? "header"])).rows[0]!.id,
    );
  const anonHandles = async () => (await asAnon((c) => c.query<{ handle: string }>("select handle from pages where shop_id = $1 order by handle", [f.shopId]))).rows.map((r) => r.handle);
  const nav = async () => ((await asAnon(async (c) => (await c.query<{ r: J }>("select shop_public_get('pp-shop') as r")).rows[0]!.r))["pages_nav"] as J[]).map((p) => p["handle"]);

  it("予約公開: 公開の日時が来るまでお客様にもメニューにも出ない", async () => {
    await insert({ handle: "now" });
    const later = await insert({ handle: "later", published_at: new Date(Date.now() + 3600_000).toISOString() });
    await insert({ handle: "past", published_at: new Date(Date.now() - 3600_000).toISOString() });
    expect(await anonHandles()).toEqual(["now", "past"]);
    expect(await nav()).toEqual(expect.arrayContaining(["now", "past"]));
    expect(await nav()).not.toContain("later");
    await getPool().query("update pages set published_at = now() - interval '1 second' where id = $1", [later]);
    expect(await anonHandles()).toEqual(["later", "now", "past"]);
  });

  it("ゴミ箱: お客様に見えず、同じ名前で作り直せる。戻すとき重なれば 23505。空にするのは service_role だけで、30 日を過ぎたものだけ", async () => {
    const id = (await getPool().query<{ id: string }>("select id from pages where shop_id = $1 and handle = 'now'", [f.shopId])).rows[0]!.id;
    await asUser(f.ownerId, (c) => c.query("update pages set deleted_at = now() where id = $1", [id]));
    expect(await anonHandles()).not.toContain("now");
    expect(await nav()).not.toContain("now");
    await insert({ handle: "now" });
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update pages set deleted_at = null where id = $1", [id])))).toMatch(/duplicate key/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select pages_purge_trash(30)")))).toMatch(/permission denied/);
    expect((await asService((c) => c.query<{ n: number }>("select pages_purge_trash(30) as n"))).rows[0]!.n).toBe(0);
    await getPool().query("update pages set deleted_at = now() - interval '31 days' where id = $1", [id]);
    expect((await asService((c) => c.query<{ n: number }>("select pages_purge_trash(30) as n"))).rows[0]!.n).toBe(1);
    expect((await getPool().query("select 1 from pages where id = $1", [id])).rowCount).toBe(0);
  });

  it("リビジョン: タイトルか本文が変わった保存で前の版を残し、20 まで。読めるのは content の人だけで、だれも書けない", async () => {
    const id = await insert({ handle: "rev" });
    await asUser(f.ownerId, (c) => c.query("update pages set nav = 'footer' where id = $1", [id]));
    expect((await getPool().query("select 1 from page_revisions where page_id = $1", [id])).rowCount).toBe(0);
    for (let i = 1; i <= 23; i++) await asUser(f.ownerId, (c) => c.query("update pages set body = $2 where id = $1", [id, `本文 ${i}`]));
    const revs = (await asUser(f.ownerId, (c) => c.query<{ body: string; created_by: string }>("select body, created_by from page_revisions where page_id = $1 order by created_at desc, id desc", [id]))).rows;
    expect(revs).toHaveLength(20);
    expect(revs[0]).toMatchObject({ body: "本文 22", created_by: f.ownerId });
    expect((await asUser(catalogOnly, (c) => c.query("select 1 from page_revisions where page_id = $1", [id]))).rowCount).toBe(0);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("insert into page_revisions (shop_id, page_id, title, body) values ($1, $2, 'x', 'y')", [f.shopId, id])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("delete from page_revisions where page_id = $1", [id])))).toMatch(/permission denied/);
    expect((await asAnon((c) => c.query("select 1 from page_revisions").catch((e: Error) => e.message))) as unknown).toMatch(/permission denied/);
  });

  it("メディアライブラリ: content の人が自分のショップの置き場の鍵だけ記録できる。アイキャッチの URL は形を確かめる", async () => {
    const add = (uid: string, key: string) => asUser(uid, (c) => c.query("insert into page_media (shop_id, storage_key, url) values ($1, $2, $3)", [f.shopId, key, `https://media.example/${key}`]));
    await add(f.ownerId, `pages/${f.shopId}/a.webp`);
    expect(await expectDbError(() => add(f.ownerId, "pages/00000000-0000-4000-8000-000000000000/b.webp"))).toMatch(/row-level security/);
    expect(await expectDbError(() => add(catalogOnly, `pages/${f.shopId}/c.webp`))).toMatch(/row-level security/);
    expect((await asUser(f.ownerId, (c) => c.query("select url from page_media where shop_id = $1", [f.shopId]))).rows).toHaveLength(1);
    // 一覧用の縮小版の URL（0082）も同じ形だけ
    await asUser(f.ownerId, (c) => c.query("insert into page_media (shop_id, storage_key, url, thumb_url) values ($1, $2, $3, $4)", [f.shopId, `pages/${f.shopId}/t.webp`, "https://media.example/t.webp", "https://media.example/t.thumb.webp"]));
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("insert into page_media (shop_id, storage_key, url, thumb_url) values ($1, $2, $3, $4)", [f.shopId, `pages/${f.shopId}/u.webp`, "https://media.example/u.webp", "javascript:alert(1)"])))).toMatch(/check constraint/);
    await asUser(f.ownerId, (c) => c.query("delete from page_media where storage_key = $1", [`pages/${f.shopId}/t.webp`]));
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update pages set image_url = 'javascript:alert(1)' where shop_id = $1", [f.shopId])))).toMatch(/check constraint/);
    await asUser(f.ownerId, (c) => c.query("update pages set image_url = 'https://media.example/pages/x.webp' where shop_id = $1 and handle = 'rev'", [f.shopId]));
  });
});
