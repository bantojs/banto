/**
 * 本文の「お店のブロック」（1 行のブロック。docs/pages.md「お店のブロック」）。
 *
 *   ::: search placeholder="商品を探す"
 *   ::: categories parent=tops layout=list
 *   ::: card page=about            ／ ::: card article=news/hello
 *   ::: product slug=tee show=image,name,price,options,cart,buy   （options は選択肢の値と見本 0115。押すとその SKU を選んだ商品ページへ）
 *   ::: icon name=truck size=m label="送料無料"
 *   ::: date of=published format=datetime label="投稿日"   （of: published 投稿日時 / updated 最終更新日時 / now 今の日時）
 *   ::: embed url="https://www.youtube.com/watch?v=…"    （YouTube・X・Instagram・TikTok・Reddit・Bluesky。押すまで外へつながない、src/pages/embeds.ts）
 *   ::: current part=title    （ひな形に割り当てたページの中で、今の記事・商品の部品。CURRENT_PARTS。src/content/layouts.ts）
 *   ::: video src="/media/pages/<ショップ>/<名前>.mp4" poster="…" autoplay=1 loop=1 controls=0   （置き場の mp4 だけ、src/media/video.ts）
 *   ::: toc levels=3 title="この記事の目次"   （本文の見出しから。データは引かない。見出しには id を振る）
 *   ::: stores tryon=1 layout=grid articles=events limit=3   （ショップで使う実店舗。店名・住所・電話・今日の営業・曜日ごとの営業時間・臨時休業。
 *                                       articles: その店舗を記事の「実店舗」の項目で指す記事を店舗ごとに添える。
 *                                       sort=field:<key> from=today で添える記事を日付の項目の早い順・今日以降だけに、0124）。
 *                                       show=field:parking,field:brands で実店舗の独自項目（公開のもの、0126）を出す
 *   ::: include page=footer-note   （部品のページの本文をここに差し込む。0122。描く前に src/content/include.ts が置き換える）
 *
 * - 値は決まった形だけ（下の SCHEMA）。知らない鍵・形の違う値は捨てる。生の HTML は入らない
 * - アイコンは決まった一式（src/pages/icons.ts）から選び、その場で SVG を描く（データを引かない）
 * - 日時は本文の HTML に印（<time data-banto-date="…">）だけを置き、描くたびに fillDateBlocks で入れる（本文の HTML の覚えに日時を入れない）。
 *   データは引かない（そのページ・記事の行と今の時刻だけ）。時間帯はデプロイの BANTO_TIMEZONE
 * - ほかはデータが要るので、本文の HTML には印（<!--banto:shop:N-->）だけを置き、お店の画面とヘッドレスの API が
 *   src/content/body-blocks.ts で中身に置き換える（商品・ページ・記事は匿名・会員の読み取りの経路のまま。会員限定のものは合わない人には出ない）
 * - データを引くブロックは 1 ページに SHOP_BLOCKS_MAX まで（多すぎる分は空）
 */
import { ICONS } from "./icons";
import { formatDateTime } from "../i18n/time";
import { parseEmbedUrl } from "./embeds";
import { isPosterUrl, isVideoUrl } from "../media/video";

export type ShopBlockKind = "search" | "categories" | "card" | "product" | "icon" | "date" | "embed" | "video" | "current" | "toc" | "stores" | "include";
export const SHOP_BLOCK_KINDS: readonly ShopBlockKind[] = ["search", "categories", "card", "product", "icon", "date", "embed", "video", "current", "toc", "stores", "include"];
/** データを引かないブロック（印を数えない・body-blocks に渡さない） */
export const LOCAL_SHOP_BLOCKS: readonly ShopBlockKind[] = ["icon", "date", "embed", "video", "current", "toc", "include"];
/** データを引くブロックの数の上限（1 ページ） */
export const SHOP_BLOCKS_MAX = 8;

/** ひな形の「今の記事」の部品（並びは編集の画面の選択肢の順） */
export const CURRENT_PARTS = ["title", "image", "price", "buy", "content", "excerpt", "author", "tags", "attributes", "breadcrumb", "size-chart", "reviews", "prev-next", "products", "filters", "subcategories", "legal", "articles", "sort"] as const;
/** 記事のひな形で使える部品・商品詳細のひな形で使える部品（ほかの部品は空） */
export const ARTICLE_PARTS: readonly CurrentPart[] = ["title", "image", "content", "excerpt", "author", "tags", "prev-next"];
export const PRODUCT_LAYOUT_PARTS: readonly CurrentPart[] = ["title", "image", "price", "buy", "content", "tags", "attributes", "breadcrumb", "size-chart", "reviews"];
/** 商品一覧のひな形で使える部品（0103。image・content はカテゴリーの画像と説明、0113） */
export const COLLECTION_PARTS: readonly CurrentPart[] = ["title", "image", "content", "products", "filters", "sort", "subcategories", "breadcrumb"];
/** ブログの一覧のひな形で使える部品（0114）。articles（記事の並びとページ送り）が見える本文に無ければひな形を使わない */
export const BLOG_LIST_PARTS: readonly CurrentPart[] = ["title", "content", "articles", "filters", "breadcrumb"];
/** 法務のページのひな形で使える部品（0104）。legal（文面）が見える本文に無ければひな形を使わない */
export const LEGAL_PARTS: readonly CurrentPart[] = ["title", "legal"];
export type CurrentPart = (typeof CURRENT_PARTS)[number];
export const currentMarker = (part: string) => `<!--banto:current:${part}-->`;

