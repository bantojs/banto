/**
 * 外部プラグインのマニフェスト（docs/hooks.md）。登録 URL に GET して取得する。
 * 取得できなくても登録は可能（イベントは手動で選ぶ）。シークレット型の設定項目は受け付けない。
 */
import { readTextCapped } from "../util/read-capped";
import { isApiScope, type ApiScope } from "../api/tokens";
import { blockedHookTarget } from "./target";

export interface ManifestSetting {
  key: string;
  label: string;
  type: "text" | "boolean" | "select";
  options?: { value: string; label: string }[];
  required?: boolean;
  description?: string;
}

/** ブロックの設定の欄（0086）。数か決まった選択肢だけ（本文の 1 行に書ける値） */
export interface ManifestBlockField {
  key: string;
  label: string;
  type: "number" | "select";
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  default?: string;
}

/** プラグインが提案するブロック（0086、docs/app-data.md §6）。見た目は Banto かテーマが決める */
export interface ManifestBlock {
  id: string;
  label: string;
  kind: "reviews.v1" | "custom.v1";
  description?: string;
  fields: ManifestBlockField[];
}

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  /** 購読したいイベント */
  events: string[];
  settings: ManifestSetting[];
  /** 管理画面に iframe で埋め込む独自画面（任意） */
  admin_url?: string;
  /** 拡張データの名前の空間の候補（0084。決めるのは運営者で、登録の画面の初めの値に使うだけ） */
  app?: string;
  /** 提案するブロック（0086） */
  blocks?: ManifestBlock[];
  /** 「もっと見る」で押した人のブラウザが取りに行く公開 API（種類 → https の URL。0087） */
  more?: Record<string, string>;
  /** つなぐ（0088）: 運営者が許したあと、券を付けて移す先（https） */
  connect_url?: string;
  /** つなぐ（0088）: 求める AI 用トークンのスコープ（運営者が画面で絞れる） */
  scopes?: ApiScope[];
  /** できること（0092）。"images" = 商品画像の段を作って差し替える（ショップの設定「外部の変換プラグインに任せる」の相手） */
  capabilities?: string[];
  /** 欲しいお店の行動（0107、同梱モジュール event_relay）。求めるだけで、渡すかは運営者が連携の画面で許す */
  /** お店の行動（0107）。custom は作り手の独自の出来事の名前（x. で始まる、"x.*" ですべて。0109） */
  storefront_events?: { types: string[]; custom?: string[]; visitors: "members" | "all" };
}

/** お店の行動の種類（src/modules/event-relay/relay.ts の RELAY_EVENT_TYPES と同じ） */
export const MANIFEST_STOREFRONT_EVENTS = ["product_view", "article_view", "page_view", "cart_add", "cart_view", "checkout_start", "purchase"] as const;

/** マニフェストの capabilities に書いてよい値 */
export const MANIFEST_CAPABILITIES = ["images"] as const;

