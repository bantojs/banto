import { Hono } from "hono";
import { previewResponse, wantsPreviewJson } from "../../content/preview";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { CategoryRow, ShopRow } from "../../db/types";
import { t, tf, type MessageKey } from "../../i18n";
import { AdminLayout, PageHead } from "../../routes/admin/layout";
import { formFields, owner, param, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { loadShop } from "../../routes/admin/shops";
import { mediaBaseUrl, publicBaseUrl } from "../../routes/common";
import { planLimitOf } from "../../plan/limits";
import { shopHome } from "../../storefront/urls";
import { moduleEnabled } from "../registry";
import { PAGE_LIMITS, PAGE_NAVS, PAGES_TRASH_DAYS, handleFromTitle, type PageNav } from "../../pages";
import { formatDateTime, zonedInputToIso } from "../../i18n/time";
import { ContentForm, type EditorKind, contentState, editorCatalog, editorHtml, featuredImageUrl, mountEditorEndpoints, type ContentValues, type RevisionRow, contentAudienceValues } from "../../content/editor";
import { ARTICLE_ORDERS, BLOG_MODULE, BLOG_ORDER_MIGRATION, articleHandleOk, blogHandleOk, blogOrderReady as blogRowOrdered, isArticleOrder, isBlogOrder, parseTags, type ArticleRow, type BlogRow } from "../../blog";
import { migrated } from "../../db/migration-state";
import { ARTICLE_FIELD_DATES_MIGRATION, ARTICLE_FIELD_IMAGE_MIGRATION, articleFieldDefs, articleFieldsReady, fieldsFromForm, formatArticleFieldRows, parseArticleFieldRows, type ArticleFieldDef } from "../../blog/fields";
import { fieldImageUpload } from "../../routes/admin/field-image";

/**
 * 同梱モジュール「ブログ」の管理画面（0081_mod_blog、docs/blog.md）。扱えるのはページと同じ content の項目を持つ人（RLS が正）。
 * 記事の編集の画面はページと同じもの（src/content/editor.tsx）。
 *   GET  …/modules/blog                       ブログの一覧と新しいブログ
 *   POST …/modules/blog                       ブログを作る
 *   GET  …/modules/blog/:blogId               記事の一覧（状態のタブ・検索）
 *   GET/POST …/modules/blog/:blogId/settings  ブログの設定・POST …/:blogId/delete で消す（記事も消える）
 *   POST …/modules/blog/:blogId/positions     手で並べる順を保存（0116、article_positions_set）
 *   GET  …/modules/blog/:blogId/articles/new  新しい記事
 *   POST …/modules/blog/:blogId/articles      記事を作る（action はページと同じ: draft / publish / update / preview）
 *   GET/POST …/modules/blog/:blogId/articles/:articleId  記事を直す・保存
 *   POST …/articles/:articleId/trash・restore・delete・revisions/:revisionId/restore
 */
export const blogAdmin = new Hono<AppEnv>();

async function scope(c: AdminContext): Promise<ShopRow | null> {
  const shop = await loadShop(c, param(c, "shopId"), "content");
  return shop && moduleEnabled(shop.settings, BLOG_MODULE) ? shop : null;
}

const base = (shopId: string) => `/admin/shops/${shopId}/modules/blog`;

function layout(c: AdminContext, shop: ShopRow, title: string, crumbs: { label: string; href?: string }[], body: Child, status: 200 | 400 | 409 = 200) {
  return c.html(
    <AdminLayout title={`${shop.name} · ${title}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, ...crumbs]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "blog" }}>
      {body}
    </AdminLayout>,
    status,
  );
}

/** ブログを引く（自分のショップのもの。id の形が違えば null） */
async function loadBlog(c: AdminContext, shop: ShopRow): Promise<BlogRow | null> {
  try {
    return await owner(c).db.from<BlogRow>("blogs").selectOne("*", { eq: { id: param(c, "blogId"), shop_id: shop.id } });
  } catch (e) {
    if (e instanceof DbError && e.code === "22P02") return null;
    throw e;
  }
}

const opt = (v: string | undefined, max: number) => {
  const s = (v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

// ---------- ブログ ----------

type BlogValues = Pick<BlogRow, "title" | "handle" | "description" | "seo_title" | "seo_description" | "template_suffix" | "nav" | "sort_order" | "article_order" | "feed" | "article_from_today">;

/** 0116（並び順・フィード）が当たっているか。ブログの行があれば列があるかで分かる（問い合わせない） */
async function blogOrderReady(c: AdminContext, blog?: BlogRow | null): Promise<boolean> {
  if (blog) return blogRowOrdered(blog);
  return migrated({ db: owner(c).db, cache: c.get("adapters").cache }, BLOG_ORDER_MIGRATION).catch(() => false);
}

/** ordered = 0116 が当たっている（並び順とフィードの欄を読む。当たる前は送らない） */
function blogValues(f: Record<string, string>, ordered = false): { values: BlogValues; error: MessageKey | null } {
  const title = (f.title ?? "").trim();
  const typed = (f.handle ?? "").trim().toLowerCase();
  const sort = Number.parseInt(f.sort_order ?? "0", 10);
  const values: BlogValues = {
    title,
    handle: typed || handleFromTitle(title) || "news",
    description: opt(f.description, 1000),
    seo_title: opt(f.seo_title, 200),
    seo_description: opt(f.seo_description, 500),
    template_suffix: opt(f.template_suffix, 40)?.toLowerCase() ?? null,
    nav: (PAGE_NAVS as readonly string[]).includes(f.nav ?? "") ? (f.nav as PageNav) : "none",
    sort_order: Number.isInteger(sort) ? Math.max(-1000, Math.min(1000, sort)) : 0,
    // 欄を出したフォーム（order_fields）からだけ読む（無いフォームで「フィード無し」にしない）
    ...(ordered && f.order_fields === "1" ? { article_order: isBlogOrder(f.article_order) ? f.article_order : "new", feed: f.feed === "1" } : {}),
    // 0124: 日付の項目の順のとき今日以降だけ（欄を出したフォームからだけ読む）
    ...(ordered && f.from_today_present === "1" ? { article_from_today: f.article_from_today === "1" } : {}),
  };
  if (!title || title.length > 200) return { values, error: "pages.error_title" };
  if (!blogHandleOk(values.handle)) return { values, error: "blog.error_handle" };
  if (values.template_suffix && !/^[a-z0-9_-]{1,40}$/.test(values.template_suffix)) return { values, error: "pages.error_template" };
  return { values, error: null };
}

function blogDbError(e: DbError): MessageKey {
  if (e.code === "23505") return "blog.error_handle_taken";
  if (/blogs_full/.test(e.message)) return "blog.error_blogs_full";
  if (e.code === "23514") return "pages.error_invalid";
  return "error.generic";
}

function BlogFields(props: { v: BlogValues; ordered?: boolean; dateFields?: { key: string; label: string }[] }) {
  const v = props.v;
  return (
    <>
      <label for="title">{t("blog.blog_title")}</label>
      <input id="title" name="title" value={v.title} required maxlength={200} placeholder={t("blog.blog_title_placeholder")} />
      <label for="handle">{t("pages.handle")}</label>
      <input id="handle" name="handle" value={v.handle} maxlength={64} pattern="[a-z0-9]([a-z0-9\-]{0,62}[a-z0-9])?" />
      <p class="muted">{t("blog.handle_help")}</p>
      <label for="description">{t("blog.description")}</label>
      <textarea id="description" name="description" rows={3} maxlength={1000} style="width:100%">
        {v.description ?? ""}
      </textarea>
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
      {props.ordered ? (
        <>
          <input type="hidden" name="order_fields" value="1" />
          <label for="article_order">{t("blog.order")}</label>
          <select id="article_order" name="article_order">
            {ARTICLE_ORDERS.map((o) => (
              <option value={o} selected={(v.article_order ?? "new") === o}>
                {t(`blog.order_${o}` as MessageKey)}
              </option>
            ))}
            {(props.dateFields ?? []).map((f) => (
              <option value={`field:${f.key}`} selected={v.article_order === `field:${f.key}`}>
                {tf("blog.order_field", { label: f.label })}
              </option>
            ))}
          </select>
          <p class="muted">{t("blog.order_help")}</p>
          {typeof v.article_from_today === "boolean" ? (
            <>
              <input type="hidden" name="from_today_present" value="1" />
              <label>
                <input type="checkbox" name="article_from_today" value="1" checked={v.article_from_today} /> {t("blog.order_from_today")}
              </label>
              <p class="muted">{t("blog.order_from_today_help")}</p>
            </>
          ) : null}
          <label>
            <input type="checkbox" name="feed" value="1" checked={v.feed !== false} /> {t("blog.feed_on")}
          </label>
          <p class="muted">{t("blog.feed_help")}</p>
        </>
      ) : null}
      <details>
        <summary>{t("pages.more")}</summary>
        <label for="seo_title">{t("pages.seo_title")}</label>
        <input id="seo_title" name="seo_title" value={v.seo_title ?? ""} maxlength={200} />
        <label for="seo_description">{t("pages.seo_description")}</label>
        <textarea id="seo_description" name="seo_description" rows={2} maxlength={500} style="width:100%">
          {v.seo_description ?? ""}
        </textarea>
        <label for="template_suffix">{t("pages.template")}</label>
        <input id="template_suffix" name="template_suffix" value={v.template_suffix ?? ""} maxlength={40} pattern="[a-z0-9_\-]{1,40}" />
        <p class="muted">{t("blog.template_help")}</p>
      </details>
    </>
  );
}

async function blogList(c: AdminContext, shop: ShopRow, opts: { values?: BlogValues; error?: MessageKey | null; status?: 200 | 400 | 409 } = {}) {
  const db = owner(c).db;
  const [blogs, counts] = await Promise.all([
    db.from<BlogRow>("blogs").select("*", { eq: { shop_id: shop.id }, order: "sort_order.asc,created_at.asc" }),
    db.from<{ blog_id: string; deleted_at: string | null }>("articles").select("blog_id,deleted_at", { eq: { shop_id: shop.id }, limit: 5000 }),
  ]);
  const home = shopHome(publicBaseUrl(c), shop);
  const flash = c.req.query("flash");
  const v = opts.values ?? { title: "", handle: "", description: null, seo_title: null, seo_description: null, template_suffix: null, nav: "none", sort_order: 0 };
  const ordered = await blogOrderReady(c);
  return layout(
    c,
    shop,
    t("mod.blog.name"),
    [{ label: t("mod.blog.name") }],
    <>
      <PageHead title={t("mod.blog.name")} sub={t("blog.intro")} />
      {flash === "deleted" ? <p class="notice">{t("blog.blog_deleted")}</p> : null}
      {opts.error ? <p class="error">{t(opts.error)}</p> : null}
      {blogs.length === 0 ? (
        <p class="muted">{t("blog.empty")}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("blog.blog_title")}</th>
              <th>URL</th>
              <th>{t("blog.articles")}</th>
              <th>{t("pages.nav")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {blogs.map((b) => (
              <tr>
                <td>
                  <a href={`${base(shop.id)}/${b.id}`}>{b.title}</a>
                </td>
                <td>
                  {shop.published ? (
                    <a href={`${home}/blogs/${b.handle}`} target="_blank" rel="noopener">
                      /blogs/{b.handle}
                    </a>
                  ) : (
                    <span class="muted">/blogs/{b.handle}</span>
                  )}
                </td>
                <td>{counts.filter((a) => a.blog_id === b.id && !a.deleted_at).length}</td>
                <td>{t(`pages.nav_${b.nav}` as MessageKey)}</td>
                <td style="white-space:nowrap">
                  <a class="btn secondary small" href={`${base(shop.id)}/${b.id}/articles/new`}>
                    {t("blog.new_article")}
                  </a>{" "}
                  <a class="btn secondary small" href={`${base(shop.id)}/${b.id}/settings`}>
                    {t("blog.settings")}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <section class="card">
        <h2>{t("blog.new_blog")}</h2>
        <p class="muted">{t("blog.new_blog_help")}</p>
        <form method="post" action={base(shop.id)}>
          <BlogFields v={v} ordered={ordered} />
          <p>
            <button type="submit">{t("blog.create_blog")}</button>
          </p>
        </form>
      </section>
    </>,
    opts.status ?? 200,
  );
}

blogAdmin.get("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  return blogList(c, shop);
});

blogAdmin.post("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const { values, error } = blogValues(await formFields(c), await blogOrderReady(c));
  if (error) return blogList(c, shop, { values, error, status: 400 });
  try {
    const [row] = await owner(c).db.from<BlogRow>("blogs").insert({ ...values, shop_id: shop.id });
    return c.redirect(`${base(shop.id)}/${row!.id}?flash=created`);
  } catch (e) {
    if (e instanceof DbError) return blogList(c, shop, { values, error: blogDbError(e), status: e.code === "23505" ? 409 : 400 });
    throw e;
  }
});

// 画像を置く・メディアライブラリ・本文の変換（ページと同じ口。src/content/editor.tsx）。/:blogId より先に付ける
mountEditorEndpoints(blogAdmin, scope, (_c, shop) => base(shop.id));

// ---------- 記事の一覧 ----------

blogAdmin.get("/:blogId", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const blog = await loadBlog(c, shop);
  if (!blog) return c.notFound();
  // 手で並べるブログ（0116）: 一覧をその順にして、順の欄を出す
  const manual = blog.article_order === "manual";
  const all = await owner(c).db.from<ArticleRow>("articles").select(`id,handle,title,tags,published,published_at,deleted_at,updated_at${manual ? ",position" : ""}`, { eq: { blog_id: blog.id, shop_id: shop.id }, order: "created_at.desc", limit: 5000 });
  const home = shopHome(publicBaseUrl(c), shop);
  const flash = c.req.query("flash");
  const tabs = ["all", "published", "scheduled", "draft", "trash"] as const;
  const tabParam = c.req.query("status") ?? "all";
  const tab = (tabs as readonly string[]).includes(tabParam) ? tabParam : "all";
  const q = (c.req.query("q") ?? "").trim().slice(0, 100).toLowerCase();
  const states = all.map((a) => ({ a, state: contentState(a) }));
  const count = (k: string) => states.filter((x) => (k === "all" ? x.state !== "trash" : x.state === k)).length;
  // 新しく公開したものから（下書きは作った順）
  const rows = states
    .filter((x) => (tab === "all" ? x.state !== "trash" : x.state === tab) && (!q || x.a.title.toLowerCase().includes(q) || x.a.handle.includes(q) || x.a.tags.some((tg) => tg.toLowerCase().includes(q))))
    .sort((x, y) => (manual && tab !== "trash" ? (x.a.position ?? 0) - (y.a.position ?? 0) : 0) || (y.a.published_at ?? "").localeCompare(x.a.published_at ?? ""));
  const shown = rows.slice(0, 200);
  const ordering = manual && tab !== "trash" && shown.length > 0;
  const link = (k: string) => `${base(shop.id)}/${blog.id}${k === "all" ? "" : `?status=${k}`}`;
  const at = `${base(shop.id)}/${blog.id}/articles`;
  return layout(
    c,
    shop,
    blog.title,
    [{ label: t("mod.blog.name"), href: base(shop.id) }, { label: blog.title }],
    <>
      <PageHead title={blog.title} sub={`/blogs/${blog.handle}`} />
      {flash === "created" ? <p class="notice">{t("blog.blog_created")}</p> : null}
      {flash === "deleted" ? <p class="notice">{t("pages.deleted")}</p> : null}
      {flash === "trashed" ? <p class="notice">{tf("pages.trashed", { n: PAGES_TRASH_DAYS })}</p> : null}
      {flash === "restored" ? <p class="notice">{t("pages.restored")}</p> : null}
      {flash === "restore_conflict" ? <p class="error">{t("pages.restore_conflict")}</p> : null}
      {flash === "order_saved" ? <p class="notice">{t("blog.order_saved")}</p> : null}
      {flash === "order_unchanged" ? <p class="notice">{t("blog.order_unchanged")}</p> : null}
      {flash === "order_invalid" ? <p class="error">{t("blog.order_invalid")}</p> : null}
      <p>
        <a class="btn" href={`${at}/new`}>
          {t("blog.new_article")}
        </a>{" "}
        <a class="btn secondary" href={`${base(shop.id)}/${blog.id}/settings`}>
          {t("blog.settings")}
        </a>
      </p>
      <form method="get" action={`${base(shop.id)}/${blog.id}`} class="toolbar" role="search">
        <nav aria-label={t("pages.state")} style="display:flex;gap:.75rem;flex-wrap:wrap">
          {tabs.map((k) => (
            <a href={link(k)} aria-current={tab === k ? "page" : undefined} style={tab === k ? "font-weight:600;color:var(--fg)" : "color:var(--fg-muted)"}>
              {t(`pages.tab_${k}` as MessageKey)} ({count(k)})
            </a>
          ))}
        </nav>
        {tab !== "all" ? <input type="hidden" name="status" value={tab} /> : null}
        <input type="search" name="q" value={q} placeholder={t("blog.search")} aria-label={t("blog.search")} />
        <button type="submit" class="secondary small">
          {t("pages.search_go")}
        </button>
      </form>
      {tab === "trash" ? <p class="muted">{tf("pages.trash_help", { n: PAGES_TRASH_DAYS })}</p> : null}
      {shown.length === 0 ? (
        <p class="muted">{all.length === 0 ? t("blog.no_articles") : t("pages.none_here")}</p>
      ) : (
        <>
        {ordering ? (
          <form id="article-order" method="post" action={`${base(shop.id)}/${blog.id}/positions`}>
            <p class="muted">{t("blog.order_manual_help")}</p>
          </form>
        ) : null}
        <table>
          <thead>
            <tr>
              {ordering ? <th style="width:5.5rem">{t("blog.order_position")}</th> : null}
              <th>{t("pages.title")}</th>
              <th>{t("blog.tags")}</th>
              <th>{t("pages.state")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ a, state }) => (
              <tr>
                {ordering ? (
                  <td>
                    <input form="article-order" type="hidden" name={`prev_${a.id}`} value={String(a.position ?? 0)} />
                    <input form="article-order" type="number" name={`pos_${a.id}`} min={1} max={1000000} value={String(a.position ?? 0)} aria-label={tf("blog.order_position_for", { title: a.title })} style="width:5rem" />
                  </td>
                ) : null}
                <td>
                  {state === "trash" ? a.title : <a href={`${at}/${a.id}`}>{a.title}</a>}
                  <div class="muted" style="font-size:.8rem">
                    {state === "published" && shop.published ? (
                      <a href={`${home}/blogs/${blog.handle}/${a.handle}`} target="_blank" rel="noopener">
                        /blogs/{blog.handle}/{a.handle}
                      </a>
                    ) : (
                      `/blogs/${blog.handle}/${a.handle}`
                    )}
                  </div>
                </td>
                <td class="muted">{a.tags.join("、")}</td>
                <td>
                  {t(`pages.state_${state}` as MessageKey)}
                  {a.published_at && (state === "scheduled" || state === "published") ? <span class="muted"> {formatDateTime(a.published_at)}</span> : null}
                </td>
                <td style="white-space:nowrap">
                  {state === "trash" ? (
                    <>
                      <form method="post" action={`${at}/${a.id}/restore`} style="display:inline">
                        <button type="submit" class="secondary small">
                          {t("pages.restore")}
                        </button>
                      </form>
                    </>
                  ) : (
                    <form method="post" action={`${at}/${a.id}/trash`} style="display:inline">
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
        {ordering ? (
          <p>
            <button type="submit" form="article-order" class="secondary">
              {t("blog.order_save")}
            </button>
          </p>
        ) : null}
        </>
      )}
    </>,
  );
});

/** 手で並べる順を保存する（0116）。送られた欄のうち、数が変わったものだけ（article_positions_set、項目 content） */
blogAdmin.post("/:blogId/positions", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  const blog = shop ? await loadBlog(c, shop) : null;
  if (!shop || !blog) return c.notFound();
  const back = `${base(shop.id)}/${blog.id}`;
  if (blog.article_order !== "manual") return c.redirect(back);
  const f = await formFields(c);
  const changed: Record<string, number> = {};
  for (const [k, v] of Object.entries(f)) {
    const m = /^pos_([0-9a-f-]{36})$/.exec(k);
    if (!m) continue;
    const n = Number(v.trim());
    if (!Number.isInteger(n) || n < 1 || n > 1000000) return c.redirect(`${back}?flash=order_invalid`);
    if (String(n) !== (f[`prev_${m[1]}`] ?? "").trim()) changed[m[1]!] = n;
  }
  if (Object.keys(changed).length === 0) return c.redirect(`${back}?flash=order_unchanged`);
  try {
    await owner(c).db.rpc("article_positions_set", { p_blog_id: blog.id, p_positions: changed });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${back}?flash=order_invalid`);
    throw e;
  }
  return c.redirect(`${back}?flash=order_saved`);
});

