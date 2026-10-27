/**
 * チェックアウトの中核。同梱テーマの画面（src/routes/storefront）とヘッドレス API（src/routes/api）の両方がここを通る。
 *
 *   カート（SKU と数量）→ quote（配送先・送料・合計を確定した「最終確認の内容」、署名付き）→ placeOrder（在庫予約 → 決済ページ）
 *
 * 金額・在庫・送料の判定はすべてここで行い、連携側（表側の画面）には計算させない。
 * quote は購入者に見せた内容そのもの。確定時に価格・送料・在庫を引き直し、1 円でも違えば確定せずに出し直す
 * （特商法の最終確認画面で見せた内容と、実際の申込み内容を一致させるため。docs/headless.md）。
 */
import type { PublicShop, StorefrontData } from "../storefront/data";
import type { Cart, CartItem } from "../cart/cart";
import { normalizeCart } from "../cart/cart";
import { openJson, randomToken, sealJson } from "../util/signed";
import { ipHash, subjectHash } from "../members/auth";
import { PREFECTURES, describeShipping, isPrefecture, parseShippingSettings, shippingFee, taxRate } from "./shipping";
import type { AddressFormValues, CartLine } from "../themes/types";
import { PrivilegedRpcError, type PrivilegedDb, type ReserveLimits } from "../db/privileged";
import { StripeError, type StripeClient } from "../payments/stripe";
import { KomojuError, parsePaymentTypes, reservationSeconds, type createKomojuClient } from "../plugins/komoju";
import { t, type MessageKey } from "../i18n";
import { EMPTY_DISCOUNT, couponSubject, customerAttributesOf, evaluateDiscounts, parseCampaigns, type DiscountLine, type DiscountResult, type RejectedCoupon } from "./discounts";
import { marketingConsentEnabled } from "../customers/fields";
import { shopHome } from "../storefront/urls";
import { checkDelivery, deliveryText, isDeliverySlot } from "../modules/delivery-time";
import { rateFor, shopTaxRates, taxBreakdown, taxClassOf, taxRoundingOf, type TaxGroup } from "./tax";

export type Provider = "stripe" | "komoju";
export const PROVIDERS: readonly Provider[] = ["stripe", "komoju"];

export function isProvider(s: unknown): s is Provider {
  return s === "stripe" || s === "komoju";
}

/**
 * Stripe Checkout の expires_at。Stripe 側の下限は「作成から 30 分」で、Worker の時計と往復の遅れで
 * ぴったり 30 分だと「at least 30 minutes in the future」で弾かれることがあるため、35 分にする。
 */
export const STRIPE_CHECKOUT_EXPIRES_SECONDS = 35 * 60;
/** 予約 TTL（Stripe）。決済ページより後に切れるようにし、解放は expired Webhook に任せる（届かなければ Cron が戻す） */
export const CHECKOUT_TTL_SECONDS = STRIPE_CHECKOUT_EXPIRES_SECONDS + 5 * 60;
/** quote の有効期限。確認画面を開いたまま放置された場合は出し直す */
export const QUOTE_TTL_SECONDS = 60 * 60;

/** 照会トークンの期限。戻り先の画面を後から開き直しても引けるように長め（返るのは注文番号・状態・合計だけで、個人情報は無い） */
export const STATUS_TOKEN_TTL_SECONDS = 24 * 60 * 60;
/** 確定時に success_url へ付ける照会トークンのクエリ名（ヘッドレス）。同梱テーマは /checkout/done?s= */
export const STATUS_QUERY_PARAM = "banto_status";

export interface StatusToken {
  quoteId: string;
  /** 発行時刻（秒）。同梱テーマの完了画面が「確認中」の自動更新をいつまで続けるかに使う */
  issuedAt: number;
}

/**
 * 照会トークン: quote の識別子（reservations.quote_id）をショップごとに署名したもの。確定の直前に出し、
 * success_url に付け、応答にも入れる。戻り先はこれで GET /api/shops/<slug>/checkout/status を呼ぶ。
 * 予約 id ではなく quote の識別子を使うのは、予約を作る前（決済ページの URL を組む前）に決まるから
 */
export async function sealStatusToken(secret: string, shopId: string, quoteId: string, now: number = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  return sealJson(secret, { t: "status", s: shopId, q: quoteId, iat, exp: iat + STATUS_TOKEN_TTL_SECONDS });
}

export async function openStatusToken(secret: string, token: string | undefined, shopId: string, now: number = Date.now()): Promise<StatusToken | null> {
  if (!token || token.length > 512) return null;
  const raw = (await openJson(secret, token)) as { t?: unknown; s?: unknown; q?: unknown; iat?: unknown; exp?: unknown } | null;
  if (!raw || raw.t !== "status" || raw.s !== shopId || typeof raw.q !== "string" || typeof raw.exp !== "number" || typeof raw.iat !== "number") return null;
  if (raw.exp * 1000 < now) return null;
  return { quoteId: raw.q, issuedAt: raw.iat };
}

/** URL にクエリを 1 つ足す（? か & を選ぶ。フラグメントは保つ） */
export function withQueryParam(url: string, key: string, value: string): string {
  const hash = url.indexOf("#");
  const base = hash >= 0 ? url.slice(0, hash) : url;
  const frag = hash >= 0 ? url.slice(hash) : "";
  return `${base}${base.includes("?") ? "&" : "?"}${encodeURIComponent(key)}=${encodeURIComponent(value)}${frag}`;
}
/**
 * 決済事業者が受け付ける最低額（Stripe の円は 50 円）。1〜49 円の注文は確定できない。
 * 0 円の注文（クーポンで全額値引き・0 円の商品）は決済なしで確定する（placeOrder、02-decisions.md）
 */