/** 「もっと見る」の URL（0087 の banto_app_more_url と同じ形） */
export const MORE_URL_RE = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?(\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$/;

/** ブロックの id（`::: app <プラグイン> <ブロック>` の 2 つ目） */
export const APP_BLOCK_ID_RE = /^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** ブロックの設定の鍵（本文の key=value。product と style は Banto が使う） */
export const APP_BLOCK_FIELD_RE = /^[a-z][a-z0-9_]{0,30}$/;
export const APP_BLOCK_RESERVED = new Set(["product", "style"]);
/** 選択肢の値（本文に引用なしで書ける形） */
export const APP_BLOCK_VALUE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function parseBlocks(raw: unknown): ManifestBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: ManifestBlock[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (out.length >= 10) break;
    if (!r || typeof r !== "object") continue;
    const b = r as Record<string, unknown>;
    if (typeof b["id"] !== "string" || !APP_BLOCK_ID_RE.test(b["id"]) || seen.has(b["id"])) continue;
    if (b["kind"] !== "reviews.v1" && b["kind"] !== "custom.v1") continue;
    const fields: ManifestBlockField[] = [];
    for (const fr of Array.isArray(b["fields"]) ? b["fields"] : []) {
      if (fields.length >= 8) break;
      if (!fr || typeof fr !== "object") continue;
      const f = fr as Record<string, unknown>;
      const key = f["key"];
      if (typeof key !== "string" || !APP_BLOCK_FIELD_RE.test(key) || APP_BLOCK_RESERVED.has(key) || fields.some((x) => x.key === key)) continue;
      const label = typeof f["label"] === "string" && f["label"].trim() ? f["label"].trim().slice(0, 100) : key;
      if (f["type"] === "number") {
        const min = Number.isInteger(f["min"]) ? (f["min"] as number) : 0;
        const max = Number.isInteger(f["max"]) ? (f["max"] as number) : 100;
        if (min > max || Math.abs(min) > 1_000_000 || Math.abs(max) > 1_000_000) continue;
        const def = Number.isInteger(f["default"]) && (f["default"] as number) >= min && (f["default"] as number) <= max ? String(f["default"]) : undefined;
        fields.push({ key, label, type: "number", min, max, ...(def ? { default: def } : {}) });
      } else if (f["type"] === "select" && Array.isArray(f["options"])) {
        const options = f["options"]
          .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === "object" && typeof (o as Record<string, unknown>)["value"] === "string" && APP_BLOCK_VALUE_RE.test(String((o as Record<string, unknown>)["value"])))
          .slice(0, 20)
          .map((o) => ({ value: String(o["value"]), label: typeof o["label"] === "string" && o["label"].trim() ? o["label"].trim().slice(0, 100) : String(o["value"]) }));
        if (options.length === 0) continue;
        const def = typeof f["default"] === "string" && options.some((o) => o.value === f["default"]) ? (f["default"] as string) : undefined;
        fields.push({ key, label, type: "select", options, ...(def ? { default: def } : {}) });
      }
    }
    seen.add(b["id"]);
    out.push({
      id: b["id"],
      label: typeof b["label"] === "string" && b["label"].trim() ? b["label"].trim().slice(0, 100) : b["id"],
      kind: b["kind"],
      ...(typeof b["description"] === "string" && b["description"].trim() ? { description: b["description"].trim().slice(0, 300) } : {}),
      fields,
    });
  }
  return out;
}

