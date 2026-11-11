import { Hono } from "hono";
import { previewResponse, wantsPreviewJson } from "../../content/preview";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { ShopRow } from "../../db/types";
import { t, tf, type MessageKey } from "../../i18n";
import { AdminLayout, PageHead } from "../../routes/admin/layout";
import { formFields, owner, param, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { loadShop } from "../../routes/admin/shops";
import { mediaBaseUrl, publicBaseUrl } from "../../routes/common";
import { planLimitOf } from "../../plan/limits";
import { shopHome } from "../../storefront/urls";
import { moduleEnabled } from "../registry";
import { PAGE_LIMITS, PAGE_NAVS, PAGE_PARTS_MIGRATION, PAGES_MODULE, PAGES_TRASH_DAYS, handleFromTitle, pageHandleOk, randomPageHandle, type PageNav, type PageRow } from "../../pages";
import { formatDateTime, zonedInputToIso } from "../../i18n/time";
import type { CategoryRow } from "../../db/types";
import { BLOG_LAYOUT_MIGRATION, pageLayoutsOf } from "../../content/layouts";
import { migrated } from "../../db/migration-state";
import { categoryTree, type CategoryNode } from "../../products/categories";
import { BLOG_MODULE, type BlogRow } from "../../blog";
import { ContentForm, contentState, editorCatalog, editorHtml, featuredImageUrl, mountEditorEndpoints, type RevisionRow, contentAudienceValues } from "../../content/editor";

/**
 * 同梱モジュール「ページ」の管理画面（0079_mod_pages、docs/pages.md）。扱えるのは content の項目を持つ人（RLS が正）。
 *   GET  /admin/shops/:shopId/modules/pages            一覧
 *   GET  /admin/shops/:shopId/modules/pages/new        新しいページ
 *   POST /admin/shops/:shopId/modules/pages            作る（action: draft = 下書き保存 / publish = 公開 / update = 状態はそのまま / preview = 新しいタブにプレビューだけ）
 *   GET  /admin/shops/:shopId/modules/pages/:pageId    直す
 *   POST /admin/shops/:shopId/modules/pages/:pageId    保存（action は作るときと同じ）
 *   POST /admin/shops/:shopId/modules/pages/:pageId/delete
 *   POST /admin/shops/:shopId/modules/pages/images     本文に使う画像を置く（ブラウザで縮小してから送る）
 */
export const pagesAdmin = new Hono<AppEnv>();

async function scope(c: AdminContext): Promise<ShopRow | null> {
  const shop = await loadShop(c, param(c, "shopId"), "content");
  return shop && moduleEnabled(shop.settings, PAGES_MODULE) ? shop : null;
}

type PageValues = Pick<PageRow, "title" | "handle" | "body" | "seo_title" | "seo_description" | "template_suffix" | "nav" | "sort_order" | "published" | "published_at" | "image_url" | "audience_id" | "audience_hide" | "is_part">;

const EMPTY: PageValues = { title: "", handle: "", body: "", seo_title: null, seo_description: null, template_suffix: null, nav: "none", sort_order: 0, published: false, published_at: null, image_url: null };

/**
 * フォームの値 → 行。誤りは文言の鍵（DB の CHECK が正。画面で先に止めて、入れた値を残したまま知らせる）。
 * 公開するかは押したボタン（action: draft → 下書き、publish → 公開、それ以外は published の欄のまま）。
 * URL の名前が空ならタイトルから作り、作れなければ page-xxxxxx（autoHandle。重なったら作り直す）
 */
function pageValues(f: Record<string, string>, opts: { mediaBase: string }): { values: PageValues; error: MessageKey | null; autoHandle: boolean } {
  const opt = (v: string | undefined, max: number) => {
    const s = (v ?? "").trim();
    return s ? s.slice(0, max) : null;
  };
  const nav = (PAGE_NAVS as readonly string[]).includes(f.nav ?? "") ? (f.nav as PageNav) : "none";
  const sort = Number.parseInt(f.sort_order ?? "0", 10);
  const title = (f.title ?? "").trim();
  const typed = (f.handle ?? "").trim().toLowerCase();
  const autoHandle = typed === "";
  const values: PageValues = {
    title,
    handle: autoHandle ? handleFromTitle(title) || randomPageHandle() : typed,
    body: (f.body ?? "").replace(/\r\n?/g, "\n"),
    seo_title: opt(f.seo_title, PAGE_LIMITS.seoTitle),
    seo_description: opt(f.seo_description, PAGE_LIMITS.seoDescription),
    template_suffix: opt(f.template_suffix, 40)?.toLowerCase() ?? null,
    nav,
    sort_order: Number.isInteger(sort) ? Math.max(-1000, Math.min(1000, sort)) : 0,
    published: f.action === "publish" ? true : f.action === "draft" ? false : f.published === "on",
    // 公開する日時（ショップの時間帯の「日付と時刻」。空ならすぐ）とアイキャッチ
    published_at: f.published_at ? zonedInputToIso(f.published_at) : null,
    image_url: (f.image_url ?? "").trim() || null,
    ...contentAudienceValues(f),
    // 部品のページ（0122）。欄があったときだけ書く（当たる前の DB に列を送らない）
    ...(f.is_part_present === "1" ? { is_part: f.is_part === "on" } : {}),
  };
  if (f.published_at && !values.published_at) return { values, error: "pages.error_published_at", autoHandle };
  if (values.image_url) {
    const img = featuredImageUrl(values.image_url, opts.mediaBase);
    if (!img) return { values, error: "pages.error_image", autoHandle };
    values.image_url = img;
  }
  if (!values.title || values.title.length > PAGE_LIMITS.title) return { values, error: "pages.error_title", autoHandle };
  if (!pageHandleOk(values.handle)) return { values, error: "pages.error_handle", autoHandle };
  if (values.body.length > PAGE_LIMITS.body) return { values, error: "pages.error_body", autoHandle };
  if (values.template_suffix && !/^[a-z0-9_-]{1,40}$/.test(values.template_suffix)) return { values, error: "pages.error_template", autoHandle };
  return { values, error: null, autoHandle };
}

/** DB の誤り → 文言の鍵 */
function dbError(e: DbError): MessageKey {
  if (planLimitOf(e)) return "plan.limit_pages";
  if (e.code === "23505") return "pages.error_handle_taken";
  if (/audience_display_only/.test(e.message)) return "product.audience_display_only";
  if (/pages_full/.test(e.message)) return "pages.error_full";
  if (e.code === "23514") return "pages.error_invalid";
  return "error.generic";
}

const base = (shopId: string) => `/admin/shops/${shopId}/modules/pages`;

function layout(c: AdminContext, shop: ShopRow, title: string, crumbs: { label: string; href?: string }[], body: Child, status: 200 | 400 | 409 = 200, here: "pages" | "layouts" = "pages") {
  return c.html(
    <AdminLayout title={`${shop.name} · ${title}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, ...crumbs]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "pages", here }}>
      {body}
    </AdminLayout>,
    status,
  );
}

pagesAdmin.get("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const parts = await migrated({ db: owner(c).db, cache: c.get("adapters").cache }, PAGE_PARTS_MIGRATION);
  const cols = `id,handle,title,nav,sort_order,published,published_at,deleted_at,updated_at${parts ? ",is_part" : ""}`;
  const all = await owner(c).db.from<PageRow>("pages").select(cols, { eq: { shop_id: shop.id }, order: "sort_order.asc,created_at.asc" });
  const home = shopHome(publicBaseUrl(c), shop);
  const flash = c.req.query("flash");
  // タブ（すべて = ゴミ箱の外）と検索（タイトルと URL の名前。ページは 1 つのショップに 100 までなので、絞り込みはここで）
  const tabs = ["all", "published", "scheduled", "draft", "trash"] as const;
  const tabParam = c.req.query("status") ?? "all";
  const tab = (tabs as readonly string[]).includes(tabParam) ? tabParam : "all";
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const states = all.map((p) => ({ p, state: contentState(p) }));
  const count = (k: string) => states.filter((x) => (k === "all" ? x.state !== "trash" : x.state === k)).length;
  const rows = states.filter((x) => (tab === "all" ? x.state !== "trash" : x.state === tab) && (!q || x.p.title.toLowerCase().includes(q.toLowerCase()) || x.p.handle.includes(q.toLowerCase())));
  const link = (k: string) => `${base(shop.id)}${k === "all" ? "" : `?status=${k}`}`;
  return layout(
    c,
    shop,
    t("mod.pages.name"),
    [{ label: t("mod.pages.name") }],
    <>
      <PageHead title={t("mod.pages.name")} sub={t("pages.intro")} />
      {flash === "deleted" ? <p class="notice">{t("pages.deleted")}</p> : null}
      {flash === "trashed" ? <p class="notice">{tf("pages.trashed", { n: PAGES_TRASH_DAYS })}</p> : null}
      {flash === "restored" ? <p class="notice">{t("pages.restored")}</p> : null}
      {flash === "restore_conflict" ? <p class="error">{t("pages.restore_conflict")}</p> : null}
      <p>
        <a class="btn" href={`${base(shop.id)}/new`}>
          {t("pages.new")}
        </a>
        <>
          {" "}
          <a class="btn secondary" href={`${base(shop.id)}/layouts`}>
            {t("pages.layouts")}
          </a>
        </>
      
      </p>
      <form method="get" action={base(shop.id)} class="toolbar" role="search">
        <nav aria-label={t("pages.state")} style="display:flex;gap:.75rem;flex-wrap:wrap">
          {tabs.map((k) => (
            <a href={link(k)} aria-current={tab === k ? "page" : undefined} style={tab === k ? "font-weight:600;color:var(--fg)" : "color:var(--fg-muted)"}>
              {t(`pages.tab_${k}` as MessageKey)} ({count(k)})
            </a>
          ))}
        </nav>
        {tab !== "all" ? <input type="hidden" name="status" value={tab} /> : null}
        <input type="search" name="q" value={q} placeholder={t("pages.search")} aria-label={t("pages.search")} />
        <button type="submit" class="secondary small">
          {t("pages.search_go")}
        </button>
      </form>
      {tab === "trash" ? <p class="muted">{tf("pages.trash_help", { n: PAGES_TRASH_DAYS })}</p> : null}
      {rows.length === 0 ? (
        <p class="muted">{all.length === 0 ? t("pages.empty") : t("pages.none_here")}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("pages.title")}</th>
              <th>URL</th>
              <th>{t("pages.nav")}</th>
              <th>{t("pages.state")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ p, state }) => (
              <tr>
                <td>{state === "trash" ? p.title : <a href={`${base(shop.id)}/${p.id}`}>{p.title}</a>}</td>
                <td>
                  {state === "published" && shop.published ? (
                    <a href={`${home}/pages/${p.handle}`} target="_blank" rel="noopener">
                      /pages/{p.handle}
                    </a>
                  ) : (
                    <span class="muted">/pages/{p.handle}</span>
                  )}
                </td>
                <td>{p.is_part ? <span class="badge">{t("pages.part_badge")}</span> : t(`pages.nav_${p.nav}` as MessageKey)}</td>
                <td>
                  {t(`pages.state_${state}` as MessageKey)}
                  {state === "scheduled" && p.published_at ? <span class="muted"> {formatDateTime(p.published_at)}</span> : null}
                </td>
                <td style="white-space:nowrap">
                  {state === "trash" ? (
                    <>
                      <form method="post" action={`${base(shop.id)}/${p.id}/restore`} style="display:inline">
                        <button type="submit" class="secondary small">
                          {t("pages.restore")}
                        </button>
                      </form>
                    </>
                  ) : (
                    <form method="post" action={`${base(shop.id)}/${p.id}/trash`} style="display:inline">
                      <button type="submit" class="secondary small">
                        {t("pages.trash")}
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>,
  );
});

async function editPage(c: AdminContext, shop: ShopRow, opts: { pageId?: string; values: PageValues; error?: MessageKey | null; status?: 200 | 400 | 409 }) {
  // 商品を並べるブロックで選ぶカテゴリーとタグ
  const db = owner(c).db;
  const [catalog, parts] = await Promise.all([editorCatalog(c, shop), migrated({ db, cache: c.get("adapters").cache }, PAGE_PARTS_MIGRATION)]);
  // リビジョン（0080。新しい順に 20 まで）
  const revisions = opts.pageId ? await db.from<RevisionRow>("page_revisions").select("id,title,created_at", { eq: { page_id: opts.pageId, shop_id: shop.id }, order: "created_at.desc", limit: 20 }) : [];
  const title = opts.pageId ? opts.values.title || t("pages.edit") : t("pages.new");
  const action = opts.pageId ? `${base(shop.id)}/${opts.pageId}` : base(shop.id);
  const flash = c.req.query("flash");
  const image = c.req.query("image");
  const live = contentState({ published: opts.values.published, published_at: opts.values.published_at ?? null, deleted_at: null }) === "published";
  const viewUrl = opts.pageId && live && shop.published ? `${shopHome(publicBaseUrl(c), shop)}/pages/${opts.values.handle}` : null;
  return layout(
    c,
    shop,
    title,
    [{ label: t("mod.pages.name"), href: base(shop.id) }, { label: title }],
    <>
      <PageHead title={title} />
      {flash === "saved" ? <p class="notice">{t("shop.saved")}</p> : null}
      {flash === "reverted" ? <p class="notice">{t("pages.reverted")}</p> : null}
      <ContentForm kind={{ base: base(shop.id), urlPrefix: "/pages/", nav: true, part: parts }} selfUrl={opts.pageId ? `${base(shop.id)}/${opts.pageId}` : `${base(shop.id)}/new`} revisions={revisions} shop={shop} action={action} values={opts.values} visual={editorHtml(c, opts.values.body)} categories={catalog.categories} tags={catalog.tags} extras={catalog} {...(opts.pageId ? { pageId: opts.pageId } : {})} viewUrl={viewUrl} error={opts.error ?? null} image={image && image.startsWith(mediaBaseUrl(c)) ? image : null} />
    </>,
    opts.status ?? 200,
  );
}

/** プレビュー（新しいタブ。保存しない）。本文はお店の画面と同じ変換、見た目はテーマが決めるので管理画面の形で中身だけ見せる */
async function previewPage(c: AdminContext, shop: ShopRow, values: PageValues, error: MessageKey | null, pageId: string | null = null) {
  // お店の画面と同じテーマ・同じブロックの中身で描く（描けないテーマなら下の簡単な形）
  if (!error) {
    const now = new Date().toISOString();
    // 保存済みのページは本当の id（ひな形に割り当てていれば、プレビューは見本の記事・商品で描く）
    const page: PageRow = { id: pageId ?? "preview", shop_id: shop.id, created_at: now, updated_at: now, ...values, body: values.body } as PageRow;
    const categories = await owner(c).db.from<CategoryRow>("categories").select("*", { eq: { shop_id: shop.id }, order: "sort_order.asc" }).catch(() => [] as CategoryRow[]);
    const res = await previewResponse(c, shop, { kind: "page", page }, categories);
    if (res) return res;
  }
  // 編集の画面のスクリプト（プレビューのタブ・お店の見た目の欄）には、描けない理由だけ
  if (wantsPreviewJson(c)) return c.json({ kind: "error", message: t(error ?? "pages.preview_note") });
  return layout(
    c,
    shop,
    t("pages.preview"),
    [{ label: t("mod.pages.name"), href: base(shop.id) }, { label: t("pages.preview") }],
    <>
      <p class="notice">{t("pages.preview_note")}</p>
      {error ? <p class="error">{t(error)}</p> : null}
      <article class="card page-preview">
        <h1>{values.title}</h1>
        {raw(editorHtml(c, values.body))}
      </article>
    </>,
  );
}

pagesAdmin.get("/new", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  return editPage(c, shop, { values: EMPTY });
});

// ---------- ひな形の割り当て（0101〜0104、docs/pages.md「ひな形の割り当て」） ----------

/** カテゴリーの木を上から順に（深さつき） */
function flattenTree(nodes: CategoryNode[], depth = 0): { node: CategoryNode; depth: number }[] {
  return nodes.flatMap((node) => [{ node, depth }, ...flattenTree(node.children, depth + 1)]);
}

async function layoutsPage(c: AdminContext, shop: ShopRow, flash: "saved" | "error" | null, status: 200 | 400 = 200) {
  const db = owner(c).db;
  const blogOn = moduleEnabled(shop.settings, BLOG_MODULE);
  const [pages, blogs, categories] = await Promise.all([
    db.from<PageRow>("pages").select("id,title,handle,published,deleted_at", { eq: { shop_id: shop.id }, order: "sort_order.asc,created_at.asc" }),
    blogOn ? db.from<BlogRow>("blogs").select("id,title", { eq: { shop_id: shop.id }, order: "sort_order.asc,created_at.asc" }) : Promise.resolve([] as BlogRow[]),
    db.from<CategoryRow>("categories").select("id,name,parent_id,sort_order", { eq: { shop_id: shop.id }, order: "sort_order.asc,name.asc" }),
  ]);
  const usable = pages.filter((p) => !p.deleted_at);
  const cur = pageLayoutsOf(shop.settings);
  // ブログの一覧のひな形（0114）は当たるまで出さない
  const blogLists = blogs.length > 0 && (await migrated({ db, cache: c.get("adapters").cache }, BLOG_LAYOUT_MIGRATION));
  const select = (name: string, value: string | null, none: MessageKey = "pages.layouts_none") => (
    <select name={name} id={name}>
      <option value="">{t(none)}</option>
      {usable.map((p) => (
        <option value={p.id} selected={p.id === value}>
          {p.title} (/pages/{p.handle}){p.published ? "" : ` — ${t("pages.tab_draft")}`}
        </option>
      ))}
    </select>
  );
  return layout(
    c,
    shop,
    t("pages.layouts"),
    [{ label: t("mod.pages.name"), href: base(shop.id) }, { label: t("pages.layouts") }],
    <>
      <PageHead title={t("pages.layouts")} sub={t("pages.layouts_desc")} />
      {flash === "saved" ? <p class="notice">{t("pages.layouts_saved")}</p> : null}
      {flash === "error" ? <p class="error">{t("pages.layouts_error")}</p> : null}
      <form method="post" action={`${base(shop.id)}/layouts`} class="card">
        <label for="home">{t("pages.layouts_home")}</label>
        {select("home", cur.home)}
        <p class="muted">{t("pages.layouts_home_help")}</p>
        {blogs.map((b) => (
          <>
            {blogLists ? (
              <>
                <label for={`bloglist_${b.id}`}>{tf("pages.layouts_blog_list", { blog: b.title })}</label>
                {select(`bloglist_${b.id}`, cur.blogs[b.id] ?? null)}
              </>
            ) : null}
            <label for={`article_${b.id}`}>{tf("pages.layouts_article", { blog: b.title })}</label>
            {select(`article_${b.id}`, cur.articles[b.id] ?? null)}
          </>
        ))}
        {blogLists ? <p class="muted">{t("pages.layouts_blog_list_help")}</p> : null}
        {blogs.length > 0 ? <p class="muted">{t("pages.layouts_article_help")}</p> : null}
        <>
          <label for="product">{t("pages.layouts_product")}</label>
          {select("product", cur.product)}
          <p class="muted">{t("pages.layouts_product_help")}</p>
          {categories.length > 0 ? (
            <details open={Object.keys(cur.productCategories).length > 0}>
              <summary>{t("pages.layouts_categories")}</summary>
              {flattenTree(categoryTree(categories)).map(({ node, depth }) => (
                <>
                  <label for={`category_${node.id}`} style={`padding-left:${depth * 1.25}rem`}>
                    {tf("pages.layouts_category", { category: node.name })}
                  </label>
                  <div style={`padding-left:${depth * 1.25}rem`}>{select(`category_${node.id}`, cur.productCategories[node.id] ?? null, "pages.layouts_inherit")}</div>
                </>
              ))}
            </details>
          ) : null}
        </>
      
        <>
          <label for="collection">{t("pages.layouts_collection")}</label>
          {select("collection", cur.collection)}
          <p class="muted">{t("pages.layouts_collection_help")}</p>
          {categories.length > 0 ? (
            <details open={Object.keys(cur.collectionCategories).length > 0}>
              <summary>{t("pages.layouts_collection_categories")}</summary>
              {flattenTree(categoryTree(categories)).map(({ node, depth }) => (
                <>
                  <label for={`ccategory_${node.id}`} style={`padding-left:${depth * 1.25}rem`}>
                    {tf("pages.layouts_collection_category", { category: node.name })}
                  </label>
                  <div style={`padding-left:${depth * 1.25}rem`}>{select(`ccategory_${node.id}`, cur.collectionCategories[node.id] ?? null, "pages.layouts_inherit")}</div>
                </>
              ))}
            </details>
          ) : null}
        </>
      
        <>
          <label for="legal">{t("pages.layouts_legal")}</label>
          {select("legal", cur.legal)}
          <p class="muted">{t("pages.layouts_legal_help")}</p>
          <details open={Object.keys(cur.legalPages).length > 0}>
            <summary>{t("pages.layouts_legal_pages")}</summary>
            {(["legal", "privacy", "returns"] as const).map((k) => (
              <>
                <label for={`legal_${k}`}>{t(k === "legal" ? "shop.legal_notice" : k === "privacy" ? "shop.privacy_policy" : "shop.return_policy")}</label>
                {select(`legal_${k}`, cur.legalPages[k] ?? null, "pages.layouts_inherit")}
              </>
            ))}
          </details>
        </>
      
        <p class="muted">{t("pages.layouts_hidden_note")}</p>
        <p>
          <button type="submit">{t("shop.save")}</button> <a href={base(shop.id)}>{t("blocks.cancel")}</a>
        </p>
      </form>
    </>,
    status,
    "layouts",
  );
}

pagesAdmin.get("/layouts", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  return layoutsPage(c, shop, c.req.query("flash") === "saved" ? "saved" : null);
});

pagesAdmin.post("/layouts", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const f = await formFields(c);
  const articles: Record<string, string> = {};
  const cats: Record<string, string> = {};
  const ccats: Record<string, string> = {};
  const blogLists: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) {
    if (k.startsWith("bloglist_") && v) blogLists[k.slice("bloglist_".length)] = v;
    if (k.startsWith("article_") && v) articles[k.slice("article_".length)] = v;
    if (k.startsWith("category_") && v) cats[k.slice("category_".length)] = v;
    if (k.startsWith("ccategory_") && v) ccats[k.slice("ccategory_".length)] = v;
  }
  const collection = { collection: f["collection"] || null, collection_categories: ccats };
  const legalPagesSel: Record<string, string> = {};
  for (const k of ["legal", "privacy", "returns"]) if (f[`legal_${k}`]) legalPagesSel[k] = f[`legal_${k}`]!;
  const legal = { legal: f["legal"] || null, legal_pages: legalPagesSel };
  const product = { product: f["product"] || null, product_categories: cats };
  try {
    // ブログの一覧（0114）: 当たる前の DB は blogs の鍵を断るので送らない（当たった後は、欄が無い = 外す）
    const withBlogs = (await migrated({ db: owner(c).db, cache: c.get("adapters").cache }, BLOG_LAYOUT_MIGRATION)) ? { blogs: blogLists } : {};
    await owner(c).db.rpc("page_layouts_set", { p_shop_id: shop.id, p_layouts: { home: f["home"] || null, articles, ...product, ...collection, ...legal, ...withBlogs } });
  } catch (e) {
    if (e instanceof DbError) return layoutsPage(c, shop, "error", 400);
    throw e;
  }
  return c.redirect(`${base(shop.id)}/layouts?flash=saved`);
});

/** 作る・保存する。action=preview なら保存せずにプレビューを出す */
async function save(c: AdminContext, pageId: string | null) {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const f = await formFields(c);
  const { values, error, autoHandle } = pageValues(f, { mediaBase: mediaBaseUrl(c) });
  const page = pageId ? { pageId } : {};
  if (f.action === "preview") return previewPage(c, shop, values, error, pageId);
  // 公開のボタンで誤りがあったら、画面の状態は押す前のまま（下書きなら下書き）に見せる
  const shown = (v: PageValues) => ({ ...v, published: f.published === "on" });
  if (error) return editPage(c, shop, { ...page, values: shown(values), error, status: 400 });
  const db = owner(c).db;
  const write = async (v: PageValues) => {
    if (pageId) {
      const rows = await db.from<PageRow>("pages").update(v, { id: pageId, shop_id: shop.id });
      return rows.length === 0 ? null : pageId;
    }
    const [row] = await db.from<PageRow>("pages").insert({ ...v, shop_id: shop.id });
    return row!.id;
  };
  try {
    let id: string | null;
    try {
      id = await write(values);
    } catch (e) {
      // 自動で作った名前が重なったら、1 回だけ作り直す
      if (!(autoHandle && e instanceof DbError && e.code === "23505")) throw e;
      values.handle = randomPageHandle();
      id = await write(values);
    }
    if (!id) return c.notFound();
    return c.redirect(`${base(shop.id)}/${id}?flash=saved`);
  } catch (e) {
    if (e instanceof DbError) return editPage(c, shop, { ...page, values: shown(values), error: dbError(e), status: e.code === "23505" ? 409 : 400 });
    throw e;
  }
}

pagesAdmin.post("/", requireOwner, (c: AdminContext) => save(c, null));

// 画像を置く・メディアライブラリ・本文の変換（ページと記事で共通。src/content/editor.tsx）
mountEditorEndpoints(pagesAdmin, scope, (_c, shop) => base(shop.id));

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
  // ゴミ箱の中のページは直さない（戻してから）
  if (row.deleted_at) return c.redirect(`${base(shop.id)}?status=trash`);
  const error = c.req.query("flash") === "image_error" ? ("image.invalid_type" as const) : null;
  return editPage(c, shop, { pageId, values: row, error });
});

pagesAdmin.post("/:pageId", requireOwner, (c: AdminContext) => save(c, param(c, "pageId")));

/** ゴミ箱へ（0080）。お客様からは見えなくなり、30 日後に Cron が消す */
pagesAdmin.post("/:pageId/trash", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  await owner(c).db.from("pages").update({ deleted_at: new Date().toISOString() }, { id: param(c, "pageId"), shop_id: shop.id });
  return c.redirect(`${base(shop.id)}?flash=trashed`);
});

/** ゴミ箱から戻す（同じ URL の名前のページが今あれば戻せない） */
pagesAdmin.post("/:pageId/restore", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  try {
    await owner(c).db.from("pages").update({ deleted_at: null }, { id: param(c, "pageId"), shop_id: shop.id });
  } catch (e) {
    if (e instanceof DbError && e.code === "23505") return c.redirect(`${base(shop.id)}?status=trash&flash=restore_conflict`);
    throw e;
  }
  return c.redirect(`${base(shop.id)}?flash=restored`);
});

/** リビジョンの版に戻す（今の版はリビジョンに残る。トリガー） */
pagesAdmin.post("/:pageId/revisions/:revisionId/restore", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const pageId = param(c, "pageId");
  const db = owner(c).db;
  let rev: { title: string; body: string } | null = null;
  try {
    rev = await db.from<{ title: string; body: string }>("page_revisions").selectOne("title,body", { eq: { id: param(c, "revisionId"), page_id: pageId, shop_id: shop.id } });
  } catch (e) {
    if (e instanceof DbError && e.code === "22P02") return c.notFound();
    throw e;
  }
  if (!rev) return c.notFound();
  await db.from("pages").update({ title: rev.title, body: rev.body }, { id: pageId, shop_id: shop.id });
  return c.redirect(`${base(shop.id)}/${pageId}?flash=reverted`);
});

