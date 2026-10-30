import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { ShopRow } from "../../db/types";
import { t, type MessageKey } from "../../i18n";
import { AdminLayout, PageHead } from "../../routes/admin/layout";
import { formFields, owner, param, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { loadShop } from "../../routes/admin/shops";
import { mediaBaseUrl, publicBaseUrl } from "../../routes/common";
import { MAX_IMAGE_BYTES, imageUrl, randomKey, sniffImage } from "../../media/images";
import { planLimitOf } from "../../plan/limits";
import { shopHome } from "../../storefront/urls";
import { moduleEnabled } from "../registry";
import { PAGE_LIMITS, PAGE_NAVS, PAGES_MODULE, pageHandleOk, type PageNav, type PageRow } from "../../pages";
import { markdownToHtml } from "../../pages/markdown";
import { CLIENT_PRELUDE } from "../woo-import/admin";
import { pageEditorClient } from "./editor-client";

/**
 * 同梱モジュール「ページ」の管理画面（0079_mod_pages、docs/pages.md）。扱えるのは content の項目を持つ人（RLS が正）。
 *   GET  /admin/shops/:shopId/modules/pages            一覧
 *   GET  /admin/shops/:shopId/modules/pages/new        新しいページ
 *   POST /admin/shops/:shopId/modules/pages            作る（action=preview ならプレビューだけ）
 *   GET  /admin/shops/:shopId/modules/pages/:pageId    直す
 *   POST /admin/shops/:shopId/modules/pages/:pageId    保存（action=preview ならプレビューだけ）
 *   POST /admin/shops/:shopId/modules/pages/:pageId/delete
 *   POST /admin/shops/:shopId/modules/pages/images     本文に使う画像を置く（ブラウザで縮小してから送る）
 */
export const pagesAdmin = new Hono<AppEnv>();

async function scope(c: AdminContext): Promise<ShopRow | null> {
  const shop = await loadShop(c, param(c, "shopId"), "content");
  return shop && moduleEnabled(shop.settings, PAGES_MODULE) ? shop : null;
}

type PageValues = Pick<PageRow, "title" | "handle" | "body" | "seo_title" | "seo_description" | "template_suffix" | "nav" | "sort_order" | "published">;

const EMPTY: PageValues = { title: "", handle: "", body: "", seo_title: null, seo_description: null, template_suffix: null, nav: "none", sort_order: 0, published: false };

/** フォームの値 → 行。誤りは文言の鍵（DB の CHECK が正。画面で先に止めて、入れた値を残したまま知らせる） */
function pageValues(f: Record<string, string>): { values: PageValues; error: MessageKey | null } {
  const opt = (v: string | undefined, max: number) => {
    const s = (v ?? "").trim();
    return s ? s.slice(0, max) : null;
  };
  const nav = (PAGE_NAVS as readonly string[]).includes(f.nav ?? "") ? (f.nav as PageNav) : "none";
  const sort = Number.parseInt(f.sort_order ?? "0", 10);
  const values: PageValues = {
    title: (f.title ?? "").trim(),
    handle: (f.handle ?? "").trim().toLowerCase(),
    body: (f.body ?? "").replace(/\r\n?/g, "\n"),
    seo_title: opt(f.seo_title, PAGE_LIMITS.seoTitle),
    seo_description: opt(f.seo_description, PAGE_LIMITS.seoDescription),
    template_suffix: opt(f.template_suffix, 40)?.toLowerCase() ?? null,
    nav,
    sort_order: Number.isInteger(sort) ? Math.max(-1000, Math.min(1000, sort)) : 0,
    published: f.published === "on",
  };
  if (!values.title || values.title.length > PAGE_LIMITS.title) return { values, error: "pages.error_title" };
  if (!pageHandleOk(values.handle)) return { values, error: "pages.error_handle" };
  if (values.body.length > PAGE_LIMITS.body) return { values, error: "pages.error_body" };
  if (values.template_suffix && !/^[a-z0-9_-]{1,40}$/.test(values.template_suffix)) return { values, error: "pages.error_template" };
  return { values, error: null };
}

/** DB の誤り → 文言の鍵 */
function dbError(e: DbError): MessageKey {
  if (planLimitOf(e)) return "plan.limit_pages";
  if (e.code === "23505") return "pages.error_handle_taken";
  if (/pages_full/.test(e.message)) return "pages.error_full";
  if (e.code === "23514") return "pages.error_invalid";
  return "error.generic";
}

const base = (shopId: string) => `/admin/shops/${shopId}/modules/pages`;

function layout(c: AdminContext, shop: ShopRow, title: string, crumbs: { label: string; href?: string }[], body: Child, status: 200 | 400 | 409 = 200) {
  return c.html(
    <AdminLayout title={`${shop.name} · ${title}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, ...crumbs]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "pages" }}>
      {body}
    </AdminLayout>,
    status,
  );
}

pagesAdmin.get("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const rows = await owner(c).db.from<PageRow>("pages").select("id,handle,title,nav,sort_order,published,updated_at", { eq: { shop_id: shop.id }, order: "sort_order.asc,created_at.asc" });
  const home = shopHome(publicBaseUrl(c), shop);
  const flash = c.req.query("flash");
  return layout(
    c,
    shop,
    t("mod.pages.name"),
    [{ label: t("mod.pages.name") }],
    <>
      <PageHead title={t("mod.pages.name")} sub={t("pages.intro")} />
      {flash === "deleted" ? <p class="notice">{t("pages.deleted")}</p> : null}
      <p>
        <a class="btn" href={`${base(shop.id)}/new`}>
          {t("pages.new")}
        </a>
      </p>
      {rows.length === 0 ? (
        <p class="muted">{t("pages.empty")}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("pages.title")}</th>
              <th>URL</th>
              <th>{t("pages.nav")}</th>
              <th>{t("pages.state")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr>
                <td>
                  <a href={`${base(shop.id)}/${p.id}`}>{p.title}</a>
                </td>
                <td>
                  {p.published && shop.published ? (
                    <a href={`${home}/pages/${p.handle}`} target="_blank" rel="noopener">
                      /pages/{p.handle}
                    </a>
                  ) : (
                    <span class="muted">/pages/{p.handle}</span>
                  )}
                </td>
                <td>{t(`pages.nav_${p.nav}` as MessageKey)}</td>
                <td>{p.published ? t("pages.published") : t("pages.draft")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>,
  );
});

/**
 * 本文の入力の手助け（見出し・太字・リンク・箇条書き…のボタンと、画像を縮小して置いて ![](URL) を入れる）。
 * JS が無くても本文は書ける（書式は docs/pages.md と画面の説明のとおり）。画像は下のフォームで置いて、出た行を貼る
 */
const PAGE_EDITOR_SCRIPT = `
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
function visualEditorScript(shopId: string): string {
  const cfg = { render: `${base(shopId)}/render`, t: { cell: t("pages.tool_table_cell") } };
  return `${CLIENT_PRELUDE}(${pageEditorClient.toString()})().mount(${JSON.stringify(cfg).replace(/</g, "\\u003c")});`;
}

function PageForm(props: { shop: ShopRow; action: string; values: PageValues; visual: string; error?: MessageKey | null; preview?: string | null; image?: string | null }) {
  const v = props.values;
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
  return (
    <>
      {props.error ? <p class="error">{t(props.error)}</p> : null}
      {props.image ? (
        <p class="notice">
          {t("pages.image_ready")} <code>![]({props.image})</code>
        </p>
      ) : null}
      {props.preview !== undefined && props.preview !== null ? (
        <section class="card">
          <h2>{t("pages.preview")}</h2>
          <h1>{v.title}</h1>
          <div class="page-preview">{raw(props.preview)}</div>
        </section>
      ) : null}
      <form method="post" action={props.action} class="card" id="page-form">
        <label for="title">{t("pages.title")}</label>
        <input id="title" name="title" value={v.title} required maxlength={PAGE_LIMITS.title} />
        <label for="handle">{t("pages.handle")}</label>
        <input id="handle" name="handle" value={v.handle} required maxlength={64} pattern="[a-z0-9]([a-z0-9\-]{0,62}[a-z0-9])?" />
        <p class="muted">{t("pages.handle_help")}</p>
        <label for="body">{t("pages.body")}</label>
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
        <div id="body-visual" class="page-preview" contenteditable={true} role="textbox" aria-multiline="true" aria-label={t("pages.body")} hidden data-ready="1" style="min-height:20rem;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);border-radius:.3rem;padding:.75rem 1rem;overflow:auto">
          {raw(props.visual)}
        </div>
        <textarea id="body" name="body" rows={20} maxlength={PAGE_LIMITS.body} style="width:100%;font-family:ui-monospace,monospace">
          {v.body}
        </textarea>
        <details>
          <summary>{t("pages.syntax")}</summary>
          <pre class="muted" style="white-space:pre-wrap">{t("pages.syntax_help")}</pre>
        </details>
        <label for="nav">{t("pages.nav")}</label>
        <select id="nav" name="nav">
          {PAGE_NAVS.map((n) => (
            <option value={n} selected={v.nav === n}>
              {t(`pages.nav_${n}` as MessageKey)}
            </option>
          ))}
        </select>
        <label for="sort_order">{t("pages.sort_order")}</label>
        <input id="sort_order" name="sort_order" type="number" min={-1000} max={1000} value={String(v.sort_order)} style="width:6rem" />
        <details>
          <summary>{t("pages.more")}</summary>
          <label for="seo_title">{t("pages.seo_title")}</label>
          <input id="seo_title" name="seo_title" value={v.seo_title ?? ""} maxlength={PAGE_LIMITS.seoTitle} />
          <label for="seo_description">{t("pages.seo_description")}</label>
          <textarea id="seo_description" name="seo_description" rows={2} maxlength={PAGE_LIMITS.seoDescription} style="width:100%">
            {v.seo_description ?? ""}
          </textarea>
          <label for="template_suffix">{t("pages.template")}</label>
          <input id="template_suffix" name="template_suffix" value={v.template_suffix ?? ""} maxlength={40} pattern="[a-z0-9_\-]{1,40}" />
          <p class="muted">{t("pages.template_help")}</p>
        </details>
        <label>
          <input type="checkbox" name="published" value="on" checked={v.published} /> {t("pages.publish")}
        </label>
        <p>
          <button type="submit" name="action" value="save">
            {t("pages.save")}
          </button>{" "}
          <button type="submit" name="action" value="preview" class="secondary">
            {t("pages.preview")}
          </button>
        </p>
      </form>
      <form method="post" action={`${base(props.shop.id)}/images`} enctype="multipart/form-data" id="page-image-form" class="card" data-busy={t("pages.image_busy")} data-failed={t("pages.image_failed")}>
        <input type="hidden" name="back" value={props.action} />
        <label for="page-image">{t("pages.image")}</label>
        <input id="page-image" type="file" name="file" accept="image/*" required />
        <p class="muted">{t("pages.image_help")}</p>
        <p>
          <button type="submit" class="secondary">
            {t("pages.image_upload")}
          </button>{" "}
          <span id="page-image-status" aria-live="polite"></span>
        </p>
      </form>
      <script dangerouslySetInnerHTML={{ __html: PAGE_EDITOR_SCRIPT }} />
      <script dangerouslySetInnerHTML={{ __html: visualEditorScript(props.shop.id) }} />
    </>
  );
}

function editPage(c: AdminContext, shop: ShopRow, opts: { pageId?: string; values: PageValues; error?: MessageKey | null; preview?: string | null; status?: 200 | 400 | 409 }) {
  const title = opts.pageId ? opts.values.title || t("pages.edit") : t("pages.new");
  const action = opts.pageId ? `${base(shop.id)}/${opts.pageId}` : base(shop.id);
  const flash = c.req.query("flash");
  const image = c.req.query("image");
  return layout(
    c,
    shop,
    title,
    [{ label: t("mod.pages.name"), href: base(shop.id) }, { label: title }],
    <>
      <PageHead title={title} />
      {flash === "saved" ? <p class="notice">{t("shop.saved")}</p> : null}
      <PageForm shop={shop} action={action} values={opts.values} visual={markdownToHtml(opts.values.body, { mediaBase: mediaBaseUrl(c) })} error={opts.error ?? null} preview={opts.preview ?? null} image={image && image.startsWith(mediaBaseUrl(c)) ? image : null} />
      {opts.pageId ? (
        <section class="card danger-zone">
          <h2>{t("pages.delete")}</h2>
          <form method="post" action={`${action}/delete`} onsubmit={`return confirm(${JSON.stringify(t("pages.delete_confirm"))})`}>
            <button type="submit">{t("pages.delete")}</button>
          </form>
        </section>
      ) : null}
    </>,
    opts.status ?? 200,
  );
}

pagesAdmin.get("/new", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  return editPage(c, shop, { values: EMPTY });
});

/** 作る・保存する。action=preview なら保存せずにプレビューを出す（入れた値はそのまま） */
async function save(c: AdminContext, pageId: string | null) {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const f = await formFields(c);
  const { values, error } = pageValues(f);
  const page = pageId ? { pageId } : {};
  if (f.action === "preview") return editPage(c, shop, { ...page, values, error, preview: markdownToHtml(values.body, { mediaBase: mediaBaseUrl(c) }) });
  if (error) return editPage(c, shop, { ...page, values, error, status: 400 });
  const db = owner(c).db;
  try {
    if (pageId) {
      const rows = await db.from<PageRow>("pages").update(values, { id: pageId, shop_id: shop.id });
      if (rows.length === 0) return c.notFound();
      return c.redirect(`${base(shop.id)}/${pageId}?flash=saved`);
    }
    const [row] = await db.from<PageRow>("pages").insert({ ...values, shop_id: shop.id });
    return c.redirect(`${base(shop.id)}/${row!.id}?flash=saved`);
  } catch (e) {
    if (e instanceof DbError) return editPage(c, shop, { ...page, values, error: dbError(e), status: e.code === "23505" ? 409 : 400 });
    throw e;
  }
}

pagesAdmin.post("/", requireOwner, (c: AdminContext) => save(c, null));

/** 本文に使う画像を置く。中身の先頭のバイトで種類を決め（SVG・HTML は受けない）、pages/<ショップ>/ に置く */
pagesAdmin.post("/images", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
  const body = await c.req.parseBody();
  const back = typeof body.back === "string" && body.back.startsWith(`${base(shop.id)}`) && !body.back.includes("?") ? body.back : `${base(shop.id)}/new`;
  const fail = (key: MessageKey) => (wantsJson ? c.json({ error: t(key) }, 400) : c.redirect(`${back.endsWith("/pages") ? `${back}/new` : back}?flash=image_error`));
  const file = body.file;
  if (!(file instanceof File) || file.size === 0) return fail("image.invalid_type");
  if (file.size > MAX_IMAGE_BYTES) return fail("image.too_large");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) return fail("image.invalid_type");
  const key = `pages/${shop.id}/${randomKey()}.${kind.ext}`;
  await c.get("adapters").storage.put(key, bytes.buffer as ArrayBuffer, kind.contentType);
  const url = imageUrl(mediaBaseUrl(c), key);
  if (wantsJson) return c.json({ url });
  return c.redirect(`${back.endsWith("/pages") ? `${back}/new` : back}?image=${encodeURIComponent(url)}`);
});

/** 本文（決まった書式）を HTML にして返す。見たままの編集に切り替えるとき（お店の画面と同じ変換） */
pagesAdmin.post("/render", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const f = await formFields(c);
  const body = (f.body ?? "").slice(0, PAGE_LIMITS.body);
  return c.json({ html: markdownToHtml(body, { mediaBase: mediaBaseUrl(c) }) });
});

pagesAdmin.get("/:pageId", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const pageId = param(c, "pageId");
  let row: PageRow | null = null;
  try {
    row = await owner(c).db.from<PageRow>("pages").selectOne("*", { eq: { id: pageId, shop_id: shop.id } });
  } catch (e) {
    if (e instanceof DbError && e.code === "22P02") return c.notFound(); // id の形が違う
    throw e;
  }
  if (!row) return c.notFound();
  const error = c.req.query("flash") === "image_error" ? ("image.invalid_type" as const) : null;
  return editPage(c, shop, { pageId, values: row, error });
});

pagesAdmin.post("/:pageId", requireOwner, (c: AdminContext) => save(c, param(c, "pageId")));

pagesAdmin.post("/:pageId/delete", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  try {
    await owner(c).db.from("pages").delete({ id: param(c, "pageId"), shop_id: shop.id });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${base(shop.id)}?flash=generic`);
    throw e;
  }
  return c.redirect(`${base(shop.id)}?flash=deleted`);
});
