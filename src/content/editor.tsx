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
import { PRODUCT_SORTS } from "../storefront/data";
import { CLIENT_PRELUDE } from "../modules/woo-import/admin";
import { pageEditorClient } from "./editor-client";
import { PAGE_BLOCKS_SCRIPT, PAGE_MEDIA_SCRIPT } from "./blocks-script";

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

/** 管理画面で本文を HTML にする（商品のブロックは説明の箱にする） */
export const editorHtml = (c: AdminContext, body: string) => markdownToHtml(body, { mediaBase: mediaBaseUrl(c), productsLabel });

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
  function draw(im,max,q){ var w=im.naturalWidth,h=im.naturalHeight,r=Math.min(1,max/Math.max(w,h)); var c=document.createElement("canvas"); c.width=Math.max(1,Math.round(w*r)); c.height=Math.max(1,Math.round(h*r)); c.getContext("2d").drawImage(im,0,0,c.width,c.height); return new Promise(function(ok,ng){ c.toBlob(function(b){ if(b&&b.type==="image/webp") ok(b); else ng(new Error("webp")); },"image/webp",q); }); }
  form.addEventListener("submit",function(ev){
    var file=input.files&&input.files[0]; if(!file) return;
    ev.preventDefault(); st.textContent=form.getAttribute("data-busy")||"";
    var send=function(blob,name){ var fd=new FormData(); fd.append("file",new File([blob],name,{type:blob.type})); return fetch(form.action,{method:"POST",body:fd,credentials:"same-origin",headers:{Accept:"application/json"}}).then(function(r){ return r.json().then(function(j){ if(!r.ok||!j.url) throw new Error(j.error||"upload"); return j; }); }); };
    var go=/^image\\/(jpeg|png|webp|avif)$/.test(file.type)?load(file).then(function(im){ return draw(im,1600,0.82); }).then(function(b){ return send(b,"image.webp"); }):send(file,file.name);
    go.then(function(j){ if(!(window.bantoPageImage&&window.bantoPageImage(j.url))) insert("\\n![]("+j.url+")\\n"); st.textContent=""; input.value=""; }).catch(function(e){ st.textContent=(form.getAttribute("data-failed")||"")+" "+(e&&e.message||""); });
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
#body-visual{min-height:24rem;border:1px solid var(--border);border-radius:6px;padding:.75rem 1rem;overflow:auto}
#body-visual:focus{outline:2px solid var(--link);outline-offset:1px}
#body-visual table{border-collapse:collapse}#body-visual th,#body-visual td{border:1px solid var(--border);padding:.3rem .5rem}
#body-visual img{max-width:100%;height:auto}
#body-visual blockquote{margin:.5rem 0;padding-left:1rem;border-left:3px solid var(--border-strong)}
.pe-url{font-size:.85rem;word-break:break-all}
.blk-bar,.blk-menu{position:absolute;z-index:21;background:var(--bg);border:1px solid var(--border-strong);box-shadow:var(--shadow)}
.blk-bar{display:flex;gap:2px;border-radius:6px;padding:2px}
.blk-btn{height:26px;min-width:28px;padding:0 .35rem;background:var(--bg);color:var(--fg);border:0;border-radius:4px;font-size:.95rem}
.blk-btn:hover{background:var(--bg-subtle);opacity:1}
.blk-menu{display:flex;flex-direction:column;min-width:12rem;border-radius:8px;padding:4px}
.blk-opt{justify-content:flex-start;height:32px;background:transparent;color:var(--fg);border:0;border-radius:4px}
.blk-opt[aria-selected=true],.blk-opt:hover{background:var(--bg-subtle);opacity:1}
.blk-bar[hidden],.blk-menu[hidden]{display:none}
.page-preview .banto-products{border:1px dashed var(--border-strong);border-radius:6px;padding:.75rem 1rem;margin:.75rem 0;background:var(--bg-subtle);cursor:pointer;font-size:.9rem;user-select:none}
.page-preview .banto-products::before{content:"\\25A6  "}
.page-preview .banto-button__link{display:inline-block;padding:.5rem 1.25rem;border-radius:6px;background:var(--accent);color:var(--accent-fg);text-decoration:none;font-weight:600}
#blk-products{max-width:28rem;width:calc(100% - 2rem);border:1px solid var(--border-strong);border-radius:10px;padding:1.25rem 1.5rem}
#blk-products::backdrop{background:rgba(0,0,0,.35)}
@media (max-width:600px){.pe-bar button{height:32px;padding:0 .7rem;font-size:.85rem}.pe-bar .status{display:none}}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;

/** 編集の画面の種類ごとの違い（ページと記事） */
export interface EditorKind {
  /** 画像・メディア・変換の口の起点（…/modules/pages など。mountEditorEndpoints を付けた先） */
  base: string;
  /** お客様の画面の URL の名前の前（/pages/ や /blogs/news/） */
  urlPrefix: string;
  /** メニュー・並び順の欄（ページだけ） */
  nav: boolean;
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

export function ContentForm(props: { kind: EditorKind; shop: ShopRow; action: string; selfUrl: string; values: ContentValues; visual: string; categories: Pick<CategoryRow, "slug" | "name">[]; pageId?: string; viewUrl?: string | null; error?: MessageKey | null; image?: string | null; publishing: boolean; revisions: RevisionRow[] }) {
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
  };
  return (
    <>
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
          <div class="card">
            <label for="title" class="sr-only">
              {t("pages.title")}
            </label>
            <input id="title" name="title" class="pe-title" value={v.title} required maxlength={PAGE_LIMITS.title} placeholder={t("pages.title_placeholder")} />
            {/* JS があるときだけ出す（見たまま / Markdown の切り替え。pageEditorClient） */}
            <div id="body-tabs" role="tablist" hidden style="margin:.25rem 0">
              <button type="button" class="secondary small" role="tab" data-mode="visual" aria-selected="false">
                {t("pages.mode_visual")}
              </button>{" "}
              <button type="button" class="secondary small" role="tab" data-mode="markdown" aria-selected="true">
                {t("pages.mode_markdown")}
              </button>
            </div>
            <div class="toolbar" role="toolbar" aria-label={t("pages.tools")}>
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
              <span class="muted">{t("pages.block_hint")}</span>
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
            <button type="button" class="secondary small" id="media-upload">
              {t("pages.image_upload")}
            </button>{" "}
            <button type="button" class="secondary small" id="media-close">
              {t("pages.cancel")}
            </button>
          </p>
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
          <input id="bp-tag" name="tag" maxlength={50} />
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
      <script dangerouslySetInnerHTML={{ __html: PAGE_EDITOR_SCRIPT }} />
      <script dangerouslySetInnerHTML={{ __html: visualEditorScript(props.kind.base) }} />
      <script dangerouslySetInnerHTML={{ __html: PAGE_BLOCKS_SCRIPT }} />
      {props.publishing ? <script dangerouslySetInnerHTML={{ __html: PAGE_MEDIA_SCRIPT }} /> : null}
    </>
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

/** 本文（決まった書式）を HTML にして返す。見たままの編集に切り替えるとき（お店の画面と同じ変換） */
  app.post("/render", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const f = await formFields(c);
  const body = (f.body ?? "").slice(0, PAGE_LIMITS.body);
  return c.json({ html: editorHtml(c, body) });
});
}
