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
  function wrapLoose(){
    var loose=Array.prototype.filter.call(ed.childNodes,function(n){ return n.nodeType===3?/\S/.test(n.nodeValue||""):(n.nodeType===1&&/^(B|STRONG|I|EM|A|CODE|SPAN|IMG|BR)$/.test(n.nodeName)); });
    if(!loose.length) return;
    var s=window.getSelection(), at=s&&s.rangeCount?s.anchorNode:null, off=s&&s.rangeCount?s.anchorOffset:0;
    var p=document.createElement("p"); ed.insertBefore(p,loose[0]);
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
    back:'<path d="M15 5l-7 7 7 7"/>',
    list:'<path d="M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1"/>',
    side:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    close:'<path d="M6 6l12 12M18 6L6 18"/>'
  };
  // ブロックの一覧（一覧の順・まとまり）
  var BLOCKS=[
    ["p","text"],["h2","text"],["h3","text"],["ul","text"],["ol","text"],["q","text"],["table","text"],["hr","text"],
    ["img","media"],["products","shop"],["button","shop"]
  ].map(function(x){ return {k:x[0],g:x[1],label:T(x[0]),desc:T("d-"+x[0])}; });
  var TEXTY={p:1,h2:1,h3:1,ul:1,ol:1,q:1};
  function kindOf(el){
    if(!el||el.nodeType!==1) return "";
    var n=el.nodeName;
    if(el.getAttribute("data-banto-block")==="products") return "products";
    if(n==="P"&&/(^|\s)banto-button(\s|$)/.test(el.className)) return "button";
    if(n==="H1"||n==="H2") return "h2";
    if(/^H[3-6]$/.test(n)) return "h3";
    if(n==="UL") return "ul"; if(n==="OL") return "ol"; if(n==="BLOCKQUOTE") return "q"; if(n==="HR") return "hr";
    if(n==="TABLE"||el.querySelector("table")) return "table";
    if(!(el.textContent||"").trim()&&el.querySelector("img")) return "img";
    return "p";
  }
  function isEmpty(el){ return !!el&&el.nodeName==="P"&&!(el.textContent||"").trim()&&!el.querySelector("img")&&!/banto-button/.test(el.className); }

  var saved=null, sel=null;
  function remember(){ var s=window.getSelection(); if(s&&s.rangeCount&&ed.contains(s.anchorNode)) saved=s.getRangeAt(0).cloneRange(); }
  function restore(){ ed.focus(); if(saved){ var s=window.getSelection(); s.removeAllRanges(); s.addRange(saved); } }
  function current(){
    var s=window.getSelection(); var n=s&&s.rangeCount?s.anchorNode:null;
    if(!n||!ed.contains(n)) return null;
    if(n===ed) return ed.children[Math.min(s.anchorOffset,ed.children.length-1)]||null;
    while(n&&n.parentNode!==ed) n=n.parentNode;
    return n&&n.nodeType===1?n:null;
  }
  function caretIn(el){ var r=document.createRange(); r.selectNodeContents(el); r.collapse(false); var s=window.getSelection(); s.removeAllRanges(); s.addRange(r); saved=r.cloneRange(); }
  function emptyP(){ var p=document.createElement("p"); p.appendChild(document.createElement("br")); return p; }
  function el(tag,cls,html){ var x=document.createElement(tag); if(cls) x.className=cls; if(html) x.innerHTML=html; return x; }
  function btn(cls,op,ico,label,text){ var b=el("button",cls,(ico?svg(ICO[ico]):"")+(text?"<span></span>":"")); b.type="button"; if(op) b.setAttribute("data-op",op); b.title=label; b.setAttribute("aria-label",label); if(text) b.lastChild.textContent=text; return b; }
  function at(node,r,dx,dy){ node.style.top=(window.scrollY+r.top+(dy||0))+"px"; node.style.left=Math.max(8,Math.min(window.scrollX+r.left+(dx||0),window.scrollX+document.documentElement.clientWidth-node.offsetWidth-8))+"px"; }

  // ---------- 選んでいるブロック（枠・空の行の案内・＋・ブロックの道具） ----------
  function select(b){
    if(sel&&sel!==b&&sel.classList) sel.classList.remove("is-sel");
    sel=b&&b.parentNode===ed?b:null;
    if(sel) sel.classList.add("is-sel");
    refresh();
  }
  function refresh(){
    Array.prototype.forEach.call(ed.querySelectorAll(".is-ph"),function(x){ x.classList.remove("is-ph"); x.removeAttribute("data-ph"); });
    var only=ed.children.length===1&&isEmpty(ed.firstElementChild)?ed.firstElementChild:null;
    var phEl=sel&&isEmpty(sel)&&document.activeElement===ed?sel:only;
    if(phEl){ phEl.classList.add("is-ph"); phEl.setAttribute("data-ph",T("ph")); }
    if(ed.hidden||!sel){ tb.hidden=true; plus.hidden=true; return; }
    var r=sel.getBoundingClientRect();
    if(isEmpty(sel)&&document.activeElement===ed&&ins.hidden&&menu.hidden){ plus.hidden=false; at(plus,r,r.width-30,(r.height-26)/2); } else plus.hidden=true;
    buildTb(kindOf(sel)); tb.hidden=false;
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
    if(pin&&e.key==="Enter"){ e.preventDefault(); var p1=pin; pin=null; if(kindOf(p1)==="products") openProducts(p1,null); else openButton(p1,null); return; }
    pin=null;
    if(e.key.length===1&&!e.ctrlKey&&!e.metaKey) tb.classList.add("typing");
  });
  document.addEventListener("mousemove",function(){ tb.classList.remove("typing"); });
  window.addEventListener("resize",refresh);
  // 本文の欄だけが動く画面（全画面の形）でも追いかける（scroll は泡立たないので捕まえる）
  document.addEventListener("scroll",function(){ gap.hidden=true; if(!tb.hidden||!plus.hidden) refresh(); if(!ins.hidden) closeIns(); },{passive:true,capture:true});

  // ---------- ブロックの道具（種類・動かす・書式・設定・その他） ----------
  var tb=el("div","blk-tb"); tb.setAttribute("role","toolbar"); tb.setAttribute("aria-label",T("type")); tb.hidden=true; document.body.appendChild(tb);
  var tbKind=null;
  function buildTb(k){
    if(tbKind===k) return; tbKind=k; tb.innerHTML="";
    var add=function(b){ b.className="blk-btn"; b.addEventListener("mousedown",function(e){ e.preventDefault(); }); tb.appendChild(b); return b; };
    var sep=function(){ tb.appendChild(el("span","blk-sep")); };
    if(TEXTY[k]){ var tbtn=add(btn("","type",k,T("type"),"\u25BE")); tbtn.setAttribute("aria-haspopup","true"); sep(); }
    else { add(btn("","none",k,T(k))).disabled=true; sep(); }
    add(btn("","drag","drag",T("drag"))); add(btn("","up","up",T("up"))); add(btn("","down","down",T("down")));
    if(TEXTY[k]){ sep(); var bb=add(btn("","bold","",T("bold"),"B")); bb.style.fontWeight="700"; var ib=add(btn("","italic","",T("italic"),"I")); ib.style.fontStyle="italic"; add(btn("","link","link",T("link"))); }
    if(k==="products"||k==="button"){ sep(); add(btn("","edit","edit",T("edit"),T("edit"))); }
    sep(); add(btn("","more","more",T("more"))).setAttribute("aria-haspopup","true");
  }
  tb.addEventListener("click",function(e){
    var b=e.target.closest?e.target.closest("[data-op]"):null; if(!b||!sel) return;
    var k=b.getAttribute("data-op"), blk=sel;
    if(k==="type") openPop(b,BLOCKS.filter(function(x){ return TEXTY[x.k]; }).map(function(x){ return [x.k,x.label,function(){ convert(blk,x.k); }]; }));
    else if(k==="more") openPop(b,[["before",T("before"),function(){ var p=emptyP(); ed.insertBefore(p,blk); openIns(p,"replace",p); }],["after",T("after"),function(){ var p=emptyP(); ed.insertBefore(p,blk.nextSibling); openIns(p,"replace",p); }],["dup",T("dup"),function(){ var c=blk.cloneNode(true); c.classList.remove("is-sel"); ed.insertBefore(c,blk.nextSibling); if(kindOf(c)==="products"){ if(ed.querySelectorAll("[data-banto-block=products]").length>3){ ed.removeChild(c); window.alert(T("products-max")); return; } } mark(); select(c); }],["del",T("del"),function(){ op("del"); }]]);
    else if(k==="up"||k==="down") op(k);
    else if(k==="bold"){ document.execCommand("bold"); mark(); }
    else if(k==="italic"){ document.execCommand("italic"); mark(); }
    else if(k==="link"){ var u=window.prompt(T("link-ask"),"https://"); if(u){ restore(); document.execCommand("createLink",false,u.replace(/[\s()<>"]/g,"")); mark(); } }
    else if(k==="edit"){ if(kindOf(blk)==="products") openProducts(blk,null); else openButton(blk,null); }
  });
  function op(k){
    var blk=sel; if(!blk||blk.parentNode!==ed) return;
    if(k==="up"&&blk.previousElementSibling) ed.insertBefore(blk,blk.previousElementSibling);
    else if(k==="down"&&blk.nextElementSibling) ed.insertBefore(blk.nextElementSibling,blk);
    else if(k==="del"){ var next=blk.nextElementSibling||blk.previousElementSibling; ed.removeChild(blk); if(!ed.children.length){ next=emptyP(); ed.appendChild(next); } sel=null; blk=next; if(blk&&kindOf(blk)!=="products") caretIn(blk); }
    mark(); select(blk);
  }
  // 段落・見出し・引用・箇条書きのあいだで種類を変える。execCommand は印の付いた段落の中に箇条書きを入れ子にすることが
  // あるので、要素を作り直す（箇条書き → 段落は項目ごとに 1 つ、段落 → 箇条書きは 1 項目）
  var TAGS={p:"P",h2:"H2",h3:"H3",q:"BLOCKQUOTE",ul:"UL",ol:"OL"};
  function convert(blk,k){
    if(!blk||blk.parentNode!==ed||kindOf(blk)===k||!TAGS[k]) return;
    var parts=/^(UL|OL)$/.test(blk.nodeName)?Array.prototype.slice.call(blk.children):blk.querySelector(":scope > p, :scope > div")?Array.prototype.slice.call(blk.children):[blk];
    var fill=function(to,from){ while(from.firstChild) to.appendChild(from.firstChild); if(!(to.textContent||"").trim()&&!to.querySelector("img")) { to.innerHTML=""; to.appendChild(document.createElement("br")); } return to; };
    var made=null;
    if(k==="ul"||k==="ol"){ made=document.createElement(TAGS[k]); parts.forEach(function(x){ made.appendChild(fill(document.createElement("li"),x)); }); ed.replaceChild(made,blk); caretIn(made.lastElementChild); }
    else { parts.forEach(function(x){ made=fill(document.createElement(TAGS[k]),x); ed.insertBefore(made,blk); }); ed.removeChild(blk); caretIn(made); }
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
    ["text","media","shop"].forEach(function(g){
      var xs=list.filter(function(b){ return b.g===g; }); if(!xs.length) return;
      var h=el("div","blk-grp"); h.textContent=T("g-"+g); box.appendChild(h);
      var grid=el("div","blk-grid"); box.appendChild(grid);
      xs.forEach(function(b){
        var i=list.indexOf(b); var o=el("button","blk-tile",svg(ICO[b.k])); o.type="button"; o.title=b.desc; o.setAttribute("aria-selected",String(i===cur)); o.appendChild(document.createTextNode(b.label));
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
  function openIns(blk,mode,anchor){
    closeMenu(); closePop(); insFor=blk; insMode=mode; insSel=0; insQ.value=""; drawIns();
    ins.hidden=false; plus.hidden=true; gap.hidden=true;
    var r=(anchor||blk||ed).getBoundingClientRect(); var below=r.bottom+ins.offsetHeight+8<document.documentElement.clientHeight;
    at(ins,r,0,below?r.height+6:-ins.offsetHeight-6);
    insQ.focus();
  }
  function closeIns(){ if(ins.hidden) return; ins.hidden=true; var b=insFor; insFor=null; if(b&&b.parentNode===ed){ if(kindOf(b)!=="products") caretIn(b); } refresh(); }
  function pickIns(i){ var b=insList[i]; var blk=insFor, mode=insMode; ins.hidden=true; insFor=null; if(b) insertAt(b.k,blk,mode); }
  // ブロックを入れる: replace はその空の行に、before / after はその前後に新しい行を作って
  function insertAt(k,ref,mode){
    var blk=ref;
    if(!(mode==="replace"&&ref&&ref.parentNode===ed&&isEmpty(ref))){ blk=emptyP(); if(ref&&ref.parentNode===ed) ed.insertBefore(blk,mode==="before"?ref:ref.nextSibling); else ed.appendChild(blk); }
    apply(k,blk);
  }
  // カーソルの位置に入れる（空の行ならそこ、文字のある行なら後ろ、どこも選んでいなければ終わり）
  function insertAtCursor(k){
    var s0=sel&&sel.parentNode===ed?sel:null, last=ed.lastElementChild;
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
  if(topBtn){ topBtn.addEventListener("mousedown",function(e){ e.preventDefault(); }); topBtn.addEventListener("click",function(){ if(sel&&sel.parentNode===ed) openIns(sel,isEmpty(sel)?"replace":"after",topBtn); else addAtEnd(topBtn); }); }
  if(addEnd) addEnd.addEventListener("click",function(){ addAtEnd(addEnd); });

  // ブロックとブロックのあいだの「＋」（マウスを置くと線と＋が出る）
  var gap=el("div","blk-gap"); gap.hidden=true; var gapBtn=btn("","gap","",T("add"),"+"); gap.appendChild(gapBtn); document.body.appendChild(gap);
  var gapAt=-1;
  function boundaries(){
    var kids=ed.children, out=[]; var er=ed.getBoundingClientRect();
    for(var i=0;i<=kids.length;i++){
      var a=i>0?kids[i-1].getBoundingClientRect():null, b=i<kids.length?kids[i].getBoundingClientRect():null;
      var y=a&&b?(a.bottom+b.top)/2:a?a.bottom+4:b?b.top-4:er.top;
      out.push({i:i,y:y,left:(b||a||er).left,width:(b||a||er).width});
    }
    return out;
  }
  function showGap(g){ gap.hidden=false; gap.style.width=g.width+"px"; at(gap,{top:g.y-1,left:g.left},0,0); gap.style.left=(window.scrollX+g.left)+"px"; }
  document.addEventListener("mousemove",function(e){
    if(dragging||ed.hidden||!ins.hidden||!menu.hidden||!pop.hidden){ if(!dragging) gap.hidden=true; return; }
    if(gap.contains(e.target)) return;
    var er=ed.getBoundingClientRect();
    if(e.clientX<er.left||e.clientX>er.right||e.clientY<er.top-6||e.clientY>er.bottom+6){ gap.hidden=true; gapAt=-1; return; }
    var bs=boundaries(), best=null;
    // 先頭と末尾は除く（そこは上の＋と終わりの＋で足せる）
    for(var i=1;i<bs.length-1;i++){ if(Math.abs(bs[i].y-e.clientY)<9){ best=bs[i]; break; } }
    if(!best){ gap.hidden=true; gapAt=-1; return; }
    gapAt=best.i; showGap(best);
  });
  gapBtn.addEventListener("mousedown",function(e){ e.preventDefault(); });
  gapBtn.addEventListener("click",function(){ var kids=ed.children; if(gapAt<0) return; var p=emptyP(); ed.insertBefore(p,kids[gapAt]||null); gap.hidden=true; mark(); select(p); openIns(p,"replace",p); });

  // ドラッグで動かす（道具の ⠿ を押したまま上下へ）
  var dragging=null, dropAt=-1;
  tb.addEventListener("pointerdown",function(e){
    var b=e.target.closest?e.target.closest("[data-op=drag]"):null; if(!b||!sel) return;
    e.preventDefault(); dragging=sel; dragging.style.opacity=".4"; document.body.style.cursor="grabbing";
  });
  document.addEventListener("pointermove",function(e){
    if(!dragging) return;
    var bs=boundaries(), best=bs[0]; bs.forEach(function(g){ if(Math.abs(g.y-e.clientY)<Math.abs(best.y-e.clientY)) best=g; });
    dropAt=best.i; showGap(best);
  });
  document.addEventListener("pointerup",function(){
    if(!dragging) return; var d=dragging; dragging=null; d.style.opacity=""; document.body.style.cursor=""; gap.hidden=true;
    if(dropAt>=0){ var ref=ed.children[dropAt]||null; if(ref!==d&&ref!==d.nextElementSibling) ed.insertBefore(d,ref); mark(); }
    dropAt=-1; select(d);
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
      var o=el("button","blk-opt",svg(ICO[b.k])); o.type="button"; o.setAttribute("role","option"); o.setAttribute("aria-selected",String(i===menuSel));
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
  ed.addEventListener("mousedown",function(e){ var b=e.target; while(b&&b.parentNode!==ed) b=b.parentNode; pin=null; if(b&&(kindOf(b)==="products"||kindOf(b)==="button")){ e.preventDefault(); ed.focus(); pin=b; select(b); } });
  ed.addEventListener("dblclick",function(e){ var b=e.target; while(b&&b.parentNode!==ed) b=b.parentNode; if(b&&kindOf(b)==="products") openProducts(b,null); else if(b&&kindOf(b)==="button") openButton(b,null); });
  ed.addEventListener("click",function(e){ var a=e.target.closest?e.target.closest("a"):null; if(a&&ed.contains(a)) e.preventDefault(); });

  // ---------- ブロックを入れる ----------
  function apply(kind,blk){
    ed.focus({preventScroll:true});
    if(kind==="img"){ caretIn(blk); select(blk); if(window.bantoOpenMedia){ window.bantoOpenMedia("body"); return; } var inp=document.getElementById("page-image"); if(inp) inp.click(); return; }
    if(kind==="products"){ openProducts(null,blk); return; }
    if(kind==="button"){ openButton(null,blk); return; }
    caretIn(blk);
    var run=function(c,v){ document.execCommand(c,false,v); };
    if(TAGS[kind]){ if(kindOf(blk)===kind) { select(blk); return; } convert(blk,kind); return; }
    else if(kind==="hr"){ var hr=document.createElement("hr"); place2(hr,blk); return; }
    else if(kind==="table"){ var c=T("cell"); run("insertHTML","<table><thead><tr><th>"+c+"</th><th>"+c+"</th></tr></thead><tbody><tr><td>"+c+"</td><td>"+c+"</td></tr></tbody></table><p><br></p>"); }
    mark(); select(current());
  }
  // ブロックの箱（商品・ボタン・区切り線）を blk の場所に置き、後ろに続きを書く段落を用意する
  function place2(box,blk){
    if(blk&&blk.parentNode===ed) ed.replaceChild(box,blk); else ed.appendChild(box);
    // 終わりに置いたときだけ、続きを書く空の行を足す（途中なら次の行へ）
    var next=box.nextElementSibling; if(!next){ next=emptyP(); ed.appendChild(next); }
    if(kindOf(next)==="products"||kindOf(next)==="button") { mark(); select(box); return; }
    caretIn(next); mark(); select(box.nodeName==="HR"?next:box);
  }

  // ---------- ボタンのブロック ----------
  var bdlg=document.getElementById("blk-button");
  function openButton(box,blk){
    if(!bdlg||!bdlg.showModal) return;
    var f=bdlg.querySelector("form"); var a=box?box.querySelector("a"):null;
    f.elements.text.value=a?(a.textContent||""):""; f.elements.url.value=a?(a.getAttribute("href")||""):"";
    bdlg.returnValue="";
    var done=function(){
      bdlg.removeEventListener("close",done);
      var text=String(f.elements.text.value||"").replace(/[\[\]\n]/g,"").trim().slice(0,100), url=String(f.elements.url.value||"").replace(/[\s()<>"]/g,"");
      if(bdlg.returnValue!=="ok"||!text||!url){ if(blk) { caretIn(blk); select(blk); } return; }
      var p=box||document.createElement("p"); p.className="banto-button"; p.innerHTML="";
      var link=document.createElement("a"); link.className="banto-button__link"; link.setAttribute("href",url); link.textContent=text; p.appendChild(link);
      if(box){ mark(); select(box); } else place2(p,blk);
    };
    bdlg.addEventListener("close",done);
    bdlg.showModal(); f.elements.text.focus();
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
  function dataOf(box){ return {category:box.getAttribute("data-category")||"",tag:box.getAttribute("data-tag")||"",limit:parseInt(box.getAttribute("data-limit")||"8",10)||8,layout:box.getAttribute("data-layout")==="scroll"?"scroll":"grid",sort:SORTS[box.getAttribute("data-sort")]?box.getAttribute("data-sort"):"new"}; }
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
    box.className="banto-products banto-products--"+d.layout; box.setAttribute("data-banto-block","products"); box.setAttribute("contenteditable","false");
    box.setAttribute("data-category",d.category); box.setAttribute("data-tag",d.tag); box.setAttribute("data-limit",String(d.limit)); box.setAttribute("data-layout",d.layout); box.setAttribute("data-sort",d.sort);
    box.textContent=""; var head=el("div",""); head.textContent=productsText(d); box.appendChild(head);
    if(sel===box) box.classList.add("is-sel");
    fetchPreview(d).then(function(j){ if(box.getAttribute("data-tag")===d.tag&&box.getAttribute("data-category")===d.category) drawPreview(box,j,true); });
  }
  // 開いたときに、置いてある商品のブロックにも見本を出す
  Array.prototype.forEach.call(ed.querySelectorAll("[data-banto-block=products]"),function(b){ setBox(b,dataOf(b)); });
  var pv=document.getElementById("bp-preview"), pvTimer=0;
  function dlgData(){ var f=dlg.querySelector("form"); var n=parseInt(f.elements.limit.value,10); var cat=/^[a-z0-9][a-z0-9-]{0,62}$/.test(f.elements.category.value)?f.elements.category.value:""; return {category:cat,tag:String(f.elements.tag.value||"").replace(/["\n\r]/g,"").trim().slice(0,50),limit:(n>=1&&n<=24)?n:8,layout:f.elements.layout.value==="scroll"?"scroll":"grid",sort:SORTS[f.elements.sort.value]?f.elements.sort.value:"new"}; }
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
    var l0=store("left"), s0=store("settings");
    setLeft(wide()?(l0===null?"lib":(l0||null)):null,true);
    setSet(wide()?s0!=="0":false,true);

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
        if(ev.clientX<er.left||ev.clientX>er.right||ev.clientY<er.top-20||ev.clientY>er.bottom+40){ gap.hidden=true; dropAt=-1; return; }
        var bs=boundaries(), best=bs[0]; bs.forEach(function(g){ if(Math.abs(g.y-ev.clientY)<Math.abs(best.y-ev.clientY)) best=g; });
        dropAt=best.i; showGap(best);
      };
      var up=function(){
        document.removeEventListener("pointermove",mv); document.removeEventListener("pointerup",up);
        document.body.style.cursor=""; gap.hidden=true;
        if(moved&&newDrag&&dropAt>=0){ var ref=ed.children[dropAt]||null; if(ref) insertAt(newDrag.k,ref,"before"); else insertAt(newDrag.k,ed.lastElementChild,"after"); }
        newDrag=null; dropAt=-1;
      };
      document.addEventListener("pointermove",mv); document.addEventListener("pointerup",up);
    }

    // リスト表示: ブロックの階層（箇条書きの項目・引用の段落は下の段）。押すと本文のそのブロックへ、
    // Shift / Ctrl（⌘）で複数を選び、ドラッグでまとめて動かす・まとめて消す
    var picked=[], anchorIdx=-1;
    function text1(b){ return (b.textContent||"").replace(/\s+/g," ").trim().slice(0,60); }
    function drawOutline(){
      if(leftMode!=="outline") return;
      picked=picked.filter(function(b){ return b.parentNode===ed; });
      olBody.innerHTML="";
      Array.prototype.forEach.call(ed.children,function(b,i){
        var k=kindOf(b); if(!k) return;
        var row=el("div","ol-row",svg(ICO.drag)+svg(ICO[k])); row.setAttribute("role","treeitem"); row.setAttribute("data-i",String(i));
        if(b===sel) row.classList.add("is-cur"); if(picked.indexOf(b)>=0){ row.classList.add("is-pick"); row.setAttribute("aria-selected","true"); }
        var tx=el("span","ol-txt"); tx.textContent=T(k); var sm=el("small",""); sm.textContent=k==="products"?(b.getAttribute("data-tag")?"#"+b.getAttribute("data-tag"):""):text1(b); tx.appendChild(sm); row.appendChild(tx);
        row.addEventListener("pointerdown",function(e){ rowDown(e,b,i); });
        olBody.appendChild(row);
        // 下の段（箇条書きの項目・引用の段落）
        var kids=k==="ul"||k==="ol"?b.querySelectorAll(":scope > li"):k==="q"?b.querySelectorAll(":scope > p"):[];
        Array.prototype.forEach.call(kids,function(c){ var cr=el("div","ol-row ol-child"); cr.setAttribute("role","treeitem"); cr.setAttribute("aria-level","2"); cr.textContent=text1(c)||"—"; cr.addEventListener("click",function(){ caretIn(c); c.scrollIntoView({block:"nearest"}); select(b); }); olBody.appendChild(cr); });
      });
      if(picked.length>1){
        var pb=el("div","ol-picked"); var n=el("span",""); n.textContent=T("picked").replace("{n}",String(picked.length)); pb.appendChild(n);
        var del=btn("secondary small","pick-del","",T("pick-del"),T("pick-del")); var clr=btn("secondary small","pick-clear","",T("pick-clear"),T("pick-clear"));
        del.addEventListener("click",deletePicked); clr.addEventListener("click",function(){ picked=[]; drawOutline(); });
        pb.appendChild(del); pb.appendChild(clr); olBody.appendChild(pb);
      }
    }
    function deletePicked(){
      if(!picked.length) return;
      var next=null; picked.forEach(function(b){ if(b.parentNode===ed){ next=b.nextElementSibling; ed.removeChild(b); } });
      if(!ed.children.length) ed.appendChild(emptyP());
      picked=[]; sel=null; mark(); var n=next&&next.parentNode===ed?next:ed.lastElementChild; if(n&&kindOf(n)!=="products") caretIn(n); select(n); drawOutline();
    }
    function rowDown(e,b,i){
      if(e.button!==0) return;
      var x0=e.clientX, y0=e.clientY, moved=false, drop=-1, line=null;
      var multi=e.shiftKey||e.ctrlKey||e.metaKey;
      // 選ぶ
      if(e.shiftKey&&anchorIdx>=0){ var a=Math.min(anchorIdx,i), z=Math.max(anchorIdx,i); picked=Array.prototype.slice.call(ed.children,a,z+1); }
      else if(e.ctrlKey||e.metaKey){ var at0=picked.indexOf(b); if(at0>=0) picked.splice(at0,1); else picked.push(b); anchorIdx=i; }
      else if(picked.indexOf(b)<0){ picked=[b]; anchorIdx=i; }
      drawOutline();
      var rows=Array.prototype.filter.call(olBody.children,function(r){ return r.classList.contains("ol-row")&&!r.classList.contains("ol-child"); });
      var mv=function(ev){
        if(!moved&&Math.abs(ev.clientX-x0)+Math.abs(ev.clientY-y0)<5) return;
        moved=true; document.body.style.cursor="grabbing";
        // 動かす先: 行の真ん中より上なら前、下なら後ろ
        drop=rows.length; for(var r=0;r<rows.length;r++){ var rr=rows[r].getBoundingClientRect(); if(ev.clientY<rr.top+rr.height/2){ drop=r; break; } }
        var ref=rows[drop]||rows[rows.length-1]; var top=ref?(drop<rows.length?ref.offsetTop:ref.offsetTop+ref.offsetHeight):0;
        if(!line){ line=el("div","ol-drop"); olBody.appendChild(line); } line.style.top=(top-1)+"px";
      };
      var up=function(){
        document.removeEventListener("pointermove",mv); document.removeEventListener("pointerup",up); document.body.style.cursor="";
        if(line&&line.parentNode) line.parentNode.removeChild(line);
        if(moved&&drop>=0){
          var moving=Array.prototype.filter.call(ed.children,function(x){ return picked.indexOf(x)>=0; });
          var ref=null; for(var j=drop;j<ed.children.length;j++){ if(moving.indexOf(ed.children[j])<0){ ref=ed.children[j]; break; } }
          moving.forEach(function(x){ ed.insertBefore(x,ref); }); mark();
        } else if(!multi){ picked=[b]; if(kindOf(b)!=="products"&&kindOf(b)!=="button"){ caretIn(b); } else pin=b; b.scrollIntoView({block:"nearest"}); select(b); }
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
  var grid=document.getElementById("media-grid"), mode="body", featuredUpload=false;
  function pick(url){ dlg.close(); if(mode==="featured") setFeatured(url); else if(window.bantoPageImage) window.bantoPageImage(url); }
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
  Array.prototype.forEach.call(document.querySelectorAll("[data-media]"),function(b){ b.hidden=false; b.addEventListener("click",function(){ open(b.getAttribute("data-media")); }); });
  document.getElementById("media-close").addEventListener("click",function(){ dlg.close(); });
  // 新しく置く: 置き終えたら（bantoPageImage が呼ばれる）、アイキャッチを選んでいたならそちらへ
  document.getElementById("media-upload").addEventListener("click",function(){ featuredUpload=mode==="featured"; dlg.close(); var inp=document.getElementById("page-image"); if(inp) inp.click(); });
  var orig=window.bantoPageImage;
  window.bantoPageImage=function(url){ if(featuredUpload){ featuredUpload=false; setFeatured(url); return true; } return orig?orig(url):false; };
})();`;
