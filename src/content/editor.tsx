/**
 * ページと記事の編集の画面（同梱モジュール pages・blog が一緒に使う。docs/pages.md・docs/blog.md）。
 * WordPress のブロックの編集に寄せた 2 列の画面・見たままの編集・ブロック・メディアライブラリ・リビジョン。
 * 保存するのは決まった書式の本文と各欄だけ（生の HTML は入らない。src/pages/markdown.ts）
 */
import type { Hono } from "hono";
import { raw } from "hono/html";
import type { AppEnv } from "../app";
import type { CategoryRow, ShopRow } from "../db/types";
import { t, tf, type MessageKey } from "../i18n";
import { formFields, owner, type AdminContext } from "../routes/admin/context";
import { requireOwner } from "../routes/admin/auth";
import { mediaBaseUrl } from "../routes/common";
import { MAX_IMAGE_BYTES, imageUrl, randomKey, sniffImage } from "../media/images";
import { PAGE_LIMITS, PAGE_NAVS, PAGES_PUBLISHING_MIGRATION, RESERVED_HANDLES, type PageNav } from "../pages";
import { migrated } from "../db/migration-state";
import { formatDateTime, isoToZonedInput } from "../i18n/time";
import { markdownToHtml } from "../pages/markdown";
import { PRODUCT_BLOCKS_MAX, PRODUCT_BLOCK_LIMIT_DEFAULT, PRODUCT_BLOCK_LIMIT_MAX, type ProductBlock } from "../pages/blocks";
import { PRODUCT_SORTS, toPublicShop, type ProductSort } from "../storefront/data";
import { storefrontData } from "../routes/storefront/domain";
import { tagCounts } from "../products/tags";
import { responsiveImage } from "../media/images";
import { CLIENT_PRELUDE } from "../modules/woo-import/admin";
import { pageEditorClient } from "./editor-client";
import { PAGE_BLOCKS_SCRIPT, PAGE_MEDIA_SCRIPT } from "./blocks-script";
import { LAYOUT_ATTRS, LAYOUT_CSS, LAYOUT_DEPTH_MAX, layoutDefault } from "../pages/layout";

/** レイアウトのブロックの値・既定・文言（PAGE_BLOCKS_SCRIPT が data-layout の JSON で受け取る） */
function layoutConfig(): string {
  const kinds = Object.keys(LAYOUT_ATTRS) as (keyof typeof LAYOUT_ATTRS)[];
  const schema: Record<string, Record<string, { values: readonly string[]; def: string }>> = {};
  const L: Record<string, string> = {};
  for (const k of kinds) {
    schema[k] = {};
    L[`kind.${k}`] = t(`layout.kind_${k}` as MessageKey);
    if (k !== "column") L[`desc.${k}`] = t(`layout.desc_${k}` as MessageKey);
    for (const [key, values] of Object.entries(LAYOUT_ATTRS[k])) {
      schema[k]![key] = { values, def: layoutDefault(k, key) };
      L[`field.${key}`] = t(`layout.field_${key}` as MessageKey);
      if (key !== "open") for (const v of values) L[`opt.${key}.${v}`] = t(`layout.opt_${key}_${v}` as MessageKey);
    }
  }
  for (const k of ["image", "alt"]) L[`field.${k}`] = t(`layout.field_${k}` as MessageKey);
  for (const k of ["group_design", "settings", "settings_none", "choose_image", "remove_image", "add_image", "parent", "depth_max", "gallery_empty", "media_empty", "acc_title", "colors_note"] as const) L[k] = t(`layout.${k}`);
  return JSON.stringify({ schema, depth: LAYOUT_DEPTH_MAX, t: L });
}

/** リビジョンの一覧に出す列（0080） */
export interface RevisionRow {
  id: string;
  title: string;
  created_at: string;
}

/** ページの状態（一覧のタブ・編集の画面の上のバー） */
export type ContentState = "published" | "scheduled" | "draft" | "trash";
export function contentState(p: { published: boolean; published_at?: string | null; deleted_at?: string | null }, now = Date.now()): ContentState {
  if (p.deleted_at) return "trash";
  if (!p.published) return "draft";
  return p.published_at && Date.parse(p.published_at) > now ? "scheduled" : "published";
}