export const MIN_PAYMENT_JPY = 50;
/** 決済なしで確定した注文の payment_provider */
export const FREE_PROVIDER = "free";

// ---------- カートの値付け ----------

export interface PricedCart {
  lines: CartLine[];
  subtotal: number;
  /** 非公開になった・削除された SKU（カートから外す） */
  dropped: string[];
  /** 表示できる行だけに整えたカート */
  cart: Cart;
}

/** カートの各行に現在の価格と在庫を付ける。価格は常に DB から読む（カートには数量しか持たない） */
export async function priceCart(sf: StorefrontData, shop: PublicShop, cart: Cart): Promise<PricedCart> {
  const found = await sf.skusForCart(
    shop,
    cart.items.map((i) => i.sku_id),
  );
  const lines: CartLine[] = [];
  const dropped: string[] = [];
  for (const item of cart.items) {
    const hit = found.get(item.sku_id);
    if (!hit) {
      dropped.push(item.sku_id);
      continue;
    }
    lines.push({ sku: hit.sku, product: hit.product, qty: item.qty, short: hit.sku.available < item.qty });
  }
  return {
    lines,
    subtotal: lines.reduce((n, l) => n + l.sku.price_jpy * l.qty, 0),
    dropped,
    cart: { items: lines.map((l) => ({ sku_id: l.sku.id, qty: l.qty })) },
  };
}

// ---------- 値引き（クーポン） ----------

/**
 * クーポンの判定の材料。同梱モジュール coupons が ON のショップでだけ渡す（OFF なら null で、DB に問い合わせない）。
 * 実体は coupon_lookup（service_role、0010）。購入者の画面からキャンペーンの表を直接は読ませない
 */
export interface CouponSource {
  /** customerId: ログイン中の会員（行に会員の独自項目 customer_attributes が載る。0049） */
  lookup(codes: string[], subject: string | null, customerId?: string | null): Promise<unknown[]>;
}

interface DiscountContext {
  sf: StorefrontData;
  shop: PublicShop;
  coupons?: CouponSource | null;
  member?: { id: string } | null;
  now?: () => number;
}

/** カートの値引き。コードが無い・モジュールが OFF なら DB に触らず「値引きなし」 */
/** provider: 選んだ支払い方法（確認画面と確定）。カートでは無し（支払い方法の条件は仮に通す） */
export async function discountCart(ctx: DiscountContext, priced: PricedCart, codes: string[] | undefined, shipping: number, email: string | null, provider?: Provider): Promise<DiscountResult> {
  if (!ctx.coupons || !codes || codes.length === 0 || priced.lines.length === 0) return EMPTY_DISCOUNT;
  const subject = await couponSubject(ctx.member, email);
  // 会員の独自項目の条件（0049）: ログイン中の会員の id を渡して、判定の材料に attributes を載せてもらう（往復は増やさない）
  const memberId = ctx.member?.id ?? null;
  const [rows, categories] = await Promise.all([ctx.coupons.lookup(codes, subject, memberId), ctx.sf.listCategories(ctx.shop)]);
  const parent = new Map(categories.map((c) => [c.id, c.parent_id ?? null]));
  const lines: DiscountLine[] = priced.lines.map((l) => ({
    sku_id: l.sku.id,
    product_id: l.product.id,
    category_id: l.product.category_id ?? null,
    extra_category_ids: l.product.extra_category_ids ?? [],
    tags: Array.isArray(l.product.tags) ? l.product.tags : [],
    brand: l.product.brand ?? null,
    unit_price_jpy: l.sku.price_jpy,
    qty: l.qty,
    sale: typeof l.sku.compare_at_price_jpy === "number" && l.sku.compare_at_price_jpy > l.sku.price_jpy,
  }));
  return evaluateDiscounts(codes, parseCampaigns(rows), lines, shipping, {
    now: (ctx.now ?? Date.now)(),
    member: Boolean(ctx.member),
    memberId: ctx.member?.id ?? null,
    attributes: customerAttributesOf(rows),
    ...(provider ? { payment: { provider } } : {}),
    ancestors: (id) => {
      const out: string[] = [];
      for (let cur: string | null = id, n = 0; cur && n < 5; cur = parent.get(cur) ?? null, n++) out.push(cur);
      return out;
    },
  });
}

/** 使えなかったクーポンの理由（画面と API で共通の文言） */
export function couponNotice(r: RejectedCoupon): { code: string; reason: string; message: string } {
  return { code: r.code, reason: r.reason, message: t(`coupon.reason.${r.reason}` as MessageKey).replace("{n}", String(r.shortfall ?? "")) };
}

// ---------- 配送先 ----------

export const ADDRESS_FIELDS = ["customer_name", "customer_email", "phone", "postal_code", "state", "city", "line1", "line2", "delivery_date", "delivery_slot", "marketing_consent"] as const;
export const REQUIRED_ADDRESS_FIELDS = ["customer_name", "customer_email", "phone", "postal_code", "state", "city", "line1"] as const;
export type Address = Required<AddressFormValues>;

