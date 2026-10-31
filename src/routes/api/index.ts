import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { createDbClient } from "../../db/client";
import { PRODUCT_OFFSET_MAX, PRODUCT_SEARCH_MIN_CHARS, PRODUCT_SEARCH_OFFSET_MAX, PRODUCT_SORTS, StorefrontData, type ProductQuery, type ProductSort } from "../../storefront/data";
import { tagsOf } from "../../products/tags";
import { categoryPath, categoryTree, type CategoryNode } from "../../products/categories";
import { productFields, publicAttributes } from "../../products/fields";
import type { CategoryRow } from "../../db/types";
import { imageUrl } from "../../media/images";
import { BANTO_VERSION } from "../../version";
import { mediaBaseUrl, param, type Ctx } from "../common";
import { cors } from "hono/cors";
import { commerceApi } from "./commerce";
import { memberCors, membersApi } from "./members";
import { tryonApi } from "./tryon";
import { inquiriesApi } from "./inquiries";
import { ordersApi } from "./orders";
import { contentApi } from "./content";
import { imageOptionsOf } from "../../products/images";
import { displayOptionAxes } from "../../products/option-axes";
import { publicOpenapiDocument } from "./openapi-public";

/**
 * ヘッドレス API（公開）。外部フロント（WordPress・Next.js 等）やプラグインが使う。docs/headless.md
 * 読み取りは anon キーで読むので RLS により published のものだけ返る。カートとチェックアウトは ./commerce.ts。
 * 別ドメインのブラウザから直接呼べるよう CORS を許可する（Cookie を使わないので資格情報は不要）。
 * /api/v1 と /mcp（Bearer トークン必須）には付けない。
 */
export const api = new Hono<AppEnv>();

const publicCors = cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Content-Type", "Authorization"], maxAge: 86400 });
api.use("/", publicCors);
api.use("/openapi.json", publicCors);
api.use("/shops", publicCors);
// 会員の API（/api/shops/:shop/members/*）は return_origins のオリジンだけ（0029）。それ以外の公開 API は *
api.use("/shops/*", (c, next) => (/^\/api\/shops\/[^/]+\/members(\/|$)/.test(c.req.path) ? memberCors(c, next) : publicCors(c, next)));
api.route("/", commerceApi);
api.route("/", membersApi);
api.route("/", tryonApi);
api.route("/", inquiriesApi);
api.route("/", ordersApi);
api.route("/", contentApi);

function data(c: Ctx): { sf: StorefrontData; mediaBaseUrl: string } | null {
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const anonKey = cfg.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) return null;
  return {
    sf: new StorefrontData(createDbClient({ url, anonKey, fetch: c.get("deps").fetch }), c.get("adapters").cache),
    mediaBaseUrl: mediaBaseUrl(c),
  };
}

api.get("/openapi.json", (c) => c.json(publicOpenapiDocument(new URL(c.req.url).origin, BANTO_VERSION)));
api.get("/", (c) => c.json({ name: "banto", version: BANTO_VERSION, openapi: "/api/openapi.json", public: ["/api/shops", "/api/shops/:slug", "/api/shops/:slug/products", "/api/shops/:slug/products/:slug", "/api/shops/:slug/categories", "/api/shops/:slug/pages", "/api/shops/:slug/pages/:handle", "/api/shops/:slug/blogs", "/api/shops/:slug/blogs/:blog/articles", "/api/shops/:slug/blogs/:blog/articles/:article"], cart: ["GET /api/shops/:slug/cart", "POST /api/shops/:slug/cart"], checkout: ["POST /api/shops/:slug/checkout/quote", "POST /api/shops/:slug/checkout"], buy_link: "/:slug/buy?sku=<sku_id>&qty=1", docs: "docs/headless.md", authenticated: "/api/v1 (OpenAPI: /api/v1/openapi.json)", mcp: "/mcp" }));

api.get("/shops", async (c: Ctx) => {
  const d = data(c);
  if (!d) return c.json({ error: "not_configured" }, 503);
  const shops = await d.sf.listShops();
  return c.json({ shops: shops.map((s) => ({ id: s.id, slug: s.slug, name: s.name })) });
});

