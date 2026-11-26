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
import { PREFECTURES, describeShipping, freeShippingTarget, isPrefecture, parseShippingSettings, shippingQuote, taxRate, type ShippingFreeReason } from "./shipping";
import type { AddressFormValues, CartLine } from "../themes/types";
import { PrivilegedRpcError, type PrivilegedDb, type ReserveLimits } from "../db/privileged";
import { migrated, type MigrationStateDeps } from "../db/migration-state";
import { StripeError, type StripeClient } from "../payments/stripe";
import { KomojuError, PAYMENT_RESUME_MIGRATION, parsePaymentTypes, reservationSeconds, type createKomojuClient } from "../plugins/komoju";
import { amazonPayConfigured } from "../plugins/amazon_pay";
import { AMAZON_PAY_URL_MAX, sealAmazonPayTicket } from "../payments/amazon-pay";
import { t, tf, type MessageKey } from "../i18n";
import { EMPTY_DISCOUNT, couponSubject, customerAttributesOf, evaluateDiscounts, parseCampaigns, type DiscountLine, type DiscountResult, type RejectedCoupon } from "./discounts";
import { marketingConsentEnabled } from "../customers/fields";
import { shopHome } from "../storefront/urls";
import { checkDelivery, deliveryText, isDeliverySlot } from "../modules/delivery-time";
import { COD_PROVIDER, codNote, codQuote, codSettings, type CodBlock } from "../modules/cod";
import { KOMOJU_TYPE_RE, flatFee, komojuFee, komojuMethods } from "./payment-fees";
import { moduleEnabled } from "../modules/registry";
import { AUDIENCES_MODULE } from "../members/audience";
import { rateFor, shopTaxRates, taxBreakdown, taxClassOf, taxRoundingOf, type TaxGroup } from "./tax";

/** cod: 代金引換（同梱モジュール cod、0157）。決済ページへ行かず、受付（未入金）で確定する */
export type Provider = "stripe" | "komoju" | "amazon_pay" | "cod";
export const PROVIDERS: readonly Provider[] = ["stripe", "komoju", "amazon_pay", "cod"];

/**
 * 決済手段の選び方（フォーム・ヘッドレスの provider）。KOMOJU は種類つき（komoju:konbini）でも受ける（0170、支払い方法の手数料）。
 * 形が合わなければ null
 */
export function parsePaymentChoice(v: unknown): { provider: Provider; method: string | null } | null {
  if (typeof v !== "string") return null;
  const m = /^komoju:([a-z_]{1,40})$/.exec(v);
  if (m) return { provider: "komoju", method: m[1]! };
  return isProvider(v) ? { provider: v, method: null } : null;
}

/** KOMOJU の種類の表示名（知らない種類は種類の名前のまま） */
export function komojuTypeLabel(type: string): string {
  const key = `komoju.type.${type}` as MessageKey;
  const v = t(key);
  return v === key ? type : v;
}

