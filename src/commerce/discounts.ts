/**
 * 値引きの判定と計算（クーポン）。お金に関わる判定の一本道（CLAUDE.md §7）。
 * チェックアウト（src/commerce/checkout.ts）だけが呼び、同梱テーマとヘッドレス API の両方がそこを通る。
 *
 * ここは純粋な計算だけを行う（DB に触らない）。キャンペーンは coupon_lookup（0010、service_role）で引いたもの。
 * 回数の上限（全体・1 人あたり）は、確定前に apply_reservation_discounts が Postgres の中で原子的に確かめ直す。
 * docs/knowledge/09-coupons.md
 */

import { productCategoryIds } from "../products/categories";

export type CouponKind = "percent" | "fixed" | "free_shipping";

/** 対象と条件（coupon_campaigns.conditions）。すべて任意。宣言型で、任意のコードは動かさない */
export interface CouponConditions {
  /** 対象の商品（指定があればこの商品だけ） */
  product_ids?: string[];
  /** 除く商品 */
  exclude_product_ids?: string[];
  /** 対象のカテゴリー（子孫のカテゴリーを含む）。主カテゴリーか追加カテゴリーのどれか 1 つが合えば対象 */
  category_ids?: string[];
  /** 除くカテゴリー（子孫を含む）。主カテゴリーか追加カテゴリーのどれか 1 つが合えば除く */
  exclude_category_ids?: string[];
  /** 対象のタグ（0042。どれか 1 つを持つ商品が対象。src/products/tags.ts と同じ正規化） */
  tags?: string[];
  /** 除くタグ（どれか 1 つを持つ商品を除く） */
  exclude_tags?: string[];
  /** 対象のブランド（0044。商品のブランドがどれかに合う商品が対象。前後の空白と大文字小文字は区別しない） */
  brands?: string[];
  /** 除くブランド */
  exclude_brands?: string[];
  /**
   * 使える支払い方法（0044）。"stripe" / "komoju"（KOMOJU のどれでも）/ "komoju:<種類>"（credit_card・konbini・paypay など）。
   * 支払い方法は確認画面の前に選ぶので、確認画面と確定で判定する（カートでは仮に通す）。
   * KOMOJU で種類を絞ったクーポンを使うと、決済ページに出す支払い方法もその種類だけにする（DiscountResult.paymentTypes）
   */
  payment_methods?: string[];
  /** セール品（通常価格が付いている SKU）を除く */
  exclude_sale?: boolean;
  /** 対象商品の合計（値引き前）の下限・上限 */
  min_subtotal_jpy?: number;
  max_subtotal_jpy?: number;
  /** 対象商品の点数の下限 */
  min_qty?: number;
  /**
   * 会員の独自項目（0049。customers.attributes、定義は shops.settings.customer_fields）。{ "<鍵>": ["値", ...] }。
   * ログイン中の会員のその項目の値がどれかに合うときだけ使える（鍵が複数なら全部）。前後の空白と大文字小文字は区別しない。
   * ゲストには使えない。値は CRM などの外部の顧客マスタが API で写したもの（docs/knowledge/13-external-customer-master.md）
   */
  attributes?: Record<string, (string | number)[]>;
}

export interface Campaign {
  id: string;
  name: string;
  code: string | null;
  kind: CouponKind;
  value: number;
  starts_at: string | null;
  ends_at: string | null;
  usage_limit: number | null;
  per_customer_limit: number | null;
  combinable: boolean;
  audience: "public" | "members";
  conditions: CouponConditions;
  active: boolean;
  /** この人の使用回数（subject が分からないときは 0） */
  used_by_subject: number;
  /** 空き枠があるか（上限なしなら true） */
  available: boolean;
  /**
   * 発行済みのクーポン（0019）のコードで引いたとき。1 枚が 1 回分で、全体の上限・1 人あたりの回数は見ない。
   * customer_id があればその会員だけが使える
   */
  grant?: { id: string; status: string; expires_at: string | null; customer_id: string | null };
}

export interface DiscountLine {
  sku_id: string;
  product_id: string;
  category_id: string | null;
  /** 追加カテゴリー（0042） */
  extra_category_ids?: string[];
  /** 商品のタグ */
  tags?: string[];
  /** 商品のブランド */
  brand?: string | null;
  unit_price_jpy: number;
  qty: number;
  /** セール中（通常価格が付いている） */
  sale: boolean;
}

