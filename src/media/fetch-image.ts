/**
 * URL から画像を取得する（AI 用 API の画像取り込みと、WooCommerce インポーターで共通。CLAUDE.md §7b）。
 * http(s) のみ、社内のアドレス不可（リダイレクト先も 1 回ずつ確かめる）、5MB まで。縮小やサムネイル生成はしない。
 * 種類は中身の先頭のバイトで決める（sniffImage）。申告の Content-Type は「画像か、種類不明（octet-stream）」かだけを見る。
 *
 * 社内のアドレスへ取りに行かせない（監査 M12）。入口は products:write の AI 用トークンと、そのトークンを持つ AI への
 * プロンプト注入（商品説明や CSV に URL を書く）なので、人間が呼ぶ場合より厳しくする:
 *   - 行き先は src/media/address.ts で数に直して判定する（文字列の前方一致はしない）
 *   - リダイレクトは自分で追い、行き先ごとに確かめる
 *   - ポートは既定と 80 / 443 / 8080 / 8443 だけ（公開のホストの、ウェブ以外の口を叩かせない）
 *   - 本文は数えながら読み、上限を超えたら読むのをやめる（Content-Length の申告は信じない）
 *   - 名前を引いた先のアドレスは、Node では接続の直前に確かめる（adapters.publicFetch、src/adapters/node/public-fetch.ts）
 */
import { MAX_IMAGE_BYTES, sniffImage } from "./images";
import { classifyHost } from "./address";

const MAX_REDIRECTS = 3;
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);
/** publicFetch が「名前を引いた先が社内のアドレス」で繋がなかったときのエラーの code */
export const BLOCKED_ADDRESS = "EBANTOBLOCKED";

/** 失敗の種類（画面で理由を出し分ける）: bad_url / host_not_allowed / fetch_failed / http_<状態> / too_many_redirects / not_image / too_large */
export class ImageFetchError extends Error {
  constructor(
    message: string,
    public readonly code: string = "fetch_failed",
  ) {
    super(message);
    this.name = "ImageFetchError";
  }
}

function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ImageFetchError("image_url must be an absolute http(s) URL", "bad_url");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ImageFetchError("image_url must be http(s)", "bad_url");
  if (u.username || u.password) throw new ImageFetchError("image_url must not contain credentials", "bad_url");
  if (classifyHost(u.hostname) === "blocked" || !ALLOWED_PORTS.has(u.port)) throw new ImageFetchError("image_url host not allowed", "host_not_allowed");
  return u;
}

/** 公開の URL を開く（行き先ごとに社内のアドレスでないか確かめながらリダイレクトを追い、状態と申告の種類まで見る） */
async function openImage(url: string, fetchImpl: typeof fetch): Promise<Response> {
  let u = checkUrl(url);
  let res: Response | undefined;
  // リダイレクトは自分で追う（公開の URL から社内のアドレスへ飛ばされないように、行き先ごとに確かめる）
  for (let hop = 0; ; hop++) {
    try {
      res = await fetchImpl(u.toString(), { redirect: "manual", headers: { Accept: "image/*", "User-Agent": "banto-api" } });
    } catch (e) {
      // Node の publicFetch が、名前を引いた先が社内のアドレスだったので繋がなかった
      if (e instanceof Error && (e as Error & { code?: string }).code === BLOCKED_ADDRESS) throw new ImageFetchError("image_url host not allowed", "host_not_allowed");
      throw new ImageFetchError("could not fetch image_url", "fetch_failed");
    }
    if (res.status < 300 || res.status >= 400 || res.status === 304) break;
    const location = res.headers.get("location");
    if (!location) break;
    await res.body?.cancel().catch(() => undefined);
    if (hop >= MAX_REDIRECTS) throw new ImageFetchError("image_url redirected too many times", "too_many_redirects");
    u = checkUrl(new URL(location, u).toString());
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new ImageFetchError(`image_url returned ${res.status}`, `http_${res.status}`);
  }
  const declaredType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (declaredType && !declaredType.startsWith("image/") && declaredType !== "application/octet-stream" && declaredType !== "binary/octet-stream") {
    await res.body?.cancel().catch(() => undefined);
    throw new ImageFetchError("image_url is not an image (jpeg/png/webp/gif/avif)", "not_image");
  }
  return res;
}


/** 本文を上限まで読み、中身で種類を決める */
async function readImage(res: Response, maxBytes: number, tooLarge: string): Promise<{ body: ArrayBuffer; contentType: string; ext: string }> {
  const large = () => new ImageFetchError(`image is larger than ${Math.round(maxBytes / 1024 / 1024)}MB`, tooLarge);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw large();
  }
  const body = await readCapped(res, maxBytes, large);
  const kind = sniffImage(new Uint8Array(body, 0, Math.min(body.byteLength, 256)));
  if (!kind) throw new ImageFetchError("image_url is not an image (jpeg/png/webp/gif/avif)", "not_image");
  return { body, contentType: kind.contentType, ext: kind.ext };
}

/** 本文を数えながら読む。上限を超えたらそこで読むのをやめる（申告の無い・偽の Content-Length でもメモリを食わせない） */
async function readCapped(res: Response, maxBytes: number, large: () => Error): Promise<ArrayBuffer> {
  if (!res.body) return new ArrayBuffer(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let r: ReadableStreamReadResult<Uint8Array>;
    try {
      r = await reader.read();
    } catch {
      throw new ImageFetchError("could not fetch image_url", "fetch_failed");
    }
    if (r.done) break;
    total += r.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw large();
    }
    chunks.push(r.value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

export async function fetchImage(url: string, fetchImpl: typeof fetch): Promise<{ body: ArrayBuffer; contentType: string; ext: string }> {
  return readImage(await openImage(url, fetchImpl), MAX_IMAGE_BYTES, "too_large");
}

/** 縮小の前の元の画像（管理画面のブラウザで縮小するために中継する）の上限 */
export const MAX_ORIGINAL_BYTES = 40 * 1024 * 1024;

/**
 * 5MB を超える画像を、ブラウザで縮小するために元のまま取る（WooCommerce の取り込みの「縮小して取り込む」）。
 * 守りは fetchImage と同じで、上限だけ 40MB（超えれば too_large_original）。保存はしない。
 */
export async function fetchOriginalImage(url: string, fetchImpl: typeof fetch): Promise<{ body: ArrayBuffer; contentType: string; ext: string }> {
  return readImage(await openImage(url, fetchImpl), MAX_ORIGINAL_BYTES, "too_large_original");
}
