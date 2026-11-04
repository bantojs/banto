/**
 * 同梱モジュール「お店の行動を連携に渡す」（event_relay、既定 OFF。0107_mod_event_relay、メンテナの決定 2026-11-04、docs/event-relay.md）。
 *
 * - Banto は出来事を溜めない。お店の画面（とヘッドレス）から届いた出来事を、運営者が許した外部プラグインへ渡すだけ。
 *   溜めて条件を判定するのはプラグイン（knowledge は banto-internal の 32 §10）
 * - 送る道は Banto を経由する道: ブラウザ → Banto（同じドメインの /_x、ヘッドレスは POST /api/shops/{shop}/events）→ プラグイン。
 *   プラグインへの署名は hooks と同じ（X-Banto-Signature。つないだ連携は接続ごとのシークレット）
 * - 経由の道は DB に触らない: 会員は Cookie・会員トークンの署名だけで確かめ、送り先はしばらく覚える。受けたらすぐ応答し、
 *   送るのは応答の後（afterResponse）。プラグインが落ちていたら捨てる（再送のために溜めない）
 * - 段階 4a は会員の出来事だけ（ゲストの訪問者 ID は段階 4b）
 * - 「何を見たか」はブラウザの申告なので本人なら偽れる（会員 ID は偽れない）。アプローチは偽っても困らない範囲にする（プラグインの責任）
 */
import type { CacheAdapter } from "../../adapters/types";
import type { PrivilegedDb } from "../../db/privileged";
import { blockedHookTarget } from "../../hooks/target";
import { connectionSecretPurpose, endpointSecret, signHookPayload } from "../../hooks/signing";
import { openSecret } from "../../members/secret-box";
import type { PublicShop } from "../../storefront/data";
import type { ShopEvent } from "../../storefront/events";
import type { HeadTag, StorefrontHeadContributor } from "../../storefront/head";

export const EVENT_RELAY_MODULE = "event_relay";
export const EVENT_RELAY_MIGRATION = "0107_mod_event_relay";
/** お店の画面のスクリプトが送る先（ショップのパスの下。/collect・/track のような知られた形にしない） */
export const RELAY_PATH = "/_x";
/** 1 回のまとまりの上限 */
export const RELAY_MAX_BYTES = 16 * 1024;
export const RELAY_MAX_EVENTS = 50;
/** 同じ IP から 1 分に受けるまとまりの数（RateLimitAdapter） */
export const RELAY_PER_MINUTE = 120;
/** 送り先を覚える秒数（許しを変えてから効くまで最大この秒数） */
export const RELAY_TARGETS_TTL = 60;
const FORWARD_TIMEOUT_MS = 5000;

export const RELAY_EVENT_TYPES = ["product_view", "article_view", "page_view", "cart_add", "cart_view", "checkout_start", "purchase"] as const;
export type RelayEventType = (typeof RELAY_EVENT_TYPES)[number];

/** プラグインへ渡す出来事の形（個人情報は入らない。ID・数・金額・記事の著者の欄の文字だけ） */
export interface RelayEvent {
  type: RelayEventType;
  at: string;
  product_id?: string;
  category_id?: string;
  tags?: string[];
  sku?: string;
  quantity?: number;
  value_jpy?: number;
  order_number?: number;
  article_id?: string;
  blog?: string;
  handle?: string;
  author?: string;
  page_id?: string;
}

export interface RelayGrant {
  types: string[];
  visitors: "members" | "all";
}
export interface RelayTarget {
  endpoint_id: string;
  url: string;
  secret_box: string | null;
  grant: RelayGrant;
}

// ---------- 形を確かめる ----------
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined);
const id = (v: unknown): string | undefined => (typeof v === "string" && ID_RE.test(v) ? v : undefined);
const int = (v: unknown, max: number): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined);
const tagList = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 40).slice(0, 20);
  return out.length > 0 ? out : undefined;
};