// ---------- ブログの設定 ----------

async function blogSettings(c: AdminContext, shop: ShopRow, blog: BlogRow, opts: { values?: BlogValues; error?: MessageKey | null; status?: 200 | 400 | 409; fieldsText?: string; fieldsError?: string | null } = {}) {
  // 記事の項目（0117）: 定義の欄。記事を指す項目のために、このショップのブログの URL の名前を引く
  const fieldsOn = articleFieldsReady(blog);
  const blogs = fieldsOn ? await owner(c).db.from<{ id: string; handle: string }>("blogs").select("id,handle", { eq: { shop_id: shop.id }, order: "sort_order.asc", limit: 100 }) : [];
  return layout(
    c,
    shop,
    t("blog.settings"),
    [{ label: t("mod.blog.name"), href: base(shop.id) }, { label: blog.title, href: `${base(shop.id)}/${blog.id}` }, { label: t("blog.settings") }],
    <>
      <PageHead title={t("blog.settings")} />
      {c.req.query("flash") === "saved" ? <p class="notice">{t("shop.saved")}</p> : null}
      {opts.error ? <p class="error">{t(opts.error)}</p> : null}
      <form method="post" action={`${base(shop.id)}/${blog.id}/settings`} class="card">
        <BlogFields v={{ ...(opts.values ?? blog), ...(typeof blog.article_from_today === "boolean" && typeof (opts.values ?? blog).article_from_today !== "boolean" ? { article_from_today: blog.article_from_today } : {}) }} ordered={blogRowOrdered(blog)} dateFields={articleFieldDefs(blog).filter((f) => f.type === "date" || f.type === "datetime")} />
        <p>
          <button type="submit">{t("pages.save")}</button>
        </p>
      </form>
      {fieldsOn ? (
        <form method="post" action={`${base(shop.id)}/${blog.id}/fields`} class="card" id="article-fields">
          <h2>{t("blog.fields")}</h2>
          {c.req.query("flash") === "fields_saved" ? <p class="notice">{t("shop.saved")}</p> : null}
          {opts.fieldsError ? <p class="error">{tf("blog.fields_error", { line: opts.fieldsError })}</p> : null}
          <p class="muted">{t("blog.fields_rows_help")}</p>
          <textarea name="rows" rows={8} style="width:100%;font-family:ui-monospace,monospace" aria-label={t("blog.fields")}>
            {opts.fieldsText ?? formatArticleFieldRows(articleFieldDefs(blog), blogs)}
          </textarea>
          <p>
            <button type="submit" class="secondary">
              {t("pages.save")}
            </button>
          </p>
        </form>
      ) : null}
      <section class="card danger-zone">
        <h2>{t("blog.delete_blog")}</h2>
        <p class="muted">{t("blog.delete_blog_help")}</p>
        <form method="post" action={`${base(shop.id)}/${blog.id}/delete`} onsubmit={`return confirm(${JSON.stringify(t("blog.delete_blog_confirm"))})`}>
          <button type="submit">{t("blog.delete_blog")}</button>
        </form>
      </section>
    </>,
    opts.status ?? 200,
  );
}

