import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { planLimitOf } from "../../plan/limits";
import { ADMIN_PAGE_SIZE, Pager, olderThan, readAfter, searchRows, splitPage } from "./paging";
import { selectIn } from "../../db/select-in";
import type { Filter } from "../../db/client";
import type { CategoryRow, InventoryRow, ProductImageRow, ProductRow, ShopRow, SkuRow } from "../../db/types";
import { MAX_IMAGE_BYTES, MAX_THUMB_BYTES, imageDimension, imageExtension, imageUrl, productImageKey, thumbKey } from "../../media/images";
import { t, tf, type MessageKey } from "../../i18n";
import { AdminLayout, PageHead } from "./layout";
import { SLUG_RE, formFields, mediaBaseUrl, owner, param, params, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";
import { normalizeTags } from "../../products/tags";
import { cleanAttributes, productFields, type ProductField } from "../../products/fields";
import { categoryOptions, loadCategories } from "./categories";
import { TAX_CLASSES, isTaxClass, taxClassOf } from "../../commerce/tax";
import { migrated } from "../../db/migration-state";
import { EXTRA_CATEGORIES_MIGRATION } from "../../products/categories";

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
  };
  const key = map[code];
  if (!key) return null;
  return { kind: code === "saved" ? "ok" : "error", text: t(key) };
}

const Flash = (props: { flash: ReturnType<typeof flash> }) =>
  props.flash ? <p class={props.flash.kind === "ok" ? "notice" : "error"}>{props.flash.text}</p> : null;

// ---------- 一覧 ----------
/**
 * ブラウザ側で縮小してからアップロードする（サーバーでは画像処理をしない: Workers の CPU 制限と可搬性のため）。
 * 本画像は長辺 1600px、サムネイルは長辺 400px の WebP。GIF（アニメーションの可能性）と SVG は触らない。
 * canvas / WebP が使えない環境では通常のフォーム送信にフォールバックする（サムネイルなし）。
 */
