import { describe, expect, it } from "vitest";
import { SEARCH_WORDS_CASES } from "./fixtures/search-words-cases";
import { searchQueryForDb, searchTooShort, searchWords } from "../src/storefront/search-words";
import { FakeSupabase } from "./fake-supabase";
import { appWith } from "./helpers";

/** 検索の語の分け方（0161）。DB の側は test/db/search-words.test.ts が同じ表で確かめる */
describe("検索の語（src/storefront/search-words.ts）", () => {
  it("答え合わせの表どおり", () => {
    for (const k of SEARCH_WORDS_CASES) {
      expect([k.name, searchWords(k.q)]).toEqual([k.name, k.words]);
      expect([k.name, searchTooShort(k.q)]).toEqual([k.name, k.tooShort]);
    }
  });

  it("DB に渡す形は分け直しても同じ語（絵文字・大文字小文字・長さの数え方でずれない）", () => {
    const inputs = [...SEARCH_WORDS_CASES.map((k) => k.q), "😀 ".repeat(45) + "abc", "İİ", "ab\u2003cd", "  ", "Ab  aB  AB xyz"];
    for (const q of inputs) {
      const db = searchQueryForDb(q);
      expect([q, searchWords(db)]).toEqual([q, searchWords(q)]);
      expect([q, searchTooShort(db)]).toEqual([q, searchTooShort(q)]);
    }
    expect(searchQueryForDb("   ")).toBeNull();
  });

  it("お店の画面と公開 API: 長い絵文字の語・ほかの空白でも 500 にしない", async () => {
    const sb = new FakeSupabase();
    const owner = sb.addUser("owner@example.com", "password-123", { owner: true });
    const shop = sb.addShop(owner.id, { slug: "s", name: "S", published: true, legal_notice: "a", privacy_policy: "b", return_policy: "c" });
    const p = sb.addProduct(shop.id, { slug: "abc", name: "abc shirt", published: true });
    sb.addSku(shop.id, p.id, { code: "A", name: "A", price_jpy: 1000, available: 1 });
    const app = appWith(sb);
    for (const q of ["😀 ".repeat(45) + "abc", "ab\u2003cd", "İİ"]) {
      expect([q, (await app.request(`/s/products?q=${encodeURIComponent(q)}`)).status]).toEqual([q, 200]);
      expect([q, (await app.request(`/api/shops/s/products?q=${encodeURIComponent(q)}`)).status]).toEqual([q, 200]);
    }
  });
});
