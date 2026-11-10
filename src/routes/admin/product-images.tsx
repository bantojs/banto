import type { ProductImageRow, SkuRow } from "../../db/types";
import { t, tf } from "../../i18n";
import { imageUrl } from "../../media/images";
import { imageMatchesSku, imageOptionGroups, imageOptionsOf, orderImagesForSku, sameImageOptions, skuOptionChoices, type ImageOptions } from "../../products/images";
import { namedOptionEntries, optionLabel, type OptionNames } from "../../products/option-names";

/**
 * 商品の画面の「画像」の欄（メンテナの決定 2026-11-08「管理画面の画像のまとめ方は 品番 / オプション / SKU の 3 つ」）。
 * データの形（画像の options、0063）は変えず、まとめ方の画面だけ:
 *   - 品番: 全部の画像を 1 つの並びで（並びは sort_order）
 *   - オプション: 選んだ軸（1 つでも組み合わせでも）の値ごとに、その組に結んだ画像
 *   - SKU: SKU を 1 つずつ、お店でその SKU を選んだときと同じ順で（細かい画像 → 共通の画像）
 * 別の組へ移すと options が付け替わる（「付け先」）。並べ替えは同じ組の隣と入れ替える。スクリプト無しで動く。
 * 軸を決めていない商品（品番だけの SKU）は SKU ごとに画像を付けられない（品番で指す鍵は足さない。メンテナの決定 2026-11-08）ので、品番だけ
 */
export type ImageView = "product" | "option" | "sku";

export interface ImageViewState {
  view: ImageView;
  /** オプションのまとめ方で選んだ軸（SKU にある軸だけ） */
  axes: string[];
  /** アップロードの付け先の初期値（「ここに追加」） */
  to: ImageOptions | null;
}

/** URL の値 → まとめ方（形の違う値は既定に） */
export function readImageView(q: { view?: string | undefined; axes: string[]; to?: string | undefined }, skus: readonly { options?: unknown }[]): ImageViewState {
  const keys = skuOptionChoices(skus).map((c) => c.key);
  if (keys.length === 0) return { view: "product", axes: [], to: null };
  const view: ImageView = q.view === "option" || q.view === "sku" ? q.view : "product";
  const axes = keys.filter((k) => q.axes.includes(k));
  return { view, axes: axes.length > 0 ? axes : [keys[0]!], to: parseTarget(q.to, keys) };
}

/** 付け先の値（JSON の options）→ options。鍵は SKU にあるものだけ、値は 60 字まで。形が違えば null */
export function parseTarget(v: string | undefined, allowedKeys: readonly string[]): ImageOptions | null {
  if (v === undefined || v === "") return null;
  try {
    const o: unknown = JSON.parse(v);
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    const out: ImageOptions = {};
    for (const [k, val] of Object.entries(o as Record<string, unknown>)) {
      if (!allowedKeys.includes(k) || typeof val !== "string" || !val.trim()) return null;
      out[k] = val.trim().slice(0, 60);
    }
    return out;
  } catch {
    return null;
  }
}

/** 付け先に選べるもの: 品番 → 軸ごとの値 → （軸が 2 つ以上なら）SKU ごと */
export function imageTargets(skus: readonly SkuRow[], names: OptionNames): { options: ImageOptions; label: string }[] {
  const choices = skuOptionChoices(skus);
  const out: { options: ImageOptions; label: string }[] = [{ options: {}, label: t("image.to_product") }];
  for (const ch of choices) for (const v of ch.values) out.push({ options: { [ch.key]: v }, label: `${optionLabel(names, ch.key)}: ${v}` });
  if (choices.length > 1) {
    for (const s of skus) {
      const o = imageOptionsOf(s.options);
      if (Object.keys(o).length < 2 || out.some((x) => sameImageOptions(x.options, o))) continue;
      out.push({ options: o, label: tf("image.to_sku", { code: s.code, options: optionsText(o, names) }) });
    }
  }
  return out;
}

const optionsText = (o: ImageOptions, names: OptionNames): string =>
  namedOptionEntries(o, names)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" / ");

/** 画像の付け先の短い印 */
function attachLabel(o: ImageOptions, names: OptionNames): string {
  return Object.keys(o).length === 0 ? t("image.to_product") : optionsText(o, names);
}

