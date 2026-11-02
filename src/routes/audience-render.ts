/**
 * お店の画面・ヘッドレスの公開 API で本文の見せる相手の囲みを外すための材料（0097、src/content/audience-blocks.ts）。
 * 条件の一覧は service_role の shop_audiences_render で引き、isolate のキャッシュに短く覚える（本文に囲みがあるときだけ引く）。
 * 引けなければ空（どの囲みも見せない）
 */
import type { Ctx } from "./common";
import { audiencesReady } from "./common";
import { privilegedFor } from "./payment-deps";
import { moduleEnabled } from "../modules/registry";
import { AUDIENCES_MODULE, type AudienceContext } from "../members/audience";
import { audienceShow, filterAudienceBlocks, hasAudienceBlocks, type RenderAudience } from "../content/audience-blocks";

/** 覚えておく秒数（管理画面で直した条件が効くまでの長さ） */
export const AUDIENCES_CACHE_TTL = 60;
export const audiencesCacheKey = (shopId: string) => `audiences:${shopId}`;

export async function shopAudiences(c: Ctx, shop: { id: string; settings?: Record<string, unknown> | null }): Promise<RenderAudience[]> {
  if (!moduleEnabled(shop.settings ?? {}, AUDIENCES_MODULE)) return [];
  if (!(await audiencesReady(c))) return [];
  const cache = c.get("adapters").cache;
  const key = audiencesCacheKey(shop.id);
  const hit = await cache.get<RenderAudience[]>(key);
  if (hit) return hit;
  const db = privilegedFor(c);
  if (!db) return [];
  try {
    const list = await db.shopAudiencesRender(shop.id);
    await cache.set(key, list, AUDIENCES_CACHE_TTL);
    return list;
  } catch (e) {
    console.error("[banto] audiences:", e instanceof Error ? e.message : e);
    return [];
  }
}

/** 見る人に合わせて本文の囲みを外す（囲みが無ければ何も引かない）。key は HTML のキャッシュの区分け */
export async function viewerBody(c: Ctx, shop: { id: string; settings?: Record<string, unknown> | null }, body: string, viewer: AudienceContext): Promise<{ body: string; key: string }> {
  if (!hasAudienceBlocks(body)) return { body, key: "" };
  const list = await shopAudiences(c, shop);
  return filterAudienceBlocks(body, audienceShow(list, viewer));
}
