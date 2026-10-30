import { Hono } from "hono";
import type { AppEnv } from "../../app";
import type { ShopRow } from "../../db/types";
import { t, tf, getLocale, type MessageKey } from "../../i18n";
import { DbError } from "../../db/client";
import { editorModel, EDITABLE_SETTING_TYPES, fieldName, layoutFieldName, layoutOnly, layoutsFromForm, SECTION_LAYOUT_KEY, settingsFromForm, shownValue, type EditorLayout, type EditorModel, type EditorSetting } from "../../themes/liquid/editor";
import { readThemeBundle, themeStorage, THEME_VERSION_ID } from "../../themes/liquid/versions";
import { AdminLayout, PageHead } from "./layout";
import { formFields, owner, param, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";

/**
 * テーマの設定の値（テーマの段階 3、docs/themes.md「設定を変える」）: /admin/shops/:shopId/design/versions/:versionId/settings。項目 design の人だけ。
 * 入力の形は版の宣言（settings_schema.json とセクションの {% schema %}）から作り、値は版の settings に置く（theme_version_set_settings、0071）。
 * 公開中の版の値を変えると、お店の画面は 30 秒ほどで切り替わる。公開していない版はプレビューで確かめる
 */
export const designSettings = new Hono<AppEnv>();

/** 版の settings の上限（DB の CHECK と同じ） */
const SETTINGS_MAX_BYTES = 65536;

const base = (shop: ShopRow) => `/admin/shops/${shop.id}/design`;

const REASON: Record<string, MessageKey> = {
  number: "design.settings_reason_number",
  option: "design.settings_reason_option",
  color: "design.settings_reason_color",
  url: "design.settings_reason_url",
};
function reasonText(reason: string): string {
  const [kind, n] = reason.split(":");
  if (kind === "too_long") return tf("design.settings_reason_too_long", { n: n ?? "" });
  if (kind === "min") return tf("design.settings_reason_min", { n: n ?? "" });
  if (kind === "max") return tf("design.settings_reason_max", { n: n ?? "" });
  const key = REASON[kind ?? ""];
  return key ? t(key) : reason;
}

function Field(p: { s: EditorSetting; name: string; value: unknown; form?: Record<string, string> | undefined; imageAssets: string[]; error?: string | undefined }) {
  const { s, name } = p;
  const type = s.type ?? "";
  if (type === "header") return <h4>{s.content || s.label}</h4>;
  if (type === "paragraph") return <p class="muted">{s.content || s.label}</p>;
  if (!s.id || !EDITABLE_SETTING_TYPES.has(type)) return null;
  const val = p.form ? (p.form[name] ?? "") : shownValue(p.value, type);
  const id = `f-${name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  let input;
  if (type === "checkbox") {
    const on = p.form ? p.form[name] === "on" : p.value === true;
    input = <input type="checkbox" id={id} name={name} value="on" checked={on} />;
  } else if (type === "textarea" || type === "richtext" || type === "inline_richtext" || type === "html") {
    input = <textarea id={id} name={name} rows={type === "inline_richtext" ? 2 : 5} placeholder={s.placeholder}>{val}</textarea>;
  } else if (type === "number" || type === "range") {
    input = <input type="number" id={id} name={name} value={val} min={s.min} max={s.max} step={s.step ?? "any"} required={type === "range"} />;
  } else if (type === "select" || type === "radio") {
    input = (
      <select id={id} name={name}>
        {(s.options ?? []).map((o) => (
          <option value={o.value} selected={o.value === val}>
            {o.label ?? o.value}
          </option>
        ))}
      </select>
    );
  } else if (type === "image_picker") {
    input = (
      <select id={id} name={name}>
        <option value="">{t("design.settings_no_image")}</option>
        {val && !p.imageAssets.includes(val) ? (
          <option value={val} selected>
            {tf("design.settings_file_image", { value: val })}
          </option>
        ) : null}
        {p.imageAssets.map((a) => (
          <option value={a} selected={a === val}>
            {a}
          </option>
        ))}
      </select>
    );
  } else {
    input = <input type="text" id={id} name={name} value={val} placeholder={type === "color" ? "#rrggbb" : s.placeholder} maxlength={500} />;
  }
  return (
    <div class="field">
      <label for={id}>
        {s.label || s.id}
        {s.unit ? <span class="muted"> ({s.unit})</span> : null}
      </label>
      {input}
      {s.info ? <p class="muted small">{s.info}</p> : null}
      {p.error ? <p class="error small">{p.error}</p> : null}
    </div>
  );
}

/** セクションの並び（置き場ごと）: 位置・表示・足す */
function LayoutFields(p: { l: EditorLayout }) {
  const { l } = p;
  return (
    <fieldset>
      <legend>{t("design.layout_title")}</legend>
      <p class="muted small">{t("design.layout_note")}</p>
      <input type="hidden" name={layoutFieldName.present(l.key)} value="1" />
      <table>
        <tbody>
          {l.items.map((it, i) => (
            <tr>
              <td>
                <input type="number" name={layoutFieldName.position(l.key, it.id)} value={String(i + 1)} min="1" max="99" style="width:4rem" aria-label={t("design.layout_position")} />
              </td>
              <td>
                <label>
                  <input type="checkbox" name={layoutFieldName.shown(l.key, it.id)} value="on" checked={it.shown} /> {it.name}
                </label>{" "}
                <span class="muted small">
                  <code>{it.id}</code>
                  {it.added ? ` · ${t("design.layout_added")}` : ""}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {l.available.length ? (
        <div class="field">
          <label for={`la-${l.key.replace(/[^A-Za-z0-9_-]/g, "_")}`}>{t("design.layout_add")}</label>
          <select id={`la-${l.key.replace(/[^A-Za-z0-9_-]/g, "_")}`} name={layoutFieldName.add(l.key)}>
            <option value="">{t("design.layout_add_none")}</option>
            {l.available.map((a) => (
              <option value={a.type}>{a.name}</option>
            ))}
          </select>
        </div>
      ) : null}
    </fieldset>
  );
}

interface LoadedVersion {
  shop: ShopRow;
  id: string;
  name: string;
  complete: boolean;
  published: boolean;
  saved: Record<string, unknown>;
  model: EditorModel;
  fileModel: EditorModel;
}

async function load(c: AdminContext): Promise<LoadedVersion | null> {
  const shop = await loadShop(c, param(c, "shopId"), "design");
  const versionId = param(c, "versionId");
  if (!shop || !THEME_VERSION_ID.test(versionId)) return null;
  const db = owner(c).db;
  const row = await db.from<{ id: string; name: string; complete: boolean; settings: Record<string, unknown> }>("theme_versions").selectOne("id,name,complete,settings", { eq: { id: versionId, shop_id: shop.id } });
  if (!row) return null;
  const bundle = await readThemeBundle(themeStorage(c.get("adapters")), shop.id, versionId);
  if (!bundle) return null;
  const cur = await db.from<{ theme_version_id: string | null }>("shops").selectOne("theme_version_id", { eq: { id: shop.id } });
  const saved = row.settings ?? {};
  return { shop, id: row.id, name: row.name, complete: row.complete, published: cur?.theme_version_id === row.id, saved, model: editorModel(bundle, saved, getLocale()), fileModel: editorModel(bundle, layoutOnly(saved), getLocale()) };
}

function page(c: AdminContext, v: LoadedVersion, opts: { form?: Record<string, string>; errors?: Map<string, string>; flash?: "saved" | "invalid" | "too_large" } = {}) {
  const { shop, model } = v;
  const tabs = { shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "design" as const };
  const crumbs = [{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("design.title"), href: base(shop) }, { label: v.name }];
  const err = (n: string) => opts.errors?.get(n);
  const empty = model.global.length === 0 && model.sections.length === 0 && model.layouts.length === 0;
  // セクションは置き場ごとにまとめる
  const byKey = new Map<string, typeof model.sections>();
  for (const l of model.layouts) byKey.set(l.key, []);
  for (const s of model.sections) byKey.set(s.key, [...(byKey.get(s.key) ?? []), s]);
  const layoutOf = new Map(model.layouts.map((l) => [l.key, l]));
  return (
    <AdminLayout title={`${shop.name} · ${t("design.settings")}`} nav crumbs={crumbs} shopTabs={tabs}>
      <PageHead title={`${t("design.settings")}: ${v.name}`} sub={v.published ? t("design.settings_live_note") : t("design.settings_preview_note")} />
      {opts.flash === "saved" ? <p class="notice">{t("design.settings_saved")}</p> : null}
      {opts.flash === "invalid" ? <p class="error">{t("design.settings_invalid")}</p> : null}
      {opts.flash === "too_large" ? <p class="error">{t("design.settings_too_large")}</p> : null}
      {empty ? (
        <p class="muted">{t("design.settings_none")}</p>
      ) : (
        <form method="post" action={`${base(shop)}/versions/${v.id}/settings`}>
          {model.global.length ? (
            <section class="card">
              <h2>{t("design.settings_global")}</h2>
              {model.global.map((g) => (
                <fieldset>
                  {g.name ? <legend>{g.name}</legend> : null}
                  {g.settings.map((s) => (
                    <Field s={s} name={s.id ? fieldName.global(s.id) : ""} value={s.id ? model.globalValues[s.id] : undefined} form={opts.form} imageAssets={model.imageAssets} error={s.id ? err(fieldName.global(s.id)) : undefined} />
                  ))}
                </fieldset>
              ))}
            </section>
          ) : null}
          {[...byKey.entries()].map(([key, secs]) => (
            <section class="card">
              <h2>
                {t("design.settings_place")}: <code>{key}</code>
              </h2>
              {layoutOf.get(key) ? <LayoutFields l={layoutOf.get(key)!} /> : null}
              {secs.map((sec) => (
                <fieldset>
                  <legend>{sec.name}</legend>
                  {sec.settings.map((s) => {
                    const n = s.id ? fieldName.section(sec.key, sec.id, s.id) : "";
                    return <Field s={s} name={n} value={s.id ? sec.values[s.id] : undefined} form={opts.form} imageAssets={model.imageAssets} error={err(n)} />;
                  })}
                  {sec.blocks.map((b) => (
                    <fieldset>
                      <legend>{b.name}</legend>
                      {b.settings.map((s) => {
                        const n = s.id ? fieldName.block(sec.key, sec.id, b.id, s.id) : "";
                        return <Field s={s} name={n} value={s.id ? b.values[s.id] : undefined} form={opts.form} imageAssets={model.imageAssets} error={err(n)} />;
                      })}
                    </fieldset>
                  ))}
                </fieldset>
              ))}
            </section>
          ))}
          <p class="muted">{t("design.settings_scope_note")}</p>
          <p>
            <button type="submit">{t("design.settings_save")}</button> <a href={base(shop)}>{t("design.settings_back")}</a>
          </p>
        </form>
      )}
    </AdminLayout>
  );
}

designSettings.get("/:shopId/design/versions/:versionId/settings", requireOwner, async (c: AdminContext) => {
  const v = await load(c);
  if (!v) return c.text(t("shop.not_found"), 404);
  return c.html(page(c, v, c.req.query("flash") === "saved" ? { flash: "saved" } : {}));
});

designSettings.post("/:shopId/design/versions/:versionId/settings", requireOwner, async (c: AdminContext) => {
  const v = await load(c);
  if (!v) return c.text(t("shop.not_found"), 404);
  const form = await formFields(c);
  const r = settingsFromForm(v.model, form, { global: v.fileModel.globalValues, sections: v.fileModel.sections });
  if (r.ok) {
    // セクションの並び（並べ替え・外す・足す）。テーマのファイルのままなら置かない
    const layouts = layoutsFromForm(v.model, form);
    if (Object.keys(layouts).length) r.settings[SECTION_LAYOUT_KEY] = layouts;
  }
  if (!r.ok) {
    const errors = new Map(r.errors.map((e) => [e.field, reasonText(e.reason)]));
    return c.html(page(c, v, { form, errors, flash: "invalid" }), 400);
  }
  if (new TextEncoder().encode(JSON.stringify(r.settings)).byteLength > SETTINGS_MAX_BYTES) return c.html(page(c, v, { form, flash: "too_large" }), 400);
  try {
    await owner(c).db.rpc("theme_version_set_settings", { p_shop_id: v.shop.id, p_version_id: v.id, p_settings: r.settings });
  } catch (e) {
    if (e instanceof DbError && e.message.includes("theme_not_found")) return c.text(t("shop.not_found"), 404);
    throw e;
  }
  return c.redirect(`${base(v.shop)}/versions/${v.id}/settings?flash=saved`);
});
