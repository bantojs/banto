import { t, tf, type MessageKey } from "../../i18n";
import { shippingLabelsClient } from "../../modules/shipping-labels/client";
import { CLIENT_PRELUDE } from "../../modules/woo-import/admin";
import { csvCell } from "../../util/csv";
import type { AdminContext } from "./context";
import type { SearchParams } from "./search";

/**
 * CSV の書き出しの列と範囲（メンテナの決定 2026-11-09「CSV の書き出しは列と範囲を選べる」）。注文・会員・商品の一覧で共通の部品。
 *   - 範囲: この条件（一覧と同じ条件）/ すべて（条件を外して書き出す）
 *   - 列: まとまりごとに選ぶ（個人情報を含むまとまりに印）。よく使う組み合わせはボタン 1 つで書き出す
 *   - 1 行の単位: 注文は注文ごと / 明細ごと、商品は SKU ごと / 商品ごと
 *   - 形式: Excel で開ける形（BOM 付き UTF-8）/ UTF-8 / Shift_JIS。Shift_JIS はブラウザで変換する（送り状 CSV の encodeSjis を共用、
 *     変換できない文字は「?」にして画面に並べて知らせる）。スクリプトが無いと Shift_JIS は選べない
 *   - 前回の選び方はそのブラウザに覚える（localStorage。DB には置かない）
 * 列を 1 つも選ばずに開いた URL（今までの「この条件で CSV」のリンク）は、今までと同じ列で書き出す（呼び出し側の今までの形）
 */
export interface CsvColumn<R> {
  key: string;
  label: string;
  group: MessageKey;
  pii?: boolean;
  /** この単位のときだけ出す（無ければどの単位でも） */
  units?: readonly string[];
  value: (r: R) => unknown;
}

export interface CsvPreset {
  label: MessageKey;
  cols: readonly string[];
  unit?: string;
}

export type CsvFormat = "bom" | "utf8";

export interface CsvChoice<R> {
  cols: CsvColumn<R>[];
  unit: string;
  format: CsvFormat;
  preset: string | null;
}

/**
 * URL の値 → 書き出しの選び方。col も preset も無ければ null（今までの書き出し）。
 * units の最初が既定の単位。知らない列・その単位で出せない列は捨てる
 */
export function readCsvChoice<R>(c: AdminContext, all: readonly CsvColumn<R>[], units: readonly string[], presets: Record<string, CsvPreset>): CsvChoice<R> | null {
  const presetKey = c.req.query("preset") ?? "";
  const preset = Object.prototype.hasOwnProperty.call(presets, presetKey) ? presets[presetKey]! : null;
  const cols = preset ? [...preset.cols] : (c.req.queries("col") ?? []);
  if (cols.length === 0) return null;
  const unitQ = preset?.unit ?? c.req.query("unit") ?? "";
  const unit = units.includes(unitQ) ? unitQ : units[0]!;
  const picked = all.filter((col) => cols.includes(col.key) && (!col.units || col.units.includes(unit)));
  if (picked.length === 0) return null;
  return { cols: picked, unit, format: c.req.query("format") === "utf8" ? "utf8" : "bom", preset: preset ? presetKey : null };
}

/** 「すべて」を選んだら、条件を外した URL（書き出しの値だけを残す）。条件が無ければ null */
export function stripConditions(c: AdminContext, base: string, conditionKeys: readonly string[]): string | null {
  if (c.req.query("range") !== "all") return null;
  const url = new URL(c.req.url);
  if (!conditionKeys.some((k) => url.searchParams.has(k))) return null;
  for (const k of conditionKeys) url.searchParams.delete(k);
  url.searchParams.delete("range");
  return `${base}${url.search}`;
}

/** 上限で切ったとき: 書き出した件数（行の数ではなく、注文・会員・商品の数）と、その数え方 */
export interface CsvCut {
  n: number;
  what: "csvx.what_orders" | "csvx.what_members" | "csvx.what_products";
}

/**
 * 上限に届いて切ったときの最後の行（黙って切らない）。読む側が見落とさないよう、1 列目に文で入れる。
 * ファイル名にも -partial を付ける（csvName）ので、開く前にも分かる
 */
export const csvTruncatedLine = (cut: CsvCut): string => csvCell(tf("csvx.truncated", { n: cut.n.toLocaleString("ja-JP"), what: t(cut.what) })) + "\r\n";

/** ファイル名（拡張子なし）。上限で切ったら -partial を付ける */
export const csvName = (name: string, cut: CsvCut | null): string => (cut ? `${name}-partial` : name);

/** truncated を渡すと、上限で切ったことを最後の行で知らせる */
export function csvBody<R>(cols: readonly CsvColumn<R>[], rows: readonly R[], format: CsvFormat, truncated: CsvCut | null = null): string {
  const lines = [cols.map((c) => csvCell(c.label)).join(","), ...rows.map((r) => cols.map((c) => csvCell(c.value(r))).join(","))];
  return (format === "bom" ? "﻿" : "") + lines.join("\r\n") + "\r\n" + (truncated === null ? "" : csvTruncatedLine(truncated));
}