/** アイキャッチ画像に使える URL（ショップの画像の置き場のものだけ。本文の画像と同じ規則） */
export function imageUrlOk(url: string, mediaBase: string): boolean {
  if (url.length > 2000 || /[\s<>"'`\\]/.test(url) || url.includes("..")) return false;
  const b = mediaBase.replace(/\/+$/, "");
  return url.startsWith(`${b}/`) || url.startsWith("/media/");
}

/** 見たままの編集での商品のブロックの説明（例: 商品を並べる — カテゴリー: tops・8 件・グリッド・新しい順） */
export function productsLabel(b: ProductBlock): string {
  const parts = [
    b.category ? tf("pages.products_label_category", { v: b.category }) : t("pages.products_all"),
    ...(b.tag ? [tf("pages.products_label_tag", { v: b.tag })] : []),
    tf("pages.products_label_limit", { n: b.limit }),
    t(`pages.layout_${b.layout}` as MessageKey),
    t(`pages.sort_${b.sort}` as MessageKey),
  ];
  return `${t("pages.block_products")} — ${parts.join("・")}`;
}

/** 商品のブロックの設定で選ぶカテゴリーとタグ（タグは公開中の商品のものを多い順に。RLS で自分のショップのものだけ） */
export async function editorCatalog(c: AdminContext, shop: ShopRow): Promise<{ categories: Pick<CategoryRow, "slug" | "name">[]; tags: { tag: string; count: number }[] }> {
  const db = owner(c).db;
  const [categories, rows] = await Promise.all([
    db.from<CategoryRow>("categories").select("slug,name", { eq: { shop_id: shop.id }, order: "sort_order.asc,name.asc" }).catch(() => [] as CategoryRow[]),
    db.from<{ tags: string[] | null }>("products").select("tags", { eq: { shop_id: shop.id, published: true }, limit: 5000 }).catch(() => [] as { tags: string[] | null }[]),
  ]);
  return { categories, tags: tagCounts(rows).slice(0, 300) };
}

/** 管理画面で本文を HTML にする（商品のブロックは説明の箱にする） */
export const editorHtml = (c: AdminContext, body: string) => markdownToHtml(body, { mediaBase: mediaBaseUrl(c), productsLabel, editor: true });

/**
 * 本文の入力の手助け（見出し・太字・リンク・箇条書き…のボタンと、画像を縮小して置いて ![](URL) を入れる）。
 * JS が無くても本文は書ける（書式は docs/pages.md と画面の説明のとおり）。画像は下のフォームで置いて、出た行を貼る
 */
export const PAGE_EDITOR_SCRIPT = `
(function(){
  var ta=document.getElementById("body"); if(!ta) return;
  // 見たままの編集のあいだは、ボタンと画像は見たままの側（pageEditorClient）が受け持つ
  function wrap(before,after,ph){ var s=ta.selectionStart,e=ta.selectionEnd,v=ta.value,sel=v.slice(s,e)||ph; ta.value=v.slice(0,s)+before+sel+after+v.slice(e); ta.focus(); ta.selectionStart=s+before.length; ta.selectionEnd=s+before.length+sel.length; }
  function line(prefix){ var s=ta.selectionStart,v=ta.value,ls=v.lastIndexOf("\\n",s-1)+1; ta.value=v.slice(0,ls)+prefix+v.slice(ls); ta.focus(); ta.selectionStart=ta.selectionEnd=s+prefix.length; }
  function insert(text){ var s=ta.selectionStart,v=ta.value; ta.value=v.slice(0,s)+text+v.slice(ta.selectionEnd); ta.focus(); ta.selectionStart=ta.selectionEnd=s+text.length; }
  Array.prototype.forEach.call(document.querySelectorAll("[data-md]"),function(b){ b.addEventListener("click",function(){
    if(ta.hidden) return;
    var k=b.getAttribute("data-md"), ph=b.getAttribute("data-ph")||"";
    if(k==="h2") line("## "); else if(k==="h3") line("### "); else if(k==="b") wrap("**","**",ph); else if(k==="i") wrap("*","*",ph);
    else if(k==="ul") line("- "); else if(k==="ol") line("1. "); else if(k==="q") line("> "); else if(k==="hr") insert("\\n---\\n"); else if(k==="p") line("");
    else if(k==="table"){ var c=b.getAttribute("data-ph")||" "; insert("\\n| "+c+" | "+c+" |\\n| --- | --- |\\n| "+c+" | "+c+" |\\n"); }
    else if(k==="link"){ var u=window.prompt(b.getAttribute("data-ask")||"URL","https://"); if(u) wrap("[","]("+u.replace(/[\\s()]/g,"")+")",ph); }
  }); });
  var form=document.getElementById("page-image-form"), input=document.getElementById("page-image"), st=document.getElementById("page-image-status");
  if(!form||!input||!window.fetch) return;
  function load(file){ return new Promise(function(ok,ng){ var url=URL.createObjectURL(file); var im=new Image(); im.onload=function(){URL.revokeObjectURL(url);ok(im)}; im.onerror=function(){URL.revokeObjectURL(url);ng(new Error("decode"))}; im.src=url; }); }
  function draw(im,max,q){ var w=im.naturalWidth,h=im.naturalHeight,r=Math.min(1,max/Math.max(w,h)); var c=document.createElement("canvas"); c.width=Math.max(1,Math.round(w*r)); c.height=Math.max(1,Math.round(h*r)); c.getContext("2d").drawImage(im,0,0,c.width,c.height); return new Promise(function(ok,ng){ c.toBlob(function(b){ if(b&&b.type==="image/webp") return ok(b); /* Safari は WebP に書き出せないので JPEG に */ c.toBlob(function(j){ if(j&&j.type==="image/jpeg") ok(j); else ng(new Error("encode")); },"image/jpeg",q); },"image/webp",q); }); }
  // 画像を縮めて置き場へ上げ、URL を返す（メディアライブラリの「新しく置く」も使う）。iPhone の HEIC も描ければ縮めて送る
  function upload(file){
    var send=function(blob,name){ var fd=new FormData(); fd.append("file",new File([blob],name,{type:blob.type})); return fetch(form.action,{method:"POST",body:fd,credentials:"same-origin",headers:{Accept:"application/json"}}).then(function(r){ return r.json().then(function(j){ if(!r.ok||!j.url) throw new Error(j.error||"upload"); return j; }); }); };
    return /^image\\/(jpeg|png|webp|avif|heic|heif)$/.test(file.type)?load(file).then(function(im){ return draw(im,1600,0.82); }).then(function(b){ return send(b,b.type==="image/jpeg"?"image.jpg":"image.webp"); },function(){ return send(file,file.name); }):send(file,file.name);
  }
  window.bantoUploadImage=function(file){ return upload(file).then(function(j){ return j.url; }); };
  form.addEventListener("submit",function(ev){
    var file=input.files&&input.files[0]; if(!file) return;
    ev.preventDefault(); st.textContent=form.getAttribute("data-busy")||"";
    upload(file).then(function(j){ if(!(window.bantoPageImage&&window.bantoPageImage(j.url))) insert("\\n![]("+j.url+")\\n"); st.textContent=""; input.value=""; }).catch(function(e){ st.textContent=(form.getAttribute("data-failed")||"")+" "+(e&&e.message||""); });
  });
})();`;

/** 見たままの編集のスクリプト（関数の toString() と設定。</script> を閉じさせないよう < を逃がす） */
export function visualEditorScript(base: string): string {
  const cfg = { render: `${base}/render`, t: { cell: t("pages.tool_table_cell") } };
  return `${CLIENT_PRELUDE}(${pageEditorClient.toString()})().mount(${JSON.stringify(cfg).replace(/</g, "\\u003c")});`;
}

/** 編集の画面の見た目（WordPress の編集に寄せた 2 列。管理画面の共通の CSS の上に足す） */
export const EDITOR_CSS = `
.pe-bar{position:sticky;top:0;z-index:5;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;padding:.6rem 0;margin:0 0 1rem;background:var(--bg);border-bottom:1px solid var(--border)}
.pe-bar .pe-grow{flex:1}
#page-form .pe-title{max-width:none;min-height:0;font-size:1.6rem;font-weight:700;line-height:1.3;border:0;border-bottom:1px solid transparent;border-radius:0;padding:.25rem 0;margin:0 0 .75rem;width:100%;background:transparent;box-shadow:none}
#page-form .pe-title:focus{outline:none;box-shadow:none;border-bottom-color:var(--border-strong)}
#body-visual{min-height:24rem;padding:.5rem 2.5rem 3rem;overflow:visible;border:0;border-radius:0}
#body-visual:focus{outline:none}
#body-visual>*,#body-visual [data-slot]>*,#body-visual .banto-accordion__title{position:relative;border-radius:3px;transition:box-shadow .1s}
#body-visual>*:hover,#body-visual [data-slot]>*:hover{box-shadow:0 0 0 1px var(--border)}
#body-visual .is-sel,#body-visual .is-sel:hover{box-shadow:0 0 0 1.5px var(--link)}
#body-visual [data-slot]{min-height:1.5rem}
#body-visual .banto-column{outline:1px dashed var(--border);outline-offset:3px}
#body-visual .banto-cover:not([data-image]){background:linear-gradient(135deg,#555,#222)}
#body-visual .banto-media__fig:empty,#body-visual .banto-gallery:empty{min-height:7rem;border:1.5px dashed var(--border-strong);border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer}
#body-visual .banto-media__fig:empty::before,#body-visual .banto-gallery:empty::before{content:attr(data-ph);color:var(--fg-muted);font-size:.85rem}
#body-visual .banto-spacer{background:repeating-linear-gradient(45deg,transparent 0 6px,rgba(127,127,127,.12) 6px 12px);border-radius:4px}
#body-visual .banto-accordion__title{font-weight:600;padding:.75rem 0}
#body-visual .banto-accordion__body{border-top:1px dashed var(--border);padding-top:.5rem}
#body-visual .is-ph-title::before{content:attr(data-ph);position:absolute;color:var(--fg-muted);font-weight:400;pointer-events:none}
.pe-blockset h2{display:flex;align-items:center;gap:.4rem}
.pe-blockset select,.pe-blockset input[type=text]{width:100%;max-width:none}
.pe-icons{display:grid;grid-template-columns:repeat(5,1fr);gap:4px}
.pe-icons label{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;margin:0;padding:.55rem .2rem;border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:.68rem;line-height:1.2;text-align:center}
.pe-icons input{position:absolute;opacity:0;width:1px;height:1px}
.pe-icons label:has(input:checked){border-color:var(--link);box-shadow:inset 0 0 0 1px var(--link)}
.pe-icons .banto-accordion__icon{display:block}
.pe-thumbs{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin:.4rem 0}
.pe-thumbs div{position:relative}.pe-thumbs img{display:block;width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:4px}
.pe-thumbs button{position:absolute;top:2px;right:2px;width:22px;height:22px;min-width:0;padding:0;border-radius:50%;font-size:.8rem;justify-content:center}
#body-visual .is-ph::before{content:attr(data-ph);position:absolute;left:0;right:0;color:var(--fg-muted);pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#body-visual table{border-collapse:collapse}#body-visual th,#body-visual td{border:1px solid var(--border);padding:.3rem .5rem}
#body-visual img{max-width:100%;height:auto}
#body-visual blockquote{margin:.5rem 0;padding-left:1rem;border-left:3px solid var(--border-strong)}
.pe-url{font-size:.85rem;word-break:break-all}
.pe-canvas-head{display:flex;align-items:center;gap:.5rem;margin:.25rem 0 .5rem}
.blk-top{width:34px;height:34px;padding:0;border-radius:6px;font-size:1.35rem;line-height:1;justify-content:center}
.blk-tb,.blk-ins,.blk-menu,.blk-pop{position:absolute;z-index:61;background:var(--bg);border:1px solid var(--border-strong);box-shadow:var(--shadow)}
.blk-tb{display:flex;align-items:stretch;border-radius:6px;padding:2px}
.blk-tb.typing{visibility:hidden}
.blk-btn{height:32px;min-width:32px;padding:0 .4rem;background:var(--bg);color:var(--fg);border:0;border-radius:4px;font-size:.9rem;justify-content:center;gap:2px}
.blk-btn:hover,.blk-btn[aria-expanded=true]{background:var(--bg-subtle);opacity:1}
.blk-btn[data-op=drag]{cursor:grab}
.blk-sep{width:1px;background:var(--border);margin:4px 2px}
.blk-ico{width:20px;height:20px;flex:none}
.blk-plus{position:absolute;z-index:60;width:26px;height:26px;padding:0;border-radius:6px;background:var(--fg);color:var(--bg);border:0;font-size:1.1rem;line-height:1;justify-content:center}
.blk-gap{position:absolute;z-index:59;height:2px;background:var(--link);pointer-events:none}
.blk-gap button{pointer-events:auto;position:absolute;left:50%;top:-12px;margin-left:-13px;width:26px;height:26px;padding:0;border-radius:50%;background:var(--link);color:#fff;border:0;font-size:1.1rem;line-height:1;justify-content:center}
.blk-ins{width:min(22rem,calc(100vw - 2rem));max-height:min(28rem,70vh);overflow:auto;border-radius:10px;padding:.5rem}
.blk-ins input{width:100%;max-width:none;margin:0 0 .25rem}
.blk-grp{font-size:.75rem;color:var(--fg-muted);margin:.5rem .25rem .25rem;text-transform:uppercase;letter-spacing:.04em}
.blk-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:2px}
.blk-tile{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;height:auto;min-height:4.5rem;padding:.5rem .25rem;background:transparent;color:var(--fg);border:0;border-radius:6px;font-size:.8rem;font-weight:400;line-height:1.2;text-align:center}
.blk-tile[aria-selected=true],.blk-tile:hover{background:var(--bg-subtle);opacity:1;box-shadow:inset 0 0 0 1.5px var(--link)}
.blk-tile .blk-ico{width:24px;height:24px}
.blk-menu,.blk-pop{display:flex;flex-direction:column;min-width:13rem;border-radius:8px;padding:4px}
.blk-menu{min-width:18rem;max-height:20rem;overflow:auto}
.blk-opt{display:flex;align-items:center;justify-content:flex-start;gap:.6rem;height:auto;min-height:34px;padding:.35rem .5rem;background:transparent;color:var(--fg);border:0;border-radius:4px;font-weight:400;text-align:left}
.blk-opt small{display:block;color:var(--fg-muted);font-size:.75rem}
.blk-opt[aria-selected=true],.blk-opt:hover{background:var(--bg-subtle);opacity:1}
#md-tools[hidden],.blk-tb[hidden],.blk-ins[hidden],.blk-menu[hidden],.blk-pop[hidden],.blk-plus[hidden],.blk-gap[hidden]{display:none}
.page-preview .banto-products{border:1px dashed var(--border-strong);border-radius:6px;padding:.75rem 1rem;margin:.75rem 0;background:var(--bg-subtle);cursor:pointer;font-size:.9rem;user-select:none}
.page-preview .banto-products .bp-items{display:flex;gap:.5rem;margin-top:.5rem;overflow:hidden}
.page-preview .banto-products .bp-item{flex:0 0 4.75rem;font-size:.7rem;line-height:1.3;overflow:hidden}
.page-preview .banto-products .bp-item span{display:block;aspect-ratio:1/1;border-radius:4px;background:var(--border) center/cover no-repeat;margin-bottom:2px}
.page-preview .banto-products .bp-item b{display:block;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bp-note{font-size:.8rem;color:var(--fg-muted);margin-top:.35rem}
.bp-note.bad{color:var(--err);font-weight:600}
.bp-preview{margin:.75rem 0 0;padding:.6rem .75rem;border-radius:6px;background:var(--bg-subtle)}
.bp-preview:empty{display:none}
.page-preview .banto-button__link{display:inline-block;padding:.5rem 1.25rem;border-radius:6px;background:var(--accent);color:var(--accent-fg);text-decoration:none;font-weight:600}
@media (max-width:600px){#body-visual{padding:.5rem .25rem 3rem 2rem}.blk-grid{grid-template-columns:repeat(3,1fr)}}
#blk-products,#blk-button{max-width:28rem;width:calc(100% - 2rem);border:1px solid var(--border-strong);border-radius:10px;padding:1.25rem 1.5rem}
#blk-products::backdrop,#blk-button::backdrop{background:rgba(0,0,0,.35)}
@media (max-width:600px){.pe-bar button{height:32px;padding:0 .7rem;font-size:.85rem}.pe-bar .status{display:none}}
html.pe-lock,html.pe-lock body{overflow:hidden}
.pe-full{position:fixed;inset:0;z-index:40;background:var(--bg);display:flex;flex-direction:column}
.pe-full>#page-form{display:flex;flex-direction:column;flex:1;min-height:0;margin:0}
.pe-full .pe-bar{position:static;margin:0;padding:.45rem .75rem;gap:.35rem;flex:none;flex-wrap:nowrap;background:var(--bg)}
.pe-full #body-visual{padding:.5rem 0 6rem}
.pe-full .pe-canvas-hint{display:none}
.pe-bar-left{display:flex;align-items:center;gap:.25rem}
.pe-back{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:6px;background:var(--fg);color:var(--bg)}
.pe-tog{height:36px;min-width:36px;padding:0 .5rem;background:transparent;color:var(--fg);border:0;border-radius:6px;justify-content:center;font-size:1.3rem}
.pe-tog:hover{background:var(--bg-subtle);opacity:1}
.pe-tog[aria-pressed=true]{background:var(--fg);color:var(--bg)}
.pe-full .split{position:relative;display:flex;flex:1;min-height:0;gap:0;align-items:stretch}
.pe-full .split>.card{flex:1;min-width:0;overflow:auto;border:0;border-radius:0;box-shadow:none;margin:0;padding:2.5rem 1rem 6rem;display:block;background:var(--bg)}
.pe-full .split>.card>*{max-width:48rem;margin-left:auto;margin-right:auto}
.pe-full .split>aside{width:300px;flex:none;overflow:auto;border-left:1px solid var(--border);padding:.75rem;background:var(--bg-page)}
.pe-full .split>aside>.card{margin:0 0 .75rem}
.pe-full .split>aside[hidden],.pe-left[hidden]{display:none}
.pe-full #blk-top{display:none}
.pe-left{width:300px;flex:none;display:flex;flex-direction:column;border-right:1px solid var(--border);background:var(--bg);min-height:0}
.pe-left-head{display:flex;align-items:center;gap:.25rem;padding:.4rem .5rem;border-bottom:1px solid var(--border)}
.pe-left-head [role=tab]{height:32px;padding:0 .7rem;background:transparent;color:var(--fg-muted);border:0;border-radius:0;border-bottom:2px solid transparent;font-weight:600}
.pe-left-head [role=tab][aria-selected=true]{color:var(--fg);border-bottom-color:var(--fg)}
.pe-left-body{flex:1;overflow:auto;padding:.6rem}
.pe-left-body input[type=search]{width:100%;max-width:none}
.pe-hint{font-size:.75rem;color:var(--fg-muted);margin:.75rem .25rem}
.blk-tile{cursor:grab}
.ol-row{display:flex;align-items:center;gap:.4rem;padding:.3rem .4rem;border-radius:4px;cursor:pointer;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;font-size:.85rem;position:relative}
.ol-handle{display:inline-flex;padding:.35rem;margin:-.35rem 0 -.35rem -.35rem;touch-action:none;cursor:grab}
.pe-left-body{-webkit-user-select:none;user-select:none}.pe-left-body input{-webkit-user-select:text;user-select:text}
.ol-row:hover{background:var(--bg-subtle)}
.ol-row.is-cur{box-shadow:inset 0 0 0 1.5px var(--link)}
.ol-row.is-pick{background:var(--link);color:#fff}
.ol-row .ol-txt{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ol-row .ol-txt small{color:var(--fg-muted);margin-left:.4rem}
.ol-row.is-pick .ol-txt small{color:inherit;opacity:.8}
.ol-row.ol-child{padding-left:1.9rem;font-size:.8rem;color:var(--fg-muted);cursor:default}
.ol-drop{position:absolute;left:.4rem;right:.4rem;height:2px;background:var(--link);pointer-events:none}
.ol-drop.ol-into{background:transparent;border:2px solid var(--link);border-radius:4px}
.ol-picked{position:sticky;bottom:0;display:flex;flex-wrap:wrap;align-items:center;gap:.4rem;padding:.5rem;margin-top:.5rem;background:var(--bg);border-top:1px solid var(--border);font-size:.8rem}
#pe-msgs .notice,#pe-msgs .error{margin:0 auto 1rem}
@media (max-width:600px){.pe-full .pe-bar{padding:.4rem .5rem;gap:.2rem}.pe-full .pe-bar button{height:32px;padding:0 .55rem;font-size:.8rem}.pe-full .pe-back,.pe-full .pe-tog{width:32px;min-width:32px;height:32px;padding:0}}
@media (max-width:900px){.pe-full .pe-left,.pe-full .split>aside{position:absolute;top:0;bottom:0;z-index:45;width:min(320px,88vw);box-shadow:var(--shadow)}.pe-full .pe-left{left:0}.pe-full .split>aside{right:0}.pe-full .pe-bar .status{display:none}}
.pe-file{position:relative;display:inline-flex;align-items:center;height:32px;padding:0 .8rem;border:1px solid var(--border-strong);border-radius:6px;background:var(--bg);cursor:pointer;font-size:.85rem;font-weight:500;overflow:hidden;margin:0}
.pe-file input{position:absolute;inset:0;opacity:0;cursor:pointer;font-size:0}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
${LAYOUT_CSS}
`;

/** 編集の画面の種類ごとの違い（ページと記事） */
export interface EditorKind {
  /** 画像・メディア・変換の口の起点（…/modules/pages など。mountEditorEndpoints を付けた先） */
  base: string;
  /** お客様の画面の URL の名前の前（/pages/ や /blogs/news/） */
  urlPrefix: string;
  /** メニュー・並び順の欄（ページだけ） */
  nav: boolean;
  /** 編集の画面の左上の「戻る」の行き先（無ければ base） */
  back?: string;
  /** 記事の欄（タグ・抜粋・書いた人） */
  article?: { tags: string; excerpt: string; author: string };
}

/** 編集の画面で扱う値（ページと記事の共通） */
export interface ContentValues {
  title: string;
  handle: string;
  body: string;
  seo_title: string | null;
  seo_description: string | null;
  template_suffix: string | null;
  published: boolean;
  published_at?: string | null;
  image_url?: string | null;
  nav?: PageNav;
  sort_order?: number;
}

export function ContentForm(props: { kind: EditorKind; shop: ShopRow; action: string; selfUrl: string; values: ContentValues; visual: string; categories: Pick<CategoryRow, "slug" | "name">[]; tags?: { tag: string; count: number }[]; pageId?: string; viewUrl?: string | null; error?: MessageKey | null; image?: string | null; publishing: boolean; revisions: RevisionRow[] }) {
  const v = props.values;
  const state = contentState({ published: v.published, published_at: v.published_at ?? null, deleted_at: null });
  const tools: [string, MessageKey, MessageKey?][] = [
    ["p", "pages.tool_p"],
    ["h2", "pages.tool_h2"],
    ["h3", "pages.tool_h3"],
    ["b", "pages.tool_bold", "pages.tool_bold"],
    ["i", "pages.tool_italic", "pages.tool_italic"],
    ["link", "pages.tool_link", "pages.tool_link"],
    ["ul", "pages.tool_ul"],
    ["ol", "pages.tool_ol"],
    ["q", "pages.tool_quote"],
    ["hr", "pages.tool_hr"],
    ["table", "pages.tool_table", "pages.tool_table_cell"],
  ];
  // ブロックの一覧と操作の文言（PAGE_BLOCKS_SCRIPT が data-t-* で読む）
  const blockText: Record<string, string> = {
    "data-t-p": t("pages.tool_p"),
    "data-t-h2": t("pages.tool_h2"),
    "data-t-h3": t("pages.tool_h3"),
    "data-t-ul": t("pages.tool_ul"),
    "data-t-ol": t("pages.tool_ol"),
    "data-t-q": t("pages.tool_quote"),
    "data-t-hr": t("pages.tool_hr"),
    "data-t-table": t("pages.tool_table"),
    "data-t-img": t("pages.block_image"),
    "data-t-cell": t("pages.tool_table_cell"),
    "data-t-add": t("pages.block_add"),
    "data-t-up": t("pages.block_up"),
    "data-t-down": t("pages.block_down"),
    "data-t-del": t("pages.block_remove"),
    "data-t-handle-auto": t("pages.handle_auto"),
    "data-t-products": t("pages.block_products"),
    "data-t-button": t("pages.block_button"),
    "data-t-button-text": t("pages.button_text_ask"),
    "data-t-button-url": t("pages.tool_link_ask"),
    "data-t-products-max": tf("pages.products_max", { n: PRODUCT_BLOCKS_MAX }),
    "data-t-products-all": t("pages.products_all"),
    "data-t-products-items": t("pages.products_label_items"),
    "data-t-ph": t("pages.block_placeholder"),
    "data-t-search": t("pages.block_search"),
    "data-t-more": t("pages.block_more"),
    "data-t-dup": t("pages.block_duplicate"),
    "data-t-before": t("pages.block_insert_before"),
    "data-t-after": t("pages.block_insert_after"),
    "data-t-edit": t("pages.block_edit"),
    "data-t-drag": t("pages.block_drag"),
    "data-t-type": t("pages.block_type"),
    "data-t-bold": t("pages.tool_bold"),
    "data-t-italic": t("pages.tool_italic"),
    "data-t-link": t("pages.tool_link"),
    "data-t-link-ask": t("pages.tool_link_ask"),
    "data-t-g-text": t("pages.block_group_text"),
    "data-t-g-media": t("pages.block_group_media"),
    "data-t-g-shop": t("pages.block_group_shop"),
    "data-t-none": t("pages.block_none"),
    "data-t-pv-count": t("pages.products_preview_count"),
    "data-t-pv-none": t("pages.products_preview_none"),
    "data-t-pv-unpublished": t("pages.products_preview_unpublished"),
    "data-t-pv-loading": t("pages.products_preview_loading"),
    "data-preview": `${props.kind.base}/products-preview`,
    "data-layout": layoutConfig(),
    "data-t-back": t("pages.editor_back"),
    "data-t-lib": t("pages.editor_library"),
    "data-t-outline": t("pages.editor_outline"),
    "data-t-settings": t("pages.editor_settings"),
    "data-t-close": t("pages.editor_close"),
    "data-t-picked": t("pages.editor_picked"),
    "data-t-pick-del": t("pages.editor_picked_delete"),
    "data-t-pick-clear": t("pages.editor_picked_clear"),
    "data-t-lib-hint": t("pages.editor_library_hint"),
    "data-t-outline-hint": t("pages.editor_outline_hint"),
  };
  for (const k of ["p", "h2", "h3", "ul", "ol", "q", "hr", "table", "img", "products", "button"]) blockText[`data-t-d-${k}`] = t(`pages.blockdesc_${k}` as MessageKey);
  return (
    <div id="pe-root" data-back={props.kind.back ?? props.kind.base}>
      <style dangerouslySetInnerHTML={{ __html: EDITOR_CSS }} />
      {props.error ? <p class="error">{t(props.error)}</p> : null}
      {props.image ? (
        <p class="notice">
          {t("pages.image_ready")} <code>![]({props.image})</code>
        </p>
      ) : null}
      <form method="post" action={props.action} id="page-form" data-reserved={RESERVED_HANDLES.join(",")} {...blockText}>
        {/* 上のバー: 状態と、下書き保存・プレビュー（新しいタブ）・公開 / 更新。Ctrl+S は data-save のボタン */}
        <div class="pe-bar">
          <span class={`status ${state === "published" ? "" : state === "scheduled" ? "info" : "off"}`}>
            {t(`pages.state_${state}` as MessageKey)}
            {state === "scheduled" && v.published_at ? ` ${formatDateTime(v.published_at)}` : ""}
          </span>
          <span class="pe-grow" />
          {v.published ? (
            <button type="submit" name="action" value="draft" class="secondary small">
              {t("pages.unpublish")}
            </button>
          ) : (
            <button type="submit" name="action" value="draft" class="secondary" data-save="1">
              {t("pages.save_draft")}
            </button>
          )}
          <button type="submit" name="action" value="preview" class="secondary" formtarget="_blank" formnovalidate>
            {t("pages.preview")}
          </button>
          {v.published ? (
            <button type="submit" name="action" value="update" data-save="1">
              {t("pages.update")}
            </button>
          ) : (
            <button type="submit" name="action" value="publish" id="pe-publish" data-now={t("pages.publish")} data-later={t("pages.schedule")}>
              {t("pages.publish")}
            </button>
          )}
        </div>
        <input type="hidden" name="published" value={v.published ? "on" : ""} />
        <div class="split">
          {/* 左: ブロックの一覧とリスト表示（JS があるときだけ。PAGE_BLOCKS_SCRIPT が中を作る） */}
          <div id="pe-left" class="pe-left" hidden></div>
          <div class="card">
            <div id="pe-msgs" aria-live="polite"></div>
            <label for="title" class="sr-only">
              {t("pages.title")}
            </label>
            <input id="title" name="title" class="pe-title" value={v.title} required maxlength={PAGE_LIMITS.title} placeholder={t("pages.title_placeholder")} />
            {/* JS があるときだけ出す（見たまま / Markdown の切り替え。pageEditorClient） */}
            <div class="pe-canvas-head">
              <button type="button" id="blk-top" class="blk-top" hidden aria-label={t("pages.block_add")} title={t("pages.block_add")}>
                +
              </button>
              <span class="pe-grow" />
            <div id="body-tabs" role="tablist" hidden>
              <button type="button" class="secondary small" role="tab" data-mode="visual" aria-selected="false">
                {t("pages.mode_visual")}
              </button>{" "}
              <button type="button" class="secondary small" role="tab" data-mode="markdown" aria-selected="true">
                {t("pages.mode_markdown")}
              </button>
            </div>
            </div>
            <div class="toolbar" id="md-tools" role="toolbar" aria-label={t("pages.tools")}>
              {tools.map(([k, label, ph]) => (
                <button type="button" class="secondary small" data-md={k} data-ph={ph ? t(ph) : undefined} data-ask={k === "link" ? t("pages.tool_link_ask") : undefined}>
                  {t(label)}
                </button>
              ))}
            </div>
            {/* 見たままの編集の領域。中身はお店の画面と同じ変換で作った HTML（決まった形のタグだけ）。保存のときは Markdown に直して送る */}
            <div id="body-visual" class="page-preview" contenteditable={true} role="textbox" aria-multiline="true" aria-label={t("pages.body")} hidden data-ready="1">
              {raw(props.visual)}
            </div>
            <textarea id="body" name="body" rows={20} maxlength={PAGE_LIMITS.body} aria-label={t("pages.body")} style="width:100%;font-family:ui-monospace,monospace">
              {v.body}
            </textarea>
            <p>
              <button type="button" id="blk-add-end" class="secondary small" hidden>
                + {t("pages.block_add")}
              </button>{" "}
              <span class="muted pe-canvas-hint">{t("pages.block_hint")}</span>
            </p>
            <details>
              <summary>{t("pages.syntax")}</summary>
              <pre class="muted" style="white-space:pre-wrap">{t("pages.syntax_help")}</pre>
            </details>
          </div>
          <aside>
            {props.publishing ? (
              <section class="card">
                <h2>{t("pages.publish_card")}</h2>
                <label for="published_at">{t("pages.published_at")}</label>
                <input id="published_at" name="published_at" type="datetime-local" value={isoToZonedInput(v.published_at)} />
                <p class="muted">{t("pages.published_at_help")}</p>
              </section>
            ) : null}
            {props.publishing ? (
              <section class="card">
                <h2>{t("pages.featured")}</h2>
                <input type="hidden" id="image_url" name="image_url" value={v.image_url ?? ""} />
                <img id="featured-preview" src={v.image_url ?? ""} alt="" hidden={!v.image_url} style="width:100%;height:auto;border-radius:6px;border:1px solid var(--border)" />
                <p class="muted">{t("pages.featured_help")}</p>
                <p>
                  <button type="button" class="secondary small" data-media="featured" hidden>
                    {t("pages.featured_choose")}
                  </button>{" "}
                  <button type="button" class="secondary small" id="featured-clear" hidden={!v.image_url}>
                    {t("pages.featured_clear")}
                  </button>
                </p>
              </section>
            ) : null}
            <section class="card">
              <h2>{t("pages.settings")}</h2>
              <label for="handle">{t("pages.handle")}</label>
              <input id="handle" name="handle" value={v.handle} maxlength={64} pattern="[a-z0-9]([a-z0-9\-]{0,62}[a-z0-9])?" data-auto={props.pageId ? "0" : v.handle ? "0" : "1"} />
              <p class="muted pe-url">
                {props.kind.urlPrefix}<span id="handle-show">{v.handle || t("pages.handle_auto")}</span>
              </p>
              <p class="muted">{t("pages.handle_help")}</p>
              {props.viewUrl ? (
                <p>
                  <a href={props.viewUrl} target="_blank" rel="noopener">
                    {t("pages.view")}
                  </a>
                </p>
              ) : null}
              {props.kind.nav ? (
                <>
                  <label for="nav">{t("pages.nav")}</label>
                  <select id="nav" name="nav">
                    {PAGE_NAVS.map((n) => (
                      <option value={n} selected={v.nav === n}>
                        {t(`pages.nav_${n}` as MessageKey)}
                      </option>
                    ))}
                  </select>
                  <label for="sort_order">{t("pages.sort_order")}</label>
                  <input id="sort_order" name="sort_order" type="number" min={-1000} max={1000} value={String(v.sort_order ?? 0)} style="width:6rem" />
                </>
              ) : null}
              {props.kind.article ? (
                <>
                  <label for="tags">{t("blog.tags")}</label>
                  <input id="tags" name="tags" value={props.kind.article.tags} maxlength={1000} />
                  <p class="muted">{t("blog.tags_help")}</p>
                  <label for="excerpt">{t("blog.excerpt")}</label>
                  <textarea id="excerpt" name="excerpt" rows={3} maxlength={1000} style="width:100%">
                    {props.kind.article.excerpt}
                  </textarea>
                  <label for="author">{t("blog.author")}</label>
                  <input id="author" name="author" value={props.kind.article.author} maxlength={100} />
                </>
              ) : null}
            </section>
            <section class="card">
              <h2>{t("pages.image")}</h2>
              {/* 画像のフォームは外に置き、欄とボタンは form 属性でそちらに結ぶ（フォームは入れ子にできない） */}
              <input id="page-image" type="file" name="file" accept="image/*" required form="page-image-form" />
              <p class="muted">{t("pages.image_help")}</p>
              <p>
                {props.publishing ? (
                  <>
                    <button type="button" class="secondary small" data-media="body" hidden>
                      {t("pages.media_library")}
                    </button>{" "}
                  </>
                ) : null}
                <button type="submit" class="secondary small" form="page-image-form">
                  {t("pages.image_upload")}
                </button>{" "}
                <span id="page-image-status" aria-live="polite"></span>
              </p>
            </section>
            <section class="card">
              <details>
                <summary>{t("pages.more")}</summary>
                <label for="seo_title">{t("pages.seo_title")}</label>
                <input id="seo_title" name="seo_title" value={v.seo_title ?? ""} maxlength={PAGE_LIMITS.seoTitle} />
                <label for="seo_description">{t("pages.seo_description")}</label>
                <textarea id="seo_description" name="seo_description" rows={3} maxlength={PAGE_LIMITS.seoDescription} style="width:100%">
                  {v.seo_description ?? ""}
                </textarea>
                <label for="template_suffix">{t("pages.template")}</label>
                <input id="template_suffix" name="template_suffix" value={v.template_suffix ?? ""} maxlength={40} pattern="[a-z0-9_\-]{1,40}" />
                <p class="muted">{t("pages.template_help")}</p>
              </details>
            </section>
            {props.pageId && props.revisions.length > 0 ? (
              <section class="card">
                <details>
                  <summary>{tf("pages.revisions", { n: props.revisions.length })}</summary>
                  <p class="muted">{t("pages.revisions_help")}</p>
                  <ul style="list-style:none;padding:0;margin:0">
                    {props.revisions.map((r) => (
                      <li style="padding:.4rem 0;border-top:1px solid var(--border)">
                        <div>{formatDateTime(r.created_at)}</div>
                        <div class="muted" style="font-size:.85rem">{r.title}</div>
                        <button type="submit" class="secondary small" form="page-revert" name="revision" value={r.id} formaction={`${props.action}/revisions/${r.id}/restore`}>
                          {t("pages.revision_restore")}
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              </section>
            ) : null}
            {props.pageId ? (
              <section class="card danger-zone">
                <button type="submit" class="secondary small" form="page-delete">
                  {props.publishing ? t("pages.trash") : t("pages.delete")}
                </button>
              </section>
            ) : null}
          </aside>
        </div>
      </form>
      <form method="post" action={`${props.kind.base}/images`} enctype="multipart/form-data" id="page-image-form" data-busy={t("pages.image_busy")} data-failed={t("pages.image_failed")}>
        <input type="hidden" name="back" value={props.selfUrl} />
      </form>
      {props.pageId ? (
        props.publishing ? (
          <form method="post" action={`${props.action}/trash`} id="page-delete" />
        ) : (
          <form method="post" action={`${props.action}/delete`} id="page-delete" onsubmit={`return confirm(${JSON.stringify(t("pages.delete_confirm"))})`} />
        )
      ) : null}
      {props.pageId && props.revisions.length > 0 ? <form method="post" action={`${props.action}/revisions`} id="page-revert" onsubmit={`return confirm(${JSON.stringify(t("pages.revision_confirm"))})`} /> : null}
      {props.publishing ? (
        <dialog id="media-lib" aria-labelledby="media-lib-title" data-list={`${props.kind.base}/media`} data-empty={t("pages.media_empty")}>
          <h2 id="media-lib-title" style="margin-top:0">
            {t("pages.media_library")}
          </h2>
          <p>
            {/* ファイルを選ぶ欄をダイアログの中に置く（iPad の写真の選択は、押した欄の位置に出る。隠れた欄を押させると閉じてしまう） */}
            <label class="pe-file" for="media-file">
              {t("pages.image_upload")}
              <input type="file" id="media-file" accept="image/*" multiple />
            </label>{" "}
            <button type="button" class="secondary small" id="media-close">
              {t("pages.cancel")}
            </button>
          </p>
          <p id="media-status" class="muted" aria-live="polite"></p>
          <div id="media-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(7rem,1fr));gap:.5rem;max-height:60vh;overflow:auto"></div>
        </dialog>
      ) : null}
      {/* 商品を並べるブロックの設定（PAGE_BLOCKS_SCRIPT が開く。JS が無ければ書式の「::: products …」を直接書く） */}
      <dialog id="blk-products" aria-labelledby="blk-products-title">
        <form method="dialog">
          <h2 id="blk-products-title">{t("pages.block_products")}</h2>
          <label for="bp-category">{t("pages.products_category")}</label>
          <select id="bp-category" name="category">
            <option value="">{t("pages.products_all")}</option>
            {props.categories.map((cat) => (
              <option value={cat.slug}>
                {cat.name}（{cat.slug}）
              </option>
            ))}
          </select>
          <label for="bp-tag">{t("pages.products_tag")}</label>
          {props.tags && props.tags.length > 0 ? (
            // お店にあるタグから選ぶ（大文字・小文字の違いで 0 件にならないように）。一覧に無いタグは開いたときにスクリプトが足す
            <select id="bp-tag" name="tag" data-missing={t("pages.products_tag_missing")}>
              <option value="">{t("pages.products_tag_any")}</option>
              {props.tags.map((x) => (
                <option value={x.tag}>
                  {x.tag}（{x.count}）
                </option>
              ))}
            </select>
          ) : (
            <input id="bp-tag" name="tag" maxlength={50} />
          )}
          <label for="bp-limit">{tf("pages.products_limit", { max: PRODUCT_BLOCK_LIMIT_MAX })}</label>
          <input id="bp-limit" name="limit" type="number" min={1} max={PRODUCT_BLOCK_LIMIT_MAX} value={String(PRODUCT_BLOCK_LIMIT_DEFAULT)} style="width:6rem" />
          <label for="bp-layout">{t("pages.products_layout")}</label>
          <select id="bp-layout" name="layout">
            <option value="grid">{t("pages.layout_grid")}</option>
            <option value="scroll">{t("pages.layout_scroll")}</option>
          </select>
          <label for="bp-sort">{t("pages.products_sort")}</label>
          <select id="bp-sort" name="sort">
            {PRODUCT_SORTS.map((x) => (
              <option value={x}>{t(`pages.sort_${x}` as MessageKey)}</option>
            ))}
          </select>
          <div id="bp-preview" class="bp-preview" aria-live="polite"></div>
          <p class="muted">{tf("pages.products_help", { n: PRODUCT_BLOCKS_MAX })}</p>
          <p>
            <button type="submit" value="ok">
              {t("pages.insert")}
            </button>{" "}
            <button type="submit" value="cancel" class="secondary" formnovalidate>
              {t("pages.cancel")}
            </button>
          </p>
        </form>
      </dialog>
      {/* ボタンのブロックの設定（PAGE_BLOCKS_SCRIPT が開く） */}
      <dialog id="blk-button" aria-labelledby="blk-button-title">
        <form method="dialog">
          <h2 id="blk-button-title">{t("pages.block_button")}</h2>
          <label for="bb-text">{t("pages.button_text")}</label>
          <input id="bb-text" name="text" maxlength={100} />
          <label for="bb-url">{t("pages.button_url")}</label>
          <input id="bb-url" name="url" maxlength={500} placeholder="/" />
          <p>
            <button type="submit" value="ok">
              {t("pages.insert")}
            </button>{" "}
            <button type="submit" value="cancel" class="secondary" formnovalidate>
              {t("pages.cancel")}
            </button>
          </p>
        </form>
      </dialog>
      <script dangerouslySetInnerHTML={{ __html: PAGE_EDITOR_SCRIPT }} />
      <script dangerouslySetInnerHTML={{ __html: visualEditorScript(props.kind.base) }} />
      <script dangerouslySetInnerHTML={{ __html: PAGE_BLOCKS_SCRIPT }} />
      {props.publishing ? <script dangerouslySetInnerHTML={{ __html: PAGE_MEDIA_SCRIPT }} /> : null}
    </div>
  );
}

/**
 * 画像を置く・メディアライブラリ・本文の変換の口を、ページや記事の管理画面のモジュールに付ける（同じ置き場 pages/<ショップ>/ と page_media を使う）。
 *   POST <base>/images   本文に使う画像を置く（ブラウザで縮小してから送る）
 *   GET  <base>/media    メディアライブラリ（0080）
 *   POST <base>/render   本文（決まった書式）を HTML にする（見たままの編集に切り替えるとき）
 */
export function mountEditorEndpoints(app: Hono<AppEnv>, scope: (c: AdminContext) => Promise<ShopRow | null>, baseOf: (c: AdminContext, shop: ShopRow) => string): void {
  const publishing = (c: AdminContext) => migrated({ db: owner(c).db, cache: c.get("adapters").cache }, PAGES_PUBLISHING_MIGRATION);
/** 本文に使う画像を置く。中身の先頭のバイトで種類を決め（SVG・HTML は受けない）、pages/<ショップ>/ に置く */
  app.post("/images", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
  const body = await c.req.parseBody();
  // JS の無いブラウザ: 直していた画面へ戻る（同じモジュールの画面だけ）
  const root = baseOf(c, shop);
  const back = typeof body.back === "string" && body.back.startsWith(root) && !body.back.includes("?") ? body.back : root;
  const fail = (key: MessageKey) => (wantsJson ? c.json({ error: t(key) }, 400) : c.redirect(`${back}?flash=image_error`));
  const file = body.file;
  if (!(file instanceof File) || file.size === 0) return fail("image.invalid_type");
  if (file.size > MAX_IMAGE_BYTES) return fail("image.too_large");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) return fail("image.invalid_type");
  const key = `pages/${shop.id}/${randomKey()}.${kind.ext}`;
  await c.get("adapters").storage.put(key, bytes.buffer as ArrayBuffer, kind.contentType);
  const url = imageUrl(mediaBaseUrl(c), key);
  // メディアライブラリに記録する（0080。記録できなくても画像は使える）
  if (await publishing(c)) await owner(c).db.from("page_media").insert({ shop_id: shop.id, storage_key: key, url }).catch((e: unknown) => console.error("[banto] page_media:", e));
  if (wantsJson) return c.json({ url });
  return c.redirect(`${back}?image=${encodeURIComponent(url)}`);
});

/** メディアライブラリ（0080）: 置いた画像の新しい順に 100 まで */
  app.get("/media", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop || !(await publishing(c))) return c.notFound();
  const items = await owner(c).db.from<{ id: string; url: string; created_at: string }>("page_media").select("id,url,created_at", { eq: { shop_id: shop.id }, order: "created_at.desc", limit: 100 });
  c.header("Cache-Control", "private, no-store");
  return c.json({ items });
});

/**
 * 商品を並べるブロックの見本（お店の画面と同じ関数・同じキャッシュで、並ぶ商品の数と最初の 6 つ）。
 * 置いたその場で「0 件」に気づけるように（タグの大文字・小文字の違いなど）。非公開のショップは並ばないので、そう返す
 */
  app.get("/products-preview", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  c.header("Cache-Control", "private, no-store");
  const sf = storefrontData(c);
  if (!shop.published || !sf) return c.json({ unpublished: true, total: 0, items: [] });
  const q = c.req.query();
  const sort = (PRODUCT_SORTS as readonly string[]).includes(q.sort ?? "") ? (q.sort as ProductSort) : "new";
  const n = Number(q.limit);
  const limit = Number.isInteger(n) && n >= 1 && n <= PRODUCT_BLOCK_LIMIT_MAX ? n : PRODUCT_BLOCK_LIMIT_DEFAULT;
  const tag = (q.tag ?? "").trim().slice(0, 50);
  const category = /^[a-z0-9][a-z0-9-]{0,62}$/.test(q.category ?? "") ? q.category! : "";
  const categories = category ? await owner(c).db.from<CategoryRow>("categories").select("*", { eq: { shop_id: shop.id } }) : [];
  const r = await sf.productPage(toPublicShop(shop), { ...(category ? { category } : {}), ...(tag ? { tag } : {}), sort, limit }, categories, { count: true });
  const items = (r?.items ?? []).slice(0, 6).map((x) => ({ name: x.product.name, image: x.image ? responsiveImage(mediaBaseUrl(c), x.image).src : null }));
  return c.json({ total: Math.min(r?.total ?? items.length, limit), items });
});

/** 本文（決まった書式）を HTML にして返す。見たままの編集に切り替えるとき（お店の画面と同じ変換） */
  app.post("/render", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const f = await formFields(c);
  const body = (f.body ?? "").slice(0, PAGE_LIMITS.body);
  return c.json({ html: editorHtml(c, body) });
});
}
