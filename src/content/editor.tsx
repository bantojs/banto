/**
 * ページと記事の編集の画面（同梱モジュール pages・blog が一緒に使う。docs/pages.md・docs/blog.md）。
 * WordPress のブロックの編集に寄せた 2 列の画面・見たままの編集・ブロック・メディアライブラリ・リビジョン。
 * 保存するのは決まった書式の本文と各欄だけ（生の HTML は入らない。src/pages/markdown.ts）
 */
import type { Hono } from "hono";
import { raw } from "hono/html";
import type { AppEnv } from "../app";
import type { CategoryRow, ShopRow } from "../db/types";
import { getLocale, t, tf, type MessageKey } from "../i18n";
import { formFields, owner, type AdminContext } from "../routes/admin/context";
import { requireOwner } from "../routes/admin/auth";
import { olderThan, readAfter, splitPage } from "../routes/admin/paging";
import { mediaBaseUrl } from "../routes/common";
import { moduleEnabled } from "../modules/registry";
import { AUDIENCES_MODULE, audienceDisplayOnly } from "../members/audience";
import { MAX_IMAGE_BYTES, MAX_THUMB_BYTES, imageUrl, randomKey, sniffImage, thumbKey } from "../media/images";
import { MAX_VIDEO_BYTES, sniffMp4 } from "../media/video";
import { PAGE_LIMITS, PAGE_NAVS, RESERVED_HANDLES, type PageNav } from "../pages";
import { formatDateTime, isoToZonedInput } from "../i18n/time";
import { markdownToHtml, shopImageUrl } from "../pages/markdown";
import { APP_BLOCKS_MAX, ARTICLE_BLOCKS_MAX, ARTICLE_BLOCK_BLOGS_MAX, ARTICLE_BLOCK_LIMIT_DEFAULT, ARTICLE_BLOCK_LIMIT_MAX, PRODUCT_BLOCKS_MAX, PRODUCT_BLOCK_LIMIT_DEFAULT, PRODUCT_BLOCK_LIMIT_MAX, PRODUCT_BLOCK_SLUGS_MAX, type ProductBlock } from "../pages/blocks";
import { PRODUCT_SORTS, toPublicShop, type ProductSort } from "../storefront/data";
import { storefrontData } from "../routes/storefront/domain";
import { tagCounts } from "../products/tags";
import { responsiveImage } from "../media/images";
import { CLIENT_PRELUDE } from "../modules/woo-import/admin";
import { PATTERNS_FILE, STYLES_FILE, bantoPatterns, parseBlockStyles, parsePatterns, type BlockStyles, type EditorPattern, type PatternBody } from "./theme-blocks";
import { readThemeBundle, themeStorage } from "../themes/liquid/versions";
import type { CacheAdapter, StorageAdapter } from "../adapters/types";
import { parseManifest, type ManifestBlock } from "../hooks/manifest";
import { pageEditorClient } from "./editor-client";
import { PAGE_BLOCKS_SCRIPT, PAGE_MEDIA_SCRIPT } from "./blocks-script";
import { LAYOUT_ATTRS, LAYOUT_CSS, LAYOUT_DEPTH_MAX, TABS_MAX, layoutDefault } from "../pages/layout";
import { CURRENT_PARTS, PRODUCT_PARTS, PRODUCT_PARTS_DEFAULT, SHOP_BLOCKS_CSS, type ShopBlock } from "../pages/shop-blocks";
import { migrated } from "../db/migration-state";
import { escapeHtml } from "../mail/html";
import { productFields } from "../products/fields";
import { FIELD_IMAGE_SCRIPT, FieldImageInput } from "../routes/admin/field-image";
import { ARTICLES_MULTI_MIGRATION, ARTICLE_ORDERS, BLOG_ORDER_MIGRATION } from "../blog";
import { fieldValues, type ArticleFieldDef } from "../blog/fields";
import { ICONS, ICON_NAMES } from "../pages/icons";

