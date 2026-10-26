/**
 * 商品フィードを作って StorageAdapter（R2）に置く。Cron（1 時間ごと）と管理画面の「今すぐ作る」から呼ぶ。
 * データは anon の経路（公開中のものだけ）で読む。service_role は使わない。
 *
 * 0060 以降は分けて作る（商品が何十万件あっても 1 回の処理の問い合わせの数が増えないように。docs/knowledge/02-decisions.md 2026-10-26）:
 *   1 回の処理で product_feed_page（id 順、1,000 商品ずつ）を数ページ読み、<item> の並びを 1 つのファイル（part）にして置く。
 *   途中の位置は feeds/<shop_id>/run.json。最後まで読んだら meta.json に run と part の数を書き、前の回の part を消す。
 *   配信（/<スラッグ>/feed/products.xml）は頭・part・尻をつないで流す（readFeed）。
 *   1 回に進める量は workers_plan（free は 3 ページ、paid は 10 ページ）と、part の大きさ（8MB）で決める。
 * 0060 より前の DB は全件を読んで 1 つのファイルに（feeds/<shop_id>/products.xml）。
 */
import type { Adapters, StorageAdapter } from "../../adapters/types";
import { createDbClient } from "../../db/client";
import { CATALOG_PAGES_MIGRATION, StorefrontData, type PublicShop } from "../../storefront/data";
import { shopHome } from "../../storefront/urls";
import { moduleEnabled } from "../registry";
import { FEED_TAIL, buildFeed, feedHead, feedItemsXml, feedXml, type FeedTarget } from "./feed";
import { externalProductUrl } from "../../storefront/mode";

export const FEED_MODULE = "product_feed";
/** Cron で作り直す間隔 */
export const FEED_INTERVAL_MS = 60 * 60 * 1000;
/** product_feed_page の 1 ページの商品の数（関数の上限と同じ） */
const FEED_PAGE = 1000;
/** 1 回の処理で読むページの数（Workers の 1 回あたりの問い合わせの上限に合わせる） */
const PAGES_PER_RUN = { free: 3, paid: 10 } as const;
/** part の大きさの目安（これを超えたらその回はそこまで。メモリ 128MB に余裕を残す） */
const PART_BYTES = 8 * 1024 * 1024;

export const feedKey = (shopId: string) => `feeds/${shopId}/products.xml`;
const metaKey = (shopId: string) => `feeds/${shopId}/meta.json`;
const runKey = (shopId: string) => `feeds/${shopId}/run.json`;
const partKey = (shopId: string, run: string, n: number) => `feeds/${shopId}/runs/${run}/${n}.xml`;

export interface FeedMeta {
  generated_at: string;
  items: number;
  skipped: { no_image: number; no_price: number };
  /** 分けて作ったとき（0060）: 回の名前と part の数（0 番が頭） */
  run?: string;
  parts?: number;
}

/** 作りかけの回 */
interface FeedRun {
  run: string;
  started_at: string;
  /** 次に読む位置（最後に読んだ商品の id） */
  after: string | null;
  /** 置いた part の数（0 番が頭） */
  parts: number;
  items: number;
  skipped: { no_image: number; no_price: number };
}

export interface FeedBases {
  /** Banto の外から見た URL（PUBLIC_BASE_URL）。独自ドメインのショップでは使わない */
  publicBaseUrl: string | undefined;
  mediaBaseUrl: string | undefined;
}

async function readJson<T>(storage: StorageAdapter, key: string): Promise<T | null> {
  const obj = await storage.get(key);
  if (!obj) return null;
  try {
    return (await new Response(obj.body).json()) as T;
  } catch {
    return null;
  }
}

const putText = (storage: StorageAdapter, key: string, text: string, type: string) => storage.put(key, new TextEncoder().encode(text).buffer as ArrayBuffer, type);

export function readFeedMeta(storage: StorageAdapter, shopId: string): Promise<FeedMeta | null> {
  return readJson<FeedMeta>(storage, metaKey(shopId));
}

/** URL の起点。分からなければ null（PUBLIC_BASE_URL が要る） */
function feedTarget(shop: PublicShop, bases: FeedBases): FeedTarget | null {
  const base = bases.publicBaseUrl?.replace(/\/+$/, "");
  if (!base && !shop.domain) return null;
  const media = (bases.mediaBaseUrl || (base ? `${base}/media` : "")).replace(/\/+$/, "");
  if (!media) return null;
  return { shopName: shop.name, home: shopHome(base ?? "", shop), mediaBaseUrl: media, productLink: (slug: string) => externalProductUrl(shop.settings, slug) };
}