export function isProvider(s: unknown): s is Provider {
  return s === "stripe" || s === "komoju" || s === "amazon_pay" || s === "cod";
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
  /** カートの行。店頭のみの商品（0149）は storeOnly の印つきで入る（購入手続きでは外す） */
  lines: CartLine[];
  /** 購入手続きに進める行の小計（店頭のみの行は入れない） */
  subtotal: number;
  /** 非公開になった・削除された SKU と、見る人が買えない会員限定の商品の SKU（カートから外す） */
  dropped: string[];
  /** dropped のうち、会員限定で買えないもの（0098。カートの画面の知らせに使う） */
  restricted?: string[];
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
  const restricted: string[] = [];
  for (const item of cart.items) {
    const hit = found.get(item.sku_id);
    if (!hit) {
      dropped.push(item.sku_id);
      continue;
    }
    // 買えない商品（src/products/sale.ts）: 会員限定（0098。会員なら DB が判定した値、ゲストは条件のある商品は買えない）・発売前（0148）は
    // カートから外す。店頭のみ（0149）は、お店で試着が ON ならカートに残すが購入手続きには進めない（storeOnly）。確定もこの値付けを通る
    if (!hit.purchasable) {
      if (hit.cartable && hit.purchase_block === "store_only") {
        lines.push({ sku: hit.sku, product: hit.product, qty: item.qty, short: hit.sku.available < item.qty, storeOnly: true });
        continue;
      }
      dropped.push(item.sku_id);
      restricted.push(item.sku_id);
      continue;
    }
    lines.push({ sku: hit.sku, product: hit.product, qty: item.qty, short: hit.sku.available < item.qty });
  }
  return {
    lines,
    subtotal: lines.reduce((n, l) => n + (l.storeOnly ? 0 : l.sku.price_jpy * l.qty), 0),
    dropped,
    ...(restricted.length > 0 ? { restricted } : {}),
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
export async function discountCart(ctx: DiscountContext, priced: PricedCart, codes: string[] | undefined, shipping: number, email: string | null, provider?: Provider, method?: string | null): Promise<DiscountResult> {
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
    ...(provider ? { payment: { provider, ...(provider === "komoju" && method ? { type: method } : {}) } } : {}),
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

export const ADDRESS_FIELDS = ["customer_name", "customer_email", "phone", "postal_code", "state", "city", "line1", "line2", "delivery_date", "delivery_slot", "marketing_consent", "save_address"] as const;
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
  // 会員の「この住所を次回も使う」（0159）。既定の住所がある会員だけが上書きに使う（無い会員は確定のときにいつも保存される）
  const save = input["save_address"];
  v.save_address = save === true || save === "1" || save === "on" || save === "true" ? "1" : "";
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
  /** 送料が 0 円になった理由（0171）: threshold = ○円以上で送料無料・audience = 会員の条件の送料無料（会員特典）。送料がかかるなら null */
  shipping_free_reason: ShippingFreeReason;
  /** 手数料: 代引き手数料（同梱モジュール cod、0157）か支払い方法の手数料（KOMOJU の種類、0170）。無ければ 0 */
  fee_jpy: number;
  /** 手数料の見出し（「代引き手数料」「お支払い手数料」）。手数料が無ければ null */
  fee_label?: string | null;
  /** 適用したクーポン（額はその値引きの分。送料無料なら送料の額） */
  discounts: { code: string; name: string; amount_jpy: number }[];
  /** 値引きの合計（商品 + 送料） */
  discount_jpy: number;
  /** 値引き後の合計（購入者が支払う額。代引き手数料を含む） */
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
  payment: {
    provider: Provider;
    method: string;
    timing: string;
    note: string | null;
    free?: true;
    /** 代金引換（その場で受付として確定し、支払いは配達のとき） */ cod?: true;
    /** KOMOJU の種類（0170。確認画面で選んだもの。決済ページはこの種類だけ） */ type?: string;
    /** 選び直し（「修正する」）に送る provider の値（KOMOJU の種類つきは komoju:<種類>） */ choice?: string;
  };
  /** 引渡時期。未設定なら null（特商法表記のページを案内する） */
  delivery: string | null;
  /** お届け希望日時（同梱モジュール delivery_time）。指定なしなら null */
  delivery_request: { date: string | null; slot: string | null; text: string } | null;
  /** 申込みの撤回・解除の条件。未設定なら null（返品ポリシーのページを案内する） */
  cancellation: string | null;
  ship_to: { name: string; email: string; phone: string; postal_code: string; state: string; city: string; line1: string; line2: string };
  /** 「お得な情報やセールの案内を受け取る」（0050）。欄を出さないショップでは null（未回答） */
  marketing_consent: boolean | null;
  /** 会員が「この住所を次回も使う」を選んだ（0159）。選んでいなければ無い */
  save_address?: true;
  /** 法務ページ（絶対 URL） */
  links: { legal: string; privacy: string; returns: string };
  /** 申込みボタンの文言（「注文を確定する」等、押すと申込みになることが分かるもの） */
  submit_label: string;
}

export function paymentDescription(provider: Provider, type?: string | null): { method: string; timing: string } {
  if (provider === "komoju" && type) return { method: tf("confirm.method_komoju_type", { method: komojuTypeLabel(type) }), timing: t("confirm.timing_komoju") };
  if (provider === "stripe") return { method: t("confirm.method_stripe"), timing: t("confirm.timing_stripe") };
  if (provider === "amazon_pay") return { method: t("confirm.method_amazon_pay"), timing: t("confirm.timing_amazon_pay") };
  if (provider === "cod") return { method: t("confirm.method_cod"), timing: t("confirm.timing_cod") };
  return { method: t("confirm.method_komoju"), timing: t("confirm.timing_komoju") };
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
  /** 手数料（代引き 0157・支払い方法 0170。0 でないときだけ） */
  f?: number;
  /** KOMOJU の種類（0170。選んだときだけ） */
  m?: string;
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
  /** 送料が 0 円になった理由（0171。確認画面の「会員特典」）。署名には入れない（確定の前に引き直す） */
  shippingReason?: ShippingFreeReason;
  /** 手数料（代引き 0157・支払い方法 0170）。無ければ 0 */
  fee: number;
  /** KOMOJU の種類（0170）。選んでいなければ null */
  method: string | null;
  /** 適用したクーポンのコード（確定時に同じ判定になるか確かめる） */
  coupons: string[];
  /** 値引きの合計 */
  discount: number;
  /** 値引き後の合計（代引き手数料を含む） */
  total: number;
  expiresAt: number;
  /** quote の識別子（1 回限りの予約に使う、0029）。古い quote には無い */
  id: string | null;
}

export type QuoteResult =
  | { ok: true; quote: Quote; token: string; confirmation: Confirmation; lines: CartLine[]; discount: DiscountResult; /** 購入手続きから外した店頭のみの行（0149。カートには残る） */ excluded?: CartLine[] }
  | {
      ok: false;
      /** payment_method: KOMOJU の種類を選んでいない・使えない種類・手数料の段に当たらない（0170） */
      error: "empty_cart" | "stock" | "invalid_address" | "minimum_amount" | "store_only" | "cod_unavailable" | "payment_method";
      invalid?: string[];
      dropped?: string[];
      /** cod_unavailable の理由 */ cod?: CodBlock;
    };

/** 購入手続きに進める行だけの値付け（店頭のみの行を外す。0149） */
export function checkoutPart(priced: PricedCart): { priced: PricedCart; excluded: CartLine[] } {
  const excluded = priced.lines.filter((l) => l.storeOnly);
  if (excluded.length === 0) return { priced, excluded };
  const lines = priced.lines.filter((l) => !l.storeOnly);
  const keep = new Set(lines.map((l) => l.sku.id));
  return { priced: { ...priced, lines, cart: { ...priced.cart, items: priced.cart.items.filter((i) => keep.has(i.sku_id)) } }, excluded };
}

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
  /** KOMOJU の受け付ける種類（プラグインの設定 payment_types。0170 の種類の選び方に使う）。無ければ [] */
  komojuTypes?: string[];
  /**
   * ログイン中の会員が当てはまる会員の条件のうち、いちばん低い送料無料の金額（0171。DB の member_free_shipping_over、最新の独自項目で判定）。
   * 決まりの無いショップ・ゲスト・モジュールが OFF では呼ばない（DB の往復を足さない）。無ければ null
   */
  memberFreeOver?: () => Promise<number | null>;
}

/**
 * 送料（0171 の会員の条件ごとの送料無料を含む）。計算は shipping.ts、会員の判定の材料は DB。
 * ゲスト・会員の条件のモジュールが OFF・決まりが無いときは DB に問い合わせない
 */
async function shippingFor(ctx: QuoteContext, subtotal: number, state: string): Promise<{ fee: number; free_reason: ShippingFreeReason }> {
  const settings = ctx.shop.settings ?? {};
  const cfg = parseShippingSettings(settings["shipping"]);
  const needsMember = Boolean(ctx.member?.id) && cfg.has_member_free && moduleEnabled(settings, AUDIENCES_MODULE) && ctx.memberFreeOver !== undefined;
  // ショップ全体の金額で無料なら、会員の判定は要らない
  const plain = shippingQuote(cfg, subtotal, state, null);
  if (!needsMember || plain.fee === 0) return plain;
  return shippingQuote(cfg, subtotal, state, await ctx.memberFreeOver!());
}

/**
 * KOMOJU の種類と手数料（0170）。手数料の決まりの無いショップは種類を見ない（今までどおり）。
 * 決まりのあるショップは種類が要り、並べる種類（komojuMethods）のどれかで、手数料の段に当たること
 */
function komojuChoice(ctx: QuoteContext, provider: Provider, method: string | null | undefined, base: number): { ok: true; fee: number; method: string | null } | { ok: false } {
  if (provider !== "komoju") return { ok: true, fee: 0, method: null };
  const settings = ctx.shop.settings ?? {};
  const methods = komojuMethods(settings, ctx.komojuTypes ?? []);
  if (!methods) return { ok: true, fee: 0, method: null };
  if (!method || !KOMOJU_TYPE_RE.test(method) || !methods.some((m) => m.type === method)) return { ok: false };
  // 0 円の注文は支払いが無いので手数料も無い（決済なしで確定する）
  if (base === 0) return { ok: true, fee: 0, method };
  const fee = komojuFee(settings, method, base);
  return fee === null ? { ok: false } : { ok: true, fee, method };
}

/** カート + 配送先から最終確認の内容を作り、署名付きの quote を発行する */
export async function createQuote(ctx: QuoteContext, cart: Cart, provider: Provider, rawAddress: Record<string, unknown>, method?: string | null): Promise<QuoteResult> {
  const normalized = normalizeCart(cart);
  const all = await priceCart(ctx.sf, ctx.shop, normalized);
  // 店頭のみの商品（0149）は購入手続きから外して知らせる（カートには残す）。それしか無ければ進めない
  const { priced, excluded } = checkoutPart(all);
  if (priced.lines.length === 0) return { ok: false, error: excluded.length > 0 ? "store_only" : "empty_cart", dropped: priced.dropped };
  const { address, invalid } = validateAddress(rawAddress);
  if (invalid.length > 0) return { ok: false, error: "invalid_address", invalid };
  const dl = checkDelivery(ctx.shop.settings, address.delivery_date, address.delivery_slot, (ctx.now ?? Date.now)());
  if (!dl.ok) return { ok: false, error: "invalid_address", invalid: dl.invalid };
  address.delivery_date = dl.request?.date ?? "";
  address.delivery_slot = dl.request?.slot ?? "";
  if (priced.lines.some((l) => l.short)) return { ok: false, error: "stock", dropped: priced.dropped };
  const settings = ctx.shop.settings ?? {};
  // 送料無料のラインは値引き前の小計で判定する（WooCommerce の既定と同じ）。会員の条件ごとの金額（0171）も
  const ship = await shippingFor(ctx, priced.subtotal, address.state);
  const shipping = ship.fee;
  const discount = await discountCart(ctx, priced, normalized.coupons, shipping, address.customer_email, provider, method);
  const base = priced.subtotal + shipping - discount.total;
  // 決済事業者の下限（50 円）。代金引換は決済事業者を通らないので当てない
  if (provider !== "cod" && base > 0 && base < MIN_PAYMENT_JPY) return { ok: false, error: "minimum_amount" };
  // 代金引換（0157）: 手数料の決まり・上限金額・会員だけを確かめる（確定のとき DB も同じ決まりで引き直す）
  let fee = 0;
  if (provider === "cod") {
    const cod = codQuote(settings, base, Boolean(ctx.member?.id));
    if (!cod.ok) return { ok: false, error: "cod_unavailable", cod: cod.reason };
    fee = cod.fee;
  }
  // KOMOJU の種類と手数料（0170）。確定の前に DB も同じ決まりで確かめる（reservation_payment_fee_check）
  const km = komojuChoice(ctx, provider, method, base);
  if (!km.ok) return { ok: false, error: "payment_method" };
  fee += km.fee;
  const total = base + fee;
  const now = (ctx.now ?? Date.now)();
  const quote: Quote = {
    shopId: ctx.shop.id,
    provider,
    cart: priced.cart,
    prices: Object.fromEntries(priced.lines.map((l) => [l.sku.id, l.sku.price_jpy])),
    address,
    shipping,
    shippingReason: ship.free_reason,
    fee,
    method: km.method,
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
    ...(fee > 0 ? { f: fee } : {}),
    ...(km.method ? { m: km.method } : {}),
    ...(quote.coupons.length > 0 ? { c: quote.coupons, d: quote.discount } : {}),
    total: quote.total,
    exp: quote.expiresAt,
  };
  return { ok: true, quote, token: await sealJson(ctx.secret, payload), confirmation: confirmationOf(ctx, priced.lines, priced.subtotal, quote, discount), lines: priced.lines, discount, ...(excluded.length > 0 ? { excluded } : {}) };
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
      // 手数料（代引き・支払い方法）は標準税率（値引きの対象にしない）
      ...(quote.fee > 0 ? [{ amount_jpy: quote.fee, rate: rates.standard, discount_jpy: 0 }] : []),
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
    shipping_free_reason: quote.shippingReason ?? null,
    fee_jpy: quote.fee,
    fee_label: quote.fee > 0 ? t(quote.provider === "cod" ? "confirm.cod_fee" : "confirm.payment_fee") : null,
    discounts: discount.applied.map((a) => ({ code: a.code, name: a.name, amount_jpy: a.amount_jpy })),
    discount_jpy: discount.total,
    total_jpy: quote.total,
    coupon_notices: discount.rejected.map(couponNotice),
    tax_rate: rates.standard,
    tax,
    tax_included: true,
    // 0 円の注文は決済なしで確定する（決済ページへ行かない）
    payment:
      quote.total === 0
        ? { provider: quote.provider, method: t("confirm.method_free"), timing: t("confirm.timing_free"), note: null, free: true, ...(quote.method ? { type: quote.method, choice: `komoju:${quote.method}` } : {}) }
        : {
            provider: quote.provider,
            ...paymentDescription(quote.provider, quote.method),
            note: quote.provider === "cod" ? (codNote(settings) ?? terms.payment_note) : terms.payment_note,
            ...(quote.provider === "cod" ? { cod: true as const } : {}),
            ...(quote.method ? { type: quote.method, choice: `komoju:${quote.method}` } : {}),
          },
    delivery: terms.delivery,
    delivery_request: a.delivery_date || a.delivery_slot ? { date: a.delivery_date || null, slot: a.delivery_slot || null, text: deliveryText({ date: a.delivery_date, slot: a.delivery_slot })! } : null,
    cancellation: terms.cancellation,
    ship_to: { name: a.customer_name, email: a.customer_email, phone: a.phone, postal_code: a.postal_code, state: a.state, city: a.city, line1: a.line1, line2: a.line2 },
    marketing_consent: consent ? a.marketing_consent === "1" : null,
    // 会員だけ（ゲストの save_address は使わない）
    ...(a.save_address === "1" && ctx.member?.id ? { save_address: true as const } : {}),
    links: { legal: `${base}/legal`, privacy: `${base}/privacy`, returns: `${base}/returns` },
    submit_label: quote.total === 0 ? t("confirm.submit_free") : quote.provider === "cod" ? t("confirm.submit_cod") : t("confirm.submit"),
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
  const fee = typeof raw.f === "number" && Number.isInteger(raw.f) && raw.f >= 0 ? raw.f : 0;
  const id = typeof raw.j === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(raw.j) ? raw.j : null;
  const method = raw.provider === "komoju" && typeof raw.m === "string" && KOMOJU_TYPE_RE.test(raw.m) ? raw.m : null;
  return { shopId, provider: raw.provider, cart, prices: raw.prices, address, shipping: raw.shipping, fee, method, coupons, discount, total: raw.total, expiresAt: raw.exp, id };
}

/**
 * 確定の直前に、quote の内容（価格・送料・在庫）を引き直す。
 * 一致しなければ新しい quote を作り直して返す（呼び出し側は購入者に確認し直させる）。
 */
export async function recheckQuote(
  ctx: QuoteContext,
  quote: Quote,
): Promise<{ ok: true; lines: CartLine[]; subtotal: number; discount: DiscountResult } | { ok: false; error: "changed"; fresh: QuoteResult } | { ok: false; error: "stock" | "store_only" }> {
  const all = await priceCart(ctx.sf, ctx.shop, quote.cart);
  const again = (cart: Cart) => createQuote(ctx, { ...cart, coupons: quote.coupons }, quote.provider, quote.address, quote.method);
  // 確認のあとで店頭のみになった商品（0149）は、外して確認画面を出し直す
  const { priced, excluded } = checkoutPart(all);
  if (excluded.length > 0) return priced.lines.length === 0 ? { ok: false, error: "store_only" } : { ok: false, error: "changed", fresh: await again(priced.cart) };
  if (priced.dropped.length > 0 || priced.lines.some((l) => l.short)) {
    if (priced.lines.length === 0 || priced.lines.some((l) => l.short)) return { ok: false, error: "stock" };
    return { ok: false, error: "changed", fresh: await again(priced.cart) };
  }
  const settings = ctx.shop.settings ?? {};
  const shipping = (await shippingFor(ctx, priced.subtotal, quote.address.state)).fee;
  const samePrices = priced.lines.every((l) => quote.prices[l.sku.id] === l.sku.price_jpy);
  // クーポンも判定し直す（期間が終わった・上限に達した・条件を満たさなくなったら、確認画面を出し直す）
  const discount = await discountCart(ctx, priced, quote.coupons, shipping, quote.address.customer_email, quote.provider, quote.method);
  const sameCoupons = discount.applied.length === quote.coupons.length && discount.applied.every((a) => quote.coupons.includes(a.code));
  // 代引き手数料も引き直す（決まり・上限・会員だけ。0157）
  const base = priced.subtotal + shipping - discount.total;
  let fee = 0;
  if (quote.provider === "cod") {
    const cod = codQuote(settings, base, Boolean(ctx.member?.id));
    if (!cod.ok) return { ok: false, error: "changed", fresh: await again(priced.cart) };
    fee = cod.fee;
  }
  // KOMOJU の種類の手数料も引き直す（0170）。種類が使えなくなったら確認画面を出し直す
  const km = komojuChoice(ctx, quote.provider, quote.method, base);
  if (!km.ok) return { ok: false, error: "changed", fresh: await again(priced.cart) };
  fee += km.fee;
  if (!samePrices || shipping !== quote.shipping || !sameCoupons || discount.total !== quote.discount || fee !== quote.fee || base + fee !== quote.total) {
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
  options: {
    stripe: boolean;
    komoju: boolean;
    amazon_pay: boolean;
    /** 代金引換（同梱モジュール cod が ON。金額・会員だけの判定は確認画面で） */ cod: boolean;
    /**
     * KOMOJU を種類ごとに並べる（0170、支払い方法の手数料の決まりがあるショップだけ）。provider には komoju:<type> を送る。
     * fee: 一律の手数料（段は金額で変わるので null、決まりの無い種類は 0）
     */
    komoju_methods?: { type: string; name: string; fee: number | null }[];
  };
  komoju: BundledOption | null;
  stripe: StripeMode;
  /** 同梱プラグイン「Amazon Pay」が有効 + 設定が揃っている（0130） */
  amazonPay: BundledOption | null;
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
  const amazon = bundled.find((o) => o.id === "amazon_pay") ?? null;
  const amazonReady = amazon !== null && amazonPayConfigured(cfg) && Boolean(cfg.get("SUPABASE_SERVICE_ROLE_KEY"));
  // 代金引換（0157）: モジュールが ON（ON にできるのは 0157 が当たってから）。確定は service_role の confirm_reservation
  const cod = codSettings(shop.settings) !== null && Boolean(cfg.get("SUPABASE_SERVICE_ROLE_KEY"));
  // 支払い方法の手数料（0170）: 決まりのあるショップは KOMOJU を種類ごとに並べる
  const methods = komojuReady ? komojuMethods(shop.settings, parsePaymentTypes(komoju.settings)) : null;
  const komojuMethodsOption = methods ? { komoju_methods: methods.map((m) => ({ type: m.type, name: komojuTypeLabel(m.type), fee: flatFee(m.rule) })) } : {};
  return {
    options: { stripe: stripe !== null, komoju: komojuReady, amazon_pay: amazonReady, cod, ...komojuMethodsOption },
    komoju: komojuReady ? komoju : null,
    stripe,
    amazonPay: amazonReady ? amazon : null,
  };
}

/** KOMOJU の受け付ける種類（プラグインの設定）。quote の文脈（QuoteContext.komojuTypes）に渡す */
export function komojuTypesOf(setup: PaymentSetup): string[] {
  return setup.komoju ? parsePaymentTypes(setup.komoju.settings) : [];
}

/** 種類つきの選び方が使えるか（0170）。種類を並べるショップは種類が要り、並べていないショップは種類を受けない */
export function choiceAvailable(setup: PaymentSetup, choice: { provider: Provider; method: string | null }): boolean {
  if (!providerAvailable(setup, choice.provider)) return false;
  if (choice.provider !== "komoju") return choice.method === null;
  const methods = setup.options.komoju_methods;
  if (!methods) return choice.method === null;
  return choice.method !== null && methods.some((m) => m.type === choice.method);
}

export function providerAvailable(setup: PaymentSetup, provider: Provider): boolean {
  if (provider === "stripe") return setup.stripe !== null;
  if (provider === "amazon_pay") return setup.amazonPay !== null;
  if (provider === "cod") return setup.options.cod;
  return setup.komoju !== null;
}

/** どれか 1 つでも決済手段が使えるか */
export function anyProvider(options: PaymentSetup["options"]): boolean {
  return options.stripe || options.komoju || options.amazon_pay || options.cod;
}

// ---------- 注文の確定（在庫予約 → 決済ページ） ----------

export interface PlaceOrderDeps {
  privileged: PrivilegedDb;
  stripe: StripeClient | null;
  komoju: ReturnType<typeof createKomojuClient> | null;
  /** Amazon Pay の中継ページの券に署名する秘密（サイトの秘密）。Amazon Pay を使わないなら null */
  amazonPay?: { secret: string } | null;
  setup: PaymentSetup;
  /** 会員限定の商品を予約のときに DB でも確かめる（reserve_stock の p_customer_id）のは 0129 が当たってから。null なら渡さない */
  migrationState?: MigrationStateDeps | null;
}

/** 注文は会員だけ（0165、ショップの設定 checkout_members_only）。DB の reserve_stock も会員でない予約を断る */
export const CHECKOUT_MEMBERS_ONLY_MIGRATION = "0165_checkout_members_only";

/**
 * 購入手続きにログイン（会員）が要るショップか。会員機能が ON で checkout_members_only が true のとき（DB の banto_checkout_members_only と同じ）。
 * 会員の登録はログインのときにその場で作るので、「会員登録が必須」と同じ
 */
export function checkoutMembersOnly(settings: Record<string, unknown> | null | undefined): boolean {
  return settings?.["members_enabled"] === true && settings?.["checkout_members_only"] === true;
}

/** 会員の注文のお届け先を既定の住所に写す（0159）。レジの「保存します」「次回も使う」は当ててから出す */
export const MEMBER_ADDRESS_MIGRATION = "0159_member_address_from_order";

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
  /** ショップの外向きの URL（shopHome）。Amazon Pay の中継ページ（<shopUrl>/checkout/amazon-pay/start）に使う */
  shopUrl?: string;
}

/** free: 0 円の注文で、決済なしで確定した（url は完了画面、orderId は確定した注文）。cod: 代金引換で受付（未入金）として確定した */
export type PlaceOrderResult = { ok: true; url: string; reservationId: string; free?: { orderId: string }; cod?: { orderId: string } } | { ok: false; error: "stock" | "payment" | "coupon" | "member" | "member_required" | "limit" | "quote_used" | "price" };

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
  // 注文は会員だけのショップ（0165）: ゲストは予約の前に断る（DB の reserve_stock も断る）
  if (checkoutMembersOnly(shop.settings) && !input.customerId) return { ok: false, error: "member_required" };
  let reservationId: string;
  try {
    // 会員 id を渡すと reserve_stock が会員限定の商品を確かめる（0129）
    reservationId = await deps.privileged.reserveStock(
      shop.id,
      lines.map((l) => ({ sku_id: l.sku.id, qty: l.qty })),
      quote.provider === "komoju" ? reservationSeconds(deps.setup.komoju?.settings ?? {}) : CHECKOUT_TTL_SECONDS,
      input.limits ?? null,
      input.customerId ?? null,
    );
    await deps.privileged.attachReservationCustomer(reservationId, shop.id, {
      customer_email: a.customer_email,
      customer_name: a.customer_name,
      shipping_address: { name: a.customer_name, phone: a.phone, postal_code: a.postal_code, country: "JP", state: a.state, city: a.city, line1: a.line1, line2: a.line2 || null },
      shipping_jpy: quote.shipping,
      // 0157: 代引き手数料（確定のとき DB がショップの決まりで引き直す）。0170: KOMOJU の種類の手数料（値引きの後に DB が確かめる）
      ...(quote.fee > 0 ? { fee_jpy: quote.fee } : {}),
      // 0170: 選んだ KOMOJU の種類（決済ページはこの種類だけ。確定のとき KOMOJU が知らせた種類と比べる）
      ...(quote.provider === "komoju" && quote.method ? { payment_method: `komoju:${quote.method}` } : {}),
      // 0018: 注文の orders.delivery にトリガーで写る
      ...(a.delivery_date || a.delivery_slot ? { delivery: { date: a.delivery_date || null, slot: a.delivery_slot || null } } : {}),
      ...(input.customerId ? { customer_id: input.customerId, customer_epoch: input.customerEpoch ?? -1 } : {}),
      // 0050: 「お得な情報やセールの案内を受け取る」。欄を出すショップだけ（出さないショップは未回答のまま）。注文の行と会員にトリガーで写る
      ...(marketingConsentEnabled(shop.settings) ? { marketing_consent: a.marketing_consent === "1" } : {}),
      // 0159: 会員が「この住所を次回も使う」を選んだ（既定の住所を上書きする）。既定の住所が無い会員はこれが無くても保存される
      ...(input.customerId && a.save_address === "1" ? { save_address: true } : {}),
      // 0159: 住所を写すのは、予約したときのログインの世代が確定のときも同じ会員だけ（すべての端末からログアウトした後の確定では写さない）
      ...(input.customerId ? { address_epoch: input.customerEpoch ?? -1 } : {}),
    });
  } catch (e) {
    if (e instanceof PrivilegedRpcError && (e.is("insufficient_stock") || e.is("sku_not_available"))) return { ok: false, error: "stock" };
    // 0029: 同じ quote で 2 回目 / 同じ人・同じ IP の未確定の予約が上限（決済せずに在庫を押さえ続けられない）
    if (e instanceof PrivilegedRpcError && e.is("quote_already_used")) return { ok: false, error: "quote_used" };
    if (e instanceof PrivilegedRpcError && e.is("too_many_reservations")) return { ok: false, error: "limit" };
    if (e instanceof PrivilegedRpcError && e.is("member_required")) return { ok: false, error: "member_required" };
    // 全端末からログアウトした後の古いセッション。予約を戻して、ログインし直してもらう
    if (e instanceof PrivilegedRpcError && e.is("member_session_invalid")) {
      await deps.privileged.releaseReservation(reservationId!, shop.id).catch(() => false);
      return { ok: false, error: "member" };
    }
    throw e;
  }

  // 会員価格（0099）: 予約の単価を DB が会員価格で写し直す。最終確認で見せた単価（会員の読み取りの経路の値付け）と
  // 1 円でも違えば（決まりやランクがあいだで変わった）確定しない
  if (input.customerId) {
    try {
      const items = await deps.privileged.applyReservationMemberPrices(reservationId, shop.id);
      const unit = new Map(items.map((i) => [i.sku_id, Number(i.unit_price_jpy)]));
      if (lines.some((l) => unit.get(l.sku.id) !== l.sku.price_jpy)) {
        await deps.privileged.releaseReservation(reservationId, shop.id).catch(() => undefined);
        return { ok: false, error: "price" };
      }
    } catch (e) {
      await deps.privileged.releaseReservation(reservationId, shop.id).catch(() => undefined);
      throw e;
    }
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

  // 支払い方法の手数料（0170）: 値引きを付けた後の金額で、DB がショップの決まりで確かめる（違えば確定しない）。
  // 手数料が 0 でも確かめる（Worker が覚えている設定が古く 0 と計算したあいだに、運営者が手数料を足したとき）
  if (quote.provider === "komoju" && quote.method) {
    try {
      await deps.privileged.reservationPaymentFeeCheck(reservationId, shop.id);
    } catch (e) {
      await deps.privileged.releaseReservation(reservationId, shop.id).catch(() => undefined);
      if (e instanceof PrivilegedRpcError && e.is("amount_mismatch")) return { ok: false, error: "price" };
      throw e;
    }
  }

  // 0 円: 決済ページを作らずにこの場で確定する。待つべき支払いが無いので、Webhook での確定の例外（02-decisions.md）。
  // 金額は recheckQuote で引き直したもの（購入者の入力は信じない）
  if (input.subtotal + quote.shipping - discount.total === 0) {
    try {
      const orderId = await deps.privileged.confirmReservation(reservationId, shop.id, { payment_provider: FREE_PROVIDER, payment_ref: `free-${reservationId}`, amount_paid_jpy: 0, currency: "jpy" });
      return { ok: true, url: input.successUrl, reservationId, free: { orderId } };
    } catch (e) {
      await deps.privileged.releaseReservation(reservationId, shop.id).catch(() => undefined);
      throw e;
    }
  }

  // 代金引換（0157）: 決済ページを作らず、その場で受付（未入金）として確定する。「Webhook のみ」の例外（02-decisions.md）。
  // 手数料・上限・会員だけは confirm_reservation が引き直す。受け取る額は 0（お金は配達のときに集める）
  if (quote.provider === "cod") {
    try {
      const orderId = await deps.privileged.confirmReservation(reservationId, shop.id, { payment_provider: COD_PROVIDER, payment_ref: `cod-${reservationId}`, amount_paid_jpy: 0, currency: "jpy" });
      return { ok: true, url: input.successUrl, reservationId, cod: { orderId } };
    } catch (e) {
      await deps.privileged.releaseReservation(reservationId, shop.id).catch(() => undefined);
      if (e instanceof PrivilegedRpcError && (e.is("cod_unavailable") || e.is("amount_mismatch"))) return { ok: false, error: "price" };
      // 未入金の代金引換の注文が多すぎる（同じ人・同じ IP、0157）
      if (e instanceof PrivilegedRpcError && e.is("too_many_reservations")) return { ok: false, error: "limit" };
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
    if (quote.provider === "amazon_pay") {
      // Amazon Pay の画面へは Banto の中継ページから移る（Amazon の checkout.js を読むのはその画面だけ。src/payments/amazon-pay.ts）。
      // 券にはどの予約を・いくらで・どこへ戻すかだけを入れる。支払ったかは戻りで Amazon Pay の API に確かめる
      if (!deps.amazonPay || !input.shopUrl) throw new Error("amazon pay not configured");
      const token = await sealAmazonPayTicket(deps.amazonPay.secret, {
        shopId: shop.id,
        reservationId,
        amountJpy: input.subtotal + quote.shipping - discount.total,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      });
      // 戻りの URL（券を付ける）は Amazon Pay の上限 1024 文字に収める
      if (`${input.shopUrl}/checkout/amazon-pay/return?t=${token}&amazonCheckoutSessionId=`.length + 100 > AMAZON_PAY_URL_MAX || input.cancelUrl.length > AMAZON_PAY_URL_MAX) throw new Error("amazon pay return url is too long");
      return { ok: true, url: `${input.shopUrl}/checkout/amazon-pay/start?t=${encodeURIComponent(token)}`, reservationId };
    }
    if (!deps.komoju) throw new Error("komoju not configured");
    // クーポンが支払い方法を絞っていれば、決済ページに出す種類もそれだけにする（設定の種類と重ねる）
    const configured = parsePaymentTypes(deps.setup.komoju?.settings ?? {});
    // 確認画面で種類を選んだ（0170）: 決済ページはその種類だけ（選び直して手数料を外せないように）
    const offered = quote.method ? [quote.method] : configured;
    const paymentTypes = discount.paymentTypes ? (offered.length > 0 ? offered.filter((x) => discount.paymentTypes!.includes(x)) : discount.paymentTypes) : offered;
    if (discount.paymentTypes && paymentTypes.length === 0) {
      await deps.privileged.releaseReservation(reservationId, shop.id).catch(() => undefined);
      return { ok: false, error: "coupon" };
    }
    const session = await deps.komoju.createSession({
      // 支払い方法の手数料（0170）を含む
      amountJpy: input.subtotal + quote.shipping - discount.total + quote.fee,
      returnUrl: input.successUrl,
      reservationId,
      shopId: shop.id,
      paymentTypes,
      email: a.customer_email,
      // 予約より長く払える決済ページを作らない（予約の時間を短くしたショップ。既定は 72 時間で、KOMOJU の上限 24 時間のまま）
      expiresInSeconds: reservationSeconds(deps.setup.komoju?.settings ?? {}),
    });
    // お支払いに戻れるように、決済ページの ID と種類を予約に残す（0180、src/commerce/payment-resume.ts）。残せなくても支払いは進める
    if (deps.migrationState && (await migrated(deps.migrationState, PAYMENT_RESUME_MIGRATION))) {
      await deps.privileged
        .reservationSetPaymentSession(reservationId, shop.id, { provider: "komoju", id: session.id, ...(paymentTypes.length > 0 ? { types: paymentTypes } : {}) }, null)
        .catch((e) => console.error("[banto] checkout: could not keep the komoju session on the reservation:", e instanceof Error ? e.message : e));
    }
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
  if (!origin || !allowed.includes(origin)) return fallback;
  // Banto が後ろに付け足す鍵（banto_challenge / banto_token / banto_handoff …）を先に埋め込ませない: 連携サイトは最初の値を読むので、
  // 攻撃者の組を仕込んだ return_to でショップの本物のメールを被害者に送らせ、攻撃者のアカウントでログインさせられる。
  // フラグメント（#）があると付け足した鍵がその中に入るので、これも受けない
  const u = new URL(url);
  if (u.hash || url.endsWith("#") || u.search.includes(";") || [...u.searchParams.keys()].some(bantoKey)) return fallback;
  // URL として読めても、空白・改行・制御文字・バックスラッシュを含む文字列はそのまま使わない: この値はメールの本文と Location に入るので、
  // パスに文章を書かれると、ショップの本物のメールに他人の文とリンクが載る。ASCII の外の文字（日本語のパスなど）は符号化した形にして返す
  if (/[\s\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(url)) return fallback;
  return /^[\x21-\x7e]+$/.test(url) ? url : u.href;
}

/** Banto が付け足す鍵（banto_…）に読めるか。連携サイトの読み方の違い（. や空白を _ に直す・もう一度復号する）も同じ鍵として扱う */
function bantoKey(key: string): boolean {
  let k = key;
  try {
    k = decodeURIComponent(key);
  } catch {
    // 復号できない鍵はそのまま見る
  }
  return k.toLowerCase().replace(/[^a-z0-9]/g, "_").startsWith("banto_");
}

/** 送料の案内（カート・確認画面・API で共通） */
export function shippingSummary(
  shop: PublicShop,
  /** カートの目安（0171）: ログイン中の会員が当てはまる会員の条件のいちばん低い送料無料の金額（memberFreeOverHint）。表示だけ */
  memberFreeOver: number | null = null,
): { summary: string; freeOver: number | null; table: { prefecture: string; fee: number }[] | null; memberFree: { label: string; freeOver: number }[]; taxRate: number; viewerFreeOver: number | null; viewerFreeMember: boolean } {
  const settings = shop.settings ?? {};
  const d = describeShipping(parseShippingSettings(settings["shipping"]));
  // 会員の条件ごとの送料無料（0171）は、会員の条件のモジュールが ON のときだけ案内する
  const on = moduleEnabled(settings, AUDIENCES_MODULE);
  const viewer = freeShippingTarget(d.freeOver, on ? memberFreeOver : null);
  return { ...d, memberFree: on ? d.memberFree : [], taxRate: taxRate(settings), viewerFreeOver: viewer.over, viewerFreeMember: viewer.member };
}

export { PREFECTURES };