/** 拡張データの名前の空間（hook_endpoints.app_handle、0084 の CHECK と同じ） */
export const APP_HANDLE_RE = /^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function parseManifest(input: unknown): PluginManifest | null {
  if (!input || typeof input !== "object") return null;
  const m = input as Record<string, unknown>;
  if (typeof m["name"] !== "string" || !m["name"].trim()) return null;
  const events = Array.isArray(m["events"]) ? m["events"].filter((e): e is string => typeof e === "string" && /^[a-z_]+\.[a-z_]+$/.test(e)) : [];
  const settings: ManifestSetting[] = [];
  if (Array.isArray(m["settings"])) {
    for (const raw of m["settings"]) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as Record<string, unknown>;
      if (typeof s["key"] !== "string" || !KEY_RE.test(s["key"])) continue;
      const type = s["type"] === "boolean" || s["type"] === "select" ? s["type"] : "text";
      if (s["type"] === "secret" || s["type"] === "password") continue; // シークレットはプラグイン側で持つ
      const options = Array.isArray(s["options"])
        ? s["options"]
            .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === "object")
            .map((o) => ({ value: String(o["value"] ?? ""), label: String(o["label"] ?? o["value"] ?? "") }))
        : undefined;
      settings.push({
        key: s["key"],
        label: typeof s["label"] === "string" ? s["label"] : s["key"],
        type,
        ...(options ? { options } : {}),
        ...(s["required"] === true ? { required: true } : {}),
        ...(typeof s["description"] === "string" ? { description: s["description"] } : {}),
      });
      if (settings.length >= 30) break;
    }
  }
  const admin_url = typeof m["admin_url"] === "string" && /^https:\/\//.test(m["admin_url"]) ? m["admin_url"] : undefined;
  const app = typeof m["app"] === "string" && APP_HANDLE_RE.test(m["app"]) ? m["app"] : undefined;
  const blocks = parseBlocks(m["blocks"]);
  const connect_url = typeof m["connect_url"] === "string" && m["connect_url"].length <= 500 && MORE_URL_RE.test(m["connect_url"]) ? m["connect_url"] : undefined;
  const scopes = Array.isArray(m["scopes"]) ? [...new Set(m["scopes"].filter((x): x is ApiScope => typeof x === "string" && isApiScope(x)))] : [];
  const capabilities = Array.isArray(m["capabilities"]) ? [...new Set(m["capabilities"].filter((x): x is string => typeof x === "string" && (MANIFEST_CAPABILITIES as readonly string[]).includes(x)))] : [];
  const se = m["storefront_events"] && typeof m["storefront_events"] === "object" && !Array.isArray(m["storefront_events"]) ? (m["storefront_events"] as Record<string, unknown>) : null;
  const seTypes = se && Array.isArray(se["types"]) ? [...new Set(se["types"].filter((x): x is string => typeof x === "string" && (MANIFEST_STOREFRONT_EVENTS as readonly string[]).includes(x)))] : [];
  // 独自の出来事（0109）: x. ＋ 英小文字・数字・_・.、60 字まで（src/modules/event-relay/relay.ts の CUSTOM_EVENT_RE と同じ）。50 個まで
  const seCustom = se && Array.isArray(se["custom"]) ? [...new Set(se["custom"].filter((x): x is string => typeof x === "string" && (x === "x.*" || /^x\.[a-z0-9_.]{1,58}$/.test(x))))].slice(0, 50) : [];
  const more: Record<string, string> = {};
  if (m["more"] && typeof m["more"] === "object" && !Array.isArray(m["more"])) {
    const v = (m["more"] as Record<string, unknown>)["reviews.v1"];
    if (typeof v === "string" && v.length <= 500 && MORE_URL_RE.test(v)) more["reviews.v1"] = v;
  }
  return {
    name: m["name"].trim().slice(0, 200),
    ...(typeof m["version"] === "string" ? { version: m["version"].slice(0, 50) } : {}),
    ...(typeof m["description"] === "string" ? { description: m["description"].slice(0, 1000) } : {}),
    events,
    settings,
    ...(admin_url ? { admin_url } : {}),
    ...(app ? { app } : {}),
    ...(blocks.length > 0 ? { blocks } : {}),
    ...(Object.keys(more).length > 0 ? { more } : {}),
    ...(connect_url ? { connect_url } : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(seTypes.length > 0 || seCustom.length > 0 ? { storefront_events: { types: seTypes, ...(seCustom.length > 0 ? { custom: seCustom } : {}), visitors: se?.["visitors"] === "all" ? ("all" as const) : ("members" as const) } } : {}),
  };
}

export async function fetchManifest(url: string, doFetch: typeof fetch, timeoutMs = 8000): Promise<PluginManifest | null> {
  // 私設のアドレス・社内の名前には取りに行かない（登録の検査と同じ。Node は doFetch に publicFetch を渡し、引いた先も確かめる）
  if (blockedHookTarget(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // リダイレクトは追わない（登録時に確かめた行き先以外へ出ない）。本文は 64KB まで
    const res = await doFetch(url, { headers: { Accept: "application/json", "User-Agent": "banto-hooks" }, signal: controller.signal, redirect: "manual" });
    if (!res.ok) return null;
    return parseManifest(JSON.parse(await readTextCapped(res, 64 * 1024)));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** マニフェストの宣言に沿ってフォーム値を settings に正規化する */
export function settingsFromForm(manifest: PluginManifest | null, form: Record<string, string>): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const s of manifest?.settings ?? []) {
    const raw = form[`setting_${s.key}`];
    if (s.type === "boolean") out[s.key] = raw === "on";
    else if (s.type === "select") out[s.key] = s.options?.some((o) => o.value === raw) ? (raw as string) : (s.options?.[0]?.value ?? "");
    // 制御文字（改行を含む）は落とす。値はメールの送信元などに使われる（2026-10-25 の監査）
    else out[s.key] = (raw ?? "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 1000);
  }
  return out;
}
