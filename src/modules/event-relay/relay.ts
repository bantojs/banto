/**
 * 同梱モジュール「お店の行動を連携に渡す」（event_relay、既定 OFF。0107_mod_event_relay、メンテナの決定 2026-11-04、docs/event-relay.md）。
 *
 * - Banto は出来事を溜めない。お店の画面（とヘッドレス）から届いた出来事を、運営者が許した外部プラグインへ渡すだけ。
 *   溜めて条件を判定するのはプラグイン（knowledge は banto-internal の 32 §10）
 * - 送る道は Banto を経由する道: ブラウザ → Banto（同じドメインの /_x、ヘッドレスは POST /api/shops/{shop}/events）→ プラグイン。
 *   プラグインへの署名は hooks と同じ（X-Banto-Signature。つないだ連携は接続ごとのシークレット）
 * - 経由の道は DB に触らない: 会員は Cookie・会員トークンの署名だけで確かめ、送り先はしばらく覚える。受けたらすぐ応答し、
 *   送るのは応答の後（afterResponse）。プラグインが落ちていたら捨てる（再送のために溜めない）
 * - 会員の出来事は会員 ID で、ゲストの出来事は訪問者 ID（ブラウザが作るランダムな ID、段階 4b・0108）で渡す。
 *   ゲストの分を渡すのは、運営者が「ゲストも」と許した連携だけ。ログインしたら visitor.identified で「この訪問者はこの会員」を渡す
 *   （会員を確かめた Cookie・会員トークンのあるまとまりだけ。それまでの行動をどこまで結ぶかはプラグインが決める。説明書は 30 分を勧める）
 * - 段階 4c（0109）: 決まった出来事に作り手の独自の情報（meta、平らな形・上限つき）、作り手の独自の出来事（x. で始まる名前）。
 *   Banto は中身を解釈せず、形と大きさだけを確かめて渡す。独自の出来事はプラグインがマニフェストの custom で求め、運営者が許したものだけ
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
/** ログインした会員と、それまでの訪問者 ID を結ぶ知らせ（0108）。許しの種類ではなく、ゲストも許した連携にだけ渡す */
export const VISITOR_IDENTIFIED = "visitor.identified";
/** 作り手の独自の出来事の名前（x. ＋ 英小文字・数字・_・.、60 字まで）。マニフェストの custom の "x.*" はすべて */
export const CUSTOM_EVENT_RE = /^x\.[a-z0-9_.]{1,58}$/;
export const CUSTOM_ALL = "x.*";
export type CustomEventType = `x.${string}`;
/** 独自の情報（meta）の値。平らな形だけ（入れ子のオブジェクトは受けない） */
export type MetaValue = string | number | boolean | string[];
const META_KEY_RE = /^[a-z0-9_]{1,40}$/;
const META_MAX_KEYS = 20;
const META_MAX_STR = 200;
const META_MAX_LIST = 20;
/** メールアドレスに見える値は捨てる（Banto は中身を解釈しないので確実ではない。説明書で「個人情報を入れない」と頼む） */
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
/** 訪問者 ID の形（ブラウザが作る。名前もメールアドレスも入らない） */
export const VISITOR_RE = /^v_[A-Za-z0-9_-]{16,64}$/;

/** プラグインへ渡す出来事の形（個人情報は入らない。ID・数・金額・記事の著者の欄の文字だけ） */
export interface RelayEvent {
  type: RelayEventType | typeof VISITOR_IDENTIFIED | CustomEventType;
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
  /** 作り手の独自の情報（0109）。Banto は解釈しない */
  meta?: Record<string, MetaValue>;
}

export interface RelayGrant {
  types: string[];
  /** 許した独自の出来事（0109）。"x.*" ならすべて */
  custom?: string[];
  visitors: "members" | "all";
}