blogAdmin.get("/:blogId/settings", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  const blog = shop ? await loadBlog(c, shop) : null;
  if (!shop || !blog) return c.notFound();
  return blogSettings(c, shop, blog);
});

blogAdmin.post("/:blogId/settings", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  const blog = shop ? await loadBlog(c, shop) : null;
  if (!shop || !blog) return c.notFound();
  const { values, error } = blogValues(await formFields(c), blogRowOrdered(blog));
  if (error) return blogSettings(c, shop, blog, { values, error, status: 400 });
  try {
    await owner(c).db.from("blogs").update(values, { id: blog.id, shop_id: shop.id });
  } catch (e) {
    if (e instanceof DbError) return blogSettings(c, shop, blog, { values, error: blogDbError(e), status: e.code === "23505" ? 409 : 400 });
    throw e;
  }
  return c.redirect(`${base(shop.id)}/${blog.id}/settings?flash=saved`);
});

/** 記事の項目の画像を置く（0120、項目 content）。返った URL を欄に入れて、記事の保存で書く */
blogAdmin.post("/field-image", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.json({ error: t("shop.not_found") }, 404);
  return fieldImageUpload(c, shop.id);
});

/** 記事の項目の定義を保存する（0117）。形と指すブログは DB のトリガーも確かめる */
blogAdmin.post("/:blogId/fields", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  const blog = shop ? await loadBlog(c, shop) : null;
  if (!shop || !blog) return c.notFound();
  if (!articleFieldsReady(blog)) return c.redirect(`${base(shop.id)}/${blog.id}/settings`);
  const text = (await formFields(c))["rows"] ?? "";
  const blogs = await owner(c).db.from<{ id: string; handle: string }>("blogs").select("id,handle", { eq: { shop_id: shop.id }, limit: 100 });
  const deps = { db: owner(c).db, cache: c.get("adapters").cache };
  const [image, dates] = await Promise.all([migrated(deps, ARTICLE_FIELD_IMAGE_MIGRATION).catch(() => false), migrated(deps, ARTICLE_FIELD_DATES_MIGRATION).catch(() => false)]);
  const { defs, error } = parseArticleFieldRows(text, blogs, { image, dates });
  if (error !== null) return blogSettings(c, shop, blog, { fieldsText: text, fieldsError: error.slice(0, 100), status: 400 });
  try {
    await owner(c).db.from("blogs").update({ article_fields: defs }, { id: blog.id, shop_id: shop.id });
  } catch (e) {
    if (e instanceof DbError) return blogSettings(c, shop, blog, { fieldsText: text, fieldsError: e.message.replace(/^.*article_fields_invalid:?/, "") || "—", status: 400 });
    throw e;
  }
  return c.redirect(`${base(shop.id)}/${blog.id}/settings?flash=fields_saved#article-fields`);
});

