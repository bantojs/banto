/**
 * 支払い方法の手数料（コアのお金の一本道。メンテナの決定 2026-11-23、0170、docs/plugins.md「KOMOJU」）。
 * 代引き手数料（0157、settings.cod）と同じ形の決まり（一律か金額の段）を、KOMOJU の支払い方法ごとに
 * settings.payment_fees.<種類> に置く。決まりの読み方は 1 つ（feeOfRule）で、DB の banto_fee_rule と同じ答えを出す
 * （答え合わせの表 test/fixtures/cod-fee-cases.ts・payment-fee-cases.ts）。確定のとき DB が引き直し、1 円でも違えば確定しない。
 *
 * KOMOJU だけ: お客様は Banto の確認画面で種類（コンビニ払い・銀行振込…）を選び、決済ページはその種類だけに絞る
 * （決済ページで別の種類に選び直して手数料を外せないように）。Stripe のコンビニ払いは決済ページの期限が 35 分で勧めないので対象にしない。
 */

import { t, tf } from "../i18n";

/** 0170 を当てるまで管理画面の手数料の画面を出さない（お客様の画面は公開の settings に payment_fees が無いので今までどおり） */
export const PAYMENT_FEES_MIGRATION = "0170_payment_fees";

export const FEE_MAX = 100_000;
export const FEE_UPTO_MAX = 10_000_000;
export const FEE_MAX_TIERS = 10;
/** settings.payment_fees に置ける種類の数（管理画面が保存のときに確かめる。読むときは数えない） */
export const PAYMENT_FEE_MAX_TYPES = 20;
export const KOMOJU_TYPE_RE = /^[a-z_]{1,40}$/;

export interface FeeTier {
  /** この金額（手数料の対象の金額、円）まで */
  upto: number;
  fee: number;
}

export interface FeeRule {
  fee_type: "flat" | "tiers";
  /** 一律の手数料 */
  fee_jpy: number;
  /** 金額の段（upto の小さい順） */
  fee_tiers: FeeTier[];
}

const intIn = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const objectOf = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** 段の有効なもの（10 個まで・形の違う値は捨てる）を upto の小さい順に。DB の banto_fee_rule と同じ */
export function feeTiers(raw: unknown): FeeTier[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, FEE_MAX_TIERS)
    .map((t, i) => {
      const o = objectOf(t);
      const upto = intIn(o["upto"], 1, FEE_UPTO_MAX);
      const fee = intIn(o["fee"], 0, FEE_MAX);
      return upto === null || fee === null ? null : { upto, fee, i };
    })
    .filter((t): t is FeeTier & { i: number } => t !== null)
    .sort((a, b) => a.upto - b.upto || a.i - b.i)
    .map(({ upto, fee }) => ({ upto, fee }));
}

/** 決まりを読む（形の違う値は既定: 一律 0 円） */
export function readFeeRule(raw: unknown): FeeRule {
  const o = objectOf(raw);
  return {
    fee_type: o["fee_type"] === "tiers" ? "tiers" : "flat",
    fee_jpy: intIn(o["fee_jpy"], 0, FEE_MAX) ?? 0,
    fee_tiers: feeTiers(o["fee_tiers"]),
  };
}

/**
 * 決まり（{ fee_type, fee_jpy, fee_tiers }）と手数料の対象の金額（小計 + 送料 - 値引き）から手数料（円）。
 * 使えないとき（段のどれにも当たらない・段が無い・金額が負）は null。DB の banto_fee_rule(rule, amount) と同じ
 */
export function feeOfRule(raw: unknown, amount: number): number | null {
  if (!Number.isInteger(amount) || amount < 0) return null;
  const r = readFeeRule(raw);
  if (r.fee_type === "tiers") {
    const tier = r.fee_tiers.find((t) => amount <= t.upto);
    return tier ? tier.fee : null;
  }
  return r.fee_jpy;
}

/** settings.payment_fees（種類 → 決まり）。種類の形が合い、値がオブジェクトのものだけ */
export function paymentFeeRules(settings: Record<string, unknown> | null | undefined): Map<string, FeeRule> {
  const raw = objectOf((settings ?? {})["payment_fees"]);
  const out = new Map<string, FeeRule>();
  for (const [k, v] of Object.entries(raw)) {
    if (!KOMOJU_TYPE_RE.test(k) || !v || typeof v !== "object" || Array.isArray(v)) continue;
    out.set(k, readFeeRule(v));
  }
  return out;
}

