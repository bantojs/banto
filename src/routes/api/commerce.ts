import { deliveryOptions } from "../../modules/delivery-time";
import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { createDbClient } from "../../db/client";
import { StorefrontData, type PublicShop } from "../../storefront/data";
import { CART_MAX_COUPONS, CART_MAX_LINES, CART_MAX_QTY, addCoupon, addItem, normalizeCart, removeCoupon, sealCart, setQty, type Cart } from "../../cart/cart";
import { normalizeCode } from "../../commerce/discounts";
import { openJson } from "../../util/signed";
import { STATUS_QUERY_PARAM, couponNotice, createQuote, openStatusToken, sealStatusToken, withQueryParam, discountCart, isProvider, openQuote, paymentSetup, placeOrder, reserveLimits, priceCart, providerAvailable, recheckQuote, returnOrigins, safeReturnUrl, shippingSummary, type QuoteContext, consentCollected } from "../../commerce/checkout";
import { couponSource, placeOrderDeps, privilegedFor } from "../payment-deps";
import { memberFromRequest, type ApiMember } from "./members";
import { clientIpFor, param, publicBaseUrl, type Ctx } from "../common";
import { shopHome } from "../../storefront/urls";

/**
 * ヘッドレスのカート・チェックアウト API（認証なし、CORS 許可）。docs/headless.md
 *
 *   GET  /api/shops/:shop/cart?cart=<token>       カートの中身（最新の価格・在庫で再計算）
 *   POST /api/shops/:shop/cart                    { cart?, op: add|set|remove|clear|coupon_add|coupon_remove, sku_id?, qty?, code? }
 *   POST /api/shops/:shop/checkout/quote          { cart, provider, address } → 最終確認の内容 + quote
 *   POST /api/shops/:shop/checkout                { quote, success_url?, cancel_url? } → 決済ページの URL
 *
 * カートはサーバーに状態を持たない署名付きトークン（同梱テーマのカート Cookie と同じ形式）。
 * 価格・在庫・送料・合計の判定はすべて Banto が行い、連携側は返ってきた値を表示するだけにする。
 * Cookie を使わないので CSRF は成立しない（ブラウザの資格情報を使う操作が無い）。
 */
export const commerceApi = new Hono<AppEnv>();

interface Scope {
  sf: StorefrontData;
  shop: PublicShop;
  secret: string;
  base: string;
  /** クーポンの判定の材料（同梱モジュール coupons が OFF なら null） */
  coupons: ReturnType<typeof couponSource>;
  /** Authorization: Bearer の会員（Banto の会員トークン、/members/verify で発行）。無ければゲスト */
  member: ApiMember | null;
  /** 「お得な情報やセールの案内を受け取る」の欄を出すか（ショップの設定 × 0050） */
  consent: boolean;
}

async function scope(c: Ctx): Promise<Scope | Response> {
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const anonKey = cfg.get("SUPABASE_ANON_KEY");
  const secret = c.get("sessionSecret");
  if (!url || !anonKey || !secret) return c.json({ error: "not_configured" }, 503);
  const sf = new StorefrontData(createDbClient({ url, anonKey, fetch: c.get("deps").fetch }), c.get("adapters").cache);
  const shop = await sf.shopBySlug(param(c, "shop"));
  if (!shop) return c.json({ error: "not_found" }, 404);
  const m = await memberFromRequest(c, shop);
  // トークンが付いているのに確かめられない: 連携側はトークンを更新して呼び直す（黙ってゲスト扱いにすると、会員の値引きが消えて見える）
  if (!m.ok) return c.json({ error: "invalid_member_token" }, 401);
  return { sf, shop, secret, base: publicBaseUrl(c), coupons: couponSource(c, shop), member: m.member, consent: consentCollected(shop) };
}