/** ブログは blog_delete で消す。記事の物理削除（ゴミ箱の中の「完全に削除」）は Cron の purge に任せる（0089） */

blogAdmin.post("/:blogId/delete", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  const blog = shop ? await loadBlog(c, shop) : null;
  if (!shop || !blog) return c.notFound();
  try {
    await owner(c).db.rpc("blog_delete", { p_shop_id: shop.id, p_blog_id: blog.id });
  } catch (e) {
    if (e instanceof DbError) return c.notFound();
    throw e;
  }
  return c.redirect(`${base(shop.id)}?flash=deleted`);
});

// ---------- 記事 ----------

type ArticleValues = ContentValues & Pick<ArticleRow, "tags" | "excerpt" | "author" | "fields">;

const EMPTY: ArticleValues = { title: "", handle: "", body: "", seo_title: null, seo_description: null, template_suffix: null, published: false, published_at: null, image_url: null, tags: [], excerpt: null, author: null };

/** 名前を空で保存したとき・タイトルから作れないときの名前（post-xxxxxx） */
function randomArticleHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `post-${Array.from(bytes, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("")}`;
}

/** フォームの値 → 行（ページの pageValues と同じ規則に、タグ・抜粋・書いた人） */
function articleValues(f: Record<string, string>, mediaBase: string, defs: ArticleFieldDef[] | null = null): { values: ArticleValues; error: MessageKey | null; autoHandle: boolean } {
  const title = (f.title ?? "").trim();
  const typed = (f.handle ?? "").trim().toLowerCase();
  const autoHandle = typed === "";
  const fromTitle = handleFromTitle(title);
  const values: ArticleValues = {
    title,
    handle: autoHandle ? (fromTitle && articleHandleOk(fromTitle) ? fromTitle : randomArticleHandle()) : typed,
    body: (f.body ?? "").replace(/\r\n?/g, "\n"),
    seo_title: opt(f.seo_title, PAGE_LIMITS.seoTitle),
    seo_description: opt(f.seo_description, PAGE_LIMITS.seoDescription),
    template_suffix: opt(f.template_suffix, 40)?.toLowerCase() ?? null,
    published: f.action === "publish" ? true : f.action === "draft" ? false : f.published === "on",
    published_at: f.published_at ? zonedInputToIso(f.published_at) : null,
    image_url: (f.image_url ?? "").trim() || null,
    tags: parseTags(f.tags ?? ""),
    excerpt: opt(f.excerpt, 1000),
    author: opt(f.author, 100),
    // 記事の項目（0117。当たっている DB だけ。形と指す先は DB が確かめる）
    ...(defs ? { fields: fieldsFromForm(defs, f, mediaBase) } : {}),
    ...contentAudienceValues(f),
  };
  if (f.published_at && !values.published_at) return { values, error: "pages.error_published_at", autoHandle };
  if (values.image_url) {
    const img = featuredImageUrl(values.image_url, mediaBase);
    if (!img) return { values, error: "pages.error_image", autoHandle };
    values.image_url = img;
  }
  if (!values.title || values.title.length > PAGE_LIMITS.title) return { values, error: "pages.error_title", autoHandle };
  if (!articleHandleOk(values.handle)) return { values, error: "blog.error_article_handle", autoHandle };
  if (values.body.length > PAGE_LIMITS.body) return { values, error: "pages.error_body", autoHandle };
  if (values.template_suffix && !/^[a-z0-9_-]{1,40}$/.test(values.template_suffix)) return { values, error: "pages.error_template", autoHandle };
  return { values, error: null, autoHandle };
}