/** 入力の検証。足りない・形が違う項目名を返す（空配列なら OK） */
export function validateAddress(input: Record<string, unknown>): { address: Address; invalid: string[] } {
  const v = {} as Address;
  for (const k of ADDRESS_FIELDS) {
    const raw = input[k];
    v[k] = (typeof raw === "string" ? raw : "").trim().slice(0, 200);
  }
  // 「お得な情報やセールの案内を受け取る」（0050）。画面は "1"、ヘッドレスは true も受ける。それ以外は空（未チェック）
  const consent = input["marketing_consent"];
  v.marketing_consent = consent === true || consent === "1" || consent === "on" || consent === "true" ? "1" : "";
  // お届け希望（同梱モジュール delivery_time）。ショップの設定での確認は createQuote（checkDelivery）
  if (v.delivery_date && !/^\d{4}-\d{2}-\d{2}$/.test(v.delivery_date)) v.delivery_date = "";
  if (v.delivery_slot && !isDeliverySlot(v.delivery_slot)) v.delivery_slot = "";
  const invalid: string[] = REQUIRED_ADDRESS_FIELDS.filter((k) => !v[k]);
  if (v.customer_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.customer_email)) invalid.push("customer_email");
  if (v.state && !isPrefecture(v.state)) invalid.push("state");
  return { address: v, invalid: [...new Set(invalid)] };
}

// ---------- 最終確認の内容（特商法の最終確認画面に出す項目） ----------

/** 購入前の表示に使うショップ設定（shops.settings.checkout_terms） */
export interface CheckoutTerms {
  /** 引渡時期（例: ご入金確認後 3 営業日以内に発送します） */
  delivery: string | null;
  /** 申込みの撤回・解除（キャンセル）の条件 */
  cancellation: string | null;
  /** 支払いについての補足（任意） */
  payment_note: string | null;
}

export function checkoutTerms(settings: Record<string, unknown> | null | undefined): CheckoutTerms {
  const raw = (settings ?? {})["checkout_terms"];
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const str = (k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim().slice(0, 2000) : null);
  return { delivery: str("delivery"), cancellation: str("cancellation"), payment_note: str("payment_note") };
}

/** 表示に必要な設定が足りないか（管理画面の警告に使う） */
export function missingTerms(settings: Record<string, unknown> | null | undefined): (keyof CheckoutTerms)[] {
  const terms = checkoutTerms(settings);
  return (["delivery", "cancellation"] as const).filter((k) => terms[k] === null);
}

export interface ConfirmationLine {
  sku_id: string;
  code: string;
  product_name: string;
  sku_name: string | null;
  unit_price_jpy: number;
  qty: number;
  line_total_jpy: number;
  /** 税率（%）。軽減税率の商品は 8 など（0017） */
  tax_rate: number;
  /** 軽減税率の対象（確認画面・領収書で「※」を付ける） */
  reduced: boolean;
}

/**
 * 最終確認画面に出す内容。同梱テーマはこれをそのまま描画し、ヘッドレス API はこれを JSON で返す。
 * 連携側は「申込みボタンの直前の画面」でこの全項目を表示する契約（docs/headless.md）。
 */
export interface Confirmation {
  shop: { name: string; slug: string };
  lines: ConfirmationLine[];
  subtotal_jpy: number;
  shipping_jpy: number;
  /** 適用したクーポン（額はその値引きの分。送料無料なら送料の額） */
  discounts: { code: string; name: string; amount_jpy: number }[];
  /** 値引きの合計（商品 + 送料） */
  discount_jpy: number;
  /** 値引き後の合計（購入者が支払う額） */
  total_jpy: number;
  /** 入力されたが使えなかったクーポンと理由 */
  coupon_notices: { code: string; reason: string; message: string }[];
  /** 標準税率（%） */
  tax_rate: number;
  /** 税率ごとの対象額（税込、値引きの按分後）と消費税額（src/commerce/tax.ts） */
  tax: TaxGroup[];
  /** 価格はすべて税込 */
  tax_included: true;
  /** free: true なら支払いが無い（0 円）。申込みボタンで注文が確定し、決済ページへは行かない */
  payment: { provider: Provider; method: string; timing: string; note: string | null; free?: true };
  /** 引渡時期。未設定なら null（特商法表記のページを案内する） */
  delivery: string | null;
  /** お届け希望日時（同梱モジュール delivery_time）。指定なしなら null */
  delivery_request: { date: string | null; slot: string | null; text: string } | null;
  /** 申込みの撤回・解除の条件。未設定なら null（返品ポリシーのページを案内する） */
  cancellation: string | null;
  ship_to: { name: string; email: string; phone: string; postal_code: string; state: string; city: string; line1: string; line2: string };
  /** 「お得な情報やセールの案内を受け取る」（0050）。欄を出さないショップでは null（未回答） */
  marketing_consent: boolean | null;
  /** 法務ページ（絶対 URL） */
  links: { legal: string; privacy: string; returns: string };
  /** 申込みボタンの文言（「注文を確定する」等、押すと申込みになることが分かるもの） */
  submit_label: string;
}

export function paymentDescription(provider: Provider): { method: string; timing: string } {
  return provider === "stripe"
    ? { method: t("confirm.method_stripe"), timing: t("confirm.timing_stripe") }
    : { method: t("confirm.method_komoju"), timing: t("confirm.timing_komoju") };
}

// ---------- quote（署名付き） ----------

interface QuotePayload {
  k: "quote";
  /** quote の識別子（0029） */
  j?: string;
  shop: string;
  provider: Provider;
  items: CartItem[];
  /** 確認時の単価（sku_id → 円）。確定時に一致を確かめる */
  prices: Record<string, number>;
  address: Address;
  shipping: number;
  /** 適用したクーポンのコードと値引きの合計 */
  c?: string[];
  d?: number;
  total: number;
  exp: number;
}

