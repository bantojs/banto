/**
 * お店の画面・ヘッドレスの公開 API で本文の見せる相手の囲みを外すための材料（0097、src/content/audience-blocks.ts）。
 * 条件の一覧は service_role の shop_audiences_render で引き、isolate のキャッシュに短く覚える（本文に囲みがあるときだけ引く）。
 * 引けなければ空（どの囲みも見せない）
 */
import type { Ctx } from "./common";
import { audiencesReady, isSecureRequest } from "./common";
import { readCookie } from "../util/signed";
import { privilegedFor } from "./payment-deps";
import { moduleEnabled } from "../modules/registry";
import { AUDIENCES_MODULE, queryParamsOf, rememberedParams, type AudienceContext } from "../members/audience";
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

/** 同じ訪問のあいだ覚える URL のパラメータの Cookie（remember の条件のものだけ。値はだれでも付けられる URL の値なので署名しない） */
export const audienceParamCookieName = (shopId: string) => `banto_ap_${shopId.replace(/[^a-zA-Z0-9]/g, "")}`;
/** 覚えておく秒数（最後にお店の画面を開いてから。開くたびに延ばす） */
export const AUDIENCE_PARAM_SECONDS = 1800;

function rememberedOf(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(decodeURIComponent(raw)) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v).slice(0, 10)) if (/^[a-z0-9_]{1,40}$/.test(k) && typeof x === "string" && x.trim()) out[k] = x.trim().slice(0, 200);
    return out;
  } catch {
    return {};
  }
}

/**
 * お店の画面の見る人の URL の材料（同梱モジュール audiences が OFF なら何もしない・DB に問い合わせない）。
 * クエリに remember の条件のパラメータがあれば Cookie に覚え、覚えた値があれば期限を延ばす
 */
export async function storefrontQueryContext(c: Ctx, shop: { id: string; settings?: Record<string, unknown> | null }, cookiePath: string): Promise<Pick<AudienceContext, "params" | "remembered">> {
  if (!moduleEnabled(shop.settings ?? {}, AUDIENCES_MODULE)) return {};
  const params = queryParamsOf(new URL(c.req.url).searchParams.entries());
  const name = audienceParamCookieName(shop.id);
  const before = rememberedOf(readCookie(c.req.header("cookie"), name));
  let remembered = before;
  if (Object.keys(params).length > 0) {
    const names = rememberedParams((await shopAudiences(c, shop)).map((a) => a.condition));
    for (const n of names) {
      const v = params[n]?.find((x) => x.trim() !== "")?.trim();
      if (v) remembered = { ...remembered, [n]: v.slice(0, 200) };
    }
  }
  const keep = Object.fromEntries(Object.entries(remembered).slice(-10));
  if (Object.keys(keep).length > 0) {
    c.header("Set-Cookie", `${name}=${encodeURIComponent(JSON.stringify(keep))}; Path=${cookiePath}; Max-Age=${AUDIENCE_PARAM_SECONDS}; SameSite=Lax; HttpOnly${isSecureRequest(c) ? "; Secure" : ""}`, { append: true });
  }
  return { params, remembered: keep };
}
