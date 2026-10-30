/**
 * ページの編集画面の操作（同梱モジュール pages、docs/pages.md「編集の画面」）。WordPress のブロックの編集に寄せた手助けで、
 * 見たままの編集（pageEditorClient）の上に重ねる。保存するものは変わらない（決まった書式の本文と、フォームの欄だけ）。
 *
 * - ブロックの挿入: 「＋」のボタンと、空の段落の頭で「/」を打つと出る一覧（段落・見出し・小見出し・箇条書き・番号付き・引用・区切り線・表・画像）
 * - ブロックの操作: いまのブロックを上へ・下へ・消す
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
  if(!(ed.textContent||"").trim()&&!ed.querySelector("img,hr,table")) ed.innerHTML="<p><br></p>";
  ed.addEventListener("input",wrapLoose);
  var BLOCKS=[
    ["p",T("p")],["h2",T("h2")],["h3",T("h3")],["ul",T("ul")],["ol",T("ol")],["q",T("q")],["hr",T("hr")],["table",T("table")],["img",T("img")]
  ];
  var saved=null;
  function remember(){ var s=window.getSelection(); if(s&&s.rangeCount&&ed.contains(s.anchorNode)) saved=s.getRangeAt(0).cloneRange(); }
  function restore(){ ed.focus(); if(saved){ var s=window.getSelection(); s.removeAllRanges(); s.addRange(saved); } }
  document.addEventListener("selectionchange",function(){ remember(); place(); });
  function current(){
    var s=window.getSelection(); var n=s&&s.rangeCount?s.anchorNode:null;
    if(!n||!ed.contains(n)||n===ed) return n===ed?ed.children[Math.min(s.anchorOffset,ed.children.length-1)]||null:null;
    while(n&&n.parentNode!==ed) n=n.parentNode;
    return n&&n.nodeType===1?n:null;
  }
  function caretIn(el){ var r=document.createRange(); r.selectNodeContents(el); r.collapse(false); var s=window.getSelection(); s.removeAllRanges(); s.addRange(r); saved=r.cloneRange(); }
  function emptyP(){ var p=document.createElement("p"); p.appendChild(document.createElement("br")); return p; }
  function apply(kind,blk){
    if(kind==="img"){ var inp=document.getElementById("page-image"); if(inp){ remember(); inp.click(); } return; }
    if(blk){ caretIn(blk); }
    var run=function(c,v){ document.execCommand(c,false,v); };
    if(kind==="p") run("formatBlock","<p>");
    else if(kind==="h2") run("formatBlock","<h2>");
    else if(kind==="h3") run("formatBlock","<h3>");
    else if(kind==="q") run("formatBlock","<blockquote>");
    else if(kind==="ul") run("insertUnorderedList");
    else if(kind==="ol") run("insertOrderedList");
    else if(kind==="hr"){ run("insertHorizontalRule"); }
    else if(kind==="table"){ var c=T("cell"); run("insertHTML","<table><thead><tr><th>"+c+"</th><th>"+c+"</th></tr></thead><tbody><tr><td>"+c+"</td><td>"+c+"</td></tr></tbody></table><p><br></p>"); }
    mark(); place();
  }

  // 「/」の一覧と「＋」の一覧（同じもの）
  var menu=document.createElement("div"); menu.className="blk-menu"; menu.setAttribute("role","listbox"); menu.hidden=true;
  document.body.appendChild(menu);
  var menuFor=null, menuSlash=false, menuSel=0, menuItems=[];
  function openMenu(blk,slash,filter){
    menuFor=blk; menuSlash=slash; menuSel=0;
    var f=(filter||"").toLowerCase();
    menuItems=BLOCKS.filter(function(b){ return !f||b[0].indexOf(f)===0||b[1].toLowerCase().indexOf(f)>=0; });
    if(!menuItems.length){ closeMenu(); return; }
    menu.innerHTML="";
    menuItems.forEach(function(b,i){
      var o=document.createElement("button"); o.type="button"; o.className="blk-opt"; o.setAttribute("role","option"); o.setAttribute("data-k",b[0]); o.textContent=b[1];
      o.addEventListener("mousedown",function(e){ e.preventDefault(); choose(i); });
      menu.appendChild(o);
    });
    highlight();
    var r=(blk||ed).getBoundingClientRect();
    menu.style.top=(window.scrollY+r.bottom+4)+"px"; menu.style.left=(window.scrollX+r.left)+"px";
    menu.hidden=false;
  }
  function highlight(){ Array.prototype.forEach.call(menu.children,function(o,i){ o.setAttribute("aria-selected",String(i===menuSel)); }); }
  function closeMenu(){ menu.hidden=true; menuFor=null; }
  function choose(i){
    var b=menuItems[i]; var blk=menuFor; var slash=menuSlash; closeMenu(); if(!b) return;
    if(slash&&blk){ blk.innerHTML="<br>"; }
    else if(blk){ var p=emptyP(); blk.parentNode.insertBefore(p,blk.nextSibling); blk=p; }
    else { var q=emptyP(); ed.appendChild(q); blk=q; }
    apply(b[0],blk);
  }
  ed.addEventListener("keydown",function(e){
    if(menu.hidden) return;
    if(e.key==="ArrowDown"){ e.preventDefault(); menuSel=(menuSel+1)%menuItems.length; highlight(); }
    else if(e.key==="ArrowUp"){ e.preventDefault(); menuSel=(menuSel+menuItems.length-1)%menuItems.length; highlight(); }
    else if(e.key==="Enter"){ e.preventDefault(); choose(menuSel); }
    else if(e.key==="Escape"){ e.preventDefault(); closeMenu(); }
  });
  ed.addEventListener("input",function(){
    var blk=current(); var txt=blk?(blk.textContent||""):"";
    if(blk&&/^(P|DIV)$/.test(blk.nodeName)&&/^\/[^\s/]{0,12}$/.test(txt)) openMenu(blk,true,txt.slice(1));
    else if(menuSlash) closeMenu();
  });
  document.addEventListener("mousedown",function(e){ if(!menu.hidden&&!menu.contains(e.target)&&!(bar&&bar.contains(e.target))) closeMenu(); });

  // いまのブロックの横に出す操作（＋・上へ・下へ・消す）
  var bar=document.createElement("div"); bar.className="blk-bar"; bar.hidden=true;
  [["add","+",T("add")],["up","↑",T("up")],["down","↓",T("down")],["del","×",T("del")]].forEach(function(x){
    var b=document.createElement("button"); b.type="button"; b.className="blk-btn"; b.setAttribute("data-op",x[0]); b.textContent=x[1]; b.title=x[2]; b.setAttribute("aria-label",x[2]);
    b.addEventListener("mousedown",function(e){ e.preventDefault(); op(x[0]); });
    bar.appendChild(b);
  });
  document.body.appendChild(bar);
  var barFor=null;
  function place(){
    if(ed.hidden){ bar.hidden=true; return; }
    var blk=current(); if(!blk){ return; }
    barFor=blk; bar.hidden=false;
    var r=blk.getBoundingClientRect(), er=ed.getBoundingClientRect();
    bar.style.top=(window.scrollY+Math.max(r.top-bar.offsetHeight-4,er.top-bar.offsetHeight-4))+"px"; bar.style.left=(window.scrollX+er.right-bar.offsetWidth-6)+"px";
  }
  function op(k){
    var blk=barFor; if(!blk||blk.parentNode!==ed) return;
    if(k==="add"){ openMenu(blk,false,""); return; }
    if(k==="up"&&blk.previousElementSibling){ ed.insertBefore(blk,blk.previousElementSibling); }
    else if(k==="down"&&blk.nextElementSibling){ ed.insertBefore(blk.nextElementSibling,blk); }
    else if(k==="del"){ var next=blk.nextElementSibling||blk.previousElementSibling; ed.removeChild(blk); if(!ed.children.length){ next=emptyP(); ed.appendChild(next); } blk=next; }
    mark(); if(blk) caretIn(blk); place();
  }
  var addEnd=document.getElementById("blk-add-end");
  if(addEnd){ addEnd.hidden=false; addEnd.addEventListener("click",function(){ var last=ed.lastElementChild; if(last&&!(last.textContent||"").trim()&&/^(P|DIV)$/.test(last.nodeName)){ openMenu(last,true,""); } else openMenu(last,false,""); }); }
  window.addEventListener("resize",place);
  // 見たままから Markdown に切り替えたら操作を隠す
  Array.prototype.forEach.call(document.querySelectorAll("[data-mode]"),function(b){ b.addEventListener("click",function(){ setTimeout(function(){ if(ed.hidden){ bar.hidden=true; closeMenu(); if(addEnd) addEnd.hidden=true; } else if(addEnd) addEnd.hidden=false; },0); }); });

  // 画像: 選んだら置き場へ上げ、選んでいた場所に入れる
  var inp=document.getElementById("page-image"), imgForm=document.getElementById("page-image-form");
  if(inp&&imgForm){ inp.addEventListener("change",function(){ if(inp.files&&inp.files.length){ if(imgForm.requestSubmit) imgForm.requestSubmit(); } }); }
  var orig=window.bantoPageImage;
  if(orig) window.bantoPageImage=function(url){ restore(); var ok=orig(url); mark(); return ok; };
})();`;
