/**
 * カート: 署名付き Cookie（ショップごとに1つ）。サーバー側に状態を持たない（ARCHITECTURE.md「使わないもの」）。
 * 中身は SKU id と数量と、入力されたクーポンのコードだけ。価格・在庫・値引きは表示のたびに DB から読み、判定し直す。
 */
import { openJson, sealJson } from "../util/signed";

export interface CartItem {
  sku_id: string;
  qty: number;
}

export interface Cart {
  items: CartItem[];
  /** 入力されたクーポンのコード（大文字、最大 5 件、入力順）。使えるかどうかは毎回判定する */
  coupons?: string[];
}

export const CART_MAX_LINES = 20;
export const CART_MAX_QTY = 99;
export const CART_MAX_COUPONS = 5;
const COUPON_RE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/; // 実体は UUID。有効性は DB 照合で確認する

export function cartCookieName(shopId: string): string {
  return `banto_cart_${shopId.replace(/[^a-zA-Z0-9]/g, "")}`;
}

export function normalizeCart(input: unknown): Cart {
  const items: CartItem[] = [];
  const raw = (input as { items?: unknown } | null)?.items;
  if (Array.isArray(raw)) {
    for (const it of raw) {
      const sku_id = (it as { sku_id?: unknown })?.sku_id;
      const qty = Number((it as { qty?: unknown })?.qty);
      if (typeof sku_id !== "string" || !ID_RE.test(sku_id) || !Number.isInteger(qty) || qty <= 0) continue;
      const existing = items.find((x) => x.sku_id === sku_id);
      if (existing) existing.qty = Math.min(CART_MAX_QTY, existing.qty + qty);
      else if (items.length < CART_MAX_LINES) items.push({ sku_id, qty: Math.min(CART_MAX_QTY, qty) });
    }
  }
  const coupons: string[] = [];
  const rawCoupons = (input as { coupons?: unknown } | null)?.coupons;
  if (Array.isArray(rawCoupons))
    for (const c of rawCoupons) {
      const code = typeof c === "string" ? c.trim().toUpperCase() : "";
      if (COUPON_RE.test(code) && !coupons.includes(code) && coupons.length < CART_MAX_COUPONS) coupons.push(code);
    }
  return coupons.length > 0 ? { items, coupons } : { items };
}

export async function openCart(secret: string, cookie: string | undefined): Promise<Cart> {
  return normalizeCart(await openJson(secret, cookie));
}

export function sealCart(secret: string, cart: Cart): Promise<string> {
  return sealJson(secret, normalizeCart(cart));
}

/** qty <= 0 で削除。戻り値は新しいカート */
export function setQty(cart: Cart, skuId: string, qty: number): Cart {
  const items = cart.items.filter((x) => x.sku_id !== skuId);
  if (Number.isInteger(qty) && qty > 0) items.push({ sku_id: skuId, qty: Math.min(CART_MAX_QTY, qty) });
  return normalizeCart({ items, coupons: cart.coupons });
}

/** カートにある行の数だけを変える（並びはそのまま。qty <= 0 で外す）。カートに無い SKU は何もしない（Shopify の change と同じ） */
export function changeQty(cart: Cart, skuId: string, qty: number): Cart {
  if (!cart.items.some((x) => x.sku_id === skuId)) return cart;
  const items = cart.items.flatMap((x) => (x.sku_id !== skuId ? [x] : Number.isInteger(qty) && qty > 0 ? [{ sku_id: skuId, qty: Math.min(CART_MAX_QTY, qty) }] : []));
  return normalizeCart({ items, coupons: cart.coupons });
}

/** クーポンのコードを足す（形が違えば何もしない。使えるかどうかはカートの表示のたびに判定する） */
export function addCoupon(cart: Cart, code: string): Cart {
  return normalizeCart({ items: cart.items, coupons: [...(cart.coupons ?? []), code] });
}

export function removeCoupon(cart: Cart, code: string): Cart {
  const c = code.trim().toUpperCase();
  return normalizeCart({ items: cart.items, coupons: (cart.coupons ?? []).filter((x) => x !== c) });
}

export function addItem(cart: Cart, skuId: string, qty: number): Cart {
  const current = cart.items.find((x) => x.sku_id === skuId)?.qty ?? 0;
  return setQty(cart, skuId, current + qty);
}

export function cartCookieHeader(name: string, value: string, opts: { path: string; secure: boolean }): string {
  const parts = [`${name}=${value}`, `Path=${opts.path}`, "HttpOnly", "SameSite=Lax", `Max-Age=${60 * 60 * 24 * 14}`];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}