/** レイアウトのブロックの値・既定・文言（PAGE_BLOCKS_SCRIPT が data-layout の JSON で受け取る） */
function layoutConfig(audiences: { id: string; name: string }[] = []): string {
  const kinds = Object.keys(LAYOUT_ATTRS) as (keyof typeof LAYOUT_ATTRS)[];
  const schema: Record<string, Record<string, { values: readonly string[]; def: string }>> = {};
  const L: Record<string, string> = {};
  for (const k of kinds) {
    schema[k] = {};
    L[`kind.${k}`] = t(`layout.kind_${k}` as MessageKey);
    if (k !== "column" && k !== "tab") L[`desc.${k}`] = t(`layout.desc_${k}` as MessageKey);
    for (const [key, values] of Object.entries(LAYOUT_ATTRS[k])) {
      schema[k]![key] = { values, def: layoutDefault(k, key) };
      L[`field.${key}`] = t(`layout.field_${key}` as MessageKey);
      if (key !== "open") for (const v of values) L[`opt.${key}.${v}`] = t(`layout.opt_${key}_${v}` as MessageKey);
    }
  }
  for (const k of ["image", "alt"]) L[`field.${k}`] = t(`layout.field_${k}` as MessageKey);
  // タブの数（書式には書かない。編集の画面で中のタブを足し引きするだけ）
  const counts = Array.from({ length: TABS_MAX - 1 }, (_, i) => String(i + 2));
  schema["tabs"] = { count: { values: counts, def: "2" } };
  L["field.count"] = t("layout.field_count");
  for (const v of counts) L[`opt.count.${v}`] = v;
  // 見せる相手の囲み（同梱モジュール audiences、0097）: 条件があるショップだけ一覧に出す。選ぶのは条件の名前
  if (audiences.length > 0) {
    schema["audience"] = { id: { values: audiences.map((a) => a.id), def: audiences[0]!.id } };
    L["kind.audience"] = t("layout.kind_audience");
    L["desc.audience"] = t("layout.desc_audience");
    L["field.id"] = t("layout.field_audience");
    L["audience_label"] = t("pages.audience_label");
    for (const a of audiences) L[`opt.id.${a.id}`] = a.name;
  }
  for (const k of ["focus_help", "group_design", "settings", "settings_none", "choose_image", "remove_image", "add_image", "parent", "depth_max", "gallery_empty", "media_empty", "acc_title", "tab_title", "colors_note", "text_wrap_help", "text_help"] as const) L[k] = t(`layout.${k}`);
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

/**
 * アイキャッチ画像として保存する URL（ショップの画像の置き場のものだけ。本文の画像と同じ規則）。使えなければ null。
 * 置き場の URL（MEDIA_BASE_URL）はそのまま、ほかの入口の /media/… はホストを外した /media/… にして保存する
 * （ほかのホストの URL をそのまま残すと、外の画像を指せてしまうため）
 */
export function featuredImageUrl(url: string, mediaBase: string): string | null {
  return shopImageUrl(url, mediaBase);
}

/** 見たままの編集での商品のブロックの説明（例: 商品を並べる — カテゴリー: tops・8 件・グリッド・新しい順） */
export function productsLabel(b: ProductBlock): string {
  if (b.slugs?.length) return `${t("pages.block_products")} — ${[tf("pages.products_label_slugs", { n: b.slugs.length }), t(`pages.layout_${b.layout}` as MessageKey)].join("・")}`;
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
export interface EditorExtras {
  /** 記事を並べるブロックで選ぶブログ（0081 が当たっていれば） */
  blogs: { handle: string; title: string }[];
  /** 記事を並べるブロックで並び順を選べるか（0116 が当たっていれば） */
  blogOrder?: boolean;
  /** 記事を並べるブロックでブログをまたげるか（0140 が当たっていれば。選ぶ欄をチェックボックスにする） */
  blogsMulti?: boolean;
  /** ブロックの一覧の「パターン」（公開中のテーマのものと Banto の既定。本文は選んだときに …/pattern で受け取る） */
  patterns: EditorPattern[];
  /** 公開中のテーマのブロックのスタイル */
  styles: BlockStyles;
  /** 外部プラグインが提案するブロック（0086。有効・名前のある連携のマニフェストの blocks） */
  apps?: EditorAppBlocks[];
  /** 見せる相手の囲みで選ぶ会員の条件（同梱モジュール audiences が ON で 0097 が当たっていれば） */
  audiences?: { id: string; name: string }[];
  /** ページ・記事を会員限定にするときに選べる条件（0100 が当たっていれば。表示用の条件は除く）。無ければ欄を出さない */
  gateAudiences?: { id: string; name: string }[];
}

export interface EditorAppBlocks {
  /** 連携の名前（app_handle） */
  app: string;
  /** 連携の表示名 */
  name: string;
  blocks: ManifestBlock[];
}

/** 編集の画面に出すプラグインのブロック（shop_app_blocks、0086。形はマニフェストと同じ規則で確かめ直す） */
async function editorAppBlocks(c: AdminContext, shop: ShopRow): Promise<EditorAppBlocks[]> {
  const db = owner(c).db;
  try {
    const rows = await db.rpc<{ app: string; name: string; blocks: unknown }[]>("shop_app_blocks", { p_shop_id: shop.id });
    return (Array.isArray(rows) ? rows : []).flatMap((r) => {
      const m = parseManifest({ name: r.name || r.app, blocks: r.blocks });
      return m?.blocks?.length ? [{ app: r.app, name: String(r.name || r.app).slice(0, 200), blocks: m.blocks }] : [];
    });
  } catch (e) {
    console.error("[banto] editor app blocks:", e instanceof Error ? e.message : e);
    return [];
  }
}

export async function editorCatalog(c: AdminContext, shop: ShopRow): Promise<{ categories: Pick<CategoryRow, "slug" | "name">[]; tags: { tag: string; count: number }[] } & EditorExtras> {
  const db = owner(c).db;
  const deps = { db, cache: c.get("adapters").cache };
  const [categories, rows, blogs, theme, apps, audiences, blogOrder, blogsMulti] = await Promise.all([
    db.from<CategoryRow>("categories").select("slug,name", { eq: { shop_id: shop.id }, order: "sort_order.asc,name.asc" }).catch(() => [] as CategoryRow[]),
    db.from<{ tags: string[] | null }>("products").select("tags", { eq: { shop_id: shop.id, published: true }, limit: 5000 }).catch(() => [] as { tags: string[] | null }[]),
    db.from<{ handle: string; title: string }>("blogs").select("handle,title", { eq: { shop_id: shop.id }, order: "sort_order.asc,title.asc" }).catch(() => []),
    editorTheme(c, shop),
    editorAppBlocks(c, shop),
    editorAudiences(c, shop),
    migrated(deps, BLOG_ORDER_MIGRATION).catch(() => false),
    migrated(deps, ARTICLES_MULTI_MIGRATION).catch(() => false),
  ]);
  const patterns = [...theme.patterns, ...bantoPatterns()].map(({ name, title, description, source }) => ({ name, title, description, source }));
  const gate = moduleEnabled(shop.settings, AUDIENCES_MODULE) ? audiences.filter((a) => !audienceDisplayOnly(a.condition)).map(({ id, name }) => ({ id, name })) : null;
  return { categories, tags: tagCounts(rows).slice(0, 300), blogs, blogOrder, blogsMulti, patterns, styles: theme.styles, apps, audiences: audiences.map(({ id, name }) => ({ id, name })), ...(gate ? { gateAudiences: gate } : {}) };
}

/** 見せる相手の囲みで選べる会員の条件（モジュールが OFF なら空。読めるのは項目 content を持つ人も） */
async function editorAudiences(c: AdminContext, shop: ShopRow): Promise<{ id: string; name: string; condition?: unknown }[]> {
  if (!moduleEnabled(shop.settings, AUDIENCES_MODULE)) return [];
  return owner(c)
    .db.from<{ id: string; name: string; condition: unknown }>("audiences")
    .select("id,name,condition", { eq: { shop_id: shop.id }, order: "name.asc", limit: 200 })
    .catch(() => []);
}

/** 公開中の Liquid のテーマのパターンとスタイル（公開中の版があるときだけ） */
async function editorTheme(c: AdminContext, shop: ShopRow): Promise<{ patterns: PatternBody[]; styles: BlockStyles }> {
  const db = owner(c).db;
  const adapters = c.get("adapters");
  try {
    const row = await db.from<{ theme_version_id: string | null }>("shops").selectOne("theme_version_id", { eq: { id: shop.id } });
    return await themeEditorFiles({ storage: themeStorage(adapters), cache: adapters.cache }, shop.id, row?.theme_version_id ?? null, getLocale());
  } catch (e) {
    console.error("[banto] editor theme:", e instanceof Error ? e.message : e);
    return { patterns: [], styles: {} };
  }
}

/** お店のブロックの編集の画面の定義（名前・説明・欄）。値の形は src/pages/shop-blocks.ts と同じ（サーバーが描くときにも確かめる） */
export function shopBlockDefs(categories: Pick<CategoryRow, "slug" | "name">[], fields: { key: string; label: string }[] = []) {
  const opt = (pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));
  const slug = "^[a-z0-9][a-z0-9-]{0,62}$";
  return {
    search: { label: t("blocks.search"), desc: t("blocks.search_desc"), group: "shop", fields: [{ key: "placeholder", label: t("blocks.placeholder"), type: "text", placeholder: t("blocks.search_placeholder") }] },
    categories: {
      label: t("blocks.categories"),
      desc: t("blocks.categories_desc"),
      group: "shop",
      fields: [
        { key: "parent", label: t("blocks.categories_parent"), type: "select", options: opt([["", t("blocks.categories_all")], ...categories.map((c): [string, string] => [c.slug, c.name])]) },
        { key: "layout", label: t("blocks.layout"), type: "select", options: opt([["list", t("blocks.layout_list")], ["grid", t("blocks.layout_grid")]]), default: "list" },
      ],
    },
    card: {
      label: t("blocks.card"),
      desc: t("blocks.card_desc"),
      group: "shop",
      oneOf: ["page", "article"],
      oneOfLabel: t("blocks.card"),
      fields: [
        { key: "page", label: t("blocks.card_page"), type: "text", pattern: slug, placeholder: "about" },
        { key: "article", label: t("blocks.card_article"), type: "text", pattern: "^[a-z0-9][a-z0-9-]{0,62}/[a-z0-9][a-z0-9-]{0,62}$", placeholder: "news/hello" },
      ],
    },
    product: {
      label: t("blocks.product"),
      desc: t("blocks.product_desc"),
      group: "shop",
      fields: [
        { key: "slug", label: t("blocks.product_slug"), type: "text", required: true, pattern: slug, placeholder: "tee" },
        // 商品の独自項目（公開のもの）も選べる（field:<key>）
        { key: "show", label: t("blocks.product_show"), type: "checks", default: PRODUCT_PARTS_DEFAULT.join(","), options: opt([...PRODUCT_PARTS.map((x): [string, string] => [x, t(`blocks.part_${x}` as MessageKey)]), ...fields.map((f): [string, string] => [`field:${f.key}`, `${t("blocks.part_field")}: ${f.label}`])]) },
      ],
    },
    toc: {
      label: t("blocks.toc"),
      desc: t("blocks.toc_desc"),
      group: "text",
      fields: [
        { key: "levels", label: t("blocks.toc_levels"), type: "select", options: opt([["3", t("blocks.toc_levels_3")], ["2", t("blocks.toc_levels_2")]]), default: "3" },
        { key: "title", label: t("blocks.toc_title"), type: "text", placeholder: t("blocks.toc_title_placeholder") },
      ],
    },
    stores: {
      label: t("blocks.stores"),
      desc: t("blocks.stores_desc"),
      group: "shop",
      fields: [
        { key: "tryon", label: t("blocks.stores_tryon"), type: "select", options: opt([["0", t("blocks.stores_all")], ["1", t("blocks.stores_tryon_only")]]), default: "0" },
        { key: "layout", label: t("blocks.layout"), type: "select", options: opt([["list", t("blocks.layout_list")], ["grid", t("blocks.layout_grid")]]), default: "list" },
        // 店舗ごとに添える記事（記事の「実店舗」の項目で店舗を指す記事。ブログの URL の名前、項目が 2 つ以上なら :<キー>）
        { key: "articles", label: t("blocks.stores_articles"), type: "text", pattern: "^[a-z0-9][a-z0-9-]{0,62}(:[a-z][a-z0-9_]{0,39})?$", placeholder: "events", help: t("blocks.stores_articles_help") },
        { key: "limit", label: t("blocks.stores_articles_limit"), type: "select", options: opt(["1", "2", "3", "4", "5", "6"].map((n): [string, string] => [n, n])), default: "3" },
        { key: "sort", label: t("blocks.stores_articles_sort"), type: "text", pattern: "^field:[a-z][a-z0-9_]{0,39}$", placeholder: "field:starts", help: t("blocks.stores_articles_sort_help") },
        { key: "from", label: t("pages.articles_from_today"), type: "select", options: opt([["", t("blocks.no")], ["today", t("blocks.yes")]]) },
        { key: "until", label: t("pages.articles_until"), type: "text", pattern: "^field:[a-z][a-z0-9_]{0,39}$", placeholder: "field:ends", help: t("blocks.stores_articles_until_help") },
        // 実店舗の独自項目（0126、公開の項目だけ・書いた順で 10 個まで）
        { key: "show", label: t("blocks.stores_show"), type: "text", pattern: "^field:[a-z][a-z0-9_]{0,39}(,field:[a-z][a-z0-9_]{0,39}){0,9}$", placeholder: "field:parking,field:brands", help: t("blocks.stores_show_help") },
      ],
    },
    include: {
      label: t("blocks.include"),
      desc: t("blocks.include_desc"),
      group: "text",
      fields: [{ key: "page", label: t("blocks.include_page"), type: "text", required: true, pattern: slug, placeholder: "footer-note", help: t("blocks.include_help") }],
    },
    icon: {
      label: t("blocks.icon"),
      desc: t("blocks.icon_desc"),
      group: "design",
      // 編集の画面でもその場で描くための SVG の中身（決まった一式。サーバーの定数だけで、入力からは作らない）
      svgs: ICONS,
      fields: [
        { key: "name", label: t("blocks.icon_name"), type: "select", options: opt(ICON_NAMES.map((n): [string, string] => [n, n])) },
        { key: "size", label: t("blocks.icon_size"), type: "select", options: opt([["s", "S"], ["m", "M"], ["l", "L"], ["xl", "XL"]]), default: "m" },
        { key: "tone", label: t("blocks.icon_tone"), type: "select", options: opt([["text", t("blocks.tone_text")], ["accent", t("blocks.tone_accent")], ["muted", t("blocks.tone_muted")]]), default: "text" },
        { key: "label", label: t("blocks.icon_label"), type: "text", help: t("blocks.icon_label_help") },
      ],
    },
    embed: {
      label: t("blocks.embed"),
      desc: t("blocks.embed_desc"),
      group: "media",
      fields: [{ key: "url", label: t("blocks.embed_url"), type: "text", required: true, pattern: "^(https?://|at://)\\S{3,300}$", placeholder: "https://www.youtube.com/watch?v=…", help: t("blocks.embed_help") }],
    },
    current: {
      label: t("blocks.current"),
      desc: t("blocks.current_desc"),
      group: "text",
      fields: [{ key: "part", label: t("blocks.current_part"), type: "select", options: opt(CURRENT_PARTS.map((x): [string, string] => [x, t(`blocks.cur_${x}` as MessageKey)])), default: "title" }],
    },
    video: {
      label: t("blocks.video"),
      desc: t("blocks.video_desc"),
      group: "media",
      fields: [
        { key: "src", label: t("blocks.video_file"), type: "video", required: true, help: t("blocks.video_help") },
        { key: "poster", label: "", type: "hidden" },
        { key: "autoplay", label: t("blocks.video_autoplay"), type: "select", options: opt([["0", t("blocks.no")], ["1", t("blocks.video_autoplay_on")]]), default: "0" },
        { key: "loop", label: t("blocks.video_loop"), type: "select", options: opt([["0", t("blocks.no")], ["1", t("blocks.yes")]]), default: "0" },
        { key: "controls", label: t("blocks.video_controls"), type: "select", options: opt([["1", t("blocks.yes")], ["0", t("blocks.no")]]), default: "1" },
      ],
    },
    date: {
      label: t("blocks.date"),
      desc: t("blocks.date_desc"),
      group: "text",
      fields: [
        { key: "of", label: t("blocks.date_of"), type: "select", options: opt([["published", t("blocks.date_published")], ["updated", t("blocks.date_updated")], ["now", t("blocks.date_now")]]), default: "published" },
        { key: "format", label: t("blocks.date_format"), type: "select", options: opt([["date", t("blocks.format_date")], ["datetime", t("blocks.format_datetime")]]), default: "date" },
        { key: "label", label: t("blocks.date_label"), type: "text", placeholder: t("blocks.date_label_placeholder") },
      ],
    },
  };
}

/** 管理画面で本文を HTML にする（商品のブロックは説明の箱にする） */
export const editorHtml = (c: AdminContext, body: string) =>
  markdownToHtml(body, { mediaBase: mediaBaseUrl(c), productsLabel, articlesLabel: (b) => tf("pages.articles_label", { blog: b.blog, n: b.limit }), appLabel: (b) => tf("pages.app_label", { app: b.app, block: b.block, product: b.product }), audienceLabel: (title) => tf("pages.audience_label", { name: title || t("pages.audience_unnamed") }), shopLabel: (b) => shopBlockText(b), editor: true });

/** 編集の画面のお店のブロックの目印（ブラウザ側の shopText と同じ形） */
function shopBlockText(b: ShopBlock): string {
  const label = t(`blocks.${b.kind}` as MessageKey);
  const bits = Object.entries(b.attrs).filter(([k, v]) => v && !(k === "layout" && v === "list")).map(([, v]) => v);
  return bits.length ? `${label} — ${bits.join(" · ")}` : label;
}

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
    var send=function(blob,name,thumb){ var fd=new FormData(); fd.append("file",new File([blob],name,{type:blob.type})); if(thumb) fd.append("thumb",new File([thumb],thumb.type==="image/jpeg"?"thumb.jpg":"thumb.webp",{type:thumb.type})); return fetch(form.action,{method:"POST",body:fd,credentials:"same-origin",headers:{Accept:"application/json"}}).then(function(r){ return r.json().then(function(j){ if(!r.ok||!j.url) throw new Error(j.error||"upload"); return j; }); }); };
    return /^image\\/(jpeg|png|webp|avif|heic|heif)$/.test(file.type)?load(file).then(function(im){ return Promise.all([draw(im,1600,0.82),draw(im,400,0.8).catch(function(){ return null; })]); }).then(function(r){ var b=r[0]; return send(b,b.type==="image/jpeg"?"image.jpg":"image.webp",r[1]); },function(){ return send(file,file.name); }):send(file,file.name);
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

/** メディアライブラリの 1 回に読む枚数 */
export const MEDIA_PAGE = 40;

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
#body-visual .banto-text{border-left:3px solid var(--border-strong);padding-left:.75rem}
#body-visual .banto-text[data-style]::after{content:attr(data-style);position:absolute;top:0;right:0;font-size:.7rem;line-height:1;padding:.15rem .35rem;border-radius:3px;background:var(--bg-subtle);color:var(--fg-muted);pointer-events:none}
#body-visual .banto-text[data-style-label]::after{content:attr(data-style-label)}
#body-visual .banto-cover:not([data-image]){background:linear-gradient(135deg,#555,#222)}
#body-visual .banto-media__fig:empty,#body-visual .banto-gallery:empty{min-height:7rem;border:1.5px dashed var(--border-strong);border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer}
#body-visual .banto-media__fig:empty::before,#body-visual .banto-gallery:empty::before{content:attr(data-ph);color:var(--fg-muted);font-size:.85rem}
#body-visual .banto-spacer{background:repeating-linear-gradient(45deg,transparent 0 6px,rgba(127,127,127,.12) 6px 12px);border-radius:4px}
#body-visual .banto-accordion__title{font-weight:600;padding:.75rem 0}
#body-visual .banto-accordion__body{border-top:1px dashed var(--border);padding-top:.5rem}
#body-visual .is-ph-title::before{content:attr(data-ph);position:absolute;color:var(--fg-muted);font-weight:400;pointer-events:none}
.pe-blockset h2{display:flex;align-items:center;gap:.4rem}
.pe-blockset select,.pe-blockset input[type=text]{width:100%;max-width:none}
.pe-focus{display:grid;grid-template-columns:repeat(3,1fr);aspect-ratio:16/10;border:1px solid var(--border-strong);border-radius:6px;overflow:hidden;background:var(--bg-subtle) center/100% 100% no-repeat;margin:.25rem 0}
.pe-focus label{position:relative;margin:0;border:1px dashed rgba(255,255,255,.55);cursor:pointer}
.pe-focus label:hover{background:rgba(31,111,235,.18)}
.pe-focus input{position:absolute;opacity:0;width:1px;height:1px}
.pe-focus label:has(input:checked){background:rgba(31,111,235,.35);box-shadow:inset 0 0 0 2px var(--link)}
.pe-focus label:has(input:checked)::after{content:"";position:absolute;left:50%;top:50%;width:10px;height:10px;margin:-5px;border-radius:50%;background:#fff;box-shadow:0 0 0 2px var(--link)}
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
.page-preview .banto-shop:not(.banto-shop--icon){border:1px dashed var(--border-strong);border-radius:6px;padding:.75rem 1rem;margin:.75rem 0;background:var(--bg-subtle);cursor:pointer;font-size:.9rem;user-select:none}
.page-preview .banto-shop--icon{cursor:pointer;display:inline-block;margin:.25rem 0}
.page-preview .banto-shop--video video{display:block;width:100%;max-height:360px;background:#000;border-radius:4px;pointer-events:none}
.page-preview .banto-tabs{border:1px solid var(--border);border-radius:6px;padding:.5rem}
.page-preview .banto-tab{border-top:1px dashed var(--border);padding:.25rem 0}.page-preview .banto-tab:first-child{border-top:0}
.page-preview .banto-tab__title{font-weight:600;padding:.25rem 0}
.page-preview .banto-grid{outline:1px dashed var(--border);outline-offset:3px}
.page-preview .banto-audience{border:2px dashed var(--accent,#1f6feb);border-radius:6px;padding:.5rem .75rem;margin:.75rem 0}
.page-preview .banto-audience__label{font-size:.8rem;color:var(--accent,#1f6feb);margin-bottom:.25rem;user-select:none}
.page-preview .banto-app,.page-preview .banto-articles{border:1px dashed var(--border-strong);border-radius:6px;padding:.75rem 1rem;margin:.75rem 0;background:var(--bg-subtle);cursor:pointer;font-size:.9rem;user-select:none}
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
.ba-blogs{border:0;padding:0;margin:0 0 .5rem}.ba-blogs label{display:block;margin:.15rem 0}
#blk-products,#blk-button,#blk-articles,#blk-app{max-width:28rem;width:calc(100% - 2rem);border:1px solid var(--border-strong);border-radius:10px;padding:1.25rem 1.5rem}
#blk-products::backdrop,#blk-button::backdrop,#blk-articles::backdrop,#blk-app::backdrop{background:rgba(0,0,0,.35)}
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
.pe-live{display:none}
.pe-full .pe-live{display:flex;flex-direction:column;flex:0 0 46%;min-width:320px;border-left:1px solid var(--border);background:var(--bg-page)}
.pe-full .pe-live[hidden]{display:none}
.pe-live-head{display:flex;align-items:center;gap:.35rem;padding:.5rem .75rem;border-bottom:1px solid var(--border)}
.pe-live-note{font-size:.75rem;margin:.35rem .75rem}
.pe-live [data-live-msg]{margin:.35rem .75rem}
.pe-live-frame{flex:1;min-height:0;display:flex;justify-content:center;background:var(--bg-subtle);padding:0}
.pe-live-frame iframe{width:100%;height:100%;border:0;background:#fff}
.pe-live[data-w=phone] .pe-live-frame{padding:.75rem 0}
.pe-live[data-w=phone] .pe-live-frame iframe{width:390px;max-width:100%;border-radius:12px;box-shadow:0 0 0 1px var(--border)}
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
@media (max-width:900px){.pe-full .pe-live{position:absolute;inset:0;z-index:44;flex:none;min-width:0}.pe-full .pe-left,.pe-full .split>aside{position:absolute;top:0;bottom:0;z-index:45;width:min(320px,88vw);box-shadow:var(--shadow)}.pe-full .pe-left{left:0}.pe-full .split>aside{right:0}.pe-full .pe-bar .status{display:none}}
.pe-file{position:relative;display:inline-flex;align-items:center;height:32px;padding:0 .8rem;border:1px solid var(--border-strong);border-radius:6px;background:var(--bg);cursor:pointer;font-size:.85rem;font-weight:500;overflow:hidden;margin:0}
.pe-file input{position:absolute;inset:0;opacity:0;cursor:pointer;font-size:0}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
${LAYOUT_CSS}
${SHOP_BLOCKS_CSS}
`;

/** 編集の画面の種類ごとの違い（ページと記事） */
export interface EditorKind {
  /** 画像・メディア・変換の口の起点（…/modules/pages など。mountEditorEndpoints を付けた先） */
  base: string;
  /** お客様の画面の URL の名前の前（/pages/ や /blogs/news/） */
  urlPrefix: string;
  /** メニュー・並び順の欄（ページだけ） */
  nav: boolean;
  /** 「部品として使う」の欄（ページだけ。0122 が当たってから） */
  part?: boolean;
  /** 編集の画面の左上の「戻る」の行き先（無ければ base） */
  back?: string;
  /** 記事の欄（タグ・抜粋・書いた人） */
  article?: {
    tags: string;
    excerpt: string;
    author: string;
    /** 記事の項目（0117）: そのブログの定義と今の値・選べる店舗・指すブログの記事 */
    fields?: { defs: ArticleFieldDef[]; values: Record<string, unknown>; stores: { id: string; name: string }[]; articles: Record<string, { handle: string; title: string }[]>; upload?: string };
  };
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
  /** 部品のページ（0122）。欄があったときだけ書く */
  is_part?: boolean;
  /** 会員限定（0100）。欄があったときだけ書く */
  audience_id?: string | null;
  audience_hide?: boolean;
}

/** 会員限定の欄の値（欄の無い送信では列に触れない） */
export function contentAudienceValues(f: Record<string, string>): Pick<ContentValues, "audience_id" | "audience_hide"> {
  return f.audience_present === "1" ? { audience_id: f.audience_id || null, audience_hide: f.audience_hide === "on" } : {};
}

/** 記事の項目の入力欄（0117。形と指す先は DB が確かめる）。商品・記事は URL の名前（いくつも選べるものはカンマ区切り） */
function ArticleFieldInputs(props: { f: NonNullable<NonNullable<EditorKind["article"]>["fields"]> }) {
  const { defs, values, stores, articles, upload } = props.f;
  if (defs.length === 0) return null;
  const val = (k: string) => fieldValues(values[k]).join(", ");
  return (
    <fieldset class="pe-fields">
      <legend>{t("blog.fields")}</legend>
      {defs.map((f) => {
        const id = `field_${f.key}`;
        const label = (
          <label for={id}>
            {f.label}
            {f.multiple ? <span class="muted"> {t("blog.fields_multiple")}</span> : null}
          </label>
        );
        if (f.type === "image") {
          return (
            <>
              {label}
              <FieldImageInput id={id} name={id} value={val(f.key)} upload={upload ?? ""} />
            </>
          );
        }
        // 日付（0124）: 日付は YYYY-MM-DD、日時はデプロイの時間帯の「日付と時刻」で入れる（保存のときに時差つきへ）
        if (f.type === "date" || f.type === "datetime") {
          return (
            <>
              {label}
              <input id={id} name={id} type={f.type === "date" ? "date" : "datetime-local"} value={f.type === "date" ? val(f.key) : isoToZonedInput(val(f.key) || null)} />
            </>
          );
        }
        if (f.type === "select" || f.type === "store" || (f.type === "article" && !f.multiple)) {
          const opts: [string, string][] = f.type === "select" ? (f.options ?? []).map((o) => [o, o]) : f.type === "store" ? stores.map((s) => [s.id, s.name]) : (articles[f.key] ?? []).map((a) => [a.handle, a.title]);
          return (
            <>
              {label}
              <select id={id} name={id}>
                <option value="">—</option>
                {opts.map(([v, l]) => (
                  <option value={v} selected={val(f.key) === v}>
                    {l}
                  </option>
                ))}
              </select>
            </>
          );
        }
        return (
          <>
            {label}
            <input id={id} name={id} value={val(f.key)} type={f.type === "number" ? "number" : "text"} step={f.type === "number" ? "any" : undefined} maxlength={f.type === "text" ? 500 : 1600} placeholder={f.type === "product" ? "tee, coat" : f.type === "article" ? "amada, kato" : undefined} list={f.type === "article" ? `${id}_list` : undefined} />
            {f.type === "article" ? (
              <datalist id={`${id}_list`}>
                {(articles[f.key] ?? []).map((a) => (
                  <option value={a.handle}>{a.title}</option>
                ))}
              </datalist>
            ) : null}
          </>
        );
      })}
      <p class="muted">{t("blog.fields_help")}</p>
      {defs.some((f) => f.type === "image") ? <script dangerouslySetInnerHTML={{ __html: FIELD_IMAGE_SCRIPT }} /> : null}
    </fieldset>
  );
}

export function ContentForm(props: { kind: EditorKind; shop: ShopRow; action: string; selfUrl: string; values: ContentValues; visual: string; categories: Pick<CategoryRow, "slug" | "name">[]; tags?: { tag: string; count: number }[]; extras?: EditorExtras; pageId?: string; viewUrl?: string | null; error?: MessageKey | null; image?: string | null; revisions: RevisionRow[] }) {
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
    "data-t-products-slugs": t("pages.products_label_slugs"),
    "data-t-products-related": t("pages.products_label_related"),
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
    "data-layout": layoutConfig(props.extras?.audiences ?? []),
    // パターン（一覧に出す名前だけ）とテーマのスタイル、記事を並べるブロックの文言
    "data-patterns": JSON.stringify(props.extras?.patterns ?? []),
    "data-styles": JSON.stringify(props.extras?.styles ?? {}),
    "data-t-patterns": t("pages.block_patterns"),
    "data-t-patterns-theme": t("pages.block_patterns_theme"),
    "data-t-style": t("pages.block_style"),
    "data-t-style-default": t("pages.block_style_default"),
    "data-t-articles": t("pages.block_articles"),
    "data-t-d-articles": t("pages.blockdesc_articles"),
    "data-t-articles-max": tf("pages.articles_max", { n: ARTICLE_BLOCKS_MAX }),
    // お店のブロック（src/pages/shop-blocks.ts）の名前・説明・設定の欄
    "data-shop-blocks": JSON.stringify(shopBlockDefs(props.categories, productFields(props.shop.settings).filter((f) => f.public))),
    // 動画のブロックの置き場（mp4、1 本の上限）
    "data-video-upload": `${props.kind.base}/videos`,
    "data-video-max": String(MAX_VIDEO_BYTES),
    "data-t-video-uploading": t("video.uploading"),
    "data-t-video-too-large": t("video.too_large"),
    "data-t-ok": t("blocks.ok"),
    "data-t-cancel": t("blocks.cancel"),
    "data-t-shop-required": t("blocks.required"),
    "data-t-articles-none": t("pages.articles_none"),
    "data-t-articles-label": t("pages.articles_label"),
    "data-t-articles-all": t("pages.articles_all_blogs"),
    // 外部プラグインのブロック（0086）
    "data-apps": JSON.stringify(props.extras?.apps ?? []),
    "data-t-g-apps": t("pages.block_group_apps"),
    "data-t-app": t("pages.block_app"),
    "data-t-app-max": tf("pages.app_max", { n: APP_BLOCKS_MAX }),
    "data-t-app-label": t("pages.app_label"),
    "data-t-app-rlayout": t("pages.app_reviews_layout"),
    "data-t-app-rlist": t("pages.app_reviews_layout_list"),
    "data-t-app-rsummary": t("pages.app_reviews_layout_summary"),
    "data-t-app-rlimit": t("pages.app_reviews_limit"),
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
    "data-t-live": t("pages.live_toggle"),
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
      <form method="post" action={props.action} id="page-form" data-reserved={RESERVED_HANDLES.join(",")} data-preview-key={props.pageId ?? "new"} data-preview-window={`${props.kind.base}/preview-window`} {...blockText}>
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
          {/* お店の見た目（JS があるときだけ。PAGE_BLOCKS_SCRIPT が開け閉めし、お店のオリジンで描いた本物の見た目を入れる。管理画面とは別のオリジンの枠） */}
          <div id="pe-live" class="pe-live" hidden data-w="full">
            <div class="pe-live-head">
              <strong>{t("pages.live_title")}</strong>
              <span class="pe-grow" />
              <button type="button" class="secondary small" data-live-w="full" title={t("pages.live_wide")}>
                {t("pages.live_wide")}
              </button>
              <button type="button" class="secondary small" data-live-w="phone" title={t("pages.live_phone")}>
                {t("pages.live_phone")}
              </button>
              <button type="button" class="secondary small" data-live-close aria-label={t("pages.live_close")} title={t("pages.live_close")}>
                ×
              </button>
            </div>
            <p class="muted pe-live-note">{t("pages.live_note")}</p>
            <p class="error" data-live-msg hidden></p>
            <div class="pe-live-frame">
              <iframe name={`banto-live-${props.pageId ?? "new"}`} title={t("pages.live_title")} sandbox="allow-scripts allow-forms allow-popups" referrerpolicy="no-referrer" />
            </div>
          </div>
          <aside>
            <section class="card">
              <h2>{t("pages.publish_card")}</h2>
              <label for="published_at">{t("pages.published_at")}</label>
              <input id="published_at" name="published_at" type="datetime-local" value={isoToZonedInput(v.published_at)} />
              <p class="muted">{t("pages.published_at_help")}</p>
            </section>
            {props.extras?.gateAudiences ? (
              <section class="card">
                <h2>{t("pages.audience_card")}</h2>
                <input type="hidden" name="audience_present" value="1" />
                <label for="audience_id">{t("pages.audience_gate")}</label>
                <select id="audience_id" name="audience_id">
                  <option value="">{t("pages.audience_anyone")}</option>
                  {props.extras.gateAudiences.map((a) => (
                    <option value={a.id} selected={v.audience_id === a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <label style="display:block;margin-top:.5rem">
                  <input type="checkbox" name="audience_hide" value="on" checked={v.audience_hide === true} /> {t("pages.audience_hide")}
                </label>
                <p class="muted">{t("pages.audience_gate_help")}</p>
              </section>
            ) : null}
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
                  {props.kind.part ? (
                    <>
                      <input type="hidden" name="is_part_present" value="1" />
                      <label style="display:block;margin-top:.5rem">
                        <input type="checkbox" name="is_part" value="on" checked={v.is_part === true} /> {t("pages.is_part")}
                      </label>
                      <p class="muted">{t("pages.is_part_help")}</p>
                    </>
                  ) : null}
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
                  {props.kind.article.fields ? <ArticleFieldInputs f={props.kind.article.fields} /> : null}
                </>
              ) : null}
            </section>
            <section class="card">
              <h2>{t("pages.image")}</h2>
              {/* 画像のフォームは外に置き、欄とボタンは form 属性でそちらに結ぶ（フォームは入れ子にできない） */}
              <input id="page-image" type="file" name="file" accept="image/*" required form="page-image-form" />
              <p class="muted">{t("pages.image_help")}</p>
              <p>
                <button type="button" class="secondary small" data-media="body" hidden>
                  {t("pages.media_library")}
                </button>{" "}
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
                  {t("pages.trash")}
                </button>
              </section>
            ) : null}
          </aside>
        </div>
      </form>
      <form method="post" action={`${props.kind.base}/images`} enctype="multipart/form-data" id="page-image-form" data-busy={t("pages.image_busy")} data-failed={t("pages.image_failed")}>
        <input type="hidden" name="back" value={props.selfUrl} />
      </form>
      {props.pageId ? <form method="post" action={`${props.action}/trash`} id="page-delete" /> : null}
      {props.pageId && props.revisions.length > 0 ? <form method="post" action={`${props.action}/revisions`} id="page-revert" onsubmit={`return confirm(${JSON.stringify(t("pages.revision_confirm"))})`} /> : null}
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
        <p id="media-more-row" style="text-align:center;margin:.5rem 0 0" hidden>
          <button type="button" class="secondary small" id="media-more">
            {t("pages.media_more")}
          </button>
        </p>
      </dialog>
      {/* 商品を並べるブロックの設定（PAGE_BLOCKS_SCRIPT が開く。JS が無ければ書式の「::: products …」を直接書く） */}
      <dialog id="blk-products" aria-labelledby="blk-products-title">
        <form method="dialog">
          <h2 id="blk-products-title">{t("pages.block_products")}</h2>
          {/* 選んだ商品（0112）。書くと下の絞り込み・数・並び順は使わず、書いた順に並べる */}
          <label for="bp-slugs">{tf("pages.products_slugs", { max: PRODUCT_BLOCK_SLUGS_MAX })}</label>
          <input id="bp-slugs" name="slugs" maxlength={1600} placeholder="tee,coat,knit" autocomplete="off" />
          <p class="muted">{t("pages.products_slugs_help")}</p>
          {/* 似た商品（商品詳細のひな形で、今の商品と同じ主カテゴリー・タグ）。選ぶとカテゴリー・タグは使わない */}
          <label>
            <input type="checkbox" name="related" value="1" /> {t("pages.products_related")}
          </label>
          <p class="muted">{t("pages.products_related_help")}</p>
          <label for="bp-from">{t("pages.products_from")}</label>
          <input id="bp-from" name="from" maxlength={40} pattern="[a-z][a-z0-9_]{0,39}" placeholder="items" autocomplete="off" />
          <p class="muted">{t("pages.products_from_help")}</p>
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
          {/* テーマのスタイル（テーマが決めているときだけスクリプトが出す） */}
          <label for="bp-style" hidden>
            {t("pages.block_style")}
          </label>
          <select id="bp-style" name="style" hidden></select>
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
          <label for="bb-style" hidden>
            {t("pages.block_style")}
          </label>
          <select id="bb-style" name="style" hidden></select>
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
      {/* 外部プラグインのブロックの設定（0086。PAGE_BLOCKS_SCRIPT が設定の欄をマニフェストから作る） */}
      {props.extras?.apps?.length ? (
        <dialog id="blk-app" aria-labelledby="blk-app-title">
          <form method="dialog">
            <h2 id="blk-app-title"></h2>
            <p class="muted" id="bapp-desc"></p>
            <label for="bapp-product">{t("pages.app_product")}</label>
            <input id="bapp-product" name="product" required pattern="[a-z0-9][a-z0-9\-]{0,62}" maxlength={63} placeholder="tee" />
            <div class="muted">{t("pages.app_product_help")}</div>
            <div id="bapp-fields"></div>
            <label for="bapp-style" hidden>
              {t("pages.block_style")}
            </label>
            <select id="bapp-style" name="style" hidden></select>
            <p class="muted">{tf("pages.app_help", { n: APP_BLOCKS_MAX })}</p>
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
      ) : null}
      {/* 記事を並べるブロックの設定（PAGE_BLOCKS_SCRIPT が開く。ブログのあるショップだけ） */}
      {props.extras?.blogs.length ? (
        <dialog id="blk-articles" aria-labelledby="blk-articles-title">
          <form method="dialog">
            <h2 id="blk-articles-title">{t("pages.block_articles")}</h2>
            {props.extras.blogsMulti && props.extras.blogs.length > 1 ? (
              // ブログをまたぐ（0140）: いくつでも選べる。「すべてのブログ」はこれから作るブログも含む
              <fieldset class="ba-blogs">
                <legend>{t("pages.articles_blogs")}</legend>
                <label>
                  <input type="checkbox" name="allblogs" value="*" /> {t("pages.articles_all_blogs")}
                </label>
                {props.extras.blogs.map((b) => (
                  <label>
                    <input type="checkbox" name="blogs" value={b.handle} data-title={b.title} /> {b.title}（{b.handle}）
                  </label>
                ))}
                <p class="muted">{tf("pages.articles_blogs_help", { n: ARTICLE_BLOCK_BLOGS_MAX })}</p>
              </fieldset>
            ) : (
              <>
                <label for="ba-blog">{t("pages.articles_blog")}</label>
                <select id="ba-blog" name="blog">
                  {props.extras.blogs.map((b) => (
                    <option value={b.handle}>
                      {b.title}（{b.handle}）
                    </option>
                  ))}
                </select>
              </>
            )}
            <label for="ba-tag">{t("pages.articles_tag")}</label>
            <input id="ba-tag" name="tag" maxlength={50} />
            <p class="muted">{t("pages.articles_tag_help")}</p>
            <label for="ba-field">{t("pages.articles_field")}</label>
            <input id="ba-field" name="field" maxlength={141} placeholder="author=@article" autocomplete="off" />
            <p class="muted">{t("pages.articles_field_help")}</p>
            <label for="ba-limit">{tf("pages.articles_limit", { max: ARTICLE_BLOCK_LIMIT_MAX })}</label>
            <input id="ba-limit" name="limit" type="number" min={1} max={ARTICLE_BLOCK_LIMIT_MAX} value={String(ARTICLE_BLOCK_LIMIT_DEFAULT)} style="width:6rem" />
            <label for="ba-layout">{t("pages.articles_layout")}</label>
            <select id="ba-layout" name="layout">
              <option value="grid">{t("pages.articles_layout_grid")}</option>
              <option value="list">{t("pages.articles_layout_list")}</option>
            </select>
            {props.extras.blogOrder ? (
              <>
                <label for="ba-sort">{t("pages.articles_sort")}</label>
                <select id="ba-sort" name="sort">
                  <option value="">{t("pages.articles_sort_blog")}</option>
                  {ARTICLE_ORDERS.map((o) => (
                    <option value={o}>{t(`blog.order_${o}` as MessageKey)}</option>
                  ))}
                </select>
              </>
            ) : null}
            <label for="ba-fsort">{t("pages.articles_fsort")}</label>
            <input id="ba-fsort" name="fsort" pattern="[a-z][a-z0-9_]{0,39}" maxlength={40} placeholder="starts" />
            <label style="display:block;margin-top:.25rem">
              <input type="checkbox" name="from" value="today" /> {t("pages.articles_from_today")}
            </label>
            <label for="ba-funtil">{t("pages.articles_until")}</label>
            <input id="ba-funtil" name="funtil" pattern="[a-z][a-z0-9_]{0,39}" maxlength={40} placeholder="ends" />
            <p class="muted">{t("pages.articles_fsort_help")}</p>
            <label for="ba-style" hidden>
              {t("pages.block_style")}
            </label>
            <select id="ba-style" name="style" hidden></select>
            <p class="muted">{tf("pages.articles_help", { n: ARTICLE_BLOCKS_MAX })}</p>
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
      ) : null}
      <script dangerouslySetInnerHTML={{ __html: PAGE_EDITOR_SCRIPT }} />
      <script dangerouslySetInnerHTML={{ __html: visualEditorScript(props.kind.base) }} />
      <script dangerouslySetInnerHTML={{ __html: PAGE_BLOCKS_SCRIPT }} />
      <script dangerouslySetInnerHTML={{ __html: PAGE_MEDIA_SCRIPT }} />
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
  /**
   * プレビューのタブ（中身は空の枠だけ）。開いた・読み直したら編集の画面（opener）に知らせ、編集の画面が券を作って枠にお店の見た目を描く。
   * テーマのコードは枠（sandbox、上の画面を動かせない）の中だけで動く
   */
  app.get("/preview-window", requireOwner, async (c: AdminContext) => {
    const shop = await scope(c);
    if (!shop) return c.notFound();
    c.header("Cache-Control", "private, no-store");
    c.header("X-Robots-Tag", "noindex");
    return c.html(
      `<!doctype html><html lang="${getLocale()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${escapeHtml(`${t("pages.preview")} · ${shop.name}`)}</title>` +
        `<style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}#m{font:14px/1.6 system-ui,sans-serif;padding:1rem 1.25rem;margin:0}</style></head>` +
        `<body><p id="m" hidden>${escapeHtml(t("pages.preview_window_lost"))}</p><iframe name="pv" title="${escapeHtml(t("pages.preview"))}" sandbox="allow-scripts allow-forms allow-popups" referrerpolicy="no-referrer"></iframe>` +
        `<script>(function(){var o=null;try{o=window.opener;if(o&&o.bantoPreviewReady){o.bantoPreviewReady(window);return}}catch(e){}document.getElementById("m").hidden=false;document.querySelector("iframe").hidden=true})();</script></body></html>`,
    );
  });

/**
 * 本文に使う画像を置く。中身の先頭のバイトで種類を決め（SVG・HTML は受けない）、pages/<ショップ>/ に置く。
 * thumb はブラウザが作った長辺 400px の縮小版（任意。メディアライブラリの一覧に使う、0082）
 */
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
  // 一覧用の縮小版（形が合わなければ置かない。本画像はそのまま使える）
  let thumbUrl: string | null = null;
  const thumb = body.thumb;
  if (thumb instanceof File && thumb.size > 0 && thumb.size <= MAX_THUMB_BYTES) {
    const tb = new Uint8Array(await thumb.arrayBuffer());
    const tk = sniffImage(tb);
    if (tk) {
      const tKey = thumbKey(key, tk.ext);
      await c.get("adapters").storage.put(tKey, tb.buffer as ArrayBuffer, tk.contentType);
      thumbUrl = imageUrl(mediaBaseUrl(c), tKey);
    }
  }
  // メディアライブラリに記録する（記録できなくても画像は使える）
  await owner(c).db.from("page_media").insert({ shop_id: shop.id, storage_key: key, url, ...(thumbUrl ? { thumb_url: thumbUrl } : {}) }).catch((e: unknown) => console.error("[banto] page_media:", e));
  if (wantsJson) return c.json({ url });
  return c.redirect(`${back}?image=${encodeURIComponent(url)}`);
});

/**
 * 本文の短い動画（`::: video`）を置く。mp4 だけ（先頭のバイトで確かめる）・1 本 MAX_VIDEO_BYTES まで。Worker では変換しない。
 * 置き場は画像と同じ pages/<ショップ>/。メディアライブラリ（画像の一覧）には載せない
 */
  app.post("/videos", requireOwner, async (c: AdminContext) => {
    const shop = await scope(c);
    if (!shop) return c.notFound();
    // 大きすぎるものは読む前に断る（申告の大きさ。中身は読んだ後にも数える）
    const declared = Number(c.req.header("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_VIDEO_BYTES + 64 * 1024) return c.json({ error: t("video.too_large") }, 413);
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File) || file.size === 0) return c.json({ error: t("video.invalid_type") }, 400);
    if (file.size > MAX_VIDEO_BYTES) return c.json({ error: t("video.too_large") }, 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!sniffMp4(bytes)) return c.json({ error: t("video.invalid_type") }, 400);
    const key = `pages/${shop.id}/${randomKey()}.mp4`;
    await c.get("adapters").storage.put(key, bytes.buffer as ArrayBuffer, "video/mp4");
    return c.json({ url: imageUrl(mediaBaseUrl(c), key) });
  });

/**
 * メディアライブラリ（0080）: 置いた画像を新しい順に MEDIA_PAGE 枚ずつ。続きは next を after に渡す
 * （キーセットのページ送り。画像が何千枚あっても 1 回に読むのは MEDIA_PAGE 枚だけ）
 */
  app.get("/media", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const after = readAfter(c.req.query("after"));
  if (after === null) return c.json({ error: "bad_cursor" }, 400);
  const rows = await owner(c).db.from<{ id: string; url: string; thumb_url?: string | null; created_at: string }>("page_media").select("id,url,thumb_url,created_at", { eq: { shop_id: shop.id }, where: after ? [olderThan(after)] : [], order: "created_at.desc,id.desc", limit: MEDIA_PAGE + 1 });
  const page = splitPage(rows, (r) => r.created_at, MEDIA_PAGE);
  c.header("Cache-Control", "private, no-store");
  return c.json({ items: page.rows, next: page.next });
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
  const slugs = (q.slugs ?? "").split(",").map((x) => x.trim()).filter((x) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(x)).slice(0, PRODUCT_BLOCK_SLUGS_MAX);
  if (slugs.length) {
    const picked = await sf.productsBySlugs(toPublicShop(shop), slugs);
    return c.json({ total: picked.length, items: picked.slice(0, 6).map((x) => ({ name: x.product.name, image: x.image ? responsiveImage(mediaBaseUrl(c), x.image).src : null })) });
  }
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
  /** パターンの本文を編集の形の HTML で返す（ブロックの一覧の「パターン」を選んだとき） */
  app.get("/pattern", requireOwner, async (c: AdminContext) => {
    const shop = await scope(c);
    if (!shop) return c.notFound();
    const name = c.req.query("name") ?? "";
    const all = [...(await editorTheme(c, shop)).patterns, ...bantoPatterns()];
    const p = all.find((x) => x.name === name);
    if (!p) return c.json({ error: "not_found" }, 404);
    c.header("Cache-Control", "private, no-store");
    return c.json({ html: editorHtml(c, p.body) });
  });

  app.post("/render", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const f = await formFields(c);
  const body = (f.body ?? "").slice(0, PAGE_LIMITS.body);
  return c.json({ html: editorHtml(c, body) });
});
}

/**
 * 編集の画面で使うテーマのパターンとスタイル（公開中の Liquid のテーマ。版ごとに覚える）。
 * テーマが無ければ空。束ねたファイルが読めなければ空（編集の画面は既定のパターンだけで使える）
 */
async function themeEditorFiles(deps: { storage: StorageAdapter; cache: CacheAdapter }, shopId: string, versionId: string | null, locale: string): Promise<{ patterns: PatternBody[]; styles: BlockStyles }> {
  if (!versionId) return { patterns: [], styles: {} };
  const key = `themeblocks:${shopId}:${versionId}:${locale}`;
  const hit = await deps.cache.get<{ patterns: PatternBody[]; styles: BlockStyles }>(key);
  if (hit) return hit;
  const bundle = await readThemeBundle(deps.storage, shopId, versionId).catch(() => null);
  const out = bundle ? { patterns: parsePatterns(bundle.files[PATTERNS_FILE], locale).patterns, styles: parseBlockStyles(bundle.files[STYLES_FILE], locale).styles } : { patterns: [], styles: {} };
  await deps.cache.set(key, out, 300);
  return out;
}