/** この許しで、その出来事を渡してよいか（visitor.identified は呼ぶ側が決める） */
export function grantAllows(grant: RelayGrant, type: string): boolean {
  if (type.startsWith("x.")) return (grant.custom ?? []).some((c) => c === CUSTOM_ALL || c === type);
  return grant.types.includes(type);
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

const metaStr = (v: string): string | undefined => (v.length <= META_MAX_STR && !EMAIL_LIKE.test(v) ? v : undefined);

/** 独自の情報を平らな形に組み直す（鍵の形・数・値の種類と長さ。合わない鍵は落とす。何も残らなければ undefined） */
export function normalizeMeta(raw: unknown): Record<string, MetaValue> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, MetaValue> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= META_MAX_KEYS) break;
    if (!META_KEY_RE.test(k)) continue;
    let val: MetaValue | undefined;
    if (typeof v === "string") val = metaStr(v);
    else if (typeof v === "number") val = Number.isFinite(v) ? v : undefined;
    else if (typeof v === "boolean") val = v;
    else if (Array.isArray(v)) {
      const list = v.filter((x): x is string => typeof x === "string").map(metaStr).filter((x): x is string => x !== undefined).slice(0, META_MAX_LIST);
      val = list.length > 0 ? list : undefined;
    }
    if (val === undefined) continue;
    out[k] = val;
    n++;
  }
  return n > 0 ? out : undefined;
}

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
  if (type === VISITOR_IDENTIFIED) return { type, at: atOf(r["at"], now) };
  if (typeof type === "string" && CUSTOM_EVENT_RE.test(type)) {
    const meta = normalizeMeta(r["meta"]);
    return { type: type as CustomEventType, at: atOf(r["at"], now), ...(meta ? { meta } : {}) };
  }
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
  set("meta", normalizeMeta(r["meta"]));
  return e;
}

