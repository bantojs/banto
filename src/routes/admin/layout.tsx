import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { t, tf, getLocale, type MessageKey } from "../../i18n";
import { BANTO_VERSION } from "../../version";
import { adminBrand } from "./brand";
import { MODULES, moduleEnabled } from "../../modules/registry";

/**
 * 管理画面の見た目（全画面で共通）。白と黒を基調に、細い線・余白・角丸のカードで組む。
 * 素の要素（見出し・表・フォーム・ボタン・通知）にも効かせるので、各画面は class を足さなくても同じ見た目になる。
 * 色は変数で持ち、OS の設定でダークにも切り替わる。フォントは OS のもの（外部のフォントを読みに行かない）。
 * 操作はフォームの送信だけでできる作りを保つ。スクリプトは「コピー」のボタンだけ（COPY_SCRIPT。動かなければボタンを出さず、値は選んでコピーできる）。
 */
// 固定の文字列（利用者の入力を含まない）なので raw で出す。JSX のままだと " と > がエスケープされ、font-family や子の選択子が効かない
const css = `
:root{
  color-scheme:light dark;
  --bg:#fff;--bg-page:#fafafa;--bg-subtle:#f5f5f5;--fg:#171717;--fg-muted:#666;--border:#eaeaea;--border-strong:#d4d4d4;
  --accent:#171717;--accent-fg:#fff;--link:#0062d1;
  --ok:#107d32;--ok-bg:#ebfaef;--warn:#9a5b00;--warn-bg:#fff7e6;--err:#cb2a2f;--err-bg:#ffeeee;
  --radius:8px;--radius-lg:12px;--shadow:0 1px 2px rgba(0,0,0,.04),0 1px 1px rgba(0,0,0,.02);
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Hiragino Sans","Noto Sans JP",sans-serif;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0a0a0a;--bg-page:#000;--bg-subtle:#171717;--fg:#ededed;--fg-muted:#a1a1a1;--border:#262626;--border-strong:#3d3d3d;
  --accent:#ededed;--accent-fg:#0a0a0a;--link:#52a8ff;
  --ok:#3ecf6e;--ok-bg:#0d2a17;--warn:#f5b041;--warn-bg:#2b1f08;--err:#ff6166;--err-bg:#2f1013;
  --shadow:none;
}}
@view-transition{navigation:auto}
*{box-sizing:border-box}
body{margin:0;background:var(--bg-page);color:var(--fg);line-height:1.6;font-size:15px;-webkit-font-smoothing:antialiased}
a{color:var(--fg);text-decoration:underline;text-decoration-color:var(--border-strong);text-underline-offset:3px}
a:hover{text-decoration-color:currentColor}
p a,li a,td a,.notice a,.muted a{color:var(--link);text-decoration-color:transparent}
p a:hover,li a:hover,td a:hover{text-decoration-color:currentColor}

/* 上の帯 */
.topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:.75rem;height:56px;padding:0 1.5rem;
  background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:saturate(180%) blur(8px);border-bottom:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:.6rem;white-space:nowrap;font-weight:600;text-decoration:none;color:var(--fg);letter-spacing:-.01em}
.brand .mark{display:grid;place-items:center;width:28px;height:28px;border-radius:7px;background:var(--accent);color:var(--accent-fg);font-size:14px;font-weight:700}
.brand img.mark{background:none;object-fit:contain}
.topbar .sep{color:var(--border-strong);font-size:1.25rem;font-weight:300}
.topbar .spacer{flex:1}
.topbar .menu{display:flex;align-items:center;gap:.25rem}
.topbar .menu a{padding:.35rem .65rem;border-radius:6px;text-decoration:none;color:var(--fg-muted);font-size:.9rem}
.topbar .menu a:hover{color:var(--fg);background:var(--bg-subtle)}
.topbar .user{color:var(--fg-muted);font-size:.85rem;margin:0 .5rem;max-width:16rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.topbar form{margin:0}
.topbar button{height:32px;padding:0 .8rem;font-size:.85rem;background:var(--bg);color:var(--fg);border:1px solid var(--border-strong)}
.topbar button:hover{background:var(--bg-subtle)}

main{max-width:72rem;margin:0 auto;padding:2.5rem 1.5rem 3rem}
footer{max-width:72rem;margin:0 auto;padding:1.5rem;border-top:1px solid var(--border);font-size:.8rem;color:var(--fg-muted)}
footer p{margin:.25rem 0}

/* 文字 */
h1{font-size:1.85rem;font-weight:600;letter-spacing:-.025em;line-height:1.25;margin:0 0 1rem}
h2{font-size:1.2rem;font-weight:600;letter-spacing:-.015em;margin:2.5rem 0 .9rem}
h3{font-size:1rem;font-weight:600;margin:1.75rem 0 .6rem}
.muted{color:var(--fg-muted);font-size:.9rem}
code{font-family:var(--mono);font-size:.85em;background:var(--bg-subtle);border:1px solid var(--border);border-radius:5px;padding:.05rem .35rem}
pre{font-family:var(--mono);font-size:.85rem;background:var(--bg-subtle);border:1px solid var(--border);border-radius:var(--radius);padding:1rem;overflow:auto}
pre code{background:none;border:0;padding:0}
hr{border:0;border-top:1px solid var(--border);margin:2rem 0}

/* フォーム */
label{display:block;margin:1rem 0 .35rem;font-size:.875rem;font-weight:500}
input:not([type]),input[type=text],input[type=email],input[type=password],input[type=number],input[type=url],input[type=tel],input[type=search],
input[type=date],input[type=datetime-local],input[type=time],select,textarea{
  width:100%;max-width:32rem;min-height:40px;padding:.5rem .75rem;font:inherit;font-size:.925rem;color:var(--fg);background:var(--bg);
  border:1px solid var(--border-strong);border-radius:6px;transition:border-color .15s,box-shadow .15s}
textarea{max-width:48rem;line-height:1.5}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--fg-muted);box-shadow:0 0 0 3px color-mix(in srgb,var(--fg) 12%,transparent)}
input[type=checkbox],input[type=radio]{accent-color:var(--accent);width:16px;height:16px;vertical-align:-3px;margin-right:.35rem}
label:has(> input[type=checkbox]),label:has(> input[type=radio]){font-weight:400}
input[type=file]{font:inherit;font-size:.875rem;color:var(--fg-muted)}
input[type=file]::file-selector-button{font:inherit;font-size:.85rem;font-weight:500;height:34px;padding:0 .9rem;margin-right:.75rem;cursor:pointer;
  color:var(--fg);background:var(--bg);border:1px solid var(--border-strong);border-radius:6px}
input[type=file]::file-selector-button:hover{background:var(--bg-subtle)}
fieldset{border:1px solid var(--border);border-radius:var(--radius-lg);padding:1rem 1.25rem 1.25rem;margin:1.25rem 0;background:var(--bg)}
legend{font-weight:600;padding:0 .35rem}
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;height:38px;padding:0 1rem;font:inherit;font-size:.9rem;font-weight:500;
  cursor:pointer;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);text-decoration:none;
  transition:opacity .15s,background .15s,border-color .15s;white-space:nowrap}
button:hover,.btn:hover{opacity:.88}
button:disabled{opacity:.45;cursor:not-allowed}
.btn.secondary,button.secondary{background:var(--bg);color:var(--fg);border-color:var(--border-strong)}
.btn.secondary:hover,button.secondary:hover{opacity:1;background:var(--bg-subtle)}
button:focus-visible,.btn:focus-visible,a:focus-visible{outline:2px solid var(--link);outline-offset:2px}

/* 表 */
table{width:100%;border-collapse:separate;border-spacing:0;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;font-size:.9rem;box-shadow:var(--shadow)}
th{text-align:left;font-weight:500;font-size:.8rem;color:var(--fg-muted);background:var(--bg-subtle);padding:.6rem .9rem;border-bottom:1px solid var(--border)}
td{text-align:left;padding:.7rem .9rem;border-bottom:1px solid var(--border);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:color-mix(in srgb,var(--bg-subtle) 60%,transparent)}
@media (max-width:760px){table{display:block;overflow-x:auto}td,th{white-space:nowrap}}
code{white-space:nowrap}

/* 通知 */
.notice{padding:.85rem 1rem;border:1px solid color-mix(in srgb,var(--warn) 35%,transparent);background:var(--warn-bg);color:var(--fg);border-radius:var(--radius);margin:1rem 0;font-size:.9rem}
p.error,div.error{padding:.85rem 1rem;border:1px solid color-mix(in srgb,var(--err) 35%,transparent);background:var(--err-bg);border-radius:var(--radius);margin:1rem 0;font-size:.9rem}
.error{color:var(--err)}
.ok{color:var(--ok)}
.badge{display:inline-flex;align-items:center;gap:.35rem;font-size:.75rem;font-weight:500;padding:.1rem .55rem;border-radius:999px;border:1px solid var(--border-strong);color:var(--fg-muted);background:var(--bg);margin-left:.5rem}
.badge.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 35%,transparent);background:var(--ok-bg)}
.badge.ng{color:var(--err);border-color:color-mix(in srgb,var(--err) 35%,transparent);background:var(--err-bg)}
details{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);padding:.6rem 1rem;margin:1rem 0}
details>summary{cursor:pointer;font-weight:500;font-size:.9rem}
details[open]>summary{margin-bottom:.5rem}

/* カード（セットアップの手順・ダッシュボード） */
section.step,.card{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-lg);padding:1.25rem 1.5rem;margin:1rem 0;box-shadow:var(--shadow)}
section.step[data-state="ok"]{border-color:color-mix(in srgb,var(--ok) 45%,var(--border))}
section.step[data-state="ng"]{border-color:color-mix(in srgb,var(--err) 45%,var(--border))}
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:1.5rem}
.page-head h1{margin:0}
.page-head>div:first-child{flex:1 1 0;min-width:16rem}
.page-head .actions{display:flex;gap:.5rem;flex-wrap:wrap;flex:0 0 auto}
.page-head p{margin:.35rem 0 0;max-width:52rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(19rem,1fr));gap:1rem}
.grid .card{margin:0;display:flex;flex-direction:column;gap:.75rem;transition:border-color .15s,box-shadow .15s}
.grid .card:hover{border-color:var(--border-strong);box-shadow:0 4px 12px rgba(0,0,0,.06)}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:.75rem}
.card-title{display:flex;align-items:center;gap:.75rem;min-width:0}
.card-title a{font-weight:600;text-decoration:none;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card-title a:hover{text-decoration:underline}
.avatar{flex:none;display:grid;place-items:center;width:32px;height:32px;border-radius:50%;border:1px solid var(--border);background:var(--bg-subtle);font-size:.8rem;font-weight:600}
.status{display:inline-flex;align-items:center;gap:.4rem;font-size:.8rem;color:var(--fg-muted);white-space:nowrap}
.status::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--border-strong)}
.status.on::before{background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 20%,transparent)}
.metric{font-size:1.5rem;font-weight:600;letter-spacing:-.02em;line-height:1.2}
.metric small{font-size:.8rem;font-weight:400;color:var(--fg-muted);margin-left:.35rem}
.card-links{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:auto;padding-top:.75rem;border-top:1px solid var(--border)}
.card-links a{font-size:.825rem;padding:.2rem .55rem;border-radius:6px;text-decoration:none;color:var(--fg-muted);border:1px solid var(--border)}
.card-links a:hover{color:var(--fg);border-color:var(--border-strong)}
.quick{display:flex;flex-wrap:wrap;gap:.5rem;margin:0 0 1.5rem}
.empty{text-align:center;padding:3rem 1.5rem;border:1px dashed var(--border-strong);border-radius:var(--radius-lg);color:var(--fg-muted)}
/* パンくず（上の帯） */
.crumbs{display:flex;align-items:center;gap:.5rem;min-width:0;font-size:.9rem}
.crumbs a{color:var(--fg-muted);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:14rem}
.crumbs a:hover{color:var(--fg)}
.crumbs .here{color:var(--fg);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:18rem}
.crumbs .sep{color:var(--border-strong);font-weight:300}
/* 左の目次（ショップの中の画面）と、画面の中のタブ */
.shell{display:grid;grid-template-columns:13.5rem minmax(0,1fr);min-height:calc(100vh - 56px)}
.shell-main{min-width:0}
.sidenav{position:sticky;top:56px;align-self:start;max-height:calc(100vh - 56px);overflow:auto;padding:1rem .6rem 2rem;border-right:1px solid var(--border);background:var(--bg)}
.sidehead{padding:.15rem .6rem .8rem;font-weight:600;font-size:.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.navgroup+.navgroup{margin-top:1rem}
.navlabel{padding:0 .6rem;margin-bottom:.2rem;font-size:.72rem;font-weight:600;letter-spacing:.05em;color:var(--fg-muted)}
.sidenav a{display:block;padding:.4rem .6rem;border-radius:6px;font-size:.88rem;color:var(--fg-muted);text-decoration:none}
.sidenav a:hover{background:var(--bg-subtle);color:var(--fg)}
.sidenav a[aria-current=page]{background:var(--bg-subtle);color:var(--fg);font-weight:500}
.subtabs{display:flex;gap:.25rem;overflow-x:auto;max-width:72rem;margin:0 auto;padding:0 1.5rem;border-bottom:1px solid var(--border);scrollbar-width:none}
.subtabs a{position:relative;padding:.75rem .7rem;font-size:.875rem;color:var(--fg-muted);text-decoration:none;white-space:nowrap}
.subtabs a:hover{color:var(--fg)}
.subtabs a[aria-current=page]{color:var(--fg)}
.subtabs a[aria-current=page]::after{content:"";position:absolute;left:.5rem;right:.5rem;bottom:-1px;height:2px;border-radius:2px;background:var(--fg)}
@media (max-width:860px){.shell{grid-template-columns:minmax(0,1fr)}.sidenav{z-index:9;display:flex;gap:.2rem;max-height:none;overflow-x:auto;padding:.4rem 1rem;border-right:0;border-bottom:1px solid var(--border);scrollbar-width:none}.navgroup{display:contents}.navlabel,.sidehead{display:none}.sidenav a{white-space:nowrap}}
/* 危ない操作（削除・取り消し・キャンセル・切断・個人情報のマスク）は赤。form の送り先で決めるので、各画面は書き換えない */
button.danger,form[action*="/delete"] button,form[action*="/revoke"] button,form[action*="/cancel"] button,form[action*="/disconnect"] button,form[action*="/mask"] button{
  background:var(--bg);color:var(--err);border-color:color-mix(in srgb,var(--err) 45%,var(--border-strong))}
button.danger:hover,form[action*="/delete"] button:hover,form[action*="/revoke"] button:hover,form[action*="/cancel"] button:hover,form[action*="/disconnect"] button:hover,form[action*="/mask"] button:hover{
  opacity:1;background:var(--err);color:#fff;border-color:var(--err)}
/* 一覧: 1 列目のリンクは本文の色、状態の点の色の種類、検索の帯 */
td:first-child>a{color:var(--fg);font-weight:500;text-decoration:none}
td:first-child>a:hover{text-decoration:underline}
.status.warn::before{background:var(--warn)}
.status.info::before{background:var(--link)}
.status.off::before{background:var(--border-strong)}
.toolbar{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:0 0 1rem}
.pager{display:flex;justify-content:space-between;gap:1rem;margin:1rem 0}
.toolbar input[type=search],.toolbar input[type=text],.toolbar select{width:auto;min-width:14rem;max-width:100%;min-height:36px;padding:.35rem .7rem}
.toolbar select{min-width:9rem}
.toolbar .count{margin-left:auto;color:var(--fg-muted);font-size:.85rem}
/* 一覧の検索（src/routes/admin/search.tsx）: キーワード・並び・＋ 条件・チップ */
.search{margin:0 0 1rem}
.search-row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.search-row input[type=search]{flex:1 1 16rem;width:auto;min-height:36px;padding:.35rem .7rem;margin:0}
.search-row select{width:auto;min-width:8rem;min-height:36px;margin:0}
.search .search-more{margin:.5rem 0 0;padding:0;border:0;background:none;box-shadow:none}
.search-row button{min-height:36px}
.search-more summary{display:inline-block;cursor:pointer;font-size:.85rem;color:var(--fg-muted);padding:.2rem .6rem;border:1px solid var(--border-strong);border-radius:999px}
.search-fields{display:grid;grid-template-columns:repeat(auto-fill,minmax(12rem,1fr));gap:.5rem 1rem;margin-top:.6rem;padding:.8rem;border:1px solid var(--border);border-radius:8px;background:var(--bg)}
.search-fields label{margin:0;font-size:.8rem;color:var(--fg-muted)}
.search-fields input,.search-fields select{margin:.2rem 0 0;width:100%}
.chips{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center;margin:.6rem 0 0;font-size:.85rem}
.chip{display:inline-flex;gap:.3rem;align-items:center;padding:.15rem .6rem;border-radius:999px;border:1px solid var(--border-strong);background:var(--bg-subtle);color:var(--fg);text-decoration:none}
.chip:hover{border-color:var(--fg-muted)}
.btn.small,button.small{height:32px;padding:0 .75rem;font-size:.85rem}
/* 詳細の画面: 本体と右の列、カードの中の見出し・表・合計・項目と値 */
.split{display:grid;grid-template-columns:minmax(0,1fr) 20rem;gap:1.25rem;align-items:start}
.split>*>.card:first-child{margin-top:0}
@media (max-width:900px){.split{grid-template-columns:minmax(0,1fr)}}
.card>h2:first-child,.card>h3:first-child{margin:0 0 .9rem;font-size:1rem}
.card table{box-shadow:none}
.card>form:last-child>:last-child,.card>:last-child{margin-bottom:0}
td .status{font-size:inherit}
td:first-child>.status{color:var(--fg);font-weight:500}
td:first-child>.status>a{color:inherit;text-decoration:none}
td:first-child>.status>a:hover{text-decoration:underline}
.card-foot{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin-top:auto;padding-top:.75rem;border-top:1px solid var(--border)}
.card-foot form{margin:0}
.grid .card>p{margin:0}
/* 保存の帯（長いフォームの下に貼りつく） */
.savebar{position:sticky;bottom:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin:1rem 0;padding:.75rem 1.25rem;
  background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(8px);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:0 -4px 16px rgba(0,0,0,.04)}
.savebar label{margin:0}
.danger-zone:not(aside .danger-zone) button{width:auto}
/* 独自項目の表: 狭い画面では横に送る */
.table-scroll{overflow-x:auto}
.fields-table td{vertical-align:middle}
.fields-table th{white-space:nowrap}
.fields-table input[type=text],.fields-table select{width:100%;min-width:8rem;margin:0}
/* 設定の画面: 上級者向けの一覧 */
.setting-list{list-style:none}
.setting-list li{display:flex;flex-direction:column;gap:.15rem;padding:.7rem 0;border-bottom:1px solid var(--border)}
.setting-list li:last-child{border-bottom:0}
.card{scroll-margin-top:72px}
th.num,td.num{text-align:right;font-variant-numeric:tabular-nums}
dl.sum{display:grid;grid-template-columns:1fr auto;gap:.4rem 0;margin:1rem 0 0;font-size:.9rem}
dl.sum dt{color:var(--fg-muted)}
dl.sum dd{margin:0;padding-left:1rem;text-align:right;font-variant-numeric:tabular-nums}
dl.sum .total{color:var(--fg);font-weight:600;font-size:1rem;padding-top:.6rem;border-top:1px solid var(--border)}
dl.kv{margin:.75rem 0 0;font-size:.9rem}
dl.kv dt{font-size:.8rem;color:var(--fg-muted);margin-top:.6rem}
dl.kv dt:first-child{margin-top:0}
dl.kv dd{margin:.1rem 0 0;word-break:break-all}
.pre{white-space:pre-line}
/* コピーのボタン（Copyable）。ボタンはスクリプトが動くときだけ出る */
.copyable{position:relative}
.copyable>pre{padding-right:6.5rem}
.copyable>button.copy{position:absolute;top:.5rem;right:.5rem}
.copy-inline{display:inline-flex;align-items:center;gap:.25rem}
button.copy{height:28px;padding:0 .6rem;font-size:.8rem;background:var(--bg);color:var(--fg);border-color:var(--border-strong)}
button.copy:hover{opacity:1;background:var(--bg-subtle)}
button.copy[hidden]{display:none}
button.copy.icon{width:28px;padding:0}
button.copy svg{width:14px;height:14px;flex:none}
button.copy[data-state=done]{color:var(--ok);border-color:var(--ok)}
button.copy[data-state=failed]{color:var(--err);border-color:var(--err)}
.danger-zone{border-color:color-mix(in srgb,var(--err) 30%,var(--border))}
.danger-zone form{margin:.5rem 0}
.danger-zone button{width:100%}
/* auth: 真ん中のカード（入口の画面） */
.auth{max-width:24rem;margin:3rem auto}
.auth .card{padding:1.75rem}
.auth h1{font-size:1.5rem;text-align:center}
.auth input{max-width:none}
.auth button[type=submit]{width:100%;margin-top:.5rem}
.auth .below{text-align:center;font-size:.875rem;margin-top:1.25rem}
.narrow{max-width:48rem;margin:0 auto}
/* 表の中の折りたたみ（行の操作）は枠なし */
td details{border:0;background:none;padding:0;margin:0}
td details>summary{color:var(--fg-muted);font-size:.85rem}
td details>summary:hover{color:var(--fg)}
td details form{margin:.4rem 0}
td form select,td form input{width:auto}
@media (max-width:640px){main{padding:1.5rem 1rem 2rem}.topbar{padding:0 1rem}.topbar .user,.topbar .menu a,.crumbs a,.crumbs .sep{display:none}h1{font-size:1.5rem}}
`;

