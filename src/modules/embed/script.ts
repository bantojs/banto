import { getLocale, t, type Locale } from "../../i18n";

/**
 * 貼れるタグ（同梱モジュール embed）のブラウザ側のスクリプト。docs/embed.md
 *
 * どのサイト（STUDIO・Wix・ペライチ・はてなブログ・手書きの LP…）にも貼れる Web Component:
 *   <banto-product shop product [sku]>   商品 1 つ（画像・価格・SKU の選択・カートに入れる）
 *   <banto-products shop [tag] [category] [brand] [sort] [limit] [product-url]>  商品の一覧（カードは商品ページへのリンク）
 *   <banto-buy-button shop sku [qty] [label] [mode=link]>  カートに入れる（mode=link なら購入リンクへ移るだけ）
 *   <banto-cart shop [expanded]>          カート（数量の変更・削除・小計・購入手続きへ）
 *
 * 決まりごと（docs/headless.md の段階 A / B の範囲だけ）:
 * - 呼ぶのは公開 API（`/api/shops/...`、CORS `*`、Cookie なし）とカート API だけ。会員の API・`/api/v1` は呼ばない。
 * - カートは署名付きトークンを貼った側のページの localStorage（`banto-cart-<shop>`、docs/headless.md のスニペットと同じ鍵）に持つ。
 *   配送先・最終確認（特商法）・決済は Banto の画面（応答の checkout_url）。購入手続きへ進んだら手元のトークンは捨てる
 *   （カートは Banto の画面の Cookie に移る。買い終えた後に古いカートが残らないように）。
 * - 金額は Banto が返した値を出すだけで、計算しない。
 * - 運営者が入れた文字列は textContent でだけ入れる（innerHTML を使わない）。画像の URL は http(s) だけ。
 * - Shadow DOM の中で描く。見た目は CSS の変数（--banto-accent など）だけを外から変えられる。
 * - 問い合わせ先（Banto の URL）はこのスクリプトを読み込んだ URL のオリジン。
 *
 * サーバー側では文字列を返すだけ（CPU を使わない）。Worker と Node の両方で同じ。
 * keepNames などのビルドの変換を受けないよう、関数ではなく文字列で持つ（中にバッククォートと「${」を書かない）。
 */
