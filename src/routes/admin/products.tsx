import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { planLimitOf } from "../../plan/limits";
import { ADMIN_PAGE_SIZE, Pager, olderThan, readAfter, searchRows, splitPage } from "./paging";
import { selectIn } from "../../db/select-in";
import type { Filter } from "../../db/client";
import type { CategoryRow, InventoryRow, ProductImageRow, ProductRow, ShopRow, SkuRow } from "../../db/types";
import { MAX_IMAGE_BYTES, MAX_THUMB_BYTES, imageDimension, imageExtension, imageSize, imageUrl, productImageKey, thumbKey } from "../../media/images";
import { ORIGINAL_MAX_BYTES, imageKeys, imageMaxWidth, imageProcessing, readVariantFiles, resizeScript, thumbScript, thumbWidthOf, variantKey } from "../../media/variants";
import { t, tf, type MessageKey } from "../../i18n";
import { AdminLayout, PageHead } from "./layout";
import { SLUG_RE, formFields, mediaBaseUrl, owner, param, params, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";
import { normalizeTags } from "../../products/tags";
import { cleanAttributes, productFields, type ProductField } from "../../products/fields";
import { FIELD_IMAGE_SCRIPT, FieldImageInput, fieldImageUpload } from "./field-image";
import { categoryOptions, loadCategories } from "./categories";
import { TAX_CLASSES, isTaxClass, taxClassOf } from "../../commerce/tax";
import { imageOptionsFromForm, imageOptionsOf, skuOptionChoices } from "../../products/images";
import { MAX_COMBINATIONS, codeFromPattern, combinations, inferOptionAxes, optionAxesFromForm, optionAxesOf, parseAxisValues, resolveOptionAxes, type OptionAxes } from "../../products/option-axes";
import { sizeChartHref } from "../../modules/size-charts/admin";
import { AxesEditor, ChipsInput, ChipsScript, axesErrorCode, axesText } from "./option-axes";
import { optionLabel, optionNamesOf, type OptionNames } from "../../products/option-names";
import { moduleEnabled } from "../../modules/registry";
import { AUDIENCES_MODULE, audienceDisplayOnly } from "../../members/audience";

export const products = new Hono<AppEnv>();

function flash(code: string | undefined): { kind: "ok" | "error"; text: string } | null {
  if (!code) return null;
  const map: Record<string, MessageKey> = {
    saved: "shop.saved",
    slug_taken: "product.slug_taken",
    plan_limit: "plan.limit_products",
    invalid_slug: "setup.shop.invalid_slug",
    sku_taken: "sku.code_taken",
    sku_invalid: "sku.invalid",
    image_type: "image.invalid_type",
    image_size: "image.too_large",
    generic: "error.generic",
    axes_saved: "axes.saved",
    axes_invalid: "axes.invalid",
    axes_mismatch: "axes.mismatch",
    axes_duplicate: "axes.duplicate",
    infer_failed: "axes.infer_failed",
    matrix_empty: "axes.matrix_empty",
    audience_display_only: "product.audience_display_only",
  };
  if (code === "matrix_too_many") return { kind: "error", text: tf("axes.matrix_too_many", { max: MAX_COMBINATIONS }) };
  const key = map[code];
  if (!key) return null;
  return { kind: code === "saved" || code === "axes_saved" ? "ok" : "error", text: t(key) };
}

/** 一括作成の結果（?flash=matrix&n=&skip=） */
function matrixFlash(q: (k: string) => string | undefined): string | null {
  return q("flash") === "matrix" ? tf("axes.matrix_created", { n: q("n") ?? "0", skip: q("skip") ?? "0" }) : null;
}

const Flash = (props: { flash: ReturnType<typeof flash> }) =>
  props.flash ? <p class={props.flash.kind === "ok" ? "notice" : "error"}>{props.flash.text}</p> : null;

// ---------- 一覧 ----------
/**
 * ブラウザ側で縮小してからアップロードする（サーバーでは画像処理をしない: Workers の CPU 制限と可搬性のため）。
 * 基準は横幅（高さは 4096px まで）。本画像の横幅がショップの設定（既定 1600px）、サムネイルは横幅 400px、そのあいだの段（800 など、0091）も作る。どれも WebP（src/media/variants.ts）。
 * GIF（アニメーションの可能性）と SVG は触らない。canvas / WebP が使えない環境では通常のフォーム送信にフォールバックする（サムネイルなし）。
 * 中間の段は 0091 が当たるまで送らない（data-variants）。
 */
const IMAGE_RESIZE_SCRIPT = `
(function(){
  var form=document.getElementById("image-form"); if(!form) return;
  var input=document.getElementById("file"), status=document.getElementById("image-status");
  var MAX=Number(form.getAttribute("data-max"))||1600, VARIANTS=form.getAttribute("data-variants")==="1", PLUGIN=form.getAttribute("data-processing")==="plugin";
  ${resizeScript()}
  ${thumbScript()}
  function load(file){ return new Promise(function(ok,ng){ var url=URL.createObjectURL(file); var im=new Image(); im.onload=function(){URL.revokeObjectURL(url);ok(im)}; im.onerror=function(){URL.revokeObjectURL(url);ng(new Error("decode"))}; im.src=url; }); }
  form.addEventListener("submit",function(ev){
    var file=input.files&&input.files[0]; if(!file) return;
    if(!/^image\\/(jpeg|png|webp|avif)$/.test(file.type)) return; // GIF などはそのまま送る
    ev.preventDefault(); var btn=form.querySelector("button[type=submit]"); btn.disabled=true; status.textContent=form.getAttribute("data-resizing")||"";
    load(file).then(function(im){
      // 外部の変換プラグインに任せるショップ（0092）: 元の写真はそのまま、サムネイルだけ作る（本画像と中間の段はプラグインが作って差し替える）
      if(PLUGIN) return bantoThumb(im).then(function(t){
        var fd=new FormData(); fd.append("file",file); fd.append("thumb",new File([t.blob],"thumb.webp",{type:"image/webp"}));
        fd.append("width",String(im.naturalWidth)); fd.append("height",String(im.naturalHeight));
        status.textContent=form.getAttribute("data-uploading")||"";
        return fetch(form.action,{method:"POST",body:fd,credentials:"same-origin",redirect:"follow"}).then(function(res){ location.href=res.url||location.href; });
      });
      return bantoResize(im,MAX).then(function(r){
        var fd=new FormData();
        // 元が小さく、縮小しても軽くならないなら元ファイルのまま
        var keepOrig=Math.max(im.naturalWidth,im.naturalHeight)<=MAX&&r.main.size>=file.size;
        var mainFile=keepOrig?file:new File([r.main],file.name.replace(/\\.[^.]+$/,"")+".webp",{type:"image/webp"});
        fd.append("file",mainFile); fd.append("thumb",new File([r.thumb],"thumb.webp",{type:"image/webp"}));
        if(VARIANTS) r.variants.forEach(function(v){ fd.append("variant_"+v.size,new File([v.blob],"v"+v.size+".webp",{type:"image/webp"})); });
        fd.append("width",String(keepOrig?im.naturalWidth:r.w)); fd.append("height",String(keepOrig?im.naturalHeight:r.h));
        status.textContent=form.getAttribute("data-uploading")||"";
        return fetch(form.action,{method:"POST",body:fd,credentials:"same-origin",redirect:"follow"}).then(function(res){ location.href=res.url||location.href; });
      });
    }).catch(function(){ status.textContent=""; btn.disabled=false; form.submit(); });
  });
})();`;

products.get("/:shopId/products", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "catalog");
  if (!shop) return c.text(t("shop.not_found"), 404);
  // 名前・スラッグの部分一致と公開の状態で、DB で絞って新しい順に 1 ページ分だけ読む（何十万件でも同じ速さ）
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const state = c.req.query("state") === "published" || c.req.query("state") === "draft" ? c.req.query("state")! : "";
  const after = readAfter(c.req.query("after"));
  if (after === null) return c.text(t("error.generic"), 400);
  const where: Filter[] = [];
  if (state) where.push({ col: "published", op: "eq", value: state === "published" });
  if (after) where.push(olderThan(after));
  const columns = "id,slug,name,published,created_at";
  // 部分一致は RLS の外の検索の関数で（0059。インデックスが効く）
  const page = splitPage(q ? await searchRows<ProductRow>(c, { kind: "products", shopId, q, filters: state ? { state } : {}, ...(after ? { after } : {}), limit: ADMIN_PAGE_SIZE + 1, columns }) : (await db.from<ProductRow>("products").select(columns, { eq: { shop_id: shopId }, where, order: "created_at.desc,id.desc", limit: ADMIN_PAGE_SIZE + 1 })), (p) => p.created_at);
  const rows = page.rows;
  const filtered = Boolean(q || state || after);
  const listBase = `/admin/shops/${shopId}/products${q || state ? `?${new URLSearchParams({ ...(q ? { q } : {}), ...(state ? { state } : {}) }).toString()}` : ""}`;
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("product.list")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("product.list") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "products" }}>
      <PageHead title={t("product.list")}>
        <a class="btn secondary" href={`/admin/shops/${shop.id}/categories`}>
          {t("category.title")}
        </a>
        <a class="btn" href={`/admin/shops/${shop.id}/products/new`}>
          {t("product.new")}
        </a>
      </PageHead>
      <Flash flash={flash(c.req.query("flash"))} />
      {rows.length > 0 || filtered ? (
        <form method="get" class="toolbar">
          <input type="search" name="q" value={c.req.query("q") ?? ""} placeholder={t("product.search")} aria-label={t("product.search")} />
          <select name="state" aria-label={t("product.state")}>
            <option value="">{t("product.state_all")}</option>
            <option value="published" selected={state === "published"}>
              {t("dashboard.published")}
            </option>
            <option value="draft" selected={state === "draft"}>
              {t("dashboard.unpublished")}
            </option>
          </select>
          <button type="submit" class="secondary small">
            {t("order.search")}
          </button>
        </form>
      ) : null}
      {rows.length === 0 && !filtered ? (
        <div class="empty">
          {t("product.none")}{" "}
          <a href={`/admin/shops/${shop.id}/products/new`}>{t("product.new")}</a>
        </div>
      ) : rows.length === 0 ? (
        <div class="empty">{t("product.no_match")}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("product.name")}</th>
              <th>slug</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr>
                <td>
                  <a href={`/admin/shops/${shop.id}/products/${p.id}`}>{p.name}</a>
                </td>
                <td>
                  <code>{p.slug}</code>
                </td>
                <td>
                  <span class={p.published ? "status on" : "status"}>{p.published ? t("dashboard.published") : t("dashboard.unpublished")}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Pager base={listBase} next={page.next} paged={Boolean(after)} />
    </AdminLayout>,
  );
});

