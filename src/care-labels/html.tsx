import { t } from "../i18n";
import { CARE_CSS, type CareView } from "./care";

/**
 * 洗濯表示の HTML（既定のテーマの商品ページ・ひな形の部品 `::: current part=care`）。値はすべてエスケープされる（JSX）。
 * 記号ごとに、持ち込んだ絵があれば絵と意味の文（記号だけでは分からないお客様が多いので文も出す。絵は飾りとして alt を空に）。付記はその下に
 */
export function CareLabelsView({ care }: { care: CareView }) {
  return (
    <section class="banto-care" id="care-labels">
      <style>{CARE_CSS}</style>
      <h2>{t("care.title")}</h2>
      <ul class="banto-care__list">
        {care.symbols.map((s) => (
          <li class={`banto-care__item banto-care__item--${s.code}`}>
            {s.image ? <img src={s.image.url} alt="" width={s.image.width} height={s.image.height} loading="lazy" /> : null}
            <span class="banto-care__label">{s.label}</span>
          </li>
        ))}
      </ul>
      {care.notes.length > 0 ? (
        <ul class="banto-care__notes">
          {care.notes.map((n) => (
            <li>{n}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
