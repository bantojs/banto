import { describe, expect, it } from "vitest";
import { couponSubject, customerAttributesOf, evaluateDiscounts, normalizeCode, parseCampaigns, type Campaign, type DiscountLine } from "../src/commerce/discounts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const tree: Record<string, string | null> = { tops: null, tees: "tops", food: null };
const ctx = (member = false) => ({
  now: NOW,
  member,
  ancestors: (id: string) => {
    const out: string[] = [];
    for (let cur: string | null = id; cur; cur = tree[cur] ?? null) out.push(cur);
    return out;
  },
});
const camp = (o: Partial<Campaign> & { code: string }): Campaign => ({
  id: `id-${o.code}`,
  name: o.code,
  kind: "fixed",
  value: 100,
  starts_at: null,
  ends_at: null,
  usage_limit: null,
  per_customer_limit: null,
  combinable: false,
  audience: "public",
  conditions: {},
  active: true,
  used_by_subject: 0,
  available: true,
  ...o,
});
const LINES: DiscountLine[] = [
  { sku_id: "tee", product_id: "p-tee", category_id: "tees", unit_price_jpy: 3000, qty: 2, sale: false },
  { sku_id: "cap", product_id: "p-cap", category_id: "tops", unit_price_jpy: 1999, qty: 1, sale: true },
  { sku_id: "jam", product_id: "p-jam", category_id: "food", unit_price_jpy: 800, qty: 3, sale: false },
];