export type RejectReason =
  | "not_found"
  | "inactive"
  | "not_started"
  | "ended"
  | "members_only"
  | "limit_reached"
  | "exhausted"
  | "not_combinable"
  | "too_many"
  | "no_eligible_items"
  | "min_subtotal"
  | "max_subtotal"
  | "min_qty"
  /** 発行済みのクーポン: 使用済み・取り消し済み・ほかの注文で手続き中 */
  | "grant_used"
  /** 発行済みのクーポン: 期限切れ */
  | "grant_expired"
  /** 発行済みのクーポン: ほかの会員のもの（ログインしていない） */
  | "grant_other"
  /** このクーポンは選んだ支払い方法では使えない（0044） */
  | "payment_method"
  /** 会員の独自項目の条件に合わない（ゲストを含む。0049） */
  | "attributes";

export interface AppliedDiscount {
  campaign_id: string;
  code: string;
  name: string;
  kind: CouponKind;
  /** この値引きの額（送料無料なら送料の額） */
  amount_jpy: number;
  /** 発行済みのクーポン（0019）。apply_reservation_discounts がこの 1 枚を押さえる */
  grant_id?: string;
}

export interface RejectedCoupon {
  code: string;
  reason: RejectReason;
  /** min_subtotal ならあと何円、min_qty ならあと何点 */
  shortfall?: number;
}

export interface DiscountResult {
  applied: AppliedDiscount[];
  rejected: RejectedCoupon[];
  /** 商品ごとの値引き（sku_id → 円）。税率ごとの区分・領収書に使う */
  lines: Record<string, number>;
  /** 商品の値引きの合計 */
  itemDiscount: number;
  /** 送料の値引き */
  shippingDiscount: number;
  /** 値引きの合計（商品 + 送料） */
  total: number;
  /** KOMOJU の決済ページに出してよい支払い方法（クーポンが種類を絞ったときだけ。無ければ絞らない） */
  paymentTypes?: string[];
}

/** 支払い方法の条件の値の形 */
export const PAYMENT_METHOD_RE = /^(stripe|komoju|komoju:[a-z_]{1,40})$/;

export const MAX_COUPONS = 5;
export const COUPON_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

/** 入力されたコードを正規化（大文字・前後の空白なし）。形が違えば null */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const c = input.trim().toUpperCase();
  return COUPON_CODE_RE.test(c) ? c : null;
}

export const EMPTY_DISCOUNT: DiscountResult = { applied: [], rejected: [], lines: {}, itemDiscount: 0, shippingDiscount: 0, total: 0 };

export interface EvaluateContext {
  now: number;
  /** ログイン中の会員か */
  member: boolean;
  /** ログイン中の会員の ID（発行済みのクーポンの持ち主を確かめる） */
  memberId?: string | null;
  /** 商品のカテゴリーから最上位までの id（自分を含む）。カテゴリーの条件で子孫を含めるために使う */
  ancestors: (categoryId: string) => string[];
  /** 選んだ支払い方法（確認画面と確定）。カートではまだ決まっていないので無し（支払い方法の条件は仮に通す） */
  payment?: { provider: "stripe" | "komoju" };
  /** ログイン中の会員の独自項目（0049。coupon_lookup が載せる）。会員でなければ無し */
  attributes?: Record<string, unknown> | null;
}

const attrKey = (v: unknown) => String(v).trim().toLowerCase();

/** 会員の独自項目の条件（0049）。条件が無ければ通す。あればログイン中の会員で、鍵ごとにどれかの値に合うこと */
function attributesAllowed(cond: CouponConditions["attributes"] | undefined, ctx: EvaluateContext): boolean {
  if (!cond || typeof cond !== "object") return true;
  const keys = Object.keys(cond).filter((k) => Array.isArray(cond[k]) && cond[k]!.length > 0);
  if (keys.length === 0) return true;
  if (!ctx.member) return false;
  const attrs = ctx.attributes && typeof ctx.attributes === "object" ? ctx.attributes : {};
  return keys.every((k) => {
    const v = attrs[k];
    if (typeof v !== "string" && typeof v !== "number") return false;
    const have = attrKey(v);
    return cond[k]!.some((a) => (typeof a === "string" || typeof a === "number") && attrKey(a) === have);
  });
}

