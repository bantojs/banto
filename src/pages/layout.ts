/**
 * 本文のレイアウトのブロック（グループ・カラム・カバー・画像と文・ギャラリー・アコーディオン・スペーサー。docs/pages.md「レイアウトのブロック」）。
 * メンテナの決定 2026-10-30: WordPress のよく使うブロックを、決まった書式のまま入れ子の囲みとして書けるようにする。
 *
 *   :::: columns ratio=1-2
 *   ::: column
 *   ## 見出し
 *   本文
 *   :::
 *   ::: column
 *   ::: products tag=NEW limit=4
 *   :::
 *   ::::
 *
 * - 囲みは「::: 名前 値…」の行で始まり、「:::」だけの行（: の数は問わない）で一番内側を閉じる。入れ子は LAYOUT_DEPTH_MAX 段まで
 *   （それより深い囲みは、行を外して中身だけを描く）。編集の画面は外側ほど : を多く書く（読みやすさのため。意味は同じ）
 * - **値は決まった選択肢だけ**（背景は none / subtle / accent / dark、余白・高さは s / m / l …）。色や大きさの実際の値は
 *   テーマが決める（CSS の変数 --banto-bg-subtle など。無ければ下の LAYOUT_CSS の既定）。本文に CSS は入らない
 * - 画像は本文の画像と同じ規則（ショップの画像の置き場のものだけ）。カバーの背景も <img> で描く（style に URL を入れない）
 * - 描くのは class だけ。並べ方の最小の CSS（LAYOUT_CSS）は、レイアウトのブロックがあるページにだけ 1 回添える
 */

/** 中に本文を持つ囲み */
export const LAYOUT_CONTAINERS = ["group", "columns", "column", "cover", "media", "gallery", "accordion"] as const;
export type LayoutContainer = (typeof LAYOUT_CONTAINERS)[number];
/** 入れ子の上限（囲みの中の囲み… を 4 段まで） */
export const LAYOUT_DEPTH_MAX = 4;

export const BG = ["none", "subtle", "accent", "dark"] as const;
export const PAD = ["none", "s", "m", "l"] as const;
/** カラムの幅の比（WordPress のよく使う形だけ。列の数もこれで決まる） */
export const RATIOS = ["1-1", "1-2", "2-1", "1-1-1", "1-2-1", "1-1-1-1"] as const;
export const VALIGN = ["top", "center", "bottom"] as const;
export const COVER_HEIGHT = ["s", "m", "l", "full"] as const;
export const OVERLAY = ["none", "light", "dark"] as const;
export const ALIGN = ["left", "center", "right"] as const;
export const SIDE = ["left", "right"] as const;
export const GALLERY_COLS = ["2", "3", "4"] as const;
/** アコーディオンの開け閉めの印（CSS で描く） */
export const ACCORDION_ICONS = ["chevron", "plus", "arrow", "caret", "none"] as const;
export const SPACER = ["s", "m", "l", "xl"] as const;

/** 囲みごとの値と既定（先頭が既定）。image / alt / title は文字の値（下で確かめる） */
export const LAYOUT_ATTRS: Record<LayoutContainer | "spacer", Record<string, readonly string[]>> = {
  group: { bg: BG, pad: PAD },
  columns: { ratio: RATIOS, valign: VALIGN },
  column: {},
  cover: { height: COVER_HEIGHT, overlay: OVERLAY, align: ALIGN, valign: VALIGN },
  media: { side: SIDE, valign: VALIGN },
  gallery: { cols: GALLERY_COLS },
  accordion: { icon: ACCORDION_ICONS, open: ["0", "1"] },
  spacer: { size: SPACER },
};
/** 既定を変えたいもの（先頭以外を既定にする） */
const DEFAULTS: Partial<Record<string, string>> = { "group.pad": "m", "cover.height": "m", "cover.overlay": "dark", "cover.align": "center", "cover.valign": "center", "columns.valign": "top", "media.valign": "center", "gallery.cols": "3", "spacer.size": "m", "accordion.icon": "chevron" };

