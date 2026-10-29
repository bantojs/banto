/**
 * SKU を分ける軸（0065、人間の決定 2026-10-28。docs/knowledge/02-decisions.md）。
 *   - 形: [{ key: "カラー", values: ["レッド", ...] }, ...]（3 つまで）。[] = 品番だけ。null = 決めていない（SKU の options は自由）
 *   - ショップ → カテゴリー（親から子へ）→ 商品の順に「ひな形」を引き継ぎ、商品を作ったとき・主カテゴリーを決めたときに商品へ写す（DB のトリガー）
 *   - 守る（鍵がちょうど同じ・組み合わせが重ならない）のは DB。ここは画面とお店の表示のための判定だけ
 */
import type { CategoryRow } from "../db/types";

export const MAX_AXES = 3;
export const MAX_AXIS_VALUES = 100;
/** 組み合わせの一括作成で 1 回に作る SKU の上限 */
export const MAX_COMBINATIONS = 100;

export interface OptionAxis {
  key: string;
  values?: string[];
}
export type OptionAxes = OptionAxis[];

type Options = Record<string, unknown> | null | undefined;

/** DB の値 → 軸（壊れた値は null = 決めていない扱い） */
export function optionAxesOf(v: unknown): OptionAxes | null {
  if (!Array.isArray(v)) return null;
  const out: OptionAxes = [];
  for (const a of v.slice(0, MAX_AXES)) {
    if (!a || typeof a !== "object") return null;
    const key = (a as Record<string, unknown>)["key"];
    if (typeof key !== "string" || !key) return null;
    const values = (a as Record<string, unknown>)["values"];
    out.push(Array.isArray(values) ? { key, values: values.filter((x): x is string => typeof x === "string") } : { key });
  }
  return out;
}

const valueText = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

/** SKU の options が軸に合うか（DB の banto_sku_fits_axes と同じ） */
export function skuFitsAxes(options: Options, axes: OptionAxes): boolean {
  const o = options ?? {};
  const keys = Object.keys(o).sort();
  const want = axes.map((a) => a.key).sort();
  return keys.length === want.length && keys.every((k, i) => k === want[i]) && Object.values(o).every((v) => valueText(v) !== "");
}

/** 今の SKU から軸を推す（どの SKU も同じ鍵を持つときだけ。鍵の順は最初の SKU、値は出てくる順）。推せなければ null */
export function inferOptionAxes(skus: readonly { options?: Options }[]): OptionAxes | null {
  if (skus.length === 0) return null;
  const first = Object.keys(skus[0]!.options ?? {});
  if (first.length === 0 || first.length > MAX_AXES) return skus.every((s) => Object.keys(s.options ?? {}).length === 0) ? [] : null;
  const sorted = [...first].sort().join("\u0000");
  if (!skus.every((s) => Object.keys(s.options ?? {}).sort().join("\u0000") === sorted)) return null;
  return first.map((key) => {
    const values: string[] = [];
    for (const s of skus) {
      const v = valueText((s.options ?? {})[key]);
      if (v && !values.includes(v) && values.length < MAX_AXIS_VALUES) values.push(v);
    }
    return { key, values };
  });
}

/** お店の画面で軸ごとの選択欄を出す軸。商品で決めていればそれ、決めていなければ SKU から推す（2 つ以上の SKU のときだけ） */
export function displayOptionAxes(axes: unknown, skus: readonly { options?: Options }[]): OptionAxes {
  const decided = optionAxesOf(axes);
  if (decided) return decided;
  return skus.length > 1 ? (inferOptionAxes(skus) ?? []) : [];
}

/** 上の段（主カテゴリーから上へ、無ければショップ）の軸。DB の banto_option_axes_resolve と同じ。from は画面に出す出どころ */
export function resolveOptionAxes(categories: readonly CategoryRow[], categoryId: string | null | undefined, shopAxes: unknown): { axes: OptionAxes | null; from: { kind: "category"; name: string } | { kind: "shop" } | null } {
  const byId = new Map(categories.map((c) => [c.id, c]));
  let cur = categoryId ? byId.get(categoryId) : undefined;
  for (let i = 0; cur && i < 10; i++) {
    const axes = optionAxesOf(cur.option_axes);
    if (cur.option_axes !== null && cur.option_axes !== undefined && axes) return { axes, from: { kind: "category", name: cur.name } };
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  const shop = optionAxesOf(shopAxes);
  return shop ? { axes: shop, from: { kind: "shop" } } : { axes: null, from: null };
}

/**
 * 値の候補の入力（1 行に 1 つ）→ 配列（重なり・空を外す）。区切りは改行だけ（値にカンマや読点を入れられるように）。
 * 管理画面のチップの入力（src/routes/admin/option-axes.tsx の CHIPS_SCRIPT）も、同じ欄に 1 行に 1 つで書く
 */
export function parseAxisValues(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const v = raw.trim().slice(0, 60);
    if (v && !out.includes(v) && out.length < MAX_AXIS_VALUES) out.push(v);
  }
  return out;
}

