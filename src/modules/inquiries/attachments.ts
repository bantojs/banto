/**
 * お問い合わせの添付ファイル（0061、メンテナの決定 2026-10-27。docs/inquiries.md「添付ファイル」）。
 * - 置き場は公開しないバケット（adapters.privateStorage）。公開のメディア URL からは読めない。無ければ添付の欄を出さない
 * - 受け付けるのは JPEG / PNG / WebP / PDF（中身の先頭の数バイトで確かめる。名前と申告の種類は信じない）、1 個 5MB、1 通 3 個
 * - 添付できるのはアドレスの確認が済んだチケットへの返事だけ（確定前のいたずらで容量を使わせない。判定は DB）
 * - 配るときは nosniff と sandbox を付け、PDF は保存として渡す（ブラウザの中で開かせない）
 * 流れ: 先に privateStorage に置く → 返事の関数に鍵を渡す（DB が数と種類と大きさを確かめて行を作る）→ 断られたら置いた実体を消す
 */
import type { StorageAdapter } from "../../adapters/types";
import { sniffImage } from "../../media/images";
import { randomToken } from "../../util/signed";

export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
/** <input type="file" accept> に入れる値 */
export const ATTACHMENT_ACCEPT = ".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf";

export interface StoredAttachment {
  key: string;
  filename: string;
  content_type: string;
  size: number;
}

export type AttachmentError = "too_many" | "too_large" | "type";

/** 中身から種類を決める（受け付ける 4 種類だけ） */
export function sniffAttachment(bytes: Uint8Array): (typeof ATTACHMENT_TYPES)[number] | null {
  const img = sniffImage(bytes);
  if (img && (ATTACHMENT_TYPES as readonly string[]).includes(img.contentType)) return img.contentType as (typeof ATTACHMENT_TYPES)[number];
  if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-") return "application/pdf";
  return null;
}

/** 表示と保存に使う名前（パス・制御文字・引用符を落とし、100 文字まで） */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "").replace(/\s+/g, " ").trim().slice(0, 100);
  return cleaned || "file";
}

/** フォームの値から添付のファイルを取り出す（空の入力は除く） */
export function filesOf(body: Record<string, unknown>, field = "files"): File[] {
  const v = body[field];
  const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return list.filter((f): f is File => f instanceof File && f.size > 0);
}

/** 確かめて privateStorage に置く。どれか 1 つでも合わなければ何も置かない */
export async function storeAttachments(storage: StorageAdapter, shopId: string, files: File[]): Promise<{ ok: true; stored: StoredAttachment[] } | { ok: false; error: AttachmentError }> {
  if (files.length > MAX_ATTACHMENTS) return { ok: false, error: "too_many" };
  const checked: { file: File; bytes: Uint8Array; type: string }[] = [];
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) return { ok: false, error: "too_large" };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniffAttachment(bytes);
    if (!type) return { ok: false, error: "type" };
    checked.push({ file, bytes, type });
  }
  const stored: StoredAttachment[] = [];
  try {
    for (const c of checked) {
      const key = `inq/${shopId}/${randomToken(24)}`;
      await storage.put(key, c.bytes.buffer as ArrayBuffer, c.type);
      stored.push({ key, filename: safeFilename(c.file.name), content_type: c.type, size: c.bytes.byteLength });
    }
  } catch (e) {
    await removeAttachments(storage, stored.map((s) => s.key));
    throw e;
  }
  return { ok: true, stored };
}

/** 置いた実体を消す（返事の関数に断られたとき・Cron の待ち行列）。消せなかったものは console に残して続ける */
export async function removeAttachments(storage: StorageAdapter, keys: string[]): Promise<string[]> {
  const done: string[] = [];
  for (const key of keys) {
    try {
      await storage.delete(key);
      done.push(key);
    } catch (e) {
      console.error("[banto] inquiries: attachment delete failed:", key, e);
    }
  }
  return done;
}

/** 配る。中身の種類は DB の値（受け付けた 4 種類）で、ブラウザに推測させない */
export async function attachmentResponse(storage: StorageAdapter, meta: { storage_key: string; content_type: string; filename: string }): Promise<Response | null> {
  const obj = await storage.get(meta.storage_key);
  if (!obj) return null;
  const type = (ATTACHMENT_TYPES as readonly string[]).includes(meta.content_type) ? meta.content_type : "application/octet-stream";
  const disposition = type.startsWith("image/") ? "inline" : "attachment";
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