/** 時刻は 1 日以内のずれまで受け、外れていれば受けた時刻にする（端末の時計が狂っていても並びが壊れない） */
function atOf(v: unknown, now: number): string {
  const t = typeof v === "string" && v.length <= 40 ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) && Math.abs(t - now) <= 86_400_000 ? new Date(t).toISOString() : new Date(now).toISOString();
}

/** 1 つの出来事を決まった形に組み直す（知らない種類・形の違うものは捨てる。知らない鍵は落とす） */
export function normalizeRelayEvent(raw: unknown, now = Date.now()): RelayEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const type = r["type"];
  if (typeof type !== "string" || !(RELAY_EVENT_TYPES as readonly string[]).includes(type)) return null;
  const e: RelayEvent = { type: type as RelayEventType, at: atOf(r["at"], now) };
  const set = <K extends keyof RelayEvent>(k: K, v: RelayEvent[K] | undefined) => {
    if (v !== undefined) e[k] = v;
  };
  set("product_id", id(r["product_id"]));
  set("category_id", id(r["category_id"]));
  set("tags", tagList(r["tags"]));
  set("sku", str(r["sku"], 64));
  set("quantity", int(r["quantity"], 999));
  set("value_jpy", int(r["value_jpy"], 100_000_000));
  set("order_number", int(r["order_number"], 1_000_000_000));
  set("article_id", id(r["article_id"]));
  set("blog", str(r["blog"], 100));
  set("handle", str(r["handle"], 100));
  set("author", str(r["author"], 100));
  set("page_id", id(r["page_id"]));
  return e;
}

/** 届いたまとまり（{ events: [...] }）を読む。大きすぎる・JSON でない・events が無ければ null */
export function parseRelayBody(text: string, now = Date.now()): RelayEvent[] | null {
  if (new TextEncoder().encode(text).byteLength > RELAY_MAX_BYTES) return null;
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const list = j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>)["events"] : null;
  if (!Array.isArray(list) || list.length > RELAY_MAX_EVENTS) return null;
  return list.map((x) => normalizeRelayEvent(x, now)).filter((x): x is RelayEvent => x !== null);
}

/** お店の画面で積んだ出来事（src/storefront/events.ts）を、スクリプトに渡す形にする（時刻はブラウザが付ける） */
export function relayEventsFromPage(events: readonly ShopEvent[]): Omit<RelayEvent, "at">[] {
  return events.flatMap((e): Omit<RelayEvent, "at">[] => {
    switch (e.type) {
      case "product_view":
        return e.product ? [{ type: e.type, product_id: e.product.id, ...(e.product.category_id ? { category_id: e.product.category_id } : {}), ...(e.product.tags?.length ? { tags: e.product.tags } : {}) }] : [];
      case "article_view":
        return e.article ? [{ type: e.type, article_id: e.article.id, blog: e.article.blog, handle: e.article.handle, ...(e.article.author ? { author: e.article.author } : {}), ...(e.article.tags?.length ? { tags: e.article.tags } : {}) }] : [];
      case "page_view":
        return e.page ? [{ type: e.type, page_id: e.page.id, handle: e.page.handle }] : [];
      case "cart_add":
        return e.items.map((i) => ({ type: e.type, sku: i.sku, ...(i.quantity ? { quantity: i.quantity } : {}) }));
      case "purchase":
        return [{ type: e.type, value_jpy: e.value_jpy, ...(e.order_number !== undefined ? { order_number: e.order_number } : {}) }];
      default:
        return [{ type: e.type, value_jpy: e.value_jpy }];
    }
  });
}

// ---------- 送り先 ----------
/** 送り先（許しのある有効な連携）。しばらく覚える（リクエストのたびに DB に問い合わせない） */
export async function relayTargets(deps: { db: PrivilegedDb; cache: CacheAdapter }, shopId: string): Promise<RelayTarget[]> {
  const key = `relay:targets:${shopId}`;
  const hit = await deps.cache.get<RelayTarget[]>(key);
  if (hit) return hit;
  const list = (await deps.db.eventRelayTargets(shopId)).filter((t) => t.grant && Array.isArray(t.grant.types) && t.grant.types.length > 0);
  await deps.cache.set(key, list, RELAY_TARGETS_TTL);
  return list;
}

