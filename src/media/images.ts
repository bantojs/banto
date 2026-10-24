/** 商品画像のアップロード規則（StorageAdapter に渡す前の検証） */
export const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function imageExtension(contentType: string): string | null {
  return IMAGE_TYPES[contentType.toLowerCase().split(";")[0]!.trim()] ?? null;
}

/**
 * 中身の先頭のバイトで画像の種類を決める（申告された Content-Type は信じない）。
 * JPEG・PNG・GIF・WebP・AVIF だけ。SVG（スクリプトを含められる）や HTML は null。
 */
export function sniffImage(bytes: Uint8Array): { contentType: string; ext: string } | null {
  const b = bytes;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { contentType: "image/jpeg", ext: "jpg" };
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return { contentType: "image/png", ext: "png" };
  if (b.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return { contentType: "image/gif", ext: "gif" };
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { contentType: "image/webp", ext: "webp" };
  if (b.length >= 16 && ascii(4, 8) === "ftyp") {
    // ftyp ボックス: 大きさ（4）・"ftyp"・主ブランド（4）・版（4）・互換ブランド（4 ずつ）
    const size = Math.min(((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0, b.length, 256);
    const brands = [ascii(8, 12)];
    for (let i = 16; i + 4 <= size; i += 4) brands.push(ascii(i, i + 4));
    if (brands.includes("avif") || brands.includes("avis")) return { contentType: "image/avif", ext: "avif" };
  }
  return null;
}

/** 画像の縦横（JPEG・PNG・GIF・WebP の見出しだけを読む。読めなければ null。AVIF は null） */
export function imageSize(bytes: Uint8Array, contentType: string): { width: number; height: number } | null {
  const b = bytes;
  const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u16le = (i: number) => b[i]! | (b[i + 1]! << 8);
  const u32be = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
  const ok = (w: number, h: number) => (w > 0 && h > 0 && w <= 20000 && h <= 20000 ? { width: w, height: h } : null);
  try {
    if (contentType === "image/png" && b.length >= 24) return ok(u32be(16), u32be(20));
    if (contentType === "image/gif" && b.length >= 10) return ok(u16le(6), u16le(8));
    if (contentType === "image/webp" && b.length >= 30) {
      const chunk = String.fromCharCode(...b.subarray(12, 16));
      if (chunk === "VP8X") return ok(1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)));
      if (chunk === "VP8 ") return ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
      if (chunk === "VP8L") {
        const v = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
        return ok((v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1);
      }
      return null;
    }
    if (contentType === "image/jpeg") {
      // マーカーを長さで飛ばしながら SOF（C0〜CF のうち C4・C8・CC を除く）を探す
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const m = b[i + 1]!;
        if (m === 0xff) {
          i++;
          continue;
        }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return ok(u16be(i + 7), u16be(i + 5));
        if (m === 0xd9 || m === 0xda) return null;
        i += 2 + u16be(i + 2);
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function randomKey(bytes = 12): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function productImageKey(shopId: string, productId: string, ext: string): string {
  return `shops/${shopId}/products/${productId}/${randomKey()}.${ext}`;
}

/** 画像 URL。MEDIA_BASE_URL + "/" + key */
export function imageUrl(mediaBaseUrl: string, key: string): string {
  return `${mediaBaseUrl.replace(/\/+$/, "")}/${key}`;
}

/** サムネイルの上限（ブラウザ側で長辺 400px の WebP に縮小したもの。念のため 1MB） */
export const MAX_THUMB_BYTES = 1024 * 1024;

/** 本画像のキーからサムネイルのキーを作る（同じディレクトリ、拡張子の前に .thumb） */
export function thumbKey(storageKey: string, ext: string): string {
  return storageKey.replace(/\.[a-z0-9]+$/i, "") + `.thumb.${ext}`;
}

/** フォームから来た寸法を整数にする。不正なら null */
export function imageDimension(value: string | undefined): number | null {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isInteger(n) && n > 0 && n <= 20000 ? n : null;
}

export interface ResponsiveImage {
  src: string;
  srcset?: string;
  sizes?: string;
  width?: number;
  height?: number;
}

/**
 * テーマ用: サムネイルがあれば srcset（400w / 本画像）を出す。無ければ本画像だけ。
 * 寸法は本画像のもの。サムネイルは同じ縦横比なので width/height 属性はレイアウトの確保にそのまま使える。
 */
export function responsiveImage(
  mediaBaseUrl: string,
  img: { storage_key: string; thumb_key?: string | null; width?: number | null; height?: number | null },
  opts: { sizes?: string; thumbWidth?: number; fullWidth?: number } = {},
): ResponsiveImage {
  const full = imageUrl(mediaBaseUrl, img.storage_key);
  const out: ResponsiveImage = { src: full };
  if (img.width && img.height) {
    out.width = img.width;
    out.height = img.height;
  }
  if (img.thumb_key) {
    const thumb = imageUrl(mediaBaseUrl, img.thumb_key);
    const fullW = img.width ?? opts.fullWidth ?? 1600;
    const thumbW = Math.min(opts.thumbWidth ?? 400, fullW);
    out.src = thumb;
    out.srcset = thumbW < fullW ? `${thumb} ${thumbW}w, ${full} ${fullW}w` : `${full} ${fullW}w`;
    out.sizes = opts.sizes ?? "(max-width: 40rem) 50vw, 14rem";
  }
  return out;
}