export const csvHeaders = (name: string) => ({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"`, "Cache-Control": "no-store" });

/** 一覧の下の「CSV を書き出す」の欄 */
export function CsvExportPanel<R>(props: {
  kind: string;
  action: string;
  params: SearchParams;
  columns: readonly CsvColumn<R>[];
  units?: { key: string; label: MessageKey }[];
  presets: Record<string, CsvPreset>;
  /** 既定で印を付ける列（無ければ全部） */
  defaults?: readonly string[];
  note?: string;
  /** 一度に書き出せる件数（上限で切ったら CSV の最後の行で知らせる） */
  limit?: number;
}) {
  const groups: MessageKey[] = [];
  for (const col of props.columns) if (!groups.includes(col.group)) groups.push(col.group);
  const conditions = Object.entries(props.params).filter(([, v]) => v !== "");
  const on = (key: string) => (props.defaults ? props.defaults.includes(key) : true);
  return (
    <details class="csv-export" id={`csv-${props.kind}`}>
      <summary>{t("csvx.title")}</summary>
      <form method="get" action={props.action} data-csv-export={props.kind}>
        {conditions.map(([k, v]) => (
          <input type="hidden" name={k} value={v} />
        ))}
        <fieldset class="purpose-group">
          <legend>{t("csvx.range")}</legend>
          <label class="purpose-line">
            <input type="radio" name="range" value="filtered" checked /> {conditions.length > 0 ? t("csvx.range_filtered") : t("csvx.range_all_rows")}
          </label>
          {conditions.length > 0 ? (
            <label class="purpose-line">
              <input type="radio" name="range" value="all" /> {t("csvx.range_all")}
            </label>
          ) : null}
        </fieldset>
        <fieldset class="purpose-group">
          <legend>{t("csvx.presets")}</legend>
          <div class="actions">
            {Object.entries(props.presets).map(([key, p]) => (
              <button type="submit" name="preset" value={key} class="secondary small">
                {t(p.label)}
              </button>
            ))}
          </div>
          {props.note ? <p class="muted">{props.note}</p> : null}
          {props.limit ? <p class="muted">{tf("csvx.limit_note", { n: props.limit.toLocaleString("ja-JP") })}</p> : null}
        </fieldset>
        <div class="purpose-groups">
          {groups.map((g) => (
            <fieldset class="purpose-group">
              <legend>
                {t(g)}
                {props.columns.some((col) => col.group === g && col.pii) ? <span class="badge warn">{t("purpose.pii")}</span> : null}
              </legend>
              {props.columns
                .filter((col) => col.group === g)
                .map((col) => (
                  <label class="purpose-line">
                    <input type="checkbox" name="col" value={col.key} checked={on(col.key)} /> {col.label}
                  </label>
                ))}
            </fieldset>
          ))}
        </div>
        {props.units ? (
          <label>
            {t("csvx.unit")}{" "}
            <select name="unit">
              {props.units.map((u) => (
                <option value={u.key}>{t(u.label)}</option>
              ))}
            </select>
          </label>
        ) : null}{" "}
        <label>
          {t("csvx.format")}{" "}
          <select name="format">
            <option value="bom">{t("csvx.format_bom")}</option>
            <option value="utf8">{t("csvx.format_utf8")}</option>
            <option value="sjis" disabled data-needs-script="1">
              {t("csvx.format_sjis")}
            </option>
          </select>
        </label>
        <p>
          <button type="submit">{t("csvx.submit")}</button> <span class="csvx-status" aria-live="polite"></span>
        </p>
      </form>
      <script dangerouslySetInnerHTML={{ __html: csvExportScript() }} />
    </details>
  );
}

/**
 * ブラウザの側: 前回の選び方を覚える（localStorage）、Shift_JIS は UTF-8 で受け取って変換してから保存する（送り状 CSV の encodeSjis）。
 * 固定の文字列（利用者の入力を含まない）
 */
let cached: string | null = null;
function csvExportScript(): string {
  if (cached) return cached;
  const msg = JSON.stringify({ converting: t("csvx.converting"), unmappable: t("csvx.unmappable"), failed: t("error.generic") });
  cached = `${CLIENT_PRELUDE}(function(){
  var M=${msg};
  var forms=document.querySelectorAll("form[data-csv-export]");
  var labels=null;
  function sjis(){ if(!labels){ labels=(${shippingLabelsClient.toString()})(); } return labels; }
  forms.forEach(function(form){
    var key="banto.csv."+form.getAttribute("data-csv-export");
    form.querySelectorAll("[data-needs-script]").forEach(function(o){ o.disabled=false; });
    try{
      var saved=JSON.parse(localStorage.getItem(key)||"null");
      if(saved){
        form.querySelectorAll("input[name=col]").forEach(function(i){ i.checked=saved.cols.indexOf(i.value)>=0; });
        ["unit","format"].forEach(function(n){ var s=form.querySelector("select[name="+n+"]"); if(s&&saved[n]) s.value=saved[n]; });
      }
    }catch(e){}
    form.addEventListener("submit",function(ev){
      var fd=new FormData(form);
      if(ev.submitter&&ev.submitter.name) fd.append(ev.submitter.name,ev.submitter.value);
      try{ localStorage.setItem(key,JSON.stringify({cols:fd.getAll("col"),unit:fd.get("unit"),format:fd.get("format")})); }catch(e){}
      if(fd.get("format")!=="sjis") return;
      ev.preventDefault();
      var status=form.querySelector(".csvx-status"); status.textContent=M.converting;
      fd.set("format","utf8");
      var q=new URLSearchParams(); fd.forEach(function(v,k){ q.append(k,String(v)); });
      fetch(form.action+"?"+q.toString(),{credentials:"same-origin"}).then(function(res){
        if(!res.ok) throw new Error("http");
        var name=(/filename="([^"]+)"/.exec(res.headers.get("content-disposition")||"")||[])[1]||"export.csv";
        return res.text().then(function(text){
          var enc=sjis().encodeSjis(text);
          var a=document.createElement("a"); var url=URL.createObjectURL(new Blob([enc.bytes],{type:"text/csv"}));
          a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function(){ URL.revokeObjectURL(url); },1000);
          status.textContent=enc.unmappable.length? M.unmappable+" "+enc.unmappable.join(" ") : "";
        });
      }).catch(function(){ status.textContent=M.failed; });
    });
  });
})();`;
  return cached;
}