const IMAGE_RESIZE_SCRIPT = `
(function(){
  var form=document.getElementById("image-form"); if(!form) return;
  var input=document.getElementById("file"), status=document.getElementById("image-status");
  var MAIN=1600, THUMB=400;
  function load(file){ return new Promise(function(ok,ng){ var url=URL.createObjectURL(file); var im=new Image(); im.onload=function(){URL.revokeObjectURL(url);ok(im)}; im.onerror=function(){URL.revokeObjectURL(url);ng(new Error("decode"))}; im.src=url; }); }
  function draw(im,max,q){ var w=im.naturalWidth,h=im.naturalHeight,r=Math.min(1,max/Math.max(w,h)); var cw=Math.max(1,Math.round(w*r)),ch=Math.max(1,Math.round(h*r)); var c=document.createElement("canvas"); c.width=cw;c.height=ch; c.getContext("2d").drawImage(im,0,0,cw,ch); return new Promise(function(ok,ng){ c.toBlob(function(b){ if(b&&b.type==="image/webp") ok({blob:b,w:cw,h:ch}); else ng(new Error("webp")); },"image/webp",q); }); }
  form.addEventListener("submit",function(ev){
    var file=input.files&&input.files[0]; if(!file) return;
    if(!/^image\\/(jpeg|png|webp|avif)$/.test(file.type)) return; // GIF などはそのまま送る
    ev.preventDefault(); var btn=form.querySelector("button[type=submit]"); btn.disabled=true; status.textContent="縮小しています…";
    load(file).then(function(im){
      return Promise.all([draw(im,MAIN,0.82),draw(im,THUMB,0.8)]).then(function(r){
        var main=r[0],thumb=r[1],fd=new FormData();
        // 元が小さく、縮小しても軽くならないなら元ファイルのまま
        var keepOrig=Math.max(im.naturalWidth,im.naturalHeight)<=MAIN&&main.blob.size>=file.size;
        var mainFile=keepOrig?file:new File([main.blob],file.name.replace(/\\.[^.]+$/,"")+".webp",{type:"image/webp"});
        fd.append("file",mainFile); fd.append("thumb",new File([thumb.blob],"thumb.webp",{type:"image/webp"}));
        fd.append("width",String(keepOrig?im.naturalWidth:main.w)); fd.append("height",String(keepOrig?im.naturalHeight:main.h));
        status.textContent="アップロードしています…";
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
  if (q) where.push({ or: [{ col: "name", op: "contains", value: q }, { col: "slug", op: "contains", value: q.toLowerCase() }] });
  if (state) where.push({ col: "published", op: "eq", value: state === "published" });
  if (after) where.push(olderThan(after));
  const columns = "id,slug,name,published,created_at";
  // 部分一致は RLS の外の検索の関数で（0059。インデックスが効く）。当たる前の DB は PostgREST の ilike
  const searched = q ? await searchRows<ProductRow>(c, { kind: "products", shopId, q, filters: state ? { state } : {}, ...(after ? { after } : {}), limit: ADMIN_PAGE_SIZE + 1, columns }) : null;
  const page = splitPage(searched ?? (await db.from<ProductRow>("products").select(columns, { eq: { shop_id: shopId }, where, order: "created_at.desc,id.desc", limit: ADMIN_PAGE_SIZE + 1 })), (p) => p.created_at);
  const rows = page.rows;
  const filtered = Boolean(q || state || after);
  const listBase = `/admin/shops/${shopId}/products${q || state ? `?${new URLSearchParams({ ...(q ? { q } : {}), ...(state ? { state } : {}) }).toString()}` : ""}`;
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("product.list")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("product.list") }]} shopTabs={{ shop: { id: shop.id, name: shop.name }, access: c.get("shopAccess"), active: "products" }}>
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
  /** 追加カテゴリー（0042）が使えるか */
  extraCategories: boolean;
}

const extraCategoriesReady = (c: AdminContext) => migrated({ db: owner(c).db, cache: c.get("adapters").cache }, EXTRA_CATEGORIES_MIGRATION);

async function catalogContext(c: AdminContext, shop: ShopRow): Promise<CatalogContext> {
  const [categories, extraCategories] = await Promise.all([loadCategories(owner(c).db, shop.id), extraCategoriesReady(c)]);
  return { categories, fields: productFields(shop.settings), extraCategories };
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
          {props.catalog.extraCategories && categories.length > 1 ? (
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
                ) : (
                  <input id={id} type={f.type === "number" ? "number" : f.type === "url" ? "url" : "text"} name={id} value={v} step={f.type === "number" ? "any" : undefined} maxlength={f.type === "number" ? undefined : 200} />
                )}
              </div>
            );
          })}
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
    <AdminLayout title={t("product.new")} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("product.list"), href: `/admin/shops/${shop.id}/products` }]} shopTabs={{ shop: { id: shop.id, name: shop.name }, access: c.get("shopAccess"), active: "products" }}>
      <PageHead title={t("product.new")} />
      <Flash flash={flash(c.req.query("flash"))} />
      <ProductForm action={`/admin/shops/${shop.id}/products/new`} catalog={await catalogContext(c, shop)} />
    </AdminLayout>,
  );
});

/** extraCategories: 追加カテゴリーが使える DB なら true（0042 より前の DB には列を送らない） */
function productValues(f: Record<string, string>, fields: ProductField[], extraCategories: boolean): Partial<ProductRow> | "invalid_slug" {
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
    // 主カテゴリーと同じもの・重複はトリガーが外す。ほかのショップのカテゴリーは弾く（category_not_found）
    ...(extraCategories
      ? { extra_category_ids: Object.keys(f).filter((k) => k.startsWith("xcat_") && f[k] === "on").map((k) => k.slice(5)).slice(0, 20) }
      : {}),
    brand: brand || null,
    attributes: cleanAttributes(fields, attrInput),
    ...(isTaxClass(f.tax_class) ? { tax_class: f.tax_class } : {}),
    published: f.published === "on",
  };
}

products.post("/:shopId/products/new", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "catalog");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const values = productValues(await formFields(c), productFields(shop.settings), await extraCategoriesReady(c));
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

products.get("/:shopId/products/:productId", requireOwner, async (c: AdminContext) => {
  const shopId = param(c, "shopId");
  const productId = param(c, "productId");
  const data = await loadProduct(c, shopId, productId);
  if (!data) return c.text(t("product.not_found"), 404);
  const { shop, product, skus, images } = data;
  const base = `/admin/shops/${shopId}/products/${productId}`;
  const mediaBase = mediaBaseUrl(c);
  const catalog = await catalogContext(c, shop);

  return c.html(
    <AdminLayout title={`${product.name} · ${t("product.edit")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("product.list"), href: `/admin/shops/${shop.id}/products` }, { label: product.name }]} shopTabs={{ shop: { id: shop.id, name: shop.name }, access: c.get("shopAccess"), active: "products" }}>
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
      </PageHead>
      <Flash flash={flash(c.req.query("flash"))} />
      {product.published && !shop.published ? <p class="notice">{t("product.unpublished_shop")}</p> : null}
      <ProductForm action={base} product={product} catalog={catalog} />

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
                  {Object.keys(s.options ?? {}).length > 0 ? <div class="muted">{formatOptions(s.options ?? {})}</div> : null}
                </td>
                <td>
                  ¥{s.price_jpy.toLocaleString("ja-JP")}
                  {s.compare_at_price_jpy ? <div class="muted">{t("sku.compare_at")}: ¥{s.compare_at_price_jpy.toLocaleString("ja-JP")}</div> : null}
                  <details>
                    <summary>{t("sku.edit")}</summary>
                    <form method="post" action={`${base}/skus/${s.id}`}>
                      <SkuFields sku={s} />
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
        <SkuExtraFields />
        <label for="available">{t("sku.stock")}</label>
        <input id="available" type="number" name="available" min={0} step={1} value="0" />
        <p>
          <button type="submit">{t("sku.add")}</button>
        </p>
      </form>

      <h2 id="images">{t("image.list")}</h2>
      {images.length === 0 ? (
        <div class="empty">
          <p>{t("image.none")}</p>
        </div>
      ) : null}
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
      <form method="post" action={`${base}/images`} enctype="multipart/form-data" id="image-form" class="card">
        <label for="file">{t("image.file")}</label>
        <input id="file" type="file" name="file" accept="image/*" required />
        <p class="muted">{t("image.resize_note")}</p>
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
  const values = productValues(await formFields(c), productFields(shop.settings), await extraCategoriesReady(c));
  if (values === "invalid_slug") return c.redirect(`${base}?flash=invalid_slug`);
  if (!values.name) return c.redirect(`${base}?flash=generic`);
  try {
    const rows = await db.from<ProductRow>("products").update(values, { id: productId, shop_id: shopId });
    if (rows.length === 0) return c.text(t("product.not_found"), 404);
    const p = rows[0]!;
    await db.rpc("enqueue_hook", { p_shop_id: shopId, p_event: "product.updated", p_payload: { product_id: p.id, shop_id: shopId, slug: p.slug, name: p.name, published: p.published } });
  } catch (e) {
    if (e instanceof DbError && e.status === 409) return c.redirect(`${base}?flash=slug_taken`);
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
  await Promise.all(data.images.flatMap((img) => [storage.delete(img.storage_key), ...(img.thumb_key ? [storage.delete(img.thumb_key)] : [])]));
  await db.from("products").delete({ id: productId, shop_id: shopId });
  return c.redirect(`/admin/shops/${shopId}/products?flash=saved`);
});