export interface Quote {
  shopId: string;
  provider: Provider;
  cart: Cart;
  prices: Record<string, number>;
  address: Address;
  shipping: number;
  /** 適用したクーポンのコード（確定時に同じ判定になるか確かめる） */
  coupons: string[];
  /** 値引きの合計 */
  discount: number;
  /** 値引き後の合計 */
  total: number;
  expiresAt: number;
  /** quote の識別子（1 回限りの予約に使う、0029）。古い quote には無い */
  id: string | null;
}

export type QuoteResult =
  | { ok: true; quote: Quote; token: string; confirmation: Confirmation; lines: CartLine[]; discount: DiscountResult }
  | { ok: false; error: "empty_cart" | "stock" | "invalid_address" | "minimum_amount"; invalid?: string[]; dropped?: string[] };

export interface QuoteContext {
  sf: StorefrontData;
  shop: PublicShop;
  secret: string;
  /** 外から見た URL（法務ページの絶対 URL 用） */
  baseUrl: string;
  now?: () => number;
  /** クーポンの判定の材料（モジュールが OFF なら null） */
  coupons?: CouponSource | null;
  /** ログイン中の会員（会員限定のクーポン・1 人あたりの回数を会員 ID で数える） */
  member?: { id: string } | null;
  /** 「お得な情報やセールの案内を受け取る」の欄を出すか（ショップの設定。呼び出し側が consentCollected() で決める） */
  consent?: boolean;
}

/** カート + 配送先から最終確認の内容を作り、署名付きの quote を発行する */
export async function createQuote(ctx: QuoteContext, cart: Cart, provider: Provider, rawAddress: Record<string, unknown>): Promise<QuoteResult> {
  const normalized = normalizeCart(cart);
  const priced = await priceCart(ctx.sf, ctx.shop, normalized);
  if (priced.lines.length === 0) return { ok: false, error: "empty_cart", dropped: priced.dropped };
  const { address, invalid } = validateAddress(rawAddress);
  if (invalid.length > 0) return { ok: false, error: "invalid_address", invalid };
  const dl = checkDelivery(ctx.shop.settings, address.delivery_date, address.delivery_slot, (ctx.now ?? Date.now)());
  if (!dl.ok) return { ok: false, error: "invalid_address", invalid: dl.invalid };
  address.delivery_date = dl.request?.date ?? "";
  address.delivery_slot = dl.request?.slot ?? "";
  if (priced.lines.some((l) => l.short)) return { ok: false, error: "stock", dropped: priced.dropped };
  const settings = ctx.shop.settings ?? {};
  // 送料無料のラインは値引き前の小計で判定する（WooCommerce の既定と同じ）
  const shipping = shippingFee(parseShippingSettings(settings["shipping"]), priced.subtotal, address.state);
  const discount = await discountCart(ctx, priced, normalized.coupons, shipping, address.customer_email, provider);
  const total = priced.subtotal + shipping - discount.total;
  if (total > 0 && total < MIN_PAYMENT_JPY) return { ok: false, error: "minimum_amount" };
  const now = (ctx.now ?? Date.now)();
  const quote: Quote = {
    shopId: ctx.shop.id,
    provider,
    cart: priced.cart,
    prices: Object.fromEntries(priced.lines.map((l) => [l.sku.id, l.sku.price_jpy])),
    address,
    shipping,
    coupons: discount.applied.map((a) => a.code),
    discount: discount.total,
    total,
    expiresAt: Math.floor(now / 1000) + QUOTE_TTL_SECONDS,
    id: randomToken(12),
  };
  const payload: QuotePayload = {
    k: "quote",
    ...(quote.id ? { j: quote.id } : {}),
    shop: quote.shopId,
    provider,
    items: quote.cart.items,
    prices: quote.prices,
    address,
    shipping,
    ...(quote.coupons.length > 0 ? { c: quote.coupons, d: quote.discount } : {}),
    total: quote.total,
    exp: quote.expiresAt,
  };
  return { ok: true, quote, token: await sealJson(ctx.secret, payload), confirmation: confirmationOf(ctx, priced.lines, priced.subtotal, quote, discount), lines: priced.lines, discount };
}

/** 同意の欄を出すか: ショップの設定（settings.marketing_consent）が ON */
export function consentCollected(shop: PublicShop): boolean {
  return marketingConsentEnabled(shop.settings);
}

