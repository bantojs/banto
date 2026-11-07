/**
 * ショップのページの本文（決まった書式、Markdown の一部）→ HTML（同梱モジュール pages、0079、docs/pages.md）。
 *
 * - **生の HTML は書けない**。文字はすべてエスケープし、HTML にするのはここで決めた形だけ（消毒ではなく、作りの上で安全にする）
 * - リンクは https:// http:// / # mailto: tel: から始まるものだけ。画像はショップの画像の置き場（mediaBase か /media/）のものだけ
 *   （外の画像を読ませない。お客様の閲覧を外に知らせないため）。合わないものは文字のまま出す
 * - 描くときに呼ぶ（DB に HTML を置かない）。長い入力でも行と文字を 1 回ずつなめるだけで、正規表現の後戻りで遅くならない
 *
 * 書ける形: 見出し（# と ## は h2、### は h3、#### 以下は h4）・段落（行の折り返しは <br>）・箇条書き（- * ）・番号付き（1. ）・引用（> ）・
 * 区切り線（---）・表（| a | b | と | --- | --- |）・太字（**）・斜体（* か _）・コード（`）・リンク（[文字](URL)）・画像（![説明](URL)）・
 * 1 行のブロック（::: products … で商品を並べる・::: button [文字](URL) でボタン・::: spacer。src/pages/blocks.ts）・
 * レイアウトの囲み（::: group … ::: のグループ・カラム・カバー・画像と文・ギャラリー・アコーディオン。入れ子 4 段まで。src/pages/layout.ts）
 */
import { APP_BLOCKS_MAX, ARTICLE_BLOCKS_MAX, BLOCK_LINE, PRODUCT_BLOCKS_MAX, appMarker, articlesMarker, parseAppLine, parseArticlesLine, type AppBlock, parseButtonLine, parseProductsLine, productsMarker, type ArticlesBlock, type ProductBlock } from "./blocks";
import { t } from "../i18n";
import { EMBED_CSS, EMBED_SCRIPT, embedHtml, parseEmbedUrl } from "./embeds";
import { currentMarker, LOCAL_SHOP_BLOCKS, SHOP_BLOCKS_CSS, SHOP_BLOCKS_MAX, dateHtml, iconHtml, parseShopBlock, shopMarker, tocMarker, type ShopBlock } from "./shop-blocks";
import { LAYOUT_CSS, LAYOUT_DEPTH_MAX, TABS_MAX, isLayoutClose, layoutEnd, parseAudienceOpen, parseLayoutOpen, parseSpacerLine, type LayoutOpen } from "./layout";

export interface MarkdownOptions {
  /** 画像として受け付ける URL の起点（MEDIA_BASE_URL。無ければ /media/ だけ） */
  mediaBase?: string;
  /**
   * /media/ から始まる画像をこのオリジンの絶対 URL にする（ヘッドレスの API。連携サイトに差し込んでも読めるように）。
   * お店の画面では渡さない（同じオリジンなので /media/ のまま）
   */
  origin?: string;
  /**
   * 管理画面の見たままの編集: 商品のブロックを印の代わりに説明の文字にし、直接は書き換えられない箱にする
   * （お店の画面では渡さない。中身は描くときに入る）
   */
  productsLabel?: (b: ProductBlock) => string;
  /** 管理画面の見たままの編集: 記事のブロックの説明の文字（お店の画面では渡さない） */
  articlesLabel?: (b: ArticlesBlock) => string;
  /** 管理画面の見たままの編集: プラグインのブロック（0086）の説明の文字（お店の画面では渡さない） */
  appLabel?: (b: AppBlock) => string;
  /** お店のブロックの目印の文字（編集の画面だけ） */
  shopLabel?: (b: ShopBlock) => string;
  /** 見せる相手の囲み（0097）の目印の文字（編集の画面だけ。お客様の画面は描く前に src/content/audience-blocks.ts で外す） */
  audienceLabel?: (title: string, id: string | null) => string;
  /**
   * 管理画面の見たままの編集の形で描く（囲みに data-slot、アコーディオンは開け閉めしない箱、画像は書き換えられない箱）。
   * レイアウトの CSS は添えない（管理画面が持つ）
   */
  editor?: boolean;
  /** レイアウトのブロックがあるとき、並べ方の CSS（LAYOUT_CSS）を先頭に 1 回添える（既定 true。editor では添えない） */
  layoutCss?: boolean;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ESC[ch]!);

/** 入れ子の上限（**[*a*](b)** のような重なり。深い入れ子で何度も同じ文字をなめないため） */
const INLINE_DEPTH = 3;