// ---------- 作成 ----------
interface CatalogContext {
  categories: CategoryRow[];
  fields: ProductField[];
  /** 会員限定にするときに選べる会員の条件（同梱モジュール audiences が ON で 0098 が当たっていれば。表示用の条件は除く） */
  audiences?: { id: string; name: string }[];
}

async function catalogContext(c: AdminContext, shop: ShopRow): Promise<CatalogContext> {
  const [categories, audiences] = await Promise.all([loadCategories(owner(c).db, shop.id), productAudiences(c, shop)]);
  return { categories, fields: productFields(shop.settings), ...(audiences ? { audiences } : {}) };
}

/** 会員限定の商品（0098）で選べる会員の条件。モジュールが OFF なら null（欄を出さない） */
async function productAudiences(c: AdminContext, shop: ShopRow): Promise<{ id: string; name: string }[] | null> {
  if (!moduleEnabled(shop.settings, AUDIENCES_MODULE)) return null;
  const rows = await owner(c)
    .db.from<{ id: string; name: string; condition: unknown }>("audiences")
    .select("id,name,condition", { eq: { shop_id: shop.id }, order: "name.asc", limit: 200 })
    .catch(() => []);
  return rows.filter((r) => !audienceDisplayOnly(r.condition)).map((r) => ({ id: r.id, name: r.name }));
}

/** 会員限定の欄（条件を選ぶと扱いの欄が効く。条件を「だれでも」にすると扱いは使わない） */
function AudienceFields(props: { product?: ProductRow; audiences: { id: string; name: string }[]; shopId: string }) {
  const p = props.product;
  const cur = p?.audience_id ?? "";
  const mode = p?.audience_mode ?? "hide";
  return (
    <section class="card">
      <h2>{t("product.audience_section")}</h2>
      <input type="hidden" name="audience_present" value="1" />
      <label for="audience_id">{t("product.audience")}</label>
      <select id="audience_id" name="audience_id">
        <option value="">{t("product.audience_anyone")}</option>
        {props.audiences.map((a) => (
          <option value={a.id} selected={cur === a.id}>
            {a.name}
          </option>
        ))}
      </select>
      {props.audiences.length === 0 ? (
        <p class="muted">
          {t("product.audience_none")} <a href={`/admin/shops/${props.shopId}/modules/audiences`}>{t("aud.title")}</a>
        </p>
      ) : null}
      <p>
        <label style="display:block">
          <input type="radio" name="audience_mode" value="hide" checked={mode === "hide"} /> {t("product.audience_mode_hide")}
        </label>
        <label style="display:block;margin-left:1.5rem">
          <input type="checkbox" name="audience_hide" value="on" checked={p?.audience_hide === true} /> {t("product.audience_hide")}
        </label>
        <label style="display:block">
          <input type="radio" name="audience_mode" value="buy" checked={mode === "buy"} /> {t("product.audience_mode_buy")}
        </label>
      </p>
      <p class="muted">{t("product.audience_hint")}</p>
    </section>
  );
}