async function jsonBody(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** トークン → カート。省略なら空、署名が合わなければ null（連携側は保持しているトークンを捨てて作り直す） */
async function openCartToken(secret: string, token: unknown): Promise<Cart | null> {
  if (token === undefined || token === null || token === "") return { items: [] };
  if (typeof token !== "string") return null;
  const raw = await openJson(secret, token);
  return raw === null ? null : normalizeCart(raw);
}

async function cartView(c: Ctx, s: Scope, cart: Cart) {
  const [priced, setup] = await Promise.all([priceCart(s.sf, s.shop, cart), paymentSetup(s.sf, s.shop, c.get("adapters").config)]);
  const token = await sealCart(s.secret, { ...priced.cart, ...(cart.coupons ? { coupons: cart.coupons } : {}) });
  const shipping = shippingSummary(s.shop);
  const short = priced.lines.some((l) => l.short);
  // 送料は配送先が決まるまで分からないので 0 で判定する（送料無料のクーポンは quote で額が決まる）。
  // 会員（Bearer トークン）なら会員限定のクーポンと、会員 ID での 1 人あたりの回数も判定する
  const discount = s.coupons ? await discountCart({ sf: s.sf, shop: s.shop, coupons: s.coupons, member: s.member }, priced, cart.coupons, 0, null) : null;
  return {
    cart: token,
    items: priced.lines.map((l) => ({
      sku_id: l.sku.id,
      sku_code: l.sku.code,
      sku_name: l.sku.name ?? null,
      product_id: l.product.id,
      product_slug: l.product.slug,
      product_name: l.product.name,
      unit_price_jpy: l.sku.price_jpy,
      qty: l.qty,
      line_total_jpy: l.sku.price_jpy * l.qty,
      in_stock: l.sku.available > 0,
      short: l.short,
    })),
    /** 非公開になった・削除された SKU（返したトークンからは外してある） */
    removed: priced.dropped,
    count: priced.lines.reduce((n, l) => n + l.qty, 0),
    subtotal_jpy: priced.subtotal,
    /** クーポン（同梱モジュール coupons が OFF なら null）。discount_jpy は商品の値引き（送料無料は quote で反映） */
    coupons: discount
      ? {
          applied: discount.applied.map((a) => ({ code: a.code, name: a.name, kind: a.kind, amount_jpy: a.amount_jpy })),
          rejected: discount.rejected.map(couponNotice),
          discount_jpy: discount.itemDiscount,
          subtotal_after_discount_jpy: priced.subtotal - discount.itemDiscount,
        }
      : null,
    tax_rate: shipping.taxRate,
    tax_included: true,
    shipping: {
      summary: shipping.summary,
      free_over_jpy: shipping.freeOver,
      remaining_for_free_jpy: shipping.freeOver === null ? null : Math.max(0, shipping.freeOver - priced.subtotal),
      by_prefecture: shipping.table,
    },
    payments: setup.options,
    /** 配送日時の選択肢（同梱モジュール delivery_time が OFF なら null）。チェックアウトの配送先の delivery_date / delivery_slot に value を渡す */
    delivery: deliveryOptions(s.shop.settings),
    can_checkout: priced.lines.length > 0 && !short && (setup.options.stripe || setup.options.komoju),
    /** 会員として判定したか（Authorization: Bearer が有効なら会員 ID） */
    member: s.member ? { id: s.member.id } : null,
    /** 同梱テーマのレジ（配送先 → 最終確認 → 決済）で続けるときの URL */
    checkout_url: `${shopHome(s.base, s.shop)}/cart/load?cart=${encodeURIComponent(token)}`,
    limits: { max_lines: CART_MAX_LINES, max_qty: CART_MAX_QTY, max_coupons: CART_MAX_COUPONS },
  };
}

commerceApi.get("/shops/:shop/cart", async (c: Ctx) => {
  const s = await scope(c);
  if (s instanceof Response) return s;
  const cart = await openCartToken(s.secret, c.req.query("cart"));
  if (!cart) return c.json({ error: "invalid_cart" }, 400);
  return c.json(await cartView(c, s, cart));
});

commerceApi.post("/shops/:shop/cart", async (c: Ctx) => {
  const s = await scope(c);
  if (s instanceof Response) return s;
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "invalid_request" }, 400);
  let cart = await openCartToken(s.secret, body.cart);
  if (!cart) return c.json({ error: "invalid_cart" }, 400);
  const op = body.op;
  const skuId = typeof body.sku_id === "string" ? body.sku_id.trim() : "";
  const qty = body.qty === undefined ? (op === "add" ? 1 : NaN) : Number(body.qty);
  if (op === "clear") {
    cart = { items: [] };
  } else if (op === "coupon_add" || op === "coupon_remove") {
    if (!s.coupons) return c.json({ error: "coupons_disabled" }, 409);
    const code = normalizeCode(body.code);
    if (!code) return c.json({ error: "invalid_request", field: "code" }, 400);
    cart = op === "coupon_add" ? addCoupon(cart, code) : removeCoupon(cart, code);
  } else if (op === "add" || op === "set" || op === "remove") {
    if (!skuId) return c.json({ error: "invalid_request", field: "sku_id" }, 400);
    if (op !== "remove" && (!Number.isInteger(qty) || qty < (op === "add" ? 1 : 0))) return c.json({ error: "invalid_request", field: "qty" }, 400);
    if (op !== "remove") {
      // 公開中の SKU だけ受け付ける
      const found = await s.sf.skusForCart(s.shop, [skuId]);
      if (!found.has(skuId) && !(op === "set" && qty === 0)) return c.json({ error: "sku_not_available", sku_id: skuId }, 404);
    }
    cart = op === "add" ? addItem(cart, skuId, qty) : setQty(cart, skuId, op === "remove" ? 0 : qty);
  } else {
    return c.json({ error: "invalid_request", field: "op" }, 400);
  }
  return c.json(await cartView(c, s, cart));
});