export interface LayoutOpen {
  kind: LayoutContainer;
  /** 選択肢の値（既定で埋めてある） */
  attrs: Record<string, string>;
  image: string | null;
  alt: string;
  title: string;
}

const OPEN = /^\s{0,3}(:{3,})\s*(group|columns|column|cover|media|gallery|accordion)(?:\s+(.*?))?\s*$/;
const CLOSE = /^\s{0,3}:{3,}\s*$/;
const SPACER_LINE = /^\s{0,3}:{3,}\s*spacer(?:\s+(.*?))?\s*$/;

/** key=value / key="値"（値に " と改行は入らない。title は 200 字、URL は 2000 字まで） */
function readAttrs(s: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([a-z]+)=(?:"([^"\n]{0,200})"|([^\s"]{1,2000}))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.set(m[1]!, m[2] ?? m[3] ?? "");
  return out;
}

function pick(kind: string, a: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, vs] of Object.entries(LAYOUT_ATTRS[kind as LayoutContainer] ?? {})) {
    const v = a.get(k);
    out[k] = v !== undefined && vs.includes(v) ? v : (DEFAULTS[`${kind}.${k}`] ?? vs[0]!);
  }
  return out;
}

/** 値の既定（編集の画面が新しいブロックを作るとき） */
export function layoutDefault(kind: LayoutContainer | "spacer", key: string): string {
  return DEFAULTS[`${kind}.${key}`] ?? LAYOUT_ATTRS[kind][key]?.[0] ?? "";
}

/** 囲みの始まりの行を読む。形が違えば null（その行は文字として出る） */
export function parseLayoutOpen(line: string): LayoutOpen | null {
  const m = OPEN.exec(line);
  if (!m) return null;
  const kind = m[2] as LayoutContainer;
  const a = readAttrs(m[3] ?? "");
  return { kind, attrs: pick(kind, a), image: a.get("image") ?? null, alt: (a.get("alt") ?? "").trim().slice(0, 200), title: (a.get("title") ?? "").trim().slice(0, 200) };
}

export const isLayoutClose = (line: string) => CLOSE.test(line);

/** 「::: spacer size=m」の 1 行 */
export function parseSpacerLine(line: string): { size: string } | null {
  const m = SPACER_LINE.exec(line);
  return m ? { size: pick("spacer", readAttrs(m[1] ?? ""))["size"]! } : null;
}

