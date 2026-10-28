import { DbError } from "../../db/client";
import { t, tf } from "../../i18n";
import { MAX_AXES, axesLabel, optionAxesOf, type OptionAxes } from "../../products/option-axes";

/**
 * SKU を分ける軸（0065）の入力欄。ショップの既定・カテゴリー・商品の 3 か所で使う。
 *   mode: inherit（カテゴリー: 上の段を引き継ぐ）/ none（決めない）/ only_code（品番だけ）/ axes（軸で分ける）
 * 値は src/products/option-axes.ts の optionAxesFromForm で読む
 */
export function AxesEditor(props: { name: string; axes: unknown; modes: ("inherit" | "none" | "only_code" | "axes")[] }) {
  const axes = optionAxesOf(props.axes);
  const current = props.axes === null || props.axes === undefined ? props.modes[0]! : axes && axes.length === 0 ? "only_code" : "axes";
  const rows: (OptionAxes[number] | null)[] = [...(axes ?? []), ...Array<null>(MAX_AXES).fill(null)].slice(0, MAX_AXES);
  const modeLabel = { inherit: t("axes.mode_inherit"), none: t("axes.mode_none"), only_code: t("axes.mode_only_code"), axes: t("axes.mode_axes") } as const;
  return (
    <div>
      <p>
        {props.modes.map((m) => (
          <label style="display:inline-block;margin-right:1rem">
            <input type="radio" name="axes_mode" value={m} checked={current === m} /> {modeLabel[m]}
          </label>
        ))}
      </p>
      <table>
        <thead>
          <tr>
            <th>{t("axes.key")}</th>
            <th>{t("axes.values")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a, i) => (
            <tr>
              <td>
                <input type="text" name={`axis.${i}.key`} value={a?.key ?? ""} maxlength={40} aria-label={`${props.name} ${t("axes.key")} ${i + 1}`} style="width:10rem" />
              </td>
              <td>
                <input type="text" name={`axis.${i}.values`} value={(a?.values ?? []).join("、")} aria-label={`${props.name} ${t("axes.values")} ${i + 1}`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 軸の短い表示（「カラー × サイズ」・「品番だけ」・「決めていない」） */
export const axesText = (v: unknown) => axesLabel(v === null || v === undefined ? null : optionAxesOf(v), t("axes.label_only_code"), t("axes.label_none"));

/** DB の守り（0065 のトリガー）のエラー → 画面のお知らせの種類 */
export function axesErrorCode(e: unknown): "axes_mismatch" | "axes_duplicate" | "axes_invalid" | null {
  if (!(e instanceof DbError)) return null;
  if (/option_axes_mismatch/.test(e.message)) return "axes_mismatch";
  if (/option_combination_exists/.test(e.message)) return "axes_duplicate";
  if (/option_axes_check|invalid_option_axes/.test(e.message)) return "axes_invalid";
  return null;
}

/** 一括で当てた結果のお知らせ（?applied=&unchanged=&skipped=slug,slug） */
export function appliedText(q: (k: string) => string | undefined): string | null {
  const applied = q("applied");
  if (applied === undefined) return null;
  const skipped = (q("skipped") ?? "").split(",").filter(Boolean);
  return tf("axes.applied", { applied, unchanged: q("unchanged") ?? "0", skipped: skipped.length > 0 ? skipped.join("、") : t("axes.applied_none") });
}
