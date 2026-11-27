import { migrationStateFor, type Ctx } from "./common";
import { createPrivilegedDb, type PrivilegedDb } from "../db/privileged";
import { createStripeClient, type StripeClient } from "../payments/stripe";
import { PAYMENT_RESUME_MIGRATION, createKomojuClient } from "../plugins/komoju";
import type { ResumeDeps } from "../commerce/payment-resume";
import { amazonPayFromConfig } from "../plugins/amazon_pay";
import type { CouponSource, PaymentSetup, PlaceOrderDeps } from "../commerce/checkout";
import type { PublicShop } from "../storefront/data";
import { moduleEnabled } from "../modules/registry";
import { AUDIENCES_MODULE } from "../members/audience";
import { AUDIENCE_FREE_SHIPPING_MIGRATION, FREE_SHIPPING_EXCLUDE_SALE_MIGRATION, parseShippingSettings } from "../commerce/shipping";
import { migrated } from "../db/migration-state";

/** 決済まわりのクライアント。ストアフロント（同梱テーマのレジ）とヘッドレス API で共通 */
function stripeFor(c: Ctx): StripeClient | null {
  const cfg = c.get("adapters").config;
  const secretKey = cfg.get("STRIPE_SECRET_KEY");
  if (!secretKey) return null;
  return createStripeClient({ secretKey, clientId: cfg.get("STRIPE_CLIENT_ID"), context: cfg.get("STRIPE_CONTEXT"), fetch: c.get("deps").fetch });
}

export function komojuFor(c: Ctx): ReturnType<typeof createKomojuClient> | null {
  const secretKey = c.get("adapters").config.get("KOMOJU_SECRET_KEY");
  return secretKey ? createKomojuClient({ secretKey, fetch: c.get("deps").fetch }) : null;
}

export function privilegedFor(c: Ctx): PrivilegedDb | null {
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) return null;
  return createPrivilegedDb({ url, serviceRoleKey, fetch: c.get("deps").fetch });
}

/** 決済の準備（API と共通）。設定が足りなければ null */
export function placeOrderDeps(c: Ctx, setup: PaymentSetup): PlaceOrderDeps | null {
  const privileged = privilegedFor(c);
  if (!privileged) return null;
  const url = c.get("adapters").config.get("SUPABASE_URL") ?? "";
  const secret = c.get("sessionSecret");
  return { privileged, stripe: stripeFor(c), komoju: komojuFor(c), amazonPay: setup.amazonPay && secret ? { secret } : null, setup, migrationState: migrationStateFor(c, url) };
}

/** Amazon Pay のクライアント（中継ページ・戻り・IPN）。設定が足りなければ null */
export function amazonPayFor(c: Ctx): ReturnType<typeof amazonPayFromConfig> {
  return amazonPayFromConfig(c.get("adapters").config, c.get("deps").fetch);
}

/**
 * 会員の条件ごとの送料無料の金額（0171）を DB に聞く関数（QuoteContext.memberFreeOver）。
 * ゲスト・会員の条件のモジュールが OFF・決まりが無い・0171 の前は undefined（DB の往復を足さない）。1 リクエストで 1 回だけ聞く。
 * DB はセッション（世代・行）も確かめる。セッションの行の無い古い Cookie・トークンは聞かない（送料がかかる）。
 * DB のエラーは送料がかかる側に倒す（null。確定の前の引き直しで確認画面を出し直す）
 */
export function memberFreeOverSource(c: Ctx, shop: PublicShop, member: { id: string; epoch: number; sid?: string | undefined } | null | undefined): (() => Promise<number | { over: number; excludeSale: boolean }[] | null>) | undefined {
  if (!member?.id || !member.sid || !moduleEnabled(shop.settings, AUDIENCES_MODULE)) return undefined;
  if (!parseShippingSettings((shop.settings ?? {})["shipping"]).has_member_free) return undefined;
  const who = { id: member.id, epoch: member.epoch, sid: member.sid };
  const privileged = privilegedFor(c);
  if (!privileged) return undefined;
  const state = migrationStateFor(c, c.get("adapters").config.get("SUPABASE_URL") ?? "");
  let once: Promise<number | { over: number; excludeSale: boolean }[] | null> | null = null;
  return () =>
    (once ??= (async () => {
      if (!state || !(await migrated(state, AUDIENCE_FREE_SHIPPING_MIGRATION))) return null;
      // 0183 から: 決まりごとの金額とセール商品を含まない印。前は いちばん低い金額だけ
      if (await migrated(state, FREE_SHIPPING_EXCLUDE_SALE_MIGRATION)) {
        return privileged.memberFreeShipping(shop.id, who).catch((e: unknown) => {
          console.warn(`member_free_shipping failed (shop ${shop.id}): ${e instanceof Error ? e.name : "error"}`);
          return null;
        });
      }
      return privileged.memberFreeShippingOver(shop.id, who).catch((e: unknown) => {
        // 会員の判定ができないときは送料がかかる側（個人情報は出さない）
        console.warn(`member_free_shipping_over failed (shop ${shop.id}): ${e instanceof Error ? e.name : "error"}`);
        return null;
      });
    })());
}

/**
 * クーポンの判定の材料（coupon_lookup、service_role）。同梱モジュール coupons が OFF のショップでは null を返し、
 * カートにも確認画面にも DB の往復を足さない（ショップ行の設定で判定する）
 */
export function couponSource(c: Ctx, shop: PublicShop): CouponSource | null {
  if (!moduleEnabled(shop.settings, "coupons")) return null;
  const privileged = privilegedFor(c);
  if (!privileged) return null;
  return {
    lookup: (codes, subject, customerId) => privileged.couponLookup(shop.id, codes, subject, customerId ?? null),
  };
}

/** お支払いに戻る・取りやめる（0180、src/commerce/payment-resume.ts）。0180 の前・設定が足りなければ null */
export async function resumeDepsFor(c: Ctx): Promise<ResumeDeps | null> {
  const privileged = privilegedFor(c);
  if (!privileged) return null;
  const state = migrationStateFor(c, c.get("adapters").config.get("SUPABASE_URL") ?? "");
  if (!state || !(await migrated(state, PAYMENT_RESUME_MIGRATION))) return null;
  return { privileged, komoju: komojuFor(c) };
}