/** カート + 配送先 → 最終確認の内容（confirmation）と quote。連携側は confirmation を申込みボタンの直前に全部表示する */
commerceApi.post("/shops/:shop/checkout/quote", async (c: Ctx) => {
  const s = await scope(c);
  if (s instanceof Response) return s;
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "invalid_request" }, 400);
  const cart = await openCartToken(s.secret, body.cart);
  if (!cart) return c.json({ error: "invalid_cart" }, 400);
  const provider = body.provider ?? "stripe";
  if (!isProvider(provider)) return c.json({ error: "invalid_request", field: "provider" }, 400);
  const setup = await paymentSetup(s.sf, s.shop, c.get("adapters").config);
  if (!providerAvailable(setup, provider)) return c.json({ error: "payment_unavailable", payments: setup.options }, 409);
  const address = body.address && typeof body.address === "object" ? (body.address as Record<string, unknown>) : {};
  const r = await createQuote(quoteContext(s), cart, provider, address);
  if (!r.ok) {
    if (r.error === "invalid_address") return c.json({ error: "invalid_address", fields: r.invalid }, 400);
    // minimum_amount: 値引き後の支払い額が決済の最低額（50 円）未満
    return c.json({ error: r.error }, 409);
  }
  return c.json({ quote: r.token, expires_at: new Date(r.quote.expiresAt * 1000).toISOString(), confirmation: r.confirmation });
});