api.get("/shops/:shop", async (c: Ctx) => {
  const d = data(c);
  if (!d) return c.json({ error: "not_configured" }, 503);
  const shop = await d.sf.shopBySlug(param(c, "shop"));
  if (!shop) return c.json({ error: "not_found" }, 404);
  // legal_links: 法務のページを連携サイトに向けていて、最後の確認で生きていた外の URL（0062。無ければ空）
  return c.json({ shop: { id: shop.id, slug: shop.slug, name: shop.name, legal_notice: shop.legal_notice, privacy_policy: shop.privacy_policy, return_policy: shop.return_policy, legal_links: shop.legal_links ?? {} } });
});

/**
 * 商品一覧。?tag=&category=&brand=&q=&updated_since=&sort=new|updated|price_asc|price_desc|name&limit=&offset=&cursor=
 * （limit は既定・上限 100）。category は子孫のカテゴリーを含む。
 * ページ送りは cursor（前の応答の next_cursor）。offset は 10,000 まで（docs/headless.md）。
 * q は 3 文字から（2 文字以下はタグ・カテゴリー・ブランドの絞り込みと一緒のときだけ）。
 * total は最初のページ（cursor も offset も無いとき）だけ、10,000 まで数える（超えたら total_capped: true、2 ページ目からは null）。検索の語があるときの offset は 1,000 まで。
 * tags はショップ全体（絞り込み前）のタグと件数（多い順に 200 件まで）で、連携側の絞り込み UI に使う。
 */
api.get("/shops/:shop/products", async (c: Ctx) => {
  const d = data(c);
  if (!d) return c.json({ error: "not_configured" }, 503);
  const shop = await d.sf.shopBySlug(param(c, "shop"));
  if (!shop) return c.json({ error: "not_found" }, 404);
  const query = productQuery(c);
  if (typeof query === "string") return c.json({ error: "invalid_request", field: query }, 400);
  const cursor = c.req.query("cursor") || undefined;
  if ((query.offset ?? 0) > (query.q ? PRODUCT_SEARCH_OFFSET_MAX : PRODUCT_OFFSET_MAX)) return c.json({ error: "invalid_request", field: "offset" }, 400);
  // 2 文字以下の語はタグ・カテゴリー・ブランドで絞っているときだけ（product_public_list と同じ。全件を見る検索をさせない）
  if (query.q && [...query.q].length < PRODUCT_SEARCH_MIN_CHARS && !query.tag && !query.category && !query.brand) return c.json({ error: "invalid_request", field: "q", reason: "too_short" }, 400);
  const categories = await d.sf.listCategories(shop);
  // total は最初のページだけ数える（ページごとに数え直させない）
  const first = !cursor && !query.offset;
  const [page, facets] = await Promise.all([d.sf.productPage(shop, query, categories, { cursor, count: first }), d.sf.productFacets(shop, categories)]);
  if (!page) return c.json({ error: "invalid_request", field: "cursor" }, 400);
  const catById = new Map(categories.map((x) => [x.id, x]));
  return c.json({
    products: page.items.map(({ product, image, minPrice, compareAt }) => ({
      id: product.id,
      slug: product.slug,
      name: product.name,
      brand: product.brand ?? null,
      category: categoryRef(catById.get(product.category_id ?? "")),
      extra_categories: (product.extra_category_ids ?? []).map((id) => categoryRef(catById.get(id))).filter((x) => x !== null),
      tags: tagsOf(product),
      image: image ? imageUrl(d.mediaBaseUrl, image.storage_key) : null,
      thumb: image ? imageUrl(d.mediaBaseUrl, image.thumb_key ?? image.storage_key) : null,
      min_price_jpy: minPrice,
      compare_at_price_jpy: compareAt ?? null,
      created_at: product.created_at,
      updated_at: product.updated_at,
    })),
    total: page.total,
    total_capped: page.totalCapped,
    limit: page.limit,
    offset: page.offset,
    next_offset: page.nextOffset,
    next_cursor: page.nextCursor,
    tags: facets.tags,
  });
});