function confirmationOf(ctx: QuoteContext, lines: CartLine[], subtotal: number, quote: Quote, discount: DiscountResult): Confirmation {
  const settings = ctx.shop.settings ?? {};
  const consent = ctx.consent === true;
  const terms = checkoutTerms(settings);
  const base = shopHome(ctx.baseUrl, ctx.shop);
  const a = quote.address;
  const rates = shopTaxRates(settings);
  const lineRate = (l: CartLine) => rateFor(taxClassOf(l.product), rates);
  // 値引きは明細ごと（discounts.ts の lines）と送料から差し引く。割り当てられていない分は按分
  const tax = taxBreakdown(
    [
      ...lines.map((l) => ({ amount_jpy: l.sku.price_jpy * l.qty, rate: lineRate(l), discount_jpy: discount.lines[l.sku.id] ?? 0 })),
      { amount_jpy: quote.shipping, rate: rates.standard, discount_jpy: discount.shippingDiscount },
    ],
    Math.max(0, discount.total - discount.itemDiscount - discount.shippingDiscount),
    taxRoundingOf(settings["tax_rounding"]),
  );
  return {
    shop: { name: ctx.shop.name, slug: ctx.shop.slug },
    lines: lines.map((l) => ({
      sku_id: l.sku.id,
      code: l.sku.code,
      product_name: l.product.name,
      sku_name: l.sku.name ?? null,
      unit_price_jpy: l.sku.price_jpy,
      qty: l.qty,
      line_total_jpy: l.sku.price_jpy * l.qty,
      tax_rate: lineRate(l),
      reduced: taxClassOf(l.product) === "reduced",
    })),
    subtotal_jpy: subtotal,
    shipping_jpy: quote.shipping,
    discounts: discount.applied.map((a) => ({ code: a.code, name: a.name, amount_jpy: a.amount_jpy })),
    discount_jpy: discount.total,
    total_jpy: quote.total,
    coupon_notices: discount.rejected.map(couponNotice),
    tax_rate: rates.standard,
    tax,
    tax_included: true,
    // 0 円の注文は決済なしで確定する（決済ページへ行かない）
    payment: quote.total === 0 ? { provider: quote.provider, method: t("confirm.method_free"), timing: t("confirm.timing_free"), note: null, free: true } : { provider: quote.provider, ...paymentDescription(quote.provider), note: terms.payment_note },
    delivery: terms.delivery,
    delivery_request: a.delivery_date || a.delivery_slot ? { date: a.delivery_date || null, slot: a.delivery_slot || null, text: deliveryText({ date: a.delivery_date, slot: a.delivery_slot })! } : null,
    cancellation: terms.cancellation,
    ship_to: { name: a.customer_name, email: a.customer_email, phone: a.phone, postal_code: a.postal_code, state: a.state, city: a.city, line1: a.line1, line2: a.line2 },
    marketing_consent: consent ? a.marketing_consent === "1" : null,
    links: { legal: `${base}/legal`, privacy: `${base}/privacy`, returns: `${base}/returns` },
    submit_label: quote.total === 0 ? t("confirm.submit_free") : t("confirm.submit"),
  };
}

/** quote を開く。署名・ショップ・期限が合わなければ null */
export async function openQuote(secret: string, token: string | undefined, shopId: string, now: number = Date.now()): Promise<Quote | null> {
  const raw = (await openJson(secret, token)) as Partial<QuotePayload> | null;
  if (!raw || raw.k !== "quote" || raw.shop !== shopId || !isProvider(raw.provider)) return null;
  if (typeof raw.exp !== "number" || raw.exp < Math.floor(now / 1000)) return null;
  if (typeof raw.shipping !== "number" || typeof raw.total !== "number" || !raw.prices || typeof raw.prices !== "object") return null;
  const { address, invalid } = validateAddress((raw.address ?? {}) as Record<string, unknown>);
  if (invalid.length > 0) return null;
  const cart = normalizeCart({ items: raw.items });
  if (cart.items.length === 0) return null;
  const coupons = Array.isArray(raw.c) ? raw.c.filter((x): x is string => typeof x === "string") : [];
  const discount = typeof raw.d === "number" ? raw.d : 0;
  const id = typeof raw.j === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(raw.j) ? raw.j : null;
  return { shopId, provider: raw.provider, cart, prices: raw.prices, address, shipping: raw.shipping, coupons, discount, total: raw.total, expiresAt: raw.exp, id };
}

/**
 * 確定の直前に、quote の内容（価格・送料・在庫）を引き直す。
 * 一致しなければ新しい quote を作り直して返す（呼び出し側は購入者に確認し直させる）。
 */
export async function recheckQuote(
  ctx: QuoteContext,
  quote: Quote,
): Promise<{ ok: true; lines: CartLine[]; subtotal: number; discount: DiscountResult } | { ok: false; error: "changed"; fresh: QuoteResult } | { ok: false; error: "stock" }> {
  const priced = await priceCart(ctx.sf, ctx.shop, quote.cart);
  const again = (cart: Cart) => createQuote(ctx, { ...cart, coupons: quote.coupons }, quote.provider, quote.address);
  if (priced.dropped.length > 0 || priced.lines.some((l) => l.short)) {
    if (priced.lines.length === 0 || priced.lines.some((l) => l.short)) return { ok: false, error: "stock" };
    return { ok: false, error: "changed", fresh: await again(priced.cart) };
  }
  const settings = ctx.shop.settings ?? {};
  const shipping = shippingFee(parseShippingSettings(settings["shipping"]), priced.subtotal, quote.address.state);
  const samePrices = priced.lines.every((l) => quote.prices[l.sku.id] === l.sku.price_jpy);
  // クーポンも判定し直す（期間が終わった・上限に達した・条件を満たさなくなったら、確認画面を出し直す）
  const discount = await discountCart(ctx, priced, quote.coupons, shipping, quote.address.customer_email, quote.provider);
  const sameCoupons = discount.applied.length === quote.coupons.length && discount.applied.every((a) => quote.coupons.includes(a.code));
  if (!samePrices || shipping !== quote.shipping || !sameCoupons || discount.total !== quote.discount || priced.subtotal + shipping - discount.total !== quote.total) {
    return { ok: false, error: "changed", fresh: await again(priced.cart) };
  }
  return { ok: true, lines: priced.lines, subtotal: priced.subtotal, discount };
}

// ---------- 決済手段 ----------

interface BundledOption {
  id: string;
  settings: Record<string, string | boolean>;
}

export type StripeMode = "connect" | "direct" | null;

interface ConfigLike {
  get(name: string): string | undefined;
}

