import { describe, expect, it } from "vitest";
import { freeLeft, freeReached, nonSaleSubtotal, parseShippingSettings, publicShipping, shippingQuote } from "../src/commerce/shipping";
import { freeBasesOf, shippingSummary } from "../src/commerce/checkout";
import { audienceFreeRulesFromForm } from "../src/routes/admin/shops";
import type { PublicShop } from "../src/storefront/data";

/** 0183: 送料無料の金額にセール商品（通常価格のある SKU）を含まない（ショップ全体・会員の条件ごと） */
const GOLD = "11111111-1111-4111-8111-111111111111";
const sale = (price: number, qty = 1) => ({ qty, sku: { price_jpy: price, compare_at_price_jpy: price + 1000 } });
const plain = (price: number, qty = 1) => ({ qty, sku: { price_jpy: price, compare_at_price_jpy: null } });

describe("送料無料とセール商品（0183）", () => {
  it("セール商品 = 通常価格が価格より高い SKU。店頭のみの行は金額に入れない", () => {
    expect(nonSaleSubtotal([sale(3000, 2), plain(2000)], 8000)).toBe(2000);
    expect(nonSaleSubtotal([{ qty: 1, sku: { price_jpy: 3000, compare_at_price_jpy: 3000 } }], 3000)).toBe(3000);
    expect(freeBasesOf({ lines: [sale(3000), plain(2000), { ...plain(9000), storeOnly: true }], subtotal: 5000 })).toEqual({ all: 5000, nonSale: 2000 });
  });

  it("使い方 1: 会員の条件 + セール商品を含まない + 1 円以上 → セール商品だけのカートは送料がかかる", () => {
    const cfg = parseShippingSettings({ mode: "flat", flat_fee_jpy: 800, free_over_by_audience: [{ audience_id: GOLD, free_over_jpy: 1, exclude_sale: true }] });
    const member = [{ over: 1, excludeSale: true }];
    expect(shippingQuote(cfg, { all: 5000, nonSale: 0 }, "東京都", member)).toEqual({ fee: 800, free_reason: null });
    expect(shippingQuote(cfg, { all: 5000, nonSale: 1 }, "東京都", member)).toEqual({ fee: 0, free_reason: "audience" });
  });

  it("使い方 2: 会員の条件なし + セール商品を含まない + 11,000 円以上", () => {
    const cfg = parseShippingSettings({ mode: "flat", flat_fee_jpy: 800, free_over_jpy: 11000, free_over_excludes_sale: true });
    expect(cfg.free_over_excludes_sale).toBe(true);
    expect(shippingQuote(cfg, { all: 15000, nonSale: 10999 }, "東京都")).toEqual({ fee: 800, free_reason: null });
    expect(shippingQuote(cfg, { all: 15000, nonSale: 11000 }, "東京都")).toEqual({ fee: 0, free_reason: "threshold" });
    // 印が無ければ今までどおり商品の合計で
    const old = parseShippingSettings({ mode: "flat", flat_fee_jpy: 800, free_over_jpy: 11000 });
    expect(shippingQuote(old, { all: 15000, nonSale: 0 }, "東京都").fee).toBe(0);
    expect(shippingQuote(old, 15000, "東京都").fee).toBe(0);
  });

  it("決まりが複数なら 1 つでも満たせば無料。あと○円は残りの少ないもの", () => {
    const t = [{ over: 11000, excludeSale: true }, { over: 20000, excludeSale: false }];
    expect(freeReached(t, { all: 20000, nonSale: 0 })).toBe(true);
    expect(freeReached(t, { all: 19999, nonSale: 10999 })).toBe(false);
    expect(freeLeft(t, { all: 19000, nonSale: 10000 })).toBe(1000);
    expect(freeLeft([], { all: 1, nonSale: 1 })).toBeNull();
  });

  it("カートの目安（progress）: セール商品を含まない決まりはセール商品を除いた合計で", () => {
    const shop = { id: "s", slug: "s", name: "S", settings: { shipping: { mode: "flat", flat_fee_jpy: 800, free_over_jpy: 11000, free_over_excludes_sale: true }, modules: { audiences: true } } } as unknown as PublicShop;
    const s = shippingSummary(shop, [{ over: 1, excludeSale: true }], { all: 12000, nonSale: 0 });
    // セール商品だけ: 会員の決まり（1 円以上・セール商品を含まない）まであと 1 円、ショップ全体まであと 11,000 円 → 近いほう
    expect(s.progress).toEqual({ over: 1, left: 1, applied: false, member: true, excludeSale: true });
    expect(shippingSummary(shop, [{ over: 1, excludeSale: true }], { all: 12000, nonSale: 500 }).progress).toEqual({ over: 1, left: 0, applied: true, member: true, excludeSale: true });
    expect(shippingSummary(shop, null, { all: 12000, nonSale: 11000 }).progress).toMatchObject({ left: 0, applied: true, member: false });
    expect(s.freeOverExcludesSale).toBe(true);
  });

  it("公開の形・管理画面のフォーム", () => {
    expect(publicShipping({ mode: "flat", free_over_jpy: 11000, free_over_excludes_sale: true, free_over_by_audience: [{ audience_id: GOLD, free_over_jpy: 1, label: "ゴールド", exclude_sale: true }] })).toEqual({
      mode: "flat",
      free_over_jpy: 11000,
      free_over_excludes_sale: true,
      member_free: true,
      free_over_by_audience: [{ label: "ゴールド", free_over_jpy: 1, exclude_sale: true }],
    });
    const choices = [{ id: GOLD, name: "ゴールド" }];
    expect(audienceFreeRulesFromForm({ aud_0: GOLD, aud_over_0: "1", aud_excl_0: "on" }, choices, [], true)).toEqual([{ audience_id: GOLD, free_over_jpy: 1, label: null, exclude_sale: true }]);
    // 欄を出していない（0183 の前）なら今の印のまま
    expect(audienceFreeRulesFromForm({ aud_0: GOLD, aud_over_0: "1" }, choices, [{ audience_id: GOLD, free_over_jpy: 5, label: null, exclude_sale: true }], false)[0]!.exclude_sale).toBe(true);
  });
});
