/**
 * SKU ごとの画像（0063）。画像の options（SKU の options の一部）で、どの SKU の画像かを表す。
 *   - {}                                  … 商品全体
 *   - { color: "レッド" }                  … color がレッドの SKU すべて（カラー単位）
 *   - { color: "レッド", size: "M" }       … その SKU だけ
 * 当てはまりの判定と並べ方はここだけ（お店の画面・公開 API・商品フィード・管理画面が同じ関数を使う）。
 * お店の画面のスクリプト（SKU_IMAGE_SCRIPT）も同じ規則で並べ替える。
 */

export const SKU_IMAGES_MIGRATION = "0063_sku_images";

export type ImageOptions = Record<string, string>;

/** 画像の options（壊れた値は {} = 商品全体として扱う） */
export function imageOptionsOf(v: unknown): ImageOptions {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: ImageOptions = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (typeof val === "string") out[k] = val;
  return out;
}

/** 画像がその SKU に当てはまるか（画像の鍵と値がすべて SKU の options にある）。商品全体の画像はどの SKU にも当てはまる */
export function imageMatchesSku(image: ImageOptions, sku: Record<string, unknown> | null | undefined): boolean {
  const opts = sku ?? {};
  return Object.entries(image).every(([k, v]) => String(opts[k] ?? "") === v);
}

/**
 * SKU を選んだときの画像の並び: その SKU に結んだ画像（細かいもの = 鍵の多いもの先）→ 商品全体の画像 → ほかの SKU の画像。
 * 同じ組の中は元の並び（sort_order）のまま。SKU が無ければ元の並び
 */
export function orderImagesForSku<T extends { options?: unknown }>(images: readonly T[], skuOptions: Record<string, unknown> | null | undefined): T[] {
  if (!skuOptions) return [...images];
  const rank = (img: T): number => {
    const o = imageOptionsOf(img.options);
    const n = Object.keys(o).length;
    if (n === 0) return 0;
    return imageMatchesSku(o, skuOptions) ? n : -1;
  };
  return images
    .map((img, i) => ({ img, i, r: rank(img) }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r === -1 ? 1 : b.r === -1 ? -1 : b.r - a.r))
    .map((x) => x.img);
}

/** SKU に使う 1 枚目（無ければ null）。商品フィードの image_link */
export function firstImageForSku<T extends { options?: unknown }>(images: readonly T[], skuOptions: Record<string, unknown> | null | undefined): T | null {
  return orderImagesForSku(images, skuOptions)[0] ?? null;
}

/** 管理画面の入力（options.<鍵>=値）から画像の options を作る。空の値の鍵は外す。鍵は SKU にあるものだけ */
export function imageOptionsFromForm(fields: Record<string, string>, allowedKeys: readonly string[]): ImageOptions {
  const out: ImageOptions = {};
  for (const k of allowedKeys) {
    const v = (fields[`options.${k}`] ?? "").trim();
    if (v) out[k] = v.slice(0, 60);
  }
  return out;
}

/** 商品の SKU から、画像に選べる項目と値（出てくる順） */
export function skuOptionChoices(skus: readonly { options?: unknown }[]): { key: string; values: string[] }[] {
  const out = new Map<string, string[]>();
  for (const s of skus) {
    for (const [k, v] of Object.entries(imageOptionsOf(s.options))) {
      const list = out.get(k) ?? [];
      if (!list.includes(v)) list.push(v);
      out.set(k, list);
    }
  }
  return [...out].slice(0, 5).map(([key, values]) => ({ key, values }));
}

/**
 * お店の商品ページで、SKU を選んだときにその場で画像を並べ替えるスクリプト（読み込み直さない。スクリプトが無くても ?sku= で同じ並びになる）。
 * 画像は [data-image-options]、SKU の選択肢は <option data-options> に JSON で載せる。固定の文字列（利用者の入力を含まない）
 */
export const SKU_IMAGE_SCRIPT = `(function(){
  var sel=document.getElementById("sku_id"),gal=document.querySelector(".gallery[data-sku-images]");
  if(!sel||!gal)return;
  var main=gal.querySelector("img[data-main]"),box=gal.querySelector(".thumbs");
  function opts(el,a){try{return JSON.parse(el.getAttribute(a)||"{}")||{};}catch(e){return {};}}
  function rank(io,so){var ks=Object.keys(io);if(!ks.length)return 0;for(var i=0;i<ks.length;i++){if(String(so[ks[i]]==null?"":so[ks[i]])!==io[ks[i]])return -1;}return ks.length;}
  function apply(){
    var o=sel.options[sel.selectedIndex];if(!o)return;var so=opts(o,"data-options");
    var items=[].slice.call(gal.querySelectorAll("[data-image-options]")).map(function(el,i){return {el:el,i:+el.getAttribute("data-index"),r:rank(opts(el,"data-image-options"),so)};});
    items.sort(function(a,b){return a.r===b.r?a.i-b.i:a.r===-1?1:b.r===-1?-1:b.r-a.r;});
    if(box)items.forEach(function(x){box.appendChild(x.el);});
    var f=items[0]&&items[0].el;
    if(main&&f){main.src=f.getAttribute("data-src");main.removeAttribute("width");main.removeAttribute("height");}
    try{var u=new URL(location.href);u.searchParams.set("sku",o.getAttribute("data-code")||"");history.replaceState(null,"",u.toString());}catch(e){}
  }
  sel.addEventListener("change",apply);
})();`;
