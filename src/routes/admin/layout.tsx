import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { t, getLocale, type MessageKey } from "../../i18n";
import { BANTO_VERSION } from "../../version";

/**
 * 管理画面の見た目（全画面で共通）。白と黒を基調に、細い線・余白・角丸のカードで組む。
 * 素の要素（見出し・表・フォーム・ボタン・通知）にも効かせるので、各画面は class を足さなくても同じ見た目になる。
 * 色は変数で持ち、OS の設定でダークにも切り替わる。フォントは OS のもの（外部のフォントを読みに行かない）。
 * スクリプトは使わない（フォームの送信だけで操作できる作りを保つ）。
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
/* ショップのタブ */
.tabs{position:sticky;top:56px;z-index:9;display:flex;gap:.25rem;overflow-x:auto;padding:0 1rem;background:color-mix(in srgb,var(--bg) 85%,transparent);
  backdrop-filter:saturate(180%) blur(8px);border-bottom:1px solid var(--border);scrollbar-width:none}
.tabs a{position:relative;padding:.75rem .7rem;font-size:.875rem;color:var(--fg-muted);text-decoration:none;white-space:nowrap}
.tabs a:hover{color:var(--fg)}
.tabs a[aria-current=page]{color:var(--fg)}
.tabs a[aria-current=page]::after{content:"";position:absolute;left:.5rem;right:.5rem;bottom:-1px;height:2px;border-radius:2px;background:var(--fg)}
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
/* 設定の画面: 左の目次と、項目ごとのカード */
.settings{display:grid;grid-template-columns:12rem minmax(0,1fr);gap:2rem;align-items:start}
.settings>div>.card:first-child{margin-top:0}
.side-nav{position:sticky;top:120px;display:flex;flex-direction:column;gap:.1rem}
.side-nav a{padding:.4rem .65rem;border-radius:6px;font-size:.875rem;color:var(--fg-muted);text-decoration:none}
.side-nav a:hover{color:var(--fg);background:var(--bg-subtle)}
.card{scroll-margin-top:120px}
@media (max-width:900px){.settings{grid-template-columns:minmax(0,1fr)}.side-nav{position:static;flex-direction:row;flex-wrap:wrap}}
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

/** ショップの中の画面の上に出すタブ。権限の無い項目は出さない（ShopAccess は loadShop が c.set("shopAccess") に置く） */
export interface ShopTabs {
  shop: { id: string; name: string };
  access?: { role: string; perms: readonly string[] };
  active?: ShopTab;
}
export type ShopTab = "products" | "orders" | "customers" | "modules" | "plugins" | "hooks" | "tokens" | "settings";

const TABS: { id: ShopTab; path: string; label: MessageKey; perm: string }[] = [
  { id: "products", path: "/products", label: "product.list", perm: "catalog" },
  { id: "orders", path: "/orders", label: "order.list", perm: "orders" },
  { id: "customers", path: "/customers", label: "customers.title", perm: "customers" },
  { id: "modules", path: "/modules", label: "modules.title", perm: "settings" },
  { id: "plugins", path: "/plugins", label: "plugins.title", perm: "integrations" },
  { id: "hooks", path: "/hooks", label: "tabs.hooks", perm: "integrations" },
  { id: "tokens", path: "/tokens", label: "tabs.tokens", perm: "integrations" },
  { id: "settings", path: "", label: "shop.settings", perm: "any" },
];

function tabAllowed(access: ShopTabs["access"], perm: string): boolean {
  if (!access) return true;
  if (perm === "any") return true;
  return access.role === "owner" || access.role === "admin" || access.perms.includes(perm);
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

export function AdminLayout(props: { title: string; nav?: boolean; user?: string; crumbs?: Crumb[]; shopTabs?: ShopTabs; children?: Child }) {
  // パンくずの最後が今の画面でなければ（リンクなら）、題名を今の画面として足す
  const crumbs: Crumb[] = [...(props.crumbs ?? [])];
  if (crumbs.length === 0 || crumbs[crumbs.length - 1]!.href) crumbs.push({ label: props.title });
  const tabs = props.shopTabs;
  return (
    <html lang={getLocale()}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>
          {props.title} · {t("app.name")}
        </title>
        <style>{raw(css)}</style>
      </head>
      <body>
        <header class="topbar">
          <a class="brand" href="/admin">
            <span class="mark" aria-hidden="true">
              番
            </span>
            {t("app.name")}
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
          <nav class="tabs" aria-label={tabs.shop.name}>
            {TABS.filter((tb) => tabAllowed(tabs.access, tb.perm)).map((tb) => (
              <a href={`/admin/shops/${tabs.shop.id}${tb.path}`} aria-current={tabs.active === tb.id ? "page" : undefined}>
                {t(tb.label)}
              </a>
            ))}
          </nav>
        ) : null}
        <main>{props.children}</main>
        <footer>
          <p>{t("app.disclaimer")}</p>
          <p>Banto v{BANTO_VERSION} · MIT License</p>
        </footer>
      </body>
    </html>
  );
}