const SOURCE = String.raw`(function(I){
"use strict";
if(window.__bantoEmbed)return;window.__bantoEmbed=1;
var me=document.currentScript;var BASE="";
try{BASE=new URL(me&&me.src?me.src:"").origin}catch(e){}
if(!BASE||!window.customElements||!Element.prototype.attachShadow)return;
var nf=new Intl.NumberFormat(I.locale);
function yen(n){return I.yen.replace("{n}",nf.format(Number(n)||0))}
function safeUrl(u){try{var x=new URL(String(u),BASE);return x.protocol==="https:"||x.protocol==="http:"?x.href:""}catch(e){return ""}}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=String(text);return e}
function api(shop,path,opt){return fetch(BASE+"/api/shops/"+encodeURIComponent(shop)+path,opt).then(function(r){return r.json().then(function(v){return{ok:r.ok,status:r.status,v:v||{}}},function(){return{ok:false,status:r.status,v:{}}})},function(){return{ok:false,status:0,v:{}}})}
var mem={},views={},queues={},loading={};
function key(shop){return "banto-cart-"+shop}
function getTok(shop){try{return localStorage.getItem(key(shop))||""}catch(e){return mem[shop]||""}}
function setTok(shop,t){mem[shop]=t;try{if(t)localStorage.setItem(key(shop),t);else localStorage.removeItem(key(shop))}catch(e){}}
function publish(shop,v){views[shop]=v;window.dispatchEvent(new CustomEvent("banto:cart",{detail:{shop:shop,cart:v}}))}
function send(shop,body){var tok=getTok(shop);
if(!body)return api(shop,"/cart"+(tok?"?cart="+encodeURIComponent(tok):""));
var b={};for(var k in body)b[k]=body[k];if(tok)b.cart=tok;
return api(shop,"/cart",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)})}
/* 同じショップのカートの操作は 1 本ずつ（同じトークンから同時に足すと片方が消えるため） */
function cartOp(shop,body){
var q=(queues[shop]||Promise.resolve()).then(function(){
return send(shop,body).then(function(r){if(r.status===400&&r.v.error==="invalid_cart"){setTok(shop,"");return send(shop,body)}return r}).then(function(r){
if(!r.ok){var err=new Error(r.v.error||"error");throw err}
setTok(shop,r.v.cart);publish(shop,r.v);return r.v})});
queues[shop]=q.catch(function(){});return q}
function loadCart(shop){
if(views[shop])return Promise.resolve(views[shop]);
if(!getTok(shop))return Promise.resolve(null);
if(!loading[shop])loading[shop]=cartOp(shop,null).catch(function(){setTok(shop,"");return null}).then(function(v){loading[shop]=null;return v});
return loading[shop]}
window.addEventListener("storage",function(e){if(!e.key||e.key.indexOf("banto-cart-")!==0)return;var shop=e.key.slice(11);delete views[shop];
if(e.newValue)loadCart(shop);else publish(shop,null)});
function goCheckout(shop,url){var u=safeUrl(url);if(!u)return;setTok(shop,"");delete views[shop];location.href=u}
var CSS=":host{display:block;font:inherit;color:inherit}*{box-sizing:border-box}"+
".card{border:1px solid var(--banto-border,#d0d7de);border-radius:var(--banto-radius,6px);padding:12px;background:var(--banto-bg,transparent);height:100%}"+
"img{width:100%;aspect-ratio:1;object-fit:cover;display:block;border-radius:calc(var(--banto-radius,6px) - 2px);background:#f3f3f3}"+
".name{font-weight:600;margin:.5em 0 .25em;overflow-wrap:anywhere}.price{margin:0 0 .5em}.was{text-decoration:line-through;opacity:.6;margin-left:.5em;font-size:.9em}"+
"button,.btn{font:inherit;cursor:pointer;border:0;border-radius:var(--banto-radius,6px);padding:.55em 1.1em;background:var(--banto-accent,#1f6feb);color:var(--banto-accent-text,#fff);text-decoration:none;display:inline-block;line-height:1.3}"+
"button.sub{background:transparent;color:inherit;border:1px solid var(--banto-border,#d0d7de);padding:.15em .6em}"+
"button[disabled],.btn[aria-disabled=true]{opacity:.5;cursor:not-allowed;pointer-events:none}"+
"select{font:inherit;padding:.4em;margin:0 0 .5em;width:100%}.msg{font-size:.9em;margin:.5em 0 0}.msg a{color:inherit}.muted{opacity:.7;font-size:.9em}"+
".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--banto-card-min,160px),1fr));gap:var(--banto-gap,16px)}a.card{color:inherit;text-decoration:none;display:block}"+
".panel{border:1px solid var(--banto-border,#d0d7de);border-radius:var(--banto-radius,6px);padding:12px;margin-top:8px;background:var(--banto-panel-bg,#fff);color:var(--banto-panel-text,#1f2328)}"+
".line{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--banto-border,#d0d7de)}.line .n{flex:1;overflow-wrap:anywhere}"+
".qty{display:flex;gap:4px;align-items:center}.total{display:flex;justify-content:space-between;font-weight:600;margin:10px 0}";
function shadow(host){var root=host.shadowRoot||host.attachShadow({mode:"open"});root.textContent="";var s=el("style");s.textContent=CSS;root.appendChild(s);return root}
function attr(host,name){var v=host.getAttribute(name);return v==null?"":String(v).trim()}
function addedMsg(box,shop,v){box.textContent=I.added+" ";var a=el("a",null,I.checkout);a.href=safeUrl(v.checkout_url)||"#";a.addEventListener("click",function(e){e.preventDefault();goCheckout(shop,v.checkout_url)});box.appendChild(a)}
function errText(err){var c=err&&err.message;return c==="sku_not_available"?I.unavailable:I.error}
function skuLabel(k){if(k.name)return k.name;var o=k.options||{},parts=[];for(var a in o)parts.push(String(o[a]));return parts.length?parts.join(" / "):k.code}
function define(name,proto){if(customElements.get(name))return;var C=class extends HTMLElement{};for(var k in proto)C.prototype[k]=proto[k];customElements.define(name,C)}

define("banto-product",{connectedCallback:function(){if(this._done)return;this._done=1;var host=this,shop=attr(this,"shop"),slug=attr(this,"product");var root=shadow(this);var card=el("div","card");root.appendChild(card);
if(!shop||!slug){card.appendChild(el("p","muted",I.unavailable));return}
card.appendChild(el("p","muted",I.loading));
api(shop,"/products/"+encodeURIComponent(slug)).then(function(r){card.textContent="";
if(!r.ok||!r.v.product){card.appendChild(el("p","muted",I.unavailable));return}
var p=r.v.product,skus=p.skus||[],iv=(p.image_variants||[])[0];
if(iv){var src=safeUrl(iv.thumb||iv.url);if(src){var img=el("img");img.src=src;img.alt=p.name;img.loading="lazy";card.appendChild(img)}}
card.appendChild(el("div","name",p.name));var price=el("p","price");card.appendChild(price);
var want=attr(host,"sku"),cur=null;for(var i=0;i<skus.length;i++){if(skus[i].id===want){cur=skus[i];break}}
if(!cur){for(var j=0;j<skus.length;j++){if(skus[j].in_stock){cur=skus[j];break}}}if(!cur)cur=skus[0]||null;
var sel=null;if(skus.length>1){sel=el("select");sel.setAttribute("aria-label",I.choose);skus.forEach(function(k){var o=el("option",null,skuLabel(k)+(k.in_stock?"":" ("+I.soldOut+")"));o.value=k.id;if(cur&&k.id===cur.id)o.selected=true;sel.appendChild(o)});card.appendChild(sel)}
var btn=el("button",null,I.addToCart);btn.type="button";card.appendChild(btn);var msg=el("p","msg");msg.setAttribute("aria-live","polite");card.appendChild(msg);
function show(){price.textContent="";if(!cur){btn.disabled=true;return}price.appendChild(document.createTextNode(yen(cur.price_jpy)));if(cur.compare_at_price_jpy&&cur.compare_at_price_jpy>cur.price_jpy)price.appendChild(el("span","was",yen(cur.compare_at_price_jpy)));price.appendChild(el("span","muted"," "+I.taxIncluded));btn.disabled=!cur.in_stock;btn.textContent=cur.in_stock?I.addToCart:I.soldOut}
if(sel)sel.addEventListener("change",function(){for(var i=0;i<skus.length;i++)if(skus[i].id===sel.value)cur=skus[i];msg.textContent="";show()});
btn.addEventListener("click",function(){if(!cur)return;btn.disabled=true;msg.textContent="";cartOp(shop,{op:"add",sku_id:cur.id,qty:1}).then(function(v){addedMsg(msg,shop,v)},function(e){msg.textContent=errText(e)}).then(function(){btn.disabled=!cur.in_stock})});
show()})}});

define("banto-products",{connectedCallback:function(){if(this._done)return;this._done=1;var host=this,shop=attr(this,"shop");var root=shadow(this);var grid=el("div","grid");root.appendChild(grid);
if(!shop){grid.appendChild(el("p","muted",I.unavailable));return}
var q=[];["tag","category","brand","sort"].forEach(function(k){var v=attr(host,k);if(v)q.push(k+"="+encodeURIComponent(v))});
var lim=parseInt(attr(host,"limit"),10);q.push("limit="+(lim>0&&lim<=100?lim:12));
var tmpl=attr(host,"product-url");
api(shop,"/products?"+q.join("&")).then(function(r){
if(!r.ok||!r.v.products||!r.v.products.length){grid.appendChild(el("p","muted",I.empty));return}
r.v.products.forEach(function(p){var a=el("a","card");
var href=tmpl&&tmpl.indexOf("{slug}")>=0?safeUrl(tmpl.split("{slug}").join(encodeURIComponent(p.slug))):BASE+"/"+encodeURIComponent(shop)+"/p/"+encodeURIComponent(p.slug);a.href=href||"#";
var src=safeUrl(p.thumb||p.image||"");if(src){var img=el("img");img.src=src;img.alt=p.name;img.loading="lazy";a.appendChild(img)}
a.appendChild(el("div","name",p.name));if(p.min_price_jpy!=null)a.appendChild(el("div","price",I.from.replace("{price}",yen(p.min_price_jpy))));grid.appendChild(a)})})}});

define("banto-buy-button",{connectedCallback:function(){if(this._done)return;this._done=1;var shop=attr(this,"shop"),sku=attr(this,"sku"),label=attr(this,"label")||I.addToCart;var qty=parseInt(attr(this,"qty"),10);if(!(qty>0))qty=1;var root=shadow(this);
if(!shop||!sku){root.appendChild(el("span","muted",I.unavailable));return}
if(attr(this,"mode")==="link"){var a=el("a","btn",label);a.href=BASE+"/"+encodeURIComponent(shop)+"/buy?sku="+encodeURIComponent(sku)+"&qty="+qty;root.appendChild(a);return}
var btn=el("button",null,label);btn.type="button";root.appendChild(btn);var msg=el("p","msg");msg.setAttribute("aria-live","polite");root.appendChild(msg);
btn.addEventListener("click",function(){btn.disabled=true;msg.textContent="";cartOp(shop,{op:"add",sku_id:sku,qty:qty}).then(function(v){addedMsg(msg,shop,v)},function(e){msg.textContent=errText(e)}).then(function(){btn.disabled=false})})}});

define("banto-cart",{connectedCallback:function(){if(this._done)return;this._done=1;var host=this,shop=attr(this,"shop");var root=shadow(this);var expanded=this.hasAttribute("expanded");var open=expanded;
var toggle=el("button");toggle.type="button";toggle.setAttribute("aria-expanded",String(open));var panel=el("div","panel");
if(!expanded)root.appendChild(toggle);root.appendChild(panel);
function render(v){var n=v?v.count:0;toggle.textContent=I.cart.replace("{count}",String(n));panel.hidden=!open;panel.textContent="";
if(!v||!v.items||!v.items.length){panel.appendChild(el("p","muted",I.cartEmpty));return}
if(v.removed&&v.removed.length)panel.appendChild(el("p","msg",I.removed));
v.items.forEach(function(it){var line=el("div","line");var nm=el("div","n");nm.appendChild(el("div",null,it.product_name));if(it.sku_name)nm.appendChild(el("div","muted",it.sku_name));if(it.short)nm.appendChild(el("div","msg",I.short));line.appendChild(nm);
var qb=el("div","qty");var minus=el("button","sub","−");minus.type="button";minus.setAttribute("aria-label",I.decrease);var plus=el("button","sub","+");plus.type="button";plus.setAttribute("aria-label",I.increase);
var rm=el("button","sub",I.remove);rm.type="button";
minus.addEventListener("click",function(){op({op:"set",sku_id:it.sku_id,qty:it.qty-1})});plus.addEventListener("click",function(){op({op:"set",sku_id:it.sku_id,qty:it.qty+1})});rm.addEventListener("click",function(){op({op:"remove",sku_id:it.sku_id})});
qb.appendChild(minus);qb.appendChild(el("span",null,String(it.qty)));qb.appendChild(plus);qb.appendChild(rm);line.appendChild(qb);line.appendChild(el("div",null,yen(it.line_total_jpy)));panel.appendChild(line)});
var tot=el("div","total");tot.appendChild(el("span",null,I.subtotal));tot.appendChild(el("span",null,yen(v.subtotal_jpy)));panel.appendChild(tot);
if(v.shipping&&v.shipping.remaining_for_free_jpy)panel.appendChild(el("p","muted",I.freeShipping.replace("{price}",yen(v.shipping.remaining_for_free_jpy))));
var go=el("a","btn",I.checkout);go.href=safeUrl(v.checkout_url)||"#";if(!v.can_checkout)go.setAttribute("aria-disabled","true");
go.addEventListener("click",function(e){e.preventDefault();if(v.can_checkout)goCheckout(shop,v.checkout_url)});panel.appendChild(go);panel.appendChild(el("p","muted",I.checkoutNote))}
function op(body){cartOp(shop,body).catch(function(){var m=el("p","msg",I.error);panel.appendChild(m)})}
toggle.addEventListener("click",function(){open=!open;toggle.setAttribute("aria-expanded",String(open));render(views[shop]||null)});
window.addEventListener("banto:cart",function(e){if(e.detail&&e.detail.shop===shop)render(e.detail.cart)});
if(!shop){panel.hidden=false;panel.appendChild(el("p","muted",I.unavailable));return}
render(views[shop]||null);loadCart(shop).then(function(v){render(v)})}});
})(__BANTO_I18N__);
`;

