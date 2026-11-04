/**
 * 採寸表（同梱モジュール size_charts、0095_mod_size_charts。メンテナの決定 2026-11-02、docs/size-charts.md）。
 *   - どの段（ショップ・カテゴリー・商品）の表を使うかは DB の banto_size_chart_resolve だけが決める（ここでは決めない）
 *   - ここは DB が返した結果を読む形にそろえるだけ（壊れた値は捨てる）。描くのは src/size-charts/html.tsx と Liquid
 */

export interface SizeChartColumn {
  key: string;
  label: string;
  unit: string | null;
}
export interface SizeChartRow {
  value: string;
  cells: Record<string, string>;
}
export interface SizeChartImage {
  key: string;
  width: number;
  height: number;
}
/** 表示する採寸表（上の段を含めて決めたもの） */
export interface SizeChart {
  /** 結ぶ SKU の軸の key（無ければ null）と表示名 */
  axis: string | null;
  axisName: string | null;
  columns: SizeChartColumn[];
  rows: SizeChartRow[];
  note: string | null;
  image: SizeChartImage | null;
  /** どの段の列・行か（管理画面の説明に使う） */
  sources: { columns: string | null; rows: string | null };
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const KEY = /^[a-z][a-z0-9_]{0,31}$/;

/** DB の JSON → SizeChart（列が無ければ null） */
export function sizeChartOf(raw: unknown): SizeChart | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const columns = columnsOf(r["columns"]);
  if (columns.length === 0) return null;
  const img = r["image"] as Record<string, unknown> | null | undefined;
  const image =
    img && typeof img === "object" && typeof img["key"] === "string" && typeof img["width"] === "number" && typeof img["height"] === "number"
      ? { key: img["key"], width: img["width"], height: img["height"] }
      : null;
  const src = (r["sources"] ?? {}) as Record<string, unknown>;
  return {
    axis: str(r["axis"]),
    axisName: str(r["axis_name"]) ?? str(r["axis"]),
    columns,
    rows: rowsOf(r["rows"]),
    note: str(r["note"]),
    image,
    sources: { columns: str(src["columns"]), rows: str(src["rows"]) },
  };
}

export function columnsOf(v: unknown): SizeChartColumn[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const o = c as Record<string, unknown>;
    const key = str(o["key"]);
    const label = str(o["label"]);
    return key && KEY.test(key) && label ? [{ key, label, unit: str(o["unit"]) }] : [];
  });
}

export function rowsOf(v: unknown): SizeChartRow[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const o = x as Record<string, unknown>;
    const value = str(o["value"]);
    if (!value) return [];
    const cells: Record<string, string> = {};
    const raw = o["cells"];
    if (raw && typeof raw === "object" && !Array.isArray(raw)) for (const [k, c] of Object.entries(raw)) if (typeof c === "string") cells[k] = c;
    return [{ value, cells }];
  });
}

/** 列の見出し（単位があれば「着丈（cm）」） */
export function columnHeading(c: SizeChartColumn): string {
  return c.unit ? `${c.label}（${c.unit}）` : c.label;
}

/** 選んだ SKU の options から、目立たせる行の値（軸に結んでいて、その値の行があるときだけ） */
export function selectedRowValue(chart: SizeChart, options: Record<string, unknown> | null | undefined): string | null {
  if (!chart.axis || !options) return null;
  const v = options[chart.axis];
  if (typeof v !== "string") return null;
  return chart.rows.find((r) => r.value.toLowerCase() === v.toLowerCase())?.value ?? null;
}

/**
 * 表 → 貼り付けの文字（タブ区切り。1 列目が値、続けて列の順にセル）。管理画面の「表計算から貼り付け」の初期値
 */
export function rowsToTsv(columns: readonly SizeChartColumn[], rows: readonly SizeChartRow[]): string {
  return rows.map((r) => [r.value, ...columns.map((c) => r.cells[c.key] ?? "")].join("\t")).join("\n");
}

/** 貼り付けの文字 → 行（1 行目が見出しなら飛ばす。値の無い行は飛ばす） */
export function tsvToRows(columns: readonly SizeChartColumn[], text: string): SizeChartRow[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
  const out: SizeChartRow[] = [];
  lines.forEach((line, i) => {
    // 表計算からの貼り付けはタブ区切り。タブが無ければカンマ区切りとして読む（引用符は外すだけ）
    const parts = line.split(line.includes("\t") ? "\t" : ",").map((p) => p.trim().replace(/^"(.*)"$/, "$1"));
    const value = parts[0] ?? "";
    // 見出しの行（2 列目以降が列の名前と同じ）は飛ばす
    if (i === 0 && columns.length > 0 && columns.every((c, j) => (parts[j + 1] ?? "") === c.label || (parts[j + 1] ?? "") === columnHeading(c))) return;
    if (!value) return;
    const cells: Record<string, string> = {};
    columns.forEach((c, j) => {
      const v = parts[j + 1] ?? "";
      if (v) cells[c.key] = v;
    });
    out.push({ value, cells });
  });
  return out;
}

/** 目立たせる行を選び直すスクリプト（既定のテーマ。SKU の選択欄の data-options と表の data-axis を突き合わせる） */
export const SIZE_CHART_SCRIPT = `(function(){var t=document.querySelector("table[data-size-chart]");var s=document.getElementById("sku_id");if(!t||!s)return;var ax=t.getAttribute("data-axis");if(!ax)return;
function up(){var o=s.options[s.selectedIndex];var v=null;try{v=JSON.parse(o&&o.getAttribute("data-options")||"{}")[ax]}catch(e){}
var rs=t.querySelectorAll("tr[data-value]");for(var i=0;i<rs.length;i++){var on=typeof v==="string"&&rs[i].getAttribute("data-value").toLowerCase()===v.toLowerCase();rs[i].classList.toggle("selected",on);if(on)rs[i].setAttribute("aria-current","true");else rs[i].removeAttribute("aria-current")}}
s.addEventListener("change",up);up()})();`;

/** 公開 API・ヘッドレスの形（図は URL に。セルは列の key ごと） */
export function sizeChartJson(chart: SizeChart | null, mediaUrl: (key: string) => string) {
  if (!chart) return null;
  return {
    axis: chart.axis,
    axis_name: chart.axisName,
    columns: chart.columns,
    rows: chart.rows,
    note: chart.note,
    image: chart.image ? { url: mediaUrl(chart.image.key), width: chart.image.width, height: chart.image.height } : null,
  };
}

/**
 * Liquid の product.size_chart（無ければ null）。rows[].cells は列と同じ並びの配列（{% for cell in row.cells %}）、
 * cells_by_key は列の key ごと。selected は選んだ SKU の行（軸に結んでいるときだけ）
 */
export function sizeChartLiquid(chart: SizeChart | null, mediaUrl: (key: string) => string, selected: string | null) {
  if (!chart) return null;
  return {
    axis: chart.axis,
    axis_name: chart.axisName ?? "",
    columns: chart.columns.map((c) => ({ key: c.key, label: c.label, unit: c.unit ?? "", heading: columnHeading(c) })),
    rows: chart.rows.map((r) => ({ value: r.value, cells: chart.columns.map((c) => r.cells[c.key] ?? ""), cells_by_key: r.cells, selected: r.value === selected })),
    note: chart.note ?? "",
    image: chart.image ? { src: mediaUrl(chart.image.key), url: mediaUrl(chart.image.key), width: chart.image.width, height: chart.image.height, alt: "" } : null,
  };
}
