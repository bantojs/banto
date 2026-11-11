/**
 * 記事の項目（0117、src/blog/fields.ts）をお店の画面に出す部品: ひな形の `::: current part=field:<key>` と、
 * 項目「書いた人」（key が author で記事を指すもの）が指す記事のカード（`::: current part=author`）。
 * 指す先は、項目の種類ごとにまとめて 1 回ずつ引く（店舗はキャッシュ済みの一覧、商品は選んだ商品の読み取り、記事は URL の名前で）
 */
import type { PublicShop, StorefrontData } from "../storefront/data";
import { articlePath, articleSummary, type ArticleRow, type BlogRow } from "../blog";
import { articleFieldDefs, fieldDateLabel, fieldValues, type ArticleFieldDef } from "../blog/fields";
import { formatDateTime } from "../i18n/time";
import { productUrl } from "../storefront/urls";
import { shopImageSrc } from "../pages/markdown";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface ArticleFieldDeps {
  sf: StorefrontData;
  shop: PublicShop;
  shopPath: string;
  mediaBase: string;
}

/** 書いた人の項目（key が author で、記事を指すもの） */
export const authorField = (defs: ArticleFieldDef[]): ArticleFieldDef | undefined => defs.find((f) => f.key === "author" && f.type === "article" && f.blog);

/**
 * 部品の HTML（field:<key> と、書いた人の項目があれば author）。keys は本文で使っている項目だけ（引く量を減らす）
 */
export async function articleFieldParts(d: ArticleFieldDeps, blog: BlogRow, article: ArticleRow, keys: { fields: string[]; author: boolean }): Promise<Record<string, string>> {
  const defs = articleFieldDefs(blog);
  const values = article.fields ?? {};
  const want = defs.filter((f) => keys.fields.includes(f.key) || (keys.author && f === authorField(defs)));
  if (want.length === 0) return {};
  const out: Record<string, string> = {};
  // 指す先をまとめて引く
  const stores = want.some((f) => f.type === "store") ? await d.sf.listStores(d.shop).catch(() => []) : [];
  const slugs = want.filter((f) => f.type === "product").flatMap((f) => fieldValues(values[f.key]));
  const products = slugs.length ? await d.sf.productsBySlugs(d.shop, slugs).catch(() => []) : [];
  const articleDefs = want.filter((f) => f.type === "article" && f.blog);
  const blogs = new Map<string, BlogRow | null>();
  const articles = new Map<string, ArticleRow[]>();
  for (const f of articleDefs) {
    if (!blogs.has(f.blog!)) blogs.set(f.blog!, await d.sf.blogById(d.shop, f.blog!).catch(() => null));
    const b = blogs.get(f.blog!);
    if (b) articles.set(f.key, await d.sf.articlesByHandles(d.shop, b.id, fieldValues(values[f.key])).catch(() => []));
  }
  for (const f of want) {
    const vs = fieldValues(values[f.key]);
    let html = "";
    if (vs.length) {
      if (f.type === "store") {
        const names = vs.map((id) => stores.find((s) => s.id === id)?.name).filter((x): x is string => Boolean(x));
        html = names.length ? `<span class="banto-field banto-field--${f.key}">${names.map(esc).join("、")}</span>` : "";
      } else if (f.type === "product") {
        const items = vs.map((s) => products.find((p) => p.product.slug === s)).filter((x) => x !== undefined);
        html = items.length ? `<ul class="banto-field banto-field--${f.key} banto-field-links">${items.map((x) => `<li><a href="${esc(productUrl(d.shopPath, x.product.slug))}">${esc(x.product.name)}</a></li>`).join("")}</ul>` : "";
      } else if (f.type === "article") {
        const b = blogs.get(f.blog!);
        const list = vs.map((h) => (articles.get(f.key) ?? []).find((a) => a.handle === h)).filter((x): x is ArticleRow => x !== undefined);
        html = b && list.length ? `<ul class="banto-field banto-field--${f.key} banto-field-links">${list.map((a) => `<li><a href="${esc(articlePath(d.shopPath, b.handle, a.handle))}">${esc(a.title)}</a></li>`).join("")}</ul>` : "";
        // 書いた人のカード（写真・名前・紹介・リンク）。最初の 1 人
        if (f === authorField(defs) && b && list[0]) out["author"] = authorCard(d, b, list[0]);
      } else if (f.type === "date" || f.type === "datetime") {
        // 日付・日時（0124）: <time> に機械の読める値も入れる
        html = `<time class="banto-field banto-field--${f.key}" datetime="${esc(vs[0]!)}">${esc(fieldDateLabel(f.type, vs[0]!, formatDateTime))}</time>`;
      } else if (f.type === "image") {
        const src = shopImageSrc(vs[0]!, d.mediaBase);
        html = src ? `<img class="banto-field banto-field--${f.key} banto-field--image" src="${esc(src)}" alt="${esc(f.label)}" loading="lazy">` : "";
      } else html = `<span class="banto-field banto-field--${f.key}">${esc(vs.join(", "))}</span>`;
    }
    out[`field:${f.key}`] = html;
  }
  return out;
}

function authorCard(d: ArticleFieldDeps, blog: BlogRow, a: ArticleRow): string {
  const url = articlePath(d.shopPath, blog.handle, a.handle);
  const img = a.image_url ? shopImageSrc(a.image_url, d.mediaBase) : null;
  const summary = articleSummary(a, 120);
  return (
    `<div class="banto-author">${img ? `<a class="banto-author__photo" href="${esc(url)}"><img src="${esc(img)}" alt="" loading="lazy" decoding="async"></a>` : ""}` +
    `<div class="banto-author__body"><a class="banto-author__name" href="${esc(url)}">${esc(a.title)}</a>${summary ? `<p class="banto-author__summary">${esc(summary)}</p>` : ""}</div></div>`
  );
}

/** 部品の最小の CSS（ひな形を使う記事のページにだけ添える） */
export const ARTICLE_FIELDS_CSS =
  ".banto-author{display:flex;gap:1rem;align-items:center;padding:1rem;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:var(--banto-radius,.5rem);margin:1.5rem 0}.banto-author__photo img{width:5rem;height:5rem;border-radius:999px;object-fit:cover;display:block}.banto-author__name{font-weight:600;text-decoration:none}.banto-author__summary{margin:.25rem 0 0;font-size:.9em;opacity:.8}.banto-field-links{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:.25rem 1rem}";

/** 本文で使っている記事の項目の部品（field:<key>）と、書いた人の部品があるか */
export function usedFieldParts(body: string): { fields: string[]; author: boolean } {
  const fields = [...body.matchAll(/^\s{0,3}:{3}\s*current\s+part=field:([a-z][a-z0-9_]{0,39})\s*$/gm)].map((m) => m[1]!);
  return { fields: [...new Set(fields)], author: /^\s{0,3}:{3}\s*current\s+part=author\s*$/m.test(body) };
}