/** パンくずの 1 段。href が無いものは今の画面 */
export interface Crumb {
  label: Child;
  href?: string;
}

/**
 * ショップの中の画面の左の目次と、画面の中のタブ（メンテナの決定 2026-11-08「目次は仕事ごと」）。
 * 権限の無い項目と OFF の同梱モジュールは出さない（ShopAccess は loadShop が c.set("shopAccess") に置く）
 */
export interface ShopTabs {
  /** settings があれば、ON の同梱モジュールの項目も出す */
  shop: { id: string; name: string; settings?: Record<string, unknown> | null };
  access?: { role: string; perms: readonly string[] };
  active?: ShopTab;
  /** 今いる画面（目次と画面の中のタブのどこを選ぶか）。active で決まらない画面（同梱モジュールなど）で渡す */
  here?: ShopHere;
}
export type ShopTab = "products" | "orders" | "customers" | "inquiries" | "pages" | "blog" | "design" | "modules" | "plugins" | "hooks" | "tokens" | "settings";
export type ShopHere =
  | ShopTab
  | "shipping-labels"
  | "categories"
  | "size-charts"
  | "care-labels"
  | "woo-import"
  | "audiences"
  | "member-prices"
  | "store-tryon"
  | "coupons"
  | "dialogs"
  | "line-messaging"
  | "product-feed"
  | "ga4"
  | "layouts"
  | "embed"
  | "receipt"
  | "product-fields"
  | "customer-fields"
  | "settings-shipping"
  | "settings-payments"
  | "settings-members"
  | "settings-advanced";