function articleDbError(e: DbError): MessageKey {
  if (/article_field_invalid/.test(e.message)) return "blog.error_field";
  if (/audience_display_only/.test(e.message)) return "product.audience_display_only";
  if (planLimitOf(e)) return "plan.limit_articles";
  if (e.code === "23505") return "pages.error_handle_taken";
  if (/articles_full/.test(e.message)) return "blog.error_articles_full";
  if (e.code === "23514") return "pages.error_invalid";
  return "error.generic";
}

async function editArticle(c: AdminContext, shop: ShopRow, blog: BlogRow, opts: { articleId?: string; values: ArticleValues; error?: MessageKey | null; status?: 200 | 400 | 409 }) {
  const db = owner(c).db;
  const at = `${base(shop.id)}/${blog.id}/articles`;
  const [catalog, revisions] = await Promise.all([
    editorCatalog(c, shop),
    opts.articleId ? db.from<RevisionRow>("article_revisions").select("id,title,created_at", { eq: { article_id: opts.articleId, shop_id: shop.id }, order: "created_at.desc", limit: 20 }) : Promise.resolve([] as RevisionRow[]),
  ]);
  const title = opts.articleId ? opts.values.title || t("blog.edit_article") : t("blog.new_article");
  const action = opts.articleId ? `${at}/${opts.articleId}` : at;
  const flash = c.req.query("flash");
  const image = c.req.query("image");
  const live = contentState(opts.values) === "published";
  const viewUrl = opts.articleId && live && shop.published ? `${shopHome(publicBaseUrl(c), shop)}/blogs/${blog.handle}/${opts.values.handle}` : null;
  const v = opts.values;
  // 記事の項目（0117）: 定義・今の値・選べる店舗・指すブログの記事（選ぶ欄のため）
  let fields: NonNullable<NonNullable<EditorKind["article"]>["fields"]> | undefined;
  if (articleFieldsReady(blog)) {
    const defs = articleFieldDefs(blog);
    const stores = defs.some((d) => d.type === "store") ? ((await db.rpc<{ id: string; name: string }[]>("shop_store_list", { p_shop_id: shop.id }).catch(() => [])) ?? []).map((s) => ({ id: s.id, name: s.name })) : [];
    const articles: Record<string, { handle: string; title: string }[]> = {};
    for (const d of defs.filter((x) => x.type === "article" && x.blog)) {
      articles[d.key] = await db.from<{ handle: string; title: string }>("articles").select("handle,title", { eq: { blog_id: d.blog!, shop_id: shop.id }, order: "title.asc", limit: 500 }).catch(() => []);
    }
    fields = { defs, values: v.fields ?? {}, stores, articles, upload: `${base(shop.id)}/field-image` };
  }
  return layout(
    c,
    shop,
    title,
    [{ label: t("mod.blog.name"), href: base(shop.id) }, { label: blog.title, href: `${base(shop.id)}/${blog.id}` }, { label: title }],
    <>
      <PageHead title={title} />
      {flash === "saved" ? <p class="notice">{t("shop.saved")}</p> : null}
      {flash === "reverted" ? <p class="notice">{t("pages.reverted")}</p> : null}
      <ContentForm
        kind={{ base: base(shop.id), back: `${base(shop.id)}/${blog.id}`, urlPrefix: `/blogs/${blog.handle}/`, nav: false, article: { tags: v.tags.join(", "), excerpt: v.excerpt ?? "", author: v.author ?? "", ...(fields ? { fields } : {}) } }}
        selfUrl={opts.articleId ? `${at}/${opts.articleId}` : `${at}/new`}
        revisions={revisions}
        shop={shop}
        action={action}
        values={v}
        visual={editorHtml(c, v.body)}
        categories={catalog.categories}
        tags={catalog.tags}
        extras={catalog}
        {...(opts.articleId ? { pageId: opts.articleId } : {})}
        viewUrl={viewUrl}
        error={opts.error ?? null}
        image={image && image.startsWith(mediaBaseUrl(c)) ? image : null}
      />
    </>,
    opts.status ?? 200,
  );
}

