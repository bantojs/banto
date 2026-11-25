import { describe, expect, it } from "vitest";
import { withOrderItemMedia } from "../src/orders/item-media";

/** 0174: 明細の画像の候補から、SKU の 1 枚目を firstImageForSku と同じ規則で選んで URL にする */
describe("注文の明細の画像（withOrderItemMedia）", () => {
  const base = "https://media.example.com";
  const cand = [
    { options: {}, storage_key: "a/all.webp", thumb_key: null, width: 1600, height: 1600 },
    { options: { color: "青" }, storage_key: "a/blue.webp", thumb_key: null, width: 1600, height: 2000 },
    { options: { color: "赤" }, storage_key: "a/red.webp", thumb_key: "a/red.thumb.webp", width: 1600, height: 2000 },
    { options: { color: "赤", size: "M" }, storage_key: "a/red-m.webp", thumb_key: null, width: 800, height: 1000 },
  ];
  const item = (options: { key: string; value: string }[], c: unknown = cand) => ({ sku_id: "s", options, image_candidates: c });

  it("その SKU に結んだ細かい画像が先、候補は外へ返さない", () => {
    const r = withOrderItemMedia({ items: [item([{ key: "size", value: "M" }, { key: "color", value: "赤" }])] }, base);
    const it0 = (r.items as Record<string, unknown>[])[0]!;
    expect(it0["image"]).toEqual({ url: "https://media.example.com/a/red-m.webp", thumb: null, width: 800, height: 1000 });
    expect(it0).not.toHaveProperty("image_candidates");
  });

  it("カラー単位 → サムネイルの URL も。結んだ画像が無ければ商品全体、それも無ければほかの SKU の画像", () => {
    const red = withOrderItemMedia({ items: [item([{ key: "size", value: "L" }, { key: "color", value: "赤" }])] }, base);
    expect((red.items as Record<string, unknown>[])[0]!["image"]).toEqual({ url: "https://media.example.com/a/red.webp", thumb: "https://media.example.com/a/red.thumb.webp", width: 1600, height: 2000 });
    const green = withOrderItemMedia({ items: [item([{ key: "color", value: "緑" }])] }, base);
    expect(((green.items as Record<string, unknown>[])[0]!["image"] as { url: string }).url).toBe("https://media.example.com/a/all.webp");
    const other = withOrderItemMedia({ items: [item([{ key: "color", value: "緑" }], [cand[1]])] }, base);
    expect(((other.items as Record<string, unknown>[])[0]!["image"] as { url: string }).url).toBe("https://media.example.com/a/blue.webp");
  });

  it("画像が無ければ null。候補の無い明細（一覧・当てる前の DB）は image を足さない", () => {
    const none = withOrderItemMedia({ items: [item([], [])] }, base);
    expect((none.items as Record<string, unknown>[])[0]!["image"]).toBeNull();
    const listed = withOrderItemMedia({ items: [{ sku_id: "s", options: [] }] }, base);
    expect((listed.items as Record<string, unknown>[])[0]).toEqual({ sku_id: "s", options: [] });
  });
});
