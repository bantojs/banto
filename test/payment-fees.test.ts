import { describe, expect, it } from "vitest";
import { PAYMENT_FEE_CASES } from "./fixtures/payment-fee-cases";
import { COD_FEE_CASES } from "./fixtures/cod-fee-cases";
import { feeOfRule, komojuFee, komojuMethods, komojuMethodButtonLabel, flatFee, paymentFeeWarnings } from "../src/commerce/payment-fees";
import { receiptData } from "../src/modules/receipt/data";
import { codFee } from "../src/modules/cod";
import { parsePaymentChoice } from "../src/commerce/checkout";
import { parsePaymentFeesForm } from "../src/routes/admin/payment-fees";
import { paymentMethodsObject } from "../src/themes/liquid/objects";

describe("支払い方法の手数料（0170）", () => {
  it("答え合わせの表（DB の banto_payment_fee と同じ）", () => {
    for (const k of PAYMENT_FEE_CASES) expect([k.name, komojuFee(k.settings, k.type, k.amount)]).toEqual([k.name, k.fee]);
  });

  it("代引きの手数料も同じ読み方（codFee = feeOfRule(settings.cod)）で、答えは変わらない", () => {
    for (const k of COD_FEE_CASES) {
      expect([k.name, codFee(k.settings, k.amount)]).toEqual([k.name, k.fee]);
      expect([k.name, feeOfRule((k.settings as { cod?: unknown }).cod, k.amount)]).toEqual([k.name, k.fee]);
    }
  });

  it("並べる種類: 決まりが無ければ null、受け付ける種類があればその順、無ければ決まりのある種類だけ", () => {
    expect(komojuMethods({}, ["konbini"])).toBeNull();
    const settings = { payment_fees: { konbini: { fee_jpy: 220 }, bank_transfer: { fee_type: "tiers", fee_tiers: [{ upto: 1000, fee: 110 }] } } };
    expect(komojuMethods(settings, ["paypay", "konbini"])!.map((m) => [m.type, flatFee(m.rule)])).toEqual([
      ["paypay", 0],
      ["konbini", 220],
    ]);
    expect(komojuMethods(settings, [])!.map((m) => m.type)).toEqual(["konbini", "bank_transfer"]);
    expect(komojuMethodButtonLabel({ name: "コンビニ払い", fee: 220 })).toContain("220");
    expect(komojuMethodButtonLabel({ name: "銀行振込", fee: null })).toContain("手数料あり");
  });

  it("選び方の値: komoju:<種類> と今までの決済手段", () => {
    expect(parsePaymentChoice("komoju:konbini")).toEqual({ provider: "komoju", method: "konbini" });
    expect(parsePaymentChoice("komoju")).toEqual({ provider: "komoju", method: null });
    expect(parsePaymentChoice("stripe")).toEqual({ provider: "stripe", method: null });
    expect(parsePaymentChoice("stripe:konbini")).toBeNull();
    expect(parsePaymentChoice("komoju:Konbini")).toBeNull();
    expect(parsePaymentChoice(undefined)).toBeNull();
  });

  it("Liquid の cart.banto_payment_methods: KOMOJU は種類ごと（id は komoju:<種類>）", () => {
    const label = (p: string) => p;
    expect(paymentMethodsObject({ stripe: true, komoju: true, amazon_pay: false }, label)).toEqual([
      { id: "stripe", name: "stripe" },
      { id: "komoju", name: "komoju" },
    ]);
    expect(paymentMethodsObject({ stripe: false, komoju: true, amazon_pay: false, komoju_methods: [{ type: "konbini", name: "コンビニ払い", fee: 220 }] }, label)).toEqual([
      { id: "komoju:konbini", name: "コンビニ払い（KOMOJU・手数料 220 円）", fee: 220 },
    ]);
  });

  it("管理画面のフォーム: 種類の形・重なり・段を確かめ、外す・空の行は飛ばす", () => {
    expect(parsePaymentFeesForm({ rows: "3", type_0: "konbini", fee_type_0: "flat", fee_jpy_0: "220", type_1: "bank_transfer", fee_type_1: "tiers", fee_tiers_1: "10000,110\n50000,330", type_2: "" })).toEqual({
      konbini: { fee_type: "flat", fee_jpy: 220, fee_tiers: [] },
      bank_transfer: { fee_type: "tiers", fee_jpy: 0, fee_tiers: [{ upto: 10000, fee: 110 }, { upto: 50000, fee: 330 }] },
    });
    expect(parsePaymentFeesForm({ rows: "1", type_0: "konbini", fee_jpy_0: "220", remove_0: "on" })).toEqual({});
    expect(parsePaymentFeesForm({ rows: "1", type_0: "Konbini", fee_jpy_0: "220" })).toBeNull();
    expect(parsePaymentFeesForm({ rows: "2", type_0: "konbini", fee_jpy_0: "220", type_1: "konbini", fee_jpy_1: "330" })).toBeNull();
    expect(parsePaymentFeesForm({ rows: "1", type_0: "konbini", fee_type_0: "tiers", fee_tiers_0: "" })).toBeNull();
    expect(parsePaymentFeesForm({ rows: "1", type_0: "konbini", fee_jpy_0: "100001" })).toBeNull();
  });
});

describe("管理画面の警告（0170）", () => {
  it("受け付ける支払い方法が空・その中に無い種類・知らない種類の名前を知らせる。決まりが無い・プラグインが読めないときは何も出さない", () => {
    expect(paymentFeeWarnings([], [])).toEqual([]);
    expect(paymentFeeWarnings(["konbini"], null)).toEqual([]);
    expect(paymentFeeWarnings(["konbini"], [])).toEqual([{ kind: "types_empty" }]);
    expect(paymentFeeWarnings(["konbini", "bank_transfer"], ["konbini", "paypay"])).toEqual([{ kind: "not_accepted", type: "bank_transfer" }]);
    expect(paymentFeeWarnings(["konbinii"], ["konbinii"])).toEqual([{ kind: "unknown_type", type: "konbinii" }]);
  });
});

describe("ヘッドレスの領収書の手数料の見出し（0170）", () => {
  it("fee_label と payment_provider を返す（手数料が無ければ見出しは null）", () => {
    const base = { number: 1001, created_at: "2026-11-23T00:00:00Z", items: [{ name: "Tシャツ", sku: "T", qty: 1, unit_price_jpy: 3000, tax_rate: 0.1 }], shipping_jpy: 500, total_jpy: 3720, shipping_tax_rate: 0.1, status: "paid" };
    const komoju = receiptData({ name: "店" }, { ...base, fee_jpy: 220, payment_provider: "komoju" }, new Date());
    expect(komoju).toMatchObject({ fee_jpy: 220, fee_label: "お支払い手数料", payment_provider: "komoju" });
    expect(receiptData({ name: "店" }, { ...base, fee_jpy: 330, payment_provider: "cod" }, new Date())).toMatchObject({ fee_label: "代引き手数料", payment_provider: "cod" });
    expect(receiptData({ name: "店" }, { ...base, total_jpy: 3500, payment_provider: "stripe" }, new Date())).toMatchObject({ fee_jpy: 0, fee_label: null });
  });
});
