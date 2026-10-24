import { Hono } from "hono";
import { ipHash } from "../../members/auth";
import type { AppEnv } from "../../app";
import { createDbClient } from "../../db/client";
import { PrivilegedRpcError } from "../../db/privileged";
import { StorefrontData, type PublicShop } from "../../storefront/data";
import { normalizeCart, sealCart, type Cart } from "../../cart/cart";
import { priceCart } from "../../commerce/checkout";
import { openJson } from "../../util/signed";
import { moduleEnabled } from "../../modules/registry";
import { TRYON_MODULE, checkTryon, hoursOn, storeView, todayHere, tryonSettings, visitDates, type StoreRow } from "../../modules/store-tryon";
import { privilegedFor } from "../payment-deps";
import { memberFromRequest, type ApiMember } from "./members";
import { clientIpFor, param, type Ctx } from "../common";

/**
 * ヘッドレスのお店で試着（同梱モジュール store_tryon、決済なし。docs/headless.md「お店で試着」、docs/store-tryon.md）。認証なし、CORS 許可。
 *
 *   GET  /api/shops/:shop/stores        このショップの実店舗（営業時間・今日の営業・臨時休業 / 臨時営業）と試着の設定。
 *                                       来店日を選ぶ形なら、試着を受ける店舗ごとに選べる日（visit_dates）
 *   POST /api/shops/:shop/tryon         { cart, store, visit_date?, customer_name, customer_email, customer_phone, note? }
 *                                       → 201 { number, store, cart }（cart は商品を外したトークン。クーポンは残す）
 *
 * カートはカート API と同じ署名付きトークン。Authorization: Bearer に会員トークンがあれば会員の申し込みにする（会員ページに出る）。
 * 決済をしないので最終確認画面（特商法）は要らない。在庫は申し込みの時点で減る（0025 の tryon_request）。
 */
export const tryonApi = new Hono<AppEnv>();

interface Scope {
  sf: StorefrontData;
  shop: PublicShop;
  secret: string;
  member: ApiMember | null;
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
  if (!moduleEnabled(shop.settings, TRYON_MODULE)) return c.json({ error: "tryon_disabled" }, 404);
  const m = await memberFromRequest(c, shop);
  if (!m.ok) return c.json({ error: "invalid_member_token" }, 401);
  return { sf, shop, secret, member: m.member };
}

function storeJson(st: StoreRow, today: string, visit: string[] | null) {
  const v = storeView(st, today);
  const now = hoursOn(st, today);
  return {
    id: st.id,
    name: st.name,
    postal_code: st.postal_code,
    address: st.address,
    phone: st.phone,
    note: st.note,
    tryon: st.tryon,
    /** 曜日ごとの営業時間（キーは曜日、0 = 日曜。空の配列は定休日） */
    hours: st.hours,
    special_days: st.special_days,
    /** 表示用（同梱テーマと同じ文） */
    week: v.week,
    today: { open: now.open, hours: now.ranges, text: v.today },
    specials: v.specials,
    ...(visit ? { visit_dates: visit } : {}),
  };
}

tryonApi.get("/shops/:shop/stores", async (c: Ctx) => {
  const s = await scope(c);
  if (s instanceof Response) return s;
  const settings = tryonSettings(s.shop.settings);
  const today = todayHere();
  const stores = await s.sf.listStores(s.shop);
  return c.json({
    stores: stores.map((st) => storeJson(st, today, settings.mode === "visit" && st.tryon ? visitDates(st, settings, today) : null)),
    tryon: { mode: settings.mode, hold_days: settings.hold_days, max_items: settings.max_items, notice: settings.notice },
    today,
  });
});

const RPC_ERRORS: Record<string, string> = {
  insufficient_stock: "stock",
  too_many_requests: "too_many_requests",
  sku_not_available: "stock",
  store_not_available: "store_unavailable",
  invalid_customer: "invalid_customer",
};

tryonApi.post("/shops/:shop/tryon", async (c: Ctx) => {
  const s = await scope(c);
  if (s instanceof Response) return s;
  let body: Record<string, unknown>;
  try {
    const b: unknown = await c.req.json();
    if (!b || typeof b !== "object" || Array.isArray(b)) return c.json({ error: "invalid_request" }, 400);
    body = b as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }
  const raw = typeof body.cart === "string" ? await openJson(s.secret, body.cart) : null;
  if (raw === null) return c.json({ error: "invalid_cart" }, 400);
  const cart: Cart = normalizeCart(raw);
  const settings = tryonSettings(s.shop.settings);
  const [priced, stores] = await Promise.all([priceCart(s.sf, s.shop, cart), s.sf.listStores(s.shop)]);
  if (priced.lines.length === 0) return c.json({ error: "empty_cart" }, 409);
  if (priced.lines.some((l) => l.short)) return c.json({ error: "stock" }, 409);
  if (priced.lines.reduce((n, l) => n + l.qty, 0) > settings.max_items) return c.json({ error: "too_many_items", max_items: settings.max_items }, 409);
  const form: Record<string, string | undefined> = {};
  for (const k of ["store", "visit_date", "customer_name", "customer_email", "customer_phone", "note"]) form[k] = typeof body[k] === "string" ? (body[k] as string) : undefined;
  const today = todayHere();
  const r = checkTryon(
    form,
    stores.filter((x) => x.tryon),
    settings,
    today,
  );
  if (!r.store) return c.json({ error: "store_unavailable" }, 400);
  if (r.error) return c.json({ error: "invalid_request", field: r.error.replace(/^tryon\.error_/, "") }, 400);
  const db = privilegedFor(c);
  if (!db) return c.json({ error: "not_configured" }, 503);
  try {
    const res = await db.tryonRequest(
      s.shop.id,
      r.store.id,
      priced.lines.map((l) => ({ sku_id: l.sku.id, qty: l.qty })),
      { customer_email: r.input.customer_email, customer_name: r.input.customer_name, customer_phone: r.input.customer_phone, note: r.input.note || null, customer_id: s.member?.id ?? null, ip_hash: await clientIpFor(c, s.shop).then((ip) => (ip ? ipHash(s.secret, ip) : null)) },
      r.input.visit_date || null,
    );
    // 申し込んだ商品はカートから外す（クーポンは残す）
    const rest = await sealCart(s.secret, { items: [], ...(cart.coupons ? { coupons: cart.coupons } : {}) });
    return c.json({ number: res.number, store: storeJson(r.store, today, null), visit_date: r.input.visit_date || null, cart: rest, member: s.member ? { id: s.member.id } : null }, 201);
  } catch (e) {
    if (e instanceof PrivilegedRpcError) {
      const code = Object.entries(RPC_ERRORS).find(([k]) => e.dbMessage.includes(k))?.[1];
      if (code) return c.json({ error: code }, 409);
    }
    throw e;
  }
});