/** quote（購入者が確認した内容）で注文を確定し、決済ページの URL を返す。内容が変わっていれば 409 で出し直す */
commerceApi.post("/shops/:shop/checkout", async (c: Ctx) => {
  const s = await scope(c);
  if (s instanceof Response) return s;
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "invalid_request" }, 400);
  const quote = await openQuote(s.secret, typeof body.quote === "string" ? body.quote : undefined, s.shop.id);
  if (!quote) return c.json({ error: "invalid_quote" }, 400);
  const setup = await paymentSetup(s.sf, s.shop, c.get("adapters").config);
  if (!providerAvailable(setup, quote.provider)) return c.json({ error: "payment_unavailable", payments: setup.options }, 409);
  const check = await recheckQuote(quoteContext(s), quote);
  if (!check.ok) {
    if (check.error === "changed" && check.fresh.ok) return c.json({ error: "changed", quote: check.fresh.token, expires_at: new Date(check.fresh.quote.expiresAt * 1000).toISOString(), confirmation: check.fresh.confirmation }, 409);
    return c.json({ error: "stock" }, 409);
  }
  const deps = placeOrderDeps(c, setup);
  if (!deps) return c.json({ error: "not_configured" }, 503);
  const allowed = returnOrigins(s.shop.settings);
  const shopUrl = shopHome(s.base, s.shop);
  // 照会トークン（0035）: 戻り先の画面が「確定したか・注文番号」を引ける。success_url にも付ける（連携側はクエリから拾える）
  const statusToken = quote.id ? await sealStatusToken(s.secret, s.shop.id, quote.id) : null;
  const successUrl = safeReturnUrl(body.success_url, allowed, `${shopUrl}/checkout/done`);
  const placed = await placeOrder(deps, {
    shop: s.shop,
    quote,
    lines: check.lines,
    subtotal: check.subtotal,
    discount: check.discount,
    successUrl: statusToken ? withQueryParam(successUrl, successUrl.startsWith(`${shopUrl}/checkout/done`) ? "s" : STATUS_QUERY_PARAM, statusToken) : successUrl,
    cancelUrl: safeReturnUrl(body.cancel_url, allowed, `${shopUrl}/cart`),
    // 会員の注文として紐づける（会員は自分の注文を /members/me や会員ページで読める）
    ...(s.member ? { customerId: s.member.id, customerEpoch: s.member.epoch } : {}),
    limits: await reserveLimits(s.secret, quote, await clientIpFor(c, s.shop), s.member ? { id: s.member.id } : null),
  });
  if (!placed.ok) {
    if (placed.error === "stock") return c.json({ error: "stock" }, 409);
    // 0029: 同じ quote は 1 回だけ（quote を取り直す）/ 同じ人・同じ IP の未確定の予約が上限（決済を済ませるか期限切れを待つ）
    if (placed.error === "quote_used") return c.json({ error: "invalid_quote" }, 400);
    if (placed.error === "limit") return c.json({ error: "too_many_reservations" }, 429);
    // coupon: 確定の瞬間にクーポンの枠が無くなった・回数の上限に達した。quote を作り直して見せ直す
    if (placed.error === "coupon") return c.json({ error: "coupon_unavailable" }, 409);
    // 会員のトークンが古い（全端末からログアウトした後）。連携側はログインし直す
    if (placed.error === "member") return c.json({ error: "invalid_member_token" }, 401);
    return c.json({ error: "payment_failed" }, 502);
  }
  const status = statusToken ? { status_token: statusToken, status_url: `${s.base}/api/shops/${s.shop.slug}/checkout/status?token=${encodeURIComponent(statusToken)}` } : {};
  // 0 円の注文は決済なしでこの時点で確定している。payment_url は完了画面（success_url）
  if (placed.free) return c.json({ payment_url: withQueryParam(placed.url, "free", "1"), free: true, order_id: placed.free.orderId, ...status });
  return c.json({ payment_url: placed.url, ...status });
});

/**
 * 戻り先の画面のための注文の状態（0035）。照会トークン（POST /checkout の status_token、success_url の banto_status）で引く。
 * 返すのは状態と注文番号・合計だけ（個人情報は注文照会 lookup_order で）。応答はキャッシュしない
 */
commerceApi.get("/shops/:shop/checkout/status", async (c: Ctx) => {
  const s = await scope(c);
  if (s instanceof Response) return s;
  const st = await openStatusToken(s.secret, c.req.query("token"), s.shop.id);
  if (!st) return c.json({ error: "invalid_token" }, 400);
  const db = privilegedFor(c);
  if (!db) return c.json({ error: "not_configured" }, 503);
  const r = await db.checkoutStatus(s.shop.id, st.quoteId);
  return c.json(r, 200, { "cache-control": "no-store" });
});

function quoteContext(s: Scope): QuoteContext {
  return { sf: s.sf, shop: s.shop, secret: s.secret, baseUrl: s.base, coupons: s.coupons, member: s.member, consent: s.consent };
}