/** 目次の 1 項目の中の画面（画面の中のタブ）。同梱モジュールの項目に要る権限はモジュールの一覧（registry の perm）から引く */
interface NavSub {
  id: ShopHere;
  path: string;
  label: MessageKey;
  perm: string;
  module?: string;
}
interface NavItem {
  label: MessageKey;
  subs: NavSub[];
}

const page = (id: ShopHere, path: string, label: MessageKey, perm: string): NavSub => ({ id, path, label, perm });
/** 同梱モジュールの画面（/modules/<adminPath>） */
const mod = (id: ShopHere, moduleId: string, label: MessageKey, sub = ""): NavSub => {
  const m = MODULES.find((x) => x.id === moduleId);
  return { id, path: `/modules/${m?.adminPath ?? moduleId}${sub}`, label, perm: m?.perm ?? "settings", module: moduleId };
};

const NAV: { label: MessageKey; items: NavItem[] }[] = [
  {
    label: "nav.group.daily",
    items: [
      { label: "order.list", subs: [page("orders", "/orders", "order.list", "orders"), mod("shipping-labels", "shipping_labels", "mod.shipping_labels.name")] },
      {
        label: "product.list",
        subs: [
          page("products", "/products", "product.list", "catalog"),
          page("categories", "/categories", "category.title", "catalog"),
          page("product-fields", "/fields", "fields.title", "catalog+settings"),
          mod("size-charts", "size_charts", "sizechart.title"),
          mod("care-labels", "care_labels", "mod.care_labels.name"),
          mod("woo-import", "woo_import", "mod.woo_import.name"),
        ],
      },
      { label: "customers.title", subs: [page("customers", "/customers", "customers.title", "customers"), page("customer-fields", "/customer-fields", "customer_fields.title", "customers+settings"), mod("audiences", "audiences", "aud.title"), mod("member-prices", "audiences", "mprice.title", "/prices")] },
      { label: "mod.inquiries.name", subs: [mod("inquiries", "inquiries", "mod.inquiries.name")] },
      { label: "mod.store_tryon.name", subs: [mod("store-tryon", "store_tryon", "mod.store_tryon.name")] },
    ],
  },
  {
    label: "nav.group.marketing",
    items: [
      { label: "mod.coupons.name", subs: [mod("coupons", "coupons", "mod.coupons.name")] },
      { label: "mod.dialogs.name", subs: [mod("dialogs", "dialogs", "mod.dialogs.name")] },
      { label: "linemsg.title", subs: [page("line-messaging", "/line-messaging", "linemsg.title", "integrations")] },
      { label: "mod.product_feed.name", subs: [mod("product-feed", "product_feed", "mod.product_feed.name")] },
      { label: "mod.ga4.name", subs: [mod("ga4", "ga4", "mod.ga4.name")] },
    ],
  },
  {
    label: "nav.group.store",
    items: [
      { label: "design.title", subs: [page("design", "/design", "design.title", "design")] },
      { label: "nav.content", subs: [mod("pages", "pages", "mod.pages.name"), mod("blog", "blog", "mod.blog.name"), mod("layouts", "pages", "pages.layouts", "/layouts")] },
      { label: "mod.embed.name", subs: [mod("embed", "embed", "mod.embed.name")] },
    ],
  },
  {
    label: "nav.group.extend",
    items: [
      { label: "modules.title", subs: [page("modules", "/modules", "modules.title", "settings")] },
      { label: "nav.connections", subs: [page("hooks", "/hooks", "tabs.hooks", "integrations"), page("plugins", "/plugins", "plugins.title", "integrations"), page("tokens", "/tokens", "tabs.tokens", "integrations")] },
    ],
  },
  {
    label: "nav.group.shop",
    items: [
      {
        label: "shop.settings",
        subs: [
          page("settings", "", "settings.tab_general", "any"),
          page("settings-shipping", "/settings/shipping", "settings.tab_shipping", "settings"),
          page("settings-payments", "/settings/payments", "settings.tab_payments", "settings"),
          page("settings-members", "/settings/members", "settings.tab_members", "admin|integrations"),
          mod("receipt", "receipt", "mod.receipt.name"),
          page("settings-advanced", "/settings/advanced", "settings.tab_advanced", "settings"),
        ],
      },
    ],
  },
];