describe("値引きの判定と計算（discounts.ts）", () => {
  it("割合は対象商品の金額にかけ、1 円未満は切り捨て、行ごとに配分する（合計が一致する）", () => {
    const r = evaluateDiscounts(["off10"], [camp({ code: "OFF10", kind: "percent", value: 10 })], LINES, 600, ctx());
    // (6000 + 1999 + 2400) * 10% = 1039.9 → 1039
    expect(r.applied).toEqual([{ campaign_id: "id-OFF10", code: "OFF10", name: "OFF10", kind: "percent", amount_jpy: 1039 }]);
    expect(r.itemDiscount).toBe(1039);
    expect(Object.values(r.lines).reduce((n, x) => n + x, 0)).toBe(1039);
    // 端数（2 円）は、端数の大きい行から 1 円ずつ
    expect(r.lines).toEqual({ tee: 599, cap: 200, jam: 240 });
    expect(r.total).toBe(1039);
  });

  it("対象: カテゴリー（子孫を含む）・商品・除外・セール品を除く。対象の金額と点数で条件を見る", () => {
    const tops = camp({ code: "TOPS", kind: "percent", value: 50, conditions: { category_ids: ["tops"], exclude_sale: true } });
    let r = evaluateDiscounts(["TOPS"], [tops], LINES, 0, ctx());
    // tees は tops の子。cap はセール品なので外れる
    expect(r.lines).toEqual({ tee: 3000 });
    r = evaluateDiscounts(["JAM"], [camp({ code: "JAM", value: 5000, conditions: { product_ids: ["p-jam"] } })], LINES, 0, ctx());
    // 定額は対象商品の金額を超えない
    expect(r.lines).toEqual({ jam: 2400 });
    r = evaluateDiscounts(["NOFOOD"], [camp({ code: "NOFOOD", value: 300, conditions: { exclude_category_ids: ["food"], min_subtotal_jpy: 9000 } })], LINES, 0, ctx());
    expect(r.rejected).toEqual([{ code: "NOFOOD", reason: "min_subtotal", shortfall: 9000 - 7999 }]);
    r = evaluateDiscounts(["QTY"], [camp({ code: "QTY", conditions: { min_qty: 7 } })], LINES, 0, ctx());
    expect(r.rejected).toEqual([{ code: "QTY", reason: "min_qty", shortfall: 1 }]);
    r = evaluateDiscounts(["MAX"], [camp({ code: "MAX", conditions: { max_subtotal_jpy: 5000 } })], LINES, 0, ctx());
    expect(r.rejected).toEqual([{ code: "MAX", reason: "max_subtotal" }]);
    r = evaluateDiscounts(["NONE"], [camp({ code: "NONE", conditions: { product_ids: ["other"] } })], LINES, 0, ctx());
    expect(r.rejected).toEqual([{ code: "NONE", reason: "no_eligible_items" }]);
  });

  it("追加カテゴリー（0042）: 主カテゴリーか追加カテゴリーのどれかが合えば対象、どれかが除くカテゴリーなら除く", () => {
    const lines: DiscountLine[] = [
      { sku_id: "tee", product_id: "p-tee", category_id: "tees", extra_category_ids: ["food"], unit_price_jpy: 3000, qty: 1, sale: false },
      { sku_id: "jam", product_id: "p-jam", category_id: "food", unit_price_jpy: 800, qty: 1, sale: false },
      { sku_id: "cap", product_id: "p-cap", category_id: null, extra_category_ids: ["tees"], unit_price_jpy: 1000, qty: 1, sale: false },
    ];
    // tops の子孫（tees）を追加カテゴリーに持つ cap も対象
    let r = evaluateDiscounts(["TOPS"], [camp({ code: "TOPS", kind: "percent", value: 10, conditions: { category_ids: ["tops"] } })], lines, 0, ctx());
    expect(Object.keys(r.lines).sort()).toEqual(["cap", "tee"]);
    // 追加カテゴリーで food に入っている tee も除く
    r = evaluateDiscounts(["NOFOOD"], [camp({ code: "NOFOOD", kind: "percent", value: 10, conditions: { exclude_category_ids: ["food"] } })], lines, 0, ctx());
    expect(Object.keys(r.lines)).toEqual(["cap"]);
  });

  it("タグ（0042）: どれか 1 つを持つ商品が対象、除くタグをひとつでも持てば除く。タグの無い行は対象外", () => {
    const lines: DiscountLine[] = [
      { sku_id: "a", product_id: "p-a", category_id: null, tags: ["セール", "冬"], unit_price_jpy: 1000, qty: 1, sale: false },
      { sku_id: "b", product_id: "p-b", category_id: null, tags: ["冬", "福袋"], unit_price_jpy: 1000, qty: 1, sale: false },
      { sku_id: "c", product_id: "p-c", category_id: null, unit_price_jpy: 1000, qty: 1, sale: false },
    ];
    let r = evaluateDiscounts(["WINTER"], [camp({ code: "WINTER", kind: "percent", value: 10, conditions: { tags: ["冬"], exclude_tags: ["福袋"] } })], lines, 0, ctx());
    expect(Object.keys(r.lines)).toEqual(["a"]);
    r = evaluateDiscounts(["NOBAG"], [camp({ code: "NOBAG", kind: "percent", value: 10, conditions: { exclude_tags: ["福袋"] } })], lines, 0, ctx());
    expect(Object.keys(r.lines).sort()).toEqual(["a", "c"]);
    r = evaluateDiscounts(["NONE"], [camp({ code: "NONE", conditions: { tags: ["夏"] } })], lines, 0, ctx());
    expect(r.rejected).toEqual([{ code: "NONE", reason: "no_eligible_items" }]);
  });

  it("ブランド（0044）: 対象・除くブランドは前後の空白と大文字小文字を区別しない", () => {
    const lines: DiscountLine[] = [
      { sku_id: "a", product_id: "p-a", category_id: null, brand: "HANARE", unit_price_jpy: 1000, qty: 1, sale: false },
      { sku_id: "b", product_id: "p-b", category_id: null, brand: "Other ", unit_price_jpy: 1000, qty: 1, sale: false },
      { sku_id: "c", product_id: "p-c", category_id: null, unit_price_jpy: 1000, qty: 1, sale: false },
    ];
    let r = evaluateDiscounts(["B"], [camp({ code: "B", kind: "percent", value: 10, conditions: { brands: [" hanare"] } })], lines, 0, ctx());
    expect(Object.keys(r.lines)).toEqual(["a"]);
    r = evaluateDiscounts(["X"], [camp({ code: "X", kind: "percent", value: 10, conditions: { exclude_brands: ["other"] } })], lines, 0, ctx());
    expect(Object.keys(r.lines).sort()).toEqual(["a", "c"]);
  });

  it("支払い方法（0044）: カートでは仮に通し、確認画面で選んだ方法に合わなければ断る。KOMOJU は種類を重ねて絞る", () => {
    const stripeOnly = camp({ code: "S", conditions: { payment_methods: ["stripe"] } });
    const paypay = camp({ code: "PP", combinable: true, conditions: { payment_methods: ["komoju:paypay", "komoju:credit_card"] } });
    const card = camp({ code: "CC", combinable: true, conditions: { payment_methods: ["komoju:credit_card"] } });
    const konbini = camp({ code: "KB", combinable: true, conditions: { payment_methods: ["komoju:konbini"] } });
    const anyKomoju = camp({ code: "KA", combinable: true, conditions: { payment_methods: ["komoju"] } });
    // カート（支払い方法がまだ）: 通す
    expect(evaluateDiscounts(["S"], [stripeOnly], LINES, 0, ctx()).applied).toHaveLength(1);
    // Stripe を選んだ: KOMOJU だけのクーポンは断る
    let r = evaluateDiscounts(["PP"], [paypay], LINES, 0, { ...ctx(), payment: { provider: "stripe" } });
    expect(r.rejected).toEqual([{ code: "PP", reason: "payment_method" }]);
    expect(evaluateDiscounts(["S"], [stripeOnly], LINES, 0, { ...ctx(), payment: { provider: "stripe" } }).applied).toHaveLength(1);
    // KOMOJU を選んだ: Stripe だけのクーポンは断る。種類は重ねて絞り、重ならないものは後から入れた方を外す
    r = evaluateDiscounts(["S"], [stripeOnly], LINES, 0, { ...ctx(), payment: { provider: "komoju" } });
    expect(r.rejected).toEqual([{ code: "S", reason: "payment_method" }]);
    r = evaluateDiscounts(["PP", "CC", "KB", "KA"], [paypay, card, konbini, anyKomoju], LINES, 0, { ...ctx(), payment: { provider: "komoju" } });
    expect(r.applied.map((a) => a.code)).toEqual(["PP", "CC", "KA"]);
    expect(r.rejected).toEqual([{ code: "KB", reason: "payment_method" }]);
    expect(r.paymentTypes).toEqual(["credit_card"]);
    // 条件の無いクーポンは絞らない
    expect(evaluateDiscounts(["KA"], [anyKomoju], LINES, 0, { ...ctx(), payment: { provider: "komoju" } }).paymentTypes).toBeUndefined();
  });

  it("会員の独自項目（0049）: 条件の鍵ごとにどれかの値に合う会員だけ。ゲストと項目の無い会員は attributes で断る。前後の空白と大文字小文字は区別しない", () => {
    const gold = camp({ code: "GOLD", conditions: { attributes: { rank: ["gold", "Silver"] } } });
    const both = camp({ code: "BOTH", conditions: { attributes: { rank: ["gold"], newsletter: ["yes"] } } });
    const none = camp({ code: "NONE", conditions: { attributes: {} } });
    const attrs = (attributes: Record<string, unknown> | null) => ({ ...ctx(true), attributes });
    expect(evaluateDiscounts(["gold"], [gold], LINES, 0, ctx(false)).rejected).toEqual([{ code: "GOLD", reason: "attributes" }]);
    expect(evaluateDiscounts(["gold"], [gold], LINES, 0, attrs(null)).rejected).toEqual([{ code: "GOLD", reason: "attributes" }]);
    expect(evaluateDiscounts(["gold"], [gold], LINES, 0, attrs({ rank: "regular" })).rejected).toEqual([{ code: "GOLD", reason: "attributes" }]);
    expect(evaluateDiscounts(["gold"], [gold], LINES, 0, attrs({ rank: " GOLD " })).applied.map((a) => a.code)).toEqual(["GOLD"]);
    expect(evaluateDiscounts(["gold"], [gold], LINES, 0, attrs({ rank: "silver" })).applied.map((a) => a.code)).toEqual(["GOLD"]);
    // 鍵が複数なら全部に合うこと。数の値も文字列として比べる
    expect(evaluateDiscounts(["both"], [both], LINES, 0, attrs({ rank: "gold" })).rejected).toEqual([{ code: "BOTH", reason: "attributes" }]);
    expect(evaluateDiscounts(["both"], [both], LINES, 0, attrs({ rank: "gold", newsletter: "yes" })).applied.map((a) => a.code)).toEqual(["BOTH"]);
    const score = camp({ code: "SCORE", conditions: { attributes: { score: [12, "15"] } } });
    expect(evaluateDiscounts(["score"], [score], LINES, 0, attrs({ score: 15 })).applied.map((a) => a.code)).toEqual(["SCORE"]);
    expect(evaluateDiscounts(["score"], [score], LINES, 0, attrs({ score: 7 })).rejected).toEqual([{ code: "SCORE", reason: "attributes" }]);
    // 空の条件はゲストでも使える
    expect(evaluateDiscounts(["none"], [none], LINES, 0, ctx(false)).applied.map((a) => a.code)).toEqual(["NONE"]);
    // lookup の行から会員の独自項目を取り出す
    expect(customerAttributesOf([{ id: "x", customer_attributes: { rank: "gold" } }])).toEqual({ rank: "gold" });
    expect(customerAttributesOf([{ id: "x", customer_attributes: null }])).toBeNull();
    expect(customerAttributesOf("nope")).toBeNull();
  });

  it("期間・有効・会員限定・1 人あたり・全体の上限で断り、理由を返す", () => {
    const list = [
      camp({ code: "A", active: false }),
      camp({ code: "B", starts_at: "2026-11-01T00:00:00Z" }),
      camp({ code: "C", ends_at: "2026-10-01T00:00:00Z" }),
      camp({ code: "D", audience: "members" }),
      camp({ code: "E", per_customer_limit: 1, used_by_subject: 1 }),
      camp({ code: "F", usage_limit: 10, available: false }),
    ];
    const r = evaluateDiscounts(["A", "B", "C", "D", "E", "F", "ZZZ", "bad code!"], list, LINES, 0, ctx());
    expect(r.rejected.map((x) => [x.code, x.reason])).toEqual([
      ["A", "inactive"],
      ["B", "not_started"],
      ["C", "ended"],
      ["D", "members_only"],
      ["E", "limit_reached"],
      // 6 枚目からは断る（形の違うコードは数えない）
      ["F", "too_many"],
      ["ZZZ", "too_many"],
    ]);
    expect(evaluateDiscounts(["D"], list, LINES, 0, ctx(true)).applied).toHaveLength(1);
    expect(evaluateDiscounts(["F"], list, LINES, 0, ctx()).rejected).toEqual([{ code: "F", reason: "exhausted" }]);
    expect(evaluateDiscounts(["NOPE"], list, LINES, 0, ctx()).rejected).toEqual([{ code: "NOPE", reason: "not_found" }]);
  });

  it("併用: 併用できないクーポンは 1 枚だけ（先に入れたものを優先）。併用時は 割合 → 定額 → 送料無料 の順", () => {
    const pct = camp({ code: "PCT", kind: "percent", value: 10, combinable: true });
    const fix = camp({ code: "FIX", value: 500, combinable: true });
    const ship = camp({ code: "SHIP", kind: "free_shipping", value: 0, combinable: true });
    const solo = camp({ code: "SOLO", value: 1000 });
    // 入れた順に関係なく、割合は値引き前の金額にかかる
    const r = evaluateDiscounts(["FIX", "SHIP", "PCT"], [pct, fix, ship], LINES, 700, ctx());
    expect(r.applied.map((x) => [x.code, x.amount_jpy])).toEqual([
      ["FIX", 500],
      ["SHIP", 700],
      ["PCT", 1039],
    ]);
    expect(r).toMatchObject({ itemDiscount: 1539, shippingDiscount: 700, total: 2239 });
    expect(evaluateDiscounts(["PCT", "SOLO"], [pct, solo], LINES, 0, ctx()).rejected).toEqual([{ code: "SOLO", reason: "not_combinable" }]);
    expect(evaluateDiscounts(["SOLO", "PCT"], [pct, solo], LINES, 0, ctx()).rejected).toEqual([{ code: "PCT", reason: "not_combinable" }]);
    // 値引きの合計は商品の金額を超えない
    const huge = evaluateDiscounts(["FIX", "BIG"], [fix, camp({ code: "BIG", value: 1_000_000, combinable: true })], LINES, 0, ctx());
    expect(huge.itemDiscount).toBe(6000 + 1999 + 2400);
  });

  it("コードの正規化、subject（会員は会員 ID、ゲストはメールアドレスの SHA-256）、lookup の行の整形", async () => {
    expect(normalizeCode(" summer-10 ")).toBe("SUMMER-10");
    expect(normalizeCode("ｓｕｍｍｅｒ")).toBeNull();
    expect(normalizeCode("x".repeat(40))).toBeNull();
    expect(await couponSubject({ id: "6F9619FF-8B86-D011-B42D-00C04FC964FF" }, "a@example.com")).toBe("c:6f9619ff-8b86-d011-b42d-00c04fc964ff");
    const g = await couponSubject(null, " A@Example.com ");
    expect(g).toMatch(/^e:[0-9a-f]{64}$/);
    expect(await couponSubject(null, "a@example.com")).toBe(g);
    expect(await couponSubject(null, "")).toBeNull();
    expect(parseCampaigns([{ id: "x", kind: "percent", value: 5, active: true, code: "A", conditions: { min_qty: 2 } }, { id: 1, kind: "?" }])).toEqual([
      expect.objectContaining({ id: "x", kind: "percent", value: 5, code: "A", conditions: { min_qty: 2 }, combinable: false, audience: "public", available: true }),
    ]);
  });
});
