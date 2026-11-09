import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { CategoryRow, ProductRow, ShopRow } from "../../db/types";
import { t, tf } from "../../i18n";
import { AdminLayout, PageHead } from "../../routes/admin/layout";
import { mediaBaseUrl, owner, param, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { loadShop } from "../../routes/admin/shops";
import { moduleEnabled } from "../registry";
import { MAX_IMAGE_BYTES, imageSize, imageUrl, randomKey, sniffImage } from "../../media/images";
import { CARE_CODES, CARE_GROUPS, CARE_LIMITS, CARE_MODULE, careGroupLabel, careImageKey, careLabel, careOf, careSymbolsOf, type Care, type CareSymbolImage } from "../../care-labels/care";

/**
 * 同梱モジュール「洗濯表示」（0127_mod_care_labels、docs/care-labels.md）。項目 catalog。
 *   GET/POST /admin/shops/:shopId/modules/care-labels                          記号の絵の表（運営者が持ち込む）とカテゴリーごとの一覧
 *   GET/POST /admin/shops/:shopId/modules/care-labels/categories/:categoryId   カテゴリーの洗濯表示
 *   GET/POST /admin/shops/:shopId/modules/care-labels/products/:productId      商品の洗濯表示（無ければカテゴリーのものを使う）
 * 絵はブラウザで 256px までの PNG に縮めてから送る（SVG もブラウザで PNG にする。スクリプトが無ければ PNG / WebP だけ受ける）
 */
export const careLabelsAdmin = new Hono<AppEnv>();

async function scope(c: AdminContext): Promise<ShopRow | null> {
  const shop = await loadShop(c, param(c, "shopId"), "catalog");
  return shop && moduleEnabled(shop.settings, CARE_MODULE) ? shop : null;
}

/** 商品・カテゴリーの画面から開くリンク（モジュールが OFF なら null） */
export function careHref(shop: { id: string; settings?: Record<string, unknown> | null }, target: { category?: string; product?: string }): string | null {
  if (!moduleEnabled(shop.settings ?? {}, CARE_MODULE)) return null;
  const base = `/admin/shops/${shop.id}/modules/care-labels`;
  return target.product ? `${base}/products/${target.product}` : target.category ? `${base}/categories/${target.category}` : base;
}

const flashOf = (code: string | undefined) =>
  code === "saved" ? <p class="notice">{t("care.saved")}</p> : code === "invalid" ? <p class="error">{t("care.invalid")}</p> : code === "notes" ? <p class="error">{t("care.notes_invalid")}</p> : null;

function Symbol({ code, img, media }: { code: string; img: CareSymbolImage | undefined; media: string }) {
  return img ? <img src={imageUrl(media, img.key)} alt={careLabel(code)} title={careLabel(code)} width={32} height={Math.round((32 * img.height) / Math.max(1, img.width))} style="vertical-align:middle" /> : <span class="muted">{code}</span>;
}

function careSummary(care: Care | null, table: Record<string, CareSymbolImage>, media: string) {
  if (!care) return <span class="muted">{t("care.none")}</span>;
  return (
    <span>
      {care.symbols.map((code) => (
        <>
          <Symbol code={code} img={table[code]} media={media} />{" "}
        </>
      ))}
      {care.notes.length > 0 ? <span class="muted">{care.notes.join(" / ")}</span> : null}
    </span>
  );
}

careLabelsAdmin.get("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const media = mediaBaseUrl(c);
  const table = careSymbolsOf(shop.care_symbols);
  const categories = await owner(c).db.from<CategoryRow>("categories").select("id,name,parent_id,care", { eq: { shop_id: shop.id }, order: "sort_order.asc" });
  const base = `/admin/shops/${shop.id}/modules/care-labels`;
  return c.html(
    <AdminLayout title={t("care.title")} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("care.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), here: "care-labels" }}>
      <PageHead title={t("care.title")} />
      {flashOf(c.req.query("flash"))}
      <p>{t("care.intro")}</p>
      <h2>{t("care.categories")}</h2>
      <table>
        <tbody>
          {categories.map((cat) => (
            <tr>
              <td>
                <a href={`${base}/categories/${cat.id}`}>{cat.name}</a>
              </td>
              <td>{careSummary(careOf(cat.care), table, media)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>{t("care.symbols")}</h2>
      <p class="muted">{t("care.symbols_hint")}</p>
      <form method="post" action={base} enctype="multipart/form-data" data-care-form>
        {CARE_GROUPS.map((g) => (
          <details open={g.codes.some((code) => table[code])}>
            <summary>{careGroupLabel(g.group)}</summary>
            <table>
              <thead>
                <tr>
                  <th>{t("care.code")}</th>
                  <th>{t("care.meaning")}</th>
                  <th>{t("care.current")}</th>
                  <th>{t("care.file")}</th>
                  <th>{t("care.clear")}</th>
                </tr>
              </thead>
              <tbody>
                {g.codes.map((code) => (
                  <tr>
                    <td>{code}</td>
                    <td>{careLabel(code)}</td>
                    <td>{table[code] ? <Symbol code={code} img={table[code]} media={media} /> : <span class="muted">{t("care.none")}</span>}</td>
                    <td>
                      <input type="file" name={`file_${code}`} accept="image/png,image/webp,image/jpeg,image/svg+xml" aria-label={`${code} ${careLabel(code)}`} data-care-image />
                    </td>
                    <td>{table[code] ? <input type="checkbox" name={`clear_${code}`} value="1" aria-label={`${t("care.clear")} ${code}`} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ))}
        <p>
          <button type="submit">{t("shop.save")}</button>
        </p>
      </form>
      <script dangerouslySetInnerHTML={{ __html: CARE_RESIZE_SCRIPT }} />
    </AdminLayout>,
  );
});

/** 絵をブラウザで縮めて PNG にしてから送る（長い辺を 256px まで。SVG も画像として描いて PNG にする）。失敗したら元のファイルのまま送る */
const CARE_RESIZE_SCRIPT = `(function(){var f=document.querySelector("form[data-care-form]");if(!f)return;var busy=false;
f.addEventListener("submit",function(e){if(busy||typeof DataTransfer==="undefined")return;var inputs=[].slice.call(f.querySelectorAll("input[data-care-image]")).filter(function(i){return i.files&&i.files[0];});if(!inputs.length)return;e.preventDefault();busy=true;var left=inputs.length;
function done(){if(--left===0)f.submit()}
inputs.forEach(function(inp){var file=inp.files[0],url=URL.createObjectURL(file),im=new Image();
im.onload=function(){var W=im.naturalWidth||${CARE_LIMITS.imageSize},H=im.naturalHeight||${CARE_LIMITS.imageSize},r=Math.min(${CARE_LIMITS.imageSize}/W,${CARE_LIMITS.imageSize}/H),w=Math.max(1,Math.round(W*r)),h=Math.max(1,Math.round(H*r)),cv=document.createElement("canvas");cv.width=w;cv.height=h;var x=cv.getContext("2d");if(!x){done();return}x.drawImage(im,0,0,w,h);
cv.toBlob(function(b){URL.revokeObjectURL(url);if(b){var dt=new DataTransfer();dt.items.add(new File([b],"care.png",{type:"image/png"}));inp.files=dt.files}done()},"image/png")};
im.onerror=function(){done()};im.src=url})})})();`;

careLabelsAdmin.post("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const base = `/admin/shops/${shop.id}/modules/care-labels`;
  const body = await c.req.parseBody();
  const storage = c.get("adapters").storage;
  const current = careSymbolsOf(shop.care_symbols);
  const next: Record<string, CareSymbolImage> = { ...current };
  const uploaded: string[] = [];
  const fail = async () => {
    await Promise.all(uploaded.map((k) => storage.delete(k).catch(() => undefined)));
    return c.redirect(`${base}?flash=invalid`);
  };
  for (const code of CARE_CODES) {
    const file = body[`file_${code}`];
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_IMAGE_BYTES) return fail();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sniff = sniffImage(bytes);
      const dim = sniff ? imageSize(bytes, sniff.contentType) : null;
      if (!sniff || !dim || !["png", "webp"].includes(sniff.ext) || dim.width > CARE_LIMITS.imageSize || dim.height > CARE_LIMITS.imageSize) return fail();
      const key = careImageKey(shop.id, randomKey(), sniff.ext);
      await storage.put(key, bytes.buffer as ArrayBuffer, sniff.contentType);
      uploaded.push(key);
      next[code] = { key, width: dim.width, height: dim.height };
    } else if (body[`clear_${code}`] === "1") {
      delete next[code];
    }
  }
  try {
    const r = await owner(c).db.rpc<{ removed_image_keys?: string[] }>("care_symbols_set", { p_shop_id: shop.id, p_symbols: next });
    await Promise.all((r?.removed_image_keys ?? []).map((k) => storage.delete(k).catch((e: unknown) => console.error("[banto] care image:", e))));
  } catch (e) {
    if (e instanceof DbError) return fail();
    throw e;
  }
  return c.redirect(`${base}?flash=saved`);
});

type Target = { kind: "category"; row: CategoryRow } | { kind: "product"; row: ProductRow };

async function targetOf(c: AdminContext, shop: ShopRow): Promise<Target | null> {
  const { db } = owner(c);
  const cid = c.req.param("categoryId");
  const pid = c.req.param("productId");
  if (cid) {
    const [row] = await db.from<CategoryRow>("categories").select("*", { eq: { id: cid, shop_id: shop.id }, limit: 1 });
    return row ? { kind: "category", row } : null;
  }
  if (pid) {
    const [row] = await db.from<ProductRow>("products").select("id,shop_id,slug,name,category_id,care,created_at,updated_at", { eq: { id: pid, shop_id: shop.id }, limit: 1 });
    return row ? { kind: "product", row } : null;
  }
  return null;
}

async function editPage(c: AdminContext, shop: ShopRow, target: Target) {
  const media = mediaBaseUrl(c);
  const table = careSymbolsOf(shop.care_symbols);
  const care = careOf(target.row.care);
  const { db } = owner(c);
  // 商品で決めていなければ、どのカテゴリーのものを使っているか
  let inherited: { name: string; care: Care } | null = null;
  if (target.kind === "product" && !care && target.row.category_id) {
    const cats = await db.from<CategoryRow>("categories").select("id,name,parent_id,care", { eq: { shop_id: shop.id } });
    const byId = new Map(cats.map((x) => [x.id, x]));
    let cur = byId.get(target.row.category_id);
    for (let i = 0; cur && i < 10 && !inherited; i++) {
      const cc = careOf(cur.care);
      if (cc) inherited = { name: cur.name, care: cc };
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
  }
  const title = target.kind === "product" ? t("care.edit_product") : t("care.edit_category");
  const base = `/admin/shops/${shop.id}/modules/care-labels`;
  const back = target.kind === "product" ? `/admin/shops/${shop.id}/products/${target.row.id}` : `/admin/shops/${shop.id}/categories`;
  return c.html(
    <AdminLayout title={title} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("care.title"), href: base }, { label: target.row.name }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), here: "care-labels" }}>
      <PageHead title={`${title}: ${target.row.name}`} />
      {flashOf(c.req.query("flash"))}
      {inherited ? (
        <p class="notice">
          {tf("care.from_category", { name: inherited.name })} {careSummary(inherited.care, table, media)}
        </p>
      ) : null}
      <form method="post">
        {CARE_GROUPS.map((g) => {
          const sel = care?.symbols.find((x) => x[0] === g.group) ?? "";
          return (
            <>
              <label for={`care_${g.group}`}>{careGroupLabel(g.group)}</label>
              <select id={`care_${g.group}`} name={`care_${g.group}`}>
                <option value="">{t("care.inherit")}</option>
                {g.codes.map((code) => (
                  <option value={code} selected={code === sel}>
                    {code} {careLabel(code)}
                  </option>
                ))}
              </select>
            </>
          );
        })}
        <label for="notes">{t("care.notes")}</label>
        <textarea id="notes" name="notes" rows={3}>
          {(care?.notes ?? []).join("\n")}
        </textarea>
        <p class="muted">{t("care.empty_hint")}</p>
        <p>
          <button type="submit">{t("shop.save")}</button> <a href={back}>{target.row.name}</a>
        </p>
      </form>
    </AdminLayout>,
  );
}

async function save(c: AdminContext) {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const target = await targetOf(c, shop);
  if (!target) return c.notFound();
  const form = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));
  const back = c.req.path;
  const notes = (form["notes"] ?? "").split(/\r?\n/).map((x) => x.trim()).filter((x) => x !== "");
  if (notes.length > CARE_LIMITS.notes || notes.some((x) => x.length > CARE_LIMITS.note)) return c.redirect(`${back}?flash=notes`);
  const care = careOf({ symbols: CARE_GROUPS.map((g) => form[`care_${g.group}`] ?? ""), notes });
  try {
    await owner(c).db.from(target.kind === "product" ? "products" : "categories").update({ care }, { id: target.row.id, shop_id: shop.id });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${back}?flash=invalid`);
    throw e;
  }
  return c.redirect(`${back}?flash=saved`);
}

careLabelsAdmin.get("/categories/:categoryId", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  const target = shop ? await targetOf(c, shop) : null;
  return shop && target ? editPage(c, shop, target) : c.notFound();
});
careLabelsAdmin.get("/products/:productId", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  const target = shop ? await targetOf(c, shop) : null;
  return shop && target ? editPage(c, shop, target) : c.notFound();
});
careLabelsAdmin.post("/categories/:categoryId", requireOwner, save);
careLabelsAdmin.post("/products/:productId", requireOwner, save);
