/**
 * ストアフロントのデータ取得（anon キー、RLS により published のものだけ見える）。
 * ショップ行と商品一覧は CacheAdapter で短時間キャッシュする（在庫は常に最新を読む）。
 */
import type { CacheAdapter } from "../adapters/types";
import type { DbClient, Row } from "../db/client";
import type { CategoryRow, InventoryRow, ProductImageRow, ProductRow, ShopRow, SkuRow } from "../db/types";
import { BASELINE_MIGRATION, appliedMigrations } from "../db/migration-state";
import { descendantIds, inCategories } from "../products/categories";
import { tagCounts } from "../products/tags";
import { ISO_TIMESTAMP, UUID_RE, decodeCursor, encodeCursor } from "../util/cursor";
import { selectIn } from "../db/select-in";
import type { StoreRow } from "../modules/store-tryon";

export const STOREFRONT_CACHE_TTL = 30;


/**
 * 公開中のショップのうち、お客様の画面（anon）に渡してよい部分（0028_security_hardening の shop_public_get / shop_public_list）。
 * Stripe の接続先 ID や settings の内部の鍵（連絡先・在庫僅少の閾値・送り状の設定など）は含めない。
 */
export interface PublicShop {
  id: string;
  slug: string;
  name: string;
  published: boolean;
  legal_notice: string | null;
  privacy_policy: string | null;
  return_policy: string | null;
  domain?: string | null;
  /** Stripe Connect の接続先があるか（ID そのものは service_role だけが読む） */
  stripe_connected: boolean;
  /** 公開の鍵だけ（publicShopSettings） */
  settings: Record<string, unknown>;
  /** 法務のページの外の URL のうち、最後の確認で生きていたものだけ（0062、src/storefront/legal-links.ts）。当たる前は無い */
  legal_links?: Record<string, string>;
}

/**
 * 0055: anon は products.attributes を読めない（非公開の独自項目を隠す）。当たっている DB では列を選んで読み、
 * 商品詳細は product_public_get（公開の項目だけの attributes 付き）で受け取る。当たる前は * で読む（0008 より前の DB でも動く）
 */
export const PRODUCT_ATTRIBUTES_MIGRATION = "0055_security_hardening_2";
export const PUBLIC_PRODUCT_COLUMNS = "id,shop_id,slug,name,description,published,created_at,updated_at,tags,category_id,brand,tax_class,extra_category_ids";

/** お客様の画面に渡す settings の鍵（0028 の banto_shop_public_settings と同じ。足すときは SQL と test/fake-supabase.ts も揃える） */
export const PUBLIC_SETTINGS_KEYS = ["theme", "theme_settings", "notice", "shipping", "modules", "members_enabled", "members_password", "checkout_terms", "delivery_time", "store_tryon", "receipt", "product_fields", "tax_rate", "tax_rate_reduced", "tax_rounding", "storefront", "analytics", "marketing_consent"] as const;

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function publicShopSettings(settings: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const src = isObject(settings) ? settings : {};
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_SETTINGS_KEYS) if (k in src) out[k] = src[k];
  // 非公開の独自項目は定義（表示名）も見せない（0055 の banto_shop_public_settings と同じ）
  if (Array.isArray(src["product_fields"])) out["product_fields"] = src["product_fields"].filter((f) => isObject(f) && f["public"] !== false);
  // relay_ips（中継元の素の IP）は公開しない（0034）。Worker が service_role で読む
  if (isObject(src["headless"])) {
    out["headless"] = { return_origins: src["headless"]["return_origins"] ?? [] };
    // 注文照会のページ（0066）
    if (typeof src["headless"]["order_page_url"] === "string") (out["headless"] as Record<string, unknown>)["order_page_url"] = src["headless"]["order_page_url"];
    // 会員ページ（0069）
    if (typeof src["headless"]["account_page_url"] === "string") (out["headless"] as Record<string, unknown>)["account_page_url"] = src["headless"]["account_page_url"];
  }
  if (isObject(src["oauth"])) {
    const oauth: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(src["oauth"])) {
      if (!isObject(v)) continue;
      const o: Record<string, unknown> = {};
      if ("client_id" in v) o["client_id"] = v["client_id"];
      if ("bot_prompt" in v) o["bot_prompt"] = v["bot_prompt"];
      oauth[k] = o;
    }
    out["oauth"] = oauth;
  }
  return out;
}

