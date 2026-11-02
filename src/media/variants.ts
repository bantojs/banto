/**
 * 商品画像の大きさの段（メンテナの決定 2026-11-01・2026-11-02、docs/images.md）。
 *
 * 縮小は管理画面のブラウザで行い（サーバーでは画像処理をしない。CLAUDE.md §10 Step 4）、アップロードのときに次の段を作る。
 * 基準は **横幅**（表示の枠と srcset の w は横幅なので。縦長の写真でも段の横幅がそろう）。どの段も高さは MAX_HEIGHT まで（縦長の説明画像で重くしない）:
 *   サムネイル（thumb_key、0091 の thumb_width）  横幅 400
 *   中間（variants、0091）                        横幅 800 / 1600 / 2048 / 2560 のうち、本画像より狭いもの
 *   本画像（storage_key）                         横幅はショップの設定 settings.images.max_width（1600 既定 / 2048 / 2560 / 3200）
 * 元の画像がそれより小さければ、元の大きさまで。お客様の画面は srcset で端末に合う段を選ぶ（テーマは responsiveImage / image_url）。
 * 中間のファイルのキーは本画像のキーから決まる（variantKey）。DB には作った横幅だけを残す。
 * 0091 より前のサムネイルは長辺 400 で作っていた（thumb_width が null。imageLadder が縦横の比から幅を出す）。
 */
import { MAX_IMAGE_BYTES, imageSize, sniffImage } from "./images";

/** 中間の段の列のマイグレーション（当たるまで中間の段を作らない・送らない。CLAUDE.md §11「コードと DB の版のずれ」） */
export const IMAGE_VARIANTS_MIGRATION = "0091_image_variants";

/** 外部の変換プラグインに任せるモード・段を書き戻す API（0092） */
export const IMAGE_PROCESSING_MIGRATION = "0092_image_processing";

/** 任せるモードで受け取る元の写真の上限（スマホの写真をそのまま。縮小した本画像は MAX_IMAGE_BYTES まで） */
export const ORIGINAL_MAX_BYTES = 20 * 1024 * 1024;

export type ImageProcessing = "browser" | "plugin";

/**
 * 段を誰が作るか（ショップの設定 settings.images.processing、メンテナの決定 2026-11-02）。
 * browser（既定）= 管理画面のブラウザが全部の段を作る（費用 0、待ちあり）。
 * plugin = ブラウザはサムネイルだけを作り、元の写真をそのまま送る。本画像と中間の段は外部の変換プラグインが作って差し替える（待ちなし、変換の費用はプラグインの側）
 */
export function imageProcessing(settings: Record<string, unknown> | null | undefined): ImageProcessing {
  const images = settings?.["images"];
  return images && typeof images === "object" && !Array.isArray(images) && (images as Record<string, unknown>)["processing"] === "plugin" ? "plugin" : "browser";
}

/** プラグインのマニフェストの capabilities に、画像を変換できると書いてあるか（docs/hooks.md） */
export const IMAGE_CAPABILITY = "images";

export const THUMB_WIDTH = 400;
/** どの段も高さはここまで（超えるなら高さで縮める） */
export const MAX_HEIGHT = 4096;
/** 本画像の横幅に選べる値（ショップの設定） */
export const IMAGE_MAX_CHOICES = [1600, 2048, 2560, 3200] as const;
export const DEFAULT_IMAGE_MAX = 1600;
/** 中間の段（0091 の check と同じ） */
export const VARIANT_SIZES = [800, 1600, 2048, 2560] as const;

/** ショップの設定の本画像の横幅（壊れていれば既定） */
export function imageMaxWidth(settings: Record<string, unknown> | null | undefined): number {
  const images = settings?.["images"];
  const v = images && typeof images === "object" && !Array.isArray(images) ? Number((images as Record<string, unknown>)["max_width"]) : NaN;
  return (IMAGE_MAX_CHOICES as readonly number[]).includes(v) ? v : DEFAULT_IMAGE_MAX;
}

/** 元の画像（w × h）を横幅 target に合わせたときの大きさ（大きくはしない・高さは MAX_HEIGHT まで） */
export function fitWidth(w: number, h: number, target: number): { width: number; height: number } {
  const r = Math.min(1, target / w, MAX_HEIGHT / h);
  return { width: Math.max(1, Math.round(w * r)), height: Math.max(1, Math.round(h * r)) };
}

/** 本画像の横幅が mainWidth のときに作る中間の段 */
export function variantSizesFor(mainWidth: number): number[] {
  return VARIANT_SIZES.filter((s) => s > THUMB_WIDTH && s < mainWidth);
}

/** 中間のファイルのキー（本画像のキーの拡張子の前に .<横幅>、WebP） */
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
  /** 0091。サムネイルの横幅（null なら 0091 より前の長辺 400 のサムネイル） */
  thumb_width?: number | null;
  width?: number | null;
  height?: number | null;
  variants?: readonly number[] | null;
}

/** 持っている段（小さい順の横幅）。寸法が分からなければ空 */
export function imageLadder(img: SizedImage): { key: string; width: number }[] {
  const w = img.width ?? null;
  const h = img.height ?? null;
  if (!w || !h) return [];
  const out: { key: string; width: number }[] = [];
  if (img.thumb_key) {
    // 0091 より前のサムネイルは長辺 400（縦長なら横幅はもっと狭い）
    const tw = img.thumb_width ?? Math.max(1, Math.round((w * Math.min(THUMB_WIDTH, Math.max(w, h))) / Math.max(w, h)));
    out.push({ key: img.thumb_key, width: Math.min(tw, w) });
  }
  for (const s of [...(img.variants ?? [])].sort((a, b) => a - b)) if (s < w) out.push({ key: variantKey(img.storage_key, s), width: s });
  out.push({ key: img.storage_key, width: w });
  // 同じ幅が重なったら大きい側（本画像）を残す
  return out.filter((x, i) => i === out.length - 1 || x.width < out[i + 1]!.width);
}