/** まとめ方の URL（今の URL の値を残し、画像の欄へ） */
export function imageViewHref(base: string, state: { view: ImageView; axes: string[] }, extra?: { to?: ImageOptions }): string {
  const q = new URLSearchParams({ img: state.view });
  if (state.view === "option") for (const a of state.axes) q.append("axis", a);
  if (extra?.to) q.set("to", JSON.stringify(extra.to));
  return `${base}?${q.toString()}#images`;
}

interface Group {
  key: string;
  title: string;
  /** この組に新しく足すときの付け先（「ここに追加」） */
  target: ImageOptions | null;
  images: ProductImageRow[];
  /** 並べ替えの隣にしてよいか（同じ組の中で、同じ付け先どうし） */
  movable: (img: ProductImageRow) => boolean;
}

function groupsOf(state: ImageViewState, images: readonly ProductImageRow[], skus: readonly SkuRow[], names: OptionNames): Group[] {
  if (state.view === "product") return [{ key: "all", title: t("image.view_product_all"), target: {}, images: [...images], movable: () => true }];
  if (state.view === "option") {
    const combos = imageOptionGroups(skus, state.axes);
    const groups: Group[] = [{ options: {} as ImageOptions, title: t("image.to_product") }, ...combos.map((o) => ({ options: o, title: optionsText(o, names) }))].map((g) => ({
      key: JSON.stringify(g.options),
      title: g.title,
      target: g.options,
      images: images.filter((img) => sameImageOptions(imageOptionsOf(img.options), g.options)),
      movable: (img: ProductImageRow) => sameImageOptions(imageOptionsOf(img.options), g.options),
    }));
    const rest = images.filter((img) => !groups.some((g) => g.images.includes(img)));
    if (rest.length > 0) groups.push({ key: "rest", title: t("image.view_rest"), target: null, images: rest, movable: () => false });
    return groups;
  }
  // SKU ごと: お店でその SKU を選んだときと同じ順（当てはまる画像だけ）。並べ替えは同じ付け先どうし
  return skus
    .filter((s) => Object.keys(imageOptionsOf(s.options)).length > 0)
    .map((s) => {
      const o = imageOptionsOf(s.options);
      return {
        key: s.id,
        title: `${s.code}（${optionsText(o, names)}）`,
        target: o,
        images: orderImagesForSku(images, o).filter((img) => imageMatchesSku(imageOptionsOf(img.options), o)),
        movable: () => true,
      };
    });
}