/** 管理画面の入力（axis.0.key / axis.0.values …）→ 軸。鍵の空の行は外す。mode が none / inherit なら null（決めない・引き継ぐ）、only_code なら [] */
export function optionAxesFromForm(f: Record<string, string>): OptionAxes | null | "invalid" {
  const mode = f["axes_mode"] ?? "axes";
  if (mode === "none" || mode === "inherit") return null;
  if (mode === "only_code") return [];
  const out: OptionAxes = [];
  for (let i = 0; i < MAX_AXES; i++) {
    const key = (f[`axis.${i}.key`] ?? "").trim();
    if (!key) continue;
    if (key.length > 40 || out.some((a) => a.key === key)) return "invalid";
    const values = parseAxisValues(f[`axis.${i}.values`] ?? "");
    out.push(values.length > 0 ? { key, values } : { key });
  }
  return out.length > 0 ? out : "invalid";
}

/** 軸を表示する短い文（「カラー × サイズ」・「品番だけ」） */
export function axesLabel(axes: OptionAxes | null, onlyCode: string, none: string): string {
  if (!axes) return none;
  return axes.length === 0 ? onlyCode : axes.map((a) => a.key).join(" × ");
}

/** 選んだ値（軸ごと）の組み合わせを全部。上限を超えたら null */
export function combinations(axes: OptionAxes, chosen: Record<string, string[]>): Record<string, string>[] | null {
  let out: Record<string, string>[] = [{}];
  for (const a of axes) {
    const vals = chosen[a.key] ?? [];
    if (vals.length === 0) return [];
    const next: Record<string, string>[] = [];
    for (const o of out) for (const v of vals) next.push({ ...o, [a.key]: v });
    if (next.length > MAX_COMBINATIONS) return null;
    out = next;
  }
  return out;
}

/** 品番のひな形（{カラー} などを値に置き換える）。SKU の code は 100 文字まで */
export function codeFromPattern(pattern: string, options: Record<string, string>): string {
  return pattern.replace(/\{([^{}]{1,40})\}/g, (m, k: string) => (k in options ? options[k]! : m)).trim().slice(0, 100);
}

/**
 * お店の商品ページで、軸ごとの選択欄に組み替えるスクリプト（スクリプトが無ければ今の 1 つの選択欄のまま）。
 * 軸は .variant[data-axes]、SKU は <option data-options data-code> に JSON で載せる。固定の文字列（利用者の入力を含まない）。
 * 在庫の無い組み合わせは選べないようにし（選んでいた値が選べなくなったら、選べる最初の値へ移す）、元の選択欄（#sku_id）を合う SKU に合わせる（SKU ごとの画像のスクリプトもそれを聞く）。
 * 価格と在庫の表示は元の選択肢の文（「レッド / M — ¥3,000」の後ろ）を [data-axes-price] に写す
 */
export const OPTION_AXES_SCRIPT = `(function(){
  var sel=document.getElementById("sku_id"),box=sel&&sel.closest("[data-axes]");
  if(!sel||!box)return;
  var axes;try{axes=JSON.parse(box.getAttribute("data-axes")||"[]");}catch(e){return;}
  if(!axes.length)return;
  var skus=[].slice.call(sel.options).map(function(o){var v={};try{v=JSON.parse(o.getAttribute("data-options")||"{}")||{};}catch(e){}return {o:o,v:v,ok:!o.disabled};});
  var cur=(skus.filter(function(s){return s.o.selected;})[0]||skus[0]||{v:{}}).v,wrap=document.createElement("div"),pickers=[];
  axes.forEach(function(a,i){
    var id="axis_"+i,l=document.createElement("label"),s=document.createElement("select");
    l.setAttribute("for",id);l.textContent=a.key;s.id=id;
    var vals=[];skus.forEach(function(k){var v=String(k.v[a.key]==null?"":k.v[a.key]);if(v&&vals.indexOf(v)<0)vals.push(v);});
    vals.forEach(function(v){var o=document.createElement("option");o.value=v;o.textContent=v;if(String(cur[a.key])===v)o.selected=true;s.appendChild(o);});
    s.addEventListener("change",apply);wrap.appendChild(l);wrap.appendChild(s);pickers.push({a:a,s:s});
  });
  function picked(){var p={};pickers.forEach(function(x){p[x.a.key]=x.s.value;});return p;}
  function match(k,p,upto){for(var i=0;i<upto;i++){var key=pickers[i].a.key;if(String(k.v[key])!==p[key])return false;}return true;}
  function apply(){
    pickers.forEach(function(x,i){
      var p=picked();
      [].slice.call(x.s.options).forEach(function(o){var q=Object.assign({},p);q[x.a.key]=o.value;o.disabled=!skus.some(function(k){return k.ok&&match(k,q,i+1);});});
      var now=x.s.options[x.s.selectedIndex],first=[].slice.call(x.s.options).filter(function(o){return !o.disabled;})[0];
      if(now&&now.disabled&&first)x.s.value=first.value;
    });
    var p=picked(),hit=skus.filter(function(k){return match(k,p,pickers.length);})[0];
    if(hit){sel.value=hit.o.value;sel.dispatchEvent(new Event("change"));}
    var price=box.querySelector("[data-axes-price]");if(price)price.textContent=hit?(hit.o.textContent||"").split(" — ").slice(1).join(" — ").trim():"";
    var btn=box.querySelector("button[type=submit]");if(btn)btn.disabled=!(hit&&hit.ok);
  }
  sel.style.display="none";var lab=box.querySelector("label[for=sku_id]");if(lab)lab.style.display="none";
  sel.parentNode.insertBefore(wrap,sel);apply();
})();`;
