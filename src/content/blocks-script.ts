/**
 * ページの編集画面の操作（同梱モジュール pages、docs/pages.md「編集の画面」）。WordPress のブロックの編集に寄せた手助けで、
 * 見たままの編集（pageEditorClient）の上に重ねる。保存するものは変わらない（決まった書式の本文と、フォームの欄だけ）。
 *
 * - ブロックの挿入: 上の「＋」・空の行の右の「＋」・ブロックのあいだにマウスを置くと出る「＋」（探す欄と図の並びの一覧）と、
 *   空の段落の頭で「/」を打つと出る一覧（続けて打つと絞り込む）
 * - 選んだブロックの上に道具: 種類を変える（段落・見出し・引用・箇条書き）・ドラッグと上下で動かす・太字・斜体・リンク・
 *   設定（商品・ボタン）・その他（前後に追加・複製・消す）。入力しているあいだは隠す
 * - 空の行には案内の文字。商品のブロックは並ぶ商品の見本と件数を出す（0 件なら赤で。…/products-preview）
 * - 画像のブロック: 置き場へ上げて、選んでいた場所に入れる（下の「画像を置く」のフォームを使う）
 * - タイトルから URL の名前を作る（新しいページで名前を手で入れるまで。英数字にならないタイトルは空のまま → 保存のときにサーバーが作る）
 * - 保存していない変更があれば離れる前に知らせる。Ctrl+S（⌘S）で保存（下書きなら下書き保存、公開中なら更新）
 *
 * JS の無いブラウザでは何もしない（フォームはそのまま使える）。文言は data-* で受け取る。
 * テンプレート文字列に入れるので、中では逆引用符とドルと波括弧の組を使わない。
 */