/** クエリ文字列 → ProductQuery。形が違う項目があればその名前を返す */
function productQuery(c: Ctx): ProductQuery | string {
  const out: ProductQuery = {};
  const tag = c.req.query("tag");
  if (tag) out.tag = tag;
  const category = c.req.query("category");
  if (category) out.category = category;
  const brand = c.req.query("brand");
  if (brand) out.brand = brand;
  const q = c.req.query("q")?.trim();
  if (q) out.q = q.slice(0, 100);
  const sort = c.req.query("sort");
  if (sort) {
    if (!(PRODUCT_SORTS as readonly string[]).includes(sort)) return "sort";
    out.sort = sort as ProductSort;
  }
  const since = c.req.query("updated_since");
  if (since) {
    const t = Date.parse(since);
    if (Number.isNaN(t)) return "updated_since";
    out.updatedSince = new Date(t);
  }
  for (const k of ["limit", "offset"] as const) {
    const v = c.req.query(k);
    if (v === undefined || v === "") continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < (k === "limit" ? 1 : 0)) return k;
    out[k] = n;
  }
  return out;
}

api.get("/shops/:shop/products/:product", async (c: Ctx) => {
  const d = data(c);
  if (!d) return c.json({ error: "not_configured" }, 503);
  const shop = await d.sf.shopBySlug(param(c, "shop"));
  if (!shop) return c.json({ error: "not_found" }, 404);
  const [detail, categories] = await Promise.all([d.sf.productBySlug(shop, param(c, "product")), d.sf.listCategories(shop)]);
  if (!detail) return c.json({ error: "not_found" }, 404);
  const p = detail.product;
  return c.json({
    product: {
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description,
      brand: p.brand ?? null,
      category: categoryRef(categories.find((x) => x.id === p.category_id)),
      /** 最上位から主カテゴリーまで（パンくず用） */
      category_path: categoryPath(categories, p.category_id).map((x) => ({ slug: x.slug, name: x.name })),
      /** 追加カテゴリー（売り場の棚。主カテゴリーのほかに並ぶカテゴリー） */
      extra_categories: (p.extra_category_ids ?? []).map((id) => categoryRef(categories.find((x) => x.id === id))).filter((x) => x !== null),
      tags: tagsOf(p),
      /** カスタム項目のうち公開するもの（表示名つき） */
      attributes: publicAttributes(productFields(shop.settings), p.attributes),
      updated_at: p.updated_at,
      images: detail.images.map((i) => imageUrl(d.mediaBaseUrl, i.storage_key)),
      image_variants: detail.images.map((i) => ({ url: imageUrl(d.mediaBaseUrl, i.storage_key), thumb: imageUrl(d.mediaBaseUrl, i.thumb_key ?? i.storage_key), width: i.width, height: i.height, options: imageOptionsOf(i.options) })),
      skus: detail.skus.map((k) => ({ id: k.id, code: k.code, name: k.name, options: k.options ?? {}, gtin: k.gtin ?? null, price_jpy: k.price_jpy, compare_at_price_jpy: k.compare_at_price_jpy ?? null, in_stock: k.available > 0 })),
      /** SKU を分ける軸（0065）。軸ごとの選択欄に使う。values は SKU に出てくる値（出てくる順）。軸の無い商品は [] */
      option_axes: optionAxesForSelect(p.option_axes, detail.skus),
    },
  });
});

/** カテゴリーの木（公開中の商品数つき、子孫を含む件数） */
api.get("/shops/:shop/categories", async (c: Ctx) => {
  const d = data(c);
  if (!d) return c.json({ error: "not_configured" }, 503);
  const shop = await d.sf.shopBySlug(param(c, "shop"));
  if (!shop) return c.json({ error: "not_found" }, 404);
  const categories = await d.sf.listCategories(shop);
  const facets = await d.sf.productFacets(shop, categories);
  type Node = { slug: string; name: string; count: number; children: Node[] };
  const walk = (nodes: CategoryNode[]): Node[] => nodes.map((n) => ({ slug: n.slug, name: n.name, count: facets.categories[n.id] ?? 0, children: walk(n.children) }));
  return c.json({ categories: walk(categoryTree(categories)) });
});

function optionAxesForSelect(axes: unknown, skus: readonly { options?: Record<string, string | number> }[]): { key: string; values: string[] }[] {
  return displayOptionAxes(axes, skus).map((a) => ({
    key: a.key,
    values: [...new Set(skus.map((k) => String((k.options ?? {})[a.key] ?? "").trim()).filter(Boolean))],
  }));
}

function categoryRef(cat: CategoryRow | undefined): { slug: string; name: string } | null {
  return cat ? { slug: cat.slug, name: cat.name } : null;
}
