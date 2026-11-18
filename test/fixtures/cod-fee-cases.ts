/**
 * 代引き手数料の答え合わせの表（0157）。src/modules/cod の codFee と DB の banto_cod_fee が同じ答えを出すことを
 * test/cod.test.ts と test/db/cod.test.ts の両方で確かめる。fee: null は「代金引換を選べない」
 */
export const COD_FEE_CASES: { name: string; settings: Record<string, unknown>; amount: number; fee: number | null }[] = [
  { name: "設定なしは一律 0 円", settings: {}, amount: 5000, fee: 0 },
  { name: "一律", settings: { cod: { fee_type: "flat", fee_jpy: 330 } }, amount: 5000, fee: 330 },
  { name: "一律（fee_type なし）", settings: { cod: { fee_jpy: 440 } }, amount: 1, fee: 440 },
  { name: "一律の値が形違いなら 0", settings: { cod: { fee_jpy: "330" } }, amount: 5000, fee: 0 },
  { name: "一律の値が上限超えなら 0", settings: { cod: { fee_jpy: 100001 } }, amount: 5000, fee: 0 },
  { name: "段: 最初の段", settings: { cod: { fee_type: "tiers", fee_tiers: [{ upto: 10000, fee: 330 }, { upto: 30000, fee: 440 }] } }, amount: 10000, fee: 330 },
  { name: "段: 次の段", settings: { cod: { fee_type: "tiers", fee_tiers: [{ upto: 10000, fee: 330 }, { upto: 30000, fee: 440 }] } }, amount: 10001, fee: 440 },
  { name: "段: どれにも当たらない", settings: { cod: { fee_type: "tiers", fee_tiers: [{ upto: 10000, fee: 330 }, { upto: 30000, fee: 440 }] } }, amount: 30001, fee: null },
  { name: "段: 並びが逆でも小さい順", settings: { cod: { fee_type: "tiers", fee_tiers: [{ upto: 30000, fee: 440 }, { upto: 10000, fee: 330 }] } }, amount: 9000, fee: 330 },
  { name: "段: 形の違う段は捨てる", settings: { cod: { fee_type: "tiers", fee_tiers: [{ upto: "5000", fee: 100 }, { upto: 10000, fee: 1.5 }, { upto: 20000, fee: 550 }] } }, amount: 3000, fee: 550 },
  { name: "段: 空なら選べない", settings: { cod: { fee_type: "tiers", fee_tiers: [] } }, amount: 3000, fee: null },
  { name: "段: 配列でなければ選べない", settings: { cod: { fee_type: "tiers", fee_tiers: { upto: 1 } } }, amount: 1, fee: null },
  {
    name: "段: 11 段目は見ない",
    settings: { cod: { fee_type: "tiers", fee_tiers: [...Array.from({ length: 10 }, (_, i) => ({ upto: (i + 1) * 100, fee: i })), { upto: 100000, fee: 999 }] } },
    amount: 5000,
    fee: null,
  },
  { name: "0 円は一律の値", settings: { cod: { fee_type: "flat", fee_jpy: 330 } }, amount: 0, fee: 330 },
];