export const PAGE_BLOCKS_SCRIPT = String.raw`
(function(){
  var form=document.getElementById("page-form"); if(!form) return;
  var ed=document.getElementById("body-visual"), ta=document.getElementById("body");
  var title=document.getElementById("title"), handle=document.getElementById("handle"), urlShow=document.getElementById("handle-show");
  var T=function(k){ return form.getAttribute("data-t-"+k)||""; };
  var dirty=false; var mark=function(){ dirty=true; };
  form.addEventListener("input",mark); form.addEventListener("change",mark);
  if(ed) ed.addEventListener("input",mark);
  form.addEventListener("submit",function(){ dirty=false; });
  window.addEventListener("beforeunload",function(e){ if(dirty){ e.preventDefault(); e.returnValue=""; } });
  document.addEventListener("keydown",function(e){
    if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&!e.altKey&&(e.key==="s"||e.key==="S")){
      var b=form.querySelector("[data-save]"); if(b){ e.preventDefault(); if(form.requestSubmit) form.requestSubmit(b); else b.click(); }
    }
  });

  // タイトル → URL の名前（英数字だけ。予約の名前は避ける）
  var RESERVED=(form.getAttribute("data-reserved")||"").split(",");
  function slug(s){
    var x=String(s||"").normalize("NFKD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,64).replace(/-+$/,"");
    return RESERVED.indexOf(x)>=0?"":x;
  }
  function showUrl(){ if(urlShow&&handle) urlShow.textContent=handle.value||T("handle-auto"); }
  if(title&&handle){
    var auto=handle.getAttribute("data-auto")==="1";
    title.addEventListener("input",function(){ if(auto){ handle.value=slug(title.value); showUrl(); } });
    handle.addEventListener("input",function(){ auto=false; showUrl(); });
    showUrl();
  }
  if(!ed) return;

  // ---------- ブロック ----------
  // 改行で段落（p）を作り、空の本文は空の段落から始める（ブロックの単位をそろえる）
  try{ document.execCommand("defaultParagraphSeparator",false,"p"); }catch(_){}
  function wrapLoose(){ wrapIn(ed); Array.prototype.forEach.call(ed.querySelectorAll("[data-slot]"),function(x){ if(x.getAttribute("data-slot")!=="cols") wrapIn(x); }); }
  function wrapIn(box){
    var loose=Array.prototype.filter.call(box.childNodes,function(n){ return n.nodeType===3?/\S/.test(n.nodeValue||""):(n.nodeType===1&&/^(B|STRONG|I|EM|A|CODE|SPAN|IMG|BR)$/.test(n.nodeName)); });
    if(!loose.length) return;
    var s=window.getSelection(), at=s&&s.rangeCount?s.anchorNode:null, off=s&&s.rangeCount?s.anchorOffset:0;
    var p=document.createElement("p"); box.insertBefore(p,loose[0]);
    loose.forEach(function(n){ p.appendChild(n); });
    if(at&&p.contains(at)){ var r=document.createRange(); r.setStart(at,Math.min(off,at.nodeType===3?(at.nodeValue||"").length:at.childNodes.length)); r.collapse(true); s.removeAllRanges(); s.addRange(r); }
  }
  if(!(ed.textContent||"").trim()&&!ed.querySelector("img,hr,table,[data-banto-block]")) ed.innerHTML="<p><br></p>";
  ed.addEventListener("input",wrapLoose);

  // 図（線画。決まった文字列だけを innerHTML に入れる）
  function svg(d){ return '<svg class="blk-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+d+'</svg>'; }
  var ICO={
    p:'<path d="M13 4v16M17 4v16M19 4H9.5a4.5 4.5 0 0 0 0 9H13"/>',
    h2:'<path d="M4 6v12M12 6v12M4 12h8"/><path d="M15 10.5a2.5 2.5 0 0 1 5 0c0 2-5 3.5-5 7.5h5"/>',
    h3:'<path d="M4 6v12M12 6v12M4 12h8"/><path d="M15 8h5l-3 4a3 3 0 1 1-2.5 5"/>',
    ul:'<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
    ol:'<path d="M10 6h10M10 12h10M10 18h10M4 4h1v4M4 8h2M4 14h2l-2 3h2"/>',
    q:'<path d="M6 17h3l2-4V7H5v6h3zM14 17h3l2-4V7h-6v6h3z"/>',
    hr:'<path d="M3 12h18M7 7h10M7 17h10" />',
    table:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M10 4v16"/>',
    img:'<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
    products:'<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    button:'<rect x="3" y="8" width="18" height="8" rx="4"/><path d="M9 12h6"/>',
    more:'<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
    drag:'<circle cx="9" cy="6" r="1.1"/><circle cx="15" cy="6" r="1.1"/><circle cx="9" cy="12" r="1.1"/><circle cx="15" cy="12" r="1.1"/><circle cx="9" cy="18" r="1.1"/><circle cx="15" cy="18" r="1.1"/>',
    up:'<path d="M12 19V5M6 11l6-6 6 6"/>',
    down:'<path d="M12 5v14M6 13l6 6 6-6"/>',
    link:'<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    edit:'<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
    articles:'<rect x="3" y="4" width="8" height="7" rx="1"/><rect x="13" y="4" width="8" height="7" rx="1"/><path d="M3 15h8M3 19h6M13 15h8M13 19h6"/>',
    pattern:'<rect x="3" y="3" width="18" height="7" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
    back:'<path d="M15 5l-7 7 7 7"/>',
    list:'<path d="M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1"/>',
    side:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    close:'<path d="M6 6l12 12M18 6L6 18"/>',
    group:'<rect x="3" y="5" width="18" height="14" rx="2" stroke-dasharray="3 2"/>',
    columns:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5v14"/>',
    column:'<rect x="7" y="4" width="10" height="16" rx="2"/>',
    cover:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 11h10M9 14.5h6"/>',
    media:'<rect x="3" y="6" width="8" height="12" rx="1"/><path d="M14 8h7M14 12h7M14 16h5"/>',
    gallery:'<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
    accordion:'<rect x="3" y="4" width="18" height="6" rx="1"/><path d="M3 14h18M3 19h18M15 6.5l1.5 1.5 1.5-1.5"/>',
    spacer:'<path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4"/>',
    parent:'<path d="M9 14l-5-5 5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v5"/>'
  };
  // レイアウトのブロック（src/pages/layout.ts の値と既定・文言。サーバーが data-layout に入れる）
  var LAY={}; try{ LAY=JSON.parse(form.getAttribute("data-layout")||"{}"); }catch(_){}
  var LS=LAY.schema||{}, LTX=LAY.t||{}, DEPTH=LAY.depth||4;
  function LT(k){ return LTX[k]||""; }
  var CONT={group:1,columns:1,column:1,cover:1,media:1,gallery:1,accordion:1};
  // 文字を書けない箱（押すと選ぶ）
  var BOXES={products:1,button:1,spacer:1,gallery:1,articles:1};
  // テーマのパターン・スタイル（サーバーが data-* の JSON で渡す。パターンの本文は選んだときに受け取る）
  var PATTERNS=[], STYLES={}; try{ PATTERNS=JSON.parse(form.getAttribute("data-patterns")||"[]"); STYLES=JSON.parse(form.getAttribute("data-styles")||"{}"); }catch(_){}
  var HAS_ARTICLES=!!document.getElementById("blk-articles");
  // ブロックの一覧（一覧の順・まとまり）
  var BLOCKS=[
    ["p","text"],["h2","text"],["h3","text"],["ul","text"],["ol","text"],["q","text"],["table","text"],["accordion","text"],
    ["img","media"],["gallery","media"],["cover","media"],["media","media"],
    ["group","design"],["columns","design"],["spacer","design"],["hr","design"],
    ["products","shop"],["articles","shop"],["button","shop"]
  ].filter(function(x){ return (!(CONT[x[0]]||x[0]==="spacer")||LS[x[0]])&&(x[0]!=="articles"||HAS_ARTICLES); }).map(function(x){ var lay=!!LS[x[0]]; return {k:x[0],g:x[1],label:lay?LT("kind."+x[0]):T(x[0]),desc:lay?LT("desc."+x[0]):T("d-"+x[0])}; })
   .concat(PATTERNS.map(function(p){ return {k:"pattern:"+p.name,g:p.source==="theme"?"theme":"patterns",label:p.title,desc:p.description||"",pattern:p.name}; }));
  function nameOf(k){ return LS[k]?LT("kind."+k):T(k); }
  var TEXTY={p:1,h2:1,h3:1,ul:1,ol:1,q:1};
  function kindOf(el){
    if(!el||el.nodeType!==1) return "";
    var n=el.nodeName, bk=el.getAttribute("data-banto-block");
    if(bk&&(CONT[bk]||bk==="spacer"||bk==="products"||bk==="articles")) return bk;
    if(n==="P"&&/(^|\s)banto-button(\s|$)/.test(el.className)) return "button";
    if(n==="H1"||n==="H2") return "h2";
    if(/^H[3-6]$/.test(n)) return "h3";
    if(n==="UL") return "ul"; if(n==="OL") return "ol"; if(n==="BLOCKQUOTE") return "q"; if(n==="HR") return "hr";
    if(n==="TABLE"||el.querySelector("table")) return "table";
    if(!(el.textContent||"").trim()&&el.querySelector("img")) return "img";
    return "p";
  }
  function isEmpty(el){ return !!el&&el.nodeName==="P"&&!(el.textContent||"").trim()&&!el.querySelector("img")&&!/banto-button/.test(el.className); }
  // ---------- 入れ子（ブロックはスロットの子。スロット = 本文・グループ・列・カバーの中・画像と文の文・アコーディオンの中。
  // カラムの列の並びは data-slot="cols" で、列だけを置く） ----------
  function isSlot(x){ return x===ed||(!!x&&x.nodeType===1&&x.hasAttribute("data-slot")); }
  function isCols(x){ return !!x&&x!==ed&&x.nodeType===1&&x.getAttribute("data-slot")==="cols"; }
  function isBlock(b){ return !!b&&b.nodeType===1&&b!==ed&&!!b.parentNode&&ed.contains(b)&&isSlot(b.parentNode); }
  function blockOf(n){ while(n&&n!==ed){ if(n.nodeType===1&&isSlot(n.parentNode)) return n; n=n.parentNode; } return null; }
  // スロットを持つ囲み（グループ・列・カラムは自分、カバーなどは外側）
  function ownerOf(slot){ if(!slot||slot===ed) return null; return slot.hasAttribute("data-banto-block")?slot:blockOf(slot); }
  // x から外へ数えた囲みの数（x が囲みなら x も数える）
  function depthOf(x){ var d=0; for(var n=x;n&&n!==ed;n=n.parentNode){ if(n.nodeType===1&&CONT[n.getAttribute("data-banto-block")]) d++; } return d; }
  // b の中の囲みの段の数（b が囲みなら 1 から）
  function heightOf(b){ var base=depthOf(b.parentNode), m=CONT[kindOf(b)]?1:0; Array.prototype.forEach.call(b.querySelectorAll("[data-banto-block]"),function(x){ if(CONT[x.getAttribute("data-banto-block")]) m=Math.max(m,depthOf(x)-base); }); return m; }
  function slotsOf(b){ var k=kindOf(b); if(k==="group"||k==="column"||k==="columns") return [b]; var s=b.querySelector(":scope > [data-slot]"); return s?[s]:[]; }
  // 囲みの class（変換 src/pages/markdown.ts と同じ形）
  function cls(d){
    var k=d.getAttribute("data-banto-block"), g=function(x){ return d.getAttribute("data-"+x)||""; }, keep=d.classList.contains("is-sel");
    var c={group:"banto-group banto-bg-"+g("bg")+" banto-pad-"+g("pad"),columns:"banto-columns banto-cols-"+g("ratio")+" banto-valign-"+g("valign"),column:"banto-column",
      cover:"banto-cover banto-cover--h-"+g("height")+" banto-cover--overlay-"+g("overlay")+" banto-align-"+g("align")+" banto-valign-"+g("valign")+" banto-cover--focus-"+g("focus"),media:"banto-media banto-media--"+g("side")+" banto-valign-"+g("valign"),
      gallery:"banto-gallery banto-gallery--"+g("cols"),accordion:"banto-accordion banto-accordion--"+g("icon"),spacer:"banto-spacer banto-spacer--"+g("size")}[k];
    var stl=g("style"); if(c) d.className=c+(stl&&/^[a-z0-9][a-z0-9-]{0,29}$/.test(stl)?" banto-style-"+stl:"")+(keep?" is-sel":"");
  }
  var RATIO_OF={2:"1-1",3:"1-1-1",4:"1-1-1-1"};
  // カラムの列の数を比に合わせる（減らすときは中身を前の列へ寄せる）
  function syncCols(d){
    var n=(d.getAttribute("data-ratio")||"1-1").split("-").length;
    while(d.children.length<n) d.appendChild(mk("column"));
    while(d.children.length>n){ var last=d.lastElementChild, prev=last.previousElementSibling; Array.prototype.slice.call(last.childNodes).forEach(function(x){ if(!(x.nodeType===1&&isEmpty(x))) prev.appendChild(x); }); d.removeChild(last); }
  }
  // 列を足した・消したあと: 1 列なら囲みを外し、数に合わない比は既定に
  function fixCols(d){
    if(!d||!d.parentNode) return;
    var n=d.children.length;
    if(n===0){ d.parentNode.removeChild(d); return; }
    if(n===1){ var only=d.firstElementChild; while(only.firstChild) d.parentNode.insertBefore(only.firstChild,d); d.parentNode.removeChild(d); return; }
    if((d.getAttribute("data-ratio")||"").split("-").length!==n){ d.setAttribute("data-ratio",RATIO_OF[Math.min(n,4)]); cls(d); }
  }
  // 空のスロットには段落を、列の無いカラムは消す
  function tidy(){
    Array.prototype.forEach.call(ed.querySelectorAll("[data-slot=cols]"),fixCols);
    Array.prototype.forEach.call(ed.querySelectorAll("[data-slot]"),function(x){ if(!isCols(x)&&!x.children.length) x.appendChild(emptyP()); });
    if(!ed.children.length) ed.appendChild(emptyP());
  }
  // 新しい囲み（中に書き始める段落を入れる）
  function mk(kind){
    var d=document.createElement("div"); d.setAttribute("data-banto-block",kind);
    var sc=LS[kind]||{}; Object.keys(sc).forEach(function(k){ d.setAttribute("data-"+k,sc[k].def); });
    var slotDiv=function(c,first){ var x=el("div",c); x.setAttribute("data-slot",""); x.appendChild(first||emptyP()); return x; };
    if(kind==="group"||kind==="column"){ d.setAttribute("data-slot",""); d.appendChild(emptyP()); }
    else if(kind==="columns"){ d.setAttribute("data-slot","cols"); syncCols(d); }
    else if(kind==="cover"){ var h=document.createElement("h2"); h.appendChild(document.createElement("br")); d.appendChild(slotDiv("banto-cover__inner",h)); }
    else if(kind==="media"){ var f=el("figure","banto-media__fig"); f.setAttribute("contenteditable","false"); f.setAttribute("data-ph",LT("media_empty")); d.appendChild(f); d.appendChild(slotDiv("banto-media__body")); }
    else if(kind==="gallery"){ d.setAttribute("contenteditable","false"); d.setAttribute("data-ph",LT("gallery_empty")); }
    else if(kind==="accordion"){ var t=el("div","banto-accordion__title"); t.setAttribute("data-acc-title",""); t.appendChild(document.createElement("br")); d.appendChild(t); d.appendChild(slotDiv("banto-accordion__body")); }
    else if(kind==="spacer"){ d.setAttribute("contenteditable","false"); d.setAttribute("aria-hidden","true"); }
    cls(d); return d;
  }
  // 画像: カバーは背景、画像と文は左右の画像、ギャラリーは並べる
  function setImage(d,url){
    var k=kindOf(d);
    if(k==="cover"){ var im=d.querySelector(":scope > .banto-cover__img"); if(!url){ d.removeAttribute("data-image"); if(im) d.removeChild(im); } else { d.setAttribute("data-image",url); if(!im){ im=document.createElement("img"); im.className="banto-cover__img"; im.alt=""; im.setAttribute("contenteditable","false"); d.insertBefore(im,d.firstChild); } im.src=url; } }
    else if(k==="media"){ var f=d.querySelector(":scope > .banto-media__fig"); f.innerHTML=""; if(!url) d.removeAttribute("data-image"); else { d.setAttribute("data-image",url); var i2=document.createElement("img"); i2.src=url; i2.alt=d.getAttribute("data-alt")||""; f.appendChild(i2); } }
    else if(k==="gallery"&&url){ var fg=document.createElement("figure"); var i3=document.createElement("img"); i3.src=url; i3.alt=""; fg.appendChild(i3); d.appendChild(fg); }
    mark(); drawSettings(true);
  }
  // 画像を選ぶ（メディアライブラリがあればそこから、無ければファイルを選んで置く）
  function pickImage(cb){
    if(window.bantoPickMedia){ window.bantoPickMedia(cb); return; }
    var inp=document.getElementById("page-image"); if(!inp) return;
    var orig=window.bantoPageImage; window.bantoPageImage=function(url){ window.bantoPageImage=orig; cb(url); return true; }; inp.click();
  }
  // 囲みの入れ子の上限（中に囲みを置くと何段になるか）
  function tooDeep(slot,h){ return depthOf(slot)+h>DEPTH; }

  var saved=null, sel=null;
  function remember(){ var s=window.getSelection(); if(s&&s.rangeCount&&ed.contains(s.anchorNode)) saved=s.getRangeAt(0).cloneRange(); }
  function restore(){ ed.focus(); if(saved){ var s=window.getSelection(); s.removeAllRanges(); s.addRange(saved); } }
  function current(){
    var s=window.getSelection(); var n=s&&s.rangeCount?s.anchorNode:null;
    if(!n||!ed.contains(n)) return null;
    if(n.nodeType===1&&isSlot(n)) return n.children[Math.min(s.anchorOffset,n.children.length-1)]||null;
    return blockOf(n);
  }
  function caretIn(el){ var r=document.createRange(); r.selectNodeContents(el); r.collapse(false); var s=window.getSelection(); s.removeAllRanges(); s.addRange(r); saved=r.cloneRange(); }
  function emptyP(){ var p=document.createElement("p"); p.appendChild(document.createElement("br")); return p; }
  function el(tag,cls,html){ var x=document.createElement(tag); if(cls) x.className=cls; if(html) x.innerHTML=html; return x; }
  function btn(cls,op,ico,label,text){ var b=el("button",cls,(ico?svg(ICO[ico]):"")+(text?"<span></span>":"")); b.type="button"; if(op) b.setAttribute("data-op",op); b.title=label; b.setAttribute("aria-label",label); if(text) b.lastChild.textContent=text; return b; }
  function at(node,r,dx,dy){ node.style.top=(window.scrollY+r.top+(dy||0))+"px"; node.style.left=Math.max(8,Math.min(window.scrollX+r.left+(dx||0),window.scrollX+document.documentElement.clientWidth-node.offsetWidth-8))+"px"; }

  // ---------- 選んでいるブロック（枠・空の行の案内・＋・ブロックの道具） ----------
  function select(b){
    if(sel&&sel!==b&&sel.classList) sel.classList.remove("is-sel");
    sel=isBlock(b)?b:null;
    if(sel) sel.classList.add("is-sel");
    refresh(); drawSettings();
  }
  function refresh(){
    Array.prototype.forEach.call(ed.querySelectorAll(".is-ph"),function(x){ x.classList.remove("is-ph"); x.removeAttribute("data-ph"); });
    var only=ed.children.length===1&&isEmpty(ed.firstElementChild)?ed.firstElementChild:null;
    var phEl=sel&&isEmpty(sel)&&document.activeElement===ed?sel:only;
    if(phEl){ phEl.classList.add("is-ph"); phEl.setAttribute("data-ph",T("ph")); }
    Array.prototype.forEach.call(ed.querySelectorAll("[data-acc-title]"),function(x){ var e0=!(x.textContent||"").trim(); x.classList.toggle("is-ph-title",e0); if(e0) x.setAttribute("data-ph",LT("acc_title")); });
    if(ed.hidden||!sel){ tb.hidden=true; plus.hidden=true; return; }
    var r=sel.getBoundingClientRect();
    if(isEmpty(sel)&&document.activeElement===ed&&ins.hidden&&menu.hidden){ plus.hidden=false; at(plus,r,r.width-30,(r.height-26)/2); } else plus.hidden=true;
    buildTb(kindOf(sel),sel.parentNode!==ed); tb.hidden=false;
    var bar0=root&&root.classList.contains("pe-full")?bar.getBoundingClientRect().bottom+4:70;
    var top=r.top-tb.offsetHeight-8; at(tb,r,0,top<bar0?r.height+8:-tb.offsetHeight-8);
  }
  function clearSel(){ if(sel&&sel.classList) sel.classList.remove("is-sel"); sel=null; refresh(); }
  // 文字を書けない箱（商品・ボタン）を押して選んだら、次に別の所を押すか打つまでそのまま
  var pin=null;
  document.addEventListener("selectionchange",function(){ if(pin) return; var b=current(); if(b){ remember(); select(b); } });
  ed.addEventListener("focus",refresh); ed.addEventListener("blur",function(){ setTimeout(refresh,0); });
  // 入力しているあいだは道具を隠す（マウスを動かすとまた出る。WordPress と同じ）
  ed.addEventListener("keydown",function(e){
    if(pin&&(e.key==="Backspace"||e.key==="Delete")){ e.preventDefault(); var p0=pin; pin=null; select(p0); op("del"); return; }
    if(pin&&e.key==="Enter"){ e.preventDefault(); var p1=pin; pin=null; editBlock(p1); return; }
    pin=null;
    guardKeys(e);
    if(e.key.length===1&&!e.ctrlKey&&!e.metaKey) tb.classList.add("typing");
  });
  document.addEventListener("mousemove",function(){ tb.classList.remove("typing"); });
  window.addEventListener("resize",refresh);
  // 本文の欄だけが動く画面（全画面の形）でも追いかける（scroll は泡立たないので捕まえる）
  // ＋の一覧は閉じずに付いていく（一覧の中のスクロール・iPad のキーボードで画面が動いたときに閉じないように）
  document.addEventListener("scroll",function(e){
    var t=e.target; if(t&&t.nodeType===1&&(ins.contains(t)||menu.contains(t)||pop.contains(t)||(left&&left.contains(t)))) return;
    gap.hidden=true; if(!tb.hidden||!plus.hidden) refresh(); if(!ins.hidden) placeIns();
  },{passive:true,capture:true});

  // ---------- ブロックの道具（種類・動かす・書式・設定・その他） ----------
  var tb=el("div","blk-tb"); tb.setAttribute("role","toolbar"); tb.setAttribute("aria-label",T("type")); tb.hidden=true; document.body.appendChild(tb);
  var tbKind=null;
  function buildTb(k,nested){
    if(tbKind===k+"|"+nested) return; tbKind=k+"|"+nested; tb.innerHTML="";
    var add=function(b){ b.className="blk-btn"; b.addEventListener("mousedown",function(e){ e.preventDefault(); }); tb.appendChild(b); return b; };
    var sep=function(){ tb.appendChild(el("span","blk-sep")); };
    if(TEXTY[k]){ var tbtn=add(btn("","type",k,T("type"),"\u25BE")); tbtn.setAttribute("aria-haspopup","true"); sep(); }
    else { add(btn("","none",k,nameOf(k))).disabled=true; sep(); }
    if(nested){ add(btn("","parent","parent",LT("parent"))); }
    add(btn("","drag","drag",T("drag"))); add(btn("","up","up",T("up"))); add(btn("","down","down",T("down")));
    if(TEXTY[k]){ sep(); var bb=add(btn("","bold","",T("bold"),"B")); bb.style.fontWeight="700"; var ib=add(btn("","italic","",T("italic"),"I")); ib.style.fontStyle="italic"; add(btn("","link","link",T("link"))); }
    if(k==="products"||k==="articles"||k==="button"||LS[k]&&k!=="column"){ sep(); add(btn("","edit","edit",T("edit"),T("edit"))); }
    sep(); add(btn("","more","more",T("more"))).setAttribute("aria-haspopup","true");
  }
  tb.addEventListener("click",function(e){
    var b=e.target.closest?e.target.closest("[data-op]"):null; if(!b||!sel) return;
    var k=b.getAttribute("data-op"), blk=sel;
    if(k==="type") openPop(b,BLOCKS.filter(function(x){ return TEXTY[x.k]; }).map(function(x){ return [x.k,x.label,function(){ convert(blk,x.k); }]; }));
    else if(k==="more") openPop(b,[["before",T("before"),function(){ addNear(blk,"before"); }],["after",T("after"),function(){ addNear(blk,"after"); }],["dup",T("dup"),function(){ dup(blk); }],["del",T("del"),function(){ op("del"); }]]);
    else if(k==="parent"){ var o=ownerOf(blk.parentNode); if(o){ pin=o; select(o); } }
    else if(k==="up"||k==="down") op(k);
    else if(k==="bold"){ document.execCommand("bold"); mark(); }
    else if(k==="italic"){ document.execCommand("italic"); mark(); }
    else if(k==="link"){ var u=window.prompt(T("link-ask"),"https://"); if(u){ restore(); document.execCommand("createLink",false,u.replace(/[\s()<>"]/g,"")); mark(); } }
    else if(k==="edit") editBlock(blk);
  });
  function editBlock(b){ var k=kindOf(b); if(k==="products") openProducts(b,null); else if(k==="articles") openArticles(b,null); else if(k==="button") openButton(b,null); else if(LS[k]) openSettings(); }
  // 前後に足す（列の並びの中なら列を足す。4 列まで）
  function addNear(blk,where){
    if(kindOf(blk)==="column"){ var cols=blk.parentNode; if(cols.children.length>=4) return; var c=mk("column"); cols.insertBefore(c,where==="before"?blk:blk.nextSibling); fixCols(cols); mark(); caretIn(c.firstElementChild); select(c.firstElementChild); return; }
    var p=emptyP(); blk.parentNode.insertBefore(p,where==="before"?blk:blk.nextSibling); select(p); openIns(p,"replace",p);
  }
  function dup(blk){
    var c=blk.cloneNode(true); c.classList.remove("is-sel");
    if(kindOf(c)==="column"&&blk.parentNode.children.length>=4) return;
    blk.parentNode.insertBefore(c,blk.nextSibling);
    if(ed.querySelectorAll("[data-banto-block=products]").length>3){ c.parentNode.removeChild(c); window.alert(T("products-max")); return; }
    if(kindOf(c)==="column") fixCols(c.parentNode);
    Array.prototype.forEach.call(c.querySelectorAll("[data-banto-block=products]"),function(x){ setBox(x,dataOf(x)); });
    if(c.getAttribute("data-banto-block")==="products") setBox(c,dataOf(c));
    mark(); pin=BOXES[kindOf(c)]||CONT[kindOf(c)]?c:null; select(c);
  }
  function op(k){
    var blk=sel; if(!isBlock(blk)) return; var slot=blk.parentNode;
    if(k==="up"&&blk.previousElementSibling) slot.insertBefore(blk,blk.previousElementSibling);
    else if(k==="down"&&blk.nextElementSibling) slot.insertBefore(blk.nextElementSibling,blk);
    else if(k==="del"){
      var next=blk.nextElementSibling||blk.previousElementSibling; slot.removeChild(blk); sel=null;
      if(isCols(slot)){ fixCols(slot); next=null; }
      tidy(); if(!next||!isBlock(next)) next=isBlock(slot)||slot===ed?(slot.firstElementChild||ed.firstElementChild):ed.firstElementChild;
      blk=next; if(blk&&!BOXES[kindOf(blk)]&&!CONT[kindOf(blk)]) caretIn(blk); else pin=blk;
    }
    mark(); select(blk);
  }
  // 段落・見出し・引用・箇条書きのあいだで種類を変える。execCommand は印の付いた段落の中に箇条書きを入れ子にすることが
  // あるので、要素を作り直す（箇条書き → 段落は項目ごとに 1 つ、段落 → 箇条書きは 1 項目）
  var TAGS={p:"P",h2:"H2",h3:"H3",q:"BLOCKQUOTE",ul:"UL",ol:"OL"};
  function convert(blk,k){
    if(!isBlock(blk)||kindOf(blk)===k||!TAGS[k]) return; var slot=blk.parentNode;
    var parts=/^(UL|OL)$/.test(blk.nodeName)?Array.prototype.slice.call(blk.children):blk.querySelector(":scope > p, :scope > div")?Array.prototype.slice.call(blk.children):[blk];
    var fill=function(to,from){ while(from.firstChild) to.appendChild(from.firstChild); if(!(to.textContent||"").trim()&&!to.querySelector("img")) { to.innerHTML=""; to.appendChild(document.createElement("br")); } return to; };
    var made=null;
    if(k==="ul"||k==="ol"){ made=document.createElement(TAGS[k]); parts.forEach(function(x){ made.appendChild(fill(document.createElement("li"),x)); }); slot.replaceChild(made,blk); caretIn(made.lastElementChild); }
    else { parts.forEach(function(x){ made=fill(document.createElement(TAGS[k]),x); slot.insertBefore(made,blk); }); slot.removeChild(blk); caretIn(made); }
    mark(); select(made);
  }

  // ---------- 小さな一覧（種類を変える・その他） ----------
  var pop=el("div","blk-pop"); pop.setAttribute("role","menu"); pop.hidden=true; document.body.appendChild(pop);
  var popBtn=null;
  function openPop(anchor,items){
    if(!pop.hidden&&popBtn===anchor){ closePop(); return; }
    pop.innerHTML=""; popBtn=anchor; anchor.setAttribute("aria-expanded","true");
    items.forEach(function(x){ var o=el("button","blk-opt",ICO[x[0]]?svg(ICO[x[0]]):""); o.type="button"; o.setAttribute("role","menuitem"); o.appendChild(document.createTextNode(x[1])); o.addEventListener("mousedown",function(e){ e.preventDefault(); }); o.addEventListener("click",function(){ closePop(); x[2](); }); pop.appendChild(o); });
    pop.hidden=false; at(pop,anchor.getBoundingClientRect(),0,anchor.offsetHeight+4);
  }
  function closePop(){ pop.hidden=true; if(popBtn) popBtn.setAttribute("aria-expanded","false"); popBtn=null; }

  // ---------- ブロックを入れる（＋の一覧: 探す欄と図の並び） ----------
  var ins=el("div","blk-ins"); ins.setAttribute("role","dialog"); ins.setAttribute("aria-label",T("add")); ins.hidden=true; document.body.appendChild(ins);
  var insQ=document.createElement("input"); insQ.type="search"; insQ.placeholder=T("search"); insQ.setAttribute("aria-label",T("search")); ins.appendChild(insQ);
  var insBody=el("div",""); ins.appendChild(insBody);
  var insFor=null, insMode="after", insSel=0, insList=[];
  function match(b,f){ return !f||b.k.indexOf(f)===0||b.label.toLowerCase().indexOf(f)>=0||b.desc.toLowerCase().indexOf(f)>=0; }
  // 図の並び（＋の一覧と左のブロックの一覧で共通）。list は絞り込んだもの、cur は選んでいる位置（-1 なら無し）
  function tiles(box,list,cur,onPick,onDrag){
    box.innerHTML="";
    if(!list.length){ var p=el("p","muted"); p.textContent=T("none"); box.appendChild(p); return; }
    ["theme","text","media","design","shop","patterns"].forEach(function(g){
      var xs=list.filter(function(b){ return b.g===g; }); if(!xs.length) return;
      var h=el("div","blk-grp"); h.textContent=g==="design"?LT("group_design"):g==="theme"?T("patterns-theme"):g==="patterns"?T("patterns"):T("g-"+g); box.appendChild(h);
      var grid=el("div","blk-grid"); box.appendChild(grid);
      xs.forEach(function(b){
        var i=list.indexOf(b); var o=el("button","blk-tile",svg(ICO[b.k]||ICO.pattern)); o.type="button"; o.title=b.desc; o.setAttribute("aria-selected",String(i===cur)); o.appendChild(document.createTextNode(b.label));
        o.addEventListener("mousedown",function(e){ e.preventDefault(); });
        o.addEventListener("click",function(){ if(!o.getAttribute("data-dragged")) onPick(i); o.removeAttribute("data-dragged"); });
        if(onDrag) o.addEventListener("pointerdown",function(e){ onDrag(e,b,o); });
        grid.appendChild(o);
      });
    });
  }
  function drawIns(){
    var f=insQ.value.trim().toLowerCase(); insList=BLOCKS.filter(function(b){ return match(b,f); });
    insSel=Math.max(0,Math.min(insSel,insList.length-1)); tiles(insBody,insList,insSel,pickIns,null);
  }
  var insAnchor=null;
  // 指で使う端末（iPad など）では、開いたときに探す欄へ入らない（キーボードが一覧を隠すため）
  var coarse=!!(window.matchMedia&&window.matchMedia("(pointer: coarse)").matches);
  function openIns(blk,mode,anchor){
    closeMenu(); closePop(); insFor=blk; insMode=mode; insSel=0; insQ.value=""; drawIns();
    ins.hidden=false; plus.hidden=true; gap.hidden=true; insAnchor=anchor||blk||ed; placeIns();
    if(!coarse) insQ.focus();
  }
  function placeIns(){
    if(ins.hidden||!insAnchor) return;
    var r=insAnchor.getBoundingClientRect(), vh=document.documentElement.clientHeight; var below=r.bottom+ins.offsetHeight+8<vh||r.top<ins.offsetHeight+8;
    at(ins,r,0,below?r.height+6:-ins.offsetHeight-6);
  }
  function closeIns(){ if(ins.hidden) return; ins.hidden=true; var b=insFor; insFor=null; if(isBlock(b)){ if(!BOXES[kindOf(b)]&&!CONT[kindOf(b)]) caretIn(b); } refresh(); }
  function pickIns(i){ var b=insList[i]; var blk=insFor, mode=insMode; ins.hidden=true; insFor=null; if(b) insertAt(b.k,blk,mode); }
  // ブロックを入れる: replace はその空の行に、before / after はその前後に新しい行を作って
  function insertAt(k,ref,mode){
    // 列の並びの中には列しか置けないので、カラムの前後へ
    if(ref&&isCols(ref.parentNode)){ ref=ref.parentNode; if(mode==="replace") mode="after"; }
    if(ref&&isCols(ref)&&mode==="replace") mode="after";
    var slot=isBlock(ref)?ref.parentNode:ed;
    if(CONT[k]&&tooDeep(slot,k==="columns"?2:1)){ window.alert(LT("depth_max")); return; }
    var blk=ref;
    if(!(mode==="replace"&&isBlock(ref)&&isEmpty(ref))){ blk=emptyP(); if(isBlock(ref)) slot.insertBefore(blk,mode==="before"?ref:ref.nextSibling); else ed.appendChild(blk); }
    apply(k,blk);
  }
  // スロット（囲みの中）の終わりに入れる。空でも入る（最後の行が空の段落ならそこに）
  function insertInto(k,slot){
    var ll=slot.lastElementChild;
    if(ll) { insertAt(k,ll,isEmpty(ll)?"replace":"after"); return; }
    if(CONT[k]&&tooDeep(slot,k==="columns"?2:1)){ window.alert(LT("depth_max")); return; }
    var p=emptyP(); slot.appendChild(p); apply(k,p);
  }
  // カーソルの位置に入れる（空の行ならそこ、文字のある行なら後ろ、どこも選んでいなければ終わり）
  function insertAtCursor(k){
    var s0=isBlock(sel)?sel:null, last=ed.lastElementChild;
    // 中にブロックを持つ囲み（カバー・グループ・列・画像と文・アコーディオン）を選んでいるなら、その中の終わりに
    var sk=s0?kindOf(s0):"";
    if(s0&&CONT[sk]&&sk!=="columns"&&sk!=="gallery"){ var sl=slotsOf(s0)[0]; if(sl){ insertInto(k,sl); return; } }
    if(s0) insertAt(k,s0,isEmpty(s0)?"replace":"after"); else insertAt(k,last,last&&isEmpty(last)?"replace":"after");
  }
  insQ.addEventListener("input",function(){ insSel=0; drawIns(); });
  insQ.addEventListener("keydown",function(e){
    var n=insList.length; if(e.key==="Escape"){ e.preventDefault(); closeIns(); return; }
    if(!n) return;
    if(e.key==="ArrowDown"||e.key==="ArrowRight"){ e.preventDefault(); insSel=(insSel+(e.key==="ArrowDown"?3:1))%n; drawIns(); }
    else if(e.key==="ArrowUp"||e.key==="ArrowLeft"){ e.preventDefault(); insSel=(insSel+n-(e.key==="ArrowUp"?3:1))%n; drawIns(); }
    else if(e.key==="Enter"){ e.preventDefault(); pickIns(insSel); }
  });

  // 空の行の右の「＋」
  var plus=btn("blk-plus","plus","",T("add"),"+"); plus.hidden=true; document.body.appendChild(plus);
  plus.addEventListener("mousedown",function(e){ e.preventDefault(); });
  plus.addEventListener("click",function(){ if(sel) openIns(sel,"replace",sel); });
  // 上の「＋」と、本文の終わりの「＋ ブロックを追加」
  var topBtn=document.getElementById("blk-top"), addEnd=document.getElementById("blk-add-end");
  function addAtEnd(anchor){ var last=ed.lastElementChild; if(last&&isEmpty(last)) openIns(last,"replace",anchor); else openIns(last,"after",anchor); }
  if(topBtn){ topBtn.addEventListener("mousedown",function(e){ e.preventDefault(); }); topBtn.addEventListener("click",function(){ if(isBlock(sel)) openIns(sel,isEmpty(sel)?"replace":"after",topBtn); else addAtEnd(topBtn); }); }
  if(addEnd) addEnd.addEventListener("click",function(){ addAtEnd(addEnd); });

  // ブロックとブロックのあいだの「＋」（マウスを置くと線と＋が出る）
  var gap=el("div","blk-gap"); gap.hidden=true; var gapBtn=btn("","gap","",T("add"),"+"); gap.appendChild(gapBtn); document.body.appendChild(gap);
  var gapAt=null;
  // スロットの中のブロックのあいだ（i 番目の前。i = 数なら終わり）
  function boundaries(slot){
    var kids=slot.children, out=[]; var er=slot.getBoundingClientRect();
    for(var i=0;i<=kids.length;i++){
      var a=i>0?kids[i-1].getBoundingClientRect():null, b=i<kids.length?kids[i].getBoundingClientRect():null;
      var y=a&&b?(a.bottom+b.top)/2:a?a.bottom+4:b?b.top-4:er.top+4;
      out.push({slot:slot,i:i,y:y,left:(b||a||er).left,width:(b||a||er).width});
    }
    return out;
  }
  // 指の下のスロット（列の並びは除く。without の中は選ばない = 動かしているブロックの中には落とせない）
  function slotAt(x,y,without){
    var t=document.elementFromPoint(x,y); if(!t||!ed.contains(t)) return null;
    for(var n=t;n&&n!==ed;n=n.parentNode){ if(n.nodeType===1&&isSlot(n)&&!isCols(n)&&!(without&&(without===n||without.contains(n)))) return n; }
    return ed;
  }
  function showGap(g){ gap.hidden=false; gap.style.width=g.width+"px"; at(gap,{top:g.y-1,left:g.left},0,0); gap.style.left=(window.scrollX+g.left)+"px"; }
  document.addEventListener("mousemove",function(e){
    if(dragging||ed.hidden||!ins.hidden||!menu.hidden||!pop.hidden){ if(!dragging) gap.hidden=true; return; }
    if(gap.contains(e.target)) return;
    var er=ed.getBoundingClientRect();
    if(e.clientX<er.left||e.clientX>er.right||e.clientY<er.top-6||e.clientY>er.bottom+6){ gap.hidden=true; gapAt=null; return; }
    var slot=slotAt(e.clientX,e.clientY)||ed;
    var bs=boundaries(slot), best=null;
    // 本文の先頭と末尾は除く（そこは上の＋と終わりの＋で足せる）。囲みの中は端にも出す
    for(var i=slot===ed?1:0;i<(slot===ed?bs.length-1:bs.length);i++){ if(Math.abs(bs[i].y-e.clientY)<9){ best=bs[i]; break; } }
    if(!best){ gap.hidden=true; gapAt=null; return; }
    gapAt=best; showGap(best);
  });
  gapBtn.addEventListener("mousedown",function(e){ e.preventDefault(); });
  gapBtn.addEventListener("click",function(){ if(!gapAt) return; var p=emptyP(); gapAt.slot.insertBefore(p,gapAt.slot.children[gapAt.i]||null); gap.hidden=true; mark(); select(p); openIns(p,"replace",p); });

  // ドラッグで動かす（道具の ⠿ を押したまま上下へ）
  var dragging=null, dropAt=null;
  // ドラッグで落とせる場所（列は同じカラムの中だけ。囲みは入れ子の上限まで）
  function dropFor(x,y,moving){
    var col=moving.length&&kindOf(moving[0])==="column";
    var slot=col?moving[0].parentNode:(slotAt(x,y,moving[0])||ed);
    for(var k=0;k<moving.length;k++){ if(moving[k]===slot||moving[k].contains(slot)) return null; if(!col&&kindOf(moving[k])==="column") return null; if(!col&&CONT[kindOf(moving[k])]&&tooDeep(slot,heightOf(moving[k]))) return null; }
    var bs=boundaries(slot), best=bs[0]; bs.forEach(function(g){ if(Math.abs(g.y-y)<Math.abs(best.y-y)) best=g; });
    if(col){ bs=[]; Array.prototype.forEach.call(slot.children,function(c,i){ var r=c.getBoundingClientRect(); bs.push({slot:slot,i:i,y:r.top,left:r.left,width:4,x:r.left}); }); var r2=slot.getBoundingClientRect(); bs.push({slot:slot,i:slot.children.length,y:r2.top,left:r2.right,width:4,x:r2.right}); best=bs[0]; bs.forEach(function(g){ if(Math.abs(g.x-x)<Math.abs(best.x-x)) best=g; }); }
    return best;
  }
  tb.addEventListener("pointerdown",function(e){
    var b=e.target.closest?e.target.closest("[data-op=drag]"):null; if(!b||!sel) return;
    e.preventDefault(); dragging=sel; dragging.style.opacity=".4"; document.body.style.cursor="grabbing";
  });
  document.addEventListener("pointermove",function(e){
    if(!dragging) return;
    dropAt=dropFor(e.clientX,e.clientY,[dragging]); if(dropAt) showGap(dropAt); else gap.hidden=true;
  });
  document.addEventListener("pointerup",function(){
    if(!dragging) return; var d=dragging; dragging=null; d.style.opacity=""; document.body.style.cursor=""; gap.hidden=true;
    if(dropAt){ var from=d.parentNode, ref=dropAt.slot.children[dropAt.i]||null; if(ref!==d) dropAt.slot.insertBefore(d,ref); if(from!==dropAt.slot&&isCols(from)) fixCols(from); tidy(); mark(); }
    dropAt=null; select(d);
  });

  // ---------- 「/」の一覧（空の行で / を打つ。続けて打つと絞り込む） ----------
  var menu=el("div","blk-menu"); menu.setAttribute("role","listbox"); menu.hidden=true; document.body.appendChild(menu);
  var menuFor=null, menuSel=0, menuItems=[];
  function openMenu(blk,filter){
    menuFor=blk; var f=(filter||"").toLowerCase();
    menuItems=BLOCKS.filter(function(b){ return match(b,f); });
    if(!menuItems.length){ closeMenu(); return; }
    menuSel=Math.min(menuSel,menuItems.length-1); menu.innerHTML="";
    menuItems.forEach(function(b,i){
      var o=el("button","blk-opt",svg(ICO[b.k]||ICO.pattern)); o.type="button"; o.setAttribute("role","option"); o.setAttribute("aria-selected",String(i===menuSel));
      var tx=el("span",""); tx.textContent=b.label; var sm=el("small",""); sm.textContent=b.desc; tx.appendChild(sm); o.appendChild(tx);
      o.addEventListener("mousedown",function(e){ e.preventDefault(); chooseMenu(i); });
      menu.appendChild(o);
    });
    menu.hidden=false; plus.hidden=true; at(menu,blk.getBoundingClientRect(),0,blk.offsetHeight+4);
  }
  function closeMenu(){ menu.hidden=true; menuFor=null; menuSel=0; }
  function chooseMenu(i){ var b=menuItems[i], blk=menuFor; closeMenu(); if(!b||!blk) return; blk.innerHTML="<br>"; apply(b.k,blk); }
  ed.addEventListener("keydown",function(e){
    if(menu.hidden) return;
    if(e.key==="ArrowDown"){ e.preventDefault(); menuSel=(menuSel+1)%menuItems.length; openMenu(menuFor,(menuFor.textContent||"").slice(1)); }
    else if(e.key==="ArrowUp"){ e.preventDefault(); menuSel=(menuSel+menuItems.length-1)%menuItems.length; openMenu(menuFor,(menuFor.textContent||"").slice(1)); }
    else if(e.key==="Enter"){ e.preventDefault(); chooseMenu(menuSel); }
    else if(e.key==="Escape"){ e.preventDefault(); closeMenu(); }
  });
  ed.addEventListener("input",function(){
    // 中身を消し切った囲み（カバー・グループなど）にも書き始める段落を残す（無いと中へ何も入れられなくなる）
    Array.prototype.forEach.call(ed.querySelectorAll("[data-slot]"),function(x){ if(!isCols(x)&&!x.children.length){ var p0=emptyP(); x.appendChild(p0); var s0=window.getSelection(); if(s0.rangeCount&&x.contains(s0.anchorNode)) caretIn(p0); } });
    var blk=current(); var txt=blk?(blk.textContent||""):"";
    if(blk&&blk.nodeName==="P"&&/^\/[^\s/]{0,12}$/.test(txt)){ if(menuFor!==blk) menuSel=0; openMenu(blk,txt.slice(1)); }
    else if(!menu.hidden) closeMenu();
    refresh();
  });
  document.addEventListener("mousedown",function(e){
    var t=e.target;
    if(!menu.hidden&&!menu.contains(t)) closeMenu();
    if(!pop.hidden&&!pop.contains(t)&&!tb.contains(t)) closePop();
    if(!ins.hidden&&!ins.contains(t)&&t!==topBtn&&t!==addEnd&&!plus.contains(t)&&!gap.contains(t)) closeIns();
  });
  document.addEventListener("keydown",function(e){ if(e.key==="Escape"){ if(!pop.hidden) closePop(); } });
  // 商品・ボタンのブロック（文字を書けない箱）は押すと選ぶ。二度押しで設定
  // 押した所のブロック（囲みの余白・カバーの画像・文字を書けない箱は、囲み・箱そのもの）
  function hitBlock(t){ if(!t||t===ed) return null; return isSlot(t)?ownerOf(t):blockOf(t); }
  ed.addEventListener("mousedown",function(e){
    var t=e.target, b=hitBlock(t), k=b?kindOf(b):""; pin=null;
    if(b&&(BOXES[k]||CONT[k]&&!(t.closest&&t.closest("[data-acc-title]")))){ e.preventDefault(); ed.focus({preventScroll:true}); pin=b; select(b); }
  });
  ed.addEventListener("dblclick",function(e){
    var t=e.target, b=hitBlock(t); if(!b) return; var k=kindOf(b);
    if((k==="cover"&&(t===b||t.classList.contains("banto-cover__img")))||(k==="media"&&t.closest(".banto-media__fig"))||k==="gallery"){ pickImage(function(u){ setImage(b,u); }); return; }
    if(BOXES[k]||(CONT[k]&&t.closest&&!t.closest("[data-acc-title]"))) editBlock(b);
  });
  // 囲みを壊さないキー: 囲みの中の最初の行の頭の Backspace・文字を書けない箱の手前の Delete・題の Enter
  function edge(b,start){ var s=window.getSelection(); if(!s.rangeCount||!s.isCollapsed) return false; var r=document.createRange(); r.selectNodeContents(b); if(start) r.setEnd(s.anchorNode,s.anchorOffset); else r.setStart(s.anchorNode,s.anchorOffset); return r.toString()===""&&!r.cloneContents().querySelector("img,hr,table"); }
  // 改行（Enter）はここで段落を分ける。ブラウザ任せだと iPad の Safari が余分な改行を残し、空の段落が増えるため。
  // 箇条書き・引用・表の中はブラウザに任せる（項目を足す・抜ける）。Shift+Enter（行の中の改行）もそのまま
  function splitBlock(b){
    var s=window.getSelection(); if(!s.rangeCount) return;
    var r=s.getRangeAt(0); if(!r.collapsed) r.deleteContents();
    var empty=function(x){ return !(x.textContent||"").trim()&&!x.querySelector("img"); };
    var np=document.createElement("p");
    if(edge(b,true)&&!empty(b)){ np.appendChild(document.createElement("br")); b.parentNode.insertBefore(np,b); mark(); select(b); return; }
    var tail=document.createRange(); tail.setStart(r.startContainer,r.startOffset); tail.setEnd(b,b.childNodes.length);
    np.appendChild(tail.extractContents());
    if(empty(np)) np.innerHTML="<br>"; if(empty(b)) b.innerHTML="<br>";
    b.parentNode.insertBefore(np,b.nextSibling);
    var c=document.createRange(); c.setStart(np,0); c.collapse(true); s.removeAllRanges(); s.addRange(c); saved=c.cloneRange();
    mark(); select(np);
  }
  ed.addEventListener("beforeinput",function(e){
    if(e.inputType!=="insertParagraph"||!menu.hidden) return;
    var n=window.getSelection().anchorNode; var x=n&&(n.nodeType===1?n:n.parentNode);
    var title=x&&x.closest?x.closest("[data-acc-title]"):null;
    var b=current(); if(!b) return;
    if(title){ e.preventDefault(); var body=b.querySelector("[data-slot]"); var f=body&&body.firstElementChild; if(f){ caretIn(f); select(f); } return; }
    if(x&&x.closest&&x.closest("li,td,th,blockquote")) return;
    if(/^(P|H[1-6])$/.test(b.nodeName)&&!/banto-button/.test(b.className)){ e.preventDefault(); splitBlock(b); }
  });
  function guardKeys(e){
    var b=current(); if(!b) return;
    var title=window.getSelection().anchorNode; title=title&&(title.nodeType===1?title:title.parentNode); title=title&&title.closest?title.closest("[data-acc-title]"):null;
    if(title&&e.key==="Enter"){ e.preventDefault(); var body=b.querySelector("[data-slot]"); var f=body&&body.firstElementChild; if(f){ caretIn(f); select(f); } return; }
    if(title&&e.key==="Backspace"&&edge(title,true)){ e.preventDefault(); return; }
    if(e.key==="Backspace"&&edge(b,true)){
      var prev=b.previousElementSibling;
      if(!prev&&b.parentNode!==ed){ e.preventDefault(); if(isEmpty(b)&&b.parentNode.children.length>1){ b.parentNode.removeChild(b); tidy(); mark(); } return; }
      if(prev&&(BOXES[kindOf(prev)]||CONT[kindOf(prev)])){ e.preventDefault(); if(isEmpty(b)){ b.parentNode.removeChild(b); mark(); } pin=prev; select(prev); }
    } else if(e.key==="Delete"&&edge(b,false)){
      var next=b.nextElementSibling;
      if(!next&&b.parentNode!==ed){ e.preventDefault(); return; }
      if(next&&(BOXES[kindOf(next)]||CONT[kindOf(next)])){ e.preventDefault(); pin=next; select(next); }
    }
  }
  ed.addEventListener("click",function(e){ var a=e.target.closest?e.target.closest("a"):null; if(a&&ed.contains(a)) e.preventDefault(); });

  // ---------- ブロックを入れる ----------
  function apply(kind,blk){
    ed.focus({preventScroll:true});
    if(kind.indexOf("pattern:")===0){ insertPattern(kind.slice(8),blk); return; }
    if(kind==="articles"){ openArticles(null,blk); return; }
    if(kind==="img"){ caretIn(blk); select(blk); if(window.bantoOpenMedia){ window.bantoOpenMedia("body"); return; } var inp=document.getElementById("page-image"); if(inp) inp.click(); return; }
    if(kind==="products"){ openProducts(null,blk); return; }
    if(kind==="button"){ openButton(null,blk); return; }
    if(CONT[kind]||kind==="spacer"){
      if(CONT[kind]&&tooDeep(blk.parentNode,kind==="columns"?2:1)){ window.alert(LT("depth_max")); caretIn(blk); select(blk); return; }
      var box=mk(kind); place2(box,blk);
      var first=box.querySelector("[data-acc-title]")||box.querySelector("[data-slot] > *");
      if(kind==="cover"||kind==="media"||kind==="gallery"){ pin=box; select(box); openSettings(); pickImage(function(u){ setImage(box,u); }); }
      else if(first){ caretIn(first); select(blockOf(first)||box); }
      else { pin=box; select(box); }
      return;
    }
    caretIn(blk);
    var run=function(c,v){ document.execCommand(c,false,v); };
    if(TAGS[kind]){ if(kindOf(blk)===kind) { select(blk); return; } convert(blk,kind); return; }
    else if(kind==="hr"){ var hr=document.createElement("hr"); place2(hr,blk); return; }
    else if(kind==="table"){ var c=T("cell"); run("insertHTML","<table><thead><tr><th>"+c+"</th><th>"+c+"</th></tr></thead><tbody><tr><td>"+c+"</td><td>"+c+"</td></tr></tbody></table><p><br></p>"); }
    mark(); select(current());
  }
  // ブロックの箱（商品・ボタン・区切り線）を blk の場所に置き、後ろに続きを書く段落を用意する
  function place2(box,blk){
    var slot=isBlock(blk)?blk.parentNode:ed;
    if(isBlock(blk)) slot.replaceChild(box,blk); else ed.appendChild(box);
    // 終わりに置いたときだけ、続きを書く空の行を足す（途中なら次の行へ）
    var next=box.nextElementSibling; if(!next){ next=emptyP(); slot.appendChild(next); }
    if(BOXES[kindOf(next)]||CONT[kindOf(next)]) { mark(); pin=box; select(box); return; }
    caretIn(next); mark(); select(box.nodeName==="HR"?next:box);
  }

  // ---------- ボタンのブロック ----------
  var bdlg=document.getElementById("blk-button");
  function openButton(box,blk){
    if(!bdlg||!bdlg.showModal) return;
    var f=bdlg.querySelector("form"); var a=box?box.querySelector("a"):null;
    f.elements.text.value=a?(a.textContent||""):""; f.elements.url.value=a?(a.getAttribute("href")||""):"";
    fillStyle(f.elements.style,"button",box?box.getAttribute("data-style"):"");
    bdlg.returnValue="";
    var done=function(){
      bdlg.removeEventListener("close",done);
      var text=String(f.elements.text.value||"").replace(/[\[\]\n]/g,"").trim().slice(0,100), url=String(f.elements.url.value||"").replace(/[\s()<>"]/g,"");
      if(bdlg.returnValue!=="ok"||!text||!url){ if(blk) { caretIn(blk); select(blk); } return; }
      var p=box||document.createElement("p"); var bst=styleVal(f.elements.style); p.className="banto-button"+(bst?" banto-style-"+bst:""); if(bst) p.setAttribute("data-style",bst); else p.removeAttribute("data-style"); p.innerHTML="";
      var link=document.createElement("a"); link.className="banto-button__link"; link.setAttribute("href",url); link.textContent=text; p.appendChild(link);
      if(box){ mark(); select(box); } else place2(p,blk);
    };
    bdlg.addEventListener("close",done);
    bdlg.showModal(); f.elements.text.focus();
  }

  // ---------- テーマのスタイル（ダイアログと設定の欄の選択） ----------
  function fillStyle(se,kind,cur){
    if(!se) return; var list=STYLES[kind]||[]; var lab=se.id?document.querySelector("label[for="+se.id+"]"):null;
    se.hidden=!list.length; if(lab) lab.hidden=!list.length; se.innerHTML="";
    var o0=document.createElement("option"); o0.value=""; o0.textContent=T("style-default"); se.appendChild(o0);
    list.forEach(function(x){ var o=document.createElement("option"); o.value=x.name; o.textContent=x.label; if(x.name===cur) o.selected=true; se.appendChild(o); });
    // テーマに無いスタイル（前のテーマのもの）も、選んだままにしておく
    if(cur&&!list.some(function(x){ return x.name===cur; })){ var o2=document.createElement("option"); o2.value=cur; o2.textContent=cur; o2.selected=true; se.appendChild(o2); se.hidden=false; if(lab) lab.hidden=false; }
  }
  function styleVal(se){ var v=se&&!se.hidden?String(se.value||""):""; return /^[a-z0-9][a-z0-9-]{0,29}$/.test(v)?v:""; }

  // ---------- パターン（テーマ・Banto の型。選ぶと本文を受け取って、その場所に普通のブロックとして入れる） ----------
  var PATTERN_URL=(form.getAttribute("data-preview")||"").replace(/products-preview$/,"pattern");
  function heightOfNode(n){ var m=0; Array.prototype.forEach.call(n.children||[],function(c){ m=Math.max(m,heightOfNode(c)); }); return m+(n.nodeType===1&&CONT[n.getAttribute("data-banto-block")]?1:0); }
  function insertPattern(name,blk){
    if(!window.fetch||!PATTERN_URL) return;
    fetch(PATTERN_URL+"?name="+encodeURIComponent(name),{credentials:"same-origin",headers:{Accept:"application/json"}}).then(function(r){ return r.ok?r.json():null; }).then(function(j){
      if(!j||typeof j.html!=="string"||!isBlock(blk)) return;
      var tpl=document.createElement("template"); tpl.innerHTML=j.html;
      var nodes=Array.prototype.slice.call(tpl.content.children); if(!nodes.length) return;
      var slot=blk.parentNode;
      if(nodes.some(function(n){ var h=heightOfNode(n); return h&&tooDeep(slot,h); })){ window.alert(LT("depth_max")); return; }
      var ref=isEmpty(blk)?blk:blk.nextSibling;
      nodes.forEach(function(n){ slot.insertBefore(n,ref); });
      if(ref===blk) slot.removeChild(blk);
      nodes.forEach(function(n){
        if(n.getAttribute("data-banto-block")==="products") setBox(n,dataOf(n));
        Array.prototype.forEach.call(n.querySelectorAll("[data-banto-block=products]"),function(x){ setBox(x,dataOf(x)); });
        Array.prototype.forEach.call(n.querySelectorAll(".banto-media__fig"),function(f){ f.setAttribute("data-ph",LT("media_empty")); });
      });
      var last=nodes[nodes.length-1]; if(!last.nextElementSibling){ slot.appendChild(emptyP()); }
      tidy(); mark();
      var first=nodes[0].querySelector("[data-slot] > *")||nodes[0]; if(first&&!BOXES[kindOf(first)]&&!CONT[kindOf(first)]){ caretIn(first); select(first); } else { pin=nodes[0]; select(nodes[0]); }
    }).catch(function(){});
  }

  // ---------- 記事を並べるブロック（ブログの新しい記事。1 ページに 2 つまで） ----------
  var adlg=document.getElementById("blk-articles");
  function articlesText(d){ var f=adlg?adlg.querySelector("form"):null; var o=f&&f.querySelector("[name=blog] option[value='"+String(d.blog).replace(/['\\]/g,"")+"']"); return T("articles-label").replace("{blog}",o?o.textContent:d.blog).replace("{n}",String(d.limit)); }
  function setArticlesBox(box,d){
    box.className="banto-articles banto-articles--"+d.layout+(d.style?" banto-style-"+d.style:"")+(sel===box?" is-sel":""); box.setAttribute("data-banto-block","articles"); box.setAttribute("contenteditable","false");
    box.setAttribute("data-blog",d.blog); box.setAttribute("data-tag",d.tag); box.setAttribute("data-limit",String(d.limit)); box.setAttribute("data-layout",d.layout);
    if(d.style) box.setAttribute("data-style",d.style); else box.removeAttribute("data-style");
    box.textContent=articlesText(d);
  }
  Array.prototype.forEach.call(ed.querySelectorAll("[data-banto-block=articles]"),function(b){ setArticlesBox(b,{blog:b.getAttribute("data-blog")||"",tag:b.getAttribute("data-tag")||"",limit:parseInt(b.getAttribute("data-limit")||"3",10)||3,layout:b.getAttribute("data-layout")==="list"?"list":"grid",style:b.getAttribute("data-style")||""}); });
  function openArticles(box,blk){
    if(!adlg||!adlg.showModal){ window.alert(T("articles-none")); return; }
    if(!box&&ed.querySelectorAll("[data-banto-block=articles]").length>=2){ window.alert(T("articles-max")); if(blk){ caretIn(blk); select(blk); } return; }
    var f=adlg.querySelector("form"); var g=function(k,dv){ return box?(box.getAttribute("data-"+k)||dv):dv; };
    if(g("blog","")) f.elements.blog.value=g("blog",""); f.elements.tag.value=g("tag",""); f.elements.limit.value=g("limit","3"); f.elements.layout.value=g("layout","grid");
    fillStyle(f.elements.style,"articles",g("style",""));
    adlg.returnValue="";
    var done=function(){
      adlg.removeEventListener("close",done);
      if(adlg.returnValue!=="ok"){ if(blk){ caretIn(blk); select(blk); } return; }
      var n=parseInt(f.elements.limit.value,10);
      var d={blog:/^[a-z0-9][a-z0-9-]{0,63}$/.test(f.elements.blog.value)?f.elements.blog.value:"",tag:String(f.elements.tag.value||"").replace(/["\n\r]/g,"").trim().slice(0,50),limit:(n>=1&&n<=12)?n:3,layout:f.elements.layout.value==="list"?"list":"grid",style:styleVal(f.elements.style)};
      if(!d.blog) return;
      if(box){ setArticlesBox(box,d); mark(); select(box); }
      else { var nb=document.createElement("div"); setArticlesBox(nb,d); place2(nb,blk); }
    };
    adlg.addEventListener("close",done);
    adlg.showModal();
  }

  // ---------- 商品を並べるブロック（設定と、並ぶ商品の見本） ----------
  var dlg=document.getElementById("blk-products");
  var SORTS={new:1,updated:1,price_asc:1,price_desc:1,name:1};
  var PREVIEW=form.getAttribute("data-preview");
  function productsText(d){
    var f=dlg?dlg.querySelector("form"):null; var opt=function(name,v){ var o=f&&f.querySelector("[name="+name+"] option[value='"+String(v).replace(/['\\]/g,"")+"']"); return o&&name!=="tag"?o.textContent:v; };
    var parts=[d.category?opt("category",d.category):T("products-all")];
    if(d.tag) parts.push("#"+d.tag);
    parts.push(d.limit+" "+T("products-items"),opt("layout",d.layout),opt("sort",d.sort));
    return T("products")+" \u2014 "+parts.join("\u30fb");
  }
  function dataOf(box){ return {category:box.getAttribute("data-category")||"",tag:box.getAttribute("data-tag")||"",limit:parseInt(box.getAttribute("data-limit")||"8",10)||8,layout:box.getAttribute("data-layout")==="scroll"?"scroll":"grid",sort:SORTS[box.getAttribute("data-sort")]?box.getAttribute("data-sort"):"new",style:box.getAttribute("data-style")||""}; }
  function fetchPreview(d){
    if(!PREVIEW||!window.fetch) return Promise.resolve(null);
    var q="?category="+encodeURIComponent(d.category)+"&tag="+encodeURIComponent(d.tag)+"&limit="+d.limit+"&sort="+d.sort;
    return fetch(PREVIEW+q,{credentials:"same-origin",headers:{Accept:"application/json"}}).then(function(r){ return r.ok?r.json():null; }).catch(function(){ return null; });
  }
  // 見本を描く（名前と画像。画像はサーバーが返した置き場の URL だけ）
  function drawPreview(target,j,withItems){
    target.querySelectorAll(".bp-items,.bp-note").forEach(function(x){ x.remove(); });
    if(!j) return;
    var note=el("div","bp-note");
    if(j.unpublished) note.textContent=T("pv-unpublished");
    else if(!j.total){ note.textContent=T("pv-none"); note.classList.add("bad"); }
    else note.textContent=T("pv-count").replace("{n}",String(j.total));
    if(withItems&&j.items&&j.items.length){
      var row=el("div","bp-items");
      j.items.forEach(function(it){ var c=el("div","bp-item"); var im=el("span",""); if(it.image&&/^(https?:\/\/|\/)[^"'()\\\s]+$/.test(it.image)) im.style.backgroundImage="url(\""+it.image+"\")"; var nm=el("b",""); nm.textContent=it.name; c.appendChild(im); c.appendChild(nm); row.appendChild(c); });
      target.appendChild(row);
    }
    target.appendChild(note);
  }
  function setBox(box,d){
    box.className="banto-products banto-products--"+d.layout+(d.style?" banto-style-"+d.style:""); box.setAttribute("data-banto-block","products"); box.setAttribute("contenteditable","false");
    if(d.style) box.setAttribute("data-style",d.style); else box.removeAttribute("data-style");
    box.setAttribute("data-category",d.category); box.setAttribute("data-tag",d.tag); box.setAttribute("data-limit",String(d.limit)); box.setAttribute("data-layout",d.layout); box.setAttribute("data-sort",d.sort);
    box.textContent=""; var head=el("div",""); head.textContent=productsText(d); box.appendChild(head);
    if(sel===box) box.classList.add("is-sel");
    fetchPreview(d).then(function(j){ if(box.getAttribute("data-tag")===d.tag&&box.getAttribute("data-category")===d.category) drawPreview(box,j,true); });
  }
  // 開いたときに、置いてある商品のブロックにも見本を出す
  Array.prototype.forEach.call(ed.querySelectorAll("[data-banto-block=products]"),function(b){ setBox(b,dataOf(b)); });
  var pv=document.getElementById("bp-preview"), pvTimer=0;
  function dlgData(){ var f=dlg.querySelector("form"); var n=parseInt(f.elements.limit.value,10); var cat=/^[a-z0-9][a-z0-9-]{0,62}$/.test(f.elements.category.value)?f.elements.category.value:""; return {category:cat,tag:String(f.elements.tag.value||"").replace(/["\n\r]/g,"").trim().slice(0,50),limit:(n>=1&&n<=24)?n:8,layout:f.elements.layout.value==="scroll"?"scroll":"grid",sort:SORTS[f.elements.sort.value]?f.elements.sort.value:"new",style:styleVal(f.elements.style)}; }
  function dlgPreview(){ if(!pv) return; pv.textContent=T("pv-loading"); clearTimeout(pvTimer); pvTimer=setTimeout(function(){ var d=dlgData(); fetchPreview(d).then(function(j){ pv.textContent=""; drawPreview(pv,j,false); }); },250); }
  if(dlg){ dlg.querySelector("form").addEventListener("change",dlgPreview); dlg.querySelector("form").addEventListener("input",dlgPreview); }
  function openProducts(box,blk){
    if(!dlg||!dlg.showModal) return;
    if(!box&&ed.querySelectorAll("[data-banto-block=products]").length>=3){ window.alert(T("products-max")); if(blk){ caretIn(blk); select(blk); } return; }
    var f=dlg.querySelector("form");
    var g=function(k,dv){ return box?(box.getAttribute("data-"+k)||dv):dv; };
    var tag=f.elements.tag, tv=g("tag","");
    // 一覧に無いタグ（公開中の商品に無い・前に手で入れた）は、そうと分かる形で選択肢に足す
    if(tag.tagName==="SELECT"){ Array.prototype.forEach.call(tag.querySelectorAll("option[data-missing]"),function(o){ o.remove(); }); if(tv&&!Array.prototype.some.call(tag.options,function(o){ return o.value===tv; })){ var o=document.createElement("option"); o.value=tv; o.setAttribute("data-missing","1"); o.textContent=(tag.getAttribute("data-missing")||"{v}").replace("{v}",tv); tag.appendChild(o); } }
    fillStyle(f.elements.style,"products",g("style",""));
    f.elements.category.value=g("category",""); tag.value=tv; f.elements.limit.value=g("limit","8"); f.elements.layout.value=g("layout","grid"); f.elements.sort.value=g("sort","new");
    dlg.returnValue=""; dlgPreview();
    var done=function(){
      dlg.removeEventListener("close",done);
      if(dlg.returnValue!=="ok"){ if(blk){ caretIn(blk); select(blk); } return; }
      var d=dlgData();
      if(box){ setBox(box,d); mark(); select(box); }
      else { var nb=document.createElement("div"); setBox(nb,d); place2(nb,blk); }
    };
    dlg.addEventListener("close",done);
    dlg.showModal();
  }

  // 見たままと Markdown の切り替えに合わせて、道具を出し分ける（Markdown のときは上の書式のボタン）
  var mdTools=document.getElementById("md-tools");
  function syncMode(){
    var vis=!ed.hidden;
    if(mdTools) mdTools.hidden=vis; if(topBtn) topBtn.hidden=!vis; if(addEnd) addEnd.hidden=!vis;
    if(!vis){ closeMenu(); closePop(); closeIns(); gap.hidden=true; clearSel(); }
  }
  if(window.MutationObserver) new MutationObserver(syncMode).observe(ed,{attributes:true,attributeFilter:["hidden"]});
  syncMode();

  // ---------- ブロックの設定（右の欄のいちばん上。選んだレイアウトのブロックの値をその場で変える） ----------
  var setCard=null, setFor=null;
  (function(){ var aside0=form.querySelector(".split > aside"); if(aside0){ setCard=el("section","card pe-blockset"); setCard.setAttribute("aria-live","polite"); aside0.insertBefore(setCard,aside0.firstChild); } })();
  function setAttr(b,key,v){ b.setAttribute("data-"+key,v); cls(b); if(key==="ratio") syncCols(b); if(key==="alt"){ var im=b.querySelector(".banto-media__fig img"); if(im) im.alt=v; } mark(); refresh(); }
  function openSettings(){ var a0=form.querySelector(".split > aside"); if(a0&&a0.hidden&&typeof setSet==="function") setSet(true); drawSettings(true); if(setCard) setCard.scrollIntoView({block:"nearest"}); }
  function drawSettings(force){
    if(!setCard) return;
    // 選んだブロックがレイアウトのブロックでなければ、それを囲む一番近いもの（列ならカラム）の設定を出す
    var b=sel; while(b&&!(LS[kindOf(b)]&&kindOf(b)!=="column")) b=b.parentNode===ed?null:ownerOf(b.parentNode);
    var k=b?kindOf(b):"";
    if(!force&&setFor===b) return; setFor=b;
    setCard.innerHTML=""; var h=el("h2","");
    if(!b||!LS[k]||k==="column"){ h.textContent=LT("settings"); setCard.appendChild(h); var p0=el("p","muted"); p0.textContent=LT("settings_none"); setCard.appendChild(p0); return; }
    h.innerHTML=svg(ICO[k]); h.appendChild(document.createTextNode(nameOf(k))); setCard.appendChild(h);
    // テーマのスタイル（テーマが決めているブロックだけ）
    if(STYLES[k]&&STYLES[k].length){ var ls0=el("label",""); ls0.textContent=T("style"); ls0.setAttribute("for","ls-style"); setCard.appendChild(ls0); var ss=document.createElement("select"); ss.id="ls-style"; fillStyle(ss,k,b.getAttribute("data-style")||""); ss.addEventListener("change",function(){ var v=styleVal(ss); if(v) b.setAttribute("data-style",v); else b.removeAttribute("data-style"); cls(b); mark(); refresh(); }); setCard.appendChild(ss); }
    var sc=LS[k];
    Object.keys(sc).forEach(function(key){
      var cur=b.getAttribute("data-"+key)||sc[key].def, id="ls-"+key;
      if(key==="open"){ var lab=el("label",""); var cb=document.createElement("input"); cb.type="checkbox"; cb.checked=cur==="1"; cb.addEventListener("change",function(){ setAttr(b,"open",cb.checked?"1":"0"); }); lab.appendChild(cb); lab.appendChild(document.createTextNode(" "+LT("field.open"))); setCard.appendChild(lab); return; }
      var l=el("label",""); l.textContent=LT("field."+key); setCard.appendChild(l);
      // 画像の見せる位置: 3×3 のマス目（押した所を残して見せる）
      if(key==="focus"){
        var fg=el("div","pe-focus"); fg.setAttribute("role","radiogroup"); fg.setAttribute("aria-label",LT("field.focus"));
        var url0=b.getAttribute("data-image"); if(url0&&/^(https?:\/\/|\/)[^"'()\\\s]+$/.test(url0)){ fg.style.backgroundImage="url(\""+url0+"\")"; var pic=new Image(); pic.onload=function(){ var ar=pic.naturalWidth/pic.naturalHeight; if(ar>0) fg.style.aspectRatio=String(Math.max(.75,Math.min(2.4,ar))); }; pic.src=url0; }
        sc[key].values.forEach(function(v){ var lb=el("label",""); lb.title=LT("opt.focus."+v); var r=document.createElement("input"); r.type="radio"; r.name="ls-focus"; r.value=v; r.checked=v===cur; r.setAttribute("aria-label",LT("opt.focus."+v)); r.addEventListener("change",function(){ setAttr(b,"focus",v); }); lb.appendChild(r); fg.appendChild(lb); });
        setCard.appendChild(fg); var fh=el("p","muted"); fh.style.fontSize=".8rem"; fh.textContent=LT("focus_help"); setCard.appendChild(fh); return;
      }
      if(key==="icon"){
        var grid=el("div","pe-icons"); grid.setAttribute("role","radiogroup"); grid.setAttribute("aria-label",LT("field.icon"));
        sc[key].values.forEach(function(v){ var lb=el("label","banto-accordion--"+v); var r=document.createElement("input"); r.type="radio"; r.name="ls-icon"; r.value=v; r.checked=v===cur; r.addEventListener("change",function(){ setAttr(b,"icon",v); }); lb.appendChild(r); lb.appendChild(el("span","banto-accordion__icon")); var tx=el("span",""); tx.textContent=LT("opt.icon."+v); lb.appendChild(tx); grid.appendChild(lb); });
        setCard.appendChild(grid); return;
      }
      var se=document.createElement("select"); se.id=id; l.setAttribute("for",id);
      sc[key].values.forEach(function(v){ var o=document.createElement("option"); o.value=v; o.textContent=LT("opt."+key+"."+v)||v; if(v===cur) o.selected=true; se.appendChild(o); });
      se.addEventListener("change",function(){ setAttr(b,key,se.value); });
      setCard.appendChild(se);
    });
    if(k==="cover"||k==="media"){
      var li=el("label",""); li.textContent=LT("field.image"); setCard.appendChild(li);
      var url=b.getAttribute("data-image");
      if(url){ var th=document.createElement("img"); th.src=url; th.alt=""; th.style.cssText="width:100%;height:auto;border-radius:6px;border:1px solid var(--border)"; setCard.appendChild(th); }
      var row=el("p",""); var ch=btn("secondary small","img-choose","",LT("choose_image"),LT("choose_image")); ch.addEventListener("click",function(){ pickImage(function(u){ setImage(b,u); }); }); row.appendChild(ch);
      if(url){ var rm=btn("secondary small","img-remove","",LT("remove_image"),LT("remove_image")); rm.addEventListener("click",function(){ setImage(b,""); }); row.appendChild(document.createTextNode(" ")); row.appendChild(rm); }
      setCard.appendChild(row);
      if(k==="media"){ var la=el("label",""); la.textContent=LT("field.alt"); la.setAttribute("for","ls-alt"); setCard.appendChild(la); var ia=document.createElement("input"); ia.type="text"; ia.id="ls-alt"; ia.maxLength=200; ia.value=b.getAttribute("data-alt")||""; ia.addEventListener("input",function(){ setAttr(b,"alt",ia.value.replace(/["\n\r]/g,"").slice(0,200)); }); setCard.appendChild(ia); }
    }
    if(k==="gallery"){
      var thumbs=el("div","pe-thumbs");
      Array.prototype.forEach.call(b.querySelectorAll("img"),function(im){ var c=el("div",""); var t2=document.createElement("img"); t2.src=im.src; t2.alt=""; var x=btn("secondary","img-del","close",LT("remove_image")); x.addEventListener("click",function(){ var f=im.closest("figure")||im; f.parentNode.removeChild(f); mark(); drawSettings(true); }); c.appendChild(t2); c.appendChild(x); thumbs.appendChild(c); });
      setCard.appendChild(thumbs);
      var ad=btn("secondary small","img-add","",LT("add_image"),LT("add_image")); ad.addEventListener("click",function(){ pickImage(function(u){ setImage(b,u); }); }); var pr=el("p",""); pr.appendChild(ad); setCard.appendChild(pr);
    }
    if(k==="group"||k==="cover"){ var nt=el("p","muted"); nt.style.fontSize=".8rem"; nt.textContent=LT("colors_note"); setCard.appendChild(nt); }
  }
  drawSettings(true);
  // 開いたとき: 前に空のまま保存した囲みにも書き始める段落を入れる
  tidy();
  // 開いたとき: 空の画像の欄とギャラリーに案内の文字
  Array.prototype.forEach.call(ed.querySelectorAll(".banto-media__fig"),function(f){ f.setAttribute("data-ph",LT("media_empty")); });
  Array.prototype.forEach.call(ed.querySelectorAll("[data-banto-block=gallery]"),function(g){ g.setAttribute("data-ph",LT("gallery_empty")); });

  // ---------- 画面の形（WordPress のように: 左にブロックの一覧とリスト表示、中央は本文だけ、右に設定） ----------
  // JS の無いブラウザでは今までの 2 列のまま。全画面の形は pe-full（管理画面の枠の上に重ねる）
  var root=document.getElementById("pe-root"), left=document.getElementById("pe-left"), bar=form.querySelector(".pe-bar"), aside=form.querySelector(".split > aside");
  var store=function(k,v){ try{ if(v===undefined) return window.localStorage.getItem("banto.editor."+k); window.localStorage.setItem("banto.editor."+k,v); }catch(_){ return null; } };
  var leftMode=null, outlineTimer=0;
  var libQ, libBody, olBody, tLib, tList, tSet;
  if(root&&left&&bar){
    root.classList.add("pe-full"); document.documentElement.classList.add("pe-lock");
    // 保存しました・誤りの知らせは本文の上へ（枠の外にあると隠れるため）
    var msgs=document.getElementById("pe-msgs");
    if(msgs) Array.prototype.forEach.call(document.querySelectorAll("main > .notice, main > .error"),function(m){ msgs.appendChild(m); if(m.classList.contains("notice")) setTimeout(function(){ if(m.parentNode) m.parentNode.removeChild(m); },6000); });
    // 上のバー: 戻る・ブロックの一覧・リスト表示（左）と、設定（右の端）
    var lg=el("div","pe-bar-left");
    var back=el("a","pe-back",svg(ICO.back)); back.href=root.getAttribute("data-back")||"#"; back.title=T("back"); back.setAttribute("aria-label",T("back"));
    tLib=btn("pe-tog","lib","",T("lib"),"+"); tList=btn("pe-tog","outline","list",T("outline")); tSet=btn("pe-tog","settings","side",T("settings"));
    lg.appendChild(back); lg.appendChild(tLib); lg.appendChild(tList); bar.insertBefore(lg,bar.firstChild); bar.appendChild(tSet);
    // 左の欄
    var head=el("div","pe-left-head"); head.setAttribute("role","tablist");
    var tabLib=btn("","tab-lib","",T("lib"),T("lib")), tabOl=btn("","tab-outline","",T("outline"),T("outline")); tabLib.setAttribute("role","tab"); tabOl.setAttribute("role","tab");
    var closeL=btn("pe-tog","close-left","close",T("close")); closeL.style.marginLeft="auto";
    head.appendChild(tabLib); head.appendChild(tabOl); head.appendChild(closeL);
    var bodyL=el("div","pe-left-body"); left.appendChild(head); left.appendChild(bodyL);
    var libBox=el("div",""), olBox=el("div",""); bodyL.appendChild(libBox); bodyL.appendChild(olBox);
    libQ=document.createElement("input"); libQ.type="search"; libQ.placeholder=T("search"); libQ.setAttribute("aria-label",T("search"));
    libBody=el("div",""); var libHint=el("p","pe-hint"); libHint.textContent=T("lib-hint");
    libBox.appendChild(libQ); libBox.appendChild(libBody); libBox.appendChild(libHint);
    olBody=el("div",""); olBody.setAttribute("role","tree"); olBody.setAttribute("aria-label",T("outline")); olBody.tabIndex=0; olBody.style.position="relative";
    var olHint=el("p","pe-hint"); olHint.textContent=T("outline-hint"); olBox.appendChild(olBody); olBox.appendChild(olHint);
    var wide=function(){ return document.documentElement.clientWidth>900; };
    var setLeft=function(m,keep){
      leftMode=m; left.hidden=!m; libBox.hidden=m!=="lib"; olBox.hidden=m!=="outline";
      tLib.setAttribute("aria-pressed",String(m==="lib")); tList.setAttribute("aria-pressed",String(m==="outline"));
      tabLib.setAttribute("aria-selected",String(m==="lib")); tabOl.setAttribute("aria-selected",String(m==="outline"));
      if(m==="lib") drawLib(); if(m==="outline") drawOutline();
      if(!keep) store("left",m||"");
      if(m&&!wide()&&aside) setSet(false,true);
      refresh();
    };
    var setSet=function(on,keep){ if(!aside) return; aside.hidden=!on; tSet.setAttribute("aria-pressed",String(on)); if(!keep) store("settings",on?"1":"0"); if(on&&!wide()&&leftMode) setLeft(null,true); refresh(); };
    tLib.addEventListener("click",function(){ setLeft(leftMode==="lib"?null:"lib"); if(leftMode==="lib") libQ.focus(); });
    tList.addEventListener("click",function(){ setLeft(leftMode==="outline"?null:"outline"); });
    tabLib.addEventListener("click",function(){ setLeft("lib"); }); tabOl.addEventListener("click",function(){ setLeft("outline"); });
    closeL.addEventListener("click",function(){ setLeft(null); });
    tSet.addEventListener("click",function(){ setSet(aside.hidden); });
    // 前に開いていた形を覚える（広い画面だけ。狭い画面は本文だけで始める）

    // ブロックの一覧: 押すとカーソルの位置に、ドラッグすると置いた場所に入れる
    var libSel=-1, libList=BLOCKS;
    function drawLib(){ var f=libQ.value.trim().toLowerCase(); libList=BLOCKS.filter(function(b){ return match(b,f); }); tiles(libBody,libList,libSel,function(i){ var b=libList[i]; if(b) insertAtCursor(b.k); },dragTile); }
    libQ.addEventListener("input",function(){ libSel=libQ.value.trim()?0:-1; drawLib(); });
    libQ.addEventListener("keydown",function(e){ if(e.key==="Enter"&&libList.length){ e.preventDefault(); insertAtCursor(libList[Math.max(0,libSel)].k); } else if(e.key==="Escape"){ libQ.value=""; libSel=-1; drawLib(); } });
    var newDrag=null;
    function dragTile(e,b,o){
      var x0=e.clientX, y0=e.clientY, moved=false;
      var mv=function(ev){
        if(!moved&&Math.abs(ev.clientX-x0)+Math.abs(ev.clientY-y0)<6) return;
        moved=true; newDrag=b; o.setAttribute("data-dragged","1"); document.body.style.cursor="grabbing";
        var er=ed.getBoundingClientRect();
        if(ev.clientX<er.left||ev.clientX>er.right||ev.clientY<er.top-20||ev.clientY>er.bottom+40){ gap.hidden=true; dropAt=null; return; }
        var slot=slotAt(ev.clientX,Math.max(er.top+1,Math.min(ev.clientY,er.bottom-1)))||ed;
        var bs=boundaries(slot), best=bs[0]; bs.forEach(function(g){ if(Math.abs(g.y-ev.clientY)<Math.abs(best.y-ev.clientY)) best=g; });
        dropAt=best; showGap(best);
      };
      var up=function(){
        document.removeEventListener("pointermove",mv); document.removeEventListener("pointerup",up);
        document.body.style.cursor=""; gap.hidden=true;
        if(moved&&newDrag&&dropAt){ var ref=dropAt.slot.children[dropAt.i]||null; if(ref) insertAt(newDrag.k,ref,"before"); else insertAt(newDrag.k,dropAt.slot.lastElementChild,"after"); }
        newDrag=null; dropAt=null;
      };
      document.addEventListener("pointermove",mv); document.addEventListener("pointerup",up);
    }

    // リスト表示: ブロックの階層（箇条書きの項目・引用の段落は下の段）。押すと本文のそのブロックへ、
    // Shift / Ctrl（⌘）で複数を選び、ドラッグでまとめて動かす・まとめて消す
    var picked=[], anchorB=null, rowsInfo=[];
    function text1(b){ return (b.textContent||"").replace(/\s+/g," ").trim().slice(0,60); }
    function docOrder(xs){ return xs.slice().sort(function(a,b){ return a.compareDocumentPosition(b)&4?-1:1; }); }
    function drawOutline(){
      if(leftMode!=="outline") return;
      picked=picked.filter(isBlock);
      olBody.innerHTML=""; rowsInfo=[];
      var walk=function(slot,level){
        Array.prototype.forEach.call(slot.children,function(b){
          var k=kindOf(b); if(!k) return;
          var row=el("div","ol-row",'<span class="ol-handle">'+svg(ICO.drag)+"</span>"+svg(ICO[k]||ICO.p)); row.style.paddingLeft=(.4+level*1.1)+"rem"; row.setAttribute("role","treeitem"); row.setAttribute("aria-level",String(level+1));
          if(b===sel) row.classList.add("is-cur"); if(picked.indexOf(b)>=0){ row.classList.add("is-pick"); row.setAttribute("aria-selected","true"); }
          var sub=k==="products"?(b.getAttribute("data-tag")?"#"+b.getAttribute("data-tag"):""):k==="accordion"?text1(b.querySelector("[data-acc-title]")||b):CONT[k]||k==="spacer"?"":text1(b);
          var tx=el("span","ol-txt"); tx.textContent=nameOf(k); var sm=el("small",""); sm.textContent=sub; tx.appendChild(sm); row.appendChild(tx);
          row.addEventListener("pointerdown",function(e){ rowDown(e,b); });
          olBody.appendChild(row); rowsInfo.push({b:b,row:row,level:level});
          if(CONT[k]) slotsOf(b).forEach(function(x){ walk(x,level+1); });
          else {
            // 下の段（箇条書きの項目・引用の段落）
            var kids=k==="ul"||k==="ol"?b.querySelectorAll(":scope > li"):k==="q"?b.querySelectorAll(":scope > p"):[];
            Array.prototype.forEach.call(kids,function(c){ var cr=el("div","ol-row ol-child"); cr.style.paddingLeft=(1.9+level*1.1)+"rem"; cr.setAttribute("role","treeitem"); cr.setAttribute("aria-level",String(level+2)); cr.textContent=text1(c)||"\u2014"; cr.addEventListener("click",function(){ caretIn(c); c.scrollIntoView({block:"nearest"}); select(b); }); olBody.appendChild(cr); });
          }
        });
      };
      walk(ed,0);
      if(picked.length>1){
        var pb=el("div","ol-picked"); var n=el("span",""); n.textContent=T("picked").replace("{n}",String(picked.length)); pb.appendChild(n);
        var del=btn("secondary small","pick-del","",T("pick-del"),T("pick-del")); var clr=btn("secondary small","pick-clear","",T("pick-clear"),T("pick-clear"));
        del.addEventListener("click",deletePicked); clr.addEventListener("click",function(){ picked=[]; drawOutline(); });
        pb.appendChild(del); pb.appendChild(clr); olBody.appendChild(pb);
      }
    }
    // 外側の選んだブロックに含まれるものは除く（まとめて動かす・消すとき）
    function tops(xs){ return xs.filter(function(b){ return !xs.some(function(o){ return o!==b&&o.contains(b); }); }); }
    function deletePicked(){
      if(!picked.length) return;
      var colsTouched=[], next=null;
      tops(picked).forEach(function(b){ if(!isBlock(b)) return; var p=b.parentNode; next=b.nextElementSibling||b.previousElementSibling||null; if(isCols(p)) colsTouched.push(p); p.removeChild(b); });
      colsTouched.forEach(fixCols); tidy();
      picked=[]; sel=null; mark(); var n=next&&isBlock(next)?next:ed.lastElementChild; if(n&&!BOXES[kindOf(n)]&&!CONT[kindOf(n)]) caretIn(n); select(n); drawOutline();
    }
    function rowDown(e,b){
      if(e.button!==0) return;
      // 指では ⠿ をつかんだときだけ動かす（ほかの所はなぞるとスクロール、触れると選ぶ）
      var canDrag=e.pointerType!=="touch"||!!(e.target.closest&&e.target.closest(".ol-handle"));
      if(canDrag) e.preventDefault();
      var x0=e.clientX, y0=e.clientY, moved=false, drop=null, line=null;
      var multi=e.shiftKey||e.ctrlKey||e.metaKey;
      // 選ぶ（Shift は同じスロットの中の続き、Ctrl・⌘ は 1 つずつ）
      if(e.shiftKey&&anchorB&&anchorB.parentNode===b.parentNode){ var kids=Array.prototype.slice.call(b.parentNode.children), a=kids.indexOf(anchorB), z=kids.indexOf(b); picked=kids.slice(Math.min(a,z),Math.max(a,z)+1); }
      else if(e.ctrlKey||e.metaKey){ var at0=picked.indexOf(b); if(at0>=0) picked.splice(at0,1); else picked.push(b); anchorB=b; }
      else if(picked.indexOf(b)<0){ picked=[b]; anchorB=b; }
      drawOutline();
      var moving=docOrder(tops(picked.indexOf(b)>=0?picked:[b]));
      var mv=function(ev){
        if(!canDrag) return;
        if(!moved&&Math.abs(ev.clientX-x0)+Math.abs(ev.clientY-y0)<5) return;
        ev.preventDefault(); moved=true; document.body.style.cursor="grabbing"; drop=null;
        // 行の真ん中より上ならその前、下なら後ろ（同じスロットに入る）。動かすものの中・列の決まり・入れ子の上限に合わない所は落とせない
        for(var r=0;r<rowsInfo.length;r++){
          var info=rowsInfo[r], rr=info.row.getBoundingClientRect(); if(ev.clientY<rr.top||ev.clientY>=rr.bottom) continue;
          var tb0=info.b, slot=tb0.parentNode, before=ev.clientY<rr.top+rr.height/2, ok=true, into=null;
          // 中にブロックを持つ囲みの行の真ん中に落とすと、その中の終わりへ（空の囲みにも入れられる）
          var tk=kindOf(tb0);
          if(CONT[tk]&&tk!=="columns"&&tk!=="gallery"&&ev.clientY>rr.top+rr.height*.25&&ev.clientY<rr.bottom-rr.height*.25){ into=slotsOf(tb0)[0]||null; if(into){ slot=into; before=false; } }
          moving.forEach(function(m){ if(m===tb0||m.contains(tb0)) ok=false; var mc=kindOf(m)==="column"; if(mc!==isCols(slot)) ok=false; if(mc&&m.parentNode!==slot) ok=false; if(CONT[kindOf(m)]&&!mc&&tooDeep(slot,heightOf(m))) ok=false; });
          if(ok) drop={slot:slot,ref:into?null:(before?tb0:tb0.nextSibling),row:info.row,before:before,level:info.level,into:!!into};
          break;
        }
        if(!drop){ if(line) line.hidden=true; return; }
        if(!line){ line=el("div","ol-drop"); olBody.appendChild(line); }
        line.hidden=false; line.classList.toggle("ol-into",drop.into);
        if(drop.into){ line.style.top=drop.row.offsetTop+"px"; line.style.height=drop.row.offsetHeight+"px"; line.style.left=(.4+drop.level*1.1)+"rem"; }
        else { line.style.height=""; line.style.top=(drop.row.offsetTop+(drop.before?0:drop.row.offsetHeight)-1)+"px"; line.style.left=(.4+drop.level*1.1)+"rem"; }
      };
      var up=function(){
        document.removeEventListener("pointermove",mv); document.removeEventListener("pointerup",up); document.body.style.cursor="";
        if(line&&line.parentNode) line.parentNode.removeChild(line);
        if(moved&&drop){
          var froms=[]; moving.forEach(function(m){ if(m===drop.ref) return; froms.push(m.parentNode); drop.slot.insertBefore(m,drop.ref); });
          froms.forEach(function(f){ if(isCols(f)&&f!==drop.slot) fixCols(f); }); tidy(); mark();
        } else if(!moved&&!multi){ picked=[b]; var kb=kindOf(b); if(!BOXES[kb]&&!CONT[kb]) caretIn(b); else pin=b; b.scrollIntoView({block:"nearest"}); select(b); }
        drawOutline();
      };
      document.addEventListener("pointermove",mv); document.addEventListener("pointerup",up);
    }
    olBody.addEventListener("keydown",function(e){
      if((e.key==="Delete"||e.key==="Backspace")&&picked.length){ e.preventDefault(); deletePicked(); }
      else if(e.key==="Escape"){ picked=[]; drawOutline(); }
    });
    // 本文が変わったら描き直す（打っているあいだは間をおいて）
    if(window.MutationObserver) new MutationObserver(function(){ if(leftMode!=="outline") return; clearTimeout(outlineTimer); outlineTimer=setTimeout(drawOutline,200); }).observe(ed,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:["class"]});
    // 前に開いていた形を覚える（広い画面だけ。狭い画面は本文だけで始める）。一覧とリスト表示の用意ができてから開く
    var l0=store("left"), s0=store("settings");
    setLeft(wide()?(l0===null?"lib":(l0||null)):null,true);
    setSet(wide()?s0!=="0":false,true);
  }

  // 画像: 選んだら置き場へ上げ、選んでいた場所に入れる
  var inp=document.getElementById("page-image"), imgForm=document.getElementById("page-image-form");
  if(inp&&imgForm){ inp.addEventListener("change",function(){ if(inp.files&&inp.files.length){ if(imgForm.requestSubmit) imgForm.requestSubmit(); } }); }
  var orig=window.bantoPageImage;
  if(orig) window.bantoPageImage=function(url){ restore(); var ok=orig(url); mark(); select(current()); return ok; };
})();`;


