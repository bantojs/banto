import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/**
 * 0117_article_fields: ブログごとの記事の項目の定義（blogs.article_fields）と、記事の値（articles.fields）。
 * 定義の形・指すブログ、値の整え（定義に無い鍵は捨てる・空は持たない）と指す先（店舗・商品・記事）はトリガーが確かめる。
 * 絞り込みは fields @>（会員の一覧 articles_member_page の p_fields も）
 */
describe.skipIf(!dbAvailable)("記事の項目（0117）", () => {
  let f: Fixture;
  let other: Fixture;
  let staff: string;
  let styling: string;
  let otherBlog: string;
  let store: string;
  let otherStore: string;

  const q = <T = Record<string, unknown>>(uid: string, sql: string, params: unknown[] = []) => asUser(uid, async (c) => (await c.query(sql, params)).rows as T[]);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "af-owner@example.com", slug: "af-shop", publish: true });
    other = await createShopFixture({ email: "af-other@example.com", slug: "af-other", publish: true });
    for (const s of [f.shopId, other.shopId]) await getPool().query("update shops set settings = jsonb_set(settings, '{modules}', '{\"blog\": true}'::jsonb) where id = $1", [s]);
    staff = (await q<{ id: string }>(f.ownerId, "insert into blogs (shop_id, handle, title) values ($1, 'staff', 'スタッフ') returning id", [f.shopId]))[0]!.id;
    styling = (await q<{ id: string }>(f.ownerId, "insert into blogs (shop_id, handle, title) values ($1, 'styling', '着こなし') returning id", [f.shopId]))[0]!.id;
    otherBlog = (await q<{ id: string }>(other.ownerId, "insert into blogs (shop_id, handle, title) values ($1, 'x', 'x') returning id", [other.shopId]))[0]!.id;
    const org = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    const otherOrg = (await getPool().query<{ org_id: string }>("select org_id from shops where id = $1", [other.shopId])).rows[0]!.org_id;
    store = (await getPool().query<{ id: string }>("insert into stores (org_id, name) values ($1, '渋谷店') returning id", [org])).rows[0]!.id;
    otherStore = (await getPool().query<{ id: string }>("insert into stores (org_id, name) values ($1, '他店') returning id", [otherOrg])).rows[0]!.id;
    await getPool().query("insert into shop_stores (shop_id, store_id) values ($1, $2)", [f.shopId, store]);
    await getPool().query("insert into products (shop_id, slug, name, published) values ($1, 'coat', 'コート', true), ($1, 'knit', 'ニット', true)", [f.shopId]);
    await getPool().query("insert into products (shop_id, slug, name, published) values ($1, 'theirs', 'よそ', true)", [other.shopId]);
  });
  afterAll(closePool);

  const defs = (extra: unknown[] = []) => [
    { key: "height", label: "身長", type: "number" },
    { key: "store", label: "店舗", type: "store" },
    { key: "mood", label: "雰囲気", type: "select", options: ["きれいめ", "カジュアル"] },
    { key: "note", label: "ひとこと", type: "text" },
    ...extra,
  ];
  const setDefs = (blog: string, d: unknown) => q(f.ownerId, "update blogs set article_fields = $2 where id = $1", [blog, JSON.stringify(d)]);
  const addArticle = (blog: string, handle: string, fields: unknown, published = true) =>
    q<{ id: string; fields: Record<string, unknown> }>(f.ownerId, "insert into articles (shop_id, blog_id, handle, title, published, fields) values ($1, $2, $3, $3, $4, $5) returning id, fields", [f.shopId, blog, handle, published, JSON.stringify(fields)]).then((r) => r[0]!);

  it("定義: 形・キーの重なり・選択肢・指すブログ（同じショップだけ）を確かめる", async () => {
    await setDefs(staff, defs());
    for (const bad of [
      [{ key: "Bad", label: "x", type: "text" }],
      [{ key: "a", label: "x", type: "text" }, { key: "a", label: "y", type: "text" }],
      [{ key: "a", label: "x", type: "color" }],
      [{ key: "a", label: "x", type: "select" }],
      [{ key: "a", label: "x", type: "article", blog: otherBlog }],
      [{ key: "a", label: "x", type: "text", multiple: true }],
      [{ key: "a", label: "", type: "text" }],
    ]) expect(await expectDbError(() => setDefs(styling, bad))).toMatch(/article_fields_invalid/);
    await setDefs(styling, [{ key: "author", label: "書いた人", type: "article", blog: staff }, { key: "items", label: "着用アイテム", type: "product", multiple: true }]);
  });

  it("値: 定義に合わせて整え、定義に無い鍵と空は捨てる。指す先はこのショップのものだけ", async () => {
    const a = await addArticle(staff, "amada", { height: "158", store, mood: "きれいめ", note: "  よろしく  ", unknown: "x", empty: "" });
    expect(a.fields).toEqual({ height: 158, store, mood: "きれいめ", note: "よろしく" });
    for (const bad of [{ height: "高い" }, { mood: "派手" }, { store: otherStore }, { store: "x" }, { note: "あ".repeat(501) }])
      expect(await expectDbError(() => addArticle(staff, `bad-${randomUUID().slice(0, 8)}`, bad))).toMatch(/article_field_invalid/);
    await addArticle(staff, "kato", { height: 170 });
    const s1 = await addArticle(styling, "look-1", { author: "amada", items: ["knit", "coat", "knit"] });
    expect(s1.fields).toEqual({ author: "amada", items: ["knit", "coat"] });
    for (const bad of [{ author: "nobody" }, { items: ["theirs"] }, { author: ["amada", "kato"] }])
      expect(await expectDbError(() => addArticle(styling, `bad-${randomUUID().slice(0, 8)}`, bad))).toMatch(/article_field_invalid/);
    await addArticle(styling, "look-2", { author: "kato", items: "coat" }).then((r) => expect(r.fields).toEqual({ author: "kato", items: ["coat"] }));
  });

  it("絞り込み: fields @> と会員の一覧の p_fields。項目はお客様（anon）にも見える", async () => {
    const byAuthor = (await asAnon((c) => c.query<{ handle: string }>("select handle from articles where blog_id = $1 and fields @> $2 order by handle", [styling, JSON.stringify({ author: "amada" })]))).rows.map((r) => r.handle);
    expect(byAuthor).toEqual(["look-1"]);
    const byItem = (await asAnon((c) => c.query<{ handle: string }>("select handle from articles where blog_id = $1 and fields @> $2 order by handle", [styling, JSON.stringify({ items: ["coat"] })]))).rows.map((r) => r.handle);
    expect(byItem).toEqual(["look-1", "look-2"]);
    const member = (await asService((c) => c.query<{ r: { handle: string; fields: unknown }[] }>("select articles_member_page($1, $2, 0, 12, null, $3, 0, $4, null, $5) as r", [f.shopId, styling, randomUUID(), randomUUID(), JSON.stringify({ author: "kato" })]))).rows[0]!.r;
    expect(member.map((x) => x.handle)).toEqual(["look-2"]);
    expect(member[0]!.fields).toEqual({ author: "kato", items: ["coat"] });
  });

  it("位置だけの変更・ほかの列の変更では値を整え直さない（定義が変わっても残る）", async () => {
    await setDefs(staff, [{ key: "height", label: "身長", type: "number" }]);
    await q(f.ownerId, "update articles set title = 'あまだ' where blog_id = $1 and handle = 'amada'", [staff]);
    const row = (await q<{ fields: Record<string, unknown> }>(f.ownerId, "select fields from articles where blog_id = $1 and handle = 'amada'", [staff]))[0]!;
    expect(row.fields).toMatchObject({ height: 158, mood: "きれいめ" });
  });
});