/** 管理画面（owner の JWT で読んだ行）から、お客様の画面の形にする */
export function toPublicShop(row: Pick<ShopRow, "id" | "slug" | "name" | "published" | "legal_notice" | "privacy_policy" | "return_policy" | "stripe_account_id" | "settings" | "domain">): PublicShop {
  return {
    id: row.id, slug: row.slug, name: row.name, published: row.published,
    legal_notice: row.legal_notice, privacy_policy: row.privacy_policy, return_policy: row.return_policy,
    domain: row.domain ?? null, stripe_connected: Boolean(row.stripe_account_id), settings: publicShopSettings(row.settings),
  };
}

export interface CouponClaimInfo {
  id: string;
  name: string;
  kind: "percent" | "fixed" | "free_shipping";
  value: number;
  starts_at: string | null;
  ends_at: string | null;
  live: boolean;
  conditions: { min_subtotal_jpy?: number | null };
  /** 残りの枚数（上限なしなら null） */
  remaining: number | null;
}

/** 一覧に出す商品の列（0058 の product_public_list が返すもの。説明・独自項目は含まない） */
export type ProductListRow = Pick<ProductRow, "id" | "slug" | "name" | "tags" | "category_id" | "extra_category_ids" | "brand" | "created_at" | "updated_at">;
export type ProductListImage = Pick<ProductImageRow, "storage_key" | "thumb_key" | "width" | "height">;

export interface ProductSummary {
  product: ProductListRow;
  image: ProductListImage | null;
  /** 最安 SKU 価格。SKU が無ければ null */
  minPrice: number | null;
  /** 最安 SKU の通常価格（セール中なら minPrice より高い）。無ければ null */
  compareAt?: number | null;
}

/** 全件を読む経路（0058 より前の DB の一覧・サイトマップ）の行。商品の行をそのまま持つ */
export interface CatalogSummary extends ProductSummary {
  product: ProductRow;
  image: ProductImageRow | null;
}

export interface SkuWithStock extends SkuRow {
  available: number;
}

export interface ProductDetail {
  product: ProductRow;
  images: ProductImageRow[];
  skus: SkuWithStock[];
}

export class StorefrontData {
  constructor(
    private db: DbClient,
    private cache: CacheAdapter,
  ) {}

  /** 適用済みの版の一覧（このインスタンスでは 1 回だけ引く。並列の判定が同時にキャッシュを外して二重に問い合わせないように） */
  private applied?: Promise<ReadonlySet<string>>;

  /** その版のマイグレーションが当たっていれば true（isolate ごとに 60 秒覚える。docs/upgrade.md「適用するまでのあいだ」） */
  async migratedTo(version: string): Promise<boolean> {
    if (version <= BASELINE_MIGRATION) return true;
    this.applied ??= appliedMigrations({ db: this.db, cache: this.cache });
    return (await this.applied).has(version);
  }

  /** anon で products を読むときの列（0055 が当たっていれば attributes を除いた列、前は *） */
  private async productColumns(): Promise<string> {
    return (await this.migratedTo(PRODUCT_ATTRIBUTES_MIGRATION)) ? PUBLIC_PRODUCT_COLUMNS : "*";
  }

  async listShops(): Promise<PublicShop[]> {
    const rows = await this.db.rpc<PublicShop[] | null>("shop_public_list", {});
    return Array.isArray(rows) ? rows : [];
  }

  private async fetchShop(by: { slug: string } | { domain: string }): Promise<PublicShop | null> {
    const r = await this.db.rpc<PublicShop | null>("shop_public_get", "slug" in by ? { p_slug: by.slug } : { p_domain: by.domain });
    return r && typeof r === "object" ? r : null;
  }

