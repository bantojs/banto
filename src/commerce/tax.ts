/**
 * 消費税（0017_tax、docs/tax.md）。税率ごとの対象額と消費税額の計算はここだけ（確認画面・領収書・管理画面）。
 *
 * - 価格はすべて税込（総額表示）。消費税額は「税率ごとの税込の合計」から 1 回だけ求める（インボイスの決まり。明細ごとに端数を出さない）。
 * - 税率は商品の区分（products.tax_class）とショップの設定から決め、注文には確定した時点の税率を残す（order_items.tax_rate 等）。
 * - 値引き（クーポン）は、商品ごとの値引き（src/commerce/discounts.ts の lines、order_items.discount_jpy）と送料の値引きを
 *   その明細から差し引く。商品ごとの値引きが分からない分（古い注文など）だけ、税率ごとの合計の比で按分する。送料は標準税率。
 */
export type TaxClass = "standard" | "reduced" | "exempt";
export type TaxRounding = "floor" | "round" | "ceil";

export const TAX_CLASSES: readonly TaxClass[] = ["standard", "reduced", "exempt"];
export const TAX_ROUNDINGS: readonly TaxRounding[] = ["floor", "round", "ceil"];

export function isTaxClass(v: unknown): v is TaxClass {
  return typeof v === "string" && (TAX_CLASSES as readonly string[]).includes(v);
}

/** 商品の区分（決まっていなければ標準） */
export function taxClassOf(product: { tax_class?: unknown }): TaxClass {
  return isTaxClass(product.tax_class) ? product.tax_class : "standard";
}

function rateSetting(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^[0-9]{1,2}(\.[0-9]{1,2})?$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n < 100 ? n : fallback;
}

/** ショップの税率（標準・軽減）。SQL の banto_shop_tax_rate と同じ既定 */
export function shopTaxRates(settings: Record<string, unknown> | null | undefined): { standard: number; reduced: number } {
  const s = settings ?? {};
  return { standard: rateSetting(s["tax_rate"], 10), reduced: rateSetting(s["tax_rate_reduced"], 8) };
}

export function rateFor(cls: TaxClass, rates: { standard: number; reduced: number }): number {
  return cls === "exempt" ? 0 : cls === "reduced" ? rates.reduced : rates.standard;
}

export function taxRoundingOf(v: unknown): TaxRounding {
  return typeof v === "string" && (TAX_ROUNDINGS as readonly string[]).includes(v) ? (v as TaxRounding) : "floor";
}

/** 税込の金額に含まれる消費税額（1 回だけ端数を処理する） */
export function includedTaxOf(amountJpy: number, rate: number, rounding: TaxRounding): number {
  if (rate <= 0 || amountJpy <= 0) return 0;
  const r = Math.round(rate * 100);
  const num = amountJpy * r;
  const den = 10000 + r;
  return rounding === "ceil" ? Math.ceil(num / den) : rounding === "round" ? Math.round(num / den) : Math.floor(num / den);
}

export interface TaxGroup {
  /** 税率（%）。0 は非課税・不課税 */
  rate: number;
  /** 税込の対象額（値引きの按分後） */
  amount_jpy: number;
  /** うち消費税額 */
  tax_jpy: number;
}

/**
 * 税率ごとの対象額と消費税額。lines は税込の金額（明細の小計・送料）と税率、その明細の値引き（discount_jpy）。
 * unallocatedJpy は明細に割り当てられていない値引きで、税率ごとの合計の比で按分する。戻り値は税率の高い順、対象額が 0 の税率は出さない。
 */
export function taxBreakdown(lines: { amount_jpy: number; rate: number; discount_jpy?: number }[], unallocatedJpy: number, rounding: TaxRounding): TaxGroup[] {
  const sums = new Map<number, number>();
  for (const l of lines) {
    const net = l.amount_jpy - Math.min(Math.max(0, l.discount_jpy ?? 0), l.amount_jpy);
    if (net > 0) sums.set(l.rate, (sums.get(l.rate) ?? 0) + net);
  }
  const groups = [...sums.entries()].map(([rate, amount]) => ({ rate, amount })).sort((a, b) => b.rate - a.rate);
  const total = groups.reduce((n, g) => n + g.amount, 0);
  const discount = Math.max(0, Math.min(unallocatedJpy, total));
  if (discount > 0 && total > 0) {
    let left = discount;
    const shares = groups.map((g) => Math.floor((discount * g.amount) / total));
    shares.forEach((s) => (left -= s));
    // 端数は合計の大きい税率に寄せる
    const largest = groups.reduce((best, g, i) => (g.amount > groups[best]!.amount ? i : best), 0);
    shares[largest]! += left;
    groups.forEach((g, i) => (g.amount -= shares[i]!));
  }
  return groups.filter((g) => g.amount > 0).map((g) => ({ rate: g.rate, amount_jpy: g.amount, tax_jpy: includedTaxOf(g.amount, g.rate, rounding) }));
}

/** 確定した注文（lookup_order・member_order・管理画面）の税率ごとの内訳。0017 の前の注文は標準税率として扱う */
export function orderTaxBreakdown(
  order: {
    shipping_jpy?: number | null;
    discount_jpy?: number | null;
    shipping_tax_rate?: number | string | null;
    tax_rounding?: string | null;
    items: { qty: number; unit_price_jpy: number; tax_rate?: number | string | null; discount_jpy?: number | null }[];
  },
  shopSettings: Record<string, unknown> | null | undefined,
): TaxGroup[] {
  const std = shopTaxRates(shopSettings).standard;
  const num = (v: number | string | null | undefined) => (v === null || v === undefined || v === "" ? std : Number(v));
  const shipping = order.shipping_jpy ?? 0;
  const total = Math.max(0, order.discount_jpy ?? 0);
  // 商品ごとの値引き（0010 の order_items.discount_jpy）。残りは送料の値引き、送料を超えた分（古い注文など）は按分
  const itemDiscount = order.items.reduce((n, i) => n + Math.max(0, i.discount_jpy ?? 0), 0);
  const shippingDiscount = Math.min(shipping, Math.max(0, total - itemDiscount));
  const unallocated = Math.max(0, total - itemDiscount - shippingDiscount);
  return taxBreakdown(
    [
      ...order.items.map((i) => ({ amount_jpy: i.qty * i.unit_price_jpy, rate: num(i.tax_rate), discount_jpy: Math.max(0, i.discount_jpy ?? 0) })),
      { amount_jpy: shipping, rate: num(order.shipping_tax_rate), discount_jpy: shippingDiscount },
    ],
    unallocated,
    taxRoundingOf(order.tax_rounding ?? (shopSettings ?? {})["tax_rounding"]),
  );
}
