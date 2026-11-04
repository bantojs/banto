/**
 * 同梱モジュール「お店の画面のダイアログ」（dialogs、既定 OFF。0110_mod_dialogs、メンテナの決定 2026-11-04、docs/dialogs.md）。
 *
 * - 判定するのは「今の訪問・今のページで分かること」だけ（線引きは banto-internal の 32 §13.2）:
 *   だれに（ゲスト・会員・会員の条件）とどのページで（種類・商品・カテゴリー・タグ）はサーバーが決めて、当てはまるものだけをページに載せる。
 *   きっかけ（秒数・スクロール・離脱しそう・今回の訪問のページ数・カートの金額）と回数（1 回の訪問に 1 回、閉じたら n 日出さない）はブラウザが決める。
 *   履歴・待ち・集計は持たない（MA は外部プラグイン）。Banto は何も溜めない
 * - 中身は決まった形だけ（見出し・本文・https の画像・ボタン 2 つ・公開のクーポンコード）。スクリプトが textContent で描く（HTML を受けない）
 * - レジ（配送先・最終確認）・会員ページ・注文照会などには出さない（特商法の最終確認と個人情報の画面に重ねない）
 * - 出した・閉じた・押したは中立の出来事（dialog_view・dialog_close・dialog_click）。GA4（gtag があれば）と行動の中継（banto.track があれば）へ。
 *   きっかけはブラウザの申告なので偽れる。ダイアログで渡すのは偽られても困らないもの（案内・公開のクーポン。上限と 1 人 1 回は DB が縛る）
 */
import { t } from "../../i18n";
import type { PublicShop } from "../../storefront/data";
import type { ShopEvent } from "../../storefront/events";
import type { HeadTag, StorefrontHeadContributor } from "../../storefront/head";

export const DIALOGS_MODULE = "dialogs";
export const DIALOGS_MIGRATION = "0110_mod_dialogs";

export const DIALOG_PAGE_KINDS = ["all", "home", "product", "list", "article", "page", "cart"] as const;
export type DialogPageKind = (typeof DIALOG_PAGE_KINDS)[number];
export const DIALOG_LAYOUTS = ["bar", "modal", "corner"] as const;
export type DialogLayout = (typeof DIALOG_LAYOUTS)[number];
export const DIALOG_AUDIENCES = ["all", "guests", "members", "audience"] as const;
export type DialogAudience = (typeof DIALOG_AUDIENCES)[number];

export interface DialogTrigger {
  delay_s?: number;
  scroll_pct?: number;
  exit_intent?: boolean;
  visit_pages?: number;
  cart_min_jpy?: number;
}

/** 公開のショップ行に載る形（banto_shop_public_json の dialogs） */
export interface PublicDialog {
  id: string;
  layout: DialogLayout;
  title: string;
  body: string;
  image_url: string | null;
  buttons: { label: string; url: string }[];
  coupon_code: string | null;
  audience: DialogAudience;
  audience_id: string | null;
  pages: { kinds: DialogPageKind[]; products?: string[]; categories?: string[]; tags?: string[] };
  trigger: DialogTrigger;
  snooze_days: number;
}

/** 今のページ（お店の画面のパスと、そのページで積んだ出来事から） */
export interface DialogPage {
  kind: Exclude<DialogPageKind, "all">;
  product?: { id: string; category_id?: string | null; tags?: string[] };
  article?: { tags?: string[] };
}

const LIST_QUERY = /(^|[?&])(category|tag|brand|q|sort|page|all)=/;

/**
 * ショップの中のパス（/p/tee など。ショップのスラッグは除いたもの）から、ダイアログを出してよいページの種類を決める。
 * 出さないページ（レジ・会員ページ・注文照会・試着・お問い合わせ・内部の道など）は null
 */