async function previewArticle(c: AdminContext, shop: ShopRow, blog: BlogRow, v: ArticleValues, error: MessageKey | null) {
  if (!error) {
    const now = new Date().toISOString();
    const article = { id: "preview", shop_id: shop.id, blog_id: blog.id, created_at: now, updated_at: now, ...v, published_at: v.published_at ?? now } as ArticleRow;
    const categories = await owner(c).db.from<CategoryRow>("categories").select("*", { eq: { shop_id: shop.id }, order: "sort_order.asc" }).catch(() => [] as CategoryRow[]);
    const res = await previewResponse(c, shop, { kind: "article", blog, article }, categories);
    if (res) return res;
  }
  if (wantsPreviewJson(c)) return c.json({ kind: "error", message: t(error ?? "pages.preview_note") });
  return layout(
    c,
    shop,
    t("pages.preview"),
    [{ label: t("mod.blog.name"), href: base(shop.id) }, { label: blog.title, href: `${base(shop.id)}/${blog.id}` }, { label: t("pages.preview") }],
    <>
      <p class="notice">{t("pages.preview_note")}</p>
      {error ? <p class="error">{t(error)}</p> : null}
      <article class="card page-preview">
        <h1>{v.title}</h1>
        {v.image_url ? <img src={v.image_url} alt="" style="width:100%;height:auto;border-radius:6px" /> : null}
        {raw(editorHtml(c, v.body))}
      </article>
    </>,
  );
}

