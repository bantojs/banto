import type { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError, type DbClient } from "../../db/client";
import { t, tf } from "../../i18n";
import { owner, param, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";
import { optionLabel, type OptionNames } from "../../products/option-names";
import { MAX_IMAGE_BYTES, imageSize, imageUrl, randomKey, sniffImage } from "../../media/images";
import { SWATCH_IMAGE_SIZE, SWATCH_LIMITS, colorFromForm, optionSwatchesOf, swatchImageKey, type OptionSwatches, type Swatch } from "../../products/option-swatches";

/**
 * 選択肢の値ごとの見本（0115、docs/storefront.md「選択肢の見本」）。カテゴリーの画面の「選択肢の表示名」の下に軸ごとの表を出す。
 * 値はこのショップの SKU に出てくるもの（と、もう見本のある値）。色か画像（ブラウザで SWATCH_IMAGE_SIZE まで縮めて送る）か、無し。
 * 書くのは DB の option_swatches_set（項目 catalog）だけ。使われなくなった画像は置き場から消す
 */

/** SKU に出てくる値（軸の key ごと、出てくる順。多すぎる分は切る） */
export async function skuOptionValues(db: DbClient, shopId: string): Promise<Record<string, string[]>> {
  const rows = await db.from<{ options: Record<string, unknown> | null }>("skus").select("options", { eq: { shop_id: shopId }, limit: 5000 });
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.options ?? {})) {
      const s = String(v ?? "").trim();
      if (!s || s.length > SWATCH_LIMITS.value) continue;
      const list = (out[k] ??= []);
      if (!list.includes(s) && list.length < 100) list.push(s);
    }
  }
  return out;
}

/** 見本の無い値の色の欄に出しておく色（変えたかどうかを比べる元） */
const DEFAULT_COLOR = "#888888";

/**
 * 1 行の入力から、その値をどうするかを決める（選択欄は無い。スクリプトが動かなくても、した操作のとおりに残す）。
 * 「外す」→ 無し。画像のファイルを選んだ → 画像。色を変えた（または色の欄を触った）→ 色。どれでもない → 今のまま
 */
export function swatchIntent(row: { clear: boolean; hasFile: boolean; color: string; colorPrev: unknown; colorTouched: boolean }, current: Swatch | undefined): "none" | "image" | "color" | "keep" {
  if (row.clear) return "none";
  if (row.hasFile) return "image";
  const color = colorFromForm(row.color);
  const prev = colorFromForm(typeof row.colorPrev === "string" ? row.colorPrev : "") ?? (current && "color" in current ? current.color : DEFAULT_COLOR);
  if (color && (color !== prev || (row.colorTouched && !(current && "color" in current && current.color === color)))) return "color";
  return "keep";
}

const sameSwatches = (a: Record<string, Swatch>, b: Record<string, Swatch>): boolean => {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
};

