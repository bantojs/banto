/**
 * 商品画像の大きさの段（メンテナの決定 2026-11-01、docs/images.md）。
 *
 * 縮小は管理画面のブラウザで行い（サーバーでは画像処理をしない。CLAUDE.md §10 Step 4）、アップロードのときに次の段を作る:
 *   サムネイル（thumb_key）     長辺 400
 *   中間（variants、0091）      長辺 800 / 1600 / 2048 / 2560 のうち、本画像より小さいもの
 *   本画像（storage_key）       長辺はショップの設定 settings.images.max_long_side（1600 既定 / 2048 / 2560 / 3200）
 * 元の画像がそれより小さければ、元の大きさまで。お客様の画面は srcset で端末に合う段を選ぶ（テーマは responsiveImage / image_url）。
 * 中間のファイルのキーは本画像のキーから決まる（variantKey）。DB には作った長辺だけを残す。
 */
import { MAX_IMAGE_BYTES, imageSize, sniffImage } from "./images";

/** 中間の段の列のマイグレーション（当たるまで中間の段を作らない・送らない。CLAUDE.md §11「コードと DB の版のずれ」） */
export const IMAGE_VARIANTS_MIGRATION = "0091_image_variants";

export const THUMB_LONG_SIDE = 400;
/** 本画像の長辺に選べる値（ショップの設定） */
export const IMAGE_MAX_CHOICES = [1600, 2048, 2560, 3200] as const;
export const DEFAULT_IMAGE_MAX = 1600;
/** 中間の段（0091 の check と同じ） */
export const VARIANT_SIZES = [800, 1600, 2048, 2560] as const;

/** ショップの設定の本画像の長辺（壊れていれば既定） */
export function imageMaxLongSide(settings: Record<string, unknown> | null | undefined): number {
  const images = settings?.["images"];
  const v = images && typeof images === "object" && !Array.isArray(images) ? Number((images as Record<string, unknown>)["max_long_side"]) : NaN;
  return (IMAGE_MAX_CHOICES as readonly number[]).includes(v) ? v : DEFAULT_IMAGE_MAX;
}

/** 本画像の長辺が mainLong のときに作る中間の段 */
export function variantSizesFor(mainLong: number): number[] {
  return VARIANT_SIZES.filter((s) => s > THUMB_LONG_SIDE && s < mainLong);
}

/** 中間のファイルのキー（本画像のキーの拡張子の前に .<長辺>、WebP） */
export function variantKey(storageKey: string, size: number): string {
  return storageKey.replace(/\.[a-z0-9]+$/i, "") + `.${size}.webp`;
}

/** 画像の行が持つファイルのキーすべて（消すとき） */
export function imageKeys(img: { storage_key: string; thumb_key?: string | null; variants?: readonly number[] | null }): string[] {
  return [img.storage_key, ...(img.thumb_key ? [img.thumb_key] : []), ...(img.variants ?? []).map((s) => variantKey(img.storage_key, s))];
}

export interface SizedImage {
  storage_key: string;
  thumb_key?: string | null;
  width?: number | null;
  height?: number | null;
  variants?: readonly number[] | null;
}

/** 持っている段（小さい順）。幅は本画像の縦横の比から出す。寸法が分からなければ本画像だけ */
export function imageLadder(img: SizedImage): { key: string; width: number }[] {
  const w = img.width ?? null;
  const h = img.height ?? null;
  if (!w || !h) return [];
  const long = Math.max(w, h);
  const widthAt = (side: number) => Math.max(1, Math.round((w * Math.min(side, long)) / long));
  const out: { key: string; width: number }[] = [];
  if (img.thumb_key) out.push({ key: img.thumb_key, width: widthAt(THUMB_LONG_SIDE) });
  for (const s of [...(img.variants ?? [])].sort((a, b) => a - b)) if (s < long) out.push({ key: variantKey(img.storage_key, s), width: widthAt(s) });
  out.push({ key: img.storage_key, width: w });
  // 同じ幅が重なったら大きい側（本画像）を残す
  return out.filter((x, i) => i === out.length - 1 || x.width < out[i + 1]!.width);
}

/** 求める幅以上でいちばん小さい段のキー（無ければ本画像）。寸法が分からなければ、400 以下ならサムネイル */
export function keyForWidth(img: SizedImage, width: number): string {
  const ladder = imageLadder(img);
  if (ladder.length === 0) return width <= THUMB_LONG_SIDE && img.thumb_key ? img.thumb_key : img.storage_key;
  return (ladder.find((x) => x.width >= width) ?? ladder[ladder.length - 1]!).key;
}

/**
 * アップロードのフォームの中間の段（variant_<長辺>）を確かめる。WebP だけ・決まった長辺だけ・本画像より小さいものだけ・長辺がその値を超えない。
 * 形が違うものは捨てずに断る（null）。無ければ空。
 */
export function readVariantFiles(form: Record<string, unknown>, mainLong: number): Promise<{ size: number; bytes: Uint8Array }[] | null> {
  return (async () => {
    const out: { size: number; bytes: Uint8Array }[] = [];
    for (const [name, value] of Object.entries(form)) {
      const m = /^variant_([0-9]{3,4})$/.exec(name);
      if (!m) continue;
      const size = Number(m[1]);
      if (!(VARIANT_SIZES as readonly number[]).includes(size) || size >= mainLong || !(value instanceof Blob)) return null;
      const bytes = new Uint8Array(await value.arrayBuffer());
      const kind = sniffImage(bytes.subarray(0, 256));
      const dim = kind ? imageSize(bytes, kind.contentType) : null;
      if (kind?.contentType !== "image/webp" || bytes.byteLength > MAX_IMAGE_BYTES || !dim || Math.max(dim.width, dim.height) > size) return null;
      out.push({ size, bytes });
    }
    return out.sort((a, b) => a.size - b.size);
  })();
}

/**
 * 管理画面のブラウザで縮小する関数（文字列。管理画面のスクリプトに埋め込む）。
 * bantoResize(source, max) → { main, thumb, variants: [{size, blob}], w, h }（source は Image か ImageBitmap）。
 * 本画像は長辺 max（元が小さければ元のまま）、サムネイルは 400、中間は max より小さい VARIANT_SIZES。どれも WebP。
 */
export function resizeScript(): string {
  return `function bantoResize(src,max){
  var W=src.naturalWidth||src.width,H=src.naturalHeight||src.height,L=Math.max(W,H);
  function draw(side,q){var r=Math.min(1,side/L);var cw=Math.max(1,Math.round(W*r)),ch=Math.max(1,Math.round(H*r));var c=document.createElement("canvas");c.width=cw;c.height=ch;var x=c.getContext("2d");if(!x)return Promise.reject(new Error("resize"));x.drawImage(src,0,0,cw,ch);return new Promise(function(ok,ng){c.toBlob(function(b){if(b&&b.type==="image/webp")ok({blob:b,w:cw,h:ch});else ng(new Error("webp"))},"image/webp",q)})}
  var mainLong=Math.min(max,L);var sizes=${JSON.stringify(VARIANT_SIZES)}.filter(function(s){return s>${THUMB_LONG_SIDE}&&s<mainLong});
  return Promise.all([draw(max,0.82),draw(${THUMB_LONG_SIDE},0.8)].concat(sizes.map(function(s){return draw(s,0.82)}))).then(function(r){
    return {main:r[0].blob,w:r[0].w,h:r[0].h,thumb:r[1].blob,variants:sizes.map(function(s,i){return {size:s,blob:r[2+i].blob}})};
  });
}`;
}