/**
 * Stripe の方式。接続済みアカウント + STRIPE_CLIENT_ID があれば Connect、
 * 同梱プラグイン「Stripe 決済」が有効 + STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET があれば API キー方式。
 */
export function stripeMode(shop: PublicShop, bundled: BundledOption[], cfg: ConfigLike): StripeMode {
  if (!cfg.get("STRIPE_SECRET_KEY")) return null;
  if (shop.stripe_connected && cfg.get("STRIPE_CLIENT_ID")) return "connect";
  if (bundled.some((o) => o.id === "stripe") && cfg.get("STRIPE_WEBHOOK_SECRET")) return "direct";
  return null;
}

export interface PaymentSetup {
  options: { stripe: boolean; komoju: boolean };
  komoju: BundledOption | null;
  stripe: StripeMode;
}

/** 有効な決済手段。同梱プラグインの有効状態と Secret の有無から決める */
export async function paymentSetup(sf: StorefrontData, shop: PublicShop, cfg: ConfigLike): Promise<PaymentSetup> {
  let bundled: BundledOption[] = [];
  try {
    bundled = await sf.paymentOptions(shop);
  } catch {
    bundled = [];
  }
  const komoju = bundled.find((o) => o.id === "komoju") ?? null;
  const komojuReady = komoju !== null && Boolean(cfg.get("KOMOJU_SECRET_KEY") && cfg.get("KOMOJU_WEBHOOK_SECRET") && cfg.get("SUPABASE_SERVICE_ROLE_KEY"));
  const stripe = cfg.get("SUPABASE_SERVICE_ROLE_KEY") ? stripeMode(shop, bundled, cfg) : null;
  return { options: { stripe: stripe !== null, komoju: komojuReady }, komoju: komojuReady ? komoju : null, stripe };
}

export function providerAvailable(setup: PaymentSetup, provider: Provider): boolean {
  return provider === "stripe" ? setup.stripe !== null : setup.komoju !== null;
}

// ---------- 注文の確定（在庫予約 → 決済ページ） ----------

export interface PlaceOrderDeps {
  privileged: PrivilegedDb;
  stripe: StripeClient | null;
  komoju: ReturnType<typeof createKomojuClient> | null;
  setup: PaymentSetup;
}

export interface PlaceOrderInput {
  shop: PublicShop;
  quote: Quote;
  lines: CartLine[];
  subtotal: number;
  /** recheckQuote が判定し直した値引き */
  discount: DiscountResult;
  successUrl: string;
  cancelUrl: string;
  /** 会員としてログイン中なら（世代は予約に紐づけるときに DB が確かめる） */
  customerId?: string;
  customerEpoch?: number;
  /** 予約の上限（0029、reserveLimits() で作る） */
  limits?: ReserveLimits | null;
}

/** free: 0 円の注文で、決済なしで確定した（url は完了画面、orderId は確定した注文） */
export type PlaceOrderResult = { ok: true; url: string; reservationId: string; free?: { orderId: string } } | { ok: false; error: "stock" | "payment" | "coupon" | "member" | "limit" | "quote_used" };

/** Stripe の決済ページと領収メールに出す値引きの名前（例: クーポン SUMMER10 + FREESHIP） */
export function discountLabel(discount: DiscountResult): string {
  return `${t("coupon.label")} ${discount.applied.map((a) => a.code).join(" + ")}`.slice(0, 40);
}

/** 予約の上限の材料（0029） */
export async function reserveLimits(secret: string, quote: Quote, ip: string | null, member: { id: string } | null): Promise<ReserveLimits> {
  const who = member?.id ? `c:${member.id.toLowerCase()}` : `e:${quote.address.customer_email.trim().toLowerCase()}`;
  return { quoteId: quote.id, subjectHash: await subjectHash(secret, who), ipHash: ip ? await ipHash(secret, ip) : null };
}