/**
 * メディアライブラリ・アイキャッチ画像・予約公開の表示（0080。DB に入っているときだけ画面に出す）。
 * ライブラリは置いた画像の一覧（…/media）から選ぶか、新しく置く。本文に入れるときは選んでいた場所に、アイキャッチなら右の欄に入れる
 */
export const PAGE_MEDIA_SCRIPT = String.raw`
(function(){
  var form=document.getElementById("page-form"); if(!form) return;
  var mark=function(){ form.dispatchEvent(new Event("change",{bubbles:true})); };
  // 予約公開: 未来の日時なら「公開」のボタンを「予約公開」に
  var at=document.getElementById("published_at"), pb=document.getElementById("pe-publish");
  function label(){ if(!pb) return; var v=at&&at.value?new Date(at.value).getTime():0; pb.textContent=v>Date.now()?pb.getAttribute("data-later"):pb.getAttribute("data-now"); }
  if(at){ at.addEventListener("input",label); label(); }
  // アイキャッチ
  var fi=document.getElementById("image_url"), prev=document.getElementById("featured-preview"), clr=document.getElementById("featured-clear");
  function setFeatured(url){ if(!fi) return; fi.value=url||""; if(prev){ prev.src=url||""; prev.hidden=!url; } if(clr) clr.hidden=!url; mark(); }
  if(clr) clr.addEventListener("click",function(){ setFeatured(""); });
  // ライブラリ
  var dlg=document.getElementById("media-lib"); if(!dlg||!dlg.showModal||!window.fetch) return;
  var grid=document.getElementById("media-grid"), mode="body", pickCb=null;
  function pick(url){ dlg.close(); if(mode==="featured") setFeatured(url); else if(mode==="cb"&&pickCb){ var f=pickCb; pickCb=null; f(url); } else if(window.bantoPageImage) window.bantoPageImage(url); }
  function open(m){
    mode=m; grid.textContent="";
    fetch(dlg.getAttribute("data-list"),{credentials:"same-origin",headers:{Accept:"application/json"}}).then(function(r){ return r.json(); }).then(function(j){
      var items=(j&&j.items)||[];
      if(!items.length){ var p=document.createElement("p"); p.className="muted"; p.textContent=dlg.getAttribute("data-empty"); grid.appendChild(p); return; }
      items.forEach(function(it){
        var b=document.createElement("button"); b.type="button"; b.className="secondary"; b.style.cssText="height:auto;padding:2px;aspect-ratio:1/1;overflow:hidden";
        var im=document.createElement("img"); im.src=it.url; im.alt=""; im.loading="lazy"; im.style.cssText="width:100%;height:100%;object-fit:cover";
        b.appendChild(im); b.addEventListener("click",function(){ pick(it.url); }); grid.appendChild(b);
      });
    }).catch(function(){});
    dlg.showModal();
  }
  window.bantoOpenMedia=open;
  // レイアウトのブロック（カバー・画像と文・ギャラリー）が画像を受け取る
  window.bantoPickMedia=function(cb){ pickCb=cb; open("cb"); };
  Array.prototype.forEach.call(document.querySelectorAll("[data-media]"),function(b){ b.hidden=false; b.addEventListener("click",function(){ open(b.getAttribute("data-media")); }); });
  document.getElementById("media-close").addEventListener("click",function(){ dlg.close(); });
  // 新しく置く: 置き終えたら（bantoPageImage が呼ばれる）、アイキャッチを選んでいたならそちらへ
  // 新しく置く: ダイアログの中のファイルの欄で選び（複数可）、置き終えたものから順に、開いたときの行き先（本文・アイキャッチ・ブロック）へ
  var mf=document.getElementById("media-file"), ms=document.getElementById("media-status");
  if(mf) mf.addEventListener("change",function(){
    var files=Array.prototype.slice.call(mf.files||[]); if(!files.length||!window.bantoUploadImage) return;
    var m0=mode, cb=pickCb, n=0;
    var next=function(){
      if(n>=files.length){ ms.textContent=""; mf.value=""; dlg.close(); if(m0==="cb") pickCb=null; return; }
      ms.textContent=(document.getElementById("page-image-form").getAttribute("data-busy")||"")+" ("+(n+1)+"/"+files.length+")";
      window.bantoUploadImage(files[n++]).then(function(url){ if(m0==="featured") setFeatured(url); else if(m0==="cb"&&cb) cb(url); else if(window.bantoPageImage) window.bantoPageImage(url); next(); })
        .catch(function(e){ ms.textContent=(document.getElementById("page-image-form").getAttribute("data-failed")||"")+" "+(e&&e.message||""); mf.value=""; });
    };
    next();
  });
})();`;
