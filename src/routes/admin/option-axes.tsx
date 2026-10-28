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
                <ChipsInput name={`axis.${i}.values`} values={a?.values ?? []} label={`${props.name} ${t("axes.values")} ${i + 1}`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 値をチップで入れる欄。正体は「1 行に 1 つ」の textarea（スクリプトが無ければそのまま使う）。
 * CHIPS_SCRIPT が textarea を隠してチップと入力欄を出し、チップの並びを textarea に 1 行に 1 つで書き戻す。
 * 区切りは改行だけなので、値にカンマや読点を入れられる（貼り付けたときだけ改行・タブ・カンマ・読点で分けてチップにする）
 */
export function ChipsInput(props: { name: string; values: readonly string[]; label: string; id?: string }) {
  return (
    <textarea id={props.id} name={props.name} rows={3} aria-label={props.label} data-chips="" data-chip-remove={t("axes.chip_remove")} data-chip-placeholder={t("axes.chip_placeholder")}>
      {props.values.join("\n")}
    </textarea>
  );
}

/** チップの入力のスクリプト（ページに 1 回）。固定の文字列（利用者の入力を含まない。文言は textarea の data 属性から） */
export function ChipsScript() {
  return <script dangerouslySetInnerHTML={{ __html: CHIPS_SCRIPT }} />;
}

export const CHIPS_SCRIPT = `(function(){
  function setup(ta){
    if(ta.getAttribute("data-chips-ready"))return;ta.setAttribute("data-chips-ready","1");
    var box=document.createElement("div"),input=document.createElement("input");
    box.className="chips";box.style.cssText="display:flex;flex-wrap:wrap;gap:.3rem;align-items:center;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);border-radius:.3rem;padding:.3rem";
    input.type="text";input.maxLength=60;input.placeholder=ta.getAttribute("data-chip-placeholder")||"";input.setAttribute("aria-label",ta.getAttribute("aria-label")||"");input.style.cssText="flex:1;min-width:8rem;border:0;margin:0";
    function values(){return ta.value.split(/\\r?\\n/).map(function(v){return v.trim();}).filter(Boolean);}
    function write(list){var out=[];list.forEach(function(v){v=v.trim().slice(0,60);if(v&&out.indexOf(v)<0&&out.length<100)out.push(v);});ta.value=out.join("\\n");render();}
    function render(){
      [].slice.call(box.querySelectorAll(".chip")).forEach(function(c){c.remove();});
      values().forEach(function(v,i){
        var chip=document.createElement("span"),x=document.createElement("button");
        chip.className="chip";chip.style.cssText="display:inline-flex;align-items:center;gap:.2rem;padding:.1rem .45rem;border-radius:1rem;background:color-mix(in srgb,CanvasText 10%,transparent)";
        chip.appendChild(document.createTextNode(v));
        x.type="button";x.textContent="×";x.setAttribute("aria-label",(ta.getAttribute("data-chip-remove")||"")+" "+v);x.style.cssText="border:0;background:none;padding:0 .1rem;cursor:pointer;color:inherit";
        x.addEventListener("click",function(){var l=values();l.splice(i,1);write(l);input.focus();});
        chip.appendChild(x);box.insertBefore(chip,input);
      });
    }
    function add(text){if(!text.trim())return;write(values().concat([text]));input.value="";}
    input.addEventListener("keydown",function(e){
      if(e.key==="Enter"&&!e.isComposing){e.preventDefault();add(input.value);}
      else if(e.key==="Backspace"&&!input.value){var l=values();l.pop();write(l);}
    });
    input.addEventListener("blur",function(){add(input.value);});
    input.addEventListener("paste",function(e){var t=(e.clipboardData||window.clipboardData).getData("text");if(!/[\\n\\t,、]/.test(t))return;e.preventDefault();write(values().concat(t.split(/[\\r\\n\\t,、]+/)));});
    ta.form&&ta.form.addEventListener("submit",function(){add(input.value);});
    box.appendChild(input);ta.style.display="none";ta.parentNode.insertBefore(box,ta);render();
  }
  [].slice.call(document.querySelectorAll("textarea[data-chips]")).forEach(setup);
})();`;

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