/** その人に見せる画面（権限の項目があり、同梱モジュールなら ON のもの） */
function visibleSubs(tabs: ShopTabs, item: NavItem): NavSub[] {
  return item.subs.filter((s) => tabAllowed(tabs.access, s.perm) && (!s.module || moduleEnabled(tabs.shop.settings, s.module)));
}

/** 左の目次 */
function SideNav(props: { tabs: ShopTabs; here: ShopHere | undefined }) {
  const { tabs, here } = props;
  const base = `/admin/shops/${tabs.shop.id}`;
  return (
    <nav class="sidenav" aria-label={tabs.shop.name}>
      <div class="sidehead">{tabs.shop.name}</div>
      {NAV.map((g) => {
        const items = g.items.map((it) => ({ it, subs: visibleSubs(tabs, it) })).filter((x) => x.subs.length > 0);
        if (items.length === 0) return null;
        return (
          <div class="navgroup">
            <div class="navlabel">{t(g.label)}</div>
            {items.map(({ it, subs }) => (
              <a href={`${base}${subs[0]!.path}`} aria-current={subs.some((s) => s.id === here) ? "page" : undefined}>
                {t(it.label)}
              </a>
            ))}
          </div>
        );
      })}
    </nav>
  );
}

/** 画面の中のタブ（目次の 1 項目に画面が 2 つ以上あるとき） */
function SubTabs(props: { tabs: ShopTabs; here: ShopHere | undefined }) {
  const { tabs, here } = props;
  const item = NAV.flatMap((g) => g.items).find((it) => it.subs.some((s) => s.id === here));
  if (!item) return null;
  const subs = visibleSubs(tabs, item);
  if (subs.length < 2) return null;
  return (
    <nav class="subtabs" aria-label={t(item.label)}>
      {subs.map((s) => (
        <a href={`/admin/shops/${tabs.shop.id}${s.path}`} aria-current={s.id === here ? "page" : undefined}>
          {t(s.label)}
        </a>
      ))}
    </nav>
  );
}