/** rows[from] が囲みの始まりのとき、対応する閉じの行の位置（無ければ rows.length。閉じずに終わったら最後まで） */
export function layoutEnd(rows: readonly string[], from: number): number {
  let depth = 0;
  for (let i = from; i < rows.length; i++) {
    const r = rows[i]!;
    if (OPEN.test(r)) depth++;
    else if (CLOSE.test(r)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return rows.length;
}

/** 書き戻すときの始まりの行（見たままの編集・テストが使う。値は既定と同じなら省く） */
export function layoutOpenLine(o: Pick<LayoutOpen, "kind" | "attrs"> & Partial<Pick<LayoutOpen, "image" | "alt" | "title">>, colons = 3): string {
  const parts = [`${":".repeat(Math.max(3, colons))} ${o.kind}`];
  for (const [k, vs] of Object.entries(LAYOUT_ATTRS[o.kind])) {
    const v = o.attrs[k];
    if (v && vs.includes(v) && v !== (DEFAULTS[`${o.kind}.${k}`] ?? vs[0])) parts.push(`${k}=${v}`);
  }
  if (o.image && !/[\s"]/.test(o.image)) parts.push(`image=${o.image}`);
  const q = (s: string) => s.replace(/["\n\r]/g, "").trim().slice(0, 200);
  if (o.alt && q(o.alt)) parts.push(`alt="${q(o.alt)}"`);
  if (o.title && q(o.title)) parts.push(`title="${q(o.title)}"`);
  return parts.join(" ");
}

/**
 * 並べ方の最小の CSS（テーマの CSS が無くても崩れない形だけ）。色・余白・高さは変数で、テーマが上書きする:
 *   --banto-bg-subtle / --banto-bg-accent / --banto-fg-accent / --banto-bg-dark / --banto-fg-dark
 *   --banto-pad-s / -m / -l、--banto-gap、--banto-cover-s / -m / -l、--banto-spacer-s / -m / -l / -xl、--banto-radius
 * 狭い画面（40rem まで）ではカラムと画像と文を縦に並べる
 */
export const LAYOUT_CSS = [
  ".banto-group,.banto-cover,.banto-media,.banto-columns,.banto-gallery,.banto-accordion{margin:1.5rem 0;box-sizing:border-box}",
  ".banto-group>:first-child,.banto-column>:first-child,.banto-cover__inner>:first-child,.banto-media__body>:first-child,.banto-accordion__body>:first-child{margin-top:0}",
  ".banto-group>:last-child,.banto-column>:last-child,.banto-cover__inner>:last-child,.banto-media__body>:last-child,.banto-accordion__body>:last-child{margin-bottom:0}",
  ".banto-group{border-radius:var(--banto-radius,.5rem)}",
  ".banto-bg-subtle{background:var(--banto-bg-subtle,rgba(127,127,127,.09))}",
  ".banto-bg-accent{background:var(--banto-bg-accent,var(--accent,#1f6feb));color:var(--banto-fg-accent,#fff)}",
  ".banto-bg-dark{background:var(--banto-bg-dark,#1d1d1f);color:var(--banto-fg-dark,#fff)}",
  ".banto-bg-accent a,.banto-bg-dark a{color:inherit}",
  ".banto-pad-s{padding:var(--banto-pad-s,1rem)}.banto-pad-m{padding:var(--banto-pad-m,2rem)}.banto-pad-l{padding:var(--banto-pad-l,3.5rem)}",
  ".banto-columns{display:grid;gap:var(--banto-gap,1.5rem)}",
  ".banto-cols-1-1{grid-template-columns:1fr 1fr}.banto-cols-1-2{grid-template-columns:1fr 2fr}.banto-cols-2-1{grid-template-columns:2fr 1fr}",
  ".banto-cols-1-1-1{grid-template-columns:repeat(3,1fr)}.banto-cols-1-2-1{grid-template-columns:1fr 2fr 1fr}.banto-cols-1-1-1-1{grid-template-columns:repeat(4,1fr)}",
  ".banto-valign-center{align-items:center}.banto-valign-bottom{align-items:end}",
  ".banto-column{min-width:0}",
  ".banto-cover{position:relative;display:flex;overflow:hidden;border-radius:var(--banto-radius,.5rem);background:var(--banto-bg-dark,#1d1d1f);color:#fff}",
  ".banto-cover--h-s{min-height:var(--banto-cover-s,16rem)}.banto-cover--h-m{min-height:var(--banto-cover-m,26rem)}.banto-cover--h-l{min-height:var(--banto-cover-l,36rem)}.banto-cover--h-full{min-height:100vh;min-height:100svh}",
  ".banto-cover__img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;margin:0}",
  ".banto-cover::after{content:\"\";position:absolute;inset:0;pointer-events:none}",
  ".banto-cover--overlay-dark::after{background:rgba(0,0,0,.45)}.banto-cover--overlay-light::after{background:rgba(255,255,255,.55)}.banto-cover--overlay-light{color:#111}",
  ".banto-cover__inner{position:relative;z-index:1;width:100%;max-width:48rem;margin:auto;padding:var(--banto-pad-m,2rem);box-sizing:border-box}",
  ".banto-cover.banto-align-left .banto-cover__inner{margin-left:0;text-align:left}.banto-cover.banto-align-center .banto-cover__inner{text-align:center}.banto-cover.banto-align-right .banto-cover__inner{margin-right:0;text-align:right}",
  ".banto-cover.banto-valign-top .banto-cover__inner{margin-top:0}.banto-cover.banto-valign-bottom .banto-cover__inner{margin-bottom:0}",
  ".banto-cover a{color:inherit}",
  ".banto-media{display:grid;grid-template-columns:1fr 1fr;gap:var(--banto-gap,1.5rem)}",
  ".banto-media--right .banto-media__fig{order:2}",
  ".banto-media__fig{margin:0}.banto-media__fig img,.banto-gallery img{display:block;width:100%;height:auto;border-radius:var(--banto-radius,.5rem)}",
  ".banto-gallery{display:grid;gap:var(--banto-gap,.75rem)}.banto-gallery figure{margin:0}",
  ".banto-gallery--2{grid-template-columns:repeat(2,1fr)}.banto-gallery--3{grid-template-columns:repeat(3,1fr)}.banto-gallery--4{grid-template-columns:repeat(4,1fr)}",
  ".banto-gallery img{aspect-ratio:1/1;object-fit:cover}",
  ".banto-accordion{border-bottom:1px solid var(--banto-line,rgba(127,127,127,.3));margin:0}",
  ".banto-accordion+.banto-accordion{margin-top:0}",
  ".banto-accordion>summary{display:flex;align-items:center;gap:1rem;padding:1rem 0;cursor:pointer;list-style:none;font-weight:600}",
  ".banto-accordion>summary::-webkit-details-marker{display:none}",
  ".banto-accordion__title{flex:1}",
  ".banto-accordion__icon{flex:none;width:1rem;height:1rem;position:relative;transition:transform .2s}",
  ".banto-accordion--chevron .banto-accordion__icon::before{content:\"\";position:absolute;inset:.15rem .25rem .35rem;border:solid currentColor;border-width:0 2px 2px 0;transform:rotate(45deg)}",
  ".banto-accordion--chevron[open] .banto-accordion__icon{transform:rotate(180deg)}",
  ".banto-accordion--plus .banto-accordion__icon::before,.banto-accordion--plus .banto-accordion__icon::after{content:\"\";position:absolute;left:0;right:0;top:calc(50% - 1px);height:2px;background:currentColor;transition:transform .2s}",
  ".banto-accordion--plus .banto-accordion__icon::after{transform:rotate(90deg)}.banto-accordion--plus[open] .banto-accordion__icon::after{transform:rotate(0)}",
  ".banto-accordion--arrow .banto-accordion__icon::before{content:\"\\2193\";position:absolute;inset:0;line-height:1rem;text-align:center}",
  ".banto-accordion--arrow[open] .banto-accordion__icon{transform:rotate(180deg)}",
  ".banto-accordion--caret .banto-accordion__icon::before{content:\"\";position:absolute;left:.15rem;top:.3rem;border:.35rem solid transparent;border-top-color:currentColor}",
  ".banto-accordion--caret[open] .banto-accordion__icon{transform:rotate(180deg)}",
  ".banto-accordion--none .banto-accordion__icon{display:none}",
  ".banto-accordion__body{padding:0 0 1rem}",
  ".banto-spacer{height:var(--banto-spacer-m,3rem)}.banto-spacer--s{height:var(--banto-spacer-s,1.5rem)}.banto-spacer--l{height:var(--banto-spacer-l,5rem)}.banto-spacer--xl{height:var(--banto-spacer-xl,8rem)}",
  "@media (max-width:40rem){.banto-columns,.banto-media{grid-template-columns:1fr}.banto-media--right .banto-media__fig{order:0}.banto-gallery--3,.banto-gallery--4{grid-template-columns:repeat(2,1fr)}}",
].join("");