// ---------- SKU ----------
/** 選択肢の入力（「サイズ=M, 色=黒」）→ オブジェクト。5 個まで、キー 40 文字・値 60 文字 */
export function parseOptions(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of input.split(/[,、\n]/)) {
    const [k, ...rest] = part.split(/[=＝:：]/);
    const key = (k ?? "").trim().slice(0, 40);
    const value = rest.join("=").trim().slice(0, 60);
    if (key && value && Object.keys(out).length < 5) out[key] = value;
  }
  return out;
}

function formatOptions(options: Record<string, string | number>): string {
  return Object.entries(options)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

function SkuExtraFields(props: { sku?: SkuRow }) {
  const s = props.sku;
  const suffix = s ? `_${s.id}` : "";
  return (
    <div>
      <label for={`options${suffix}`}>{t("sku.options")}</label>
      <input id={`options${suffix}`} type="text" name="options" value={s ? formatOptions(s.options ?? {}) : ""} placeholder={t("sku.options_placeholder")} />
      <label for={`compare_at${suffix}`}>{t("sku.compare_at")}</label>
      <input id={`compare_at${suffix}`} type="number" name="compare_at_price_jpy" min={0} step={1} value={s?.compare_at_price_jpy ? String(s.compare_at_price_jpy) : ""} />
      <label for={`gtin${suffix}`}>{t("sku.gtin")}</label>
      <input id={`gtin${suffix}`} type="text" name="gtin" value={s?.gtin ?? ""} inputmode="numeric" pattern="[0-9]{8}|[0-9]{12,14}" />
    </div>
  );
}

function SkuFields(props: { sku: SkuRow }) {
  const s = props.sku;
  return (
    <div>
      <label for={`name_${s.id}`}>{t("sku.name")}</label>
      <input id={`name_${s.id}`} type="text" name="name" value={s.name ?? ""} maxlength={200} />
      <label for={`price_${s.id}`}>{t("sku.price")}</label>
      <input id={`price_${s.id}`} type="number" name="price_jpy" min={0} step={1} required value={String(s.price_jpy)} />
      <SkuExtraFields sku={s} />
    </div>
  );
}

/** SKU の拡張欄（0008）。フォームに欄が出ていたときだけ値を返す。不正なら "sku_invalid" */
function skuExtraValues(f: Record<string, string>, price: number): Partial<SkuRow> | "sku_invalid" {
  if (f.options === undefined && f.gtin === undefined && f.compare_at_price_jpy === undefined) return {};
  const gtin = (f.gtin ?? "").trim();
  if (gtin && !/^([0-9]{8}|[0-9]{12,14})$/.test(gtin)) return "sku_invalid";
  const compareRaw = (f.compare_at_price_jpy ?? "").trim();
  const compare = compareRaw === "" ? null : Number.parseInt(compareRaw, 10);
  if (compare !== null && (!Number.isInteger(compare) || compare <= price)) return "sku_invalid";
  return { options: parseOptions(f.options ?? ""), gtin: gtin || null, compare_at_price_jpy: compare };
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
  const extra = skuExtraValues(f, price);
  if (extra === "sku_invalid") return c.redirect(`${base}?flash=sku_invalid`);
  try {
    const [sku] = await db.from<SkuRow>("skus").insert({ shop_id: shopId, product_id: productId, code, name: name || null, price_jpy: price, ...extra });
    if (available > 0) await db.rpc("set_stock", { p_sku_id: sku!.id, p_available: available });
  } catch (e) {
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
  const extra = skuExtraValues(f, price);
  if (extra === "sku_invalid") return c.redirect(`${base}?flash=sku_invalid`);
  const name = (f.name ?? "").trim().slice(0, 200);
  try {
    await db.from<SkuRow>("skus").update({ name: name || null, price_jpy: price, ...extra }, { id: skuId, product_id: productId, shop_id: shopId });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${base}?flash=sku_invalid`);
    throw e;
  }
  return c.redirect(`${base}?flash=saved`);
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
  if (file.size > MAX_IMAGE_BYTES) return c.redirect(`${base}?flash=image_size`);
  // サムネイルと寸法はブラウザ側のスクリプトが付ける（任意。JS が無い環境では本画像だけ）
  const thumb = body.thumb instanceof File && body.thumb.size > 0 ? body.thumb : null;
  const thumbExt = thumb ? imageExtension(thumb.type) : null;
  if (thumb && (!thumbExt || thumb.size > MAX_THUMB_BYTES)) return c.redirect(`${base}?flash=image_type`);
  const width = imageDimension(typeof body.width === "string" ? body.width : undefined);
  const height = imageDimension(typeof body.height === "string" ? body.height : undefined);

  const storage = c.get("adapters").storage;
  const key = productImageKey(shopId, productId, ext);
  const tKey = thumb && thumbExt ? thumbKey(key, thumbExt) : null;
  await storage.put(key, await file.arrayBuffer(), file.type);
  if (thumb && tKey) await storage.put(tKey, await thumb.arrayBuffer(), thumb.type);
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
    });
  } catch (e) {
    await Promise.all([storage.delete(key), tKey ? storage.delete(tKey) : Promise.resolve()]);
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

products.post("/:shopId/products/:productId/images/:imageId/delete", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const { shopId, productId, imageId } = params(c);
  const img = await db.from<ProductImageRow>("product_images").selectOne("*", { eq: { id: imageId, product_id: productId, shop_id: shopId } });
  if (img) {
    await db.from("product_images").delete({ id: imageId });
    const storage = c.get("adapters").storage;
    await Promise.all([storage.delete(img.storage_key), img.thumb_key ? storage.delete(img.thumb_key) : Promise.resolve()]);
  }
  return c.redirect(`/admin/shops/${shopId}/products/${productId}?flash=saved`);
});
