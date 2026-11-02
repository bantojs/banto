import { t } from "../../i18n";

/**
 * 「チェック（ラジオ）を選んだときだけ使われる入力欄」の落とし穴を防ぐ（選ばずに入力して保存すると、入れた値が使われない・消える）。
 *   <div data-autocheck="<name>" data-autocheck-value="<value>">…入力欄…</div>
 * この中に入力したら、同じフォームの input[name=<name>]（ラジオなら value も合うもの）にチェックを付ける。
 * チェックが無いあいだは中を薄く見せる（入力はできる。入れたらチェックが付く）。チェックやラジオ自身の操作では付けない。
 * スクリプトはページに 1 回（AutocheckScript）。スクリプトが無いときは今までどおり（チェックを付けて保存する）
 */
export function autocheckAttrs(name: string, value?: string): Record<string, string> {
  return value === undefined ? { "data-autocheck": name } : { "data-autocheck": name, "data-autocheck-value": value };
}

/** 欄の下に出す説明（「入力すると○○が選ばれます」） */
export function AutocheckHint(props: { label: string }) {
  return <p class="muted">{t("autocheck.hint").replace("{label}", props.label)}</p>;
}

export const AUTOCHECK_SCRIPT = `(function(){
  [].slice.call(document.querySelectorAll("[data-autocheck]")).forEach(function(box){
    var form=box.closest("form")||document,name=box.getAttribute("data-autocheck"),val=box.getAttribute("data-autocheck-value");
    var ctrl=[].slice.call(form.querySelectorAll("input")).filter(function(i){return i.name===name&&(val===null||i.value===val);})[0];
    if(!ctrl)return;
    function paint(){box.style.opacity=ctrl.checked?"":"0.55";}
    function use(e){var x=e&&e.target;if(x&&x.type&&(x.type==="checkbox"||x.type==="radio"))return;if(!ctrl.checked){ctrl.checked=true;ctrl.dispatchEvent(new Event("change",{bubbles:true}));}paint();}
    box.addEventListener("input",use);box.addEventListener("change",use);box.addEventListener("paste",use);
    [].slice.call(form.querySelectorAll("input")).filter(function(i){return i.name===name;}).forEach(function(i){i.addEventListener("change",paint);});
    paint();
  });
})();`;

export function AutocheckScript() {
  return <script dangerouslySetInnerHTML={{ __html: AUTOCHECK_SCRIPT }} />;
}
