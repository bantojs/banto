/**
 * ページの本文の見たままの編集（同梱モジュール pages、0079、docs/pages.md）。管理画面に toString() で埋め込む
 * （送り状 CSV と同じ作り、CLIENT_PRELUDE を前に付ける）。この関数は外の変数を参照しない。
 *
 * - 編集はブラウザの中だけ（contenteditable）。**保存するときは決まった書式（Markdown の一部）に直して送る**。
 *   サーバーは今までどおり Markdown を受け取り、描くときに HTML にするので、見たままの編集で HTML やスクリプトは入らない
 * - 書式は Markdown と同じ範囲だけ（見出し・太字・斜体・コード・リンク・画像・箇条書き・番号付き・引用・区切り線・表・改行）。
 *   それ以外の要素は中の文字だけを残す。貼り付けは文字だけ（ほかのサイトの見た目を持ち込まない）
 * - 「ビジュアル」と「Markdown」を切り替えられる。Markdown → ビジュアルはサーバーで HTML にしてもらう（お店の画面と同じ変換）
 * - JS が無いブラウザでは、今までどおり Markdown の入力欄だけ
 */
export function pageEditorClient() {
  /** 読むだけの DOM（テストでは同じ形の偽物を渡す） */
  interface MdNode {
    nodeType: number;
    nodeName: string;
    childNodes: ArrayLike<MdNode>;
    textContent: string | null;
    getAttribute?(name: string): string | null;
  }

  const BLOCK = /^(P|DIV|H1|H2|H3|H4|H5|H6|UL|OL|LI|BLOCKQUOTE|HR|TABLE|THEAD|TBODY|TR|PRE|SECTION|ARTICLE|FIGURE)$/;

  /** 文字の中の書式の記号を、記号のまま出るように \ を付ける */
  function escapeText(s: string, inTable: boolean): string {
    let out = s.replace(/[\\`*_[\]]/g, (ch) => `\\${ch}`).replace(/!(?=\\\[)/g, "\\!");
    if (inTable) out = out.replace(/\|/g, "\\|");
    return out;
  }

  /** 行の頭が見出し・箇条書き・引用・区切り線・番号付きに見えるなら、頭の記号に \ を付ける */
  function escapeLineStart(line: string): string {
    if (/^\s{0,3}(#|>|[-+*]\s|[-*_]{3,}\s*$)/.test(line)) return line.replace(/^(\s*)([#>\-+*_])/, "$1\\$2");
    if (/^\s{0,3}\d{1,9}[.)]\s/.test(line)) return line.replace(/^(\s*\d{1,9})([.)])/, "$1\\$2");
    // 「:::」で始まる行はブロックの行（商品・ボタン）に読まれるので、文字のままにする
    if (/^\s{0,3}:::/.test(line)) return line.replace(/^(\s*):/, "$1\\:");
    return line;
  }

  const attr = (n: MdNode, k: string) => (n.getAttribute ? (n.getAttribute(k) ?? "") : "");

  /** 書式の記号の内側の端の空白は外へ出す（「** 太字**」は太字にならないため） */
  function wrap(mark: string, inner: string): string {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
    return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
  }

  function inline(n: MdNode, inTable: boolean): string {
    if (n.nodeType === 3) return escapeText((n.textContent ?? "").replace(/[\s ]+/g, " "), inTable);
    if (n.nodeType !== 1) return "";
    const tag = n.nodeName.toUpperCase();
    const kids = () => Array.from(n.childNodes, (c) => inline(c, inTable)).join("");
    switch (tag) {
      case "BR":
        return inTable ? " " : "\n";
      case "STRONG":
      case "B":
        return wrap("**", kids());
      case "EM":
      case "I":
        return wrap("*", kids());
      case "CODE":
        return (n.textContent ?? "").includes("`") ? escapeText(n.textContent ?? "", inTable) : `\`${n.textContent ?? ""}\``;
      case "A": {
        const href = attr(n, "href").trim();
        const text = kids();
        return href && !/[\s()<>]/.test(href) ? `[${text}](${href})` : text;
      }
      case "IMG": {
        const src = attr(n, "src").trim();
        return src && !/[\s()<>]/.test(src) ? `![${escapeText(attr(n, "alt").replace(/[\s ]+/g, " "), false)}](${src})` : "";
      }
      default:
        return BLOCK.test(tag) ? Array.from(n.childNodes, (c) => inline(c, inTable)).join(" ") : kids();
    }
  }

  /** 段落の中の行を整える（行の頭の記号を逃がし、空の行を詰める） */
  function paragraph(text: string): string {
    return text
      .split("\n")
      .map((l) => escapeLineStart(l.trim().replace(/ {2,}/g, " ")))
      .filter((l, i, a) => l !== "" || (i > 0 && i < a.length - 1 && a[i - 1] !== ""))
      .join("\n")
      .trim();
  }

  function listItems(n: MdNode, ordered: boolean, out: string[]): void {
    let k = 1;
    for (const li of Array.from(n.childNodes)) {
      if (li.nodeType !== 1) continue;
      const tag = li.nodeName.toUpperCase();
      if (tag === "UL" || tag === "OL") {
        // 入れ子の箇条書きは書式に無いので、同じ段に並べる
        listItems(li, tag === "OL", out);
        continue;
      }
      const inner: string[] = [];
      const nested: MdNode[] = [];
      for (const c of Array.from(li.childNodes)) {
        const ct = c.nodeType === 1 ? c.nodeName.toUpperCase() : "";
        if (ct === "UL" || ct === "OL") nested.push(c);
        else inner.push(inline(c, false));
      }
      const text = inner.join("").split("\n").map((l) => l.trim()).filter(Boolean);
      if (text.length) out.push(`${ordered ? `${k++}.` : "-"} ${escapeLineStart(text[0]!)}${text.slice(1).map((l) => `\n  ${escapeLineStart(l)}`).join("")}`);
      for (const ns of nested) listItems(ns, ns.nodeName.toUpperCase() === "OL", out);
    }
  }

  function table(n: MdNode): string {
    const rows: string[][] = [];
    const walk = (x: MdNode) => {
      for (const c of Array.from(x.childNodes)) {
        if (c.nodeType !== 1) continue;
        const tag = c.nodeName.toUpperCase();
        if (tag === "TR") rows.push(Array.from(c.childNodes).filter((d) => d.nodeType === 1 && /^(TD|TH)$/i.test(d.nodeName)).map((d) => inline(d, true).replace(/\s+/g, " ").trim()));
        else walk(c);
      }
    };
    walk(n);
    if (rows.length === 0) return "";
    const width = Math.max(...rows.map((r) => r.length), 1);
    const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] || " ").join(" | ")} |`;
    return [line(rows[0]!), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
  }

  /** 商品を並べるブロックの箱 → 「::: products …」の 1 行（値は blocks.ts の parseProductsLine が受ける形だけ） */
  function productsLine(n: MdNode): string {
    const parts = ["::: products"];
    const category = attr(n, "data-category");
    if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(category)) parts.push(`category=${category}`);
    const tag = attr(n, "data-tag").replace(/["\n\r]/g, "").trim().slice(0, 50);
    if (tag) parts.push(/\s/.test(tag) ? `tag="${tag}"` : `tag=${tag}`);
    const limit = Number(attr(n, "data-limit"));
    parts.push(`limit=${Number.isInteger(limit) && limit >= 1 && limit <= 24 ? limit : 8}`);
    parts.push(`layout=${attr(n, "data-layout") === "scroll" ? "scroll" : "grid"}`);
    const sort = attr(n, "data-sort");
    parts.push(`sort=${/^(new|updated|price_asc|price_desc|name)$/.test(sort) ? sort : "new"}`);
    return parts.join(" ");
  }

  /** 塊（段落・見出し・…）を順に Markdown にする。インラインの並びは 1 つの段落にまとめる */
  function blocks(n: MdNode, out: string[]): void {
    let run: MdNode[] = [];
    const flush = () => {
      const p = paragraph(run.map((c) => inline(c, false)).join(""));
      if (p) out.push(p);
      run = [];
    };
    for (const c of Array.from(n.childNodes)) {
      const tag = c.nodeType === 1 ? c.nodeName.toUpperCase() : "";
      if (!tag || !BLOCK.test(tag)) {
        run.push(c);
        continue;
      }
      flush();
      // 商品を並べる・ボタンのブロック（src/pages/blocks.ts と同じ 1 行の形に戻す）
      if (tag === "DIV" && attr(c, "data-banto-block") === "products") {
        const line = productsLine(c);
        if (line) out.push(line);
        continue;
      }
      if (tag === "P" && /(^|\s)banto-button(\s|$)/.test(attr(c, "class"))) {
        const a = Array.from(c.childNodes).find((x) => x.nodeType === 1 && x.nodeName.toUpperCase() === "A");
        const href = a ? attr(a, "href").trim() : "";
        const text = (a?.textContent ?? "").replace(/[\s ]+/g, " ").replace(/[[\]]/g, "").trim().slice(0, 100);
        if (text && href && !/[\s()<>]/.test(href)) out.push(`::: button [${text}](${href})`);
        else if (text) out.push(paragraph(escapeText(text, false)));
        continue;
      }
      if (/^H[1-6]$/.test(tag)) {
        // 見出しはもともと太いので、中の太字は外す（ブラウザは太字のまま見出しにすることがある）
        const text = Array.from(c.childNodes, (x) => inline(x, false)).join("").replace(/(?<!\\)\*\*/g, "").replace(/\s+/g, " ").trim();
        // h1・h2 は ##、h3 は ###、それより下は ####（変換は # を h2 にするため、h1 は使わない）
        if (text) out.push(`${tag === "H1" || tag === "H2" ? "##" : tag === "H3" ? "###" : "####"} ${text}`);
      } else if (tag === "UL" || tag === "OL") {
        const items: string[] = [];
        listItems(c, tag === "OL", items);
        if (items.length) out.push(items.join("\n"));
      } else if (tag === "BLOCKQUOTE") {
        const inner: string[] = [];
        blocks(c, inner);
        // 引用の中は段落だけ（変換と同じ）。行の頭に > を付ける
        const text = inner.join("\n\n").replace(/^(?:#{2,4}|-|\d+\.) /gm, "");
        if (text) out.push(text.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
      } else if (tag === "HR") {
        out.push("---");
      } else if (tag === "TABLE") {
        const t = table(c);
        if (t) out.push(t);
      } else {
        // P・DIV・PRE・LI だけが残った・FIGURE など: 中に塊があれば塊ごとに、無ければ 1 つの段落
        blocks(c, out);
      }
    }
    flush();
  }

  /** 編集の領域（contenteditable）→ 決まった書式 */
  function toMarkdown(root: MdNode): string {
    const out: string[] = [];
    blocks(root, out);
    return out.join("\n\n");
  }

  // ---------- 画面（ブラウザの中だけ） ----------
  interface El {
    value: string;
    innerHTML: string;
    hidden: boolean;
    textContent: string | null;
    childNodes: ArrayLike<MdNode>;
    nodeType: number;
    nodeName: string;
    getAttribute(k: string): string | null;
    setAttribute(k: string, v: string): void;
    addEventListener(t: string, f: (e: Ev) => void): void;
    querySelectorAll(s: string): ArrayLike<El>;
    focus(): void;
    classList: { toggle(c: string, on: boolean): void };
  }
  interface Ev {
    preventDefault(): void;
    target: El | null;
    clipboardData?: { getData(t: string): string } | null;
  }
  interface Doc {
    getElementById(id: string): El | null;
    execCommand(cmd: string, ui?: boolean, value?: string): boolean;
  }
  interface MountConfig {
    /** 本文を HTML にしてもらう先（…/pages/render） */
    render: string;
    t: Record<string, string>;
  }

  function mount(cfg: MountConfig): void {
    const g = globalThis as unknown as { document: Doc; fetch: (u: string, i: unknown) => Promise<{ ok: boolean; json(): Promise<{ html?: string }> }>; prompt: (m: string, d: string) => string | null; FormData: new () => { append(k: string, v: string): void } };
    const doc = g.document;
    const ta = doc.getElementById("body");
    const ed = doc.getElementById("body-visual");
    const form = doc.getElementById("page-form");
    if (!ta || !ed || !form) return;
    let mode: "visual" | "markdown" = "markdown";
    const tabs = doc.getElementById("body-tabs");
    const setMode = (m: "visual" | "markdown") => {
      mode = m;
      ed.hidden = m !== "visual";
      ta.hidden = m === "visual";
      if (tabs)
        for (const b of Array.from(tabs.querySelectorAll("[data-mode]"))) {
          const on = b.getAttribute("data-mode") === m;
          b.setAttribute("aria-selected", String(on));
          // 選んでいる方を塗りのボタンにする
          b.classList.toggle("secondary", !on);
        }
    };
    const toVisual = () => {
      const fd = new g.FormData();
      fd.append("body", ta.value);
      return g.fetch(cfg.render, { method: "POST", body: fd, credentials: "same-origin", headers: { Accept: "application/json" } })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("render"))))
        .then((j) => {
          ed.innerHTML = j.html ?? "";
          setMode("visual");
        });
    };
    if (tabs) {
      tabs.hidden = false;
      for (const b of Array.from(tabs.querySelectorAll("[data-mode]"))) {
        b.addEventListener("click", () => {
          const want = b.getAttribute("data-mode");
          if (want === mode) return;
          if (want === "markdown") {
            ta.value = toMarkdown(ed);
            setMode("markdown");
          } else void toVisual().catch(() => undefined);
        });
      }
    }
    // 最初は見たままで開く（サーバーが入れた HTML がそのまま使える）
    if (ed.getAttribute("data-ready") === "1") setMode("visual");
    // 保存・プレビューの前に Markdown に直す
    form.addEventListener("submit", () => {
      if (mode === "visual") ta.value = toMarkdown(ed);
    });
    // 貼り付けは文字だけ
    ed.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
      doc.execCommand("insertText", false, text);
    });
    ed.addEventListener("drop", (e) => e.preventDefault());
    const run = (cmd: string, value?: string) => {
      ed.focus();
      doc.execCommand(cmd, false, value);
    };
    // 書式のボタン（Markdown のときは今までどおり記号を入れる。そちらは別のスクリプト）
    for (const b of Array.from(doc.getElementById("page-form")!.querySelectorAll("[data-md]"))) {
      b.addEventListener("click", (e) => {
        if (mode !== "visual") return;
        e.preventDefault();
        const k = b.getAttribute("data-md");
        if (k === "h2") run("formatBlock", "<h2>");
        else if (k === "h3") run("formatBlock", "<h3>");
        else if (k === "p") run("formatBlock", "<p>");
        else if (k === "b") run("bold");
        else if (k === "i") run("italic");
        else if (k === "ul") run("insertUnorderedList");
        else if (k === "ol") run("insertOrderedList");
        else if (k === "q") run("formatBlock", "<blockquote>");
        else if (k === "hr") run("insertHorizontalRule");
        else if (k === "table") run("insertHTML", `<table><thead><tr><th>${cfg.t["cell"] ?? ""}</th><th>${cfg.t["cell"] ?? ""}</th></tr></thead><tbody><tr><td>${cfg.t["cell"] ?? ""}</td><td>${cfg.t["cell"] ?? ""}</td></tr></tbody></table><p><br></p>`);
        else if (k === "link") {
          const u = g.prompt(b.getAttribute("data-ask") ?? "URL", "https://");
          if (u) run("createLink", u.replace(/[\s()<>"]/g, ""));
        }
      });
    }
    // 画像を置いたら、見たままのときはその場所に入れる（Markdown のときは別のスクリプトが ![](URL) を入れる）
    (globalThis as unknown as { bantoPageImage?: (url: string) => boolean }).bantoPageImage = (url: string) => {
      if (mode !== "visual") return false;
      run("insertImage", url.replace(/[\s()<>"]/g, ""));
      return true;
    };
  }

  return { toMarkdown, mount };
}