/** 求める幅以上でいちばん小さい段のキー（無ければ本画像）。寸法が分からなければ、400 以下ならサムネイル */
export function keyForWidth(img: SizedImage, width: number): string {
  const ladder = imageLadder(img);
  if (ladder.length === 0) return width <= THUMB_WIDTH && img.thumb_key ? img.thumb_key : img.storage_key;
  return (ladder.find((x) => x.width >= width) ?? ladder[ladder.length - 1]!).key;
}

/**
 * アップロードのフォームの中間の段（variant_<横幅>）を確かめる。WebP だけ・決まった横幅だけ・本画像より狭いものだけ・
 * 横幅がその値を超えず高さが MAX_HEIGHT を超えない。形が違うものは捨てずに断る（null）。無ければ空。
 */
export function readVariantFiles(form: Record<string, unknown>, mainWidth: number): Promise<{ size: number; bytes: Uint8Array }[] | null> {
  return (async () => {
    const out: { size: number; bytes: Uint8Array }[] = [];
    for (const [name, value] of Object.entries(form)) {
      const m = /^variant_([0-9]{3,4})$/.exec(name);
      if (!m) continue;
      const size = Number(m[1]);
      if (!(VARIANT_SIZES as readonly number[]).includes(size) || size >= mainWidth || !(value instanceof Blob)) return null;
      const bytes = new Uint8Array(await value.arrayBuffer());
      const kind = sniffImage(bytes.subarray(0, 256));
      const dim = kind ? imageSize(bytes, kind.contentType) : null;
      if (kind?.contentType !== "image/webp" || bytes.byteLength > MAX_IMAGE_BYTES || !dim || dim.width > size || dim.height > MAX_HEIGHT) return null;
      out.push({ size, bytes });
    }
    return out.sort((a, b) => a.size - b.size);
  })();
}

/** サムネイルの横幅（0091 の thumb_width）。WebP などの見出しから読む。読めなければ null（長辺 400 とみなされる） */
export function thumbWidthOf(bytes: Uint8Array, contentType: string): number | null {
  const dim = imageSize(bytes, contentType);
  return dim && dim.width <= THUMB_WIDTH ? dim.width : null;
}

/**
 * 管理画面のブラウザで縮小する関数（文字列。管理画面のスクリプトに埋め込む）。
 * bantoResize(source, max) → { main, thumb, variants: [{size, blob}], w, h }（source は Image か ImageBitmap）。
 * 本画像は横幅 max（元が小さければ元のまま）、サムネイルは横幅 400、中間は本画像より狭い VARIANT_SIZES。どれも高さ MAX_HEIGHT まで・WebP（fitWidth と同じ計算）。
 */
export function resizeScript(): string {
  return `function bantoResize(src,max){
  var W=src.naturalWidth||src.width,H=src.naturalHeight||src.height;
  function fit(t){var r=Math.min(1,t/W,${MAX_HEIGHT}/H);return {w:Math.max(1,Math.round(W*r)),h:Math.max(1,Math.round(H*r))}}
  function draw(t,q){var d=fit(t);var c=document.createElement("canvas");c.width=d.w;c.height=d.h;var x=c.getContext("2d");if(!x)return Promise.reject(new Error("resize"));x.drawImage(src,0,0,d.w,d.h);return new Promise(function(ok,ng){c.toBlob(function(b){if(b&&b.type==="image/webp")ok({blob:b,w:d.w,h:d.h});else ng(new Error("webp"))},"image/webp",q)})}
  var mainW=fit(max).w;var sizes=${JSON.stringify(VARIANT_SIZES)}.filter(function(s){return s>${THUMB_WIDTH}&&s<mainW});
  return Promise.all([draw(max,0.82),draw(${THUMB_WIDTH},0.8)].concat(sizes.map(function(s){return draw(s,0.82)}))).then(function(r){
    return {main:r[0].blob,w:r[0].w,h:r[0].h,thumb:r[1].blob,variants:sizes.map(function(s,i){return {size:s,blob:r[2+i].blob}})};
  });
}`;
}

/** サムネイルだけを作る関数（文字列。任せるモードの管理画面のスクリプトに埋め込む）。bantoThumb(source) → { blob, w, h } */
export function thumbScript(): string {
  return `function bantoThumb(src){
  var W=src.naturalWidth||src.width,H=src.naturalHeight||src.height;var r=Math.min(1,${THUMB_WIDTH}/W,${MAX_HEIGHT}/H);
  var w=Math.max(1,Math.round(W*r)),h=Math.max(1,Math.round(H*r));var c=document.createElement("canvas");c.width=w;c.height=h;var x=c.getContext("2d");if(!x)return Promise.reject(new Error("resize"));x.drawImage(src,0,0,w,h);
  return new Promise(function(ok,ng){c.toBlob(function(b){if(b&&b.type==="image/webp")ok({blob:b,w:w,h:h});else ng(new Error("webp"))},"image/webp",0.8)});
}`;
}
