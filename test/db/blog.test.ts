import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/**
 * 0081_mod_blog: ブログと記事。書けるのは content の項目の人。お客様（anon）に見えるのは公開中・日時を過ぎた・ゴミ箱の外の記事だけ。
 * 記事はブログと同じショップ、タグは整える、公開したら published_at が入る。リビジョンはトリガーだけが書く
 */
describe.skipIf(!dbAvailable)("ブログと記事（0081）", () => {
  let f: Fixture;
  let other: Fixture;
  let catalogOnly: string;
  let blogId: string;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "bl-owner@example.com", slug: "bl-shop", publish: true });
    other = await createShopFixture({ email: "bl-other@example.com", slug: "bl-other", publish: true });
    await getPool().query("update shops set settings = jsonb_set(settings, '{modules}', '{\"blog\": true}'::jsonb) where id = $1", [f.shopId]);
    const orgId = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    catalogOnly = await createAuthUser("bl-catalog@example.com");
    await asUser(f.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, "bl-catalog@example.com", JSON.stringify([{ shop_id: f.shopId, perms: ["catalog"] }]), hash("t-c")]));
    await withRole("authenticated", { sub: catalogOnly, email: "bl-catalog@example.com" }, (c) => c.query("select org_invitation_accept($1)", [hash("t-c")]));
  });
  afterAll(closePool);

  const newArticle = (uid: string, fields: { handle: string; blog?: string; shop?: string; published?: boolean; published_at?: string | null; tags?: string[] }) =>
    asUser(uid, async (c) =>
      (
        await c.query<{ id: string; published_at: string | null; tags: string[] }>(
          "insert into articles (shop_id, blog_id, handle, title, body, published, published_at, tags) values ($1, $2, $3, 't', 'b', $4, $5, $6) returning id, published_at, tags",
          [fields.shop ?? f.shopId, fields.blog ?? blogId, fields.handle, fields.published ?? true, fields.published_at ?? null, fields.tags ?? []],
        )
      ).rows[0]!,
    );
  const anonArticles = async () => (await asAnon((c) => c.query<{ handle: string }>("select handle from articles where blog_id = $1 order by published_at desc", [blogId]))).rows.map((r) => r.handle);

  it("ブログは content の人と owner が作れ、ほかの項目の人は作れない。お客様は公開中のショップのブログを読める。メニューは blogs_nav", async () => {
    blogId = (await asUser(f.ownerId, (c) => c.query<{ id: string }>("insert into blogs (shop_id, handle, title, nav) values ($1, 'news', 'お知らせ', 'header') returning id", [f.shopId]))).rows[0]!.id;
    expect(await expectDbError(() => asUser(catalogOnly, (c) => c.query("insert into blogs (shop_id, handle, title) values ($1, 'x', 'x')", [f.shopId])))).toMatch(/row-level security/);
    expect((await asAnon((c) => c.query("select handle from blogs where shop_id = $1", [f.shopId]))).rows).toEqual([{ handle: "news" }]);
    const shop = (await asAnon(async (c) => (await c.query<{ r: J }>("select shop_public_get('bl-shop') as r")).rows[0]!.r));
    expect(shop["blogs_nav"]).toEqual([{ handle: "news", title: "お知らせ", nav: "header" }]);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("insert into blogs (shop_id, handle, title) values ($1, 'News', 'x')", [f.shopId])))).toMatch(/check constraint/);
  });

  it("記事: 公開で published_at が入り、予約・下書き・ゴミ箱はお客様に見えない。タグは整える", async () => {
    const a = await newArticle(f.ownerId, { handle: "first", tags: [" 新作 ", "新作", "", "セール"] });
    expect(a.published_at).not.toBeNull();
    expect(a.tags).toEqual(["セール", "新作"]);
    await newArticle(f.ownerId, { handle: "later", published_at: new Date(Date.now() + 3600_000).toISOString() });
    await newArticle(f.ownerId, { handle: "draft", published: false });
    const trashed = await newArticle(f.ownerId, { handle: "gone" });
    await asUser(f.ownerId, (c) => c.query("update articles set deleted_at = now() where id = $1", [trashed.id]));
    expect(await anonArticles()).toEqual(["first"]);
    // ゴミ箱の外で同じ名前は作れず、ゴミ箱の中と同じ名前は作れる
    expect(await expectDbError(() => newArticle(f.ownerId, { handle: "first" }))).toMatch(/duplicate key/);
    await newArticle(f.ownerId, { handle: "gone" });
    expect(await expectDbError(() => newArticle(f.ownerId, { handle: "feed" }))).toMatch(/check constraint/);
    expect(await expectDbError(() => newArticle(f.ownerId, { handle: "long-tag", tags: ["x".repeat(51)] }))).toMatch(/article_tag_too_long/);
  });

  it("記事はブログと同じショップだけ。ほかのショップの人・ほかの項目の人は書けない", async () => {
    const otherBlog = (await asUser(other.ownerId, (c) => c.query<{ id: string }>("insert into blogs (shop_id, handle, title) values ($1, 'news', 'x') returning id", [other.shopId]))).rows[0]!.id;
    expect(await expectDbError(() => newArticle(f.ownerId, { handle: "mix", blog: otherBlog }))).toMatch(/article_blog_mismatch|row-level security/);
    expect(await expectDbError(() => newArticle(other.ownerId, { handle: "mix2", blog: blogId, shop: other.shopId }))).toMatch(/article_blog_mismatch/);
    expect(await expectDbError(() => newArticle(catalogOnly, { handle: "nope" }))).toMatch(/row-level security/);
  });

  it("リビジョンはタイトルか本文が変わったときだけ、読めるのは content の人。ゴミ箱を空にするのは service_role で 30 日を過ぎたものだけ", async () => {
    const a = await newArticle(f.ownerId, { handle: "rev" });
    await asUser(f.ownerId, (c) => c.query("update articles set tags = '{a}' where id = $1", [a.id]));
    await asUser(f.ownerId, (c) => c.query("update articles set body = 'b2' where id = $1", [a.id]));
    expect((await asUser(f.ownerId, (c) => c.query("select body from article_revisions where article_id = $1", [a.id]))).rows).toEqual([{ body: "b" }]);
    expect((await asUser(catalogOnly, (c) => c.query("select 1 from article_revisions where article_id = $1", [a.id]))).rowCount).toBe(0);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("insert into article_revisions (shop_id, article_id, title, body) values ($1, $2, 'x', 'y')", [f.shopId, a.id])))).toMatch(/permission denied/);
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("select articles_purge_trash(30)")))).toMatch(/permission denied/);
    await getPool().query("update articles set deleted_at = now() - interval '31 days' where id = $1", [a.id]);
    expect((await asService((c) => c.query<{ n: number }>("select articles_purge_trash(30) as n"))).rows[0]!.n).toBe(1);
  });

  it("プランの上限 articles", async () => {
    const n = Number((await getPool().query<{ n: string }>("select count(*) as n from articles")).rows[0]!.n);
    await getPool().query("select site_settings_set('plan_limits', $1::jsonb)", [JSON.stringify({ articles: n })]);
    expect(await expectDbError(() => newArticle(f.ownerId, { handle: "over" }))).toMatch(/plan_limit_exceeded:articles:/);
    const usage = await asService(async (c) => (await c.query<{ r: { usage: Record<string, number> } }>("select banto_plan_usage() as r")).rows[0]!.r);
    expect(usage.usage["articles"]).toBe(n);
    await getPool().query("select site_settings_set('plan_limits', '{}'::jsonb)");
  });
});