/** 在庫を原子的に確保し（CLAUDE.md §6-1）、配送先と送料を予約に付け、決済ページを作る（§6-2） */
export async function placeOrder(deps: PlaceOrderDeps, input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const { shop, quote, lines } = input;
  const a = quote.address;
  let reservationId: string;
  try {
    reservationId = await deps.privileged.reserveStock(
      shop.id,
      lines.map((l) => ({ sku_id: l.sku.id, qty: l.qty })),
      quote.provider === "komoju" ? reservationSeconds(deps.setup.komoju?.settings ?? {}) : CHECKOUT_TTL_SECONDS,
      input.limits ?? null,
    );
    await deps.privileged.attachReservationCustomer(reservationId, shop.id, {
      customer_email: a.customer_email,
      customer_name: a.customer_name,
      shipping_address: { name: a.customer_name, phone: a.phone, postal_code: a.postal_code, country: "JP", state: a.state, city: a.city, line1: a.line1, line2: a.line2 || null },
      shipping_jpy: quote.shipping,
      // 0018: 注文の orders.delivery にトリガーで写る
      ...(a.delivery_date || a.delivery_slot ? { delivery: { date: a.delivery_date || null, slot: a.delivery_slot || null } } : {}),
      ...(input.customerId ? { customer_id: input.customerId, customer_epoch: input.customerEpoch ?? -1 } : {}),
      // 0050: 「お得な情報やセールの案内を受け取る」。欄を出すショップだけ（出さないショップは未回答のまま）。注文の行と会員にトリガーで写る
      ...(marketingConsentEnabled(shop.settings) ? { marketing_consent: a.marketing_consent === "1" } : {}),
    });
  } catch (e) {
    if (e instanceof PrivilegedRpcError && (e.is("insufficient_stock") || e.is("sku_not_available"))) return { ok: false, error: "stock" };
    // 0029: 同じ quote で 2 回目 / 同じ人・同じ IP の未確定の予約が上限（決済せずに在庫を押さえ続けられない）
    if (e instanceof PrivilegedRpcError && e.is("quote_already_used")) return { ok: false, error: "quote_used" };
    if (e instanceof PrivilegedRpcError && e.is("too_many_reservations")) return { ok: false, error: "limit" };
    // 全端末からログアウトした後の古いセッション。予約を戻して、ログインし直してもらう
    if (e instanceof PrivilegedRpcError && e.is("member_session_invalid")) {
      await deps.privileged.releaseReservation(reservationId!, shop.id).catch(() => false);
      return { ok: false, error: "member" };
    }
    throw e;
  }

  // クーポン: 値引きを予約に付け、回数（全体の上限の枠・1 人あたり）を在庫と同じく予約する。取れなければ予約ごと戻す
  const discount = input.discount;
  if (discount.applied.length > 0) {
    try {
      const subject = await couponSubject(input.customerId ? { id: input.customerId } : null, a.customer_email);
      if (!subject) throw new Error("no coupon subject");
      await deps.privileged.applyReservationDiscounts(reservationId, shop.id, subject, {
        total_jpy: discount.total,
        lines: Object.entries(discount.lines).map(([sku_id, discount_jpy]) => ({ sku_id, discount_jpy })),
        applied: discount.applied,
      });
    } catch (e) {
      await deps.privileged.releaseReservation(reservationId, shop.id).catch(() => undefined);
      if (e instanceof PrivilegedRpcError && (e.is("coupon_exhausted") || e.is("coupon_limit_reached") || e.is("coupon_unavailable"))) return { ok: false, error: "coupon" };
      throw e;
    }
  }

  // 0 円: 決済ページを作らずにこの場で確定する。待つべき支払いが無いので、Webhook での確定の例外（02-decisions.md）。
  // 金額は recheckQuote で引き直したもの（購入者の入力は信じない）
  if (input.subtotal + quote.shipping - discount.total === 0) {
    try {
      const orderId = await deps.privileged.confirmReservation(reservationId, shop.id, { payment_provider: FREE_PROVIDER, payment_ref: `free-${reservationId}`, amount_paid_jpy: 0 });
      return { ok: true, url: input.successUrl, reservationId, free: { orderId } };
    } catch (e) {
      await deps.privileged.releaseReservation(reservationId, shop.id).catch(() => undefined);
      throw e;
    }
  }

  try {
    if (quote.provider === "stripe") {
      if (!deps.stripe) throw new Error("stripe not configured");
      // Connect の接続先 ID はお客様の画面には渡さない（0028）。決済ページを作るこの場で service_role が読む
      const account = deps.setup.stripe === "connect" ? await deps.privileged.shopStripeAccount(shop.id) : null;
      // 値引きは Banto が判定した額のクーポンとして渡す（方式 A。docs/knowledge/09-coupons.md）
      const couponId = discount.total > 0 ? await deps.stripe.ensureCoupon(account, discount.total, discountLabel(discount)) : undefined;
      const session = await deps.stripe.createCheckoutSession(account, {
        lineItems: [
          ...lines.map((l) => ({ name: l.sku.name ? `${l.product.name} / ${l.sku.name}` : l.product.name, unitAmountJpy: l.sku.price_jpy, quantity: l.qty })),
          ...(quote.shipping > 0 ? [{ name: t("store.shipping"), unitAmountJpy: quote.shipping, quantity: 1 }] : []),
        ],
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
        reservationId,
        shopId: shop.id,
        expiresAt: Math.floor(Date.now() / 1000) + STRIPE_CHECKOUT_EXPIRES_SECONDS,
        collectShippingAddress: false,
        customerEmail: a.customer_email,
        ...(couponId ? { couponId } : {}),
      });
      if (!session.url) throw new Error("checkout session has no url");
      return { ok: true, url: session.url, reservationId };
    }
    if (!deps.komoju) throw new Error("komoju not configured");
    // クーポンが支払い方法を絞っていれば、決済ページに出す種類もそれだけにする（設定の種類と重ねる）
    const configured = parsePaymentTypes(deps.setup.komoju?.settings ?? {});
    const paymentTypes = discount.paymentTypes ? (configured.length > 0 ? configured.filter((x) => discount.paymentTypes!.includes(x)) : discount.paymentTypes) : configured;
    if (discount.paymentTypes && paymentTypes.length === 0) {
      await deps.privileged.releaseReservation(reservationId, shop.id).catch(() => undefined);
      return { ok: false, error: "coupon" };
    }
    const session = await deps.komoju.createSession({
      amountJpy: input.subtotal + quote.shipping - discount.total,
      returnUrl: input.successUrl,
      reservationId,
      shopId: shop.id,
      paymentTypes,
      email: a.customer_email,
    });
    return { ok: true, url: session.session_url, reservationId };
  } catch (e) {
    // 決済ページを出せなければ予約を即座に戻す（Cron を待たない）。理由はログに残す（Cloudflare の Workers ログで見える）
    await deps.privileged.releaseReservation(reservationId, shop.id).catch(() => undefined);
    if (e instanceof StripeError) console.error(`[banto] checkout: stripe refused to create a session (${e.status} ${e.code ?? ""} ${e.type ?? ""}): ${e.message}`);
    else if (e instanceof KomojuError) console.error(`[banto] checkout: komoju refused to create a session: ${e.message}`);
    else console.error("[banto] checkout: payment session failed:", e instanceof Error ? e.message : e);
    if (e instanceof Error) return { ok: false, error: "payment" };
    throw e;
  }
}