/** perm: 権限の項目（"a|b" はどれか 1 つ、"a+b" は両方）、"admin" = 組織の owner / admin、"any" = だれでも */
function tabAllowed(access: ShopTabs["access"], perm: string): boolean {
  if (!access) return true;
  if (perm === "any") return true;
  return access.role === "owner" || access.role === "admin" || perm.split("|").some((alt) => alt.split("+").every((p) => access.perms.includes(p)));
}

/**
 * コピーのボタン。押すと値をクリップボードに入れ、「コピーしました」に変わる。
 * http の画面（安全な接続でない）など Clipboard API が使えないときは、値を選んだ状態にして execCommand で試す。
 * 固定の文字列なので raw で出す（利用者の入力を含まない）。
 */
const COPY_SCRIPT = `(function(){
  function label(b,key){var l=b.querySelector(".copy-label");var v=b.getAttribute(key);if(l)l.textContent=v;else{b.setAttribute("aria-label",v);b.title=v;}}
  function pick(b){var el=document.getElementById(b.getAttribute("data-copy-target")||"");if(!el)return false;var r=document.createRange();r.selectNodeContents(el);var s=window.getSelection();s.removeAllRanges();s.addRange(r);try{return document.execCommand("copy");}catch(e){return false;}}
  function show(b,ok){b.setAttribute("data-state",ok?"done":"failed");label(b,ok?"data-done":"data-failed");clearTimeout(b._t);b._t=setTimeout(function(){b.removeAttribute("data-state");label(b,"data-label");},2000);}
  document.querySelectorAll("button.copy[data-copy]").forEach(function(b){
    b.hidden=false;
    b.addEventListener("click",function(){
      var v=b.getAttribute("data-copy");
      if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(v).then(function(){show(b,true);},function(){show(b,pick(b));});}
      else show(b,pick(b));
    });
  });
})();`;