  async shopBySlug(slug: string): Promise<PublicShop | null> {
    const key = `shop:${slug}`;
    const hit = await this.cache.get<PublicShop>(key);
    if (hit) return hit;
    const shop = await this.fetchShop({ slug });
    if (shop) await this.cache.set(key, shop, STOREFRONT_CACHE_TTL);
    return shop;
  }

  /**
   * 独自ドメインのホスト名 → 公開中のショップ（0015_shop_domain）。無いホストも短時間覚える（Banto 自身の URL で毎回引かないように）。
   * 見つかったショップ行は shopBySlug のキャッシュにも入れる（続く処理で引き直さない）。
   */
  async shopByDomain(host: string): Promise<PublicShop | null> {
    const key = `domain:${host}`;
    const hit = await this.cache.get<{ shop: PublicShop | null }>(key);
    if (hit) return hit.shop;
    const shop = await this.fetchShop({ domain: host });
    await this.cache.set(key, { shop }, STOREFRONT_CACHE_TTL);
    if (shop) await this.cache.set(`shop:${shop.slug}`, shop, STOREFRONT_CACHE_TTL);
    return shop;
  }

  async listProducts(shop: PublicShop): Promise<CatalogSummary[]> {
    const key = `products:${shop.id}`;
    const hit = await this.cache.get<CatalogSummary[]>(key);
    if (hit) return hit;
    const cols = await this.productColumns();
    const [products, images, skus] = await Promise.all([
      this.db.from<ProductRow>("products").select(cols, { eq: { shop_id: shop.id, published: true }, order: "created_at.desc" }),
      this.db.from<ProductImageRow>("product_images").select("*", { eq: { shop_id: shop.id }, order: "sort_order.asc" }),
      // 列名を絞らず * で読む（0008 の compare_at_price_jpy が無い DB でも動くように）
      this.db.from<SkuRow>("skus").select("*", { eq: { shop_id: shop.id } }),
    ]);
    const firstImage = new Map<string, ProductImageRow>();
    for (const img of images) if (!firstImage.has(img.product_id)) firstImage.set(img.product_id, img);
    const cheapest = new Map<string, SkuRow>();
    for (const s of skus) {
      const cur = cheapest.get(s.product_id);
      if (!cur || s.price_jpy < cur.price_jpy) cheapest.set(s.product_id, s);
    }
    const out = products.map((product) => {
      const sku = cheapest.get(product.id);
      return { product, image: firstImage.get(product.id) ?? null, minPrice: sku ? sku.price_jpy : null, compareAt: sku?.compare_at_price_jpy ?? null };
    });
    await this.cache.set(key, out, STOREFRONT_CACHE_TTL);
    return out;
  }

