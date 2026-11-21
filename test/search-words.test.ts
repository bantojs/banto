import { describe, expect, it } from "vitest";
import { SEARCH_WORDS_CASES } from "./fixtures/search-words-cases";
import { searchTooShort, searchWords } from "../src/storefront/search-words";

/** 検索の語の分け方（0161）。DB の側は test/db/search-words.test.ts が同じ表で確かめる */
describe("検索の語（src/storefront/search-words.ts）", () => {
  it("答え合わせの表どおり", () => {
    for (const k of SEARCH_WORDS_CASES) {
      expect([k.name, searchWords(k.q)]).toEqual([k.name, k.words]);
      expect([k.name, searchTooShort(k.q)]).toEqual([k.name, k.tooShort]);
    }
  });
});