/** 届いたまとまり（{ visitor?, events: [...] }）を読む。大きすぎる・JSON でない・events が無ければ null。形の違う visitor は無いものにする */
export function parseRelayBody(text: string, now = Date.now()): { visitor: string | null; events: RelayEvent[] } | null {
  if (new TextEncoder().encode(text).byteLength > RELAY_MAX_BYTES) return null;
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const o = j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  const list = o ? o["events"] : null;
  if (!Array.isArray(list) || list.length > RELAY_MAX_EVENTS) return null;
  const v = o?.["visitor"];
  return { visitor: typeof v === "string" && VISITOR_RE.test(v) ? v : null, events: list.map((x) => normalizeRelayEvent(x, now)).filter((x): x is RelayEvent => x !== null) };
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
 * - 会員（customerId）の出来事はどの連携にも。訪問者 ID を付けるのは「ゲストも」と許した連携にだけ
 * - ゲスト（customerId が無い）の出来事は、「ゲストも」と許した連携にだけ、訪問者 ID があるときだけ
 * - visitor.identified は会員を確かめたまとまりで、訪問者 ID があり、「ゲストも」と許した連携にだけ
 */
export async function forwardRelay(opts: {
  targets: readonly RelayTarget[];
  shopId: string;
  customerId: string | null;
  visitor: string | null;
  source: "storefront" | "headless";
  events: readonly RelayEvent[];
  sessionSecret: string;
  fetch: typeof fetch;
}): Promise<number> {
  const visitor = opts.visitor && VISITOR_RE.test(opts.visitor) ? opts.visitor : null;
  if ((!opts.customerId && !visitor) || opts.events.length === 0) return 0;
  let sent = 0;
  await Promise.all(
    opts.targets.map(async (t) => {
      const guests = t.grant.visitors === "all";
      if (!opts.customerId && !guests) return;
      const events = opts.events.filter((e) => (e.type === VISITOR_IDENTIFIED ? Boolean(opts.customerId && visitor && guests) : grantAllows(t.grant, e.type)));
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
        data: { customer_id: opts.customerId, visitor: guests ? visitor : null, source: opts.source, events },
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
 * 送り方は sendBeacon（text/plain。プリフライトが起きない）、使えなければ fetch の keepalive。
 * visitors（ゲストも渡す連携があるショップ、0108）のときは訪問者 ID を localStorage に置いて一緒に送る:
 *   - 無ければ作る（ランダム、名前もメールアドレスも入らない）
 *   - 会員からゲストに変わった（ログアウトした）ら作り直す。共用の端末で、次の人の行動を前の会員に結ばない
 *   - ゲストから会員に変わった（ログインした）ら visitor.identified を積む（Banto は Cookie の会員だけを結ぶ）
 *   - 変わったときは、前の状態で積んだまだ送っていない出来事を捨てる（別の人の行動として送らない）
 *   - 貼れるタグから Banto のレジへ移ってきたとき（URL の banto_v）、まだ訪問者 ID が無ければそれを使う（0109。外のサイトの続き）
 * visitors でないショップでは訪問者 ID を作らず、前に作ったものも消す。
 * テーマの作り手には window.banto.track(type, { ...項目, meta }) を出す（0109。x. の独自の出来事・決まった出来事に meta）
 */
export function relayScript(url: string, events: readonly Omit<RelayEvent, "at">[], opts: { member: boolean; visitors: boolean } = { member: true, visitors: false }): string {
  const visitor = opts.visitors
    ? `var V="banto_v",st=null;try{st=JSON.parse(localStorage.getItem(V)||"null")}catch(e){}var M=${opts.member ? "true" : "false"};function rid(){var a=new Uint8Array(16);crypto.getRandomValues(a);var h="v_";for(var i=0;i<a.length;i++)h+=(a[i]<16?"0":"")+a[i].toString(16);return h}if(!st){try{var P=new URLSearchParams(location.search).get("banto_v");if(P&&/^v_[A-Za-z0-9_-]{16,64}$/.test(P))st={id:P,m:false}}catch(e){}}if(!st||typeof st.id!=="string"||st.m!==M){var was=st&&typeof st.id==="string";if(!was||st.m){st={id:rid(),m:M}}else{st={id:st.id,m:M}}q=[];if(was&&M&&st.id)q.push({type:"visitor.identified",at:new Date().toISOString()})}try{localStorage.setItem(V,JSON.stringify(st))}catch(e){}var VI=st.id;`
    : `var VI=null;try{localStorage.removeItem("banto_v")}catch(e){}`;
  return `(function(){var U=${scriptJson(url)},K="banto_rq",q=[];try{q=JSON.parse(sessionStorage.getItem(K)||"[]")||[]}catch(e){}${visitor}function sv(){try{sessionStorage.setItem(K,JSON.stringify(q))}catch(e){}}function fl(){while(q.length){var b=q.splice(0,20);sv();var o={events:b};if(VI)o.visitor=VI;var d=JSON.stringify(o);var ok=false;try{ok=navigator.sendBeacon&&navigator.sendBeacon(U,new Blob([d],{type:"text/plain"}))}catch(e){}if(!ok){try{fetch(U,{method:"POST",body:d,keepalive:true,credentials:"same-origin",headers:{"Content-Type":"text/plain"}})}catch(e){}}}}var n=new Date().toISOString(),ev=${scriptJson(events)};for(var i=0;i<ev.length;i++){ev[i].at=n;q.push(ev[i])}if(q.length>200)q=q.slice(-200);sv();if(q.length>=20)fl();var B=window.banto=window.banto||{};B.track=function(t,d){if(typeof t!=="string")return;var e={},k;if(d&&typeof d==="object")for(k in d)e[k]=d[k];e.type=t;e.at=new Date().toISOString();q.push(e);if(q.length>200)q=q.slice(-200);sv();if(q.length>=20)fl()};setInterval(fl,30000);document.addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden")fl()});addEventListener("pagehide",fl)})();`;
}

export const eventRelayHead: StorefrontHeadContributor = {
  module: EVENT_RELAY_MODULE,
  tags(shop: PublicShop, events, extra): HeadTag[] {
    // ゲストのページには、ゲストも渡す連携があるショップ（0108 の relay_guests）だけスクリプトを載せる。範囲はサーバーで当てる
    const visitors = shop.relay_guests === true;
    if (!extra || (!extra.member && !visitors)) return [];
    return [{ kind: "inline-script", code: relayScript(`${extra.base}${RELAY_PATH}`, relayEventsFromPage(events), { member: extra.member, visitors }) }];
  },
};