export function dialogPageOf(path: string, search: string, events: readonly ShopEvent[]): DialogPage | null {
  const p = path === "" ? "/" : path;
  if (p === "/") return { kind: LIST_QUERY.test(search) ? "list" : "home" };
  if (/^\/p\/[^/]+$/.test(p)) {
    const ev = events.find((e) => e.type === "product_view" && e.product);
    const prod = ev?.product;
    return { kind: "product", ...(prod ? { product: { id: prod.id, category_id: prod.category_id ?? null, tags: prod.tags ?? [] } } : {}) };
  }
  if (p === "/search") return { kind: "list" };
  if (/^\/blogs\/[^/]+(\/[^/]+)?$/.test(p) && !p.endsWith("/feed.atom")) {
    const ev = events.find((e) => e.type === "article_view" && e.article);
    return { kind: "article", ...(ev?.article ? { article: { tags: ev.article.tags ?? [] } } : {}) };
  }
  if (/^\/pages\/[^/]+$/.test(p) || /^\/(legal|privacy|returns|shipping|stores)$/.test(p)) return { kind: "page" };
  if (p === "/cart") return { kind: "cart" };
  return null;
}

/** そのページ・その人に出すダイアログ（サーバーで決める。きっかけと回数はブラウザ） */
export function dialogsFor(list: readonly PublicDialog[], page: DialogPage, viewer: { member: boolean; audienceOk: (id: string) => boolean }): PublicDialog[] {
  return list.filter((d) => {
    const kinds = d.pages?.kinds ?? ["all"];
    if (!kinds.includes("all") && !kinds.includes(page.kind)) return false;
    // 商品・カテゴリー・タグを選んだものは、合う商品・記事のページだけ（どれか 1 つが合えば）
    const products = d.pages?.products ?? [];
    const categories = d.pages?.categories ?? [];
    const tags = d.pages?.tags ?? [];
    if (products.length + categories.length + tags.length > 0) {
      const target = page.product ?? page.article;
      if (!target) return false;
      const hit =
        (page.product && products.includes(page.product.id)) ||
        (page.product?.category_id && categories.includes(page.product.category_id)) ||
        (target.tags ?? []).some((x) => tags.includes(x));
      if (!hit) return false;
    }
    switch (d.audience) {
      case "guests":
        return !viewer.member;
      case "members":
        return viewer.member;
      case "audience":
        return Boolean(d.audience_id) && viewer.audienceOk(d.audience_id!);
      default:
        return true;
    }
  });
}

/** <script> の中に置く JSON（</script> や <!-- で抜けさせない） */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/** ブラウザに渡す分（だれに・どのページは決め済みなので落とす） */
const forBrowser = (d: PublicDialog) => ({ id: d.id, layout: d.layout, title: d.title, body: d.body, image_url: d.image_url, buttons: d.buttons, coupon_code: d.coupon_code, trigger: d.trigger ?? {}, snooze_days: d.snooze_days });

/**
 * ブラウザのスクリプト。きっかけを見て、1 ページに 1 つだけ出す。
 *   - 今回の訪問: localStorage の banto_dv（最後に開いてから 30 分で新しい訪問）。ページ数と、この訪問で出したダイアログ
 *   - カートの金額: カートの画面で積んだ cart_view の値を sessionStorage の banto_dc に覚える
 *   - 閉じた・押した: localStorage の banto_dlg_<id> に「この時刻まで出さない」
 * 描くのは Shadow DOM の中で、文字は textContent だけ。色と角はテーマの CSS の変数（--banto-dialog-*）
 */