/** coupon_lookup の行に載るログイン中の会員の独自項目（0049）。無ければ null */
export function customerAttributesOf(rows: unknown): Record<string, unknown> | null {
  if (!Array.isArray(rows)) return null;
  for (const r of rows) {
    const a = r && typeof r === "object" ? (r as Record<string, unknown>)["customer_attributes"] : null;
    if (a && typeof a === "object" && !Array.isArray(a)) return a as Record<string, unknown>;
  }
  return null;
}

const brandKey = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** クーポンが KOMOJU で許す種類。null = どれでも、[] = KOMOJU では使えない */
function komojuAllowed(methods: string[]): string[] | null {
  if (methods.includes("komoju")) return null;
  return methods.filter((m) => m.startsWith("komoju:")).map((m) => m.slice(7));
}

function ids(v: unknown): Set<string> | null {
  return Array.isArray(v) && v.length > 0 ? new Set(v.filter((x): x is string => typeof x === "string")) : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

/** 条件に合う商品の行 */
function eligibleLines(lines: DiscountLine[], cond: CouponConditions, ctx: EvaluateContext): DiscountLine[] {
  const products = ids(cond.product_ids);
  const excludeProducts = ids(cond.exclude_product_ids);
  const categories = ids(cond.category_ids);
  const excludeCategories = ids(cond.exclude_category_ids);
  const tags = ids(cond.tags);
  const excludeTags = ids(cond.exclude_tags);
  const brands = ids(cond.brands?.map(brandKey));
  const excludeBrands = ids(cond.exclude_brands?.map(brandKey));
  return lines.filter((l) => {
    const cats = productCategoryIds(l).flatMap((id) => ctx.ancestors(id));
    const lineTags = Array.isArray(l.tags) ? l.tags : [];
    if (products && !products.has(l.product_id)) return false;
    if (categories && !cats.some((c) => categories.has(c))) return false;
    if (tags && !lineTags.some((x) => tags.has(x))) return false;
    if (excludeProducts?.has(l.product_id)) return false;
    if (excludeCategories && cats.some((c) => excludeCategories.has(c))) return false;
    if (excludeTags && lineTags.some((x) => excludeTags.has(x))) return false;
    if (brands && !brands.has(brandKey(l.brand))) return false;
    if (excludeBrands && excludeBrands.has(brandKey(l.brand))) return false;
    if (cond.exclude_sale === true && l.sale) return false;
    return true;
  });
}

/**
 * amount を lines の残り金額に比例して配分する（最大剰余法。1 円未満の端数は、端数の大きい行から 1 円ずつ）。
 * どの行も残り金額を超えない。戻り値は sku_id → 円
 */
function allocate(amount: number, lines: DiscountLine[], remaining: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  const base = lines.map((l) => ({ id: l.sku_id, rest: remaining.get(l.sku_id) ?? 0 })).filter((x) => x.rest > 0);
  const total = base.reduce((n, x) => n + x.rest, 0);
  const want = Math.min(amount, total);
  if (want <= 0 || total <= 0) return out;
  let given = 0;
  const parts = base.map((x) => {
    const exact = (want * x.rest) / total;
    const floor = Math.min(x.rest, Math.floor(exact));
    given += floor;
    return { ...x, floor, frac: exact - floor };
  });
  parts.sort((a, b) => b.frac - a.frac || a.id.localeCompare(b.id));
  for (const p of parts) {
    if (given >= want) break;
    if (p.floor < p.rest) {
      p.floor++;
      given++;
    }
  }
  for (const p of parts) if (p.floor > 0) out.set(p.id, p.floor);
  return out;
}

/**
 * 入力されたコード（入力順）とキャンペーンから、値引きを判定して計算する。
 *   - 最大 5 枚。併用できないクーポンは 1 枚だけで使う（先に入れたものを優先）
 *   - 計算の順は 割合（値引き前の金額にかける）→ 定額 → 送料無料。割合と定額は対象商品の金額にだけかかる
 *   - 値引きの合計は、対象商品の金額を超えない。割合は 1 円未満を切り捨てる
 * shipping は送料（未定のカートでは 0。送料無料のクーポンは確認画面で額が決まる）
 */
export function evaluateDiscounts(codes: string[], campaigns: Campaign[], lines: DiscountLine[], shipping: number, ctx: EvaluateContext): DiscountResult {
  const rejected: RejectedCoupon[] = [];
  const byCode = new Map(campaigns.filter((c) => c.code).map((c) => [c.code!, c]));
  const seen = new Set<string>();
  const valid: { c: Campaign; eligible: DiscountLine[] }[] = [];
  for (const raw of codes) {
    const code = normalizeCode(raw);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    if (seen.size > MAX_COUPONS) {
      rejected.push({ code, reason: "too_many" });
      continue;
    }
    const c = byCode.get(code);
    if (!c) {
      rejected.push({ code, reason: "not_found" });
      continue;
    }
    const g = c.grant;
    if (g && g.status !== "available") rejected.push({ code, reason: "grant_used" });
    else if (g && g.expires_at && Date.parse(g.expires_at) < ctx.now) rejected.push({ code, reason: "grant_expired" });
    else if (g && g.customer_id && g.customer_id !== ctx.memberId) rejected.push({ code, reason: "grant_other" });
    // 同じキャンペーンのクーポンは 1 注文に 1 枚
    else if (valid.some((v) => v.c.id === c.id)) rejected.push({ code, reason: "limit_reached" });
    else if (!c.active) rejected.push({ code, reason: "inactive" });
    else if (c.starts_at && Date.parse(c.starts_at) > ctx.now) rejected.push({ code, reason: "not_started" });
    else if (c.ends_at && Date.parse(c.ends_at) < ctx.now) rejected.push({ code, reason: "ended" });
    else if (c.audience === "members" && !ctx.member) rejected.push({ code, reason: "members_only" });
    else if (!g && c.per_customer_limit !== null && c.used_by_subject >= c.per_customer_limit) rejected.push({ code, reason: "limit_reached" });
    else if (!g && c.usage_limit !== null && !c.available) rejected.push({ code, reason: "exhausted" });
    else if (!attributesAllowed(c.conditions?.attributes, ctx)) rejected.push({ code, reason: "attributes" });
    else if (!paymentAllowed(c.conditions?.payment_methods, ctx)) rejected.push({ code, reason: "payment_method" });
    else {
      const cond = c.conditions ?? {};
      const eligible = eligibleLines(lines, cond, ctx);
      const subtotal = eligible.reduce((n, l) => n + l.unit_price_jpy * l.qty, 0);
      const qty = eligible.reduce((n, l) => n + l.qty, 0);
      const min = num(cond.min_subtotal_jpy);
      const max = num(cond.max_subtotal_jpy);
      const minQty = num(cond.min_qty);
      if (eligible.length === 0) rejected.push({ code, reason: "no_eligible_items" });
      else if (min !== null && subtotal < min) rejected.push({ code, reason: "min_subtotal", shortfall: min - subtotal });
      else if (max !== null && subtotal > max) rejected.push({ code, reason: "max_subtotal" });
      else if (minQty !== null && qty < minQty) rejected.push({ code, reason: "min_qty", shortfall: minQty - qty });
      else valid.push({ c, eligible });
    }
  }

  // 併用: 先に入れたクーポンを残し、併用できない組み合わせになるものを外す
  const kept: typeof valid = [];
  for (const v of valid) {
    if (kept.length > 0 && (!v.c.combinable || kept.some((k) => !k.c.combinable))) rejected.push({ code: v.c.code!, reason: "not_combinable" });
    else kept.push(v);
  }

  // KOMOJU: 使うクーポンが許す種類を重ねて絞る。重ならなくなるクーポンは外す（先に入れたものを優先）
  let paymentTypes: string[] | null = null;
  if (ctx.payment?.provider === "komoju")
    for (let i = 0; i < kept.length; i++) {
      const methods = (kept[i]!.c.conditions?.payment_methods ?? []).filter((m) => PAYMENT_METHOD_RE.test(m));
      if (methods.length === 0) continue;
      const allowed = komojuAllowed(methods);
      if (allowed === null) continue;
      const next: string[] = paymentTypes === null ? allowed : paymentTypes.filter((x) => allowed.includes(x));
      if (next.length === 0) {
        rejected.push({ code: kept[i]!.c.code!, reason: "payment_method" });
        kept.splice(i--, 1);
      } else paymentTypes = next;
    }

  const remaining = new Map(lines.map((l) => [l.sku_id, l.unit_price_jpy * l.qty]));
  const lineDiscounts = new Map<string, number>();
  const amounts = new Map<string, number>();
  const order: CouponKind[] = ["percent", "fixed", "free_shipping"];
  let shippingDiscount = 0;
  for (const kind of order)
    for (const { c, eligible } of kept.filter((k) => k.c.kind === kind)) {
      let amount = 0;
      if (kind === "free_shipping") {
        amount = Math.max(0, shipping - shippingDiscount);
        shippingDiscount += amount;
      } else {
        // 割合は値引き前の金額にかける（複数の割合クーポンを重ねても、掛け算で目減りさせない）
        const want = kind === "percent" ? Math.floor((eligible.reduce((n, l) => n + l.unit_price_jpy * l.qty, 0) * Math.min(100, c.value)) / 100) : c.value;
        for (const [id, yen] of allocate(want, eligible, remaining)) {
          remaining.set(id, (remaining.get(id) ?? 0) - yen);
          lineDiscounts.set(id, (lineDiscounts.get(id) ?? 0) + yen);
          amount += yen;
        }
      }
      amounts.set(c.id, amount);
    }

  const applied: AppliedDiscount[] = kept.map(({ c }) => ({ campaign_id: c.id, code: c.code!, name: c.name, kind: c.kind, amount_jpy: amounts.get(c.id) ?? 0, ...(c.grant ? { grant_id: c.grant.id } : {}) }));
  const itemDiscount = [...lineDiscounts.values()].reduce((n, x) => n + x, 0);
  return {
    applied,
    rejected,
    lines: Object.fromEntries(lineDiscounts),
    itemDiscount,
    shippingDiscount,
    total: itemDiscount + shippingDiscount,
    ...(paymentTypes ? { paymentTypes } : {}),
  };
}

/** 支払い方法の条件（選んだ方法が決まっていなければ仮に通す） */
function paymentAllowed(methods: string[] | undefined, ctx: EvaluateContext): boolean {
  const list = (Array.isArray(methods) ? methods : []).filter((m) => typeof m === "string" && PAYMENT_METHOD_RE.test(m));
  if (list.length === 0 || !ctx.payment) return true;
  if (ctx.payment.provider === "stripe") return list.includes("stripe");
  const allowed = komojuAllowed(list);
  return allowed === null || allowed.length > 0;
}

/** 1 人あたりの回数を数える単位。会員は会員 ID（メールアドレスを変えても同じ人）、ゲストはメールアドレスの SHA-256 */
export async function couponSubject(member: { id: string } | null | undefined, email: string | null | undefined): Promise<string | null> {
  if (member?.id && /^[0-9a-f-]{32,64}$/i.test(member.id)) return `c:${member.id.toLowerCase()}`;
  const e = (email ?? "").trim().toLowerCase();
  if (!e) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(e));
  return `e:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function grantOf(v: unknown): Campaign["grant"] | null {
  if (!v || typeof v !== "object") return null;
  const g = v as Record<string, unknown>;
  if (typeof g["id"] !== "string" || typeof g["status"] !== "string") return null;
  return { id: g["id"], status: g["status"], expires_at: typeof g["expires_at"] === "string" ? g["expires_at"] : null, customer_id: typeof g["customer_id"] === "string" ? g["customer_id"] : null };
}

/** coupon_lookup の結果を Campaign に整える（形の違う行は捨てる） */
export function parseCampaigns(rows: unknown): Campaign[] {
  if (!Array.isArray(rows)) return [];
  const out: Campaign[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const kind = o["kind"];
    if (typeof o["id"] !== "string" || (kind !== "percent" && kind !== "fixed" && kind !== "free_shipping")) continue;
    out.push({
      id: o["id"],
      name: typeof o["name"] === "string" ? o["name"] : "",
      code: typeof o["code"] === "string" ? o["code"] : null,
      kind,
      value: Number(o["value"] ?? 0),
      starts_at: typeof o["starts_at"] === "string" ? o["starts_at"] : null,
      ends_at: typeof o["ends_at"] === "string" ? o["ends_at"] : null,
      usage_limit: typeof o["usage_limit"] === "number" ? o["usage_limit"] : null,
      per_customer_limit: typeof o["per_customer_limit"] === "number" ? o["per_customer_limit"] : null,
      combinable: o["combinable"] === true,
      audience: o["audience"] === "members" ? "members" : "public",
      conditions: o["conditions"] && typeof o["conditions"] === "object" ? (o["conditions"] as CouponConditions) : {},
      active: o["active"] === true,
      used_by_subject: Number(o["used_by_subject"] ?? 0),
      available: o["available"] !== false,
      ...(grantOf(o["grant"]) ? { grant: grantOf(o["grant"])! } : {}),
    });
  }
  return out;
}
