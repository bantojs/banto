/**
 * 会員のお気に入り（同梱モジュール favorites、0123_mod_favorites、メンテナの決定 2026-11-06、docs/favorites.md）。
 *
 * - テーマは押すところに `data-banto-favorite="<商品 id>"` を付けるだけ。Banto のスクリプト（お店の画面の <head> の口）が押せるようにする
 * - 会員: 押してあるかはページの HTML に入れない（キャッシュを崩さない）。スクリプトが自分の一覧を 1 回取って塗る
 * - ゲスト: ブラウザ（localStorage）に GUEST_FAVORITES_MAX まで覚える。ログインしたら会員へ移してブラウザの分を消す
 * - 押したら中立の出来事 favorite_add / favorite_remove（行動の中継と GA4 の add_to_wishlist）と、DOM の banto:favorite
 */
import type { PublicShop } from "../../storefront/data";
import type { HeadTag, StorefrontHeadContributor } from "../../storefront/head";
import { moduleEnabled } from "../registry";

export const FAVORITES_MODULE = "favorites";
export const FAVORITES_MIGRATION = "0123_mod_favorites";
/** 1 人のお気に入りの上限（DB の banto_favorites_limit と同じ） */
export const FAVORITES_MAX = 200;
/** ゲストがブラウザに覚える数（DB の member_favorites_merge が受ける数と同じ） */
export const GUEST_FAVORITES_MAX = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const favoritesEnabled = (shop: Pick<PublicShop, "settings">): boolean => moduleEnabled(shop.settings, FAVORITES_MODULE);

/** 書き込みの本文（{ product_id, on } か { merge: [...] }）。形が違えば null */
export function parseFavoriteBody(v: unknown): { kind: "set"; productId: string; on: boolean } | { kind: "merge"; productIds: string[] } | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Array.isArray(o["merge"])) {
    const ids = [...new Set(o["merge"].filter((x): x is string => typeof x === "string" && UUID.test(x)).map((x) => x.toLowerCase()))];
    return o["merge"].length <= GUEST_FAVORITES_MAX ? { kind: "merge", productIds: ids } : null;
  }
  const id = o["product_id"];
  if (typeof id !== "string" || !UUID.test(id) || typeof o["on"] !== "boolean") return null;
  return { kind: "set", productId: id.toLowerCase(), on: o["on"] };
}

const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/**
 * お店の画面のスクリプト。u: 会員の一覧・書き込みの口（会員機能が OFF なら null = ブラウザだけ）、m: 会員としてログイン中か、k: ブラウザに覚える鍵
 */
export function favoritesScript(cfg: { url: string | null; member: boolean; key: string }): string {
  return `(function(){var U=${json(cfg.url)},M=${cfg.member ? "true" : "false"},K=${json(cfg.key)},X=${GUEST_FAVORITES_MAX},S={};
function ld(){try{var a=JSON.parse(localStorage.getItem(K)||"[]");return Array.isArray(a)?a.filter(function(x){return typeof x==="string"}).slice(0,X):[]}catch(e){return[]}}
function sv(a){try{if(a.length)localStorage.setItem(K,JSON.stringify(a.slice(0,X)));else localStorage.removeItem(K)}catch(e){}}
function paint(){var l=document.querySelectorAll("[data-banto-favorite]");for(var i=0;i<l.length;i++){var b=l[i],on=!!S[b.getAttribute("data-banto-favorite")];b.setAttribute("aria-pressed",on?"true":"false");if(b.classList)b.classList.toggle("is-active",on)}}
function ev(id,on){var t=on?"favorite_add":"favorite_remove";try{if(window.banto&&banto.track)banto.track(t,{product_id:id})}catch(e){}try{if(on&&window.gtag)gtag("event","add_to_wishlist",{items:[{item_id:id}]})}catch(e){}try{window.dispatchEvent(new CustomEvent("banto:favorite",{detail:{product_id:id,on:on}}))}catch(e){}}
function post(b){return fetch(U,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)})}
function toggle(id){var on=!S[id];if(on)S[id]=1;else delete S[id];paint();ev(id,on);
if(M){post({product_id:id,on:on}).then(function(r){if(!r.ok){if(on)delete S[id];else S[id]=1;paint()}}).catch(function(){})}
else{var a=ld().filter(function(x){return x!==id});if(on)a.unshift(id);sv(a)}}
function init(){document.addEventListener("click",function(e){var b=e.target&&e.target.closest?e.target.closest("[data-banto-favorite]"):null;if(!b)return;e.preventDefault();var id=b.getAttribute("data-banto-favorite");if(id)toggle(id)});
if(M&&U){var g=ld(),go=function(){fetch(U+".json",{credentials:"same-origin"}).then(function(r){return r.ok?r.json():null}).then(function(j){if(j&&j.ids){S={};for(var i=0;i<j.ids.length;i++)S[j.ids[i]]=1;paint()}}).catch(function(){})};
if(g.length)post({merge:g}).then(function(r){if(r.ok)sv([])}).catch(function(){}).then(go);else go()}
else{var a=ld();for(var i=0;i<a.length;i++)S[a[i]]=1;paint()}
var mo=window.MutationObserver?new MutationObserver(paint):null;if(mo)mo.observe(document.body,{childList:true,subtree:true})}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init()})();`;
}

export const favoritesHead: StorefrontHeadContributor = {
  module: FAVORITES_MODULE,
  tags(shop: PublicShop, _events, extra): HeadTag[] {
    if (!extra) return [];
    const members = (shop.settings ?? {})["members_enabled"] === true;
    return [{ kind: "inline-script", code: favoritesScript({ url: members ? `${extra.base}/account/favorites` : null, member: members && extra.member, key: `banto_fav_${shop.id}` }) }];
  },
};