let copySeq = 0;

const COPY_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" />
  </svg>
);

/**
 * 値とコピーのボタン。block は <pre>（鍵・トークン・設定の JSON）、inline は <code>（変数の名前）の横に小さなボタン。
 * name はボタンの読み上げに使う（inline は文字を出さないため）。
 */
export function Copyable(props: { value: string; inline?: boolean; name?: string }) {
  const id = `copy-${++copySeq}`;
  const what = props.name ?? props.value;
  const common = {
    type: "button" as const,
    class: props.inline ? "copy icon" : "copy",
    hidden: true,
    "data-copy": props.value,
    "data-copy-target": id,
    "data-label": props.inline ? tf("copy.named", { name: what }) : t("copy.button"),
    "data-done": t("copy.done"),
    "data-failed": t("copy.failed"),
  };
  if (props.inline) {
    return (
      <span class="copy-inline">
        <code id={id}>{props.value}</code>
        <button {...common} aria-label={tf("copy.named", { name: what })} title={tf("copy.named", { name: what })}>
          {COPY_ICON}
        </button>
      </span>
    );
  }
  return (
    <div class="copyable">
      <pre id={id}>{props.value}</pre>
      <button {...common} aria-label={props.name ? tf("copy.named", { name: what }) : undefined}>
        {COPY_ICON}
        <span class="copy-label">{t("copy.button")}</span>
      </button>
    </div>
  );
}

