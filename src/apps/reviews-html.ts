/**
 * レビュー（reviews.v1）の既定の見た目を HTML の文字で（0084・0086）。既定のテーマの商品のページ・本文のプラグインのブロック・
 * snippet の無い Liquid のテーマが使う。文字はすべてエスケープする（プラグインが HTML を送っても文字のまま）
 */
import type { ProductReviews } from "./app-data";
import { t, tf } from "../i18n";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ESC[ch]!);

export function starsHtml(rating: number): string {
  const full = Math.max(0, Math.min(5, Math.round(rating)));
  return `<span class="stars" role="img" aria-label="${esc(tf("store.reviews_rating", { rating: rating.toFixed(1) }))}">${"★".repeat(full)}<span class="stars-off">${"★".repeat(5 - full)}</span></span>`;
}

/** 星と件数（href があれば件数を一覧へのリンクに） */
export function reviewsSummaryHtml(r: ProductReviews, href?: string): string {
  const label = esc(tf("store.reviews_count", { count: r.rating_count.toLocaleString("ja-JP") }));
  return `<p class="reviews-summary">${starsHtml(r.rating_avg)} <strong>${r.rating_avg.toFixed(1)}</strong> ${href ? `<a href="${esc(href)}">${label}</a>` : `<span>${label}</span>`}</p>`;
}

/**
 * 「もっと見る」の小さなスクリプト（0087、docs/app-data.md §7）。押した人のブラウザが、プラグインの公開 API から JSON を取り、
 * Banto の決まった形（li.review）を DOM で組んで足す（文字は textContent。プラグインの HTML・JS は使わない）。
 * 1 ページに何度出ても 1 回だけ動く。Cookie と参照元は送らない。1 回 20 件、合わせて 200 件まで
 */
export const REVIEWS_MORE_SCRIPT = `(function(){if(window.__bantoMore)return;window.__bantoMore=1;
function txt(t,c,s){var e=document.createElement(t);if(c)e.className=c;if(s!=null)e.textContent=s;return e;}
function stars(r,b){var s=txt("span","stars","\u2605".repeat(r));s.setAttribute("role","img");s.setAttribute("aria-label",(b.getAttribute("data-t-rating")||"").replace("{rating}",r.toFixed(1)));s.appendChild(txt("span","stars-off","\u2605".repeat(5-r)));return s;}
function item(v,b){if(!v||typeof v!=="object")return null;var r=v.rating;if(typeof v.id!=="string"||r!==Math.floor(r)||r<1||r>5||typeof v.body!=="string"||typeof v.author_display!=="string"||typeof v.created_at!=="string")return null;
var li=txt("li","review"),h=txt("p","review-head");h.appendChild(stars(r,b));if(typeof v.title==="string"&&v.title){h.appendChild(document.createTextNode(" "));h.appendChild(txt("strong","",v.title.slice(0,200)));}li.appendChild(h);
li.appendChild(txt("p","review-body",v.body.slice(0,2000)));var m=txt("p","muted review-meta",v.author_display.slice(0,100)+" \u00b7 ");var tm=txt("time","",v.created_at.slice(0,10));tm.setAttribute("datetime",v.created_at.slice(0,40));m.appendChild(tm);
if(v.verified_purchase===true)m.appendChild(txt("span","badge",b.getAttribute("data-t-verified")));if(v.incentivized===true)m.appendChild(txt("span","badge",b.getAttribute("data-t-pr")));li.appendChild(m);return li;}
document.addEventListener("click",function(e){var b=e.target&&e.target.closest?e.target.closest("[data-banto-more]"):null;if(!b||b.disabled)return;e.preventDefault();
var u;try{u=new URL(b.getAttribute("data-url"));}catch(_){return;}if(u.protocol!=="https:")return;var off=parseInt(b.getAttribute("data-offset")||"0",10)||0;
u.searchParams.set("product",b.getAttribute("data-product")||"");u.searchParams.set("offset",String(off));u.searchParams.set("limit","20");
var box=b.closest("[data-banto-reviews]")||b.parentNode,ol=box.querySelector("ol.review-list");if(!ol){ol=txt("ol","review-list");b.parentNode.insertBefore(ol,b);}
b.disabled=true;var label=b.textContent;b.textContent=b.getAttribute("data-t-loading")||label;
fetch(u.toString(),{credentials:"omit",referrerPolicy:"no-referrer",headers:{Accept:"application/json"}}).then(function(r){if(!r.ok)throw 0;return r.json();}).then(function(j){
var xs=j&&Array.isArray(j.items)?j.items.slice(0,20):[],n=0;xs.forEach(function(v){var li=item(v,b);if(li){ol.appendChild(li);n++;}});
var next=j&&typeof j.next_offset==="number"&&j.next_offset>off&&n>0&&ol.children.length<200?j.next_offset:null;
if(next===null){b.remove();return;}b.setAttribute("data-offset",String(next));b.disabled=false;b.textContent=label;
}).catch(function(){b.disabled=false;b.textContent=b.getAttribute("data-t-error")||label;});});})();`;

/** 「もっと見る」のボタンとスクリプト（URL が無い・置いた分で全部なら空） */
export function reviewsMoreHtml(r: ProductReviews, shown: number): string {
  if (!r.more || shown >= r.rating_count) return "";
  const attrs = [
    "data-banto-more",
    `data-url="${esc(r.more.url)}"`,
    `data-product="${esc(r.more.product_id)}"`,
    `data-offset="${shown}"`,
    `data-t-rating="${esc(t("store.reviews_rating"))}"`,
    `data-t-verified="${esc(t("store.review_verified"))}"`,
    `data-t-pr="${esc(t("store.review_incentivized"))}"`,
    `data-t-loading="${esc(t("store.reviews_loading"))}"`,
    `data-t-error="${esc(t("store.reviews_more_error"))}"`,
  ].join(" ");
  return `<button type="button" class="reviews-more" ${attrs}>${esc(t("store.reviews_more"))}</button><script>${REVIEWS_MORE_SCRIPT}</script>`;
}

/** レビューの一覧（見出し・星と件数・新しいものから limit 件） */
export function reviewsListHtml(r: ProductReviews, opts: { id?: string; limit?: number; heading?: boolean } = {}): string {
  const items = r.items.slice(0, Math.max(0, Math.min(20, opts.limit ?? 20)));
  const list = items.length
    ? `<ol class="review-list">${items
        .map(
          (i) =>
            `<li class="review"><p class="review-head">${starsHtml(i.rating)} ${i.title ? `<strong>${esc(i.title)}</strong>` : ""}</p><p class="review-body">${esc(i.body)}</p><p class="muted review-meta">${esc(i.author_display)} · <time datetime="${esc(i.created_at)}">${esc(i.created_at.slice(0, 10))}</time>${i.verified_purchase ? `<span class="badge">${esc(t("store.review_verified"))}</span>` : ""}${i.incentivized ? `<span class="badge">${esc(t("store.review_incentivized"))}</span>` : ""}</p></li>`,
        )
        .join("")}</ol>`
    : "";
  return `<section class="reviews" data-banto-reviews${opts.id ? ` id="${esc(opts.id)}"` : ""}>${opts.heading === false ? "" : `<h2>${esc(t("store.reviews"))}</h2>`}${reviewsSummaryHtml(r)}${list || '<ol class="review-list"></ol>'}${reviewsMoreHtml(r, items.length)}</section>`;
}