const KEYS = {
  addToCart: "embed.js.add_to_cart",
  added: "embed.js.added",
  checkout: "embed.js.checkout",
  checkoutNote: "embed.js.checkout_note",
  soldOut: "embed.js.sold_out",
  unavailable: "embed.js.unavailable",
  error: "embed.js.error",
  loading: "embed.js.loading",
  choose: "embed.js.choose",
  taxIncluded: "embed.js.tax_included",
  from: "embed.js.from",
  empty: "embed.js.empty",
  cart: "embed.js.cart",
  cartEmpty: "embed.js.cart_empty",
  removed: "embed.js.removed",
  short: "embed.js.short",
  decrease: "embed.js.decrease",
  increase: "embed.js.increase",
  remove: "embed.js.remove",
  subtotal: "embed.js.subtotal",
  freeShipping: "embed.js.free_shipping",
  yen: "embed.js.yen",
} as const;

const built = new Map<Locale, string>();

/** 配るスクリプト（ロケールはデプロイ単位なので、ロケールごとに 1 回だけ組み立てて持っておく） */
export function embedScript(locale: Locale = getLocale()): string {
  const hit = built.get(locale);
  if (hit) return hit;
  const strings: Record<string, string> = { locale: locale === "ja" ? "ja-JP" : "en-US" };
  for (const [k, key] of Object.entries(KEYS)) strings[k] = t(key, locale);
  // スクリプトのファイルとして配るが、念のため < と行区切りの文字は \u で書く（文言から文脈を抜けさせない）
  const json = JSON.stringify(strings).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const js = SOURCE.replace("__BANTO_I18N__", json);
  built.set(locale, js);
  return js;
}

/** スクリプトの URL（版つき。形を変えるときは v2 を足し、v1 はしばらく残す） */
export const EMBED_SCRIPT_PATH = "/api/embed/v1.js";