// ---------- ヘッドレス: 決済後の戻り先 ----------

/** 許可する戻り先のオリジン（shops.settings.headless.return_origins） */
export function returnOrigins(settings: Record<string, unknown> | null | undefined): string[] {
  const raw = (settings ?? {})["headless"];
  const list = raw && typeof raw === "object" ? (raw as Record<string, unknown>)["return_origins"] : null;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
}

/**
 * IP を 1 つの書き方にそろえる（比較と保存のため）。IPv4 はそのまま（各オクテット 0〜255、先頭の 0 は不可）、
 * IPv6 は RFC 5952 の省略形（小文字・先頭の 0 を落とす・いちばん長い 0 の並びを :: に）。IPv4 射影（::ffff:1.2.3.4）も 16 進にそろえる。
 * Cloudflare の CF-Connecting-IP は省略形で届くので、運営者が省略しない形で入れても一致するように。IP でなければ null
 */
export function canonicalIp(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const parts = s.split(".");
    return parts.every((p) => (p === "0" || !p.startsWith("0")) && Number(p) <= 255) ? s : null;
  }
  if (!s.includes(":") || s.length > 45 || /[^0-9a-f:.]/.test(s)) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): string[] | null => {
    if (part === "") return [];
    const out: string[] = [];
    for (const g of part.split(":")) {
      if (g.includes(".")) {
        // 末尾の IPv4 表記（::ffff:203.0.113.5）
        const v4 = canonicalIp(g);
        if (!v4 || !/^\d/.test(v4)) return null;
        const [a, b, c, d] = v4.split(".").map(Number) as [number, number, number, number];
        out.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
      } else if (/^[0-9a-f]{1,4}$/.test(g)) out.push(g.replace(/^0+(?=.)/, ""));
      else return null;
    }
    return out;
  };
  const head = toGroups(halves[0]!);
  const tail = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  // いちばん長い 0 の並び（2 つ以上）を :: にする
  let best = { start: -1, len: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== "0") {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === "0") j++;
    if (j - i > best.len) best = { start: i, len: j - i };
    i = j;
  }
  if (best.len < 2) return groups.join(":");
  return `${groups.slice(0, best.start).join(":")}::${groups.slice(best.start + best.len).join(":")}`;
}

/**
 * 信頼する中継元の IP（settings.headless.relay_ips、0033。0034 から公開の settings には含めない）。WordPress などがサーバー側で
 * Banto を中継する構成では、購入者の IP が全員この 1 台になるので、ここにある IP から来た通信だけ X-Banto-Client-IP を購入者の IP として使う
 * （src/routes/common.ts の clientIpFor、docs/headless.md「サーバー側で中継するとき」）。読むのは管理画面（運営者の行）と service_role だけ
 */
export function relayIps(settings: Record<string, unknown> | null | undefined): string[] {
  const raw = (settings ?? {})["headless"];
  const list = raw && typeof raw === "object" ? (raw as Record<string, unknown>)["relay_ips"] : null;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const x of list) {
    const ip = typeof x === "string" ? canonicalIp(x) : null;
    if (ip && !out.includes(ip)) out.push(ip);
  }
  return out;
}

/** 入力（改行・カンマ・空白区切り）を中継元の IP の一覧に整える（書き方をそろえ、重複と IP でないものを落とす）。最大 20 件 */
export function parseRelayIps(input: string): string[] {
  const out: string[] = [];
  for (const part of input.split(/[\s,]+/)) {
    const ip = part ? canonicalIp(part) : null;
    if (ip && !out.includes(ip)) out.push(ip);
  }
  return out.slice(0, 20);
}

/** ショップごとの上限（SQL の banto_shop_limit と同じ読み方: 1〜4 桁の数字だけ、それ以外は既定） */
export function shopLimit(settings: Record<string, unknown> | null | undefined, section: string, key: string, dflt: number): number {
  const sec = (settings ?? {})[section];
  const v = sec && typeof sec === "object" ? String((sec as Record<string, unknown>)[key] ?? "") : "";
  return /^[0-9]{1,4}$/.test(v) ? Number(v) : dflt;
}

/** 入力（改行・カンマ区切り）をオリジンの一覧に整える。https のみ（http は localhost の開発用だけ）、最大 10 件 */
export function parseOrigins(input: string): string[] {
  const out: string[] = [];
  for (const part of input.split(/[\s,]+/)) {
    const origin = originOf(part.trim());
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out.slice(0, 10);
}

function originOf(s: string): string | null {
  if (!s) return null;
  try {
    const u = new URL(s);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** 連携側が指定した戻り先 URL。許可されたオリジンのものだけ使い、それ以外は fallback（Banto の画面）に戻す */
export function safeReturnUrl(url: unknown, allowed: string[], fallback: string): string {
  if (typeof url !== "string" || url.length > 2000) return fallback;
  const origin = originOf(url);
  return origin && allowed.includes(origin) ? url : fallback;
}

/** 送料の案内（カート・確認画面・API で共通） */
export function shippingSummary(shop: PublicShop): { summary: string; freeOver: number | null; table: { prefecture: string; fee: number }[] | null; taxRate: number } {
  const settings = shop.settings ?? {};
  return { ...describeShipping(parseShippingSettings(settings["shipping"])), taxRate: taxRate(settings) };
}

export { PREFECTURES };