/** 商品のブロックで出せる項目（並びはこの順で描く） */
export const PRODUCT_PARTS = ["image", "name", "price", "options", "sku", "tags", "description", "cart", "buy"] as const;
export type ProductPart = (typeof PRODUCT_PARTS)[number];
/** 商品の独自項目（shops.settings.product_fields の公開の項目）を出す部品: field:<key> */
export const PRODUCT_FIELD_PART = /^field:[a-z][a-z0-9_]{0,39}$/;
export type ProductShowPart = ProductPart | `field:${string}`;
export const PRODUCT_PARTS_DEFAULT: readonly ProductPart[] = ["image", "name", "price", "cart"];

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TEXT = (v: string) => v.replace(/["\n\r]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);

/** url: 大文字小文字を変えず、引用符で書き戻す（300 文字まで。形は test で確かめる） */
type Field = { values?: readonly string[]; test?: (v: string) => boolean; text?: true; url?: true; def?: string };
/** ブロックごとの鍵と値の形（def は省いたときの値。書き戻すときは def と同じなら省く） */
export const SHOP_BLOCK_SCHEMA: Record<ShopBlockKind, Record<string, Field>> = {
  search: { placeholder: { text: true } },
  categories: { parent: { test: (v) => SLUG.test(v) }, layout: { values: ["list", "grid"], def: "list" } },
  card: { page: { test: (v) => SLUG.test(v) }, article: { test: (v) => /^[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9-]{0,62}$/.test(v) } },
  product: { slug: { test: (v) => SLUG.test(v) }, show: { test: (v) => v.split(",").length <= 30 && v.split(",").every((x) => (PRODUCT_PARTS as readonly string[]).includes(x) || PRODUCT_FIELD_PART.test(x)) } },
  icon: { name: { test: (v) => Object.prototype.hasOwnProperty.call(ICONS, v) }, size: { values: ["s", "m", "l", "xl"], def: "m" }, tone: { values: ["text", "accent", "muted"], def: "text" }, label: { text: true } },
  embed: { url: { url: true, test: (v) => parseEmbedUrl(v) !== null } },
  // field:<key> は記事の項目（0117）
  current: { part: { test: (v) => (CURRENT_PARTS as readonly string[]).includes(v) || /^field:[a-z][a-z0-9_]{0,39}$/.test(v) } },
  video: { src: { url: true, test: isVideoUrl }, poster: { url: true, test: isPosterUrl }, autoplay: { values: ["0", "1"], def: "0" }, loop: { values: ["0", "1"], def: "0" }, controls: { values: ["0", "1"], def: "1" } },
  date: { of: { values: ["published", "updated", "now"], def: "published" }, format: { values: ["date", "datetime"], def: "date" }, label: { text: true } },
  toc: { levels: { values: ["2", "3"], def: "3" }, title: { text: true } },
  // articles: 店舗ごとに添える記事のブログ（:<キー> は記事の「実店舗」の項目。1 つしか無ければ省ける）。limit は店舗ごとの数
  stores: { tryon: { values: ["0", "1"], def: "0" }, layout: { values: ["list", "grid"], def: "list" }, articles: { test: (v) => /^[a-z0-9][a-z0-9-]{0,62}(?::[a-z][a-z0-9_]{0,39})?$/.test(v) }, limit: { values: ["1", "2", "3", "4", "5", "6"], def: "3" }, sort: { test: (v) => /^field:[a-z][a-z0-9_]{0,39}$/.test(v) }, from: { values: ["today"] }, until: { test: (v) => /^field:[a-z][a-z0-9_]{0,39}$/.test(v) }, show: { test: (v) => v.split(",").length <= 10 && v.split(",").every((x) => /^field:[a-z][a-z0-9_]{0,39}$/.test(x)) } },
  include: { page: { test: (v) => SLUG.test(v) } },
};

export interface ShopBlock {
  kind: ShopBlockKind;
  /** 決まった形に通した値（既定の値も埋めてある） */
  attrs: Record<string, string>;
}

const LINE = /^\s{0,3}:{3}\s*(search|categories|card|product|icon|date|embed|video|current|toc|stores|include)(?:\s+(.*?))?\s*$/;

/** 1 行を読む。形が違えば null（その行は文字として出る）。必須の値が無いもの（商品の slug など）も null */
export function parseShopBlock(line: string): ShopBlock | null {
  const m = LINE.exec(line);
  if (!m) return null;
  const kind = m[1] as ShopBlockKind;
  const schema = SHOP_BLOCK_SCHEMA[kind];
  const attrs: Record<string, string> = {};
  const re = /([a-z]+)=(?:"([^"\n]{0,300})"|([^\s"]{1,300}))/g;
  let a: RegExpExecArray | null;
  while ((a = re.exec(m[2] ?? ""))) {
    const key = a[1]!;
    const f = schema[key];
    if (!f) continue;
    const raw = a[2] ?? a[3] ?? "";
    const v = f.text ? TEXT(raw) : f.url ? raw.trim() : raw.trim().toLowerCase();
    if (f.text ? v !== "" : f.url ? v.length <= 300 && (f.test ? f.test(v) : false) : f.values ? f.values.includes(v) : f.test ? f.test(v) : false) attrs[key] = v;
  }
  for (const [k, f] of Object.entries(schema)) if (f.def !== undefined && attrs[k] === undefined) attrs[k] = f.def;
  if (kind === "product" && !attrs["slug"]) return null;
  if (kind === "icon" && !attrs["name"]) return null;
  if (kind === "embed" && !attrs["url"]) return null;
  if (kind === "video" && !attrs["src"]) return null;
  if (kind === "current" && !attrs["part"]) return null;
  if (kind === "include" && !attrs["page"]) return null;
  if (kind === "card" && !attrs["page"] && !attrs["article"]) return null;
  if (kind === "card" && attrs["page"] && attrs["article"]) delete attrs["article"];
  return { kind, attrs };
}