export function forgetRelayTargets(cache: CacheAdapter, shopId: string): Promise<void> {
  return cache.delete(`relay:targets:${shopId}`);
}

/**
 * 許された出来事だけを、許された連携へ署名して送る。失敗は捨てる（溜めない）。返すのは送った数（テスト・記録用）。
 * customerId が無い（ゲスト）ものは段階 4a では送らない
 */
export async function forwardRelay(opts: {
  targets: readonly RelayTarget[];
  shopId: string;
  customerId: string | null;
  source: "storefront" | "headless";
  events: readonly RelayEvent[];
  sessionSecret: string;
  fetch: typeof fetch;
}): Promise<number> {
  if (!opts.customerId || opts.events.length === 0) return 0;
  let sent = 0;
  await Promise.all(
    opts.targets.map(async (t) => {
      const events = opts.events.filter((e) => t.grant.types.includes(e.type));
      if (events.length === 0 || blockedHookTarget(t.url)) return;
      const secret = t.secret_box ? await openSecret(opts.sessionSecret, opts.shopId, connectionSecretPurpose(t.endpoint_id), t.secret_box) : await endpointSecret(opts.sessionSecret, t.endpoint_id);
      if (!secret) return;
      const id = crypto.randomUUID();
      const body = JSON.stringify({
        id,
        event: "storefront.events",
        created_at: new Date().toISOString(),
        shop_id: opts.shopId,
        attempt: 1,
        data: { customer_id: opts.customerId, visitor: null, source: opts.source, events },
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
      try {
        const res = await opts.fetch(t.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": "banto-hooks", "X-Banto-Event": "storefront.events", "X-Banto-Delivery": id, "X-Banto-Signature": await signHookPayload(secret, body) },
          body,
          signal: controller.signal,
          redirect: "manual",
        });
        if (res.status >= 200 && res.status < 300) sent++;
      } catch {
        // 落ちていたら捨てる（閲覧の数だけ溜めることになるため、再送しない）
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return sent;
}

// ---------- お店の画面のスクリプト ----------
/** <script> の中に置く JSON（</script> や <!-- で抜けさせない） */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/**
 * ページの出来事をブラウザで溜め（sessionStorage）、20 件ごと・30 秒ごと・ページを離れるときにまとめて送る。
 * 送り方は sendBeacon（text/plain。プリフライトが起きない）、使えなければ fetch の keepalive
 */
export function relayScript(url: string, events: readonly Omit<RelayEvent, "at">[]): string {
  return `(function(){var U=${scriptJson(url)},K="banto_rq",q=[];try{q=JSON.parse(sessionStorage.getItem(K)||"[]")||[]}catch(e){}function sv(){try{sessionStorage.setItem(K,JSON.stringify(q))}catch(e){}}function fl(){while(q.length){var b=q.splice(0,20);sv();var d=JSON.stringify({events:b});var ok=false;try{ok=navigator.sendBeacon&&navigator.sendBeacon(U,new Blob([d],{type:"text/plain"}))}catch(e){}if(!ok){try{fetch(U,{method:"POST",body:d,keepalive:true,credentials:"same-origin",headers:{"Content-Type":"text/plain"}})}catch(e){}}}}var n=new Date().toISOString(),ev=${scriptJson(events)};for(var i=0;i<ev.length;i++){ev[i].at=n;q.push(ev[i])}if(q.length>200)q=q.slice(-200);sv();if(q.length>=20)fl();setInterval(fl,30000);document.addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden")fl()});addEventListener("pagehide",fl)})();`;
}

export const eventRelayHead: StorefrontHeadContributor = {
  module: EVENT_RELAY_MODULE,
  tags(_shop: PublicShop, events, extra): HeadTag[] {
    // 段階 4a は会員だけ（ゲストのページにはスクリプトも載せない）
    if (!extra?.member) return [];
    return [{ kind: "inline-script", code: relayScript(`${extra.base}${RELAY_PATH}`, relayEventsFromPage(events)) }];
  },
};