export function ImagesSection(props: { base: string; images: ProductImageRow[]; skus: SkuRow[]; names: OptionNames; mediaBase: string; state: ImageViewState; uploadForm: (target: ImageOptions, targets: { options: ImageOptions; label: string }[]) => unknown }) {
  const { base, images, skus, names, state } = props;
  const choices = skuOptionChoices(skus);
  const targets = imageTargets(skus, names);
  const groups = groupsOf(state, images, skus, names);
  const back = imageViewHref("", state).replace(/#images$/, "");
  const uploadTarget = state.to ?? (state.view === "option" ? (groups[1]?.target ?? {}) : state.view === "sku" ? (groups[0]?.target ?? {}) : {});
  return (
    <>
      <h2 id="images">{t("image.list")}</h2>
      {choices.length > 0 ? (
        <>
          <nav class="viewtabs" aria-label={t("image.view")}>
            {(["product", "option", "sku"] as const).map((v) => (
              <a href={imageViewHref(base, { view: v, axes: state.axes })} aria-current={state.view === v ? "page" : undefined}>
                {t(v === "product" ? "image.view_product" : v === "option" ? "image.view_option" : "image.view_sku")}
              </a>
            ))}
          </nav>
          <p class="muted">{t(state.view === "product" ? "image.view_product_hint" : state.view === "option" ? "image.view_option_hint" : "image.view_sku_hint")}</p>
          {state.view === "option" ? (
            <form method="get" action={`${base}#images`} class="chips">
              <input type="hidden" name="img" value="option" />
              <span class="muted">{t("image.axes")}</span>
              {choices.map((ch) => (
                <label class="chip">
                  <input type="checkbox" name="axis" value={ch.key} checked={state.axes.includes(ch.key)} /> {optionLabel(names, ch.key)}
                </label>
              ))}
              <button type="submit" class="secondary small">
                {t("image.axes_apply")}
              </button>
            </form>
          ) : null}
        </>
      ) : skus.length > 1 ? (
        <p class="muted">
          {t("image.no_axes")} <a href={`${base}#option-axes`}>{t("image.no_axes_link")}</a>
        </p>
      ) : null}
      {images.length === 0 ? (
        <div class="empty">
          <p>{t("image.none")}</p>
        </div>
      ) : null}
      {images.length > 0 || state.view !== "product"
        ? groups.map((g) => (
            <section class="image-group" aria-label={g.title}>
              {state.view !== "product" ? (
                <h3>
                  {g.title}{" "}
                  {g.target ? (
                    <a class="small" href={imageViewHref(base, state, { to: g.target }).replace(/#images$/, "#image-form")}>
                      {t("image.add_here")}
                    </a>
                  ) : null}
                </h3>
              ) : null}
              {g.images.length === 0 ? (
                <p class="muted">{t("image.group_empty")}</p>
              ) : (
                <table>
                  <tbody>
                    {g.images.map((img, i) => {
                      const o = imageOptionsOf(img.options);
                      const prev = g.movable(img) ? g.images.slice(0, i).reverse().find((x) => g.movable(x) && (state.view === "product" || sameImageOptions(imageOptionsOf(x.options), o))) : undefined;
                      const next = g.movable(img) ? g.images.slice(i + 1).find((x) => g.movable(x) && (state.view === "product" || sameImageOptions(imageOptionsOf(x.options), o))) : undefined;
                      return (
                        <tr>
                          <td>
                            <img src={imageUrl(props.mediaBase, img.thumb_key ?? img.storage_key)} alt="" style="max-width:8rem;max-height:8rem" loading="lazy" />
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
                            {choices.length > 0 ? <span class="badge">{attachLabel(o, names)}</span> : null}
                            <div class="actions">
                              {prev ? (
                                <form method="post" action={`${base}/images/${img.id}/move`} style="display:inline">
                                  <input type="hidden" name="with" value={prev.id} />
                                  <input type="hidden" name="back" value={back} />
                                  <button type="submit" class="secondary small" aria-label={t("image.move_up")}>
                                    ↑
                                  </button>
                                </form>
                              ) : null}
                              {next ? (
                                <form method="post" action={`${base}/images/${img.id}/move`} style="display:inline">
                                  <input type="hidden" name="with" value={next.id} />
                                  <input type="hidden" name="back" value={back} />
                                  <button type="submit" class="secondary small" aria-label={t("image.move_down")}>
                                    ↓
                                  </button>
                                </form>
                              ) : null}
                            </div>
                          </td>
                          {choices.length > 0 ? (
                            <td>
                              <form method="post" action={`${base}/images/${img.id}/options`} style="display:inline">
                                <input type="hidden" name="back" value={back} />
                                <label>
                                  {t("image.attach_to")}{" "}
                                  <select name="target">
                                    {targets.map((x) => (
                                      <option value={JSON.stringify(x.options)} selected={sameImageOptions(x.options, o)}>
                                        {x.label}
                                      </option>
                                    ))}
                                    {targets.some((x) => sameImageOptions(x.options, o)) ? null : (
                                      <option value={JSON.stringify(o)} selected>
                                        {attachLabel(o, names)}
                                      </option>
                                    )}
                                  </select>
                                </label>{" "}
                                <button type="submit" class="secondary small">
                                  {t("image.move_to")}
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
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
          ))
        : null}
      {props.uploadForm(uploadTarget, choices.length > 0 ? targets : [])}
    </>
  );
}

/** 戻り先（hidden の back）→ 商品の画面の URL（まとめ方の値だけを残す） */
export function imageBackHref(base: string, back: string | undefined): string {
  const src = new URLSearchParams((back ?? "").replace(/^\?/, ""));
  const q = new URLSearchParams();
  const view = src.get("img");
  if (view === "product" || view === "option" || view === "sku") q.set("img", view);
  for (const a of src.getAll("axis").slice(0, 5)) if (a.length > 0 && a.length <= 40) q.append("axis", a);
  q.set("flash", "saved");
  return `${base}?${q.toString()}#images`;
}