  /**
   * 商品の一覧の 1 ページ（お店の画面と公開 API で共通）。0058 以降は DB で絞り込み・並べ替え・キーセットのページ送り
   * （product_public_list、問い合わせ 1 回）。それより前の DB は全件を読んでメモリで（queryProducts）。
   * categories はカテゴリーで絞るときだけ要る（子孫まで広げるため）。cursor は前のページの nextCursor。形が違えば null を返す。
   */
  async productPage(shop: PublicShop, query: ProductQuery, categories: CategoryRow[], opts: { cursor?: string; count?: boolean } = {}): Promise<ProductListPage | null> {
    const sort = query.sort ?? "new";
    const limit = Math.min(PRODUCT_PAGE_MAX, Math.max(1, Math.floor(query.limit ?? PRODUCT_PAGE_MAX)));
    const cursor = opts.cursor ? readCursor(opts.cursor, sort) : undefined;
    if (cursor === null) return null;
    if (!(await this.migratedTo(PRODUCT_LISTING_MIGRATION))) {
      const page = queryProducts(await this.listProducts(shop), { ...query, limit, offset: cursor && "o" in cursor ? cursor.o : query.offset }, categories);
      return { ...page, total: opts.count ? page.total : null, nextCursor: page.nextOffset === null ? null : encodeCursor({ s: sort, o: page.nextOffset }), totalCapped: false };
    }
    if (cursor && "o" in cursor) return null;
    const offset = cursor ? 0 : Math.max(0, Math.floor(query.offset ?? 0));
    // 検索の語があるときの offset は 1,000 まで（深い位置まで読ませて DB を重くさせない。先は cursor で）
    if (offset > (query.q?.trim() ? PRODUCT_SEARCH_OFFSET_MAX : PRODUCT_OFFSET_MAX)) return null;
    const cat = query.category ? categories.find((c) => c.slug === query.category) : undefined;
    const args = {
      p_shop_id: shop.id,
      p_sort: sort,
      p_limit: limit,
      p_after: cursor ? { k: cursor.k, id: cursor.id } : null,
      p_offset: offset,
      p_tag: query.tag ?? null,
      // 無いカテゴリーなら 0 件（全件を返さない）
      p_category_ids: query.category ? (cat ? [...descendantIds(categories, cat.id)] : []) : null,
      p_brand: query.brand ?? null,
      p_q: query.q?.trim() ? query.q.trim().slice(0, 100) : null,
      p_updated_since: query.updatedSince?.toISOString() ?? null,
      p_count: opts.count ?? false,
    };
    // キャッシュするのは、よく見られる最初のページだけ（検索の語・ページの位置・時刻を変えたリクエストでキャッシュを埋められないように）
    const cacheable = !cursor && offset === 0 && !args.p_q && !args.p_updated_since;
    const key = `plist:${JSON.stringify(args)}`;
    const hit = cacheable ? await this.cache.get<ProductListPage>(key) : null;
    if (hit) return hit;
    const r = await this.db.rpc<{ items: ListItem[]; next: { k: string | number; id: string } | null; total?: number; total_capped?: boolean }>("product_public_list", args);
    const items = r.items.map((x): ProductSummary => ({
      product: { id: x.id, slug: x.slug, name: x.name, tags: x.tags ?? [], category_id: x.category_id, extra_category_ids: x.extra_category_ids ?? [], brand: x.brand, created_at: x.created_at, updated_at: x.updated_at },
      image: x.image,
      minPrice: x.min_price_jpy,
      compareAt: x.compare_at_price_jpy,
    }));
    const out: ProductListPage = {
      items,
      total: r.total ?? null,
      totalCapped: r.total_capped ?? false,
      limit,
      offset,
      nextOffset: !cursor && r.next && offset + limit <= PRODUCT_OFFSET_MAX ? offset + limit : null,
      nextCursor: r.next ? encodeCursor({ s: sort, k: r.next.k, id: r.next.id }) : null,
    };
    if (cacheable) await this.cache.set(key, out, STOREFRONT_CACHE_TTL);
    return out;
  }

  /**
   * 公開中の商品のタグ（多い順に 200 件まで）とカテゴリーごとの件数（子孫を含む、1 商品は 1 回）。
   * 0058 以降は数え済みの表（product_public_facets、問い合わせ 1 回）。それより前は全件から数える。
   */
  async productFacets(shop: PublicShop, categories: CategoryRow[]): Promise<ProductFacets> {
    if (!(await this.migratedTo(PRODUCT_LISTING_MIGRATION))) {
      const all = await this.listProducts(shop);
      const counts: Record<string, number> = {};
      for (const c of categories) {
        const ids = descendantIds(categories, c.id);
        counts[c.id] = all.filter((s) => inCategories(s.product, ids)).length;
      }
      return { tags: tagCounts(all.map((s) => s.product)).slice(0, PRODUCT_FACET_TAGS), categories: counts };
    }
    const key = `facets:${shop.id}`;
    const hit = await this.cache.get<ProductFacets>(key);
    if (hit) return hit;
    const out = await this.db.rpc<ProductFacets>("product_public_facets", { p_shop_id: shop.id, p_tag_limit: PRODUCT_FACET_TAGS });
    await this.cache.set(key, out, STOREFRONT_CACHE_TTL);
    return out;
  }