function ProductForm(props: { action: string; product?: ProductRow; catalog: CatalogContext }) {
  const p = props.product;
  const { categories, fields } = props.catalog;
  const attrs = p?.attributes ?? {};
  return (
    <form method="post" action={props.action}>
      <section class="card">
      <h2>{t("product.section_basic")}</h2>
      <label for="name">{t("product.name")}</label>
      <input id="name" type="text" name="name" value={p?.name ?? ""} required maxlength={200} />
      <label for="slug">{t("product.slug")}</label>
      <input id="slug" type="text" name="slug" value={p?.slug ?? ""} required pattern="[a-z0-9][a-z0-9-]{0,62}" />
      <label for="description">{t("product.description")}</label>
      <textarea id="description" name="description" rows={8} style="width:100%;max-width:40rem">
        {p?.description ?? ""}
      </textarea>
      </section>
      <section class="card">
      <h2>{t("product.section_organize")}</h2>
      <div>
          <label for="category_id">{t("product.category")}</label>
          <select id="category_id" name="category_id">
            <option value="">{t("category.uncategorized")}</option>
            {categoryOptions(categories).map((o) => (
              <option value={o.id} selected={o.id === p?.category_id}>
                {o.label}
              </option>
            ))}
          </select>
          {categories.length > 1 ? (
            <fieldset>
              <legend>{t("product.extra_categories")}</legend>
              <div style="display:flex;flex-wrap:wrap;gap:.25rem 1rem">
                {categoryOptions(categories).map((o) => (
                  <label style="white-space:nowrap">
                    <input type="checkbox" name={`xcat_${o.id}`} checked={(p?.extra_category_ids ?? []).includes(o.id)} /> {o.label.trim()}
                  </label>
                ))}
              </div>
              <p class="muted">{t("product.extra_categories_hint")}</p>
            </fieldset>
          ) : null}
          <label for="brand">{t("product.brand")}</label>
          <input id="brand" type="text" name="brand" value={p?.brand ?? ""} maxlength={100} />
        </div>
      <label for="tax_class">{t("tax.class")}</label>
      <select id="tax_class" name="tax_class">
        {TAX_CLASSES.map((cls) => (
          <option value={cls} selected={taxClassOf(p ?? {}) === cls}>
            {t(`tax.class_${cls}`)}
          </option>
        ))}
      </select>
      <label for="tags">{t("product.tags")}</label>
      <input id="tags" type="text" name="tags" value={(p?.tags ?? []).join(", ")} placeholder={t("product.tags_placeholder")} style="width:100%;max-width:40rem" />
      <p class="muted">{t("product.tags_hint")}</p>
      </section>
      {props.catalog.audiences ? <AudienceFields product={p} audiences={props.catalog.audiences} shopId={p?.shop_id ?? props.action.split("/")[3] ?? ""} /> : null}
      {fields.length > 0 ? (
        <section class="card">
          <h2>{t("product.fields")}</h2>
          {fields.map((f) => {
            const id = `attr_${f.key}`;
            const v = attrs[f.key] === undefined ? "" : String(attrs[f.key]);
            return (
              <div>
                <label for={id}>
                  {f.label}
                  {f.public ? "" : ` (${t("fields.private")})`}
                </label>
                {f.type === "textarea" ? (
                  <textarea id={id} name={id} rows={3} maxlength={500} style="width:100%;max-width:40rem">
                    {v}
                  </textarea>
                ) : f.type === "select" ? (
                  <select id={id} name={id}>
                    <option value="">---</option>
                    {(f.options ?? []).map((o) => (
                      <option value={o} selected={o === v}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : f.type === "image" ? (
                  <FieldImageInput id={id} name={id} value={v} upload={`/admin/shops/${props.action.split("/")[3] ?? ""}/products/field-image`} />
                ) : (
                  <input id={id} type={f.type === "number" ? "number" : f.type === "url" ? "url" : "text"} name={id} value={v} step={f.type === "number" ? "any" : undefined} maxlength={f.type === "number" ? undefined : 200} />
                )}
              </div>
            );
          })}
          {fields.some((f) => f.type === "image") ? <script dangerouslySetInnerHTML={{ __html: FIELD_IMAGE_SCRIPT }} /> : null}
        </section>
      ) : null}
      <div class="savebar">
        <label>
          <input type="checkbox" name="published" value="on" checked={p?.published ?? false} /> {t("product.published")}
        </label>
        <button type="submit">{t("product.save")}</button>
      </div>
    </form>
  );
}

products.get("/:shopId/products/new", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shop = await loadShop(c, param(c, "shopId"), "catalog");
  if (!shop) return c.text(t("shop.not_found"), 404);
  return c.html(
    <AdminLayout title={t("product.new")} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("product.list"), href: `/admin/shops/${shop.id}/products` }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "products" }}>
      <PageHead title={t("product.new")} />
      <Flash flash={flash(c.req.query("flash"))} />
      <ProductForm action={`/admin/shops/${shop.id}/products/new`} catalog={await catalogContext(c, shop)} />
    </AdminLayout>,
  );
});

function productValues(f: Record<string, string>, fields: ProductField[], mediaBase?: string): Partial<ProductRow> | "invalid_slug" {
  const slug = (f.slug ?? "").trim();
  if (!SLUG_RE.test(slug)) return "invalid_slug";
  const description = (f.description ?? "").trim();
  const brand = (f.brand ?? "").trim().slice(0, 100);
  const attrInput: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (k.startsWith("attr_")) attrInput[k.slice(5)] = v;
  return {
    name: (f.name ?? "").trim().slice(0, 200),
    slug,
    description: description === "" ? null : description,
    tags: normalizeTags(f.tags ?? ""),
    category_id: f.category_id || null,
    // 追加カテゴリー（0042）。主カテゴリーと同じもの・重複はトリガーが外す。ほかのショップのカテゴリーは弾く（category_not_found）
    extra_category_ids: Object.keys(f).filter((k) => k.startsWith("xcat_") && f[k] === "on").map((k) => k.slice(5)).slice(0, 20),
    brand: brand || null,
    attributes: cleanAttributes(fields, attrInput, mediaBase),
    ...(isTaxClass(f.tax_class) ? { tax_class: f.tax_class } : {}),
    // 会員限定（0098）: 欄があったときだけ書く（欄の無い画面・当たる前の DB では列に触れない）。
    // 「存在も隠す」に印を付けたら、扱いを選び忘れていても「見せない」として扱う（入れたものを捨てない）
    ...(f.audience_present === "1"
      ? {
          audience_id: f.audience_id || null,
          audience_mode: f.audience_hide === "on" || f.audience_mode !== "buy" ? ("hide" as const) : ("buy" as const),
          audience_hide: f.audience_hide === "on",
        }
      : {}),
    published: f.published === "on",
  };
}