/** 手数料を決めたショップか（KOMOJU を種類ごとに分けて並べる） */
export function hasPaymentFees(settings: Record<string, unknown> | null | undefined): boolean {
  return paymentFeeRules(settings).size > 0;
}

/**
 * KOMOJU の種類（type）の手数料。決まりの無い種類は 0、使えない（段に当たらない）ときは null。
 * DB の banto_payment_fee(settings, 'komoju:<type>', amount) と同じ
 */
export function komojuFee(settings: Record<string, unknown> | null | undefined, type: string, amount: number): number | null {
  if (!Number.isInteger(amount) || amount < 0) return null;
  if (!KOMOJU_TYPE_RE.test(type)) return 0;
  const rule = objectOf((settings ?? {})["payment_fees"])[type];
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return 0;
  return feeOfRule(rule, amount);
}

export interface KomojuMethod {
  type: string;
  /** 決まり（無ければ手数料なし） */
  rule: FeeRule | null;
}

/**
 * 確認画面で並べる KOMOJU の種類。手数料の決まりが無いショップは null（今までどおり「KOMOJU」1 つ）。
 * 受け付ける種類（プラグインの設定 payment_types）があればその順に、無ければ決まりのある種類だけ
 * （決済ページを種類で絞れない「すべて」は、手数料のある種類を外せないので出さない）
 */
export function komojuMethods(settings: Record<string, unknown> | null | undefined, configured: string[]): KomojuMethod[] | null {
  const rules = paymentFeeRules(settings);
  if (rules.size === 0) return null;
  const types = configured.length > 0 ? configured.filter((x) => KOMOJU_TYPE_RE.test(x)) : [...rules.keys()];
  return types.map((type) => ({ type, rule: rules.get(type) ?? null }));
}

/** 決まりの見出し（カート・確認画面の「手数料 220 円」）。段なら金額で変わるので null */
export function flatFee(rule: FeeRule | null): number | null {
  if (!rule) return 0;
  return rule.fee_type === "flat" ? rule.fee_jpy : null;
}

/** カートのボタン・Liquid の cart.banto_payment_methods の名前（「コンビニ払い（KOMOJU・手数料 220 円）」） */
export function komojuMethodButtonLabel(m: { name: string; fee: number | null }): string {
  if (m.fee === null) return tf("store.pay_with_komoju_fee_varies", { method: m.name });
  if (m.fee > 0) return tf("store.pay_with_komoju_fee", { method: m.name, fee: m.fee.toLocaleString("ja-JP") });
  return tf("store.pay_with_komoju_type", { method: m.name });
}

/** 手数料の見出し: 代金引換は「代引き手数料」、ほか（KOMOJU の種類の手数料）は「お支払い手数料」 */
export function feeLabelFor(provider: unknown): string {
  return t(provider === "cod" ? "confirm.cod_fee" : "confirm.payment_fee");
}

/** KOMOJU の種類の名前として知っているもの（表示名のある種類）。知らない名前は警告だけ（保存はできる） */
export const KOMOJU_KNOWN_TYPES: readonly string[] = ["credit_card", "konbini", "bank_transfer", "pay_easy", "paypay", "linepay", "merpay", "rakutenpay", "aupay", "web_money"];

export type PaymentFeeWarning = { kind: "types_empty" } | { kind: "not_accepted"; type: string } | { kind: "unknown_type"; type: string };

/**
 * 管理画面の警告。configured は KOMOJU のプラグインの「受け付ける支払い方法」（読めない・プラグインが無いときは null）。
 * 受け付ける支払い方法が空のまま決まりを足すと、決まりのある種類だけが並ぶ（ほかの支払い方法が消える）ので知らせる
 */
export function paymentFeeWarnings(ruleTypes: string[], configured: string[] | null): PaymentFeeWarning[] {
  const out: PaymentFeeWarning[] = [];
  if (ruleTypes.length === 0) return out;
  if (configured !== null && configured.length === 0) out.push({ kind: "types_empty" });
  for (const type of ruleTypes) {
    if (configured !== null && configured.length > 0 && !configured.includes(type)) out.push({ kind: "not_accepted", type });
    if (!KOMOJU_KNOWN_TYPES.includes(type)) out.push({ kind: "unknown_type", type });
  }
  return out;
}
