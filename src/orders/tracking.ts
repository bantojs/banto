/**
 * 発送のお問い合わせ番号（0022_tracking、docs/shipping-labels.md §5）。
 * 番号は区切り（- と空白）を外して英数字だけで持つ。照会ページの URL は運送会社の公開している形（実機で確かめること）。
 */
import { t, type MessageKey } from "../i18n";

export const TRACKING_CARRIERS = ["yamato", "sagawa", "japanpost", "other"] as const;
export type TrackingCarrier = (typeof TRACKING_CARRIERS)[number];

export function isTrackingCarrier(v: unknown): v is TrackingCarrier {
  return typeof v === "string" && (TRACKING_CARRIERS as readonly string[]).includes(v);
}

/** 区切りを外す。番号として使えなければ null */
export function normalizeTracking(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, "");
  return /^[0-9A-Za-z]{4,40}$/.test(s) ? s : null;
}

/** 運送会社の照会ページ。「その他」は null */
export function trackingUrl(carrier: string | null | undefined, number: string): string | null {
  const n = encodeURIComponent(number);
  if (carrier === "yamato") return `https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number00=1&number01=${n}`;
  if (carrier === "sagawa") return `https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=${n}`;
  if (carrier === "japanpost") return `https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1=${n}&locale=ja`;
  return null;
}

export function carrierLabel(carrier: string | null | undefined): string {
  return t(`tracking.carrier_${isTrackingCarrier(carrier) ? carrier : "other"}` as MessageKey);
}

/** lookup_order・order_contact の tracking（0022。番号が無い注文は null） */
export function trackingOf(v: unknown): { carrier: string; number: string } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return typeof o["number"] === "string" && o["number"] ? { carrier: typeof o["carrier"] === "string" ? o["carrier"] : "other", number: o["number"] } : null;
}
