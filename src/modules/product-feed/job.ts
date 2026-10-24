/**
 * 商品フィードを作って StorageAdapter（R2）に置く。Cron（1 時間ごと）と管理画面の「今すぐ作る」から呼ぶ。
 * データは anon の経路（公開中のものだけ）で読む。service_role は使わない。
 * 置き場所: feeds/<shop_id>/products.xml と、状態の feeds/<shop_id>/meta.json。配信は /<スラッグ>/feed/products.xml（短いキャッシュ）。
 */
import type { Adapters, StorageAdapter } from "../../adapters/types";
import { createDbClient } from "../../db/client";
import { StorefrontData, type PublicShop } from "../../storefront/data";
import { shopHome } from "../../storefront/urls";
import { moduleEnabled } from "../registry";
import { buildFeed, feedXml } from "./feed";
import { externalProductUrl } from "../../storefront/mode";

export const FEED_MODULE = "product_feed";
/** Cron で作り直す間隔 */
export const FEED_INTERVAL_MS = 60 * 60 * 1000;

export const feedKey = (shopId: string) => `feeds/${shopId}/products.xml`;
const metaKey = (shopId: string) => `feeds/${shopId}/meta.json`;

export interface FeedMeta {
  generated_at: string;
  items: number;
  skipped: { no_image: number; no_price: number };
}

export interface FeedBases {
  /** Banto の外から見た URL（PUBLIC_BASE_URL）。独自ドメインのショップでは使わない */
  publicBaseUrl: string | undefined;
  mediaBaseUrl: string | undefined;
}

export async function readFeedMeta(storage: StorageAdapter, shopId: string): Promise<FeedMeta | null> {
  const obj = await storage.get(metaKey(shopId));
  if (!obj) return null;
  try {
    return (await new Response(obj.body).json()) as FeedMeta;
  } catch {
    return null;
  }
}

/** 作れたら meta を返す。URL の起点が分からなければ null（PUBLIC_BASE_URL が要る） */
export async function generateFeed(sf: StorefrontData, storage: StorageAdapter, shop: PublicShop, bases: FeedBases, now = new Date()): Promise<FeedMeta | null> {
  const base = bases.publicBaseUrl?.replace(/\/+$/, "");
  if (!base && !shop.domain) return null;
  const media = (bases.mediaBaseUrl || (base ? `${base}/media` : "")).replace(/\/+$/, "");
  if (!media) return null;
  const target = { shopName: shop.name, home: shopHome(base ?? "", shop), mediaBaseUrl: media, productLink: (slug: string) => externalProductUrl(shop.settings, slug) };
  const result = buildFeed(await sf.feedCatalog(shop), target);
  await storage.put(feedKey(shop.id), new TextEncoder().encode(feedXml(result, target)).buffer as ArrayBuffer, "application/xml; charset=utf-8");
  const meta: FeedMeta = { generated_at: now.toISOString(), items: result.items.length, skipped: result.skipped };
  await storage.put(metaKey(shop.id), new TextEncoder().encode(JSON.stringify(meta)).buffer as ArrayBuffer, "application/json");
  return meta;
}

/** jobs/index.ts から登録する。モジュールが ON の公開中のショップだけ、1 時間ごとに作り直す */
export function registerFeedJob(adapters: Adapters, doFetch: typeof fetch): void {
  const cfg = adapters.config;
  const url = cfg.get("SUPABASE_URL");
  const anonKey = cfg.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) return;
  adapters.scheduler.register("product_feeds", async () => {
    const sf = new StorefrontData(createDbClient({ url, anonKey, fetch: doFetch }), adapters.cache);
    const bases = { publicBaseUrl: cfg.get("PUBLIC_BASE_URL"), mediaBaseUrl: cfg.get("MEDIA_BASE_URL") };
    for (const shop of await sf.listShops()) {
      if (!moduleEnabled(shop.settings, FEED_MODULE)) continue;
      const meta = await readFeedMeta(adapters.storage, shop.id);
      if (meta && Date.now() - Date.parse(meta.generated_at) < FEED_INTERVAL_MS - 60_000) continue;
      // 1 店の失敗で他の店とハートビートを止めない
      await generateFeed(sf, adapters.storage, shop, bases).catch((e: unknown) => console.error(`[banto] product feed ${shop.slug}:`, e));
    }
  });
}