/** 書き戻す 1 行（既定の値は省く。値に空白があれば引用符） */
export function shopBlockLine(b: ShopBlock): string {
  const schema = SHOP_BLOCK_SCHEMA[b.kind];
  const parts: string[] = [b.kind];
  for (const [k, f] of Object.entries(schema)) {
    const v = b.attrs[k];
    if (v === undefined || v === "" || v === f.def) continue;
    parts.push(f.text ? `${k}="${TEXT(v)}"` : f.url ? `${k}="${v.replace(/["\n\r]/g, "")}"` : `${k}=${v}`);
  }
  return `::: ${parts.join(" ")}`;
}

/** 本文の中のデータを引くお店のブロック（文書の順、上限まで） */
export function shopBlocksOf(body: string): ShopBlock[] {
  const out: ShopBlock[] = [];
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const b = parseShopBlock(line);
    if (b && !LOCAL_SHOP_BLOCKS.includes(b.kind)) out.push(b);
    if (out.length >= SHOP_BLOCKS_MAX) break;
  }
  return out;
}

export const shopMarker = (i: number) => `<!--banto:shop:${i}-->`;
export function fillShopBlocks(html: string, rendered: readonly string[]): string {
  return html.replace(/<!--banto:shop:(\d+)-->/g, (_, n: string) => rendered[Number(n)] ?? "");
}

export const productPartsOf = (b: ShopBlock): ProductShowPart[] => (b.attrs["show"] ? (b.attrs["show"].split(",") as ProductShowPart[]) : [...PRODUCT_PARTS_DEFAULT]);

/** 目次の印（見出しは描き終わってから集めるので、本文の HTML には印だけを置く。markdownToHtml が入れる） */
export const tocMarker = (i: number) => `<!--banto:toc:${i}-->`;

/** アイコンの SVG（決まった一式だけ。label があれば読み上げる、無ければ飾り） */
export function iconHtml(b: ShopBlock): string {
  const inner = ICONS[b.attrs["name"] ?? ""];
  if (!inner) return "";
  const label = b.attrs["label"] ?? "";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const a11y = label ? ` role="img" aria-label="${esc(label)}"` : ' aria-hidden="true"';
  const text = label ? `<span class="banto-icon__label">${esc(label)}</span>` : "";
  return `<span class="banto-icon banto-icon--${b.attrs["size"]} banto-icon--${b.attrs["tone"]}"${a11y}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false">${inner}</svg>${text}</span>`;
}

/** 日時のブロックの HTML（印。時刻は描くたびに fillDateBlocks が入れる） */
export function dateHtml(b: ShopBlock): string {
  const label = b.attrs["label"] ?? "";
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `${label ? `<span class="banto-date__label">${esc(label)}</span> ` : ""}<time data-banto-date="${b.attrs["of"]}|${b.attrs["format"]}"></time>`;
}

