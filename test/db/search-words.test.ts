import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, closePool, createShopFixture, dbAvailable, expectDbError, getPool, resetDatabase, type Fixture } from "./harness";
import { SEARCH_WORDS_CASES } from "../fixtures/search-words-cases";
import { searchQueryForDb, searchTooShort } from "../../src/storefront/search-words";

/** 0161: 検索の語を空白で分けて、すべての語を含む商品を探す（AND）。分け方と短い語の決まりは src/storefront/search-words.ts と同じ表で縛る */
describe.skipIf(!dbAvailable)("検索の語（0161）", () => {
  let f: Fixture;
  const list = (q: string, extra: { tags?: string[]; brand?: string } = {}) =>
    asService(async (c) =>
      (
        await c.query<{ r: { items: { slug: string }[] } }>(
          "select banto_product_list(p_shop_id => $1, p_q => $2, p_tags => $3, p_brand => $4, p_limit => 100) as r",
          [f.shopId, q, extra.tags ?? null, extra.brand ?? null],
        )
      ).rows[0]!.r.items.map((x) => x.slug).sort(),
    );
  const add = (slug: string, name: string, tags: string[] = [], description: string | null = null) =>
    getPool().query("insert into products (shop_id, slug, name, tags, published, description) values ($1, $2, $3, $4, true, $5)", [f.shopId, slug, name, tags, description]);

  beforeAll(async () => {
    await resetDatabase();
    f = await createShopFixture({ email: "sw-owner@example.com", slug: "sw-shop", publish: true });
    await add("cardigan-black", "黒 カーディガン", ["秋"]);
    await add("cardigan-navy", "ネイビー カーディガン", ["秋"]);
    await add("shirt-linen", "リネン シャツ", ["夏"], "麻 100%");
    await add("shirt-cotton", "コットン シャツ", ["夏"], "綿 100%");
  });
  afterAll(closePool);

  it("語の分け方と「短すぎる」は Worker と同じ（答え合わせの表）", async () => {
    for (const k of SEARCH_WORDS_CASES) {
      const err = await list(k.q).then(
        () => null,
        (e: unknown) => String(e),
      );
      expect([k.name, err !== null && /q_too_short/.test(err)]).toEqual([k.name, k.tooShort]);
    }
  });

  it("Worker が渡す形（searchQueryForDb）なら、絵文字・ほかの空白・大文字小文字の違いでも DB の判定が Worker とずれない", async () => {
    for (const q of [...SEARCH_WORDS_CASES.map((k) => k.q), "😀 ".repeat(45) + "abc", "İİ", "ab\u2003cd", "ab\u2028cd"]) {
      const db = searchQueryForDb(q);
      if (db === null) continue;
      const err = await list(db).then(
        () => null,
        (e: unknown) => String(e),
      );
      expect([q, err !== null && /q_too_short/.test(err)]).toEqual([q, searchTooShort(q)]);
    }
  });

  it("すべての語を含む商品だけ。順と大文字小文字は問わない。短い語は 3 文字以上の語と一緒なら使える", async () => {
    expect(await list("カーディガン")).toEqual(["cardigan-black", "cardigan-navy"]);
    expect(await list("カーディガン 黒")).toEqual(["cardigan-black"]);
    expect(await list("黒　カーディガン")).toEqual(["cardigan-black"]);
    expect(await list("シャツ 麻")).toEqual(["shirt-linen"]);
    expect(await list("シャツ 100%")).toEqual(["shirt-cotton", "shirt-linen"]);
    expect(await list("シャツ カーディガン")).toEqual([]);
    expect(await list("リネン シャツ リネン")).toEqual(["shirt-linen"]);
    // 6 語目からは捨てる
    expect(await list("シャツ リネン 麻 100% 夏 存在しない語")).toEqual(["shirt-linen"]);
    // 短い語だけでもタグ・ブランドで絞っていれば探す
    expect(await list("麻", { tags: ["夏"] })).toEqual(["shirt-linen"]);
    expect(await expectDbError(() => list("麻 黒"))).toMatch(/q_too_short/);
  });

  it("3 文字以上の語は pg_trgm のインデックス、短い語は strpos（インデックスを全部なめる形にしない）", async () => {
    const def = (await getPool().query<{ d: string }>("select pg_get_functiondef('banto_product_list'::regproc) as d")).rows[0]!.d;
    expect(def).toContain("like ($5)[%s]");
    expect(def).toContain("strpos(banto_product_search_text");
    // 同じ接続で設定と EXPLAIN を流す（行が少ないと順に読むほうを選ぶので、インデックスを使える形かだけを見る）
    const client = await getPool().connect();
    try {
      await client.query("set enable_seqscan = off; set enable_indexscan = off");
      const plan = (
        await client.query<{ "QUERY PLAN": string }>(
          "explain select id from products p where p.published and banto_product_search_text(p.name, p.brand, p.tags, p.description, p.search_keywords) like ($1::text[])[1] and banto_product_search_text(p.name, p.brand, p.tags, p.description, p.search_keywords) like ($1::text[])[2]",
          [["%カーディガン%", "%ネイビー%"]],
        )
      ).rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(plan).toContain("products_search_trgm");
    } finally {
      await client.query("reset enable_seqscan; reset enable_indexscan");
      client.release();
    }
  });
});
