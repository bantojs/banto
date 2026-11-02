import { t } from "../i18n";
import { imageUrl } from "../media/images";
import { columnHeading, type SizeChart } from "./chart";

/**
 * 採寸表の HTML（既定のテーマの商品ページと、管理画面の「表示される表」の確かめ）。値はすべてエスケープされる（JSX）。
 * 軸に結んでいれば表に data-axis、行に data-value を付ける（SIZE_CHART_SCRIPT が選んだ SKU の行に .selected を付ける）
 */
export function SizeChartView(props: { chart: SizeChart; mediaBaseUrl: string; selected?: string | null; id?: string }) {
  const { chart, mediaBaseUrl, selected } = props;
  return (
    <section class="size-chart" id={props.id ?? "size-chart"}>
      <h2>{t("sizechart.heading")}</h2>
      <div class="size-chart-scroll">
        <table data-size-chart="" {...(chart.axis ? { "data-axis": chart.axis } : {})}>
          <thead>
            <tr>
              <th scope="col">{chart.axisName ?? t("sizechart.value")}</th>
              {chart.columns.map((c) => (
                <th scope="col">{columnHeading(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {chart.rows.map((r) => (
              <tr data-value={r.value} class={selected === r.value ? "selected" : undefined} aria-current={selected === r.value ? "true" : undefined}>
                <th scope="row">{r.value}</th>
                {chart.columns.map((c) => (
                  <td>{r.cells[c.key] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {chart.note ? <p class="size-chart-note">{chart.note}</p> : null}
      {chart.image ? (
        <figure class="size-chart-image">
          <img src={imageUrl(mediaBaseUrl, chart.image.key)} width={chart.image.width} height={chart.image.height} alt={t("sizechart.image_alt")} loading="lazy" decoding="async" />
        </figure>
      ) : null}
    </section>
  );
}

/** 既定のテーマの見た目（横に長い表は枠の中だけ横に動く。選んだ SKU の行はアクセントの色） */
export const SIZE_CHART_CSS =
  ".size-chart{margin-top:2rem}.size-chart-scroll{overflow-x:auto}.size-chart table{border-collapse:collapse;min-width:100%;font-size:.95rem}.size-chart th,.size-chart td{padding:.4rem .7rem;border-bottom:1px solid color-mix(in srgb,CanvasText 15%,transparent);text-align:center;white-space:nowrap}.size-chart thead th{font-weight:600}.size-chart tbody th{text-align:left}.size-chart tr.selected{background:color-mix(in srgb,var(--accent,#1f6feb) 14%,transparent);font-weight:600}.size-chart-note{white-space:pre-wrap;font-size:.9rem;opacity:.85}.size-chart-image img{max-width:100%;height:auto}.size-chart-image{margin:1rem 0}";