  /** 公開中の商品の数（0060。サイトマップのファイルの数を決める） */
  async productCount(shop: PublicShop): Promise<number> {
    const key = `pcount:${shop.id}`;
    const hit = await this.cache.get<{ n: number }>(key);
    if (hit) return hit.n;
    const n = await this.db.rpc<number>("product_public_count", { p_shop_id: shop.id });
    // サイトマップの索引のたびに数えない（ファイルの数が少し遅れて増えるだけ）
    await this.cache.set(key, { n }, 600);
    return n;
  }

  /** サイトマップの 1 ファイル分の [slug, 更新日時]（0060、id 順） */
  async productSlugs(shop: PublicShop, offset: number, limit: number): Promise<[string, string][]> {
    return this.db.rpc<[string, string][]>("product_public_slugs", { p_shop_id: shop.id, p_offset: offset, p_limit: limit });
  }

  /**
   * 商品フィードの 1 ページ（0060、id が after より後ろの公開中の商品 limit 件と、その SKU・在庫・画像）。
   * 在庫は「あり / なし」だけが返る（フィードの availability に要るのはそれだけ）ので、在庫の行は 1 / 0 の数にして渡す
   */
  async feedPage(shop: PublicShop, after: string | null, limit: number): Promise<Omit<FeedCatalogRows, "categories">> {
    const r = await this.db.rpc<Omit<FeedCatalogRows, "categories" | "inventory"> & { inventory: { sku_id: string; in_stock: boolean }[] }>("product_feed_page", { p_shop_id: shop.id, p_after: after, p_limit: limit });
    return { ...r, inventory: r.inventory.map((i) => ({ sku_id: i.sku_id, available: i.in_stock ? 1 : 0 })) };
  }

  /** このデプロイの Workers のプラン（0060 の banto_site_plan。裏の処理が 1 回に進める量）。当たる前は free */
  async sitePlan(): Promise<"free" | "paid"> {
    if (!(await this.migratedTo(CATALOG_PAGES_MIGRATION))) return "free";
    return (await this.db.rpc<string>("banto_site_plan", {})) === "paid" ? "paid" : "free";
  }

  /**
   * カテゴリー（公開中のショップのもの、RLS）。商品一覧と同じく短時間キャッシュする。
   */
  async listCategories(shop: PublicShop): Promise<CategoryRow[]> {
    const key = `categories:${shop.id}`;
    const hit = await this.cache.get<CategoryRow[]>(key);
    if (hit) return hit;
    const rows = await this.db.from<CategoryRow>("categories").select("*", { eq: { shop_id: shop.id }, order: "sort_order.asc" });
    await this.cache.set(key, rows, STOREFRONT_CACHE_TTL);
    return rows;
  }

  /**
   * 実店舗（同梱モジュール store_tryon、0025 の shop_store_list）。公開の列だけ（お知らせの宛先は読めない）。短時間キャッシュする。
   */
  async listStores(shop: PublicShop): Promise<StoreRow[]> {
    const key = `stores:${shop.id}`;
    const hit = await this.cache.get<StoreRow[]>(key);
    if (hit) return hit;
    const rows = await this.db.rpc<StoreRow[]>("shop_store_list", { p_shop_id: shop.id });
    await this.cache.set(key, rows, STOREFRONT_CACHE_TTL);
    return rows;
  }

  async productBySlug(shop: PublicShop, slug: string): Promise<ProductDetail | null> {
    // 0055 以降: product_public_get（attributes は公開の項目だけ）。前は行をそのまま読む（attributes は Worker の publicAttributes が絞る）
    const product = (await this.migratedTo(PRODUCT_ATTRIBUTES_MIGRATION))
      ? await this.db.rpc<ProductRow | null>("product_public_get", { p_shop_id: shop.id, p_slug: slug })
      : await this.db.from<ProductRow>("products").selectOne("*", { eq: { shop_id: shop.id, slug, published: true } });
    if (!product || typeof product !== "object") return null;
    // 在庫はこの商品の SKU の分だけ引く（ショップ全体を読むと 1,000 行の上限で外れた SKU が在庫 0 に見える）
    const [images, [skus, inventory]] = await Promise.all([
      this.db.from<ProductImageRow>("product_images").select("*", { eq: { product_id: product.id }, order: "sort_order.asc" }),
      this.db
        .from<SkuRow>("skus")
        .select("*", { eq: { product_id: product.id }, order: "created_at.asc" })
        .then(async (skus) => [skus, await this.inventoryOf(shop, skus.map((s) => s.id))] as const),
    ]);
    const stock = new Map(inventory.map((i) => [i.sku_id, i.available]));
    return { product, images, skus: skus.map((s) => ({ ...s, available: stock.get(s.id) ?? 0 })) };
  }

