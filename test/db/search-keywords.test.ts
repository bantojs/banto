import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { asAnon, asService, asUser, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";

/** 0163: 商品の検索用のキーワード（お客様には見せない、検索だけに使う） */
describe.skipIf(!dbAvailable)("検索用のキーワード（0163）", () => {
  let f: Fixture;
  const tok = `banto_${randomUUID()}`;
  const hash = (t: string) => createHash("sha256").update(t).digest("hex");
  type J = Record<string, unknown>;
  const list = (q: string) =>
    asAnon(async (c) => (await c.query<{ r: { items: { slug: string }[] } }>("select product_public_list($1, 'new', 100, null, 0, null, null, null, $2, null, false) as r", [f.shopId, q])).rows[0]!.r.items.map((x) => x.slug).sort());
  const keywords = async (id: string) => (await getPool().query<{ k: string | null }>("select search_keywords as k from products where id = $1", [id])).rows[0]!.k;

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "sk-owner@example.com", slug: "sk-shop", publish: true });
    await asUser(f.ownerId, (c) => c.query("insert into api_tokens (shop_id, owner_id, name, token_hash, prefix, scopes) values ($1, $2, 't', $3, $4, '{products:read,products:write}')", [f.shopId, f.ownerId, hash(tok), tok.slice(0, 12)]));
  });
  afterAll(closePool);

  it("運営者が書くと空白をそろえ、空なら null。200 文字を超えたら断る", async () => {
    await asUser(f.ownerId, (c) => c.query("update products set search_keywords = $1 where id = $2", ["  カットソー　　 型番ABC-12\n ", f.productId]));
    expect(await keywords(f.productId)).toBe("カットソー 型番ABC-12");
    await asUser(f.ownerId, (c) => c.query("update products set search_keywords = $1 where id = $2", [" 　 ", f.productId]));
    expect(await keywords(f.productId)).toBeNull();
    expect(await expectDbError(() => asUser(f.ownerId, (c) => c.query("update products set search_keywords = $1 where id = $2", ["あ".repeat(201), f.productId])))).toMatch(/search_keywords_too_long/);
  });

  it("お店の検索はキーワードでも当たる（ほかの語と AND）。匿名はキーワードの列を読めず、公開の関数も返さない", async () => {
    await asUser(f.ownerId, (c) => c.query("update products set search_keywords = 'ラッシュガード 水着' where id = $1", [f.productId]));
    const slug = (await getPool().query<{ slug: string }>("select slug from products where id = $1", [f.productId])).rows[0]!.slug;
    expect(await list("ラッシュガード")).toEqual([slug]);
    expect(await list("ラッシュガード 存在しない")).toEqual([]);
    expect(await expectDbError(() => asAnon((c) => c.query("select search_keywords from products")))).toMatch(/permission denied/);
    const detail = await asAnon(async (c) => (await c.query<{ r: unknown }>("select product_public_get($1, $2) as r", [f.shopId, slug])).rows[0]!.r);
    expect(JSON.stringify(detail)).not.toContain("ラッシュガード");
  });

  it("AI 用 API: 作成・更新で読み書きでき、null で外す。文字でなければ invalid_search_keywords", async () => {
    const p = await asService(async (c) => (await c.query<{ r: J }>("select api_product_create($1, $2) as r", [hash(tok), JSON.stringify({ slug: "kw", name: "kw", search_keywords: " 型番 X1 " })])).rows[0]!.r);
    expect(p["search_keywords"]).toBe("型番 X1");
    const u = await asService(async (c) => (await c.query<{ r: J }>("select api_product_update($1, $2, $3) as r", [hash(tok), p["id"], JSON.stringify({ name: "kw2" })])).rows[0]!.r);
    expect(u["search_keywords"]).toBe("型番 X1");
    const cleared = await asService(async (c) => (await c.query<{ r: J }>("select api_product_update($1, $2, $3) as r", [hash(tok), p["id"], JSON.stringify({ search_keywords: null })])).rows[0]!.r);
    expect(cleared["search_keywords"]).toBeNull();
    expect(await expectDbError(() => asService((c) => c.query("select api_product_update($1, $2, $3)", [hash(tok), p["id"], JSON.stringify({ search_keywords: 1 })])))).toMatch(/invalid_search_keywords/);
  });

  it("検索のインデックスはキーワードを含む式で、使える形", async () => {
    const client = await getPool().connect();
    try {
      await client.query("set enable_seqscan = off; set enable_indexscan = off");
      const plan = (await client.query<{ "QUERY PLAN": string }>("explain select id from products p where p.published and banto_product_search_text(p.name, p.brand, p.tags, p.description, p.search_keywords) like '%ラッシュガード%'")).rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(plan).toContain("products_search_trgm");
    } finally {
      await client.query("reset enable_seqscan; reset enable_indexscan");
      client.release();
    }
  });
});
