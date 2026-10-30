/**
 * 法務のページ（特商法・プライバシー・返品）を連携サイトのページへ向ける（0062、docs/headless.md「法務のページ」）。
 *
 * 設定は shops.settings.headless.legal_links（integrations の項目）。外のページが生きているかは Cron と管理画面（保存・今すぐ確かめる）が
 * 確かめ、結果を DB（legal_links_state）に置く。お店の画面はリクエストのたびには取りに行かず、公開の形の legal_links
 * （最後の確認で生きていた URL だけ）にあれば 302、無ければ Banto のページを出す。文面の正は Banto のまま。
 */
import { classifyHost } from "../media/address";

export const LEGAL_KINDS = ["legal", "privacy", "returns"] as const;
export type LegalKind = (typeof LEGAL_KINDS)[number];

/** 確かめる間隔（時間）。既定は 1 日（メンテナの決定 2026-10-27） */
export const LEGAL_CHECK_HOURS = [1, 6, 24, 168] as const;
export const DEFAULT_LEGAL_CHECK_HOURS = 24;

export interface LegalLinksSetting {
  urls: Partial<Record<LegalKind, string>>;
  check_hours: number;
}

export type LegalLinkResults = Partial<Record<LegalKind, { url: string; ok: boolean }>>;
export type LegalLinkState = Partial<Record<LegalKind, { url: string; ok: boolean; checked_at: string }>>;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** shops.settings から読む（無ければ空） */
export function legalLinksOf(settings: Record<string, unknown> | null | undefined): LegalLinksSetting {
  const headless = isObject(settings?.["headless"]) ? settings["headless"] : {};
  const raw = isObject(headless["legal_links"]) ? headless["legal_links"] : {};
  const urls: Partial<Record<LegalKind, string>> = {};
  for (const k of LEGAL_KINDS) {
    const v = raw[k];
    if (typeof v === "string" && v.startsWith("https://")) urls[k] = v;
  }
  const hours = Number(raw["check_hours"]);
  return { urls, check_hours: (LEGAL_CHECK_HOURS as readonly number[]).includes(hours) ? hours : DEFAULT_LEGAL_CHECK_HOURS };
}

/**
 * 管理画面の入力を検査する。https で、オリジンが決済後の戻り先の許可リスト（return_origins）にあるものだけ。
 * 空は「使わない」。合わなければ種類ごとの理由を返す
 */
export function parseLegalUrl(raw: string, returnOrigins: readonly string[]): { ok: true; url: string | null } | { ok: false; reason: "bad_url" | "origin_not_allowed" } {
  const s = raw.trim();
  if (!s) return { ok: true, url: null };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  if (u.protocol !== "https:" || u.username || u.password || s.length > 500) return { ok: false, reason: "bad_url" };
  if (!returnOrigins.includes(u.origin)) return { ok: false, reason: "origin_not_allowed" };
  return { ok: true, url: u.toString() };
}

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 5000;

/**
 * 外のページが生きているか: 2xx で HTML が返れば true。本文は読まない。
 * リダイレクトは自分で追い、行き先ごとに社内のアドレスでないことを確かめる（画像の取り込みと同じ守り。src/media/fetch-image.ts）
 */
export async function checkLegalUrl(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
  for (let hop = 0; ; hop++) {
    if (u.protocol !== "https:" || u.username || u.password || classifyHost(u.hostname) === "blocked" || (u.port && u.port !== "443")) return false;
    let res: Response;
    try {
      res = await fetchImpl(u.toString(), { redirect: "manual", headers: { Accept: "text/html", "User-Agent": "banto-legal-check" }, ...(signal ? { signal } : {}) });
    } catch {
      // 届かない・時間切れ・Node の publicFetch が社内のアドレスとして繋がなかった
      return false;
    }
    await res.body?.cancel().catch(() => undefined);
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const location = res.headers.get("location");
      if (!location || hop >= MAX_REDIRECTS) return false;
      u = new URL(location, u);
      continue;
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    return res.status >= 200 && res.status < 300 && type === "text/html";
  }
}

/** 設定にある外の URL を全部確かめる（並べて） */
export async function checkLegalLinks(urls: Partial<Record<LegalKind, string>>, fetchImpl: typeof fetch): Promise<LegalLinkResults> {
  const out: LegalLinkResults = {};
  await Promise.all(
    LEGAL_KINDS.map(async (k) => {
      const url = urls[k];
      if (url) out[k] = { url, ok: await checkLegalUrl(url, fetchImpl) };
    }),
  );
  return out;
}

/** 公開の形の legal_links（生きている外の URL）から、その種類の行き先 */
export function liveLegalUrl(legalLinks: unknown, kind: LegalKind): string | null {
  if (!isObject(legalLinks)) return null;
  const v = legalLinks[kind];
  return typeof v === "string" && v.startsWith("https://") ? v : null;
}