blogAdmin.get("/:blogId/articles/new", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  const blog = shop ? await loadBlog(c, shop) : null;
  if (!shop || !blog) return c.notFound();
  return editArticle(c, shop, blog, { values: EMPTY });
});

async function saveArticle(c: AdminContext, articleId: string | null) {
  const shop = await scope(c);
  const blog = shop ? await loadBlog(c, shop) : null;
  if (!shop || !blog) return c.notFound();
  const f = await formFields(c);
  const { values, error, autoHandle } = articleValues(f, mediaBaseUrl(c), articleFieldsReady(blog) ? articleFieldDefs(blog) : null);
  const one = articleId ? { articleId } : {};
  if (f.action === "preview") return previewArticle(c, shop, blog, values, error);
  const shown = (v: ArticleValues) => ({ ...v, published: f.published === "on" });
  if (error) return editArticle(c, shop, blog, { ...one, values: shown(values), error, status: 400 });
  const db = owner(c).db;
  const at = `${base(shop.id)}/${blog.id}/articles`;
  const write = async (v: ArticleValues) => {
    if (articleId) {
      const rows = await db.from<ArticleRow>("articles").update(v, { id: articleId, blog_id: blog.id, shop_id: shop.id });
      return rows.length === 0 ? null : articleId;
    }
    const [row] = await db.from<ArticleRow>("articles").insert({ ...v, shop_id: shop.id, blog_id: blog.id });
    return row!.id;
  };
  try {
    let id: string | null;
    try {
      id = await write(values);
    } catch (e) {
      if (!(autoHandle && e instanceof DbError && e.code === "23505")) throw e;
      values.handle = randomArticleHandle();
      id = await write(values);
    }
    if (!id) return c.notFound();
    return c.redirect(`${at}/${id}?flash=saved`);
  } catch (e) {
    if (e instanceof DbError) return editArticle(c, shop, blog, { ...one, values: shown(values), error: articleDbError(e), status: e.code === "23505" ? 409 : 400 });
    throw e;
  }
}

