/**
 * 本文の短い動画（`::: video`、docs/pages.md「お店のブロック」）。mp4 だけ・1 本 MAX_VIDEO_BYTES まで。
 * Worker では変換しない（運営者が書き出した mp4 をそのまま置く）。置き場は本文の画像と同じ pages/<ショップ>/。
 * 再生には置き場が Range に答える必要がある（/media/ は StorageAdapter.getRange で答える。R2 のカスタムドメインはそのまま答える）
 */

/** 1 本の大きさの上限（メンテナの決定 2026-11-03） */
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

/** mp4 と見なす ftyp のブランド（QuickTime の mov・HEIF・AVIF は受けない） */
const MP4_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "MSNV", "dash"]);
const NOT_VIDEO = new Set(["avif", "avis", "heic", "heix", "mif1", "msf1", "qt  "]);

/** 中身の先頭のバイトで mp4 か決める（申告された Content-Type は信じない） */
export function sniffMp4(b: Uint8Array): boolean {
  if (b.length < 16) return false;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (ascii(4, 8) !== "ftyp") return false;
  const size = Math.min(((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0, b.length, 256);
  if (size < 16) return false;
  const brands = [ascii(8, 12)];
  for (let i = 16; i + 4 <= size; i += 4) brands.push(ascii(i, i + 4));
  if (NOT_VIDEO.has(brands[0]!) || brands.some((x) => x === "avif" || x === "avis")) return false;
  return brands.some((x) => MP4_BRANDS.has(x));
}

/** 本文の動画・ポスターの URL の形（Banto の置き場の pages/<ショップ>/ のものだけ。ホストは描くときに確かめる） */
const MEDIA_URL = /^(\/media\/|https?:\/\/[^\s"'<>?#\\]+\/)pages\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{1,96}\.(mp4|jpg|png|webp|gif|avif)$/;
export const isVideoUrl = (u: string) => u.length <= 2000 && !u.includes("..") && MEDIA_URL.test(u) && u.endsWith(".mp4");
export const isPosterUrl = (u: string) => u.length <= 2000 && !u.includes("..") && MEDIA_URL.test(u) && !u.endsWith(".mp4");