  /** SKU の在庫（その SKU の分だけ。SKU が無ければ問い合わせない） */
  private inventoryOf(shop: PublicShop, skuIds: readonly string[]): Promise<InventoryRow[]> {
    return selectIn<InventoryRow>(this.db, "inventory", "sku_id,available", shop.id, "sku_id", skuIds);
  }

  async feedCatalog(shop: PublicShop): Promise<FeedCatalogRows> {
    const all = async <T extends Row>(table: string, columns: string, eq: Record<string, string | boolean>, order: string): Promise<T[]> => {
      const out: T[] = [];
      for (let offset = 0; ; offset += 1000) {
        const page = await this.db.from<T>(table).select(columns, { eq, order, limit: 1000, offset });
        out.push(...page);
        if (page.length < 1000) return out;
      }
    };
    const cols = await this.productColumns();
    const [products, skus, inventory, images, categories] = await Promise.all([
      all<ProductRow>("products", cols, { shop_id: shop.id, published: true }, "created_at.asc"),
      all<SkuRow>("skus", "*", { shop_id: shop.id }, "created_at.asc"),
      all<InventoryRow>("inventory", "sku_id,available", { shop_id: shop.id }, "sku_id.asc"),
      all<ProductImageRow>("product_images", "*", { shop_id: shop.id }, "sort_order.asc"),
      this.listCategories(shop),
    ]);
    return { products, skus, inventory, images, categories };
  }

  /** 有効な同梱決済プラグイン（shop_payment_options RPC、anon から読める。シークレットは含まない） */
  async paymentOptions(shop: PublicShop): Promise<{ id: string; settings: Record<string, string | boolean> }[]> {
    const raw = await this.db.rpc<unknown>("shop_payment_options", { p_shop_id: shop.id });
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((o): o is { id: string; settings?: Record<string, string | boolean> } => Boolean(o) && typeof o === "object" && typeof (o as { id?: unknown }).id === "string")
      .map((o) => ({ id: o.id, settings: o.settings ?? {} }));
  }

  /** 先着の獲得ページのキャンペーン（0020、anon RPC。獲得できるものだけ） */
  async couponClaimInfo(shop: PublicShop, campaignId: string): Promise<CouponClaimInfo | null> {
    const r = await this.db.rpc<CouponClaimInfo | null>("coupon_claim_info", { p_shop_id: shop.id, p_campaign_id: campaignId });
    return r && typeof r === "object" ? r : null;
  }

  /** 購入者向け注文照会（anon RPC、住所は返らない）。0067 より前の DB だけ（後は src/routes/order-lookup.ts が service_role で） */
  async lookupOrder(shop: PublicShop, number: number, email: string): Promise<Record<string, unknown> | null> {
    const r = await this.db.rpc<Record<string, unknown> | null>("lookup_order", { p_shop_id: shop.id, p_number: number, p_email: email });
    return r && typeof r === "object" ? r : null;
  }