export function dialogScript(base: string, dialogs: readonly PublicDialog[], cartTotal: number | null): string {
  const words = { close: t("dlg.js.close"), copy: t("dlg.js.copy"), copied: t("dlg.js.copied"), coupon: t("dlg.js.coupon") };
  return `(function(){var D=${scriptJson(dialogs.map(forBrowser))},B=${scriptJson(base)},W=${scriptJson(words)},CT=${cartTotal === null ? "null" : String(cartTotal)};
if(!D.length||!Element.prototype.attachShadow)return;var now=Date.now(),V={};
function ls(k,v){try{if(v===undefined)return JSON.parse(localStorage.getItem(k)||"null");localStorage.setItem(k,JSON.stringify(v))}catch(e){return null}}
V=ls("banto_dv")||{};if(!V.s||now-(V.t||0)>1800000)V={s:now,n:0,d:[]};V.n=(V.n||0)+1;V.t=now;V.d=V.d||[];ls("banto_dv",V);
var cart=CT;try{if(cart!==null)sessionStorage.setItem("banto_dc",String(cart));else{var c=sessionStorage.getItem("banto_dc");cart=c===null?null:Number(c)}}catch(e){}
function ev(t,d,x){var p={dialog_id:d.id};if(x!==undefined)p.index=x;try{if(window.banto&&banto.track)banto.track(t,{dialog_id:d.id})}catch(e){}try{if(window.gtag)gtag("event","banto_"+t,p)}catch(e){}}
var open=false;
function seen(d){var v=ls("banto_dv")||V;v.d=v.d||[];if(v.d.indexOf(d.id)<0)v.d.push(d.id);ls("banto_dv",v)}
function snooze(d){if(d.snooze_days>0)ls("banto_dlg_"+d.id,now+d.snooze_days*86400000);seen(d)}
function url(u){return u.charAt(0)==="/"?B+(u==="/"?"":u):u}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=String(x);return e}
var CSS=":host{all:initial}.w{position:fixed;z-index:2147483000;font:15px/1.6 system-ui,sans-serif;color:var(--banto-dialog-text,#1f2328)}.ov{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147482999}"+
".box{background:var(--banto-dialog-bg,#fff);border-radius:var(--banto-dialog-radius,10px);box-shadow:0 8px 30px rgba(0,0,0,.25);padding:20px;position:relative;max-height:90vh;overflow:auto}"+
".modal{inset:0;display:flex;align-items:center;justify-content:center;padding:16px}.modal .box{width:min(440px,100%)}"+
".bar{left:0;right:0;bottom:0}.bar .box{border-radius:var(--banto-dialog-radius,10px) var(--banto-dialog-radius,10px) 0 0;max-width:720px;margin:0 auto}"+
".corner{right:16px;bottom:16px;width:min(340px,calc(100vw - 32px))}"+
"h2{font-size:1.15em;margin:0 32px 8px 0}p{margin:0 0 12px;white-space:pre-line}img{display:block;width:100%;height:auto;border-radius:6px;margin:0 0 12px}"+
".x{position:absolute;top:8px;right:8px;border:0;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:inherit;padding:6px}"+
".btns{display:flex;gap:8px;flex-wrap:wrap}.btn{display:inline-block;padding:.55em 1.1em;border-radius:6px;background:var(--banto-dialog-accent,#1f6feb);color:var(--banto-dialog-accent-text,#fff);text-decoration:none}"+
".btn.sub{background:transparent;color:inherit;border:1px solid currentColor}.cp{display:flex;gap:8px;align-items:center;margin:0 0 12px}.code{font-family:ui-monospace,monospace;font-weight:700;border:1px dashed currentColor;padding:.3em .7em;border-radius:6px}"+
".cp button{font:inherit;cursor:pointer;border:1px solid currentColor;background:transparent;color:inherit;border-radius:6px;padding:.3em .8em}";
function show(d){if(open)return;open=true;var host=el("div");host.setAttribute("data-banto-dialog",d.id);var root=host.attachShadow({mode:"open"});var st=el("style");st.textContent=CSS;root.appendChild(st);
var prev=document.activeElement,ov=null;if(d.layout==="modal"){ov=el("div","ov");root.appendChild(ov)}
var w=el("div","w "+d.layout),box=el("div","box");box.setAttribute("role","dialog");if(d.layout==="modal")box.setAttribute("aria-modal","true");box.setAttribute("aria-labelledby","t");w.appendChild(box);
var h=el("h2",null,d.title);h.id="t";box.appendChild(h);
if(d.image_url&&/^https:\\/\\//.test(d.image_url)){var im=el("img");im.src=d.image_url;im.alt="";box.appendChild(im)}
if(d.body)box.appendChild(el("p",null,d.body));
if(d.coupon_code){var cp=el("div","cp");cp.appendChild(el("span",null,W.coupon));cp.appendChild(el("span","code",d.coupon_code));var cb=el("button",null,W.copy);cb.type="button";cb.addEventListener("click",function(){try{navigator.clipboard.writeText(d.coupon_code).then(function(){cb.textContent=W.copied})}catch(e){}});cp.appendChild(cb);box.appendChild(cp)}
if(d.buttons&&d.buttons.length){var bs=el("div","btns");d.buttons.forEach(function(b,i){var a=el("a","btn"+(i?" sub":""),b.label);a.href=url(b.url);a.addEventListener("click",function(){ev("dialog_click",d,i);snooze(d)});bs.appendChild(a)});box.appendChild(bs)}
var x=el("button","x","\\u00d7");x.type="button";x.setAttribute("aria-label",W.close);box.appendChild(x);
function close(){if(!host.parentNode)return;host.parentNode.removeChild(host);document.removeEventListener("keydown",key,true);ev("dialog_close",d);snooze(d);try{if(prev&&prev.focus)prev.focus()}catch(e){}}
function key(e){if(e.key==="Escape")close()}
x.addEventListener("click",close);if(ov)ov.addEventListener("click",close);document.addEventListener("keydown",key,true);
root.appendChild(w);document.body.appendChild(host);try{x.focus()}catch(e){}seen(d);ev("dialog_view",d)}
function start(){D.forEach(function(d){var tr=d.trigger||{};
if(V.d.indexOf(d.id)>=0)return;var until=ls("banto_dlg_"+d.id);if(typeof until==="number"&&until>now)return;
if(tr.visit_pages&&V.n<tr.visit_pages)return;
var need={delay:true,scroll:!tr.scroll_pct,exit:!tr.exit_intent};
function check(){if(need.delay&&need.scroll&&need.exit){if(tr.cart_min_jpy&&!(cart!==null&&cart>=tr.cart_min_jpy))return;show(d)}}
need.delay=false;setTimeout(function(){need.delay=true;check()},(tr.delay_s||0)*1000);
if(tr.scroll_pct)addEventListener("scroll",function s(){var h=document.documentElement,max=h.scrollHeight-innerHeight;if(max<=0||(scrollY/max)*100>=tr.scroll_pct){need.scroll=true;removeEventListener("scroll",s);check()}},{passive:true});
if(tr.exit_intent)document.addEventListener("mouseout",function m(e){if(!e.relatedTarget&&e.clientY<=0){need.exit=true;document.removeEventListener("mouseout",m);check()}})})}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();})();`;
}

export interface DialogHeadExtra {
  member: boolean;
  base: string;
  path?: string;
  search?: string;
  audienceOk?: (id: string) => boolean;
}

/** カートの画面で積んだ cart_view の金額（カートの合計）。ほかのページでは null（ブラウザが覚えた値を使う） */
const cartTotalOf = (events: readonly ShopEvent[]): number | null => {
  const e = events.find((x) => x.type === "cart_view");
  return e ? e.value_jpy : null;
};

export const dialogsHead: StorefrontHeadContributor = {
  module: DIALOGS_MODULE,
  tags(shop: PublicShop, events, extra): HeadTag[] {
    const list = shop.dialogs ?? [];
    if (!extra || list.length === 0 || extra.path === undefined) return [];
    const page = dialogPageOf(extra.path, extra.search ?? "", events);
    if (!page) return [];
    const picked = dialogsFor(list, page, { member: extra.member, audienceOk: extra.audienceOk ?? (() => false) });
    if (picked.length === 0) return [];
    return [{ kind: "inline-script", code: dialogScript(extra.base, picked, cartTotalOf(events)) }];
  },
};
