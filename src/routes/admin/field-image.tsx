/**
 * 独自の項目の「画像」（商品のカスタム項目と記事の項目、メンテナの決定 2026-11-05）。
 * - 値は画像の URL の文字（このショップの画像の置き場のものだけ。アイキャッチと同じ規則、src/pages/markdown.ts の shopImageUrl）
 * - 管理画面の欄は URL の入力・見本・ファイルを選ぶボタン。選んだ画像はブラウザで縮小（横幅 FIELD_IMAGE_WIDTH・高さ 4096 まで、WebP）してから
 *   受け口に送り、返った URL を欄に入れる（サーバーでは画像を処理しない）。置き場は fields/<ショップ>/
 */
import type { AdminContext } from "./context";
import { mediaBaseUrl } from "./context";
import { MAX_IMAGE_BYTES, imageSize, imageUrl, randomKey, sniffImage } from "../../media/images";
import { t } from "../../i18n";

export const FIELD_IMAGE_WIDTH = 1600;

/** 置き場の鍵（fields/<ショップ>/<乱数>.<拡張子>） */
export const fieldImageKey = (shopId: string, random: string, ext: string) => `fields/${shopId}/${random}.${ext}`;

/** 受け口の本体（権限は呼び手が確かめる）。multipart の image を置いて { url } を返す */
export async function fieldImageUpload(c: AdminContext, shopId: string): Promise<Response> {
  c.header("Cache-Control", "private, no-store");
  const declared = Number(c.req.header("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES + 64 * 1024) return c.json({ error: t("field_image.invalid") }, 413);
  const body = await c.req.parseBody();
  const file = body["image"];
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_IMAGE_BYTES) return c.json({ error: t("field_image.invalid") }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  const dim = kind ? imageSize(bytes, kind.contentType) : null;
  if (!kind || !dim || dim.width > 4096 || dim.height > 4096) return c.json({ error: t("field_image.invalid") }, 400);
  const key = fieldImageKey(shopId, randomKey(), kind.ext);
  await c.get("adapters").storage.put(key, bytes.buffer as ArrayBuffer, kind.contentType);
  return c.json({ url: imageUrl(mediaBaseUrl(c), key) });
}

/** 管理画面の欄（URL の入力・見本・ファイルを選ぶ）。upload は受け口の URL */
export function FieldImageInput(props: { id: string; name: string; value: string; upload: string }) {
  return (
    <div class="field-image" data-field-image={props.upload}>
      <img src={props.value || undefined} alt="" style={`max-width:160px;max-height:160px;display:${props.value ? "block" : "none"};margin:.25rem 0;border-radius:4px`} />
      <input id={props.id} type="text" name={props.name} value={props.value} maxlength={2000} style="width:100%;max-width:40rem" placeholder="https://…" />
      <div>
        <input type="file" accept="image/*" aria-label={t("field_image.choose")} />
        <span class="muted" data-field-image-status />
      </div>
    </div>
  );
}

/** 選んだ画像を縮小して送り、返った URL を欄に入れる。縮小できなければ元のファイルのまま送る */
export const FIELD_IMAGE_SCRIPT = `(function(){document.querySelectorAll("[data-field-image]").forEach(function(box){var up=box.getAttribute("data-field-image");var file=box.querySelector("input[type=file]");var url=box.querySelector("input[type=text]");var img=box.querySelector("img");var st=box.querySelector("[data-field-image-status]");
function show(u){img.style.display=u?"block":"none";if(u)img.src=u;else img.removeAttribute("src")}
url.addEventListener("input",function(){show(url.value.trim())});
function send(blob,name){var fd=new FormData();fd.append("image",blob,name);st.textContent=${JSON.stringify(t("image.uploading"))};
fetch(up,{method:"POST",body:fd,credentials:"same-origin"}).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})}).then(function(x){if(x.ok&&x.j.url){url.value=x.j.url;show(x.j.url);st.textContent=""}else{st.textContent=(x.j&&x.j.error)||"error"}}).catch(function(){st.textContent="error"}).finally(function(){file.value=""})}
file.addEventListener("change",function(){var f=file.files&&file.files[0];if(!f)return;st.textContent=${JSON.stringify(t("image.resizing"))};var u=URL.createObjectURL(f);var im=new Image();
im.onload=function(){var W=im.naturalWidth,H=im.naturalHeight;var r=Math.min(1,${FIELD_IMAGE_WIDTH}/W,4096/H);var w=Math.max(1,Math.round(W*r)),h=Math.max(1,Math.round(H*r));var c=document.createElement("canvas");c.width=w;c.height=h;var x=c.getContext("2d");if(!x){URL.revokeObjectURL(u);send(f,f.name);return}x.drawImage(im,0,0,w,h);
c.toBlob(function(b){URL.revokeObjectURL(u);if(b&&b.type==="image/webp")send(b,"field.webp");else send(f,f.name)},"image/webp",0.85)};
im.onerror=function(){URL.revokeObjectURL(u);send(f,f.name)};im.src=u})})})();`;
