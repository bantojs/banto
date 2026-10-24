/**
 * ショップごとの外部サービスの秘密（LINE のチャネルシークレット・Google のクライアントシークレット）の暗号化。
 * CLAUDE.md §1-5 の例外（人間の決定、2026-10-16。docs/knowledge/10-members-identity.md §14）:
 * DB には暗号文だけを置き、鍵はサイトの秘密（SESSION_SECRET、無ければ service_role キーからの導出値）から作る。鍵は DB に無い。
 *
 * - AES-GCM（256 ビット、IV 12 バイト）。WebCrypto だけを使い、ランタイムに依存しない。
 * - 追加認証データにショップ ID と用途（例: "oauth:line"）を入れる。暗号文を別のショップ・別の提供元の行に移しても復号できない。
 * - 形式: "v1.<IV>.<暗号文>"（base64url）。サイトの秘密を変えると読めなくなる（管理画面で入れ直してもらう）。
 */
import { b64url, fromB64url } from "../util/signed";

const enc = new TextEncoder();

async function boxKey(siteSecret: string): Promise<CryptoKey> {
  // 用途ごとに分けた鍵（サイトの秘密をそのまま AES の鍵にしない）
  const hmac = await crypto.subtle.importKey("raw", enc.encode(siteSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const raw = await crypto.subtle.sign("HMAC", hmac, enc.encode("banto-secret-box/v1"));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

const aad = (shopId: string, purpose: string) => enc.encode(`${shopId}|${purpose}`);

export async function sealSecret(siteSecret: string, shopId: string, purpose: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(shopId, purpose) }, await boxKey(siteSecret), enc.encode(plaintext));
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

/** 読めなければ null（サイトの秘密が変わった・別のショップの暗号文・改ざん） */
export async function openSecret(siteSecret: string, shopId: string, purpose: string, box: string): Promise<string | null> {
  const [v, iv, ct] = box.split(".");
  if (v !== "v1" || !iv || !ct) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv), additionalData: aad(shopId, purpose) }, await boxKey(siteSecret), fromB64url(ct));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
