/**
 * ページの本文の「ブロック」（同梱モジュール pages、docs/pages.md「商品を並べる・ボタン」）。
 * 本文は決まった書式のまま、1 行で書く 2 つの形を足す:
 *
 *   ::: products category=tops tag="冬物" limit=8 layout=grid sort=new
 *   ::: button [詳しく見る](/p/coat)
 *
 * - 商品を並べる: **選ぶのは Banto**（公開中の商品だけ、一覧と同じ product_public_list・キャッシュ）、**描くのはテーマ**
 *   （Liquid のテーマは snippets/page-products.liquid、無ければ下の既定のカード）。1 ページに PRODUCT_BLOCKS_MAX まで（速度の予算）
 * - 変換（markdown.ts）は商品の場所に印（productsMarker）を置いた入れ物だけを作り、描くときに中身を入れる（fillProductBlocks）。
 *   本文の文字はすべてエスケープされるので、印は変換しか作れない
 * - ボタン: リンクの規則（https / http / / / # / mailto / tel）は本文のリンクと同じ
 */
import { responsiveImage } from "../media/images";
import { PRODUCT_SORTS, type ProductSort, type ProductSummary } from "../storefront/data";

export type ProductsLayout = "grid" | "scroll";
export interface ProductBlock {
  /** カテゴリーの slug（その子孫も含む）。null ならすべて */
  category: string | null;
  /** このタグを持つ商品だけ。null なら絞らない */
  tag: string | null;
  limit: number;
  layout: ProductsLayout;
  sort: ProductSort;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ESC[ch]!);

/** 1 ページに置ける商品のブロック（これより後のものは描かない） */
export const PRODUCT_BLOCKS_MAX = 3;
export const PRODUCT_BLOCK_LIMIT_MAX = 24;
export const PRODUCT_BLOCK_LIMIT_DEFAULT = 8;

const LINE = /^\s{0,3}:::\s*products(?:\s+(.*))?$/;
const BUTTON = /^\s{0,3}:::\s*button\s+\[([^\]\n]{1,100})\]\(([^)\s]{1,2000})\)\s*$/;
/** ::: で始まる行（段落を区切る） */
export const BLOCK_LINE = /^\s{0,3}:::/;

/** key=value / key="値" の並び（値に " と改行は入らない） */
function attrs(s: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([a-z]+)=(?:"([^"\n]{0,100})"|([^\s"]{1,100}))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.set(m[1]!, m[2] ?? m[3] ?? "");
  return out;
}

/** 「::: products …」の 1 行を読む。形が違えば null（その行はただの文字として出る） */
export function parseProductsLine(line: string): ProductBlock | null {
  const m = LINE.exec(line);
  if (!m) return null;
  const a = attrs(m[1] ?? "");
  const category = a.get("category") || null;
  if (category !== null && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(category)) return null;
  const tag = a.get("tag")?.trim() || null;
  if (tag !== null && tag.length > 50) return null;
  const limitRaw = a.get("limit");
  const limit = limitRaw === undefined ? PRODUCT_BLOCK_LIMIT_DEFAULT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > PRODUCT_BLOCK_LIMIT_MAX) return null;
  const layout = a.get("layout") ?? "grid";
  if (layout !== "grid" && layout !== "scroll") return null;
  const sort = (a.get("sort") ?? "new") as ProductSort;
  if (!PRODUCT_SORTS.includes(sort)) return null;
  return { category, tag, limit, layout, sort };
}

/** ブロック → 1 行（見たままの編集が書き戻す形と同じ） */
export function productsLine(b: ProductBlock): string {
  const parts = ["::: products"];
  if (b.category) parts.push(`category=${b.category}`);
  if (b.tag) parts.push(/^[^\s"]+$/.test(b.tag) ? `tag=${b.tag}` : `tag="${b.tag.replace(/"/g, "")}"`);
  parts.push(`limit=${b.limit}`, `layout=${b.layout}`, `sort=${b.sort}`);
  return parts.join(" ");
}

/** 本文の中の商品のブロック（先頭から PRODUCT_BLOCKS_MAX 個。変換が印を付けるのと同じ順） */
export function productBlocksOf(body: string): ProductBlock[] {
  const out: ProductBlock[] = [];
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (!BLOCK_LINE.test(line)) continue;
    const b = parseProductsLine(line);
    if (b) out.push(b);
    if (out.length >= PRODUCT_BLOCKS_MAX) break;
  }
  return out;
}

export function parseButtonLine(line: string): { text: string; url: string } | null {
  const m = BUTTON.exec(line);
  return m ? { text: m[1]!.trim(), url: m[2]! } : null;
}

/** 商品を入れる場所の印（変換が置き、描くときに中身と入れ替える） */
export const productsMarker = (i: number) => `<!--banto:products:${i}-->`;

/** 印を描いた中身に入れ替える。中身の無い印（取れなかった・数を超えた）は空に */
export function fillProductBlocks(html: string, rendered: readonly string[]): string {
  return html.replace(/<!--banto:products:(\d)-->/g, (_, i: string) => rendered[Number(i)] ?? "");
}

/**
 * 既定のカード（既定のテーマと、snippets/page-products.liquid の無い Liquid のテーマ）。
 * 既定のテーマの一覧と同じクラス（grid / card）に、テーマの CSS が無くても崩れない最小の style を添える
 */
export function defaultProductsHtml(items: readonly ProductSummary[], b: ProductBlock, ctx: { shopPath: string; mediaBaseUrl: string; taxNote: string; yen: (n: number) => string }): string {
  if (items.length === 0) return "";
  const listStyle =
    b.layout === "scroll"
      ? "display:flex;gap:1rem;overflow-x:auto;scroll-snap-type:x mandatory;padding:0 0 .5rem;margin:0;list-style:none"
      : "display:grid;grid-template-columns:repeat(auto-fill,minmax(10rem,1fr));gap:1rem;padding:0;margin:0;list-style:none";
  const itemStyle = b.layout === "scroll" ? "flex:0 0 min(14rem,70%);scroll-snap-align:start" : "";
  const cards = items.map(({ product, image, minPrice, compareAt }) => {
    const img = image ? responsiveImage(ctx.mediaBaseUrl, image) : null;
    const imgHtml = img
      ? `<img src="${escapeHtml(img.src)}"${img.srcset ? ` srcset="${escapeHtml(img.srcset)}"` : ""}${img.sizes ? ` sizes="${escapeHtml(img.sizes)}"` : ""}${img.width ? ` width="${img.width}" height="${img.height}"` : ""} alt="${escapeHtml(product.name)}" loading="lazy" decoding="async" style="width:100%;height:100%;object-fit:cover">`
      : "";
    const price = minPrice !== null ? `<div class="price">${compareAt ? `<s class="muted">${escapeHtml(ctx.yen(compareAt))}</s> ` : ""}${escapeHtml(ctx.yen(minPrice))} <span class="muted">${escapeHtml(ctx.taxNote)}</span></div>` : "";
    return `<li class="card"${itemStyle ? ` style="${itemStyle}"` : ""}><a href="${escapeHtml(`${ctx.shopPath}/p/${encodeURIComponent(product.slug)}`)}" style="display:block;color:inherit;text-decoration:none"><div class="thumb" style="aspect-ratio:1/1;overflow:hidden">${imgHtml}</div><div class="body"><div>${escapeHtml(product.name)}</div>${price}</div></a></li>`;
  });
  return `<ul class="banto-products__list grid" style="${listStyle}">${cards.join("")}</ul>`;
}
