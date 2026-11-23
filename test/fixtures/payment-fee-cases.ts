/**
 * 支払い方法の手数料の答え合わせの表（0170）。src/commerce/payment-fees.ts の komojuFee と DB の banto_payment_fee が
 * 同じ答えを出すことを test/payment-fees.test.ts と test/db/payment-fees.test.ts の両方で確かめる。
 * 決まりの読み方（一律・段）は代引きと共通（cod-fee-cases.ts）。fee: null は「その種類を選べない」
 */
const fees = {
  konbini: { fee_type: "flat", fee_jpy: 220 },
  bank_transfer: { fee_type: "tiers", fee_tiers: [{ upto: 10000, fee: 110 }, { upto: 50000, fee: 330 }] },
  pay_easy: { fee_jpy: 0 },
};

export const PAYMENT_FEE_CASES: { name: string; settings: Record<string, unknown>; type: string; amount: number; fee: number | null }[] = [
  { name: "決まりが無ければ 0", settings: {}, type: "konbini", amount: 5000, fee: 0 },
  { name: "一律", settings: { payment_fees: fees }, type: "konbini", amount: 5000, fee: 220 },
  { name: "一律は 0 円の金額でも同じ", settings: { payment_fees: fees }, type: "konbini", amount: 0, fee: 220 },
  { name: "決まりの無い種類は 0", settings: { payment_fees: fees }, type: "paypay", amount: 5000, fee: 0 },
  { name: "一律 0 円", settings: { payment_fees: fees }, type: "pay_easy", amount: 5000, fee: 0 },
  { name: "段: 最初の段", settings: { payment_fees: fees }, type: "bank_transfer", amount: 10000, fee: 110 },
  { name: "段: 次の段", settings: { payment_fees: fees }, type: "bank_transfer", amount: 10001, fee: 330 },
  { name: "段: どれにも当たらない", settings: { payment_fees: fees }, type: "bank_transfer", amount: 50001, fee: null },
  { name: "決まりがオブジェクトでなければ 0", settings: { payment_fees: { konbini: 220 } }, type: "konbini", amount: 5000, fee: 0 },
  { name: "payment_fees が配列なら 0", settings: { payment_fees: [fees] }, type: "konbini", amount: 5000, fee: 0 },
  { name: "一律の値が形違いなら 0", settings: { payment_fees: { konbini: { fee_jpy: "220" } } }, type: "konbini", amount: 5000, fee: 0 },
  { name: "段が空なら選べない", settings: { payment_fees: { konbini: { fee_type: "tiers", fee_tiers: [] } } }, type: "konbini", amount: 5000, fee: null },
  { name: "代引きの決まりは見ない", settings: { cod: { fee_jpy: 330 } }, type: "konbini", amount: 5000, fee: 0 },
  { name: "金額が負なら選べない", settings: { payment_fees: fees }, type: "konbini", amount: -1, fee: null },
];