/** 画面の題名と、右に並べる操作（作成のボタンなど）。Vercel のダッシュボードと同じ並び */
export function PageHead(props: { title: Child; sub?: Child; children?: Child }) {
  return (
    <div class="page-head">
      <div>
        <h1>{props.title}</h1>
        {props.sub ? <p class="muted">{props.sub}</p> : null}
      </div>
      {props.children ? <div class="actions">{props.children}</div> : null}
    </div>
  );
}

function Footer() {
  return (
    <footer>
      <p>{t("app.disclaimer")}</p>
      <p>Banto v{BANTO_VERSION} · MIT License</p>
    </footer>
  );
}

export function AdminLayout(props: { title: string; nav?: boolean; user?: string; crumbs?: Crumb[]; shopTabs?: ShopTabs; children?: Child }) {
  // パンくずの最後が今の画面でなければ（リンクなら）、題名を今の画面として足す
  const crumbs: Crumb[] = [...(props.crumbs ?? [])];
  if (crumbs.length === 0 || crumbs[crumbs.length - 1]!.href) crumbs.push({ label: props.title });
  const tabs = props.shopTabs;
  const brand = adminBrand();
  // doctype が無いとブラウザは互換モード（quirks mode）で描く。JSX では書けないので raw で先頭に置く
  return (
    <>
      {raw("<!doctype html>")}
      <html lang={getLocale()}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>
          {props.title} · {brand.name}
        </title>
        <style>{raw(css)}</style>
      </head>
      <body>
        <header class="topbar">
          <a class="brand" href="/admin">
            {brand.icon ? (
              <img class="mark" src={brand.icon} alt="" width={28} height={28} />
            ) : (
              <span class="mark" aria-hidden="true">
                {brand.mark}
              </span>
            )}
            {brand.name}
          </a>
          <nav class="crumbs" aria-label="breadcrumb">
            {crumbs.map((cr) => (
              <>
                <span class="sep" aria-hidden="true">
                  /
                </span>
                {cr.href ? <a href={cr.href}>{cr.label}</a> : <span class="here">{cr.label}</span>}
              </>
            ))}
          </nav>
          <span class="spacer"></span>
          {props.nav ? (
            <nav class="menu">
              <a href="/admin">{t("nav.dashboard")}</a>
              {props.user ? <span class="user">{props.user}</span> : null}
              <a href="/admin/mfa/setup">{t("nav.mfa")}</a>
              <form method="post" action="/admin/logout">
                <button type="submit">{t("nav.logout")}</button>
              </form>
            </nav>
          ) : null}
        </header>
        {tabs ? (
          <div class="shell">
            <SideNav tabs={tabs} here={tabs.here ?? tabs.active} />
            <div class="shell-main">
              <SubTabs tabs={tabs} here={tabs.here ?? tabs.active} />
              <main>{props.children}</main>
              <Footer />
            </div>
          </div>
        ) : (
          <>
            <main>{props.children}</main>
            <Footer />
          </>
        )}
        <script>{raw(COPY_SCRIPT)}</script>
      </body>
      </html>
    </>
  );
}