blogAdmin.post("/:blogId/articles", requireOwner, (c: AdminContext) => saveArticle(c, null));

/** 記事を引く（このブログの、自分のショップのもの） */
async function loadArticle(c: AdminContext, shop: ShopRow, blog: BlogRow): Promise<ArticleRow | null> {
  try {
    return await owner(c).db.from<ArticleRow>("articles").selectOne("*", { eq: { id: param(c, "articleId"), blog_id: blog.id, shop_id: shop.id } });
  } catch (e) {
    if (e instanceof DbError && e.code === "22P02") return null;
    throw e;
  }
}

blogAdmin.get("/:blogId/articles/:articleId", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  const blog = shop ? await loadBlog(c, shop) : null;
  if (!shop || !blog) return c.notFound();
  const row = await loadArticle(c, shop, blog);
  if (!row) return c.notFound();
  if (row.deleted_at) return c.redirect(`${base(shop.id)}/${blog.id}?status=trash`);
  const error = c.req.query("flash") === "image_error" ? ("image.invalid_type" as const) : null;
  return editArticle(c, shop, blog, { articleId: row.id, values: row, error });
});

blogAdmin.post("/:blogId/articles/:articleId", requireOwner, (c: AdminContext) => saveArticle(c, param(c, "articleId")));

blogAdmin.post("/:blogId/articles/:articleId/trash", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  const blog = shop ? await loadBlog(c, shop) : null;
  if (!shop || !blog) return c.notFound();
  await owner(c).db.from("articles").update({ deleted_at: new Date().toISOString() }, { id: param(c, "articleId"), blog_id: blog.id, shop_id: shop.id });
  return c.redirect(`${base(shop.id)}/${blog.id}?flash=trashed`);
});

blogAdmin.post("/:blogId/articles/:articleId/restore", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  const blog = shop ? await loadBlog(c, shop) : null;
  if (!shop || !blog) return c.notFound();
  try {
    await owner(c).db.from("articles").update({ deleted_at: null }, { id: param(c, "articleId"), blog_id: blog.id, shop_id: shop.id });
  } catch (e) {
    if (e instanceof DbError && e.code === "23505") return c.redirect(`${base(shop.id)}/${blog.id}?status=trash&flash=restore_conflict`);
    throw e;
  }
  return c.redirect(`${base(shop.id)}/${blog.id}?flash=restored`);
});

blogAdmin.post("/:blogId/articles/:articleId/revisions/:revisionId/restore", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  const blog = shop ? await loadBlog(c, shop) : null;
  if (!shop || !blog) return c.notFound();
  const articleId = param(c, "articleId");
  const db = owner(c).db;
  let rev: { title: string; body: string } | null = null;
  try {
    rev = await db.from<{ title: string; body: string }>("article_revisions").selectOne("title,body", { eq: { id: param(c, "revisionId"), article_id: articleId, shop_id: shop.id } });
  } catch (e) {
    if (e instanceof DbError && e.code === "22P02") return c.notFound();
    throw e;
  }
  if (!rev) return c.notFound();
  await db.from("articles").update({ title: rev.title, body: rev.body }, { id: articleId, blog_id: blog.id, shop_id: shop.id });
  return c.redirect(`${base(shop.id)}/${blog.id}/articles/${articleId}?flash=reverted`);
});
