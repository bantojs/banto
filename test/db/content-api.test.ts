import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { asAnon, asService, asUser, closePool, createAuthUser, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, withRole, type Fixture } from "./harness";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type J = Record<string, unknown>;

/**
 * 0083_api_content: ページと記事を AI 用トークンで読み書きする（content:read / content:write、項目 content）。
 * ページはモジュール pages、記事はモジュール blog が ON のショップだけ。公開も content:write、消すのはゴミ箱へ
 */
describe.skipIf(!dbAvailable)("ページと記事の AI 用 API（0083）", () => {
  let f: Fixture;
  let other: Fixture;
  let writer: string;
  let catalogOnly: string;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "ca-owner@example.com", slug: "ca-shop", publish: true });
    other = await createShopFixture({ email: "ca-other@example.com", slug: "ca-other", publish: true });
    const pool = getPool();
    const orgId = (await pool.query<{ org_id: string }>("select org_id from shops where id = $1", [f.shopId])).rows[0]!.org_id;
    writer = await createAuthUser("ca-writer@example.com");
    catalogOnly = await createAuthUser("ca-catalog@example.com");
    for (const [uid, email, perms] of [[writer, "ca-writer@example.com", ["content", "integrations"]], [catalogOnly, "ca-catalog@example.com", ["catalog", "integrations"]]] as const) {
      await asUser(f.ownerId, (c) => c.query("select org_invite($1, $2, 'member', $3::jsonb, $4)", [orgId, email, JSON.stringify([{ shop_id: f.shopId, perms }]), hash(`t-${email}`)]));
      await withRole("authenticated", { sub: uid, email }, (c) => c.query("select org_invitation_accept($1)", [hash(`t-${email}`)]));
    }
    await pool.query(`update shops set settings = jsonb_set(settings, '{modules}', '{"pages": true, "blog": true}'::jsonb) where id = any($1)`, [[f.shopId, other.shopId]]);
    await pool.query("insert into blogs (shop_id, handle, title) values ($1, 'news', 'お知らせ'), ($2, 'news', 'よそ')", [f.shopId, other.shopId]);
  });
  afterAll(closePool);

  const issue = async (uid: string, shopId: string, scopes: string[]) => {
    const raw = `banto_${randomUUID()}`;
    await asUser(uid, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, $5)", [shopId, uid, hash(raw), raw.slice(0, 12), scopes]));
    return hash(raw);
  };
  const api = <T>(fn: string, args: unknown[]) => asService(async (c) => (await c.query<{ r: T }>(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0]!.r);

  it("ページ: 作る（下書き）→ handle で直す → 公開 → お客様に見える。一覧の状態の絞り込み。ゴミ箱へ", async () => {
    const tok = await issue(writer, f.shopId, ["content:read", "content:write"]);
    const p = await api<J>("api_page_save", [tok, JSON.stringify({ handle: "about", title: " 私たちについて ", body: "## ようこそ", nav: "footer" })]);
    expect(p).toMatchObject({ handle: "about", title: "私たちについて", body: "## ようこそ", nav: "footer", published: false, status: "draft" });
    expect((await asAnon((c) => c.query("select 1 from pages where handle = 'about'"))).rows).toHaveLength(0);
    // handle が同じなら直す（送らなかった鍵はそのまま）。リビジョンはトリガーが残す
    const upd = await api<J>("api_page_save", [tok, JSON.stringify({ handle: "about", body: "## 新しい本文", published: true })]);
    expect(upd).toMatchObject({ id: p["id"], title: "私たちについて", body: "## 新しい本文", nav: "footer", status: "published" });
    expect((await getPool().query("select body from page_revisions where page_id = $1", [p["id"]])).rows).toEqual([{ body: "## ようこそ" }]);
    expect((await asAnon((c) => c.query("select title from pages where handle = 'about'"))).rows).toHaveLength(1);
    // 予約公開
    const later = new Date(Date.now() + 86400_000).toISOString();
    const sch = await api<J>("api_page_save", [tok, JSON.stringify({ handle: "sale", title: "セール", published: true, published_at: later })]);
    expect(sch["status"]).toBe("scheduled");
    const list = await api<{ items: J[]; total: number }>("api_pages_list", [tok, "all", null, 50, 0]);
    expect(list.items.map((x) => x["handle"]).sort()).toEqual(["about", "sale"]);
    expect(list.items[0]).not.toHaveProperty("body");
    expect((await api<{ total: number }>("api_pages_list", [tok, "scheduled", null, 50, 0])).total).toBe(1);
    expect(await api<J>("api_page_get", [tok, "about"])).toMatchObject({ id: p["id"], body: "## 新しい本文" });
    expect(await api<J>("api_page_get", [tok, p["id"]])).toMatchObject({ handle: "about" });
    // id で handle を変える。ほかのページと重なれば handle_taken
    expect(await expectDbError(() => api("api_page_save", [tok, JSON.stringify({ id: p["id"], handle: "sale" })]))).toMatch(/handle_taken/);
    // ゴミ箱へ → 一覧から消え、trash に出る。ゴミ箱のページは直せない
    expect(await api<J>("api_page_trash", [tok, sch["id"]])).toMatchObject({ status: "trash" });
    expect((await api<{ total: number }>("api_pages_list", [tok, null, null, 50, 0])).total).toBe(1);
    expect((await api<{ total: number }>("api_pages_list", [tok, "trash", null, 50, 0])).total).toBe(1);
    expect(await expectDbError(() => api("api_page_save", [tok, JSON.stringify({ id: sch["id"], title: "x" })]))).toMatch(/not_found/);
  });

  it("値の誤りは invalid_<鍵>。作るときは handle と title が要る", async () => {
    const tok = await issue(f.ownerId, f.shopId, ["content:write"]);
    const bad = (v: J) => expectDbError(() => api("api_page_save", [tok, JSON.stringify(v)]));
    expect(await bad({ handle: "Bad Handle", title: "x" })).toMatch(/invalid_handle/);
    expect(await bad({ handle: "cart", title: "x" })).toMatch(/invalid_handle/);
    expect(await bad({ handle: "ok", title: "" })).toMatch(/invalid_title/);
    expect(await bad({ handle: "ok", title: "x", body: "a".repeat(50001) })).toMatch(/invalid_content_body/);
    expect(await bad({ handle: "ok", title: "x", nav: "side" })).toMatch(/invalid_nav/);
    expect(await bad({ handle: "ok", title: "x", published: "yes" })).toMatch(/invalid_published/);
    expect(await bad({ handle: "ok", title: "x", published_at: "いつか" })).toMatch(/invalid_published_at/);
    expect(await bad({ handle: "ok", title: "x", image_url: "javascript:alert(1)" })).toMatch(/invalid_image_url/);
    expect(await bad({ handle: "ok" })).toMatch(/invalid_values_handle_title_required/);
  });

  it("記事: ブログの中に作る・直す・タグ・公開・ゴミ箱。ブログの一覧。ブログは自分のショップのものだけ", async () => {
    const tok = await issue(writer, f.shopId, ["content:read", "content:write"]);
    const a = await api<J>("api_article_save", [tok, "news", JSON.stringify({ handle: "hello", title: "はじめまして", body: "本文", tags: [" 新作 ", "セール", "新作"], published: true })]);
    expect(a).toMatchObject({ blog: "news", handle: "hello", tags: ["セール", "新作"], status: "published" });
    expect(a["published_at"]).not.toBeNull();
    const b = await api<J>("api_article_save", [tok, "news", JSON.stringify({ handle: "draft", title: "下書き" })]);
    expect(b["status"]).toBe("draft");
    expect(await api<J>("api_article_save", [tok, "news", JSON.stringify({ id: b["id"], excerpt: "抜粋", author: "店長" })])).toMatchObject({ handle: "draft", excerpt: "抜粋", author: "店長" });
    const blogs = await api<{ items: J[] }>("api_blogs_list", [tok]);
    expect(blogs.items).toEqual([expect.objectContaining({ handle: "news", articles: 2 })]);
    expect((await api<{ total: number }>("api_articles_list", [tok, "news", "published", null, null, 50, 0])).total).toBe(1);
    expect((await api<{ total: number }>("api_articles_list", [tok, "news", null, null, "セール", 50, 0])).total).toBe(1);
    expect(await api<J>("api_article_get", [tok, "news", "hello"])).toMatchObject({ body: "本文" });
    expect(await expectDbError(() => api("api_article_save", [tok, "news", JSON.stringify({ handle: "feed", title: "x" })]))).toMatch(/invalid_handle/);
    expect(await expectDbError(() => api("api_article_save", [tok, "news", JSON.stringify({ handle: "t", title: "x", tags: ["a".repeat(51)] })]))).toMatch(/invalid_tags/);
    expect(await expectDbError(() => api("api_articles_list", [tok, "none", null, null, null, 50, 0]))).toMatch(/not_found/);
    expect(await api<J>("api_article_trash", [tok, "news", b["id"]])).toMatchObject({ status: "trash" });
    // ほかのショップのトークンからは、同じ名前のブログでも自分のショップのものだけ
    const otherTok = await issue(other.ownerId, other.shopId, ["content:read", "content:write"]);
    expect((await api<{ total: number }>("api_articles_list", [otherTok, "news", null, null, null, 50, 0])).total).toBe(0);
    expect(await expectDbError(() => api("api_article_trash", [otherTok, "news", a["id"]]))).toMatch(/not_found/);
    expect(await expectDbError(() => api("api_page_trash", [otherTok, randomUUID()]))).toMatch(/not_found/);
  });

  it("スコープと項目: content:read では書けない。項目 content の無い人は content:* を発行できない。モジュールが OFF なら module_disabled", async () => {
    const ro = await issue(writer, f.shopId, ["content:read"]);
    expect(await expectDbError(() => api("api_page_save", [ro, JSON.stringify({ handle: "x", title: "x" })]))).toMatch(/unauthorized/);
    expect(await expectDbError(() => issue(catalogOnly, f.shopId, ["content:read"]))).toMatch(/scope|permission|row-level|invalid/);
    const tok = await issue(f.ownerId, f.shopId, ["content:read"]);
    await getPool().query(`update shops set settings = jsonb_set(settings, '{modules}', '{"pages": false, "blog": false}'::jsonb) where id = $1`, [f.shopId]);
    expect(await expectDbError(() => api("api_pages_list", [tok, null, null, 50, 0]))).toMatch(/module_disabled/);
    expect(await expectDbError(() => api("api_blogs_list", [tok]))).toMatch(/module_disabled/);
    await getPool().query(`update shops set settings = jsonb_set(settings, '{modules}', '{"pages": true, "blog": true}'::jsonb) where id = $1`, [f.shopId]);
  });
});
