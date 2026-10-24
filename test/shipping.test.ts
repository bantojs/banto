import { describe, expect, it } from "vitest";
import { describeShipping, includedTax, parseShippingSettings, shippingFee, taxRate } from "../src/commerce/shipping";

describe("送料・税", () => {
  it("設定の読み込みは壊れた値を捨てる", () => {
    expect(parseShippingSettings(undefined)).toEqual({ mode: "flat", flat_fee_jpy: 0, by_prefecture: {}, free_over_jpy: null });
    expect(parseShippingSettings({ mode: "by_prefecture", flat_fee_jpy: 800, by_prefecture: { 北海道: 1500, 火星: 1, 沖縄県: -5, 東京都: "800" }, free_over_jpy: 5000 })).toEqual({
      mode: "by_prefecture",
      flat_fee_jpy: 800,
      by_prefecture: { 北海道: 1500 },
      free_over_jpy: 5000,
    });
  });

  it("全国一律 / 都道府県別 / 無料ライン", () => {
    const flat = parseShippingSettings({ mode: "flat", flat_fee_jpy: 800, free_over_jpy: 5000 });
    expect(shippingFee(flat, 1000, "東京都")).toBe(800);
    expect(shippingFee(flat, 5000, "東京都")).toBe(0);
    expect(shippingFee(flat, 1000, null)).toBe(800);
    const byPref = parseShippingSettings({ mode: "by_prefecture", flat_fee_jpy: 800, by_prefecture: { 北海道: 1500, 沖縄県: 1800 } });
    expect(shippingFee(byPref, 1000, "北海道")).toBe(1500);
    expect(shippingFee(byPref, 1000, "東京都")).toBe(800); // 未設定の県は一律額
    expect(shippingFee(byPref, 1000, "不明")).toBe(800);
    expect(describeShipping(flat).summary).toBe("送料は全国一律 ¥800（税込）");
    expect(describeShipping(parseShippingSettings({})).summary).toBe("送料無料");
    const d = describeShipping(byPref);
    expect(d.summary).toBe("送料は都道府県により ¥800〜¥1,800（税込）");
    expect(d.table).toHaveLength(47);
  });

  it("内税の計算", () => {
    expect(taxRate({})).toBe(10);
    expect(taxRate({ tax_rate: 8 })).toBe(8);
    expect(includedTax(1100, 10)).toBe(100);
    expect(includedTax(1080, 8)).toBe(80);
    expect(includedTax(3000, 10)).toBe(272);
  });
});