function safeLink(url: string): string | null {
  const u = url.trim();
  if (u.length === 0 || u.length > 2000 || /[\s<>"'`]/.test(u)) return null;
  if (/^https?:\/\/[^/]/i.test(u) || /^mailto:[^/]/i.test(u) || /^tel:[0-9+()-]+$/i.test(u)) return u;
  // / から始まる（// はほかのホストになるので外す）・# から始まる
  if ((u.startsWith("/") && !u.startsWith("//")) || u.startsWith("#")) return u;
  return null;
}

/**
 * 本文とアイキャッチに使える画像の URL（ショップの画像の置き場のものだけ）。描くときの URL を返し、使えなければ null。
 * 管理画面と別の入口（独自ドメインのお店）や、MEDIA_BASE_URL を後から付けた前の画像の URL も、/media/ からとして受ける
 */
export function shopImageUrl(url: string, mediaBase: string | undefined): string | null {
  return safeImage(url, { mediaBase });
}

function safeImage(url: string, opts: MarkdownOptions): string | null {
  const u = mediaPath(url, opts);
  return u && opts.origin && u.startsWith("/media/") ? `${opts.origin.replace(/\/+$/, "")}${u}` : u;
}

function mediaPath(url: string, opts: MarkdownOptions): string | null {
  const u = url.trim();
  if (u.length === 0 || u.length > 2000 || /[\s<>"'`\\]/.test(u) || u.includes("..")) return null;
  const base = opts.mediaBase?.replace(/\/+$/, "");
  if (base && u.startsWith(`${base}/`)) return u;
  if (u.startsWith("/media/")) return u;
  // 別の入口（管理画面の workers.dev と独自ドメインのお店など）の画像の置き場の URL は、ホストを外して /media/ からにする。
  // 指す先はいつもこの Banto の画像の置き場なので、外の画像にはならない
  const other = /^https?:\/\/[^/?#]+(\/media\/[^?#]+)$/i.exec(u);
  if (other) return other[1]!;
  return null;
}

/** リンク・画像の [文字] と (URL) の長さの上限（閉じの無い [ が並んでも、遠くまで探さない） */
const TEXT_SPAN = 300;
const URL_SPAN = 2000;

/** [ の位置から、対応する ] と、その直後の (URL) を探す。見つからなければ null */
function bracket(s: string, open: number): { text: string; url: string; end: number } | null {
  let depth = 0;
  const stop = Math.min(s.length, open + TEXT_SPAN);
  for (let i = open; i < stop; i++) {
    const ch = s[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        if (s[i + 1] !== "(") return null;
        const rel = s.slice(i + 2, i + 2 + URL_SPAN).indexOf(")");
        if (rel < 0) return null;
        return { text: s.slice(open + 1, i), url: s.slice(i + 2, i + 2 + rel), end: i + 3 + rel };
      }
    }
  }
  return null;
}

function inline(s: string, opts: MarkdownOptions, depth = 0): string {
  if (depth > INLINE_DEPTH) return esc(s);
  // 閉じの記号を探して無かったもの（この先にも無いので、同じ記号で探し直さない。閉じの無い記号が並んでも二乗にならない）
  const missing = new Set<string>();
  const find = (mark: string, from: number): number => {
    if (missing.has(mark)) return -1;
    const at = s.indexOf(mark, from);
    if (at < 0) missing.add(mark);
    return at;
  };
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    // \ の後の記号は文字として出す
    if (ch === "\\" && i + 1 < s.length && /[\\`*_[\]()!#>|:-]/.test(s[i + 1]!)) {
      out += esc(s[i + 1]!);
      i += 2;
      continue;
    }
    if (ch === "`") {
      const close = find("`", i + 1);
      if (close > i + 1) {
        out += `<code>${esc(s.slice(i + 1, close))}</code>`;
        i = close + 1;
        continue;
      }
    }
    if (ch === "!" && s[i + 1] === "[" && find("](", i) >= 0) {
      const b = bracket(s, i + 1);
      if (b) {
        const src = safeImage(b.url, opts);
        out += src ? `<img src="${esc(src)}" alt="${esc(b.text)}" loading="lazy" decoding="async">` : esc(b.text);
        i = b.end;
        continue;
      }
    }
    if (ch === "[" && find("](", i) >= 0) {
      const b = bracket(s, i);
      if (b) {
        const href = safeLink(b.url);
        const text = inline(b.text, opts, depth + 1);
        if (href) {
          const external = /^https?:/i.test(href);
          out += `<a href="${esc(href)}"${external ? ' rel="noopener"' : ""}>${text}</a>`;
        } else out += text;
        i = b.end;
        continue;
      }
    }
    if (ch === "*" && s[i + 1] === "*") {
      let close = find("**", i + 2);
      // 「***太字の斜体***」: 閉じの記号が 3 つ続くなら、外側の ** は最後の 2 つ（中は *斜体*）
      if (s[i + 2] === "*") while (close >= 0 && s[close + 2] === "*") close++;
      if (close > i + 2) {
        out += `<strong>${inline(s.slice(i + 2, close), opts, depth + 1)}</strong>`;
        i = close + 2;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && s[i + 1] !== ch && s[i + 1] !== " " && s[i + 1] !== undefined) {
      const close = find(ch, i + 1);
      // _ は単語の中（snake_case）では斜体にしない
      const wordy = ch === "_" && ((i > 0 && /\w/.test(s[i - 1]!)) || (close >= 0 && /\w/.test(s[close + 1] ?? "")));
      if (close > i + 1 && s[close - 1] !== " " && !wordy) {
        out += `<em>${inline(s.slice(i + 1, close), opts, depth + 1)}</em>`;
        i = close + 1;
        continue;
      }
    }
    // 特別な文字が出るまでまとめて進める
    let j = i + 1;
    while (j < s.length && !"\\`![*_".includes(s[j]!)) j++;
    out += esc(s.slice(i, j));
    i = j;
  }
  return out;
}

/** 段落の中の行（行の折り返しは <br>） */
const lines = (ls: string[], opts: MarkdownOptions) => ls.map((l) => inline(l.trim(), opts)).join("<br>");

const LIST_UL = /^\s{0,3}[-*+]\s+(.*)$/;
const LIST_OL = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
/** 見出しの中の行の数の上限（行の末尾の「\」で続ける） */
export const HEADING_LINES_MAX = 4;
const RULE = /^\s{0,3}(?:-\s*){3,}$|^\s{0,3}(?:\*\s*){3,}$|^\s{0,3}(?:_\s*){3,}$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
/** 表の列と行の上限（docs/pages.md「書式」） */
export const TABLE_COLS_MAX = 30;
export const TABLE_ROWS_MAX = 500;
/** 本文の HTML の上限（文字）。超えた本文は「本文が大きすぎます」の段落だけにする（書いた人が、見る人全員の Worker を止められないように） */
export const BODY_HTML_MAX = 1_000_000;

function cells(row: string): string[] {
  let r = row.trim();
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|") && !r.endsWith("\\|")) r = r.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < r.length; i++) {
    if (r[i] === "\\" && r[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (r[i] === "|") {
      out.push(cur.trim());
      cur = "";
    } else cur += r[i];
  }
  out.push(cur.trim());
  return out;
}

interface RenderState {
  opts: MarkdownOptions;
  /** 商品のブロックの数（印の番号。文書の順） */
  products: number;
  /** 記事のブロックの数 */
  articles: number;
  /** プラグインのブロックの数 */
  apps: number;
  /** レイアウトのブロックを描いたか（CSS を添えるため） */
  layout: boolean;
  /** お店のブロック（データを引くもの）の数・お店のブロックを描いたか */
  shop: number;
  shopCss: boolean;
  /** 埋め込みがある（押したら iframe にするスクリプトと CSS を 1 回だけ足す） */
  embed: boolean;
  /** タブの数（ラジオの名前を重ねないため） */
  tabs: number;
  /** 見出し（目次のため。目次のある本文のお店の画面だけ id を振る）と目次のブロック */
  ids: boolean;
  headings: { level: number; id: string; text: string }[];
  tocs: { levels: number; title: string }[];
}

const blank = (l: string | undefined) => l === undefined || l.trim() === "";
const startsBlock = (l: string) => BLOCK_LINE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || LIST_UL.test(l) || LIST_OL.test(l);

export function markdownToHtml(source: string, opts: MarkdownOptions = {}): string {
  const rows = source.replace(/\r\n?/g, "\n").split("\n");
  const st: RenderState = { opts, products: 0, articles: 0, apps: 0, layout: false, shop: 0, shopCss: false, embed: false, tabs: 0, ids: !opts.editor && TOC_LINE.test(source), headings: [], tocs: [] };
  let html = render(rows, 0, st).join("\n");
  if (st.tocs.length) html = html.replace(/<!--banto:toc:(\d+)-->/g, (_, n: string) => tocHtml(st.tocs[Number(n)], st.headings));
  if (html.length > BODY_HTML_MAX) return `<p class="banto-too-large">${esc(t("pages.body_too_large"))}</p>`;
  const css = !opts.editor && opts.layoutCss !== false ? `${st.layout ? LAYOUT_CSS : ""}${st.shopCss ? SHOP_BLOCKS_CSS : ""}${st.embed ? EMBED_CSS : ""}` : "";
  const script = st.embed && !opts.editor ? `\n<script>${EMBED_SCRIPT}</script>` : "";
  return (css ? `<style>${css}</style>\n${html}` : html) + script;
}

/** 目次のブロックの行（ある本文だけ見出しに id を振る。無い本文の HTML は今までと同じ） */
const TOC_LINE = /^\s{0,3}:{3}\s*toc(\s|$)/m;

/**
 * 目次（::: toc）: 本文の見出し（levels までの深さ）を入れ子の番号付きリストに。見出しが無ければ何も出さない。
 * 文字は描いた見出しの中身（エスケープ済み）からタグを外したもの
 */
function tocHtml(toc: { levels: number; title: string } | undefined, headings: readonly { level: number; id: string; text: string }[]): string {
  if (!toc) return "";
  const list = headings.filter((h) => h.level <= toc.levels && h.text);
  if (list.length === 0) return "";
  let html = "<ol>";
  let li = false;
  let sub = false;
  for (const h of list) {
    const item = `<a href="#${h.id}">${h.text}</a>`;
    if (h.level === 2) {
      if (sub) html += "</ol>";
      if (li) html += "</li>";
      html += `<li>${item}`;
      li = true;
      sub = false;
    } else {
      // 小見出し（h2 より前にあれば空の項目の下に）
      if (!li) html += "<li>";
      if (!sub) html += "<ol>";
      html += `<li>${item}</li>`;
      li = true;
      sub = true;
    }
  }
  html += `${sub ? "</ol>" : ""}${li ? "</li>" : ""}</ol>`;
  const title = toc.title ? `<p class="banto-toc__title">${esc(toc.title)}</p>` : "";
  return `<nav class="banto-toc"${toc.title ? ` aria-label="${esc(toc.title)}"` : ""}>${title}${html}</nav>`;
}

const ESC_ATTR = (s: string) => esc(s);

/** 囲みを HTML にする（中身は inner の行を同じ規則で描いたもの） */
function layoutBlock(o: LayoutOpen, inner: string[], depth: number, st: RenderState): string {
  // 文字のスタイルは並べ方の CSS を使わない（見た目はテーマだけ）
  if (o.kind !== "text") st.layout = true;
  const ed = st.opts.editor === true;
  const a = o.attrs;
  const data = (extra = "") => `data-banto-block="${o.kind}"${Object.entries(a).map(([k, v]) => ` data-${k}="${ESC_ATTR(v)}"`).join("")}${o.style ? ` data-style="${o.style}"` : ""}${extra}`;
  // テーマのスタイル（決まった形の名前だけ。見た目はテーマの CSS）
  const sty = o.style ? ` banto-style-${o.style}` : "";
  const slot = ed ? " data-slot" : "";
  const body = () => render(inner, depth + 1, st).join("\n");
  const img = (cls: string, alt: string) => {
    const src = o.image ? safeImage(o.image, st.opts) : null;
    return src ? `<img${cls ? ` class="${cls}"` : ""} src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async"${ed ? ' contenteditable="false"' : ""}>` : "";
  };
  switch (o.kind) {
    case "group":
      return `<div class="banto-group banto-bg-${a["bg"]} banto-pad-${a["pad"]}${sty}" ${data()}${slot}>${body()}</div>`;
    case "text":
      // 文字のスタイル: 余白も背景も足さない。見た目はテーマの CSS（.banto-text.banto-style-<名前> の中の p・h2・ul など）
      return `<div class="banto-text${sty}" ${data()}${slot}>${body()}</div>`;
    case "columns":
      return `<div class="banto-columns banto-cols-${a["ratio"]} banto-valign-${a["valign"]}${sty}" ${data()}${ed ? ' data-slot="cols"' : ""}>${body()}</div>`;
    case "column":
      return `<div class="banto-column${sty}" ${data()}${slot}>${body()}</div>`;
    case "cover": {
      const image = o.image ? safeImage(o.image, st.opts) : null;
      return `<div class="banto-cover banto-cover--h-${a["height"]} banto-cover--overlay-${a["overlay"]} banto-align-${a["align"]} banto-valign-${a["valign"]} banto-cover--focus-${a["focus"]}${sty}" ${data(image ? ` data-image="${esc(image)}"` : "")}>${img("banto-cover__img", "")}<div class="banto-cover__inner"${slot}>${body()}</div></div>`;
    }
    case "media": {
      const image = o.image ? safeImage(o.image, st.opts) : null;
      return `<div class="banto-media banto-media--${a["side"]} banto-valign-${a["valign"]}${sty}" ${data(`${image ? ` data-image="${esc(image)}"` : ""}${o.alt ? ` data-alt="${esc(o.alt)}"` : ""}`)}><figure class="banto-media__fig"${ed ? ' contenteditable="false"' : ""}>${img("", o.alt)}</figure><div class="banto-media__body"${slot}>${body()}</div></div>`;
    }
    case "gallery": {
      // 中は画像の行だけ（![説明](URL)。1 行に並べても、行を分けてもよい）。ほかの文字は描かない
      const figs: string[] = [];
      const re = /!\[([^\]\n]{0,200})\]\(([^)\s]{1,2000})\)/g;
      for (const line of inner) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) && figs.length < 60) {
          const src = safeImage(m[2]!, st.opts);
          if (src) figs.push(`<figure><img src="${esc(src)}" alt="${esc(m[1]!)}" loading="lazy" decoding="async"></figure>`);
        }
      }
      return `<div class="banto-gallery banto-gallery--${a["cols"]}${sty}" ${data()}${ed ? ' contenteditable="false"' : ""}>${figs.join("")}</div>`;
    }
    case "grid":
      return `<div class="banto-grid banto-grid--${a["cols"]}${sty}" ${data()}${slot}>${body()}</div>`;
    case "tab": {
      // タブの外に置かれたタブ（編集の画面以外）は、題つきのグループとして出す
      const title = esc(o.title);
      if (ed) return `<div class="banto-tab${sty}" ${data()}><div class="banto-tab__title" data-acc-title>${title || "<br>"}</div><div class="banto-tab__body" data-slot>${body()}</div></div>`;
      return `<div class="banto-tab${sty}">${title ? `<p><strong>${title}</strong></p>` : ""}${body()}</div>`;
    }
    case "tabs": {
      // 中の「タブ」の囲みだけを拾う（ほかの行は捨てる。編集の画面はタブしか置かせない）
      const tabs: { open: LayoutOpen; rows: string[] }[] = [];
      for (let j = 0; j < inner.length && tabs.length < TABS_MAX; j++) {
        const lo = parseLayoutOpen(inner[j]!);
        if (!lo) continue;
        const end = layoutEnd(inner, j);
        if (lo.kind === "tab") tabs.push({ open: lo, rows: inner.slice(j + 1, end) });
        j = end;
      }
      if (ed) return `<div class="banto-tabs${sty}" ${data(` data-count="${Math.max(2, tabs.length)}"`)} data-slot="tabs">${tabs.map((x) => layoutBlock(x.open, x.rows, depth + 1, st)).join("")}</div>`;
      if (tabs.length === 0) return "";
      const n = st.tabs++;
      const id = (k: number) => `banto-tabs-${n}-${k}`;
      const radios = tabs.map((_, k) => `<input type="radio" class="banto-tabs__r" name="banto-tabs-${n}" id="${id(k)}"${k === 0 ? " checked" : ""}>`).join("");
      const nav = tabs.map((x, k) => `<label for="${id(k)}">${esc(x.open.title) || String(k + 1)}</label>`).join("");
      const panels = tabs.map((x) => `<div class="banto-tabs__panel">${render(x.rows, depth + 2, st).join("\n")}</div>`).join("");
      return `<div class="banto-tabs${sty}" ${data()}>${radios}<div class="banto-tabs__nav">${nav}</div><div class="banto-tabs__panels">${panels}</div></div>`;
    }
    case "accordion": {
      const title = esc(o.title);
      if (ed)
        return `<div class="banto-accordion banto-accordion--${a["icon"]}${sty}" ${data()}><div class="banto-accordion__title" data-acc-title>${title || "<br>"}</div><div class="banto-accordion__body" data-slot>${body()}</div></div>`;
      return `<details class="banto-accordion banto-accordion--${a["icon"]}${sty}" ${data()}${a["open"] === "1" ? " open" : ""}><summary><span class="banto-accordion__title">${title}</span><span class="banto-accordion__icon" aria-hidden="true"></span></summary><div class="banto-accordion__body">${body()}</div></details>`;
    }
  }
}

/** 行の並びを描く（囲みの中も同じ規則。depth は囲みの深さ） */
function render(rows: readonly string[], depth: number, st: RenderState): string[] {
  const opts = st.opts;
  const out: string[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i]!;
    if (blank(row)) {
      i++;
      continue;
    }
    if (BLOCK_LINE.test(row)) {
      // 見せる相手の囲み（0097）。編集の画面は枠と目印で描く。お客様の画面では描く前に外してあるので、
      // ここまで来たもの（外す道を通らない使い方）はだれにも見せない（閉じまで飛ばす）
      const ao = parseAudienceOpen(row);
      if (ao) {
        const end = layoutEnd(rows, i);
        if (opts.editor && depth < LAYOUT_DEPTH_MAX) {
          const label = opts.audienceLabel ? opts.audienceLabel(ao.title, ao.id) : ao.title;
          out.push(`<div class="banto-audience" data-banto-block="audience"${ao.id ? ` data-id="${ao.id}"` : ""}${ao.title ? ` data-title="${esc(ao.title)}"` : ""}><div class="banto-audience__label" contenteditable="false">${esc(label)}</div><div class="banto-audience__body" data-slot>${render(rows.slice(i + 1, end), depth + 1, st).join("\n")}</div></div>`);
        }
        i = end + 1;
        continue;
      }
      // レイアウトの囲み（入れ子は LAYOUT_DEPTH_MAX 段まで。深すぎる囲みは行を外して中身だけ描く）
      const lo = parseLayoutOpen(row);
      if (lo) {
        // 深すぎる囲みは再帰せず、始まりの行を外して平らに続ける（閉じの行は下で捨てる。入れ子の数だけ再帰しない）
        if (depth >= LAYOUT_DEPTH_MAX) {
          i++;
          continue;
        }
        const end = layoutEnd(rows, i);
        out.push(layoutBlock(lo, rows.slice(i + 1, end), depth, st));
        i = end + 1;
        continue;
      }
      // 対になる始まりの無い閉じの行は捨てる
      if (isLayoutClose(row)) {
        i++;
        continue;
      }
      const sp = parseSpacerLine(row);
      if (sp) {
        st.layout = true;
        out.push(`<div class="banto-spacer banto-spacer--${sp.size}" data-banto-block="spacer" data-size="${sp.size}" aria-hidden="true"${opts.editor ? ' contenteditable="false"' : ""}></div>`);
        i++;
        continue;
      }
      // お店のブロック（src/pages/shop-blocks.ts）。アイコンはその場で描き、ほかは印だけ（中身は src/content/body-blocks.ts）
      const sb = parseShopBlock(row);
      // 部品の差し込み（0122）は描く前に本文を置き換えてある。ここまで来たもの（差し込まない使い方）は何も出さない
      if (sb?.kind === "include" && !opts.editor) {
        i++;
        continue;
      }
      if (sb) {
        st.shopCss = true;
        const data = `data-banto-block="shop" data-kind="${sb.kind}" data-attrs="${esc(JSON.stringify(sb.attrs))}"`;
        if (sb.kind === "icon") out.push(opts.editor ? `<div class="banto-shop banto-shop--icon" ${data} contenteditable="false">${iconHtml(sb)}</div>` : `<p class="banto-shop banto-shop--icon">${iconHtml(sb)}</p>`);
        else if (sb.kind === "current" && !opts.editor) out.push(currentMarker(sb.attrs["part"] ?? ""));
        else if (sb.kind === "video") {
          // 置き場の mp4 だけ（ホストも確かめる）。自動で再生するときは音を消し、iPhone で全画面にしない（ブラウザの決まり）
          const src = safeImage(sb.attrs["src"] ?? "", opts);
          const poster = sb.attrs["poster"] ? safeImage(sb.attrs["poster"], opts) : null;
          if (src) {
            const auto = sb.attrs["autoplay"] === "1";
            const flags = `${sb.attrs["controls"] !== "0" || opts.editor ? " controls" : ""}${auto && !opts.editor ? " autoplay" : ""}${auto || opts.editor ? " muted" : ""}${sb.attrs["loop"] === "1" && !opts.editor ? " loop" : ""}`;
            const video = `<video src="${esc(src)}"${poster ? ` poster="${esc(poster)}"` : ""} preload="metadata" playsinline${flags}></video>`;
            if (opts.editor) out.push(`<div class="banto-shop banto-shop--video" ${data} contenteditable="false">${video}</div>`);
            else {
              st.shopCss = true;
              out.push(`<figure class="banto-video">${video}</figure>`);
            }
          }
        } else if (sb.kind === "embed" && !opts.editor) {
          const e = parseEmbedUrl(sb.attrs["url"] ?? "");
          if (e) {
            st.embed = true;
            out.push(embedHtml(e));
          }
        } else if (sb.kind === "date" && !opts.editor) out.push(`<p class="banto-shop banto-shop--date">${dateHtml(sb)}</p>`);
        else if (sb.kind === "toc" && !opts.editor) {
          out.push(tocMarker(st.tocs.length));
          st.tocs.push({ levels: sb.attrs["levels"] === "2" ? 2 : 3, title: sb.attrs["title"] ?? "" });
        }
        else if (opts.editor) out.push(`<div class="banto-shop banto-shop--${sb.kind}" ${data} contenteditable="false">${esc(opts.shopLabel ? opts.shopLabel(sb) : sb.kind)}</div>`);
        else out.push(`<div class="banto-shop banto-shop--${sb.kind}">${st.shop < SHOP_BLOCKS_MAX ? shopMarker(st.shop) : ""}</div>`);
        if (!LOCAL_SHOP_BLOCKS.includes(sb.kind)) st.shop++;
        i++;
        continue;
      }
      // 外部プラグインのブロック（0086）。class はテーマが合わせるための目印（名前は連携とブロックの決まった形だけ）
      const pb = parseAppLine(row);
      if (pb) {
        const data = `data-banto-block="app" data-app="${pb.app}" data-block="${pb.block}" data-product="${pb.product}" data-settings="${esc(JSON.stringify(pb.settings))}"${pb.style ? ` data-style="${pb.style}"` : ""}`;
        const cls = `banto-app banto-app--${pb.app}-${pb.block}${pb.style ? ` banto-style-${pb.style}` : ""}`;
        if (opts.appLabel) out.push(`<div class="${cls}" ${data} contenteditable="false">${esc(opts.appLabel(pb))}</div>`);
        else out.push(`<div class="${cls}" ${data}>${st.apps < APP_BLOCKS_MAX ? appMarker(st.apps) : ""}</div>`);
        st.apps++;
        i++;
        continue;
      }
      const ab = parseArticlesLine(row);
      if (ab) {
        const data = `data-banto-block="articles" data-blog="${ab.blog}" data-tag="${esc(ab.tag ?? "")}" data-limit="${ab.limit}" data-layout="${ab.layout}"${ab.fieldSort ? ` data-sort="field:${ab.fieldSort}"` : ab.sort ? ` data-sort="${ab.sort}"` : ""}${ab.fieldSort && ab.from ? ` data-from="${ab.from}"` : ""}${ab.fieldSort && ab.from && ab.until ? ` data-until="field:${ab.until}"` : ""}${ab.field ? ` data-field="${esc(`${ab.field.key}=${ab.field.value}`)}"` : ""}${ab.style ? ` data-style="${ab.style}"` : ""}`;
        const cls = `banto-articles banto-articles--${ab.layout}${ab.style ? ` banto-style-${ab.style}` : ""}`;
        if (opts.articlesLabel) out.push(`<div class="${cls}" ${data} contenteditable="false">${esc(opts.articlesLabel(ab))}</div>`);
        else out.push(`<div class="${cls}" ${data}>${st.articles < ARTICLE_BLOCKS_MAX ? articlesMarker(st.articles) : ""}</div>`);
        st.articles++;
        i++;
        continue;
      }
      const b = parseProductsLine(row);
      if (b) {
        const data = `data-banto-block="products"${b.slugs?.length ? ` data-slugs="${b.slugs.join(",")}"` : ""}${b.related ? ' data-related="1"' : ""}${b.from ? ` data-from="${b.from}"` : ""} data-category="${esc(b.category ?? "")}" data-tag="${esc(b.tag ?? "")}" data-limit="${b.limit}" data-layout="${b.layout}" data-sort="${b.sort}"${b.style ? ` data-style="${b.style}"` : ""}`;
        const cls = `banto-products banto-products--${b.layout}${b.style ? ` banto-style-${b.style}` : ""}`;
        // 印は先頭から PRODUCT_BLOCKS_MAX 個まで（それより後は描かない）
        if (opts.productsLabel) out.push(`<div class="${cls}" ${data} contenteditable="false">${esc(opts.productsLabel(b))}</div>`);
        else out.push(`<div class="${cls}" ${data}>${st.products < PRODUCT_BLOCKS_MAX ? productsMarker(st.products) : ""}</div>`);
        st.products++;
        i++;
        continue;
      }
      const btn = parseButtonLine(row);
      const href = btn ? safeLink(btn.url) : null;
      if (btn && href) {
        const external = /^https?:/i.test(href);
        out.push(`<p class="banto-button${btn.style ? ` banto-style-${btn.style}` : ""}"${btn.style ? ` data-style="${btn.style}"` : ""}><a class="banto-button__link" href="${esc(href)}"${external ? ' rel="noopener"' : ""}>${esc(btn.text)}</a></p>`);
        i++;
        continue;
      }
    }
    const h = HEADING.exec(row);
    if (h) {
      // ページのタイトルが h1 なので、# と ## は h2、### は h3、それより下は h4
      const level = h[1]!.length <= 2 ? 2 : h[1]!.length === 3 ? 3 : 4;
      // 末尾の閉じの # は外す（正規表現で外すと、長い空白で後戻りが増える）
      let text = h[2]!.trimEnd();
      let k = text.length;
      while (k > 0 && text[k - 1] === "#") k--;
      // 「C#」のような語の中の # は残す（前が空白か行の頭のときだけ閉じの #）
      if (k < text.length && (k === 0 || text[k - 1] === " ")) text = text.slice(0, k);
      // 見出しの中の改行: 行の末尾の「\」で次の行に続ける（HEADING_LINES_MAX 行まで。\\ は文字の \）
      const parts = [text.trimEnd()];
      i++;
      while (parts.length < HEADING_LINES_MAX && /(^|[^\\])\\$/.test(parts[parts.length - 1]!) && i < rows.length && rows[i]!.trim() !== "" && !BLOCK_LINE.test(rows[i]!)) {
        parts[parts.length - 1] = parts[parts.length - 1]!.slice(0, -1).trimEnd();
        parts.push(rows[i]!.trim());
        i++;
      }
      const inner = parts.map((x) => inline(x, opts)).join("<br>");
      if (!st.ids) out.push(`<h${level}>${inner}</h${level}>`);
      else {
        // 目次（::: toc）とリンクで飛べるように id を振る（文書の順の番号。見出しの文字を変えても変わらない）
        const id = `h-${st.headings.length + 1}`;
        st.headings.push({ level, id, text: inner.replace(/<br>/g, " ").replace(/<[^>]*>/g, "").trim() });
        out.push(`<h${level} id="${id}">${inner}</h${level}>`);
      }
      continue;
    }
    if (RULE.test(row)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (QUOTE.test(row)) {
      const ls: string[] = [];
      while (i < rows.length && QUOTE.test(rows[i]!)) ls.push(QUOTE.exec(rows[i++]!)![1]!);
      // 引用の中は段落だけ（入れ子の書式は持たない）
      const paras = ls.join("\n").split(/\n\s*\n/).map((p) => `<p>${lines(p.split("\n"), opts)}</p>`);
      out.push(`<blockquote>${paras.join("")}</blockquote>`);
      continue;
    }
    const list = LIST_UL.test(row) ? ([LIST_UL, "ul"] as const) : LIST_OL.test(row) ? ([LIST_OL, "ol"] as const) : null;
    if (list) {
      const [re, tag] = list;
      const items: string[][] = [];
      while (i < rows.length) {
        const m = re.exec(rows[i]!);
        if (m) items.push([m[1]!]);
        // 字下げした続きの行は前の項目の続き
        else if (items.length > 0 && !blank(rows[i]) && /^\s{2,}\S/.test(rows[i]!) && !startsBlock(rows[i]!)) items[items.length - 1]!.push(rows[i]!);
        else break;
        i++;
      }
      out.push(`<${tag}>${items.map((it) => `<li>${lines(it, opts)}</li>`).join("")}</${tag}>`);
      continue;
    }
    // 表: 見出しの行の次が区切りの行
    if (row.includes("|") && TABLE_SEP.test(rows[i + 1] ?? "")) {
      // 列と行は上限まで（超えた列は捨て、超えた行は打ち切る。列 × 行で出力が膨らまないように）
      const head = cells(row).slice(0, TABLE_COLS_MAX);
      i += 2;
      const body: string[][] = [];
      while (i < rows.length && !blank(rows[i]) && rows[i]!.includes("|")) {
        if (body.length < TABLE_ROWS_MAX) body.push(cells(rows[i]!).slice(0, TABLE_COLS_MAX));
        i++;
      }
      const th = head.map((c) => `<th>${inline(c, opts)}</th>`).join("");
      const tb = body.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? "", opts)}</td>`).join("")}</tr>`).join("");
      out.push(`<div class="banto-table"><table><thead><tr>${th}</tr></thead>${tb ? `<tbody>${tb}</tbody>` : ""}</table></div>`);
      continue;
    }
    // 段落: 空の行か、ほかの形が始まるまで
    const ls: string[] = [];
    while (i < rows.length && !blank(rows[i]) && (ls.length === 0 || !startsBlock(rows[i]!))) ls.push(rows[i++]!);
    out.push(`<p>${lines(ls, opts)}</p>`);
  }
  return out;
}
