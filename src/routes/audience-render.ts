/**
 * お店の画面・ヘッドレスの公開 API で本文の見せる相手の囲みを外すための材料（0097、src/content/audience-blocks.ts）。
 * 条件の一覧は service_role の shop_audiences_render で引き、isolate のキャッシュに短く覚える（本文に囲みがあるときだけ引く）。
 * 引けなければ空（どの囲みも見せない）
 */
import type { Ctx } from "./common";
import { isSecureRequest } from "./common";
import { readCookie } from "../util/signed";
import { privilegedFor } from "./payment-deps";
import { moduleEnabled } from "../modules/registry";
import { AUDIENCES_MODULE, queryParamsOf, rememberedParams, type AudienceContext } from "../members/audience";
import { audienceShow, filterAudienceBlocks, hasAudienceBlocks, type RenderAudience } from "../content/audience-blocks";
import type { MemberReader, PublicShop, StorefrontData } from "../storefront/data";
import { memberFromRequest } from "./api/members";
import { withIncludes } from "../content/include";

/** 覚えておく秒数（管理画面で直した条件が効くまでの長さ） */
export const AUDIENCES_CACHE_TTL = 60;
export const audiencesCacheKey = (shopId: string) => `audiences:${shopId}`;

export async function shopAudiences(c: Ctx, shop: { id: string; settings?: Record<string, unknown> | null }): Promise<RenderAudience[]> {
  if (!moduleEnabled(shop.settings ?? {}, AUDIENCES_MODULE)) return [];
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

/**
 * 見る人に合わせた本文: 部品を差し込み（`::: include`、0122）、見せる相手の囲みを外す（どちらも無ければ何も引かない）。
 * key は HTML のキャッシュの区分け（差し込んだ部品と、外した囲みの組み合わせ）
 */
export async function viewerBody(c: Ctx, sf: StorefrontData, shop: PublicShop, body: string, viewer: AudienceContext): Promise<{ body: string; key: string }> {
  const inc = await withIncludes(sf, shop, body);
  if (!hasAudienceBlocks(inc.body)) return inc;
  const list = await shopAudiences(c, shop);
  const out = filterAudienceBlocks(inc.body, audienceShow(list, viewer));
  return { body: out.body, key: inc.key ? `${inc.key}|${out.key}` : out.key };
}

/** プレビュー: 部品を差し込み、見せる相手の囲みは中身ごと見せる */
export async function previewBody(sf: StorefrontData, shop: PublicShop, body: string): Promise<{ body: string; key: string }> {
  const inc = await withIncludes(sf, shop, body);
  return { body: filterAudienceBlocks(inc.body, () => true).body, key: inc.key };
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

/** 会員の読み取りの経路（0098 の product_member_*。service_role の鍵が無ければ null = ゲストと同じ） */
export function memberReader(c: Ctx, shopId: string, member: { cid: string; ep: number; sid: string }): MemberReader | null {
  const db = privilegedFor(c);
  if (!db) return null;
  const who = { p_shop_id: shopId, p_customer_id: member.cid, p_epoch: member.ep, p_session_id: member.sid };
  return {
    member,
    list: (args) => db.productMemberList({ ...args, ...who }),
    pick: (slugs) => db.productMemberPick({ ...who, p_slugs: slugs }),
    get: (slug) => db.productMemberGet({ ...who, p_slug: slug }),
    skus: (skuIds) => db.productMemberSkus({ ...who, p_sku_ids: skuIds }),
    page: (handle) => db.contentMemberRpc("page_member_get", { ...who, p_handle: handle }),
    article: (blogId, handle) => db.contentMemberRpc("article_member_get", { ...who, p_blog_id: blogId, p_handle: handle }),
    // p_sort は 0116 から（sort があるのは 0116 の DB だけ。articleSortFor）
    // p_fields は 0117 から（fields があるのは 0117 の DB だけ。src/blog/fields.ts）
    // 日付の項目の順（0124）は p_sort = field:<key>・p_field_from（日付の項目は 0124 の DB にしか無いので、渡すのは当たっている DB だけ）
    articles: (blogId, offset, limit, tag, sort, fields, fieldSort) =>
      db.contentMemberRpc("articles_member_page", { ...who, p_blog_id: blogId, p_offset: offset, p_limit: limit, p_tag: tag, ...(fieldSort ? { p_sort: `field:${fieldSort.key}`, ...(fieldSort.from ? { p_field_from: fieldSort.from } : {}) } : sort ? { p_sort: sort } : {}), ...(fields ? { p_fields: fields } : {}) }),
  };
}

/**
 * ヘッドレスの公開 API: 会員トークン（Authorization: Bearer bm1.…）の会員なら会員の読み取りの経路で読む（0098）。
 * 同梱モジュール audiences が OFF のショップは今までどおり（トークンを見ない）。壊れたトークンは 401
 */
export async function apiViewerData(c: Ctx, sf: StorefrontData, shop: PublicShop): Promise<StorefrontData | Response> {
  if (!moduleEnabled(shop.settings ?? {}, AUDIENCES_MODULE)) return sf;
  const m = await memberFromRequest(c, shop);
  if (!m.ok) return c.json({ error: "invalid_member_token" }, 401);
  return withApiMember(c, sf, shop, m.member);
}

/** 確かめ済みの会員トークンの会員で読む（commerce の scope が使う） */
export function withApiMember(c: Ctx, sf: StorefrontData, shop: PublicShop, member: { id: string; epoch: number; sid?: string } | null): StorefrontData {
  if (!member?.sid || !moduleEnabled(shop.settings ?? {}, AUDIENCES_MODULE)) return sf;
  const r = memberReader(c, shop.id, { cid: member.id, ep: member.epoch, sid: member.sid });
  return r ? sf.withMember(r) : sf;
}