products.post("/:shopId/products/new", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "catalog");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const values = productValues(await formFields(c), productFields(shop.settings), mediaBaseUrl(c));
  if (values === "invalid_slug") return c.redirect(`/admin/shops/${shopId}/products/new?flash=invalid_slug`);
  if (!values.name) return c.redirect(`/admin/shops/${shopId}/products/new?flash=generic`);
  try {
    const inserted = await db.from<ProductRow>("products").insert({ ...values, shop_id: shopId });
    return c.redirect(`/admin/shops/${shopId}/products/${inserted[0]!.id}?flash=saved`);
  } catch (e) {
    if (e instanceof DbError && e.status === 409) return c.redirect(`/admin/shops/${shopId}/products/new?flash=slug_taken`);
    if (e instanceof DbError && planLimitOf(e)) return c.redirect(`/admin/shops/${shopId}/products/new?flash=plan_limit`);
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}/products/new?flash=generic`);
    throw e;
  }
});

// ---------- 編集（商品 + SKU + 画像） ----------
interface SkuWithStock extends SkuRow {
  available: number;
}

async function loadProduct(c: AdminContext, shopId: string, productId: string) {
  const { db } = owner(c);
  const shop = await loadShop(c, shopId, "catalog");
  if (!shop) return null;
  const product = await db.from<ProductRow>("products").selectOne("*", { eq: { id: productId, shop_id: shopId } });
  if (!product) return null;
  // 在庫はこの商品の SKU の分だけ（ショップ全体を読むと 1,000 行で欠ける）
  const [[skus, inventory], images] = await Promise.all([
    db
      .from<SkuRow>("skus")
      .select("*", { eq: { product_id: productId }, order: "created_at.asc" })
      .then(async (skus) => [skus, await selectIn<InventoryRow>(db, "inventory", "sku_id,available", shopId, "sku_id", skus.map((k) => k.id))] as const),
    db.from<ProductImageRow>("product_images").select("*", { eq: { product_id: productId }, order: "sort_order.asc" }),
  ]);
  const stock = new Map(inventory.map((i) => [i.sku_id, i.available]));
  const skusWithStock: SkuWithStock[] = skus.map((s) => ({ ...s, available: stock.get(s.id) ?? 0 }));
  return { shop, product, skus: skusWithStock, images };
}

/** 商品のカスタム項目の画像を置く（項目 catalog。返った URL を欄に入れて、商品の保存で書く）。/:productId より先に置く */
products.post("/:shopId/products/field-image", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  if (!(await loadShop(c, shopId, "catalog"))) return c.json({ error: t("shop.not_found") }, 404);
  return fieldImageUpload(c, shopId);
});

products.get("/:shopId/products/:productId", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const productId = param(c, "productId");
  const data = await loadProduct(c, shopId, productId);
  if (!data) return c.text(t("product.not_found"), 404);
  const { shop, product, skus, images } = data;
  // SKU の選択肢の表示名（0094。鍵は key で置かれる）
  const names = optionNamesOf(shop.option_names);
  const base = `/admin/shops/${shopId}/products/${productId}`;
  const mediaBase = mediaBaseUrl(c);
  const catalog = await catalogContext(c, shop);
  const variantsReady = true;
  const pluginMode = imagePluginMode(shop);
  // SKU ごとの画像（0063）: SKU の項目（カラー・サイズなど）から、画像ごとに結ぶ先を選ぶ欄
  const optionChoices = skuOptionChoices(skus);
  // SKU を分ける軸（0065）。axes は null（決めていない）・[]（品番だけ）・軸
  const axes = optionAxesOf(product.option_axes);
  const upper = resolveOptionAxes(catalog.categories, product.category_id, shop.option_axes);
  const matrixMsg = matrixFlash((k) => c.req.query(k));

  return c.html(
    <AdminLayout title={`${product.name} · ${t("product.edit")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("product.list"), href: `/admin/shops/${shop.id}/products` }, { label: product.name }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "products" }}>
      <PageHead
        title={
          <>
            {product.name} <span class={`status ${product.published ? "on" : "off"}`}>{product.published ? t("dashboard.published") : t("dashboard.unpublished")}</span>
          </>
        }
        sub={t("product.edit")}
      >
        <a class="btn secondary" href="#skus">
          {t("sku.list")}
        </a>
        <a class="btn secondary" href="#images">
          {t("image.list")}
        </a>
        {sizeChartHref(shop, { product: product.id }) ? (
          <a class="btn secondary" href={sizeChartHref(shop, { product: product.id })!}>
            {t("sizechart.link")}
          </a>
        ) : null}
      </PageHead>
      <Flash flash={flash(c.req.query("flash"))} />
      {matrixMsg ? <p class="notice">{matrixMsg}</p> : null}
      {product.published && !shop.published ? <p class="notice">{t("product.unpublished_shop")}</p> : null}
      <ProductForm action={base} product={product} catalog={catalog} />

      {upper ? (
        <section class="card" id="option-axes">
          <h2>{t("axes.title")}</h2>
          <p>
            {t("axes.current")}: <strong>{axesText(product.option_axes ?? null, names)}</strong>
            {product.option_axes_custom ? <span class="muted"> （{t("axes.custom")}）</span> : null}
          </p>
          <p class="muted">
            {tf("axes.upper", { label: axesText(upper.axes, names), from: upper.from ? (upper.from.kind === "category" ? tf("axes.from_category", { name: upper.from.name }) : t("axes.from_shop")) : t("axes.from_none") })}
          </p>
          <details>
            <summary>{t("product.edit")}</summary>
            <form method="post" action={`${base}/option-axes`}>
              <AxesEditor name={product.name} axes={product.option_axes ?? null} modes={["none", "only_code", "axes"]} names={names} />
              <button type="submit" class="secondary">
                {t("shop.save")}
              </button>
            </form>
          </details>
          <p>
            {JSON.stringify(upper.axes) !== JSON.stringify(axes) || product.option_axes_custom ? (
              <form method="post" action={`${base}/option-axes/reset`} style="display:inline">
                <button type="submit" class="secondary small">
                  {t("axes.reset")}
                </button>
              </form>
            ) : null}{" "}
            {skus.length > 0 ? (
              <form method="post" action={`${base}/option-axes/infer`} style="display:inline">
                <button type="submit" class="secondary small">
                  {t("axes.infer")}
                </button>
              </form>
            ) : null}
          </p>
        </section>
      ) : null}

      <h2 id="skus">{t("sku.list")}</h2>
      {skus.length === 0 ? (
        <div class="empty">
          <p>{t("sku.none")}</p>
        </div>
      ) : null}
      {skus.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t("sku.code")}</th>
              <th>{t("sku.name")}</th>
              <th>{t("sku.price")}</th>
              <th>{t("sku.stock")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {skus.map((s) => (
              <tr>
                <td>
                  <code>{s.code}</code>
                  {s.gtin ? <div class="muted">JAN {s.gtin}</div> : null}
                </td>
                <td>
                  {s.name ?? ""}
                  {Object.keys(s.options ?? {}).length > 0 ? <div class="muted">{formatOptions(s.options ?? {}, ", ", names)}</div> : null}
                </td>
                <td>
                  ¥{s.price_jpy.toLocaleString("ja-JP")}
                  {s.compare_at_price_jpy ? <div class="muted">{t("sku.compare_at")}: ¥{s.compare_at_price_jpy.toLocaleString("ja-JP")}</div> : null}
                  <details>
                    <summary>{t("sku.edit")}</summary>
                    <form method="post" action={`${base}/skus/${s.id}`}>
                      <SkuFields sku={s} axes={axes} names={names} />
                      <button type="submit">{t("shop.save")}</button>
                    </form>
                  </details>
                </td>
                <td>
                  <form method="post" action={`${base}/skus/${s.id}/stock`} style="display:inline">
                    <input type="number" name="available" value={String(s.available)} min={0} style="width:5rem" />{" "}
                    <button type="submit" class="secondary small">
                      {t("sku.update_stock")}
                    </button>
                  </form>
                </td>
                <td>
                  <form method="post" action={`${base}/skus/${s.id}/delete`} style="display:inline">
                    <button type="submit" class="small">
                      {t("sku.delete")}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <form method="post" action={`${base}/skus`} class="card">
        <h3>{t("sku.add")}</h3>
        <label for="code">{t("sku.code")}</label>
        <input id="code" type="text" name="code" required maxlength={100} />
        <label for="sku_name">{t("sku.name")}</label>
        <input id="sku_name" type="text" name="name" maxlength={200} />
        <label for="price_jpy">{t("sku.price")}</label>
        <input id="price_jpy" type="number" name="price_jpy" min={0} step={1} required />
        <SkuExtraFields axes={axes} names={names} />
        <label for="available">{t("sku.stock")}</label>
        <input id="available" type="number" name="available" min={0} step={1} value="0" />
        <p>
          <button type="submit">{t("sku.add")}</button>
        </p>
      </form>
      {axes && axes.length > 0 ? <MatrixForm action={`${base}/sku-matrix`} axes={axes} slug={product.slug} names={names} /> : null}
      <ChipsScript />

      <h2 id="images">{t("image.list")}</h2>
      {images.length === 0 ? (
        <div class="empty">
          <p>{t("image.none")}</p>
        </div>
      ) : null}
      {optionChoices.length > 0 ? <p class="muted">{t("image.options_hint")}</p> : null}
      {images.length > 0 ? (
        <table>
          <tbody>
            {images.map((img) => (
              <tr>
                <td>
                  <img src={imageUrl(mediaBase, img.thumb_key ?? img.storage_key)} alt="" style="max-width:8rem;max-height:8rem" loading="lazy" />
                  {img.width && img.height ? (
                    <div class="muted">
                      {img.width}×{img.height}
                      {img.thumb_key ? "" : ` ${t("image.no_thumb")}`}
                    </div>
                  ) : img.thumb_key ? null : (
                    <div class="muted">{t("image.no_thumb")}</div>
                  )}
                </td>
                <td>
                  <form method="post" action={`${base}/images/${img.id}/sort`} style="display:inline">
                    {t("image.sort")} <input type="number" name="sort_order" value={String(img.sort_order)} style="width:4rem" />{" "}
                    <button type="submit" class="secondary small">
                      {t("product.save")}
                    </button>
                  </form>
                </td>
                {optionChoices.length > 0 ? (
                  <td>
                    <form method="post" action={`${base}/images/${img.id}/options`} style="display:inline">
                      {optionChoices.map((ch) => (
                        <label style="display:inline-block;margin-right:.5rem">
                          {optionLabel(names, ch.key)}{" "}
                          <select name={`options.${ch.key}`}>
                            <option value="">{t("image.options_any")}</option>
                            {ch.values.map((v) => (
                              <option value={v} selected={imageOptionsOf(img.options)[ch.key] === v}>
                                {v}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))}
                      <button type="submit" class="secondary small">
                        {t("product.save")}
                      </button>
                    </form>
                  </td>
                ) : null}
                <td>
                  <form method="post" action={`${base}/images/${img.id}/delete`} style="display:inline">
                    <button type="submit" class="small">
                      {t("image.delete")}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <form method="post" action={`${base}/images`} enctype="multipart/form-data" id="image-form" class="card" data-max={String(imageMaxWidth(shop.settings))} data-variants={variantsReady ? "1" : "0"} data-processing={pluginMode ? "plugin" : "browser"} data-resizing={t("image.resizing")} data-uploading={t("image.uploading")}>
        <label for="file">{t("image.file")}</label>
        <input id="file" type="file" name="file" accept="image/*" required />
        <p class="muted">{pluginMode ? t("image.plugin_note") : tf("image.resize_note", { max: imageMaxWidth(shop.settings) })}</p>
        <p>
          <button type="submit">{t("image.upload")}</button> <span id="image-status" aria-live="polite"></span>
        </p>
      </form>
      <script dangerouslySetInnerHTML={{ __html: IMAGE_RESIZE_SCRIPT }} />

      <section class="card danger-zone">
        <h2>{t("product.delete")}</h2>
        <form method="post" action={`${base}/delete`} onsubmit={`return confirm(${JSON.stringify(t("product.delete_confirm"))})`}>
          <button type="submit">{t("product.delete")}</button>
        </form>
      </section>
    </AdminLayout>,
  );
});

products.post("/:shopId/products/:productId", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const productId = param(c, "productId");
  const base = `/admin/shops/${shopId}/products/${productId}`;
  const shop = await loadShop(c, shopId, "catalog");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const values = productValues(await formFields(c), productFields(shop.settings), mediaBaseUrl(c));
  if (values === "invalid_slug") return c.redirect(`${base}?flash=invalid_slug`);
  if (!values.name) return c.redirect(`${base}?flash=generic`);
  try {
    const rows = await db.from<ProductRow>("products").update(values, { id: productId, shop_id: shopId });
    if (rows.length === 0) return c.text(t("product.not_found"), 404);
    const p = rows[0]!;
    await db.rpc("enqueue_hook", { p_shop_id: shopId, p_event: "product.updated", p_payload: { product_id: p.id, shop_id: shopId, slug: p.slug, name: p.name, published: p.published } });
  } catch (e) {
    if (e instanceof DbError && e.status === 409) return c.redirect(`${base}?flash=slug_taken`);
    if (e instanceof DbError && /audience_display_only/.test(e.message)) return c.redirect(`${base}?flash=audience_display_only`);
    if (e instanceof DbError) return c.redirect(`${base}?flash=generic`);
    throw e;
  }
  return c.redirect(`${base}?flash=saved`);
});

products.post("/:shopId/products/:productId/delete", requireOwner, async (c: AdminContext) => {
  const { db, } = owner(c);
  const shopId = param(c, "shopId");
  const productId = param(c, "productId");
  const data = await loadProduct(c, shopId, productId);
  if (!data) return c.text(t("product.not_found"), 404);
  // 画像はストレージからも消す（DB 行は on delete cascade）
  const storage = c.get("adapters").storage;
  await Promise.all(data.images.flatMap((img) => imageKeys(img).map((k) => storage.delete(k))));
  await db.from("products").delete({ id: productId, shop_id: shopId });
  return c.redirect(`/admin/shops/${shopId}/products?flash=saved`);
});

// ---------- SKU ----------
/** 選択肢の入力（1 行に 1 つ「サイズ=M」）→ オブジェクト。5 個まで、キー 40 文字・値 60 文字。区切りは改行だけ（値にカンマを入れられるように） */
export function parseOptions(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of input.split(/\r?\n/)) {
    const [k, ...rest] = part.split(/[=＝:：]/);
    const key = (k ?? "").trim().slice(0, 40);
    const value = rest.join("=").trim().slice(0, 60);
    if (key && value && Object.keys(out).length < 5) out[key] = value;
  }
  return out;
}

function formatOptions(options: Record<string, string | number>, separator = ", ", names: OptionNames = {}): string {
  return Object.entries(options)
    .map(([k, v]) => `${optionLabel(names, k)}=${v}`)
    .join(separator);
}

/** SKU の選択肢の欄。軸を決めた商品は軸ごとの欄（値の候補つき）、品番だけの商品は欄なし、決めていなければ自由入力（0065） */
function SkuOptionFields(props: { sku?: SkuRow; axes: OptionAxes | null | undefined; suffix: string; names?: OptionNames }) {
  const { sku: s, axes, suffix } = props;
  const names = props.names ?? {};
  if (axes && axes.length === 0) return <input type="hidden" name="options_mode" value="none" />;
  if (axes) {
    return (
      <fieldset>
        <legend>{t("axes.sku_options")}</legend>
        <input type="hidden" name="options_mode" value="axes" />
        {axes.map((a, i) => (
          <span style="display:inline-block;margin-right:.75rem">
            <label for={`opt${suffix}_${i}`}>{optionLabel(names, a.key)}</label>
            <input id={`opt${suffix}_${i}`} type="text" name={`opt.${i}`} value={s ? String((s.options ?? {})[a.key] ?? "") : ""} required maxlength={60} list={`axis${suffix}_${i}`} style="width:9rem" />
            <datalist id={`axis${suffix}_${i}`}>
              {(a.values ?? []).map((v) => (
                <option value={v} />
              ))}
            </datalist>
          </span>
        ))}
      </fieldset>
    );
  }
  return (
    <>
      <label for={`options${suffix}`}>{t("sku.options")}</label>
      <textarea id={`options${suffix}`} name="options" rows={3} placeholder={t("sku.options_placeholder")}>
        {s ? formatOptions(s.options ?? {}, "\n", names) : ""}
      </textarea>
    </>
  );
}

function SkuExtraFields(props: { sku?: SkuRow; axes?: OptionAxes | null; names?: OptionNames }) {
  const s = props.sku;
  const suffix = s ? `_${s.id}` : "";
  return (
    <div>
      <SkuOptionFields sku={s} axes={props.axes} suffix={suffix} names={props.names} />
      <label for={`compare_at${suffix}`}>{t("sku.compare_at")}</label>
      <input id={`compare_at${suffix}`} type="number" name="compare_at_price_jpy" min={0} step={1} value={s?.compare_at_price_jpy ? String(s.compare_at_price_jpy) : ""} />
      <label for={`gtin${suffix}`}>{t("sku.gtin")}</label>
      <input id={`gtin${suffix}`} type="text" name="gtin" value={s?.gtin ?? ""} inputmode="numeric" pattern="[0-9]{8}|[0-9]{12,14}" />
    </div>
  );
}

function SkuFields(props: { sku: SkuRow; axes?: OptionAxes | null; names?: OptionNames }) {
  const s = props.sku;
  return (
    <div>
      <label for={`name_${s.id}`}>{t("sku.name")}</label>
      <input id={`name_${s.id}`} type="text" name="name" value={s.name ?? ""} maxlength={200} />
      <label for={`price_${s.id}`}>{t("sku.price")}</label>
      <input id={`price_${s.id}`} type="number" name="price_jpy" min={0} step={1} required value={String(s.price_jpy)} />
      <SkuExtraFields sku={s} axes={props.axes} names={props.names} />
    </div>
  );
}

/** 組み合わせの一括作成（0065）。値の候補にチェック・ほかの値を足す → 組み合わせの数だけ SKU */
function MatrixForm(props: { action: string; axes: OptionAxes; slug: string; names?: OptionNames }) {
  const names = props.names ?? {};
  const pattern = [props.slug.toUpperCase(), ...props.axes.map((a) => `{${optionLabel(names, a.key)}}`)].join("-");
  return (
    <form method="post" action={props.action} class="card">
      <h3>{t("axes.matrix")}</h3>
      <p class="muted">{tf("axes.matrix_hint", { max: MAX_COMBINATIONS })}</p>
      {props.axes.map((a, i) => (
        <fieldset>
          <legend>{optionLabel(names, a.key)}</legend>
          {(a.values ?? []).map((v) => (
            <label style="display:inline-block;margin-right:.75rem">
              <input type="checkbox" name={`mx.${i}`} value={v} checked /> {v}
            </label>
          ))}
          <label for={`mx_other_${i}`}>{t("axes.matrix_other")}</label>
          <ChipsInput id={`mx_other_${i}`} name={`mx_other.${i}`} values={[]} label={`${optionLabel(names, a.key)} ${t("axes.matrix_other")}`} />
        </fieldset>
      ))}
      <label for="mx_code">{t("axes.matrix_code")}</label>
      <input id="mx_code" type="text" name="code_pattern" value={pattern} required maxlength={100} />
      <label for="mx_price">{t("sku.price")}</label>
      <input id="mx_price" type="number" name="price_jpy" min={0} step={1} required />
      <label for="mx_stock">{t("sku.stock")}</label>
      <input id="mx_stock" type="number" name="available" min={0} step={1} value="0" />
      <p>
        <button type="submit">{t("axes.matrix")}</button>
      </p>
    </form>
  );
}

/** SKU の拡張欄（0008）。フォームに欄が出ていたときだけ値を返す。不正なら "sku_invalid" */
function skuExtraValues(f: Record<string, string>, price: number, axes: OptionAxes | null = null): Partial<SkuRow> | "sku_invalid" {
  if (f.options === undefined && f.options_mode === undefined && f.gtin === undefined && f.compare_at_price_jpy === undefined) return {};
  const gtin = (f.gtin ?? "").trim();
  if (gtin && !/^([0-9]{8}|[0-9]{12,14})$/.test(gtin)) return "sku_invalid";
  const compareRaw = (f.compare_at_price_jpy ?? "").trim();
  const compare = compareRaw === "" ? null : Number.parseInt(compareRaw, 10);
  if (compare !== null && (!Number.isInteger(compare) || compare <= price)) return "sku_invalid";
  return { options: skuOptionsFromForm(f, axes), gtin: gtin || null, compare_at_price_jpy: compare };
}

/** 選択肢の欄 → options。軸ごとの欄（opt.0 …）なら軸の鍵で、品番だけなら空、自由入力なら「サイズ=M, 色=黒」 */
function skuOptionsFromForm(f: Record<string, string>, axes: OptionAxes | null): Record<string, string> {
  if (f.options_mode === "none") return {};
  if (f.options_mode === "axes" && axes) {
    const out: Record<string, string> = {};
    axes.forEach((a, i) => {
      const v = (f[`opt.${i}`] ?? "").trim().slice(0, 60);
      if (v) out[a.key] = v;
    });
    return out;
  }
  return parseOptions(f.options ?? "");
}

/** 商品の軸（SKU を書くときの欄の読み方に使う） */
async function productAxes(c: AdminContext, shopId: string, productId: string): Promise<OptionAxes | null> {
  const { db } = owner(c);
  const p = await db.from<ProductRow>("products").selectOne("option_axes", { eq: { id: productId, shop_id: shopId } });
  return p ? optionAxesOf(p.option_axes) : null;
}

products.post("/:shopId/products/:productId/skus", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const productId = param(c, "productId");
  const base = `/admin/shops/${shopId}/products/${productId}`;
  const f = await formFields(c);
  const code = (f.code ?? "").trim();
  const price = Number.parseInt(f.price_jpy ?? "", 10);
  const available = Number.parseInt(f.available ?? "0", 10);
  if (!code || code.length > 100 || !Number.isInteger(price) || price < 0 || !Number.isInteger(available) || available < 0) {
    return c.redirect(`${base}?flash=sku_invalid`);
  }
  const name = (f.name ?? "").trim();
  const extra = skuExtraValues(f, price, await productAxes(c, shopId, productId));
  if (extra === "sku_invalid") return c.redirect(`${base}?flash=sku_invalid`);
  try {
    const [sku] = await db.from<SkuRow>("skus").insert({ shop_id: shopId, product_id: productId, code, name: name || null, price_jpy: price, ...extra });
    if (available > 0) await db.rpc("set_stock", { p_sku_id: sku!.id, p_available: available });
  } catch (e) {
    const axesError = axesErrorCode(e);
    if (axesError) return c.redirect(`${base}?flash=${axesError}#skus`);
    if (e instanceof DbError && e.status === 409) return c.redirect(`${base}?flash=sku_taken`);
    if (e instanceof DbError) return c.redirect(`${base}?flash=generic`);
    throw e;
  }
  return c.redirect(`${base}?flash=saved`);
});

/** SKU の名前・価格・選択肢・通常価格・JAN を更新する（在庫は /stock、品番は変えない） */
products.post("/:shopId/products/:productId/skus/:skuId", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const { shopId, productId, skuId } = params(c);
  const base = `/admin/shops/${shopId}/products/${productId}`;
  const f = await formFields(c);
  const price = Number.parseInt(f.price_jpy ?? "", 10);
  if (!Number.isInteger(price) || price < 0) return c.redirect(`${base}?flash=sku_invalid`);
  const extra = skuExtraValues(f, price, await productAxes(c, shopId, productId));
  if (extra === "sku_invalid") return c.redirect(`${base}?flash=sku_invalid`);
  const name = (f.name ?? "").trim().slice(0, 200);
  try {
    await db.from<SkuRow>("skus").update({ name: name || null, price_jpy: price, ...extra }, { id: skuId, product_id: productId, shop_id: shopId });
  } catch (e) {
    const axesError = axesErrorCode(e);
    if (axesError) return c.redirect(`${base}?flash=${axesError}#skus`);
    if (e instanceof DbError) return c.redirect(`${base}?flash=sku_invalid`);
    throw e;
  }
  return c.redirect(`${base}?flash=saved`);
});

// ---------- SKU を分ける軸（0065） ----------
/** この商品で軸を決める（上書きした扱い。一括で当てるときに飛ばす） */
products.post("/:shopId/products/:productId/option-axes", requireOwner, async (c: AdminContext) => {
  const { shopId, productId } = params(c);
  const base = `/admin/shops/${shopId}/products/${productId}`;
  if (!(await loadShop(c, shopId, "catalog"))) return c.text(t("shop.not_found"), 404);
  const axes = optionAxesFromForm(await formFields(c));
  if (axes === "invalid") return c.redirect(`${base}?flash=axes_invalid#option-axes`);
  return saveAxes(c, base, shopId, productId, axes, true);
});

/** 上の段（主カテゴリー → ショップ）の軸に戻す */
products.post("/:shopId/products/:productId/option-axes/reset", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const { shopId, productId } = params(c);
  const base = `/admin/shops/${shopId}/products/${productId}`;
  const shop = await loadShop(c, shopId, "catalog");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const product = await db.from<ProductRow>("products").selectOne("category_id", { eq: { id: productId, shop_id: shopId } });
  if (!product) return c.text(t("product.not_found"), 404);
  const upper = resolveOptionAxes(await loadCategories(db, shopId), product.category_id, shop.option_axes);
  return saveAxes(c, base, shopId, productId, upper.axes, false);
});

/** 今の SKU から推す（どの SKU も同じ項目を持つときだけ） */
products.post("/:shopId/products/:productId/option-axes/infer", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const { shopId, productId } = params(c);
  const base = `/admin/shops/${shopId}/products/${productId}`;
  if (!(await loadShop(c, shopId, "catalog"))) return c.text(t("shop.not_found"), 404);
  const skus = await db.from<SkuRow>("skus").select("options", { eq: { product_id: productId, shop_id: shopId } });
  const axes = inferOptionAxes(skus);
  if (!axes) return c.redirect(`${base}?flash=infer_failed#option-axes`);
  return saveAxes(c, base, shopId, productId, axes, true);
});

async function saveAxes(c: AdminContext, base: string, shopId: string, productId: string, axes: OptionAxes | null, custom: boolean) {
  try {
    await owner(c).db.from<ProductRow>("products").update({ option_axes: axes, option_axes_custom: custom && axes !== null }, { id: productId, shop_id: shopId });
  } catch (e) {
    const code = axesErrorCode(e);
    if (code) return c.redirect(`${base}?flash=${code}#option-axes`);
    throw e;
  }
  return c.redirect(`${base}?flash=axes_saved#option-axes`);
}

/** 組み合わせの一括作成。すでにある組み合わせ・品番が重なるものは飛ばす */
products.post("/:shopId/products/:productId/sku-matrix", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const { shopId, productId } = params(c);
  const base = `/admin/shops/${shopId}/products/${productId}`;
  const matrixShop = await loadShop(c, shopId, "catalog");
  if (!matrixShop) return c.text(t("shop.not_found"), 404);
  const axes = await productAxes(c, shopId, productId);
  if (!axes || axes.length === 0) return c.redirect(`${base}?flash=generic`);
  const raw = await c.req.parseBody({ all: true });
  const list = (k: string) => {
    const v = raw[k];
    return (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === "string");
  };
  const one = (k: string) => list(k)[0] ?? "";
  const chosen: Record<string, string[]> = {};
  axes.forEach((a, i) => {
    const vals = [...list(`mx.${i}`).map((v) => v.trim().slice(0, 60)), ...parseAxisValues(one(`mx_other.${i}`))].filter(Boolean);
    chosen[a.key] = [...new Set(vals)];
  });
  const combos = combinations(axes, chosen);
  if (combos === null) return c.redirect(`${base}?flash=matrix_too_many#skus`);
  if (combos.length === 0) return c.redirect(`${base}?flash=matrix_empty#skus`);
  const price = Number.parseInt(one("price_jpy"), 10);
  const available = Number.parseInt(one("available") || "0", 10);
  const pattern = one("code_pattern").trim();
  if (!pattern || !Number.isInteger(price) || price < 0 || !Number.isInteger(available) || available < 0) return c.redirect(`${base}?flash=sku_invalid#skus`);
  const existing = await db.from<SkuRow>("skus").select("code,options", { eq: { product_id: productId, shop_id: shopId } });
  const have = new Set(existing.map((k) => JSON.stringify(Object.fromEntries(Object.entries(k.options ?? {}).map(([kk, vv]) => [kk, String(vv)]).sort()))));
  let created = 0;
  let skipped = 0;
  for (const options of combos) {
    if (have.has(JSON.stringify(Object.entries(options).sort().reduce<Record<string, string>>((o, [k, v]) => ({ ...o, [k]: v }), {})))) {
      skipped++;
      continue;
    }
    try {
      const [sku] = await db.from<SkuRow>("skus").insert({ shop_id: shopId, product_id: productId, code: codeFromPattern(pattern, options, optionNamesOf(matrixShop.option_names)), name: null, price_jpy: price, options });
      if (available > 0) await db.rpc("set_stock", { p_sku_id: sku!.id, p_available: available });
      created++;
    } catch (e) {
      // 品番が重なった・同じ組み合わせ（同時に作られた）は飛ばして続ける
      if (e instanceof DbError && (e.status === 409 || axesErrorCode(e) === "axes_duplicate")) {
        skipped++;
        continue;
      }
      throw e;
    }
  }
  return c.redirect(`${base}?flash=matrix&n=${created}&skip=${skipped}#skus`);
});

products.post("/:shopId/products/:productId/skus/:skuId/stock", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const { shopId, productId, skuId } = params(c);
  const base = `/admin/shops/${shopId}/products/${productId}`;
  const f = await formFields(c);
  const available = Number.parseInt(f.available ?? "", 10);
  if (!Number.isInteger(available) || available < 0) return c.redirect(`${base}?flash=sku_invalid`);
  try {
    await db.rpc("set_stock", { p_sku_id: skuId, p_available: available });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${base}?flash=generic`);
    throw e;
  }
  return c.redirect(`${base}?flash=saved`);
});

products.post("/:shopId/products/:productId/skus/:skuId/delete", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const { shopId, productId, skuId } = params(c);
  await db.from("skus").delete({ id: skuId, product_id: productId, shop_id: shopId });
  return c.redirect(`/admin/shops/${shopId}/products/${productId}?flash=saved`);
});

// ---------- 画像 ----------
/** 外部の変換プラグインに任せるショップか（0092） */
const imagePluginMode = (shop: ShopRow): boolean => imageProcessing(shop.settings) === "plugin";

products.post("/:shopId/products/:productId/images", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const productId = param(c, "productId");
  const base = `/admin/shops/${shopId}/products/${productId}`;
  const data = await loadProduct(c, shopId, productId);
  if (!data) return c.text(t("product.not_found"), 404);

  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.redirect(`${base}?flash=image_type`);
  const ext = imageExtension(file.type);
  if (!ext) return c.redirect(`${base}?flash=image_type`);
  // 任せるショップは元の写真をそのまま受ける（スマホの写真が入る大きさまで）
  const pluginMode = imagePluginMode(data.shop);
  if (file.size > (pluginMode ? ORIGINAL_MAX_BYTES : MAX_IMAGE_BYTES)) return c.redirect(`${base}?flash=image_size`);
  // サムネイルと寸法はブラウザ側のスクリプトが付ける（任意。JS が無い環境では本画像だけ）
  const thumb = body.thumb instanceof File && body.thumb.size > 0 ? body.thumb : null;
  const thumbExt = thumb ? imageExtension(thumb.type) : null;
  if (thumb && (!thumbExt || thumb.size > MAX_THUMB_BYTES)) return c.redirect(`${base}?flash=image_type`);
  const width = imageDimension(typeof body.width === "string" ? body.width : undefined);
  const height = imageDimension(typeof body.height === "string" ? body.height : undefined);

  // 中間の段（0091 が当たってから。本画像の実際の横幅より狭いものだけ）
  const mainBytes = new Uint8Array(await file.arrayBuffer());
  const mainDim = imageSize(mainBytes, file.type);
  const variantsOn = true;
  const variants = variantsOn && !pluginMode ? await readVariantFiles(body, mainDim?.width ?? 0) : [];
  if (variants === null) return c.redirect(`${base}?flash=image_type`);

  const storage = c.get("adapters").storage;
  const key = productImageKey(shopId, productId, ext);
  const tKey = thumb && thumbExt ? thumbKey(key, thumbExt) : null;
  const vKeys = variants.map((v) => variantKey(key, v.size));
  await storage.put(key, mainBytes.slice().buffer, file.type);
  const thumbBytes = thumb ? new Uint8Array(await thumb.arrayBuffer()) : null;
  const thumbWidth = thumbBytes && thumb ? thumbWidthOf(thumbBytes, thumb.type) : null;
  if (thumbBytes && thumb && tKey) await storage.put(tKey, thumbBytes.slice().buffer, thumb.type);
  await Promise.all(variants.map((v, i) => storage.put(vKeys[i]!, v.bytes.slice().buffer, "image/webp")));
  const sortOrder = data.images.reduce((m, i) => Math.max(m, i.sort_order), -1) + 1;
  try {
    await db.from<ProductImageRow>("product_images").insert({
      shop_id: shopId,
      product_id: productId,
      storage_key: key,
      thumb_key: tKey,
      width: width && height ? width : null,
      height: width && height ? height : null,
      sort_order: sortOrder,
      ...(variantsOn ? { variants: variants.map((v) => v.size), thumb_width: thumbWidth } : {}),
    });
  } catch (e) {
    await Promise.all([key, ...(tKey ? [tKey] : []), ...vKeys].map((k) => storage.delete(k)));
    if (e instanceof DbError) return c.redirect(`${base}?flash=generic`);
    throw e;
  }
  return c.redirect(`${base}?flash=saved`);
});

products.post("/:shopId/products/:productId/images/:imageId/sort", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const { shopId, productId, imageId } = params(c);
  const f = await formFields(c);
  const sort = Number.parseInt(f.sort_order ?? "", 10);
  if (Number.isInteger(sort)) {
    await db.from<ProductImageRow>("product_images").update({ sort_order: sort }, { id: imageId, product_id: productId, shop_id: shopId });
  }
  return c.redirect(`/admin/shops/${shopId}/products/${productId}?flash=saved`);
});

/** 画像を SKU の項目に結ぶ（0063）。選べる項目はその商品の SKU にあるものだけ。全部「指定なし」なら商品全体の画像 */
products.post("/:shopId/products/:productId/images/:imageId/options", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const { shopId, productId, imageId } = params(c);
  const f = await formFields(c);
  const skus = await db.from<SkuRow>("skus").select("options", { eq: { product_id: productId, shop_id: shopId } });
  const options = imageOptionsFromForm(f, skuOptionChoices(skus).map((ch) => ch.key));
  try {
    await db.from<ProductImageRow>("product_images").update({ options }, { id: imageId, product_id: productId, shop_id: shopId });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/shops/${shopId}/products/${productId}?flash=generic#images`);
    throw e;
  }
  return c.redirect(`/admin/shops/${shopId}/products/${productId}?flash=saved#images`);
});

products.post("/:shopId/products/:productId/images/:imageId/delete", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const { shopId, productId, imageId } = params(c);
  const img = await db.from<ProductImageRow>("product_images").selectOne("*", { eq: { id: imageId, product_id: productId, shop_id: shopId } });
  if (img) {
    await db.from("product_images").delete({ id: imageId });
    const storage = c.get("adapters").storage;
    await Promise.all(imageKeys(img).map((k) => storage.delete(k)));
  }
  return c.redirect(`/admin/shops/${shopId}/products/${productId}?flash=saved`);
});