  /** カート表示用: SKU 行 + 商品 + 在庫（公開中のものだけ返る） */
  async skusForCart(shop: PublicShop, skuIds: string[]): Promise<Map<string, { sku: SkuWithStock; product: ProductRow }>> {
    const out = new Map<string, { sku: SkuWithStock; product: ProductRow }>();
    if (skuIds.length === 0) return out;
    // カートの分だけ引く（ショップ全体を読むと 1,000 行の上限で外れた商品がカートから消える）
    const ids = [...new Set(skuIds)].filter((id) => UUID_RE.test(id)).slice(0, 100);
    if (ids.length === 0) return out;
    const [cols, skus] = await Promise.all([this.productColumns(), this.db.from<SkuRow>("skus").select("*", { eq: { shop_id: shop.id }, in: { id: ids } })]);
    const [inventory, products] = await Promise.all([
      this.inventoryOf(shop, skus.map((s) => s.id)),
      skus.length === 0 ? [] : this.db.from<ProductRow>("products").select(cols, { eq: { shop_id: shop.id, published: true }, in: { id: [...new Set(skus.map((s) => s.product_id))] } }),
    ]);
    const stock = new Map(inventory.map((i) => [i.sku_id, i.available]));
    const byProduct = new Map(products.map((p) => [p.id, p]));
    const wanted = new Set(skuIds);
    for (const s of skus) {
      const product = byProduct.get(s.product_id);
      if (wanted.has(s.id) && product) out.set(s.id, { sku: { ...s, available: stock.get(s.id) ?? 0 }, product });
    }
    return out;
  }
}

// ---------- 一覧の絞り込み・並べ替え・ページング（ストアフロントと公開 API で共通） ----------

export type ProductSort = "new" | "updated" | "price_asc" | "price_desc" | "name";
export const PRODUCT_SORTS: readonly ProductSort[] = ["new", "updated", "price_asc", "price_desc", "name"];
export const PRODUCT_PAGE_MAX = 100;

export interface ProductQuery {
  /** このタグを持つ商品だけ（完全一致） */
  tag?: string;
  /** このカテゴリー（slug）と、その子孫のカテゴリーの商品だけ。categories を渡すこと */
  category?: string;
  /** このブランドの商品だけ（完全一致） */
  brand?: string;
  /** 名前・説明・タグの部分一致（大文字小文字を区別しない） */
  q?: string;
  /** この時刻より後に更新された商品だけ（連携側のキャッシュ更新用） */
  updatedSince?: Date;
  sort?: ProductSort;
  limit?: number;
  offset?: number;
}

export interface ProductPage {
  items: ProductSummary[];
  /** 絞り込み後の件数（ページング前） */
  total: number;
  limit: number;
  offset: number;
  /** 次のページの offset。最後のページなら null */
  nextOffset: number | null;
}

/** サイトマップの分割と商品フィードの分割（product_public_count / product_public_slugs / product_feed_page）。当たる前は全件を読む */
export const CATALOG_PAGES_MIGRATION = "0060_catalog_pages";

/** 商品フィードの材料（src/modules/product-feed/feed.ts の FeedCatalog と同じ形） */
export interface FeedCatalogRows {
  products: ProductRow[];
  skus: SkuRow[];
  inventory: Pick<InventoryRow, "sku_id" | "available">[];
  images: ProductImageRow[];
  categories: CategoryRow[];
}

/** 商品の一覧を DB で絞り込む版（product_public_list・product_public_facets）。当たる前は全件を読んでメモリで */
export const PRODUCT_LISTING_MIGRATION = "0058_product_listing";
/** offset で辿れる上限（それより先は cursor）。product_public_list と同じ */
export const PRODUCT_OFFSET_MAX = 10000;
/** 絞り込み（タグ・カテゴリー・ブランド）無しで受け付ける検索の語の文字数の下限（pg_trgm のインデックスが効く長さ） */
export const PRODUCT_SEARCH_MIN_CHARS = 3;
/** 検索の語があるときの offset の上限 */
export const PRODUCT_SEARCH_OFFSET_MAX = 1000;
/** 一覧と一緒に返すタグの数（多い順） */
export const PRODUCT_FACET_TAGS = 200;

export interface ProductListPage {
  items: ProductSummary[];
  /** 絞り込み後の件数。数えなかったら null。10,000 を超えたら 10,000 で totalCapped */
  total: number | null;
  totalCapped: boolean;
  limit: number;
  offset: number;
  /** 次のページの offset（offset で辿っていて 10,000 以内のときだけ）。最後のページなら null */
  nextOffset: number | null;
  /** 次のページの cursor。最後のページなら null */
  nextCursor: string | null;
}