/** 日時の材料（そのページ・記事の投稿日時と最終更新日時。ISO）。無ければ印は空になる */
export interface DateContext {
  published?: string | null;
  updated?: string | null;
  now?: Date;
}

/** 日時の印を入れる（運営者の時間帯の表示と、機械が読む datetime） */
export function fillDateBlocks(html: string, d: DateContext): string {
  if (!html.includes("data-banto-date=")) return html;
  return html.replace(/<time data-banto-date="(published|updated|now)\|(date|datetime)"><\/time>/g, (_, of: string, format: string) => {
    const iso = of === "now" ? (d.now ?? new Date()).toISOString() : of === "updated" ? d.updated : d.published;
    if (!iso || Number.isNaN(new Date(iso).getTime())) return "";
    return `<time class="banto-date" datetime="${new Date(iso).toISOString()}">${formatDateTime(iso, { dateOnly: format === "date" })}</time>`;
  });
}

/** お店のブロックの最小の CSS（ブロックがあるページにだけ添える。色と大きさはテーマの CSS の変数） */
export const SHOP_BLOCKS_CSS = [
  ".banto-icon{display:inline-flex;align-items:center;gap:.4em;vertical-align:middle}.banto-icon svg{width:1.5em;height:1.5em;flex:none}",
  ".banto-icon--s{font-size:.85em}.banto-icon--l{font-size:1.4em}.banto-icon--xl{font-size:2.2em}.banto-icon--accent{color:var(--banto-bg-accent,var(--accent,#1f6feb))}.banto-icon--muted{opacity:.65}",
  ".banto-video{margin:1.25rem 0}.banto-video video{display:block;width:100%;height:auto;border-radius:var(--banto-radius,.5rem);background:#000}",
  ".banto-shop{margin:1.25rem 0}.banto-search{display:flex;gap:.5rem;max-width:32rem}.banto-search input{flex:1;font:inherit;padding:.5rem .65rem}",
  ".banto-categories{list-style:none;padding:0;margin:0}.banto-categories ul{list-style:none;padding-left:1.25rem}.banto-categories a{text-decoration:none}",
  ".banto-categories--grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(10rem,1fr));gap:.5rem}.banto-categories--grid>li>a{display:block;padding:.75rem;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:var(--banto-radius,.5rem)}",
  ".banto-categories__image{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:calc(var(--banto-radius,.5rem) - .25rem);margin:0 0 .5rem}",
  ".banto-card{display:flex;gap:1rem;align-items:center;padding:.75rem;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:var(--banto-radius,.5rem);text-decoration:none;color:inherit}.banto-card img{width:6rem;height:6rem;object-fit:cover;border-radius:.35rem}.banto-card__title{font-weight:600}",
  ".banto-toc{margin:1.25rem 0;padding:.75rem 1rem;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:var(--banto-radius,.5rem)}.banto-toc__title{font-weight:600;margin:0 0 .35rem}.banto-toc ol{margin:0;padding-left:1.25rem}.banto-toc ol ol{margin:.15rem 0}",
  ".banto-stores{list-style:none;padding:0;margin:0;display:grid;gap:.75rem}.banto-stores--grid{grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))}.banto-store{padding:.75rem 1rem;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:var(--banto-radius,.5rem)}.banto-store__name{font-weight:600;margin:0 0 .25rem}.banto-store p{margin:.15rem 0}.banto-store__today{font-weight:600}.banto-store table{font-size:.9em}.banto-store__specials{font-size:.9em;opacity:.8;padding-left:1.1rem;margin:.25rem 0 0}",
  ".banto-product__field-label{font-size:.85em;opacity:.75;margin-right:.35em}",
  ".banto-product{display:grid;gap:.5rem;max-width:28rem}.banto-product img{width:100%;height:auto;border-radius:var(--banto-radius,.5rem)}.banto-product__name{font-weight:600;font-size:1.1rem}.banto-product__price{font-weight:600}.banto-product form{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}.banto-product__option{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}.banto-product__option-name{font-size:.9em;opacity:.8}.banto-swatches{display:flex;flex-wrap:wrap;gap:.35rem}.banto-swatch{display:inline-flex;text-decoration:none;color:inherit}.banto-swatch__dot{display:inline-block;width:1.5rem;height:1.5rem;border-radius:999px;overflow:hidden;box-shadow:inset 0 0 0 1px color-mix(in srgb,currentColor 25%,transparent)}.banto-swatch__dot img{width:100%;height:100%;object-fit:cover}.banto-swatch__text{padding:.15rem .6rem;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:999px;font-size:.85em}.banto-swatch--out{opacity:.4}",
].join("");