/**
 * フィードを作る（0060 以降は 1 回の処理の分だけ進める）。作り終えたら meta を、続きがあれば "in_progress" を、
 * URL の起点が分からなければ null を返す。pages は 1 回に読むページの数（省略時は workers_plan で決める）
 */
export async function generateFeed(sf: StorefrontData, storage: StorageAdapter, shop: PublicShop, bases: FeedBases, now = new Date(), pages?: number): Promise<FeedMeta | "in_progress" | null> {
  const target = feedTarget(shop, bases);
  if (!target) return null;
  if (!(await sf.migratedTo(CATALOG_PAGES_MIGRATION))) {
    const result = buildFeed(await sf.feedCatalog(shop), target);
    await putText(storage, feedKey(shop.id), feedXml(result, target), "application/xml; charset=utf-8");
    const meta: FeedMeta = { generated_at: now.toISOString(), items: result.items.length, skipped: result.skipped };
    await putText(storage, metaKey(shop.id), JSON.stringify(meta), "application/json");
    return meta;
  }
  let run = await readJson<FeedRun>(storage, runKey(shop.id));
  if (!run) {
    run = { run: now.getTime().toString(36), started_at: now.toISOString(), after: null, parts: 1, items: 0, skipped: { no_image: 0, no_price: 0 } };
    await putText(storage, partKey(shop.id, run.run, 0), feedHead(target), "application/xml; charset=utf-8");
  }
  const [categories, plan] = await Promise.all([sf.listCategories(shop), pages === undefined ? sf.sitePlan() : Promise.resolve("free" as const)]);
  const budget = pages ?? PAGES_PER_RUN[plan];
  let xml = "";
  let done = false;
  for (let i = 0; i < budget && xml.length < PART_BYTES; i++) {
    const page = await sf.feedPage(shop, run.after, FEED_PAGE);
    const result = buildFeed({ ...page, categories }, target);
    xml += feedItemsXml(result);
    run.items += result.items.length;
    run.skipped.no_image += result.skipped.no_image;
    run.skipped.no_price += result.skipped.no_price;
    const last = page.products[page.products.length - 1];
    if (last) run.after = last.id;
    if (page.products.length < FEED_PAGE) {
      done = true;
      break;
    }
  }
  if (xml) {
    await putText(storage, partKey(shop.id, run.run, run.parts), xml, "application/xml; charset=utf-8");
    run.parts++;
  }
  if (!done) {
    await putText(storage, runKey(shop.id), JSON.stringify(run), "application/json");
    return "in_progress";
  }
  const previous = await readFeedMeta(storage, shop.id);
  const meta: FeedMeta = { generated_at: now.toISOString(), items: run.items, skipped: run.skipped, run: run.run, parts: run.parts };
  await putText(storage, metaKey(shop.id), JSON.stringify(meta), "application/json");
  await storage.delete(runKey(shop.id));
  // 前の回の part を消す（配信は meta の回だけを読むので、消す途中でも壊れない）
  if (previous?.run && previous.run !== run.run) for (let n = 0; n < (previous.parts ?? 0); n++) await storage.delete(partKey(shop.id, previous.run, n));
  if (!previous?.run) await storage.delete(feedKey(shop.id));
  return meta;
}

/** 配信: 分けて作ったものは頭・part・尻をつないで流す。0060 より前のものは 1 つのファイル。まだ無ければ null */
export async function readFeed(storage: StorageAdapter, shopId: string): Promise<ReadableStream | null> {
  const meta = await readFeedMeta(storage, shopId);
  if (!meta?.run || !meta.parts) return (await storage.get(feedKey(shopId)))?.body ?? null;
  const { run, parts } = meta;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  void (async () => {
    for (let n = 0; n < parts; n++) {
      const obj = await storage.get(partKey(shopId, run, n));
      if (!obj) continue;
      const reader = obj.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer));
      }
    }
    await writer.write(new TextEncoder().encode(FEED_TAIL));
    await writer.close();
  })().catch((e: unknown) => writer.abort(e));
  return readable;
}

/** jobs/index.ts から登録する。モジュールが ON の公開中のショップだけ、1 時間ごとに作り直す（作りかけの回があれば続き） */
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
      const running = (await adapters.storage.get(runKey(shop.id))) !== null;
      const meta = running ? null : await readFeedMeta(adapters.storage, shop.id);
      if (meta && Date.now() - Date.parse(meta.generated_at) < FEED_INTERVAL_MS - 60_000) continue;
      // 1 店の失敗で他の店とハートビートを止めない
      await generateFeed(sf, adapters.storage, shop, bases).catch((e: unknown) => console.error(`[banto] product feed ${shop.slug}:`, e));
    }
  });
}