export interface ProductFacets {
  tags: { tag: string; count: number }[];
  /** カテゴリーの id → 公開中の商品の数（子孫を含む） */
  categories: Record<string, number>;
}

/** product_public_list の 1 行 */
interface ListItem extends ProductListRow {
  min_price_jpy: number | null;
  compare_at_price_jpy: number | null;
  image: ProductListImage | null;
}

/**
 * ページ送りの位置（並べ替えの値と id、0058 より前の DB では offset）。base64url の JSON。
 * 並べ替えを変えて使い回されたら受け付けない（位置の意味が変わるため）
 */
type Cursor = { s: ProductSort; k: string | number; id: string } | { s: ProductSort; o: number };

function readCursor(text: string, sort: ProductSort): Cursor | null {
  const v = decodeCursor(text);
  if (!v || v["s"] !== sort) return null;
  if (typeof v["o"] === "number") return Number.isInteger(v["o"]) && v["o"] >= 0 ? { s: sort, o: v["o"] } : null;
  const k = v["k"];
  const id = v["id"];
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  // 並べ替えの値の型と範囲を DB の列と同じに確かめる（DB で型に直せない値を渡して 500 にさせない）
  const price = sort === "price_asc" || sort === "price_desc";
  if (price ? !(typeof k === "number" && Number.isInteger(k) && k >= -1 && k <= 2147483647) : sort === "name" ? !(typeof k === "string" && k.length <= 300) : !(typeof k === "string" && ISO_TIMESTAMP.test(k))) return null;
  return { s: sort, k: k as string | number, id };
}

/** listProducts の結果を絞り込む。0058 より前の DB だけの経路（キャッシュ済みの全件をメモリで処理する） */
export function queryProducts(all: CatalogSummary[], query: ProductQuery, categories: CategoryRow[] = []): ProductPage {
  const q = query.q?.trim().toLowerCase();
  const cat = query.category ? categories.find((c) => c.slug === query.category) : undefined;
  // 存在しないカテゴリーを指定されたら 0 件（全件を返さない）
  const inCategory = query.category ? (cat ? descendantIds(categories, cat.id) : new Set<string>()) : null;
  const since = query.updatedSince?.getTime();
  const tagsOf = (p: ProductRow) => (Array.isArray(p.tags) ? p.tags : []);
  const hits = all.filter(({ product: p }) => {
    if (query.tag && !tagsOf(p).includes(query.tag)) return false;
    if (inCategory && !inCategories(p, inCategory)) return false;
    if (query.brand && p.brand !== query.brand) return false;
    if (since !== undefined && !(Date.parse(p.updated_at) > since)) return false;
    if (q && ![p.name, p.description ?? "", p.brand ?? "", ...tagsOf(p)].some((s) => s.toLowerCase().includes(q))) return false;
    return true;
  });
  const price = (s: ProductSummary, missing: number) => s.minPrice ?? missing;
  const sorters: Record<ProductSort, (a: ProductSummary, b: ProductSummary) => number> = {
    new: (a, b) => b.product.created_at.localeCompare(a.product.created_at),
    updated: (a, b) => b.product.updated_at.localeCompare(a.product.updated_at),
    price_asc: (a, b) => price(a, Number.POSITIVE_INFINITY) - price(b, Number.POSITIVE_INFINITY),
    price_desc: (a, b) => price(b, Number.NEGATIVE_INFINITY) - price(a, Number.NEGATIVE_INFINITY),
    name: (a, b) => a.product.name.localeCompare(b.product.name, "ja"),
  };
  const sorted = [...hits].sort(sorters[query.sort ?? "new"]);
  const limit = Math.min(PRODUCT_PAGE_MAX, Math.max(1, Math.floor(query.limit ?? PRODUCT_PAGE_MAX)));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const items = sorted.slice(offset, offset + limit);
  return { items, total: sorted.length, limit, offset, nextOffset: offset + limit < sorted.length ? offset + limit : null };
}