export function SwatchesEditor({ shopId, names, values, table, media }: { shopId: string; names: OptionNames; values: Record<string, string[]>; table: OptionSwatches; media: string }) {
  const keys = Object.keys(names);
  if (keys.length === 0) return null;
  return (
    <div id="option-swatches">
      <h3>{t("swatch.title")}</h3>
      <p class="muted">{t("swatch.hint")}</p>
      {keys.map((k) => {
        const list = [...new Set([...(values[k] ?? []), ...Object.keys(table[k] ?? {})])];
        if (list.length === 0) return null;
        return (
          <details open={Boolean(table[k])}>
            <summary>
              {optionLabel(names, k)}
              {table[k] ? ` ✓` : ""}
            </summary>
            <form method="post" action={`/admin/shops/${shopId}/option-swatches/${k}`} enctype="multipart/form-data" data-swatch-form>
              <table>
                <thead>
                  <tr>
                    <th>{t("swatch.value")}</th>
                    <th>{t("swatch.current")}</th>
                    <th>{t("swatch.color")}</th>
                    <th>{t("swatch.image")}</th>
                    <th>{t("swatch.clear")}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((v, i) => {
                    const sw: Swatch | undefined = table[k]?.[v];
                    const color = sw && "color" in sw ? sw.color : DEFAULT_COLOR;
                    return (
                      <tr>
                        <td>
                          <input type="hidden" name={`v_${i}`} value={v} />
                          <input type="hidden" name={`color_prev_${i}`} value={color} />
                          <input type="hidden" name={`color_set_${i}`} value="" data-swatch-touched />
                          {v}
                        </td>
                        <td>
                          {!sw ? (
                            <span class="muted">{t("swatch.none")}</span>
                          ) : "color" in sw ? (
                            <span title={sw.color} style={`display:inline-block;width:24px;height:24px;border-radius:999px;border:1px solid #ccc;vertical-align:middle;background:${sw.color}`} />
                          ) : (
                            <img src={imageUrl(media, sw.image.key)} alt="" width={24} height={24} style="border-radius:999px;object-fit:cover;vertical-align:middle" />
                          )}
                        </td>
                        <td>
                          <input type="color" name={`color_${i}`} value={color} aria-label={tf("swatch.color_for", { value: v })} />
                        </td>
                        <td>
                          <input type="file" name={`image_${i}`} accept="image/jpeg,image/png,image/webp" aria-label={tf("swatch.image_for", { value: v })} data-swatch-image />
                        </td>
                        <td>
                          {sw ? <input type="checkbox" name={`clear_${i}`} value="1" aria-label={tf("swatch.clear_for", { value: v })} /> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p class="muted">{t("swatch.image_hint")}</p>
              <button type="submit" class="secondary small">
                {t("shop.save")}
              </button>
            </form>
          </details>
        );
      })}
      <script dangerouslySetInnerHTML={{ __html: SWATCH_RESIZE_SCRIPT }} />
    </div>
  );
}

/** 見本の画像を縮めてから送る（長い辺を SWATCH_IMAGE_SIZE まで、WebP）。失敗したら元のファイルのまま送る */
const SWATCH_RESIZE_SCRIPT = `(function(){document.querySelectorAll("form[data-swatch-form]").forEach(function(f){var busy=false;
// 色の欄を触ったら印を付ける（見本の無い値で、置いてある灰色そのものを選んだときも色として残すため）
f.addEventListener("input",function(e){var t=e.target;if(!t||!t.name)return;var m=/^color_(\\d+)$/.exec(t.name);if(!m)return;var h=f.querySelector("input[name=color_set_"+m[1]+"]");if(h)h.value="1";});
f.addEventListener("submit",function(e){if(busy||typeof DataTransfer==="undefined")return;var inputs=[].slice.call(f.querySelectorAll("input[data-swatch-image]")).filter(function(i){return i.files&&i.files[0];});if(!inputs.length)return;e.preventDefault();busy=true;var left=inputs.length;
function done(){if(--left===0)f.submit()}
inputs.forEach(function(inp){var file=inp.files[0],url=URL.createObjectURL(file),im=new Image();
im.onload=function(){var W=im.naturalWidth,H=im.naturalHeight,r=Math.min(1,${SWATCH_IMAGE_SIZE}/Math.max(W,H)),w=Math.max(1,Math.round(W*r)),h=Math.max(1,Math.round(H*r)),c=document.createElement("canvas");c.width=w;c.height=h;var x=c.getContext("2d");if(!x){done();return}x.drawImage(im,0,0,w,h);
c.toBlob(function(b){URL.revokeObjectURL(url);if(b&&b.type==="image/webp"){var dt=new DataTransfer();dt.items.add(new File([b],"swatch.webp",{type:"image/webp"}));inp.files=dt.files}done()},"image/webp",0.9)};
im.onerror=function(){done()};im.src=url})})})})();`;

/** /admin/shops/:shopId/option-swatches/:axis（項目 catalog） */
export function mountOptionSwatches(app: Hono<AppEnv>): void {
  app.post("/:shopId/option-swatches/:axis", requireOwner, async (c: AdminContext) => {
    const { db } = owner(c);
    const shopId = param(c, "shopId");
    const axis = param(c, "axis");
    const back = `/admin/shops/${shopId}/categories`;
    const shop = await loadShop(c, shopId, "catalog");
    if (!shop) return c.text(t("shop.not_found"), 404);
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(axis)) return c.redirect(`${back}?flash=swatch_invalid#option-swatches`);
    const current = optionSwatchesOf(shop.option_swatches)[axis] ?? {};
    const body = await c.req.parseBody();
    const storage = c.get("adapters").storage;
    const uploaded: string[] = [];
    // フォームに無い値（開いた後に増えた値など）は今のまま残す。フォームにある値だけを入力で決め直す
    const next: Record<string, Swatch> = { ...current };
    const fail = async (code: string) => {
      await Promise.all(uploaded.map((k) => storage.delete(k).catch(() => undefined)));
      return c.redirect(`${back}?flash=${code}#option-swatches`);
    };
    for (let i = 0; i < SWATCH_LIMITS.total; i++) {
      const v = body[`v_${i}`];
      if (typeof v !== "string") break;
      const file = body[`image_${i}`];
      const hasFile = file instanceof File && file.size > 0;
      const colorRaw = typeof body[`color_${i}`] === "string" ? (body[`color_${i}`] as string) : "";
      const intent = swatchIntent({ clear: body[`clear_${i}`] === "1", hasFile, color: colorRaw, colorPrev: body[`color_prev_${i}`], colorTouched: body[`color_set_${i}`] === "1" }, current[v]);
      if (intent === "keep") continue;
      if (intent === "none") {
        delete next[v];
      } else if (intent === "color") {
        const color = colorFromForm(colorRaw);
        if (!color) return fail("swatch_invalid");
        next[v] = { color };
      } else if (file instanceof File) {
        if (file.size > MAX_IMAGE_BYTES) return fail("swatch_image_invalid");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const sniff = sniffImage(bytes);
        const dim = sniff ? imageSize(bytes, sniff.contentType) : null;
        if (!sniff || !dim || !["webp", "png", "jpg"].includes(sniff.ext) || dim.width > 512 || dim.height > 512) return fail("swatch_image_invalid");
        const key = swatchImageKey(shopId, randomKey(), sniff.ext);
        await storage.put(key, bytes.buffer as ArrayBuffer, sniff.contentType);
        uploaded.push(key);
        next[v] = { image: { key, width: dim.width, height: dim.height } };
      }
    }
    if (sameSwatches(next, current)) return fail("swatch_unchanged");
    try {
      const r = await db.rpc<{ removed_image_keys?: string[] }>("option_swatches_set", { p_shop_id: shopId, p_axis: axis, p_values: next });
      await Promise.all((r?.removed_image_keys ?? []).map((k) => storage.delete(k).catch((e: unknown) => console.error("[banto] swatch image:", e))));
    } catch (e) {
      if (e instanceof DbError) return fail("swatch_invalid");
      throw e;
    }
    return c.redirect(`${back}?flash=${Object.keys(next).length > 0 ? "swatch_saved" : "swatch_cleared"}#option-swatches`);
  });
}
