/**
 * 代金引換（同梱モジュール cod、既定 OFF。0157_mod_cod、docs/cod.md。メンテナの決定 2026-11-18）。
 * 支払いを待たずにその場で「受付（未入金）」の注文として確定する（「確定は Webhook のみ」の 3 つ目の例外）。
 * お金は配達のときに運送会社が集め、運営者が入金を記録すると入金済みになる（0156、order.paid はそのとき）。
 * 代引き手数料はコアのお金の一本道（送料と同じ）: 計算はここ（codFee）と DB の banto_cod_fee が同じ決まりで行い、
 * 答え合わせの表（test/fixtures/cod-fee-cases.ts）で縛る。確定のとき DB が引き直し、1 円でも違えば確定しない。
 */
import { COD_MIGRATION, moduleEnabled } from "../registry";
import { FEE_MAX, FEE_MAX_TIERS, FEE_UPTO_MAX, feeOfRule, feeTiers, type FeeTier } from "../../commerce/payment-fees";

export { COD_MIGRATION };
export const COD_MODULE = "cod";
export const COD_PROVIDER = "cod";
/** 上限金額（合計・手数料込み）の既定。運送会社の代引きの一般的な上限 */
export const COD_DEFAULT_MAX_TOTAL = 300_000;
// 決まりの形（一律か金額の段）は支払い方法の手数料（0170、src/commerce/payment-fees.ts）と共通
export const COD_MAX_TIERS = FEE_MAX_TIERS;
export const COD_FEE_MAX = FEE_MAX;
export const COD_UPTO_MAX = FEE_UPTO_MAX;

export type CodTier = FeeTier;

export interface CodSettings {
  fee_type: "flat" | "tiers";
  /** 一律の手数料 */
  fee_jpy: number;
  /** 金額の段（upto の小さい順） */
  fee_tiers: CodTier[];
  /** 合計（手数料込み）の上限 */
  max_total_jpy: number;
  /** 会員だけ（ゲストには出さない） */
  members_only: boolean;
  /** 最終確認画面の「お支払い」に添える文（500 字まで。無ければショップの支払いの説明） */
  note: string;
}

export const COD_NOTE_MAX = 500;

const intIn = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null);

/** 段の有効なもの（10 個まで・形の違う値は捨てる）を upto の小さい順に。DB の banto_fee_rule と同じ */
export const codTiers = feeTiers;

/** 設定を読む（形の違う値は既定）。モジュールが OFF でも読む（画面用）。ON かどうかは codSettings */
export function readCodSettings(settings: Record<string, unknown> | null | undefined): CodSettings {
  const raw = (settings ?? {})["cod"];
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    fee_type: o["fee_type"] === "tiers" ? "tiers" : "flat",
    fee_jpy: intIn(o["fee_jpy"], 0, COD_FEE_MAX) ?? 0,
    fee_tiers: codTiers(o["fee_tiers"]),
    max_total_jpy: intIn(o["max_total_jpy"], 1, COD_UPTO_MAX) ?? COD_DEFAULT_MAX_TOTAL,
    members_only: o["members_only"] === true,
    note: typeof o["note"] === "string" ? o["note"].trim().slice(0, COD_NOTE_MAX) : "",
  };
}

/** モジュールが OFF なら null */
export function codSettings(settings: Record<string, unknown> | null | undefined): CodSettings | null {
  return moduleEnabled(settings, COD_MODULE) ? readCodSettings(settings) : null;
}

/** 最終確認画面の「お支払い」に添える文。無ければ null */
export function codNote(settings: Record<string, unknown> | null | undefined): string | null {
  return readCodSettings(settings).note || null;
}

/**
 * 手数料（円）。amount は手数料の対象の金額（小計 + 送料 - 値引き）。使えないとき（段のどれにも当たらない・段が無い）は null。
 * DB の banto_cod_fee(settings, amount) と同じ（settings はショップの settings をそのまま）
 */
export function codFee(settings: Record<string, unknown> | null | undefined, amount: number): number | null {
  // 決まりの読み方は支払い方法の手数料と共通（feeOfRule。DB は banto_cod_fee → banto_fee_rule）
  return feeOfRule((settings ?? {})["cod"], amount);
}

export type CodBlock = "module" | "fee" | "max_total" | "members_only";

/**
 * 代引きで買えるか（手数料つき）。amount は手数料の対象の金額。DB の confirm_reservation と同じ順に確かめる。
 * 0 円の注文は支払いが無いので手数料も 0（呼び出し側が 0 円の注文として確定する）
 */
export function codQuote(settings: Record<string, unknown> | null | undefined, amount: number, member: boolean): { ok: true; fee: number } | { ok: false; reason: CodBlock } {
  const s = codSettings(settings);
  if (!s) return { ok: false, reason: "module" };
  if (amount === 0) return { ok: true, fee: 0 };
  const fee = codFee(settings, amount);
  if (fee === null) return { ok: false, reason: "fee" };
  if (amount + fee > s.max_total_jpy) return { ok: false, reason: "max_total" };
  if (s.members_only && !member) return { ok: false, reason: "members_only" };
  return { ok: true, fee };
}
