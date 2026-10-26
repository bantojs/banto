/**
 * テスト用の Supabase 代替（GoTrue + PostgREST のごく一部をインメモリで再現）。
 * 管理画面・ストアフロントが叩くエンドポイントだけを実装し、RLS に相当する可視性判定も最小限入れる。
 * 本物との差異が疑わしい箇所は test/db/ の実 PostgreSQL テストで裏取りする。
 */

import { BUNDLED_MIGRATIONS } from "../src/db/migrations";
import { normalizeTags } from "../src/products/tags";
import { productFields } from "../src/products/fields";
import { publicShopSettings } from "../src/storefront/data";

export interface FakeSupabaseOptions {
  url?: string;
  anonKey?: string;
  /** false なら rpc/banto_setup_state 等が PGRST202（関数なし）を返す */
  migrationsApplied?: boolean;
  /** true なら signup でセッションを返さない（確認メール待ち） */
  confirmEmail?: boolean;
  signupsAllowed?: boolean;
  appliedMigrations?: string[];
  serviceRoleKey?: string;
}

interface User {
  id: string;
  email: string;
  password: string;
  confirmed: boolean;
  /** 運営者の二段階認証（0054。GoTrue の TOTP の代わり。正しい 6 桁は FakeSupabase.TOTP_CODE） */
  factors?: { id: string; status: "verified" | "unverified" }[];
}

export type Row = Record<string, unknown>;

type TableName = "shops" | "categories" | "products" | "skus" | "inventory" | "product_images" | "orders" | "order_items" | "reservations" | "hook_endpoints" | "hook_deliveries" | "api_tokens" | "customers" | "coupon_campaigns" | "coupon_redemptions" | "coupon_slots" | "coupon_grants" | "shop_secret_boxes" | "stores" | "shop_stores" | "tryon_requests" | "tryon_items" | "audit_log";

const UNIQUE: Partial<Record<TableName, string[][]>> = {
  customers: [["shop_id", "id"]],
  shops: [["slug"], ["domain"]],
  categories: [["shop_id", "slug"]],
  products: [["shop_id", "slug"]],
  skus: [["shop_id", "code"]],
  coupon_campaigns: [["shop_id", "code"]],
};

/** 0024: 表ごとの項目（ポリシーの banto_shop_perm 相当） */
const TABLE_PERM: Partial<Record<TableName, string>> = {
  shops: "settings",
  products: "catalog",
  skus: "catalog",
  product_images: "catalog",
  categories: "catalog",
  inventory: "catalog",
  orders: "orders",
  order_items: "orders",
  reservations: "orders",
  customers: "customers",
  coupon_campaigns: "marketing",
  coupon_redemptions: "marketing",
  coupon_grants: "marketing",
  hook_endpoints: "integrations",
  hook_deliveries: "integrations",
  api_tokens: "integrations",
  shop_secret_boxes: "integrations",
  shop_stores: "stores",
  tryon_requests: "stores",
  tryon_items: "stores",
};

/** POST の本文は 1 行のオブジェクトか行の配列。列の有無を見るために先頭の行を返す */
function firstRow(body: unknown): Record<string, unknown> {
  const row = Array.isArray(body) ? body[0] : body;
  return row && typeof row === "object" ? (row as Record<string, unknown>) : {};
}

export class FakeSupabase {
  /** 偽の認証アプリが出す 6 桁（これだけを正しいとする） */
  static readonly TOTP_CODE = "123456";
  /** access_token / refresh_token ごとの aal（0054） */
  private readonly tokenAal = new Map<string, string>();
  /** 今処理している REST のリクエストの aal（RPC の中で見る） */
  private currentAal = "aal1";
  readonly url: string;
  readonly anonKey: string;
  readonly users = new Map<string, User>();
  /** 会員のログインのチャレンジ（0012。member_login_challenges の代わり） */
  readonly memberChallenges: Row[] = [];
  /** 0030: 運営者のセッションの世代と、管理者ログインの失敗の記録 */
  readonly adminEpochs = new Map<string, number>();
  readonly adminLoginAttempts: { email_hash: string; ip_hash: string | null; success: boolean; at: number }[] = [];
  /** パスワードの失敗（0013）・外部アカウント（0014）・引き換え券（0014） */
  readonly memberFailures: Row[] = [];
  readonly memberIdentities: Row[] = [];
  readonly memberHandoffs: Row[] = [];
  /** 会員のセッション（0045。member_sessions の代わり）。expires_at・rotated_at・revoked_at は ms */
  readonly memberSessions: Row[] = [];
  /** パスキー（0046。member_passkeys / member_passkey_challenges の代わり）。expires_at・consumed_at は ms */
  readonly memberPasskeys: Row[] = [];
  readonly passkeyChallenges: Row[] = [];
  /** ショップごとの提供元の設定（0014。shop_oauth_clients の代わり） */
  readonly oauthClients: Row[] = [];
  /** 偽の bcrypt: 取り込んだ WordPress のハッシュ → 平文（本物の照合は test/db/member-password-line.test.ts） */
  readonly legacyPasswords = new Map<string, string>();
  readonly owners = new Set<string>();
  readonly tables: Record<TableName, Row[]> = {
    shops: [],
    categories: [],
    products: [],
    skus: [],
    inventory: [],
    product_images: [],
    orders: [],
    order_items: [],
    reservations: [],
    hook_endpoints: [],
    hook_deliveries: [],
    api_tokens: [],
    customers: [],
    coupon_campaigns: [],
    coupon_redemptions: [],
    coupon_slots: [],
    coupon_grants: [],
    shop_secret_boxes: [],
    stores: [],
    shop_stores: [],
    tryon_requests: [],
    tryon_items: [],
    audit_log: [],
  };
  readonly calls: string[] = [];
  /** テスト用: 次の N リクエストを 503 で落とす（障害の再現） */
  failNextRequests = 0;
  /** 最後に呼ばれた 0023 の取り込みの RPC */
  lastImport: { fn: string; args: Record<string, unknown> } | null = null;
  /** 最後に restore_commerce（0022）に渡された書き出しの表 */
  lastRestoreCommerce: Record<string, Row[]> | null = null;
  /**
   * 組織・メンバー・ショップごとの項目（0024）。owner を作ると組織ができ、ショップは owner の組織に入る（マイグレーションの移し替えと同じ）。
   * 本物の判定は test/db/organizations.test.ts。ここは管理画面の出し分けを確かめるための最小限
   */
  readonly organizations: Row[] = [];
  readonly orgMembers: { org_id: string; user_id: string; role: "owner" | "admin" | "member"; created_at: string }[] = [];
  readonly orgMemberShops: { org_id: string; user_id: string; shop_id: string; perms: string[] }[] = [];
  readonly orgInvitations: Row[] = [];
  /** 0025: member の実店舗ごとの項目（tryon / hours） */
  readonly orgMemberStores: { org_id: string; user_id: string; store_id: string; perms: string[] }[] = [];
  migrationsApplied: boolean;
  confirmEmail: boolean;
  signupsAllowed: boolean;
  appliedMigrations: string[];
  /** 0060 の banto_site_plan（0038 の workers_plan） */
  sitePlan: "free" | "paid" = "free";
  readonly serviceRoleKey: string;
  readonly webhookEvents = new Set<string>();
  /** 0038: サイトの設定（banto_site_settings の 1 行） */
  siteSettings: Record<string, unknown> = {};
  /** 0052: プランの上限。その種類に上限があり、今の数が上限に達していれば「超えた」の印（本物は文単位の AFTER INSERT トリガー） */
  planLimitHit(kind: "shops" | "products" | "customers" | "members" | "mail_per_day"): Response | null {
    const limits = (this.siteSettings["plan_limits"] ?? {}) as Record<string, number | undefined>;
    const limit = limits[kind];
    if (limit == null) return null;
    const n = kind === "members" ? this.orgMembers.length : kind === "mail_per_day" ? this.memberChallenges.length + this.orgInvitations.length : this.tables[kind].length;
    return n + 1 > limit ? json({ code: "P0001", message: `plan_limit_exceeded:${kind}:${limit}` }, 400) : null;
  }
  /** 0039: 画像を裏で取り込む予約（image_import_jobs）。本物の SQL は test/db/image-import-queue.test.ts */
  imageJobs: { id: number; shop_id: string; product_id: string; url: string; status: string; attempts: number; last_error: string | null }[] = [];
  private seq = 0;
  private tokens = new Map<string, string>(); // access_token -> user id
  private refreshTokens = new Map<string, string>(); // refresh_token -> user id

  constructor(opts: FakeSupabaseOptions = {}) {
    this.url = opts.url ?? "https://fake.supabase.co";
    this.anonKey = opts.anonKey ?? "anon-key";
    this.migrationsApplied = opts.migrationsApplied ?? true;
    this.confirmEmail = opts.confirmEmail ?? false;
    this.signupsAllowed = opts.signupsAllowed ?? true;
    this.appliedMigrations = opts.appliedMigrations ?? [...BUNDLED_MIGRATIONS];
    this.serviceRoleKey = opts.serviceRoleKey ?? "service-role-key";
  }

  get shops() {
    return this.tables.shops as (Row & { id: string; owner_id: string; slug: string; name: string; published: boolean })[];
  }

  /** app に渡す fetch */
  readonly fetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    this.calls.push(`${req.method} ${u.pathname}${u.search}`);
    if (this.failNextRequests > 0) {
      this.failNextRequests--;
      return json({ message: "service unavailable" }, 503);
    }
    if (!req.url.startsWith(this.url)) return new Response("unknown host", { status: 502 });
    if (req.headers.get("apikey") !== this.anonKey && req.headers.get("apikey") !== this.serviceRoleKey) return json({ message: "Invalid API key" }, 401);
    if (u.pathname.startsWith("/auth/v1/")) return this.auth(req, u);
    if (u.pathname.startsWith("/rest/v1/")) return this.rest(req, u);
    return new Response("not found", { status: 404 });
  };

  /** restore_shop_data（0006）の再現: 空のショップにだけ入れ、id を振り直す */
  private restoreShopData(shopId: string, data: Record<string, Row[]>): Response {
    if (!this.tables.shops.some((s) => s["id"] === shopId)) return json({ code: "P0001", message: "shop_not_found" }, 400);
    if (this.tables.products.some((p) => p["shop_id"] === shopId) || this.tables.orders.some((o) => o["shop_id"] === shopId)) return json({ code: "P0001", message: "shop_not_empty" }, 400);
    if (!Array.isArray(data["products"] ?? []) || !Array.isArray(data["orders"] ?? [])) return json({ code: "P0001", message: "invalid_export" }, 400);
    const counts: Record<string, number> = {};
    const pmap = new Map<string, string>(), smap = new Map<string, string>(), omap = new Map<string, string>();
    for (const r of data["products"] ?? []) { const id = fakeUuid(++this.seq); pmap.set(String(r["id"]), id); this.tables.products.push({ ...r, tags: [], category_id: null, brand: null, attributes: {}, id, shop_id: shopId }); } // 0006 は拡張列を入れない（restore_catalog が戻す）
    counts["products"] = pmap.size;
    for (const r of data["skus"] ?? []) { const pid = pmap.get(String(r["product_id"])); if (!pid) continue; const id = fakeUuid(++this.seq); smap.set(String(r["id"]), id); this.tables.skus.push({ ...r, options: {}, gtin: null, compare_at_price_jpy: null, id, product_id: pid, shop_id: shopId }); this.tables.inventory.push({ sku_id: id, shop_id: shopId, available: 0 }); }
    counts["skus"] = smap.size;
    for (const r of data["inventory"] ?? []) { const sid = smap.get(String(r["sku_id"])); if (sid) this.tables.inventory.find((i) => i["sku_id"] === sid)!["available"] = Math.max(0, Number(r["available"] ?? 0)); }
    let n = 0;
    for (const r of data["product_images"] ?? []) { const pid = pmap.get(String(r["product_id"])); if (!pid) continue; this.tables.product_images.push({ ...r, id: `img-${++this.seq}`, product_id: pid, shop_id: shopId }); n++; }
    counts["product_images"] = n;
    const okCustomers = new Set<string>(); let skippedC = 0;
    for (const r of data["customers"] ?? []) { const email = String(r["email"] ?? "").trim().toLowerCase(); if (email && !this.tables.customers.some((c) => c["shop_id"] === shopId && String(c["email"] ?? "").toLowerCase() === email)) { this.tables.customers.push({ ...r, email, shop_id: shopId }); okCustomers.add(String(r["id"])); } else skippedC++; }
    counts["customers"] = okCustomers.size; counts["customers_skipped"] = skippedC;
    let maxNumber = 0;
    for (const r of data["orders"] ?? []) { const id = `order-${++this.seq}`; omap.set(String(r["id"]), id); this.tables.orders.push({ ...r, id, shop_id: shopId, reservation_id: null, customer_id: okCustomers.has(String(r["customer_id"])) ? r["customer_id"] : null }); maxNumber = Math.max(maxNumber, Number(r["number"] ?? 0)); }
    counts["orders"] = omap.size;
    const shop = this.tables.shops.find((s) => s["id"] === shopId)!;
    shop["order_seq"] = Math.max(Number(shop["order_seq"] ?? 1000), maxNumber);
    n = 0; let skippedI = 0;
    for (const r of data["order_items"] ?? []) { const oid = omap.get(String(r["order_id"])), sid = smap.get(String(r["sku_id"])); if (oid && sid) { this.tables.order_items.push({ ...r, id: `item-${++this.seq}`, order_id: oid, sku_id: sid, shop_id: shopId }); n++; } else skippedI++; }
    counts["order_items"] = n; counts["order_items_skipped"] = skippedI;
    n = 0;
    for (const r of data["hook_endpoints"] ?? []) { this.tables.hook_endpoints.push({ ...r, id: `ep-${++this.seq}`, shop_id: shopId }); n++; }
    counts["hook_endpoints"] = n;
    return json(counts);
  }

  // ---------- fixtures ----------
  addUser(email: string, password: string, opts: { owner?: boolean; confirmed?: boolean } = {}): User {
    // 本物の Supabase Auth と同じく UUID の形にする（会員 ID をそのまま使う処理があるため）
    const user: User = { id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`, email, password, confirmed: opts.confirmed ?? true };
    this.users.set(user.id, user);
    if (opts.owner) {
      this.owners.add(user.id);
      this.ownerOrg(user.id);
    }
    return user;
  }

  /** owner の組織（0024 の owners のトリガーと同じ）。無ければ作る */
  private ownerOrg(userId: string): string {
    const found = this.orgMembers.find((m) => m.user_id === userId && m.role === "owner");
    if (found) return found.org_id;
    const org = `org-${++this.seq}`;
    this.organizations.push({ id: org, name: "マイ組織", created_at: this.now() });
    this.orgMembers.push({ org_id: org, user_id: userId, role: "owner", created_at: this.now() });
    return org;
  }

  addShop(ownerId: string, fields: Partial<Row> = {}): Row & { id: string } {
    const row = {
      id: `shop-${++this.seq}`,
      owner_id: ownerId,
      slug: "shop",
      name: "Shop",
      published: false,
      legal_notice: null,
      privacy_policy: null,
      return_policy: null,
      stripe_account_id: null,
      settings: {},
      domain: null,
      order_seq: 1000,
      created_at: this.now(),
      updated_at: this.now(),
      org_id: this.owners.has(ownerId) ? this.ownerOrg(ownerId) : null,
      ...fields,
    };
    this.tables.shops.push(row);
    return row;
  }

  addProduct(shopId: string, fields: Partial<Row> = {}): Row & { id: string } {
    const row = { id: fakeUuid(++this.seq), shop_id: shopId, slug: "item", name: "Item", description: null, tags: [] as string[], category_id: null as string | null, brand: null as string | null, attributes: {} as Record<string, unknown>, published: false, created_at: this.now(), updated_at: this.now(), ...fields };
    this.tables.products.push(row);
    return row;
  }

  /** import_catalog（0009）の再現（簡略）: slug / code で突き合わせて作るか更新する。商品ごとの不備は errors に返す */
  private importCatalog(args: Row): Response {
      // import_catalog（0009）の再現（簡略）: slug / code で突き合わせて作るか更新する。商品ごとの不備は errors に返す
    const shopId = String(args["p_shop_id"]);
    const batch = args["p_batch"] as { categories?: Row[]; products?: Row[]; overwrite_stock?: boolean };
    const r = { categories: 0, products_created: 0, products_updated: 0, skus_created: 0, skus_updated: 0, errors: [] as Row[] };
    for (const c of batch.categories ?? []) {
      const parent = this.tables.categories.find((x) => x["shop_id"] === shopId && x["slug"] === c["parent_slug"]);
      const cur = this.tables.categories.find((x) => x["shop_id"] === shopId && x["slug"] === c["slug"]);
      if (cur) Object.assign(cur, { name: c["name"], parent_id: parent?.["id"] ?? null });
      else this.addCategory(shopId, { slug: c["slug"], name: c["name"], parent_id: parent?.["id"] ?? null });
      r.categories++;
    }
    for (const p of batch.products ?? []) {
      if (!p["name"]) {
        r.errors.push({ slug: p["slug"], message: "null value in column \"name\"" });
        continue;
      }
      const cat = this.tables.categories.find((x) => x["shop_id"] === shopId && x["slug"] === p["category_slug"]);
      const fields: Row = { name: p["name"], description: p["description"] ?? null, published: p["published"] ?? false, tags: normalizeTags(p["tags"]), brand: p["brand"] ?? null, category_id: cat?.["id"] ?? null };
      // 追加カテゴリー（0042）: 鍵があるときだけ。知らない slug は飛ばす
      if (Array.isArray(p["extra_category_slugs"]))
        fields["extra_category_ids"] = (p["extra_category_slugs"] as unknown[]).flatMap((slug) => this.tables.categories.filter((x) => x["shop_id"] === shopId && x["slug"] === slug && x["id"] !== fields["category_id"]).map((x) => x["id"]));
      let prod = this.tables.products.find((x) => x["shop_id"] === shopId && x["slug"] === p["slug"]);
      if (prod) {
        Object.assign(prod, fields, { attributes: { ...((prod["attributes"] as Row) ?? {}), ...((p["attributes"] as Row) ?? {}) } });
        r.products_updated++;
      } else {
        prod = this.addProduct(shopId, { slug: p["slug"], ...fields, attributes: (p["attributes"] as Row) ?? {} });
        r.products_created++;
      }
      for (const k of (p["skus"] as Row[]) ?? []) {
        const cur = this.tables.skus.find((x) => x["shop_id"] === shopId && x["code"] === k["code"]);
        const vals = { name: k["name"] ?? null, price_jpy: k["price_jpy"], compare_at_price_jpy: k["compare_at_price_jpy"] ?? null, gtin: k["gtin"] ?? null, options: k["options"] ?? {} };
        if (cur) {
          Object.assign(cur, vals);
          r.skus_updated++;
          if (batch.overwrite_stock !== false && k["available"] !== undefined) this.tables.inventory.find((i) => i["sku_id"] === cur["id"])!["available"] = k["available"];
        } else {
          this.addSku(shopId, String(prod["id"]), { code: k["code"], ...vals, available: Number(k["available"] ?? 0) });
          r.skus_created++;
        }
      }
    }
    return json(r);
      }

  addCategory(shopId: string, fields: Partial<Row> = {}): Row & { id: string } {
    const row = { id: `category-${++this.seq}`, shop_id: shopId, parent_id: null as string | null, slug: "cat", name: "Cat", sort_order: 0, created_at: this.now(), ...fields };
    this.tables.categories.push(row);
    return row;
  }

  /** api_category_ref の再現: slug → id。空なら null、見つからなければ false */
  /** 追加カテゴリーの slug の配列 → id（0042 の api_category_refs と同じ。見つからなければ false） */
  private categoryRefs(shopId: string, slugs: unknown): string[] | false {
    const out: string[] = [];
    for (const s of Array.isArray(slugs) ? slugs : []) {
      const id = this.categoryRef(shopId, s);
      if (id === false) return false;
      if (id && !out.includes(id)) out.push(id);
    }
    return out;
  }

  private categoryRef(shopId: string, slug: unknown): string | null | false {
    if (slug === undefined || slug === null || String(slug).trim() === "") return null;
    const c = this.tables.categories.find((x) => x["shop_id"] === shopId && x["slug"] === String(slug).trim());
    return c ? String(c["id"]) : false;
  }

  addSku(shopId: string, productId: string, fields: Partial<Row> & { available?: number } = {}): Row & { id: string } {
    const { available, ...rest } = fields;
    const row = { id: fakeUuid(++this.seq), shop_id: shopId, product_id: productId, code: "SKU", name: null, price_jpy: 1000, options: {} as Record<string, unknown>, gtin: null as string | null, compare_at_price_jpy: null as number | null, created_at: this.now(), ...rest };
    this.tables.skus.push(row);
    this.tables.inventory.push({ sku_id: row.id, shop_id: shopId, available: available ?? 0, updated_at: this.now() });
    return row;
  }

  private now(): string {
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.seq)).toISOString();
  }

  // ---------- auth ----------
  private issueSession(user: User, aal = "aal1") {
    // JWT の形（真ん中に { sub, aal }）。管理画面は aal を読む（src/routes/admin/auth.ts の sessionAal）
    const payload = Buffer.from(JSON.stringify({ sub: user.id, aal })).toString("base64url");
    const access_token = `at.${payload}.${user.id}_${++this.seq}`;
    const refresh_token = `rt_${user.id}_${this.seq}`;
    this.tokens.set(access_token, user.id);
    this.refreshTokens.set(refresh_token, user.id);
    this.tokenAal.set(access_token, aal);
    this.tokenAal.set(refresh_token, aal);
    return { access_token, refresh_token, expires_in: 3600, token_type: "bearer", user: this.publicUser(user) };
  }

  private publicUser(user: User) {
    return {
      id: user.id,
      email: user.email,
      email_confirmed_at: user.confirmed ? this.now() : null,
      factors: (user.factors ?? []).map((f) => ({ id: f.id, factor_type: "totp", status: f.status, friendly_name: "Banto" })),
    };
  }

  /** テスト用: 二段階認証を登録済みにする */
  addFactor(userId: string): string {
    const user = this.users.get(userId)!;
    const id = `00000000-0000-4000-9000-${String(++this.seq).padStart(12, "0")}`;
    user.factors = [...(user.factors ?? []), { id, status: "verified" }];
    return id;
  }

  /** 0054 の banto_pre_request の再現: ok / challenge / enroll */
  private mfaState(uid: string, aal: string): "ok" | "challenge" | "enroll" {
    if (aal === "aal2") return "ok";
    if ((this.users.get(uid)?.factors ?? []).some((f) => f.status === "verified")) return "challenge";
    const orgs = this.orgMembers.filter((m) => m.user_id === uid).map((m) => m.org_id);
    if (this.organizations.some((o) => orgs.includes(String(o["id"])) && o["require_mfa"] === true)) return "enroll";
    return "ok";
  }

  private async auth(req: Request, u: URL): Promise<Response> {
    const body = req.method === "POST" || req.method === "PUT" ? ((await req.json().catch(() => ({}))) as Record<string, string>) : {};
    const path = u.pathname.replace("/auth/v1", "");
    // 0054: 二段階認証（GoTrue の /factors と Admin API）
    const adminUser = /^\/admin\/users\/([^/]+)(?:\/factors\/([^/]+))?$/.exec(path);
    if (adminUser) {
      if (!this.isService(req)) return json({ msg: "not allowed" }, 401);
      const target = this.users.get(adminUser[1]!);
      if (!target) return json({ msg: "User not found" }, 404);
      if (!adminUser[2] && req.method === "GET") return json(this.publicUser(target));
      if (adminUser[2] && req.method === "DELETE") {
        target.factors = (target.factors ?? []).filter((f) => f.id !== adminUser[2]);
        return json({ id: adminUser[2] });
      }
    }
    const factor = /^\/factors(?:\/([^/]+)(?:\/(challenge|verify))?)?$/.exec(path);
    if (factor) {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const uid = this.userFromAuth(req);
      if (!uid) return json({ msg: "invalid JWT" }, 401);
      const user = this.users.get(uid)!;
      const [, fid, step] = factor;
      if (!fid && req.method === "POST") {
        const id = `00000000-0000-4000-9000-${String(++this.seq).padStart(12, "0")}`;
        user.factors = [...(user.factors ?? []), { id, status: "unverified" }];
        return json({ id, type: "totp", totp: { qr_code: "data:image/svg+xml;utf-8,<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", secret: "FAKESECRET", uri: "otpauth://totp/Banto" } });
      }
      const f = (user.factors ?? []).find((x) => x.id === fid);
      if (!f) return json({ msg: "Factor not found" }, 404);
      if (step === "challenge") return json({ id: `ch-${++this.seq}`, expires_at: 0 });
      if (step === "verify") {
        if ((body as Record<string, string>).code !== FakeSupabase.TOTP_CODE) return json({ code: 422, error_code: "mfa_verification_failed", msg: "Invalid TOTP code entered" }, 422);
        f.status = "verified";
        return json(this.issueSession(user, "aal2"));
      }
      if (req.method === "DELETE") {
        if (f.status === "verified" && this.tokenAal.get(token) !== "aal2") return json({ code: 403, error_code: "insufficient_aal", msg: "AAL2 required" }, 403);
        user.factors = (user.factors ?? []).filter((x) => x.id !== fid);
        return json({ id: fid });
      }
    }
    if (path === "/admin/users") {
      if (!this.isService(req)) return json({ msg: "not allowed" }, 401);
      if ([...this.users.values()].some((x) => x.email === body.email)) return json({ code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" }, 422);
      const user = this.addUser(body.email!, body.password ?? "", { confirmed: (body as unknown as { email_confirm?: boolean }).email_confirm === true });
      return json(this.publicUser(user));
    }
    if (path === "/signup") {
      if (!this.signupsAllowed) return json({ code: 422, error_code: "signup_disabled", msg: "Signups not allowed for this instance" }, 422);
      if ([...this.users.values()].some((x) => x.email === body.email)) return json({ code: 422, error_code: "user_already_exists", msg: "User already registered" }, 422);
      const user = this.addUser(body.email!, body.password!, { confirmed: !this.confirmEmail });
      if (this.confirmEmail) return json(this.publicUser(user));
      return json(this.issueSession(user));
    }
    if (path === "/token") {
      const grant = u.searchParams.get("grant_type");
      if (grant === "password") {
        const user = [...this.users.values()].find((x) => x.email === body.email && x.password !== "" && x.password === body.password);
        if (!user) return json({ error: "invalid_grant", error_description: "Invalid login credentials" }, 400);
        if (!user.confirmed) return json({ error: "invalid_grant", error_code: "email_not_confirmed", error_description: "Email not confirmed" }, 400);
        return json(this.issueSession(user));
      }
      if (grant === "refresh_token") {
        const uid = this.refreshTokens.get(body.refresh_token!);
        if (!uid) return json({ error: "invalid_grant", error_description: "Invalid Refresh Token" }, 400);
        this.refreshTokens.delete(body.refresh_token!);
        return json(this.issueSession(this.users.get(uid)!, this.tokenAal.get(body.refresh_token!) ?? "aal1"));
      }
    }
    if (path === "/user") {
      const uid = this.userFromAuth(req);
      if (!uid) return json({ msg: "invalid JWT" }, 401);
      return json(this.publicUser(this.users.get(uid)!));
    }
    if (path === "/logout") return new Response(null, { status: 204 });
    return json({ msg: "not found" }, 404);
  }

  private userFromAuth(req: Request): string | null {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    return this.tokens.get(token) ?? null;
  }

  // ---------- RLS 相当 ----------
  private ownedShopIds(uid: string | null): Set<string> {
    const admin = new Set(this.orgMembers.filter((m) => m.user_id === uid && m.role !== "member").map((m) => m.org_id));
    return new Set(this.tables.shops.filter((s) => (s["org_id"] ? admin.has(String(s["org_id"])) : s["owner_id"] === uid)).map((s) => s["id"] as string));
  }

  /** 0024: member のショップごとの項目（owner / admin は ownedShopIds で全権） */
  private memberPerms(uid: string | null, shopId: unknown): string[] {
    if (!uid) return [];
    const shop = this.tables.shops.find((s) => s["id"] === shopId);
    return this.orgMemberShops.find((m) => m.user_id === uid && m.shop_id === shopId && m.org_id === shop?.["org_id"])?.perms ?? [];
  }

  /** 0025 の banto_store_perm / banto_store_visible */
  private storePerm(uid: string | null, storeId: unknown, perm: string): boolean {
    const st = this.tables.stores.find((x) => x["id"] === storeId);
    if (!st || !uid) return false;
    if (this.orgMembers.some((m) => m.org_id === st["org_id"] && m.user_id === uid && m.role !== "member")) return true;
    return this.orgMemberStores.some((m) => m.store_id === storeId && m.user_id === uid && m.org_id === st["org_id"] && m.perms.includes(perm));
  }

  private storeVisible(uid: string | null, st: Row): boolean {
    if (!uid) return false;
    if (this.storePerm(uid, st["id"], "tryon") || this.storePerm(uid, st["id"], "hours")) return true;
    return this.orgMemberShops.some((m) => m.org_id === st["org_id"] && m.user_id === uid && m.perms.includes("stores"));
  }

  private hasPerm(table: TableName, row: Row, uid: string | null): boolean {
    const perm = TABLE_PERM[table];
    const shopId = table === "shops" ? row["id"] : row["shop_id"];
    return perm !== undefined && this.memberPerms(uid, shopId).includes(perm);
  }

  /** メール通知プラグインの送信元（0057 の banto_member_mail_from） */
  private mailFrom(shopId: unknown): string | null {
    const ep = this.tables.hook_endpoints.find((e) => e["shop_id"] === shopId && e["enabled"] !== false && e["url"] === "https://banto.invalid/plugins/email_resend");
    const from = ((ep?.["settings"] ?? {}) as Row)["from"];
    return typeof from === "string" && from.trim() ? from.trim() : null;
  }

  private shopPublished(shopId: unknown): boolean {
    return this.tables.shops.some((s) => s["id"] === shopId && s["published"] === true);
  }

  private productPublished(productId: unknown): boolean {
    const p = this.tables.products.find((x) => x["id"] === productId);
    return Boolean(p && p["published"] === true && this.shopPublished(p["shop_id"]));
  }

  /** SELECT の可視性（ポリシーの using 相当） */
  private visible(table: TableName, row: Row, uid: string | null): boolean {
    // 0051: 監査ログは組織の owner / admin だけ
    if (table === "audit_log") return Boolean(uid) && this.orgMembers.some((m) => m.org_id === row["org_id"] && m.user_id === uid && m.role !== "member");
    if (uid && this.ownedShopIds(uid).has(row["shop_id"] as string)) return true;
    if (this.hasPerm(table, row, uid)) return true;
    if (table === "shops" && this.memberPerms(uid, row["id"]).length > 0) return true;
    if (table === "shops" && uid && this.ownedShopIds(uid).has(row["id"] as string)) return true;
    if (table === "shops") return row["published"] === true;
    if (table === "products") return row["published"] === true && this.shopPublished(row["shop_id"]);
    if (table === "categories") return this.shopPublished(row["shop_id"]);
    if (table === "stores") return this.storeVisible(uid, row);
    if (table === "tryon_requests") return this.storePerm(uid, row["store_id"], "tryon");
    if (table === "tryon_items") return this.tables.tryon_requests.some((r) => r["id"] === row["request_id"] && this.storePerm(uid, r["store_id"], "tryon"));
    if (table === "skus" || table === "product_images") return this.productPublished(row["product_id"]);
    if (table === "inventory") {
      const sku = this.tables.skus.find((k) => k["id"] === row["sku_id"]);
      return Boolean(sku && this.productPublished(sku["product_id"]));
    }
    return false; // customers / orders / order_items / reservations は owner のみ（上で判定済み）
  }

  /** INSERT / UPDATE の with check 相当（owner のみ） */
  private writable(table: TableName, row: Row, uid: string | null, op: "insert" | "update" | "delete" = "insert"): boolean {
    if (!uid) return false;
    if (table === "audit_log") return false; // 書くのは DB のトリガーだけ（0051）
    if (table === "shops") {
      if (op === "insert") return this.orgMembers.some((m) => m.user_id === uid && m.role !== "member");
      return this.ownedShopIds(uid).has(row["id"] as string) || (op === "update" && this.hasPerm(table, row, uid));
    }
    if (table === "stores") return this.orgMembers.some((m) => m.org_id === row["org_id"] && m.user_id === uid && m.role !== "member");
    if (table === "shop_stores") {
      const sh = this.tables.shops.find((x) => x["id"] === row["shop_id"]);
      const st = this.tables.stores.find((x) => x["id"] === row["store_id"]);
      if (!sh || !st || sh["org_id"] !== st["org_id"]) return false;
    }
    if (this.hasPerm(table, row, uid) && !["inventory", "order_items", "reservations", "hook_deliveries", "coupon_redemptions", "coupon_grants", "tryon_requests", "tryon_items"].includes(table)) {
      if (table === "customers") return op === "delete";
      if (table === "orders") return op === "update";
      if (table === "api_tokens") return row["owner_id"] === uid;
      return true;
    }
    if (table === "orders") return op === "update" && this.ownedShopIds(uid).has(row["shop_id"] as string);
    if (table === "inventory" || table === "order_items" || table === "reservations" || table === "hook_deliveries" || table === "coupon_redemptions" || table === "coupon_grants" || table === "tryon_requests" || table === "tryon_items") return false;
    if (table === "api_tokens") return this.ownedShopIds(uid).has(row["shop_id"] as string) && row["owner_id"] === uid;
    // 会員の読み書きは service_role の member_* RPC だけ（0012）。owner は削除だけ
    if (table === "customers") return op === "delete" && this.ownedShopIds(uid).has(row["shop_id"] as string);
    return this.ownedShopIds(uid).has(row["shop_id"] as string);
  }

  private uniqueViolation(table: TableName, row: Row, excludeId?: unknown): boolean {
    for (const cols of UNIQUE[table] ?? []) {
      // PostgreSQL と同じく null 同士は重複にしない（shops.domain 等）
      if (cols.some((c) => row[c] === null || row[c] === undefined)) continue;
      if (this.tables[table].some((r) => r["id"] !== excludeId && cols.every((c) => r[c] === row[c]))) return true;
    }
    return false;
  }

  private isService(req: Request): boolean {
    return (req.headers.get("authorization") ?? "") === `Bearer ${this.serviceRoleKey}`;
  }

  private async rest(req: Request, u: URL): Promise<Response> {
    const service = this.isService(req);
    const uid = this.userFromAuth(req); // null = anon
    const path = u.pathname.replace("/rest/v1/", "");
    // 0054: PostgREST のリクエストの前の関数（banto_pre_request）。運営者の aal1 の JWT を止める
    this.currentAal = this.tokenAal.get((req.headers.get("authorization") ?? "").replace(/^Bearer /, "")) ?? "aal1";
    if (uid && !service && this.migrationsApplied) {
      const state = this.mfaState(uid, this.currentAal);
      if (state !== "ok") return json({ code: "42501", message: `mfa_required:${state}`, details: null, hint: null }, 403);
    }
    const filters: [string, string][] = [];
    const inFilters: [string, Set<string>][] = [];
    for (const [k, v] of u.searchParams) {
      if (["select", "order", "limit", "offset"].includes(k)) continue;
      if (v.startsWith("eq.")) filters.push([k, v.slice(3)]);
      else if (v === "is.null") filters.push([k, "\u0000null"]);
      else if (v.startsWith("in.(") && v.endsWith(")")) inFilters.push([k, new Set(parseInList(v.slice(4, -1)))]);
    }
    // 条件の木（DbClient の where → and=(…)）
    const tree = u.searchParams.get("and");
    const logic = tree ? parseLogic(`and${tree}`) : null;
    const matches = (row: Row) =>
      filters.every(([k, v]) => (v === "\u0000null" ? row[k] === null : String(row[k]) === v)) && inFilters.every(([k, vs]) => vs.has(String(row[k]))) && (!logic || evalLogic(logic, row));

    if (path.startsWith("rpc/")) {
      const fn = path.slice(4);
      if (!this.migrationsApplied) return json({ code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache`, hint: null, details: null }, 404);
      const args = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      return service ? this.serviceRpc(fn, args) : this.rpc(fn, args, uid);
    }
    if (!this.migrationsApplied) return json({ code: "PGRST205", message: `Could not find the table 'public.${path}' in the schema cache` }, 404);

    if (path === "owners") {
      if (req.method === "GET") return json([...this.owners].filter((o) => o === uid).map((id) => ({ id })).filter(matches));
      if (req.method === "POST") {
        const rows = (await req.json()) as { id: string }[];
        for (const r of rows) {
          if (!uid || r.id !== uid || this.owners.size > 0 || this.orgMembers.length > 0 || this.tables.shops.length > 0) return rlsError("owners");
          this.owners.add(r.id);
          this.ownerOrg(r.id);
        }
        return json(rows, 201);
      }
    }
    if ((path === "org_members" || path === "organizations" || path === "org_invitations")) {
      const admin = (org: unknown) => this.orgMembers.some((m) => m.org_id === org && m.user_id === uid && m.role !== "member");
      if (path === "org_members" && req.method === "GET") return json(this.orgMembers.filter((m) => m.user_id === uid || admin(m.org_id)).filter(matches));
      if (path === "organizations" && req.method === "GET") return json(this.organizations.filter((o) => this.orgMembers.some((m) => m.org_id === o["id"] && m.user_id === uid)).filter(matches));
      if (path === "organizations" && req.method === "PATCH") {
        const values = (await req.json()) as Row;
        const hit = this.organizations.filter((o) => admin(o["id"]) && matches(o));
        for (const o of hit) Object.assign(o, values);
        return json(hit);
      }
      if (path === "org_invitations" && req.method === "GET") return json(this.orgInvitations.filter((i) => admin(i["org_id"])).filter(matches));
      return rlsError(path);
    }
    if (path === "banto_site_settings" && req.method === "GET") {
      if (uid && this.orgMembers.some((m) => m.user_id === uid && m.role !== "member")) return json([{ settings: this.siteSettings }]);
      return json([]);
    }
    if (path === "banto_migrations" && req.method === "GET") {
      if (uid && this.orgMembers.some((m) => m.user_id === uid && m.role !== "member")) return json(this.appliedMigrations.map((version) => ({ version })));
      return json([]);
    }

    const table = path as TableName;
    if (!(table in this.tables)) return json({ code: "PGRST205", message: `Could not find the table 'public.${path}'` }, 404);
    const rows = this.tables[table];

    if (req.method === "GET") {
      // 0025: 実店舗の表は購入者（anon）に読ませない（お客様の画面は shop_store_list）
      if ((table === "stores" || table === "shop_stores") && !service && !uid) return json({ code: "42501", message: `permission denied for table ${table}` }, 401);
      let out = rows.filter((r) => (service || this.visible(table, r, uid)) && matches(r));
      const order = u.searchParams.get("order");
      if (order) {
        // created_at.desc,id.desc のような複数の列（同じ値なら次の列で）
        const keys = order.split(",").map((part) => part.split(".") as [string, string | undefined]);
        out = [...out].sort((a, b) => {
          for (const [col, dir] of keys) {
            const x = String(a[col]), y = String(b[col]);
            if (x !== y) return (x < y ? -1 : 1) * (dir === "desc" ? -1 : 1);
          }
          return 0;
        });
      }
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const limit = u.searchParams.get("limit");
      const total = out.length;
      out = out.slice(offset, limit ? offset + Number(limit) : undefined);
      // Prefer: count=exact（DbClient の count）
      if ((req.headers.get("prefer") ?? "").includes("count=exact")) {
        const res = json(out);
        res.headers.set("content-range", `*/${total}`);
        return res;
      }
      return json(out);
    }
    if (req.method === "POST") {
      const incoming = (await req.json()) as Row[];
      const created: Row[] = [];
      for (const r of incoming) {
        if (!this.writable(table, r, uid)) return rlsError(table);
        if (this.uniqueViolation(table, r)) return json({ code: "23505", message: "duplicate key value violates unique constraint" }, 409);
        if (table === "shops" || table === "products" || table === "customers") {
          const hit = this.planLimitHit(table);
          if (hit) return hit;
        }
        const row: Row = { id: `${table}-${++this.seq}`, created_at: this.now(), updated_at: this.now(), published: false, ...r };
        if (table === "shops") Object.assign(row, { legal_notice: null, privacy_policy: null, return_policy: null, stripe_account_id: null, settings: {}, ...r });
        if (table === "shops" && !row["org_id"]) {
          row["org_id"] = this.orgMembers.find((m) => m.user_id === uid && m.role !== "member")?.org_id ?? null;
          if (row["owner_id"] && !this.owners.has(String(row["owner_id"]))) row["owner_id"] = null;
        }
        if (table === "skus") this.tables.inventory.push({ sku_id: row["id"], shop_id: row["shop_id"], available: 0, updated_at: this.now() });
        rows.push(row);
        created.push(row);
      }
      return json(created, 201);
    }
    if (req.method === "PATCH") {
      const values = (await req.json()) as Row;
      const targets = rows.filter((r) => this.visible(table, r, uid) && this.writable(table, r, uid, "update") && matches(r));
      const updated: Row[] = [];
      for (const r of targets) {
        const next: Row = { ...r, ...values, updated_at: this.now() };
        if (!this.writable(table, next, uid, "update")) return rlsError(table);
        if (table === "shops" && next["published"] === true && !(next["legal_notice"] && next["privacy_policy"] && next["return_policy"])) {
          return json({ code: "23514", message: 'new row for relation "shops" violates check constraint "shops_publish_requires_legal"' }, 400);
        }
        if (this.uniqueViolation(table, next, r["id"])) return json({ code: "23505", message: "duplicate key value violates unique constraint" }, 409);
        Object.assign(r, next);
        updated.push(r);
      }
      return json(updated);
    }
    if (req.method === "DELETE") {
      const targets = rows.filter((r) => this.visible(table, r, uid) && this.writable(table, r, uid, "delete") && matches(r));
      for (const r of targets) this.cascadeDelete(table, r);
      return new Response(null, { status: 204 });
    }
    return json({ message: "method not allowed" }, 405);
  }

  private cascadeDelete(table: TableName, row: Row) {
    const remove = (t: TableName, pred: (r: Row) => boolean) => {
      this.tables[t] = this.tables[t].filter((r) => !pred(r));
    };
    const id = row["id"];
    remove(table, (r) => r === row);
    if (table === "products") {
      for (const sku of this.tables.skus.filter((k) => k["product_id"] === id)) this.cascadeDelete("skus", sku);
      remove("product_images", (r) => r["product_id"] === id);
    }
    if (table === "skus") remove("inventory", (r) => r["sku_id"] === id);
  }

  /** 0024 の org_* / banto_* の関数（規則は test/db/organizations.test.ts で裏取り済みのものを最小限） */
  private orgRpc(fn: string, args: Record<string, unknown>, uid: string | null): Response | null {
    const ALL = ["catalog", "orders", "orders_cancel", "customers", "marketing", "reports", "stores", "settings", "integrations"];
    const role = (org: unknown) => this.orgMembers.find((m) => m.org_id === org && m.user_id === uid)?.role ?? null;
    const isAdmin = (org: unknown) => ["owner", "admin"].includes(role(org) ?? "");
    const err = (message: string) => json({ code: "P0001", message }, 400);
    const setShops = (org: string, user: string, shops: unknown) => {
      for (let i = this.orgMemberShops.length - 1; i >= 0; i--) if (this.orgMemberShops[i]!.org_id === org && this.orgMemberShops[i]!.user_id === user) this.orgMemberShops.splice(i, 1);
      for (let i = this.orgMemberStores.length - 1; i >= 0; i--) if (this.orgMemberStores[i]!.org_id === org && this.orgMemberStores[i]!.user_id === user) this.orgMemberStores.splice(i, 1);
      for (const e of (Array.isArray(shops) ? shops : []) as { shop_id?: string; store_id?: string; perms: string[] }[]) {
        if (e.store_id) {
          if (this.tables.stores.some((x) => x["id"] === e.store_id && x["org_id"] === org)) this.orgMemberStores.push({ org_id: org, user_id: user, store_id: e.store_id, perms: [...new Set((e.perms ?? []).filter((p) => p === "tryon" || p === "hours"))] });
          continue;
        }
        if (!this.tables.shops.some((s) => s["id"] === e.shop_id && s["org_id"] === org)) continue;
        this.orgMemberShops.push({ org_id: org, user_id: user, shop_id: e.shop_id!, perms: [...new Set((e.perms ?? []).filter((p) => ALL.includes(p)))] });
      }
    };
    const guard = (org: unknown, target: string | null, current: string | null) => {
      if (!isAdmin(org)) return "org_not_found";
      if (role(org) !== "owner" && (target === "owner" || current === "owner")) return "owner_only";
      return null;
    };
    switch (fn) {
      case "banto_admin_shop": {
        const s = this.tables.shops.find((x) => x["id"] === args["p_shop_id"]);
        if (!s) return json(null);
        if (this.ownedShopIds(uid).has(String(s["id"]))) return json({ shop: s, role: role(s["org_id"]) ?? "owner", perms: ALL });
        const perms = this.memberPerms(uid, s["id"]);
        return json(perms.length > 0 ? { shop: s, role: "member", perms } : null);
      }
      case "banto_my_shops":
        return json(
          this.tables.shops
            .map((s) => ({ s, perms: this.ownedShopIds(uid).has(String(s["id"])) ? ALL : this.memberPerms(uid, s["id"]) }))
            .filter((x) => x.perms.length > 0)
            .map(({ s, perms }) => ({ id: s["id"], slug: s["slug"], name: s["name"], published: s["published"], org_id: s["org_id"], perms })),
        );
      case "org_members_list":
        if (!isAdmin(args["p_org_id"])) return json({ code: "42501", message: "org_not_found" }, 403);
        return json(
          this.orgMembers
            .filter((m) => m.org_id === args["p_org_id"])
            .map((m) => ({ ...m, email: this.users.get(m.user_id)?.email, shops: this.orgMemberShops.filter((x) => x.org_id === m.org_id && x.user_id === m.user_id).map((x) => ({ shop_id: x.shop_id, perms: x.perms })), stores: this.orgMemberStores.filter((x) => x.org_id === m.org_id && x.user_id === m.user_id).map((x) => ({ store_id: x.store_id, perms: x.perms })) })),
        );
      case "org_invite": {
        const org = String(args["p_org_id"]);
        const email = String(args["p_email"] ?? "").trim().toLowerCase();
        const g = guard(org, String(args["p_role"]), null);
        if (g) return err(g);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("invalid_email");
        if (this.orgMembers.some((m) => m.org_id === org && this.users.get(m.user_id)?.email === email)) return err("already_member");
        {
          const limitHit = this.planLimitHit("mail_per_day"); // 0053
          if (limitHit) return limitHit;
        }
        for (let i = this.orgInvitations.length - 1; i >= 0; i--) if (this.orgInvitations[i]!["org_id"] === org && this.orgInvitations[i]!["email"] === email && this.orgInvitations[i]!["accepted_at"] == null) this.orgInvitations.splice(i, 1);
        const id = `inv-${++this.seq}`;
        this.orgInvitations.push({ id, org_id: org, email, role: args["p_role"], shops: args["p_role"] === "member" ? args["p_shops"] : [], token_hash: args["p_token_hash"], expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), accepted_at: null, created_at: this.now() });
        const from = this.tables.hook_endpoints.find((e) => e["enabled"] === true && e["url"] === "https://banto.invalid/plugins/email_resend" && this.tables.shops.some((s) => s["id"] === e["shop_id"] && s["org_id"] === org) && (e["settings"] as Row | undefined)?.["from"]);
        return json({ id, mail_from: from ? String((from["settings"] as Row)["from"]) : null });
      }
      case "org_invitation_revoke": {
        const i = this.orgInvitations.find((x) => x["id"] === args["p_invitation_id"] && x["org_id"] === args["p_org_id"]);
        const g = guard(args["p_org_id"], i ? String(i["role"]) : null, null);
        if (g) return err(g);
        if (i && i["accepted_at"] == null) this.orgInvitations.splice(this.orgInvitations.indexOf(i), 1);
        return json(null);
      }
      case "org_invitation_accept": {
        if (!uid) return json({ code: "42501", message: "login_required" }, 403);
        const i = this.orgInvitations.find((x) => x["token_hash"] === args["p_token_hash"]);
        if (!i || i["accepted_at"] != null || String(i["expires_at"]) <= this.now()) return err("invitation_invalid");
        if (i["email"] !== this.users.get(uid)?.email) return err("invitation_email_mismatch");
        const org = String(i["org_id"]);
        if (!this.orgMembers.some((m) => m.org_id === org && m.user_id === uid)) {
          const limitHit = this.planLimitHit("members");
          if (limitHit) return limitHit;
          this.orgMembers.push({ org_id: org, user_id: uid, role: i["role"] as "owner" | "admin" | "member", created_at: this.now() });
        }
        if (i["role"] === "member") setShops(org, uid, i["shops"]);
        i["accepted_at"] = this.now();
        return json(org);
      }
      case "org_member_set": {
        const org = String(args["p_org_id"]);
        const m = this.orgMembers.find((x) => x.org_id === org && x.user_id === args["p_user_id"]);
        if (!m) return err("member_not_found");
        const next = String(args["p_role"]);
        const g = guard(org, next, m.role);
        if (g) return err(g);
        if (m.role === "owner" && next !== "owner" && this.orgMembers.filter((x) => x.org_id === org && x.role === "owner").length <= 1) return err("last_owner");
        m.role = next as "owner" | "admin" | "member";
        setShops(org, m.user_id, next === "member" ? args["p_shops"] : []);
        return json(null);
      }
      case "tryon_store_shops": {
        if (!this.storePerm(uid, args["p_store_id"], "tryon")) return json([]);
        const st = this.tables.stores.find((x) => x["id"] === args["p_store_id"]);
        return json(
          this.tables.shops
            .filter((s) => s["org_id"] === st?.["org_id"] && (this.tables.shop_stores.some((l) => l["shop_id"] === s["id"] && l["store_id"] === st?.["id"]) || this.tables.tryon_requests.some((r) => r["shop_id"] === s["id"] && r["store_id"] === st?.["id"])))
            .map((s) => ({ id: s["id"], name: s["name"] })),
        );
      }
      case "banto_my_stores":
        return json(this.orgMemberStores.filter((m) => m.user_id === uid && m.perms.length > 0).map((m) => ({ id: m.store_id, org_id: m.org_id, name: this.tables.stores.find((x) => x["id"] === m.store_id)?.["name"], perms: m.perms })));
      case "store_set_hours": {
        if (!this.storePerm(uid, args["p_store_id"], "hours")) return json({ code: "42501", message: "store_not_found" }, 403);
        const st = this.tables.stores.find((x) => x["id"] === args["p_store_id"])!;
        Object.assign(st, { hours: args["p_hours"], special_days: args["p_special_days"] });
        return json(true);
      }
      case "stores_set_special_days": {
        const days = args["p_days"] as Row[];
        const dates = new Set(days.map((d) => String(d["date"])));
        let n = 0;
        for (const st of this.tables.stores.filter((x) => x["org_id"] === args["p_org_id"] && (args["p_store_ids"] as string[]).includes(String(x["id"])))) {
          if (!this.storePerm(uid, st["id"], "hours")) continue;
          const keep = ((st["special_days"] as Row[]) ?? []).filter((d) => !dates.has(String(d["date"])));
          const add = days.filter((d) => d["remove"] !== true).map(({ remove: _r, ...d }) => d);
          st["special_days"] = [...keep, ...add].sort((a, b) => (String(a["date"]) < String(b["date"]) ? -1 : 1));
          n++;
        }
        return json(n);
      }
      case "tryon_request_detail": {
        const r = this.tables.tryon_requests.find((x) => x["id"] === args["p_request_id"]);
        if (!r) return json(null);
        const shopPerm = this.ownedShopIds(uid).has(String(r["shop_id"])) || this.memberPerms(uid, r["shop_id"]).includes("stores");
        if (!shopPerm && !this.storePerm(uid, r["store_id"], "tryon")) return json(null);
        const st = this.tables.stores.find((x) => x["id"] === r["store_id"]);
        const sh = this.tables.shops.find((x) => x["id"] === r["shop_id"])!;
        const items = this.tables.tryon_items.filter((x) => x["request_id"] === r["id"]).map((it) => {
          const sku = this.tables.skus.find((k) => k["id"] === it["sku_id"]);
          return { sku_id: it["sku_id"], code: sku?.["code"] ?? null, product: this.tables.products.find((p) => p["id"] === sku?.["product_id"])?.["name"] ?? null, sku: sku?.["name"] ?? null, qty: it["qty"], unit_price_jpy: it["unit_price_jpy"] };
        });
        return json({ request: r, store: st ? { id: st["id"], name: st["name"], hours: st["hours"], special_days: st["special_days"] } : null, shop: { id: sh["id"], name: sh["name"], settings: { store_tryon: (sh["settings"] as Row | undefined)?.["store_tryon"] ?? null } }, can_restock: shopPerm, items });
      }
      case "org_member_remove": {
        const org = String(args["p_org_id"]);
        const m = this.orgMembers.find((x) => x.org_id === org && x.user_id === args["p_user_id"]);
        if (!m) return err("member_not_found");
        const g = guard(org, null, m.role);
        if (g) return err(g);
        if (m.role === "owner" && this.orgMembers.filter((x) => x.org_id === org && x.role === "owner").length <= 1) return err("last_owner");
        this.orgMembers.splice(this.orgMembers.indexOf(m), 1);
        setShops(org, m.user_id, []);
        return json(null);
      }
    }
    return null;
  }

  /** Cron ハートビート（0006）。null = 一度も記録なし */
  heartbeats = new Map<string, number>();

  /** 0058 の list_price_jpy / list_compare_at_jpy（いちばん安い SKU。同額なら作成順・id 順） */
  private listPrice(productId: unknown): { price: number | null; compareAt: number | null } {
    const skus = this.tables.skus
      .filter((k) => k["product_id"] === productId)
      .sort((a, b) => Number(a["price_jpy"]) - Number(b["price_jpy"]) || String(a["created_at"]).localeCompare(String(b["created_at"])) || String(a["id"]).localeCompare(String(b["id"])));
    const k = skus[0];
    return k ? { price: Number(k["price_jpy"]), compareAt: (k["compare_at_price_jpy"] as number | null) ?? null } : { price: null, compareAt: null };
  }

  private productPublicList(args: Record<string, unknown>): Response {
    const shopId = args["p_shop_id"];
    if (!this.shopPublished(shopId)) return json({ items: [], next: null });
    const limit = Math.min(Math.max(Number(args["p_limit"] ?? 24) || 24, 1), 100);
    const offset = Math.max(Number(args["p_offset"] ?? 0) || 0, 0);
    if (offset > 10000) return json({ code: "22023", message: "offset_too_large" }, 400);
    const sort = String(args["p_sort"] ?? "new");
    const tag = args["p_tag"] as string | null;
    const cats = args["p_category_ids"] as string[] | null;
    const brand = args["p_brand"] as string | null;
    const q = typeof args["p_q"] === "string" && args["p_q"].trim() ? args["p_q"].trim().slice(0, 100).toLowerCase() : null;
    const since = args["p_updated_since"] ? Date.parse(String(args["p_updated_since"])) : null;
    type Entry = { p: Row; key: string | number; price: number | null; compareAt: number | null };
    const keyOf: Record<string, (e: { p: Row; price: number | null }) => string | number> = {
      new: (e) => String(e.p["created_at"]),
      updated: (e) => String(e.p["updated_at"]),
      price_asc: (e) => e.price ?? 2147483647,
      price_desc: (e) => e.price ?? -1,
      name: (e) => String(e.p["name"]),
    };
    const desc = sort === "new" || sort === "updated" || sort === "price_desc";
    if (!keyOf[sort]) return json({ code: "22023", message: "invalid_sort" }, 400);
    const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);
    const order = (x: Entry, y: Entry) => (desc ? -1 : 1) * (cmp(x.key, y.key) || cmp(String(x.p["id"]), String(y.p["id"])));
    const tagsOf = (p: Row) => (Array.isArray(p["tags"]) ? (p["tags"] as string[]) : []);
    const text = (p: Row) => [p["name"], p["brand"] ?? "", tagsOf(p).join(" "), String(p["description"] ?? "").slice(0, 300)].join(" ").toLowerCase();
    let rows: Entry[] = this.tables.products
      .filter((p) => p["shop_id"] === shopId && p["published"] === true)
      .filter((p) => !tag || tagsOf(p).includes(tag))
      .filter((p) => !cats || cats.includes(String(p["category_id"])) || ((p["extra_category_ids"] ?? []) as string[]).some((c) => cats.includes(c)))
      .filter((p) => !brand || p["brand"] === brand)
      .filter((p) => !q || text(p).includes(q))
      .filter((p) => since === null || Date.parse(String(p["updated_at"])) > since)
      .map((p) => {
        const lp = this.listPrice(p["id"]);
        return { p, key: keyOf[sort]!({ p, price: lp.price }), price: lp.price, compareAt: lp.compareAt };
      })
      .sort(order);
    const total = rows.length;
    const after = args["p_after"] as { k: string | number; id: string } | null;
    if (after) rows = rows.filter((e) => (desc ? -1 : 1) * (cmp(e.key, typeof e.key === "number" ? Number(after.k) : String(after.k)) || cmp(String(e.p["id"]), after.id)) > 0);
    else rows = rows.slice(offset);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const items = page.map((e) => {
      const img = this.tables.product_images.filter((i) => i["product_id"] === e.p["id"]).sort((a, b) => Number(a["sort_order"]) - Number(b["sort_order"]))[0];
      return {
        id: e.p["id"], slug: e.p["slug"], name: e.p["name"], brand: e.p["brand"] ?? null, category_id: e.p["category_id"] ?? null,
        extra_category_ids: e.p["extra_category_ids"] ?? [], tags: tagsOf(e.p), created_at: e.p["created_at"], updated_at: e.p["updated_at"],
        min_price_jpy: e.price, compare_at_price_jpy: e.compareAt,
        image: img ? { storage_key: img["storage_key"], thumb_key: img["thumb_key"] ?? null, width: img["width"] ?? null, height: img["height"] ?? null } : null,
      };
    });
    return json({
      items,
      next: rows.length > limit && last ? { k: last.key, id: last.p["id"] } : null,
      ...(args["p_count"] ? { total: Math.min(total, 10000), total_capped: total > 10000 } : {}),
    });
  }

  private productPublicFacets(shopId: string, tagLimit: number): { tags: { tag: string; count: number }[]; categories: Record<string, number> } {
    if (!this.shopPublished(shopId)) return { tags: [], categories: {} };
    const products = this.tables.products.filter((p) => p["shop_id"] === shopId && p["published"] === true);
    const tags = new Map<string, number>();
    for (const p of products) for (const t of new Set(Array.isArray(p["tags"]) ? (p["tags"] as string[]) : [])) tags.set(t, (tags.get(t) ?? 0) + 1);
    const cats = this.tables.categories.filter((c) => c["shop_id"] === shopId);
    const parent = new Map(cats.map((c) => [String(c["id"]), (c["parent_id"] as string | null) ?? null]));
    const counts: Record<string, number> = {};
    for (const p of products) {
      const seen = new Set<string>();
      for (const start of [p["category_id"], ...((p["extra_category_ids"] ?? []) as string[])]) {
        for (let id = start ? String(start) : null; id && parent.has(id); id = parent.get(id) ?? null) seen.add(id);
      }
      for (const id of seen) counts[id] = (counts[id] ?? 0) + 1;
    }
    return {
      tags: [...tags].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)).slice(0, tagLimit),
      categories: counts,
    };
  }

  private rpc(fn: string, args: Record<string, unknown>, uid: string | null): Response {
    if (fn === "shop_store_list") {
      if (!this.shopPublished(args["p_shop_id"])) return json([]);
      return json(
        this.tables.shop_stores
          .filter((ss) => ss["shop_id"] === args["p_shop_id"])
          .map((ss) => ({ ss, st: this.tables.stores.find((x) => x["id"] === ss["store_id"] && x["active"] !== false) }))
          .filter((x) => x.st)
          .sort((a, b) => Number(a.ss["sort_order"] ?? 0) - Number(b.ss["sort_order"] ?? 0))
          .map(({ ss, st }) => ({ id: st!["id"], shop_id: ss["shop_id"], name: st!["name"], postal_code: st!["postal_code"] ?? null, address: st!["address"] ?? null, phone: st!["phone"] ?? null, hours: st!["hours"] ?? {}, special_days: st!["special_days"] ?? [], note: st!["note"] ?? null, tryon: ss["tryon"] !== false, active: true, sort_order: ss["sort_order"] ?? 0 })),
      );
    }
    // 0030: 運営者のセッションの世代
    if (fn === "banto_admin_me") {
      if (!uid || !this.orgMembers.some((m) => m.user_id === uid)) return json({ member: false });
      return json({ member: true, epoch: this.adminEpochs.get(uid) ?? 0 });
    }
    if (fn === "admin_session_bump") {
      if (!uid) return json({ code: "42501", message: "unauthorized" }, 403);
      const next = (this.adminEpochs.get(uid) ?? 0) + 1;
      this.adminEpochs.set(uid, next);
      return json(next);
    }
    // 0054: 運営者の二段階認証
    if (fn === "org_set_require_mfa") {
      const org = this.organizations.find((o) => o["id"] === args["p_org_id"]);
      if (!org || !this.orgMembers.some((m) => m.org_id === org["id"] && m.user_id === uid && m.role === "owner")) return json({ code: "42501", message: "forbidden" }, 403);
      if (args["p_required"] === true && this.currentAal !== "aal2") return json({ code: "P0001", message: "mfa_self_first" }, 400);
      org["require_mfa"] = args["p_required"] === true;
      return json(null);
    }
    // 0057: 二段階認証の登録・解除の監査（本物は audit_log に書く。ここでは呼べたことだけ）
    if (fn === "org_member_mfa_self") {
      if (!uid) return json({ code: "42501", message: "forbidden" }, 403);
      return json(null);
    }
    if (fn === "org_members_mfa") {
      const isAdmin = this.orgMembers.some((m) => m.org_id === args["p_org_id"] && m.user_id === uid && m.role !== "member");
      if (!isAdmin) return json([]);
      return json(this.orgMembers.filter((m) => m.org_id === args["p_org_id"]).map((m) => ({ user_id: m.user_id, has_mfa: (this.users.get(m.user_id)?.factors ?? []).some((f) => f.status === "verified") })));
    }
    if (fn === "org_member_mfa_reset_authorize") {
      const target = String(args["p_user_id"]);
      const ok = target !== uid && this.orgMembers.some((me) => me.user_id === uid && me.role !== "member" && this.orgMembers.some((them) => them.org_id === me.org_id && them.user_id === target && (them.role !== "owner" || me.role === "owner")));
      return ok ? json(true) : json({ code: "42501", message: "forbidden" }, 403);
    }
    const orgResult = this.orgRpc(fn, args, uid);
    if (orgResult) return orgResult;
    if (fn === "heartbeat_age_seconds") {
      const at = this.heartbeats.get(String(args["p_name"]));
      return json(at === undefined ? null : Math.floor((Date.now() - at) / 1000));
    }
    if (fn === "banto_setup_state") {
      return json({ has_owner: this.owners.size > 0 || this.orgMembers.length > 0 || this.tables.shops.length > 0, shop_count: this.tables.shops.length, migrations: this.appliedMigrations });
    }
    if (fn === "shop_payment_options") return json(this.paymentOptions(args["p_shop_id"]));
    if (fn === "shop_public_get") return json(this.shopPublicGet(args));
    if (fn === "shop_public_list") return json(this.tables.shops.filter((s) => s["published"] === true).map((s) => this.shopPublicJson(s)));
    // 0055: 商品詳細（公開中のショップの公開中の商品だけ。attributes は公開の項目だけ）
    if (fn === "product_public_get") {
      if (!this.shopPublished(args["p_shop_id"])) return json(null);
      const p = this.tables.products.find((x) => x["shop_id"] === args["p_shop_id"] && x["slug"] === args["p_slug"] && x["published"] === true);
      if (!p) return json(null);
      const shop = this.tables.shops.find((s) => s["id"] === args["p_shop_id"]);
      const fields = productFields((shop?.["settings"] ?? {}) as Record<string, unknown>);
      const attrs = (p["attributes"] ?? {}) as Record<string, unknown>;
      const pub: Record<string, unknown> = {};
      for (const f of fields) if (f.public && f.key in attrs) pub[f.key] = attrs[f.key];
      return json({ ...p, attributes: pub });
    }
    // 0058: 商品の一覧（キーセット）とタグ・カテゴリーの件数。本物の SQL と同じ並べ替え・絞り込みをメモリで
    if (fn === "product_public_list") return this.productPublicList(args);
    // 0060: サイトマップの分割と商品フィードの 1 ページ
    if (fn === "product_public_count") return json(this.shopPublished(args["p_shop_id"]) ? this.tables.products.filter((p) => p["shop_id"] === args["p_shop_id"] && p["published"] === true).length : 0);
    if (fn === "product_public_slugs") {
      if (!this.shopPublished(args["p_shop_id"])) return json([]);
      const rows = this.tables.products.filter((p) => p["shop_id"] === args["p_shop_id"] && p["published"] === true).sort((a, b) => String(a["id"]).localeCompare(String(b["id"])));
      const offset = Number(args["p_offset"] ?? 0);
      return json(rows.slice(offset, offset + Math.min(Number(args["p_limit"] ?? 0), 10000)).map((p) => [p["slug"], p["updated_at"]]));
    }
    if (fn === "product_feed_page") {
      if (!this.shopPublished(args["p_shop_id"])) return json({ products: [], skus: [], inventory: [], images: [] });
      const after = args["p_after"] as string | null;
      const products = this.tables.products
        .filter((p) => p["shop_id"] === args["p_shop_id"] && p["published"] === true && (!after || String(p["id"]) > after))
        .sort((a, b) => String(a["id"]).localeCompare(String(b["id"])))
        .slice(0, Math.min(Number(args["p_limit"] ?? 0), 1000))
        .map(({ attributes: _attrs, ...p }) => p);
      const ids = new Set(products.map((p) => p["id"]));
      const skus = this.tables.skus.filter((k) => ids.has(k["product_id"]));
      const skuIds = new Set(skus.map((k) => k["id"]));
      return json({
        products,
        skus,
        inventory: this.tables.inventory.filter((i) => skuIds.has(i["sku_id"])).map((i) => ({ sku_id: i["sku_id"], available: i["available"] })),
        images: this.tables.product_images.filter((i) => ids.has(i["product_id"])).sort((a, b) => Number(a["sort_order"]) - Number(b["sort_order"])),
      });
    }
    if (fn === "banto_site_plan") return json(this.sitePlan);
    if (fn === "product_public_facets") return json(this.productPublicFacets(String(args["p_shop_id"]), Number(args["p_tag_limit"] ?? 200)));
    if (fn === "set_stock") {
      const sku = this.tables.skus.find((k) => k["id"] === args["p_sku_id"]);
      const available = Number(args["p_available"]);
      if (!Number.isInteger(available) || available < 0) return json({ code: "P0001", message: "invalid_available" }, 400);
      if (!sku || !uid || !this.ownedShopIds(uid).has(sku["shop_id"] as string)) return json({ code: "42501", message: "sku_not_found" }, 403);
      const inv = this.tables.inventory.find((i) => i["sku_id"] === sku["id"])!;
      inv["available"] = available;
      return json(available);
    }
    if (fn === "enqueue_hook") {
      if (!uid || !this.ownedShopIds(uid).has(args["p_shop_id"] as string)) return json({ code: "42501", message: "shop_not_found" }, 403);
      return json(this.enqueue(args["p_shop_id"] as string, args["p_event"] as string, (args["p_payload"] ?? {}) as Row));
    }
    if (fn === "coupon_claim_info") {
      const k = this.tables.coupon_campaigns.find((x) => x["id"] === args["p_campaign_id"] && x["shop_id"] === args["p_shop_id"] && x["claimable"] === true && this.shopPublished(x["shop_id"]));
      if (!k) return json(null);
      const claimed = this.tables.coupon_grants.filter((g) => g["campaign_id"] === k["id"]).length;
      return json({ id: k["id"], name: k["name"], kind: k["kind"], value: k["value"] ?? 0, starts_at: k["starts_at"] ?? null, ends_at: k["ends_at"] ?? null, live: k["active"] !== false, conditions: {}, remaining: k["usage_limit"] == null ? null : Math.max(0, Number(k["usage_limit"]) - claimed) });
    }
    if (fn === "lookup_order") {
      const o = this.tables.orders.find((x) => x["shop_id"] === args["p_shop_id"] && x["number"] === Number(args["p_number"]) && String(x["customer_email"] ?? "").toLowerCase() === String(args["p_email"]).trim().toLowerCase() && this.shopPublished(x["shop_id"]));
      if (!o) return json(null);
      return json(this.orderJson(o));
    }
    if (fn === "sales_summary") {
      if (!uid || !this.ownedShopIds(uid).has(args["p_shop_id"] as string)) return json({ code: "42501", message: "shop_not_found" }, 403);
      return json(this.salesSummary(args["p_shop_id"] as string, String(args["p_from"]), String(args["p_to"]), String(args["p_group_by"] ?? "day")));
    }
    if (fn === "import_catalog") {
      if (!uid || !this.ownedShopIds(uid).has(args["p_shop_id"] as string)) return json({ code: "42501", message: "shop_not_found" }, 403);
      return this.importCatalog(args);
    }
    if (fn === "tryon_update" || fn === "tryon_restock") {
      // 0024 の再現（遷移の検査は簡略。中身は test/db/tryon.test.ts）
      const shopId = args["p_shop_id"] as string;
      const shopPerm = !!uid && (this.ownedShopIds(uid).has(shopId) || this.memberPerms(uid, shopId).includes("stores"));
      const r = this.tables.tryon_requests.find((x) => x["id"] === args["p_request_id"] && x["shop_id"] === shopId);
      if (fn === "tryon_restock" && !shopPerm) return json({ code: "42501", message: "shop_not_found" }, 403);
      if (!r || !(shopPerm || this.storePerm(uid, r["store_id"], "tryon"))) return json({ code: "42501", message: "not_found" }, 403);
      if (fn === "tryon_restock") {
        if (!["not_purchased", "expired", "cancelled"].includes(String(r["status"]))) return json({ code: "P0001", message: "not_restockable" }, 400);
        if (r["restocked"]) return json(0);
        for (const it of this.tables.tryon_items.filter((x) => x["request_id"] === r["id"])) {
          const inv = this.tables.inventory.find((i) => i["sku_id"] === it["sku_id"]);
          if (inv) inv["available"] = Number(inv["available"]) + Number(it["qty"]);
        }
        r["restocked"] = true;
        return json(1);
      }
      const status = String(args["p_status"]);
      const allowed: Record<string, string[]> = { sent: ["requested"], ready: ["requested", "sent", "ready"], purchased: ["ready", "expired"], not_purchased: ["ready", "expired"], cancelled: ["requested", "sent", "ready"] };
      if (!(allowed[status] ?? []).includes(String(r["status"]))) return json({ code: "P0001", message: "invalid_transition" }, 400);
      Object.assign(r, { status, hold_until: status === "ready" ? args["p_hold_until"] : r["hold_until"] });
      this.enqueue(shopId, "tryon.updated", { request_id: r["id"], number: r["number"], shop_id: shopId, store_id: r["store_id"], status, hold_until: r["hold_until"] ?? null, customer_id: r["customer_id"] ?? null });
      return json({ id: r["id"], status, hold_until: r["hold_until"] ?? null });
    }
    if (fn === "coupon_grants_for_emails") {
      // 0023 の再現: 会員はその会員に、それ以外はコードだけ
      if (!uid || !this.ownedShopIds(uid).has(args["p_shop_id"] as string)) return json({ code: "42501", message: "shop_not_found" }, 403);
      const out: Row[] = [];
      for (const e of [...new Set(((args["p_emails"] as string[]) ?? []).map((x) => x.toLowerCase()))].sort()) {
        const cust = this.tables.customers.find((c) => c["shop_id"] === args["p_shop_id"] && String(c["email"]).toLowerCase() === e);
        const code = `G${++this.seq}`;
        this.tables.coupon_grants.push({ id: `grant-${this.seq}`, shop_id: args["p_shop_id"], campaign_id: args["p_campaign_id"], code, customer_id: cust?.["id"] ?? null, status: "available" });
        out.push({ email: e, code, member: !!cust });
      }
      return json(out);
    }
    if (fn === "import_coupons") {
      // 0043 の再現（簡略）: 既にあるか・知らない商品・会員でない人だけを見る。値の検査は test/db/coupon-import.test.ts（実 PostgreSQL）
      const shopId = args["p_shop_id"] as string;
      if (!uid || !this.ownedShopIds(uid).has(shopId)) return json({ code: "42501", message: "shop_not_found" }, 403);
      this.lastImport = { fn, args };
      const out: Row[] = [];
      const seen = new Set<string>();
      for (const r of (args["p_rows"] as Row[]) ?? []) {
        const v = { ...(r["values"] as Row) };
        const emails = (r["member_emails"] as string[]) ?? [];
        const missing = ((r["product_slugs"] as string[]) ?? []).filter((slug) => !this.tables.products.some((p) => p["shop_id"] === shopId && p["slug"] === slug));
        if (missing.length > 0) {
          out.push({ line: r["line"], status: "error", error: `unknown_products: ${missing.join(", ")}` });
          continue;
        }
        const notMembers = emails.filter((e) => !this.tables.customers.some((c) => c["shop_id"] === shopId && String(c["email"]).toLowerCase() === e));
        if (notMembers.length > 0) {
          out.push({ line: r["line"], status: "error", error: `not_members: ${notMembers.join(", ")} (${notMembers.length})` });
          continue;
        }
        const code = emails.length > 0 || !v["code"] ? null : String(v["code"]).toUpperCase();
        const ref = (v["external_ref"] as string | undefined) ?? (emails.length > 0 && v["code"] ? `csv:${String(v["code"]).toUpperCase()}` : null);
        const exists = this.tables.coupon_campaigns.some((x) => x["shop_id"] === shopId && ((code && x["code"] === code) || (ref && x["external_ref"] === ref)));
        if (exists || (code && seen.has(`c:${code}`)) || (ref && seen.has(`r:${ref}`))) {
          out.push({ line: r["line"], status: "existing", code, name: v["name"] });
          continue;
        }
        if (code) seen.add(`c:${code}`);
        if (ref) seen.add(`r:${ref}`);
        if (!args["p_dry_run"]) {
          const id = `camp-${++this.seq}`;
          this.tables.coupon_campaigns.push({ id, shop_id: shopId, name: v["name"], code, external_ref: ref, kind: v["kind"], value: v["value"] ?? 0, active: v["active"] ?? true, audience: v["audience"] ?? "public", conditions: r["conditions"] ?? {}, combinable: v["combinable"] ?? false, created_at: new Date().toISOString() });
          for (const e of emails) this.tables.coupon_grants.push({ id: `grant-${++this.seq}`, shop_id: shopId, campaign_id: id, code: `G${this.seq}`, customer_id: this.tables.customers.find((c) => c["shop_id"] === shopId && String(c["email"]).toLowerCase() === e)!["id"], status: "available" });
        }
        out.push({ line: r["line"], status: args["p_dry_run"] ? "ok" : "created", code, name: v["name"], members: emails.length, active: v["active"] ?? true });
      }
      return json(out);
    }
    if (fn === "import_coupon_usage" || fn === "import_orders") {
      // 0023 の受け口（中身は DB テスト test/db/woo-history.test.ts）
      if (!uid || !this.ownedShopIds(uid).has(args["p_shop_id"] as string)) return json({ code: "42501", message: "shop_not_found" }, 403);
      this.lastImport = { fn, args };
      return json(fn === "import_orders" ? { created: (args["p_orders"] as unknown[]).length, existing: 0, invalid: 0, items: 0, items_without_sku: 0, conflicts: [] } : { found: true, uses: (args["p_emails"] as unknown[]).length });
    }
    if (fn === "ship_orders") {
      // 0022 の再現（番号の検査は簡略）
      const shopId = args["p_shop_id"] as string;
      if (!uid || !this.ownedShopIds(uid).has(shopId)) return json({ code: "42501", message: "shop_not_found" }, 403);
      const r = { shipped: 0, updated: 0, invalid: 0, missing: [] as number[] };
      for (const it of (args["p_items"] as Row[]) ?? []) {
        const tracking = String(it["tracking"] ?? "").replace(/[\s-]/g, "");
        if (!/^[0-9]{1,9}$/.test(String(it["number"])) || !/^[0-9A-Za-z]{4,40}$/.test(tracking)) {
          r.invalid++;
          continue;
        }
        const o = this.tables.orders.find((x) => x["shop_id"] === shopId && x["number"] === Number(it["number"]) && ["paid", "shipped"].includes(String(x["status"])));
        if (!o) {
          r.missing.push(Number(it["number"]));
          continue;
        }
        Object.assign(o, { tracking_carrier: it["carrier"], tracking_number: tracking });
        if (o["status"] === "paid") {
          Object.assign(o, { status: "shipped", shipped_at: new Date().toISOString() });
          this.enqueue(shopId, "order.shipped", { order_id: o["id"], order_number: o["number"], shop_id: shopId, status: "shipped" });
          r.shipped++;
        } else r.updated++;
      }
      return json(r);
    }
    // 0038 / 0039（簡略。権限と値の検査の本物は test/db/image-import-queue.test.ts）
    if (fn === "banto_plan_usage") {
      if (!uid || !this.orgMembers.some((m) => m.user_id === uid && m.role !== "member")) return json({ code: "42501", message: "forbidden" }, 403);
      return json({ limits: this.siteSettings["plan_limits"] ?? {}, usage: { shops: this.tables.shops.length, products: this.tables.products.length, customers: this.tables.customers.length, members: this.orgMembers.length, mail_per_day: this.memberChallenges.length + this.orgInvitations.length } });
    }
    if (fn === "site_settings_set") {
      if (args["p_key"] === "plan_limits") return json({ code: "42501", message: "forbidden" }, 403); // 0052: 組織の owner / admin は書けない
      if (!uid || !this.orgMembers.some((m) => m.user_id === uid && m.role !== "member")) return json({ code: "42501", message: "forbidden" }, 403);
      if (args["p_key"] !== "workers_plan" || !["free", "paid"].includes(String(args["p_value"]))) return json({ code: "P0001", message: "invalid_value" }, 400);
      this.siteSettings = { ...this.siteSettings, workers_plan: args["p_value"] };
      return json(this.siteSettings);
    }
    if (fn.startsWith("image_import_")) {
      const shopId = args["p_shop_id"] as string;
      if (!uid || !this.ownedShopIds(uid).has(shopId)) return json({ code: "42501", message: "shop_not_found" }, 403);
      const mine = this.imageJobs.filter((j) => j.shop_id === shopId);
      if (fn === "image_import_enqueue") {
        const r = { queued: 0, skipped: 0, missing: 0 };
        for (const it of (args["p_items"] as Row[]) ?? []) {
          const p = this.tables.products.find((x) => x["shop_id"] === shopId && x["slug"] === it["slug"]);
          if (!p) {
            r.missing++;
            continue;
          }
          for (const u of (it["urls"] as { url: string; tag: string }[]) ?? []) {
            const have = this.tables.product_images.some((i) => i["product_id"] === p["id"] && String(i["storage_key"]).includes(u.tag));
            const job = this.imageJobs.find((j) => j.product_id === p["id"] && j.url === u.url);
            if (have || (job && job.status !== "failed")) r.skipped++;
            else if (job) Object.assign(job, { status: "pending", attempts: 0, last_error: null }) && r.queued++;
            else {
              this.imageJobs.push({ id: ++this.seq, shop_id: shopId, product_id: p["id"] as string, url: u.url, status: "pending", attempts: 0, last_error: null });
              r.queued++;
            }
          }
        }
        return json(r);
      }
      if (fn === "image_import_summary") {
        const n = (st: string) => mine.filter((j) => j.status === st).length;
        const plan = this.siteSettings["workers_plan"] === "paid" ? "paid" : "free";
        return json({ pending: n("pending"), running: n("running"), done: n("done"), failed: n("failed"), last_done_at: null, batch: plan === "paid" ? 150 : 12, plan,
          failures: mine.filter((j) => j.status === "failed").map((j) => ({ slug: this.tables.products.find((p) => p["id"] === j.product_id)?.["slug"], url: j.url, code: j.last_error })) });
      }
      if (fn === "image_import_cancel") {
        const before = this.imageJobs.length;
        this.imageJobs = this.imageJobs.filter((j) => !(j.shop_id === shopId && (j.status === "pending" || j.status === "failed")));
        return json(before - this.imageJobs.length);
      }
      if (fn === "image_import_resolve") {
        const hit = mine.filter((j) => j.product_id === args["p_product_id"] && j.url === args["p_url"] && (j.status === "pending" || j.status === "failed"));
        for (const j of hit) Object.assign(j, { status: "done", last_error: null });
        return json(hit.length);
      }
      if (fn === "image_import_retry") {
        const failed = mine.filter((j) => j.status === "failed");
        for (const j of failed) Object.assign(j, { status: "pending", attempts: 0, last_error: null });
        return json(failed.length);
      }
    }
    if (fn === "import_tax_classes") {
      if (!uid || !this.ownedShopIds(uid).has(args["p_shop_id"] as string)) return json({ code: "42501", message: "shop_not_found" }, 403);
      let n = 0;
      for (const it of (args["p_items"] as Row[]) ?? []) {
        const p = this.tables.products.find((x) => x["shop_id"] === args["p_shop_id"] && x["slug"] === it["slug"]);
        if (p && ["standard", "reduced", "exempt"].includes(String(it["tax_class"])) && p["tax_class"] !== it["tax_class"]) {
          p["tax_class"] = it["tax_class"];
          n++;
        }
      }
      return json(n);
    }
    if (fn === "shop_secret_save") {
      if (!uid || !this.ownedShopIds(uid).has(args["p_shop_id"] as string)) return json({ code: "42501", message: "shop_not_found" }, 403);
      this.tables.shop_secret_boxes = this.tables.shop_secret_boxes.filter((r) => !(r["shop_id"] === args["p_shop_id"] && r["purpose"] === args["p_purpose"]));
      if (args["p_secret_box"]) this.tables.shop_secret_boxes.push({ shop_id: args["p_shop_id"], purpose: args["p_purpose"], secret_box: args["p_secret_box"], updated_at: this.now() });
      return json(true);
    }
    if (fn === "coupon_grants_issue") {
      if (!uid || !this.ownedShopIds(uid).has(args["p_shop_id"] as string)) return json({ code: "42501", message: "shop_not_found" }, 403);
      const c = this.tables.coupon_campaigns.find((x) => x["id"] === args["p_campaign_id"] && x["shop_id"] === args["p_shop_id"]);
      if (!c) return json({ code: "P0001", message: "campaign_not_found" }, 400);
      const days = c["grant_valid_days"] ? Number(c["grant_valid_days"]) : null;
      const expires = days ? new Date(Date.now() + days * 86400_000).toISOString() : (c["ends_at"] ?? null);
      let n = 0;
      for (const cid of (args["p_customer_ids"] as string[]) ?? []) {
        if (!this.tables.customers.some((x) => x["shop_id"] === args["p_shop_id"] && x["id"] === cid)) continue;
        if (this.tables.coupon_grants.some((g) => g["campaign_id"] === c["id"] && g["customer_id"] === cid && (g["status"] === "available" || g["status"] === "held"))) continue;
        this.addGrant(String(args["p_shop_id"]), String(c["id"]), { customer_id: cid, expires_at: expires });
        n++;
      }
      for (let i = 0; i < Number(args["p_count"] ?? 0); i++) {
        this.addGrant(String(args["p_shop_id"]), String(c["id"]), { expires_at: expires });
        n++;
      }
      return json({ issued: n });
    }
    if (fn === "coupon_grant_revoke") {
      if (!uid || !this.ownedShopIds(uid).has(args["p_shop_id"] as string)) return json({ code: "42501", message: "shop_not_found" }, 403);
      const g = this.tables.coupon_grants.find((x) => x["id"] === args["p_grant_id"] && x["shop_id"] === args["p_shop_id"] && x["status"] === "available");
      if (g) g["status"] = "revoked";
      return json(Boolean(g));
    }
    // 0059: 管理画面の部分一致の検索（本物は権限を 1 回確かめて RLS の外でインデックスを使う）
    if (fn === "admin_search_ids") {
      const shopId = String(args["p_shop_id"]);
      if (!uid || !this.ownedShopIds(uid).has(shopId)) return json({ code: "42501", message: "forbidden" }, 403);
      const kind = String(args["p_kind"]) as "products" | "orders" | "customers";
      const q = String(args["p_q"] ?? "").trim().toLowerCase();
      const f = (args["p_filters"] ?? {}) as Record<string, string>;
      const has = (v: unknown) => q !== "" && typeof v === "string" && v.toLowerCase().includes(q);
      const afterK = args["p_after_k"] as string | null;
      const afterId = args["p_after_id"] as string | null;
      const rows = this.tables[kind]
        .filter((r) => r["shop_id"] === shopId)
        .filter((r) => {
          if (kind === "products") return (!q || has(r["name"]) || has(r["slug"])) && (f["state"] !== "published" || r["published"] === true) && (f["state"] !== "draft" || r["published"] !== true);
          if (kind === "orders") return (!q || has(r["customer_email"]) || has(r["customer_name"]) || r["payment_ref"] === q || (/^\d{1,9}$/.test(q) && Number(r["number"]) === Number(q))) && (!f["status"] || r["status"] === f["status"]);
          const attrs = (r["attributes"] ?? {}) as Record<string, unknown>;
          const consent = r["marketing_consent"];
          return (
            (!q || has(r["email"]) || has(r["name"])) &&
            (!f["field"] || !f["value"] || String(attrs[f["field"]] ?? "").toLowerCase().includes(f["value"].toLowerCase())) &&
            (f["consent"] !== "yes" || consent === true) && (f["consent"] !== "no" || consent === false) && (f["consent"] !== "none" || consent === null || consent === undefined)
          );
        })
        .filter((r) => !afterK || !afterId || String(r["created_at"]) < afterK || (String(r["created_at"]) === afterK && String(r["id"]) < afterId))
        .sort((a, b) => (String(a["created_at"]) === String(b["created_at"]) ? (String(a["id"]) < String(b["id"]) ? 1 : -1) : String(a["created_at"]) < String(b["created_at"]) ? 1 : -1));
      return json(rows.slice(0, Math.min(Number(args["p_limit"] ?? 50), 1000)).map((r) => r["id"]));
    }
    if (fn === "coupon_grant_counts") {
      if (!uid || !this.ownedShopIds(uid).has(String(args["p_shop_id"]))) return json(null);
      const out: Record<string, number> = { available: 0, held: 0, used: 0, revoked: 0 };
      for (const g of this.tables.coupon_grants) if (g["shop_id"] === args["p_shop_id"] && g["campaign_id"] === args["p_campaign_id"]) out[String(g["status"])] = (out[String(g["status"])] ?? 0) + 1;
      return json(out);
    }
    if (fn === "coupon_stats" || fn === "coupon_stats_for") {
      if (!uid || !this.ownedShopIds(uid).has(args["p_shop_id"] as string)) return json(null);
      const out: Record<string, { used: number; held: number }> = {};
      // 0059: coupon_stats_for は渡したキャンペーンの分だけ
      const only = fn === "coupon_stats_for" ? new Set(args["p_campaign_ids"] as string[]) : null;
      for (const r of this.tables.coupon_redemptions.filter((x) => x["shop_id"] === args["p_shop_id"] && (!only || only.has(String(x["campaign_id"]))))) {
        const s = (out[String(r["campaign_id"])] ??= { used: 0, held: 0 });
        if (r["status"] === "used") s.used++;
        if (r["status"] === "held") s.held++;
      }
      return json(out);
    }
    if (fn === "shop_oauth_client_save" || fn === "shop_oauth_client_delete") {
      const shopId = String(args["p_shop_id"]);
      if (!this.ownedShopIds(uid).has(shopId)) return json({ code: "42501", message: "shop_not_found" }, 403);
      const shop = this.tables.shops.find((x) => x["id"] === shopId)!;
      const settings = { ...((shop["settings"] ?? {}) as Row) };
      const oauth = { ...((settings["oauth"] ?? {}) as Row) };
      const provider = String(args["p_provider"]);
      const i = this.oauthClients.findIndex((x) => x["shop_id"] === shopId && x["provider"] === provider);
      if (fn === "shop_oauth_client_delete") {
        if (i >= 0) this.oauthClients.splice(i, 1);
        delete oauth[provider];
      } else {
        const clientId = String(args["p_client_id"] ?? "").trim();
        if (!clientId || /\s/.test(clientId)) return json({ code: "P0001", message: "invalid_client_id" }, 400);
        if (args["p_secret_box"] == null && i < 0) return json({ code: "P0001", message: "secret_required" }, 400);
        const row = { shop_id: shopId, provider, client_id: clientId, secret_box: args["p_secret_box"] ?? this.oauthClients[i]!["secret_box"] };
        if (i >= 0) this.oauthClients[i] = row;
        else this.oauthClients.push(row);
        oauth[provider] = { client_id: clientId };
      }
      settings["oauth"] = oauth;
      shop["settings"] = settings;
      return new Response(null, { status: 204 });
    }
    if (fn === "customer_marketing_consent_withdraw") {
      if (!this.ownedShopIds(uid).has(String(args["p_shop_id"]))) return json({ code: "42501", message: "shop_not_found" }, 403);
      const cur = this.tables.customers.find((c) => c["shop_id"] === args["p_shop_id"] && c["id"] === args["p_customer_id"]);
      if (!cur || cur["marketing_consent"] === false) return json(false);
      cur["marketing_consent"] = false; cur["marketing_consent_at"] = this.now(); cur["marketing_consent_source"] = "admin";
      return json(true);
    }
    if (fn === "member_passkeys_reset") {
      if (!this.ownedShopIds(uid).has(String(args["p_shop_id"]))) return json({ code: "42501", message: "forbidden" }, 403);
      const before = this.memberPasskeys.length;
      this.memberPasskeys.splice(0, this.memberPasskeys.length, ...this.memberPasskeys.filter((k) => !(k["shop_id"] === args["p_shop_id"] && k["customer_id"] === args["p_customer_id"])));
      return json(before - this.memberPasskeys.length);
    }
    // 0048: 運営者が会員の独自項目を直す（定義に無い鍵は断る。渡した鍵だけ重ね、null で消す）
    if (fn === "customer_set_attributes") {
      if (!this.ownedShopIds(uid).has(String(args["p_shop_id"]))) return json({ code: "42501", message: "shop_not_found" }, 403);
      const cur = this.tables.customers.find((c) => c["shop_id"] === args["p_shop_id"] && c["id"] === args["p_customer_id"]);
      if (!cur) return json({ code: "P0001", message: "customer_not_found" }, 400);
      const shopRow = this.tables.shops.find((x) => x["id"] === args["p_shop_id"]);
      const defs = ((shopRow?.["settings"] as Row | undefined)?.["customer_fields"] as Row[] | undefined) ?? [];
      const next = { ...((cur["attributes"] as Row | undefined) ?? {}) };
      for (const [k, v] of Object.entries((args["p_values"] ?? {}) as Row)) {
        const d = defs.find((x) => x["key"] === k);
        if (!d) return json({ code: "P0001", message: `invalid_attribute_${k}` }, 400);
        if (v === null) { delete next[k]; continue; }
        if (d["type"] === "select" && !((d["options"] as string[] | undefined) ?? []).includes(String(v))) return json({ code: "P0001", message: `invalid_attribute_${k}` }, 400);
        if (d["type"] === "number" && typeof v !== "number") return json({ code: "P0001", message: `invalid_attribute_${k}` }, 400);
        next[k] = v;
      }
      cur["attributes"] = next;
      cur["updated_at"] = this.now();
      return json(next);
    }
    if (fn === "member_set_email") {
      if (!this.ownedShopIds(uid).has(String(args["p_shop_id"]))) return json({ code: "42501", message: "shop_not_found" }, 403);
      const email = String(args["p_email"] ?? "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ code: "P0001", message: "invalid_email" }, 400);
      const cur = this.tables.customers.find((c) => c["shop_id"] === args["p_shop_id"] && c["id"] === args["p_customer_id"]);
      if (!cur) return json({ code: "P0001", message: "customer_not_found" }, 400);
      if (this.tables.customers.some((c) => c["shop_id"] === args["p_shop_id"] && c !== cur && String(c["email"] ?? "").toLowerCase() === email)) return json({ code: "P0001", message: "email_taken" }, 400);
      const old = cur["email"] ?? null;
      cur["email"] = email;
      cur["session_epoch"] = Number(cur["session_epoch"] ?? 0) + 1;
      return json({ old_email: old, new_email: email });
    }
    if (fn === "mask_customer") {
      if (!uid || !this.ownedShopIds(uid).has(args["p_shop_id"] as string)) return json({ code: "42501", message: "shop_not_found" }, 403);
      let n = 0;
      for (const o of this.tables.orders) {
        if (o["shop_id"] === args["p_shop_id"] && String(o["customer_email"] ?? "").toLowerCase() === String(args["p_email"]).toLowerCase()) {
          Object.assign(o, { customer_email: null, customer_name: "[masked]", shipping_address: null });
          n++;
        }
      }
      return json(n);
    }
    return json({ code: "PGRST202", message: `Could not find the function public.${fn}` }, 404);
  }

  /** 0024 の tryon_request の再現（在庫の条件付きの減算、全体の取り消し） */
  private tryonRequest(args: Row): Response {
    const shopId = args["p_shop_id"] as string;
    const fail = (message: string) => json({ code: "P0001", message }, 400);
    const link = this.tables.shop_stores.find((x) => x["store_id"] === args["p_store_id"] && x["shop_id"] === shopId && x["tryon"] !== false);
    const store = link && this.tables.stores.find((x) => x["id"] === link["store_id"] && x["active"] !== false);
    if (!store) return fail("store_not_available");
    const items = args["p_items"] as { sku_id: string; qty: number }[];
    const customer = args["p_customer"] as Row;
    if (!String(customer["customer_email"] ?? "").includes("@")) return fail("invalid_customer");
    for (const it of items) {
      const sku = this.tables.skus.find((k) => k["id"] === it.sku_id && k["shop_id"] === shopId);
      if (!sku || !this.productPublished(sku["product_id"])) return fail("sku_not_available");
      const inv = this.tables.inventory.find((i) => i["sku_id"] === it.sku_id)!;
      if (Number(inv["available"]) < it.qty) return fail("insufficient_stock");
    }
    const shop = this.tables.shops.find((x) => x["id"] === shopId)!;
    const number = Number(shop["tryon_seq"] ?? 0) + 1;
    shop["tryon_seq"] = number;
    const id = `tryon-${++this.seq}`;
    this.tables.tryon_requests.push({ id, shop_id: shopId, store_id: store["id"], number, status: "requested", visit_date: args["p_visit_date"] ?? null, hold_until: null, customer_id: customer["customer_id"] ?? null, customer_email: String(customer["customer_email"]).toLowerCase(), customer_name: customer["customer_name"] ?? null, customer_phone: customer["customer_phone"] ?? null, note: customer["note"] ?? null, restocked: false, created_at: this.now() });
    for (const it of items) {
      const inv = this.tables.inventory.find((i) => i["sku_id"] === it.sku_id)!;
      inv["available"] = Number(inv["available"]) - it.qty;
      this.tables.tryon_items.push({ id: `tryon-item-${++this.seq}`, shop_id: shopId, request_id: id, sku_id: it.sku_id, qty: it.qty, unit_price_jpy: this.tables.skus.find((k) => k["id"] === it.sku_id)!["price_jpy"] });
    }
    this.enqueue(shopId, "tryon.requested", { request_id: id, number, shop_id: shopId, store_id: store["id"], status: "requested", visit_date: args["p_visit_date"] ?? null, customer_id: customer["customer_id"] ?? null });
    return json({ id, number });
  }

  enqueue(shopId: string, event: string, payload: Row): number {
    let n = 0;
    for (const e of this.tables.hook_endpoints) {
      if (e["shop_id"] === shopId && e["enabled"] === true && (e["events"] as string[]).includes(event)) {
        this.tables.hook_deliveries.push({ id: `del-${++this.seq}`, shop_id: shopId, endpoint_id: e["id"], event, payload, status: "pending", attempts: 0, next_attempt_at: this.now(), last_status: null, last_error: null, created_at: this.now(), delivered_at: null });
        n++;
      }
    }
    return n;
  }

  /** 0028: 決済プラグイン（stripe / komoju）の、表示に要る設定だけ */
  paymentOptions(shopId: unknown): Row[] {
    const prefix = "https://banto.invalid/plugins/";
    return this.tables.hook_endpoints
      .filter((e) => e["shop_id"] === shopId && e["enabled"] === true && ["stripe", "komoju"].includes(String(e["url"]).slice(prefix.length)) && this.shopPublished(shopId))
      .map((e) => {
        const settings = (e["settings"] ?? {}) as Record<string, unknown>;
        const pick: Record<string, unknown> = {};
        for (const k of ["payment_types", "reservation_hours"]) if (k in settings) pick[k] = settings[k];
        return { id: String(e["url"]).slice(prefix.length), settings: pick };
      });
  }

  /** 0028 の banto_shop_public_json と同じ形（公開の settings だけ、Stripe の接続先は真偽値） */
  shopPublicJson(s: Row): Row {
    return {
      id: s["id"], slug: s["slug"], name: s["name"], published: s["published"],
      legal_notice: s["legal_notice"] ?? null, privacy_policy: s["privacy_policy"] ?? null, return_policy: s["return_policy"] ?? null,
      domain: s["domain"] ?? null, stripe_connected: Boolean(s["stripe_account_id"]),
      settings: publicShopSettings((s["settings"] ?? {}) as Record<string, unknown>),
    };
  }

  private shopPublicGet(args: Record<string, unknown>): Row | null {
    const s = this.tables.shops.find((x) => x["published"] === true && ((args["p_slug"] != null && x["slug"] === args["p_slug"]) || (args["p_domain"] != null && x["domain"] === args["p_domain"])));
    return s ? this.shopPublicJson(s) : null;
  }

  salesSummary(shopId: string, from: string, to: string, groupBy: string): Row {
    const orders = this.tables.orders.filter((o) => o["shop_id"] === shopId && ["paid", "shipped"].includes(String(o["status"])) && String(o["created_at"]) >= from && String(o["created_at"]) < to);
    const items = this.tables.order_items.filter((i) => orders.some((o) => o["id"] === i["order_id"]));
    const revenue = orders.reduce((n, o) => n + Number(o["total_jpy"]), 0);
    const rows: Row[] = groupBy === "product"
      ? [...new Set(items.map((i) => String(i["sku_id"])))].map((sku) => ({ sku_code: this.tables.skus.find((k) => k["id"] === sku)?.["code"] ?? null, qty: items.filter((i) => i["sku_id"] === sku).reduce((n, i) => n + Number(i["qty"]), 0), revenue_jpy: items.filter((i) => i["sku_id"] === sku).reduce((n, i) => n + Number(i["qty"]) * Number(i["unit_price_jpy"]), 0) }))
      : orders.length ? [{ period: String(orders[0]!["created_at"]).slice(0, groupBy === "day" ? 10 : 7), orders: orders.length, revenue_jpy: revenue }] : [];
    return { from, to, group_by: groupBy, timezone: "Asia/Tokyo", total: { orders: orders.length, revenue_jpy: revenue, items: items.reduce((n, i) => n + Number(i["qty"]), 0), avg_order_jpy: orders.length ? Math.round(revenue / orders.length) : 0 }, rows };
  }

  /** api_*: トークン検証 → shop 限定。本物の SQL は test/db/api.test.ts で検証 */
  private apiRpc(fn: string, args: Record<string, unknown>): Response {
    const hash = args["p_token_hash"];
    const tok = this.tables.api_tokens.find((t) => t["token_hash"] === hash && t["revoked_at"] == null && (t["expires_at"] == null || String(t["expires_at"]) > new Date().toISOString()));
    const unauthorized = () => json({ code: "42501", message: "unauthorized" }, 403);
    const notFound = () => json({ code: "P0001", message: "not_found" }, 400);
    // 本物と同じく、無効なトークンでも例外にせず false
    if (fn === "api_has_scope") return json(Boolean(tok && (tok["scopes"] as string[]).includes(args["p_scope"] as string)));
    if (!tok) return unauthorized();
    const scopes = tok["scopes"] as string[];
    const need = (s: string) => scopes.includes(s);
    const shopId = tok["shop_id"] as string;
    if (tok["last_used_at"] === null) tok["last_used_at"] = this.now();
    const product = (p: Row): Row => ({
      id: p["id"], slug: p["slug"], name: p["name"], description: p["description"] ?? null, tags: p["tags"] ?? [], brand: p["brand"] ?? null, attributes: p["attributes"] ?? {},
      category: (() => { const c = this.tables.categories.find((x) => x["id"] === p["category_id"]); return c ? { id: c["id"], slug: c["slug"], name: c["name"], parent_id: c["parent_id"] ?? null, sort_order: c["sort_order"] ?? 0 } : null; })(),
      extra_categories: ((p["extra_category_ids"] ?? []) as string[]).flatMap((id) => this.tables.categories.filter((c) => c["id"] === id).map((c) => ({ id: c["id"], slug: c["slug"], name: c["name"], parent_id: c["parent_id"] ?? null, sort_order: c["sort_order"] ?? 0 }))),
      published: p["published"], created_at: p["created_at"], updated_at: p["updated_at"],
      images: this.tables.product_images.filter((i) => i["product_id"] === p["id"]).map((i) => ({ id: i["id"], storage_key: i["storage_key"], thumb_key: i["thumb_key"] ?? null, width: i["width"] ?? null, height: i["height"] ?? null, sort_order: i["sort_order"] })),
      skus: this.tables.skus.filter((k) => k["product_id"] === p["id"]).map((k) => ({ id: k["id"], code: k["code"], name: k["name"] ?? null, price_jpy: k["price_jpy"], compare_at_price_jpy: k["compare_at_price_jpy"] ?? null, options: k["options"] ?? {}, gtin: k["gtin"] ?? null, available: this.tables.inventory.find((i) => i["sku_id"] === k["id"])?.["available"] ?? 0 })),
    });
    const order = (o: Row, pii: boolean): Row => ({
      id: o["id"], number: o["number"] ?? null, status: o["status"], total_jpy: o["total_jpy"], shipping_jpy: o["shipping_jpy"] ?? 0, customer_id: o["customer_id"] ?? null, payment_provider: o["payment_provider"] ?? null, payment_ref: o["payment_ref"] ?? null, shipped_at: o["shipped_at"] ?? null, created_at: o["created_at"], updated_at: o["updated_at"],
      customer: pii ? { email: o["customer_email"] ?? null, name: o["customer_name"] ?? null, shipping_address: o["shipping_address"] ?? null } : { masked: true, prefecture: (o["shipping_address"] as Row | null)?.["state"] ?? null },
      items: this.tables.order_items.filter((i) => i["order_id"] === o["id"]).map((i) => ({ sku_id: i["sku_id"], qty: i["qty"], unit_price_jpy: i["unit_price_jpy"] })),
    });
    const mine = (p: Row | undefined) => (p && p["shop_id"] === shopId ? p : undefined);

    // 0036: クーポンと会員（スコープとショップの限定だけ再現。値の検査・個人情報の列は test/db/api-coupons-customers.test.ts）
    const coupon = (c: Row): Row => ({ ...c, usage: { used: 0, held: 0 }, grants: { available: 0, held: 0, used: 0, revoked: 0 } });
    const member = (c: Row): Row => ({ id: c["id"], email: c["email"] ?? null, name: c["name"] ?? null, default_address: c["default_address"] ?? null, external_ref: c["external_ref"] ?? null, attributes: c["attributes"] ?? {}, marketing_consent: c["marketing_consent"] ?? null, marketing_consent_at: c["marketing_consent_at"] ?? null, marketing_consent_source: c["marketing_consent_source"] ?? null, created_at: c["created_at"] ?? null, updated_at: c["updated_at"] ?? null, last_login_at: c["last_login_at"] ?? null, orders: { count: 0, total_jpy: 0, last_order_at: null } });
    const page = (items: Row[]) => ({ items: items.slice(Number(args["p_offset"] ?? 0), Number(args["p_offset"] ?? 0) + Number(args["p_limit"] ?? 50)), total: items.length, limit: args["p_limit"], offset: args["p_offset"] });
    if (fn.startsWith("api_coupon")) {
      if (!need(/create|update|delete|issue|revoke/.test(fn) ? "coupons:write" : "coupons:read")) return unauthorized();
      const shop = this.tables.shops.find((x) => x["id"] === shopId);
      if (((shop?.["settings"] as Row | undefined)?.["modules"] as Row | undefined)?.["coupons"] !== true) return json({ code: "P0001", message: "module_disabled" }, 400);
      const camps = this.tables.coupon_campaigns.filter((c) => c["shop_id"] === shopId);
      const values = (args["p_values"] ?? {}) as Row;
      switch (fn) {
        case "api_coupons_list": return json(page(camps.map(coupon)));
        case "api_coupon_get": {
          const c = camps.find((x) => (args["p_campaign_id"] ? x["id"] === args["p_campaign_id"] : x["code"] === String(args["p_code"] ?? "").toUpperCase()));
          return c ? json(coupon(c)) : notFound();
        }
        case "api_coupon_create": {
          const code = typeof values["code"] === "string" ? values["code"].toUpperCase() : null;
          if (code && camps.some((x) => x["code"] === code)) return json({ code: "23505", message: "duplicate key value violates unique constraint" }, 409);
          const row: Row = { id: crypto.randomUUID(), shop_id: shopId, active: true, conditions: {}, ...values, code };
          this.tables.coupon_campaigns.push(row);
          return json(coupon(row));
        }
        case "api_coupon_update": {
          const c = camps.find((x) => x["id"] === args["p_campaign_id"]);
          if (!c) return notFound();
          Object.assign(c, values);
          return json(coupon(c));
        }
        case "api_coupon_delete": {
          const c = camps.find((x) => x["id"] === args["p_campaign_id"]);
          if (!c) return notFound();
          if (this.tables.coupon_redemptions.some((r) => r["campaign_id"] === c["id"] && r["status"] !== "released")) return json({ code: "P0001", message: "coupon_in_use" }, 400);
          this.tables.coupon_campaigns = this.tables.coupon_campaigns.filter((x) => x !== c);
          return json({ deleted: true, id: c["id"] });
        }
        case "api_coupon_grants_list": {
          if (!camps.some((x) => x["id"] === args["p_campaign_id"])) return notFound();
          return json(page(this.tables.coupon_grants.filter((g) => g["campaign_id"] === args["p_campaign_id"])));
        }
        case "api_coupon_grants_issue": {
          if (!camps.some((x) => x["id"] === args["p_campaign_id"])) return notFound();
          const ids = ((args["p_customer_ids"] ?? []) as string[]).filter((id) => this.tables.customers.some((c) => c["shop_id"] === shopId && c["id"] === id));
          const grants = [...ids.map((id) => ({ customer_id: id })), ...Array.from({ length: Number(args["p_count"] ?? 0) }, () => ({ customer_id: null }))].map((g, i) => {
            const row: Row = { id: crypto.randomUUID(), shop_id: shopId, campaign_id: args["p_campaign_id"], code: `G${this.tables.coupon_grants.length + i + 1}`, status: "available", expires_at: null, ...g };
            return row;
          });
          this.tables.coupon_grants.push(...grants);
          return json({ issued: grants.length, skipped: ((args["p_customer_ids"] ?? []) as string[]).length - ids.length, grants });
        }
        case "api_coupon_grant_revoke": {
          const g = this.tables.coupon_grants.find((x) => x["shop_id"] === shopId && x["id"] === args["p_grant_id"]);
          if (!g) return notFound();
          g["status"] = "revoked";
          return json({ id: g["id"], status: "revoked" });
        }
      }
    }
    if (fn.startsWith("api_customer")) {
      if (!need(/create|update|delete|upsert/.test(fn) ? "customers:write" : "customers:read")) return unauthorized();
      const members = this.tables.customers.filter((c) => c["shop_id"] === shopId);
      const values = (args["p_values"] ?? {}) as Row;
      // 0047: 独自項目（定義に無い鍵は断る）と外部の ID（形と一意）。値の検査の本体は test/db/customer-master.test.ts
      const shopRow = this.tables.shops.find((x) => x["id"] === shopId);
      const defs = ((shopRow?.["settings"] as Row | undefined)?.["customer_fields"] as Row[] | undefined) ?? [];
      const applyMaster = (row: Row, v: Row): Response | null => {
        if ("attributes" in v) {
          const a = (v["attributes"] ?? {}) as Row;
          const cur = { ...((row["attributes"] as Row | undefined) ?? {}) };
          for (const [k, val] of Object.entries(a)) {
            if (!defs.some((d) => d["key"] === k)) return json({ code: "P0001", message: `invalid_attribute_${k}` }, 400);
            if (val === null) delete cur[k];
            else cur[k] = val;
          }
          row["attributes"] = cur;
        }
        // 0050: 案内メールの同意は false（取り下げ）だけ
        if ("marketing_consent" in v) {
          if (v["marketing_consent"] === true) return json({ code: "P0001", message: "consent_requires_person" }, 400);
          if (v["marketing_consent"] !== false) return json({ code: "P0001", message: "invalid_marketing_consent" }, 400);
          if (row["marketing_consent"] !== false) { row["marketing_consent"] = false; row["marketing_consent_at"] = this.now(); row["marketing_consent_source"] = "api"; }
        }
        if ("external_ref" in v) {
          const r = v["external_ref"] as Row | null;
          if (r !== null && (typeof r !== "object" || typeof r["provider"] !== "string" || typeof r["id"] !== "string")) return json({ code: "P0001", message: "invalid_external_ref" }, 400);
          if (r && members.some((c) => c !== row && (c["external_ref"] as Row | undefined)?.["provider"] === r["provider"] && (c["external_ref"] as Row | undefined)?.["id"] === r["id"])) return json({ code: "P0001", message: "external_ref_taken" }, 400);
          row["external_ref"] = r;
        }
        return null;
      };
      switch (fn) {
        case "api_customers_list": {
          const email = typeof args["p_email"] === "string" ? args["p_email"].toLowerCase() : null;
          const prov = typeof args["p_external_provider"] === "string" ? args["p_external_provider"] : null;
          const ext = typeof args["p_external_id"] === "string" ? args["p_external_id"] : null;
          const since = typeof args["p_updated_since"] === "string" ? Date.parse(args["p_updated_since"]) : null;
          const consent = typeof args["p_marketing_consent"] === "boolean" ? args["p_marketing_consent"] : null;
          const hit = members.filter((c) => (!email || String(c["email"]).toLowerCase() === email)
            && (consent === null || c["marketing_consent"] === consent)
            && (!prov || (c["external_ref"] as Row | undefined)?.["provider"] === prov)
            && (!ext || (c["external_ref"] as Row | undefined)?.["id"] === ext)
            && (since === null || Date.parse(String(c["updated_at"] ?? c["created_at"] ?? 0)) >= since));
          return json(page(hit.map(member)));
        }
        case "api_customer_upsert": {
          const email = String(values["email"] ?? "").trim().toLowerCase();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ code: "P0001", message: "invalid_email" }, 400);
          const cur = members.find((c) => String(c["email"]).toLowerCase() === email);
          if (cur) {
            const { email: _e, ...rest } = values;
            void _e;
            if ("name" in rest) cur["name"] = rest["name"] ?? null;
            if ("default_address" in rest) cur["default_address"] = rest["default_address"] ?? null;
            const err = applyMaster(cur, rest);
            if (err) return err;
            cur["updated_at"] = this.now();
            return json({ ...member(cur), created: false });
          }
          const row: Row = { id: crypto.randomUUID(), shop_id: shopId, email, name: values["name"] ?? null, default_address: values["default_address"] ?? null, attributes: {}, external_ref: null, created_at: this.now(), updated_at: this.now() };
          const err = applyMaster(row, values);
          if (err) return err;
          this.tables.customers.push(row);
          return json({ ...member(row), created: true });
        }
        case "api_customer_get": {
          const c = members.find((x) => x["id"] === args["p_customer_id"]);
          return c ? json(member(c)) : notFound();
        }
        case "api_customer_create": {
          const email = String(values["email"] ?? "").trim().toLowerCase();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ code: "P0001", message: "invalid_email" }, 400);
          if (members.some((c) => String(c["email"]).toLowerCase() === email)) return json({ code: "P0001", message: "email_taken" }, 400);
          const limitHit = this.planLimitHit("customers");
          if (limitHit) return limitHit;
          const row: Row = { id: crypto.randomUUID(), shop_id: shopId, email, name: values["name"] ?? null, default_address: values["default_address"] ?? null, attributes: {}, external_ref: null, created_at: this.now(), updated_at: this.now() };
          const err = applyMaster(row, values);
          if (err) return err;
          this.tables.customers.push(row);
          return json(member(row));
        }
        case "api_customer_update": {
          if ("email" in values) return json({ code: "P0001", message: "email_change_not_allowed" }, 400);
          const c = members.find((x) => x["id"] === args["p_customer_id"]);
          if (!c) return notFound();
          const { attributes: _a, external_ref: _r, marketing_consent: _m, ...plain } = values;
          void _a; void _r; void _m;
          Object.assign(c, plain);
          const err = applyMaster(c, values);
          if (err) return err;
          c["updated_at"] = this.now();
          return json(member(c));
        }
        case "api_customer_delete": {
          const c = members.find((x) => x["id"] === args["p_customer_id"]);
          if (!c) return notFound();
          this.tables.customers = this.tables.customers.filter((x) => x !== c);
          return json({ deleted: true, id: c["id"] });
        }
      }
    }

    switch (fn) {
      case "api_tryon_requests_list":
      case "api_tryon_request_get":
      case "api_tryon_request_update":
      case "api_tryon_request_restock": {
        // 0026 の再現（遷移の中身は test/db/tryon-api.test.ts）
        if (!need(fn === "api_tryon_request_update" || fn === "api_tryon_request_restock" ? "orders:write" : "orders:read")) return unauthorized();
        const pii = need("orders:pii");
        const view = (r: Row): Row => ({
          id: r["id"], number: r["number"], status: r["status"], store_id: r["store_id"], store_name: this.tables.stores.find((x) => x["id"] === r["store_id"])?.["name"] ?? null,
          visit_date: r["visit_date"] ?? null, hold_until: r["hold_until"] ?? null, customer_id: r["customer_id"] ?? null, restocked: r["restocked"] ?? false, created_at: r["created_at"],
          items: this.tables.tryon_items.filter((i) => i["request_id"] === r["id"]).map((i) => ({ sku_id: i["sku_id"], qty: i["qty"], unit_price_jpy: i["unit_price_jpy"] })),
          ...(pii ? { customer: { email: r["customer_email"] ?? null, name: r["customer_name"] ?? null, phone: r["customer_phone"] ?? null, note: r["note"] ?? null } } : {}),
        });
        const rows = this.tables.tryon_requests.filter((r) => r["shop_id"] === shopId);
        if (fn === "api_tryon_requests_list") {
          const hit = rows.filter((r) => (args["p_status"] == null || r["status"] === args["p_status"]) && (args["p_store_id"] == null || r["store_id"] === args["p_store_id"])).reverse();
          return json({ items: hit.map(view), total: hit.length, limit: 50, offset: 0, pii });
        }
        const r = rows.find((x) => x["number"] === Number(args["p_number"]));
        if (!r) return notFound();
        if (fn === "api_tryon_request_get") return json(view(r));
        if (fn === "api_tryon_request_restock") {
          if (!["not_purchased", "expired", "cancelled"].includes(String(r["status"]))) return json({ code: "P0001", message: "not_restockable" }, 400);
          let n = 0;
          if (!r["restocked"]) {
            for (const it of this.tables.tryon_items.filter((x) => x["request_id"] === r["id"])) {
              const inv = this.tables.inventory.find((i) => i["sku_id"] === it["sku_id"]);
              if (inv) (inv["available"] = Number(inv["available"]) + Number(it["qty"])), n++;
            }
            r["restocked"] = true;
          }
          return json({ ...view(r), restocked_skus: n });
        }
        const status = String(args["p_status"]);
        const allowed: Record<string, string[]> = { sent: ["requested"], ready: ["requested", "sent", "ready"], purchased: ["ready", "expired"], not_purchased: ["ready", "expired"], cancelled: ["requested", "sent", "ready"] };
        if (!(allowed[status] ?? []).includes(String(r["status"]))) return json({ code: "P0001", message: "invalid_transition" }, 400);
        Object.assign(r, { status, hold_until: status === "ready" ? args["p_hold_until"] : r["hold_until"] });
        this.enqueue(shopId, "tryon.updated", { request_id: r["id"], number: r["number"], shop_id: shopId, store_id: r["store_id"], status, hold_until: r["hold_until"] ?? null, customer_id: r["customer_id"] ?? null });
        return json(view(r));
      }
      case "api_stores_list":
        if (!need("shop:read")) return unauthorized();
        return json(this.tables.shop_stores.filter((l) => l["shop_id"] === shopId).map((l) => ({ ...this.tables.stores.find((x) => x["id"] === l["store_id"]), tryon: l["tryon"], sort_order: l["sort_order"] })));
      case "api_token_shop": return json({ shop_id: shopId, scopes, name: tok["name"], stripe_account_id: this.tables.shops.find((x) => x["id"] === shopId)?.["stripe_account_id"] ?? null });
      case "api_shop_get": {
        if (!need("shop:read")) return unauthorized();
        const sh = this.tables.shops.find((x) => x["id"] === shopId)!;
        const terms = ((sh["settings"] as Row | undefined)?.["checkout_terms"] ?? {}) as Row;
        const term = (k: string) => (typeof terms[k] === "string" && (terms[k] as string).trim() ? (terms[k] as string).trim() : null);
        const checkoutTerms = this.appliedMigrations.includes("0032_api_checkout_terms") ? { checkout_terms: { delivery: term("delivery"), cancellation: term("cancellation"), payment_note: term("payment_note") } } : {};
        const lim = (section: string, key: string, dflt: number) => {
          const v = String(((sh["settings"] as Row | undefined)?.[section] as Row | undefined)?.[key] ?? "");
          return /^[0-9]{1,4}$/.test(v) ? Number(v) : dflt;
        };
        // 0033 より前の DB は IP ごとの上限を返さない（本物と同じ）
        const ipLimits = this.appliedMigrations.includes("0033_relay_limits") ? { max_pending_per_ip: lim("checkout", "max_pending_per_ip", 20), login_per_ip_per_hour: lim("members_login_limits", "per_ip_per_hour", 30) } : {};
        return json({ id: sh["id"], slug: sh["slug"], name: sh["name"], published: sh["published"], legal_notice: sh["legal_notice"], privacy_policy: sh["privacy_policy"], return_policy: sh["return_policy"], ...checkoutTerms, low_stock_threshold: 3, ...ipLimits, stripe_connected: Boolean(sh["stripe_account_id"]) });
      }
      case "api_shop_update": {
        if (!need("shop:write")) return unauthorized();
        const sh = this.tables.shops.find((x) => x["id"] === shopId)!;
        const v = args["p_values"] as Row;
        if (v["published"] === true && !(sh["legal_notice"] || v["legal_notice"])) return json({ code: "23514", message: 'violates check constraint "shops_publish_requires_legal"' }, 400);
        for (const k of ["name", "legal_notice", "privacy_policy", "return_policy", "published"]) if (v[k] !== undefined) sh[k] = v[k];
        // 0032 より前の DB は checkout_terms を黙って捨てる（本物と同じ）
        if (v["checkout_terms"] !== undefined && this.appliedMigrations.includes("0032_api_checkout_terms")) {
          const inTerms = v["checkout_terms"] as Row;
          const settings = (sh["settings"] ?? {}) as Row;
          const terms = { ...((settings["checkout_terms"] ?? {}) as Row) };
          for (const k of ["delivery", "cancellation", "payment_note"]) {
            if (!(k in inTerms)) continue;
            const x = inTerms[k];
            if (x !== null && typeof x !== "string") return json({ code: "P0001", message: "invalid_checkout_terms" }, 400);
            const val = (x ?? "").replace(/\r\n/g, "\n").trim();
            if (val.length > 2000) return json({ code: "P0001", message: "invalid_checkout_terms" }, 400);
            terms[k] = val;
          }
          sh["settings"] = { ...settings, checkout_terms: terms };
        }
        // 0033: IP ごとの上限（1〜9999）。0033 より前の DB は黙って捨てる（本物と同じ）
        for (const [k, section, key] of [["max_pending_per_ip", "checkout", "max_pending_per_ip"], ["login_per_ip_per_hour", "members_login_limits", "per_ip_per_hour"]] as const) {
          if (v[k] === undefined || !this.appliedMigrations.includes("0033_relay_limits")) continue;
          const n = Number(v[k]);
          if (!Number.isInteger(n) || n < 1 || n > 9999) return json({ code: "P0001", message: `invalid_${k}` }, 400);
          const settings = { ...((sh["settings"] ?? {}) as Row) };
          settings[section] = { ...((settings[section] ?? {}) as Row), [key]: n };
          sh["settings"] = settings;
        }
        return this.apiRpc("api_shop_get", args);
      }
      case "api_products_list": {
        if (!need("products:read")) return unauthorized();
        const q = args["p_query"] as string | null;
        const all = this.tables.products.filter((p) => p["shop_id"] === shopId && (args["p_published"] == null || p["published"] === args["p_published"]) && (!q || String(p["name"]).includes(q) || String(p["slug"]).includes(q)));
        const limit = Math.min(Number(args["p_limit"] ?? 50), 100);
        const offset = Number(args["p_offset"] ?? 0);
        return json({ items: all.slice(offset, offset + limit).map(product), total: all.length, limit, offset });
      }
      case "api_product_get": {
        if (!need("products:read")) return unauthorized();
        const p = mine(this.tables.products.find((x) => (args["p_product_id"] && x["id"] === args["p_product_id"]) || (!args["p_product_id"] && x["slug"] === args["p_slug"])));
        return p ? json(product(p)) : notFound();
      }
      case "api_product_create": {
        if (!need("products:write")) return unauthorized();
        const v = args["p_values"] as Row;
        if (this.tables.products.some((p) => p["shop_id"] === shopId && p["slug"] === v["slug"])) return json({ code: "23505", message: "duplicate key value violates unique constraint" }, 409);
        const cat = this.categoryRef(shopId, v["category"]);
        if (cat === false) return json({ code: "P0001", message: "category_not_found" }, 400);
        const extra = this.categoryRefs(shopId, v["extra_categories"]);
        if (extra === false) return json({ code: "P0001", message: "category_not_found" }, 400);
        const p = this.addProduct(shopId, { slug: v["slug"], name: v["name"], description: v["description"] ?? null, tags: normalizeTags(v["tags"]), brand: v["brand"] || null, attributes: (v["attributes"] as Row) ?? {}, category_id: cat, extra_category_ids: extra.filter((id) => id !== cat), published: v["published"] ?? false });
        this.enqueue(shopId, "product.updated", { product_id: p.id });
        return json(product(p));
      }
      case "api_product_update": {
        if (!need("products:write")) return unauthorized();
        const p = mine(this.tables.products.find((x) => x["id"] === args["p_product_id"]));
        if (!p) return notFound();
        const v = args["p_values"] as Row;
        for (const k of ["slug", "name", "description", "published"]) if (v[k] !== undefined) p[k] = v[k];
        if (v["tags"] !== undefined) p["tags"] = normalizeTags(v["tags"]);
        if (v["brand"] !== undefined) p["brand"] = v["brand"] || null;
        if (v["attributes"] !== undefined) p["attributes"] = v["attributes"];
        if (v["category"] !== undefined) {
          const cat = this.categoryRef(shopId, v["category"]);
          if (cat === false) return json({ code: "P0001", message: "category_not_found" }, 400);
          p["category_id"] = cat;
        }
        if (v["extra_categories"] !== undefined) {
          const extra = this.categoryRefs(shopId, v["extra_categories"]);
          if (extra === false) return json({ code: "P0001", message: "category_not_found" }, 400);
          p["extra_category_ids"] = extra.filter((id) => id !== p["category_id"]);
        }
        this.enqueue(shopId, "product.updated", { product_id: p["id"] });
        return json(product(p));
      }
      case "api_sku_create": {
        if (!need("products:write")) return unauthorized();
        const p = mine(this.tables.products.find((x) => x["id"] === args["p_product_id"]));
        if (!p) return notFound();
        const v = args["p_values"] as Row;
        if (this.tables.skus.some((k) => k["shop_id"] === shopId && k["code"] === v["code"])) return json({ code: "23505", message: "duplicate key value violates unique constraint" }, 409);
        this.addSku(shopId, p["id"] as string, { code: v["code"], name: v["name"] ?? null, price_jpy: v["price_jpy"], options: (v["options"] as Row) ?? {}, gtin: v["gtin"] ?? null, compare_at_price_jpy: v["compare_at_price_jpy"] ?? null, available: Number(v["available"] ?? 0) });
        return json(product(p));
      }
      case "api_sku_update": {
        if (!need("products:write")) return unauthorized();
        const k = mine(this.tables.skus.find((x) => x["id"] === args["p_sku_id"]));
        if (!k) return notFound();
        const v = args["p_values"] as Row;
        for (const key of ["code", "name", "price_jpy", "options", "gtin", "compare_at_price_jpy"]) if (v[key] !== undefined) k[key] = v[key];
        if (v["available"] !== undefined) {
          if (Number(v["available"]) < 0) return json({ code: "P0001", message: "invalid_available" }, 400);
          this.tables.inventory.find((i) => i["sku_id"] === k["id"])!["available"] = v["available"];
        }
        return json(product(this.tables.products.find((x) => x["id"] === k["product_id"])!));
      }
      case "api_categories_list": {
        if (!need("products:read")) return unauthorized();
        return json(this.tables.categories.filter((c) => c["shop_id"] === shopId).map((c) => ({ id: c["id"], slug: c["slug"], name: c["name"], parent_id: c["parent_id"] ?? null, sort_order: c["sort_order"] ?? 0 })));
      }
      case "api_category_save": {
        if (!need("products:write")) return unauthorized();
        const v = args["p_values"] as Row;
        const parent = this.categoryRef(shopId, v["parent"]);
        if (parent === false) return json({ code: "P0001", message: "category_not_found" }, 400);
        let c = this.tables.categories.find((x) => x["shop_id"] === shopId && x["slug"] === v["slug"]);
        if (!c) c = this.addCategory(shopId, { slug: v["slug"], name: v["name"] });
        if (v["name"]) c["name"] = v["name"];
        if (v["parent"] !== undefined) c["parent_id"] = parent;
        if (v["sort_order"] !== undefined) c["sort_order"] = v["sort_order"];
        return json({ id: c["id"], slug: c["slug"], name: c["name"], parent_id: c["parent_id"] ?? null, sort_order: c["sort_order"] ?? 0 });
      }
      case "api_sku_delete": {
        if (!need("products:write")) return unauthorized();
        const k = mine(this.tables.skus.find((x) => x["id"] === args["p_sku_id"]));
        if (!k) return notFound();
        this.cascadeDelete("skus", k);
        return json(product(this.tables.products.find((x) => x["id"] === k["product_id"])!));
      }
      case "api_image_add": {
        if (!need("products:write")) return unauthorized();
        const p = mine(this.tables.products.find((x) => x["id"] === args["p_product_id"]));
        if (!p) return notFound();
        if (!String(args["p_storage_key"]).startsWith(`shops/${shopId}/`)) return json({ code: "P0001", message: "invalid_storage_key" }, 400);
        this.tables.product_images.push({ id: `img-${++this.seq}`, shop_id: shopId, product_id: p["id"], storage_key: args["p_storage_key"], thumb_key: null, width: null, height: null, sort_order: this.tables.product_images.filter((i) => i["product_id"] === p["id"]).length, created_at: this.now() });
        return json(product(p));
      }
      case "api_image_add_file": {
        // 0037: キーの形の検査は test/db/api-image-upload.test.ts（本物の SQL）
        if (!need("products:write")) return unauthorized();
        const p = mine(this.tables.products.find((x) => x["id"] === args["p_product_id"]));
        if (!p) return notFound();
        if (!String(args["p_storage_key"]).startsWith(`shops/${shopId}/products/${p["id"]}/`)) return json({ code: "P0001", message: "invalid_storage_key" }, 400);
        const id = `img-${++this.seq}`;
        this.tables.product_images.push({ id, shop_id: shopId, product_id: p["id"], storage_key: args["p_storage_key"], thumb_key: args["p_thumb_key"] ?? null, width: args["p_width"] ?? null, height: args["p_height"] ?? null, sort_order: this.tables.product_images.filter((i) => i["product_id"] === p["id"]).length, created_at: this.now() });
        return json({ image_id: id, product: product(p) });
      }
      case "api_image_delete": {
        if (!need("products:write")) return unauthorized();
        const i = mine(this.tables.product_images.find((x) => x["id"] === args["p_image_id"]));
        if (!i) return notFound();
        this.tables.product_images = this.tables.product_images.filter((x) => x !== i);
        return json({ storage_key: i["storage_key"], thumb_key: i["thumb_key"] ?? null });
      }
      case "api_order_payment_info": {
        if (!need("orders:write")) return unauthorized();
        const o = mine(this.tables.orders.find((x) => x["id"] === args["p_order_id"]));
        return o ? json({ order_id: o["id"], status: o["status"], payment_provider: o["payment_provider"] ?? null, payment_ref: o["payment_ref"] ?? null, total_jpy: o["total_jpy"] }) : notFound();
      }
      case "api_order_cancel": {
        if (!need("orders:write")) return unauthorized();
        if (!mine(this.tables.orders.find((x) => x["id"] === args["p_order_id"]))) return notFound();
        const r = this.cancelOrder(args["p_order_id"], shopId, args["p_refunded"] === true);
        if (r.status !== 200) return r;
        return json(order(this.tables.orders.find((x) => x["id"] === args["p_order_id"])!, need("orders:pii")));
      }
      case "api_orders_list": {
        if (!need("orders:read")) return unauthorized();
        const q = args["p_query"] as string | null;
        const all = this.tables.orders.filter((o) => o["shop_id"] === shopId && (args["p_status"] == null || o["status"] === args["p_status"]) && (!q || String(o["number"]) === q || (need("orders:pii") && (String(o["customer_email"] ?? "").includes(q) || String(o["customer_name"] ?? "").includes(q)))));
        return json({ items: all.map((o) => order(o, need("orders:pii"))), total: all.length, limit: 50, offset: 0, pii: need("orders:pii") });
      }
      case "api_order_get": {
        if (!need("orders:read")) return unauthorized();
        const o = mine(this.tables.orders.find((x) => x["id"] === args["p_order_id"]));
        return o ? json(order(o, need("orders:pii"))) : notFound();
      }
      case "api_order_update_status": {
        if (!need("orders:write")) return unauthorized();
        if (args["p_status"] !== "shipped") return json({ code: "P0001", message: "invalid_status" }, 400);
        const o = mine(this.tables.orders.find((x) => x["id"] === args["p_order_id"] && x["status"] === "paid"));
        if (!o) return notFound();
        o["status"] = args["p_status"];
        if (args["p_status"] === "shipped") o["shipped_at"] = this.now();
        this.enqueue(shopId, `order.${String(args["p_status"])}`, { order_id: o["id"] });
        return json(order(o, need("orders:pii")));
      }
      case "api_sales_summary": {
        if (!need("stats:read")) return unauthorized();
        if (!["day", "month", "product"].includes(String(args["p_group_by"]))) return json({ code: "P0001", message: "invalid_group_by" }, 400);
        return json(this.salesSummary(shopId, String(args["p_from"]), String(args["p_to"]), String(args["p_group_by"])));
      }
      case "api_inventory_low": {
        if (!need("stats:read")) return unauthorized();
        const th = Number(args["p_threshold"] ?? 3);
        return json(this.tables.inventory.filter((i) => i["shop_id"] === shopId && Number(i["available"]) <= th).map((i) => { const k = this.tables.skus.find((x) => x["id"] === i["sku_id"])!; return { sku_id: k["id"], sku_code: k["code"], available: i["available"] }; }));
      }
      default:
        return json({ code: "PGRST202", message: `Could not find the function public.${fn}` }, 404);
    }
  }

  orderItemsJson(orderId: unknown): Row[] {
    return this.tables.order_items.filter((i) => i["order_id"] === orderId).map((i) => {
      const k = this.tables.skus.find((x) => x["id"] === i["sku_id"]);
      const p = this.tables.products.find((x) => x["id"] === k?.["product_id"]);
      const rate = i["tax_rate"] ?? null;
      return { name: p?.["name"] ?? null, sku: k?.["name"] ?? k?.["code"] ?? null, qty: i["qty"], unit_price_jpy: i["unit_price_jpy"], tax_rate: rate, discount_jpy: i["discount_jpy"] ?? 0 };
    });
  }

  /** 0017 のトリガーの再現: SKU の商品の区分とショップの設定から税率 */
  taxRateOf(item: Row): number {
    const k = this.tables.skus.find((x) => x["id"] === item["sku_id"]);
    const p = this.tables.products.find((x) => x["id"] === k?.["product_id"]);
    const settings = (this.tables.shops.find((s) => s["id"] === item["shop_id"])?.["settings"] ?? {}) as Row;
    const cls = String(p?.["tax_class"] ?? "standard");
    return cls === "exempt" ? 0 : cls === "reduced" ? Number(settings["tax_rate_reduced"] ?? 8) : Number(settings["tax_rate"] ?? 10);
  }

  /** 0045 の banto_member_session_live: 取り消されていない・期限内・世代が今と同じ */
  private liveMemberSession(shopId: unknown, customerId: unknown, epoch: unknown, sessionId: unknown, now: number): Row | null {
    const c = this.tables.customers.find((x) => x["id"] === customerId && x["shop_id"] === shopId);
    const ms = this.memberSessions.find((x) => x["id"] === sessionId && x["shop_id"] === shopId && x["customer_id"] === customerId);
    if (!c || !ms || Number(c["session_epoch"] ?? 0) !== epoch || ms["session_epoch"] !== epoch || ms["revoked_at"] || Number(ms["expires_at"]) <= now) return null;
    return ms;
  }

  /** lookup_order・member_order（0017）の形 */
  orderJson(o: Row): Row {
    const settings = (this.tables.shops.find((s) => s["id"] === o["shop_id"])?.["settings"] ?? {}) as Row;
    return {
      number: o["number"], status: o["status"], created_at: o["created_at"], shipped_at: o["shipped_at"] ?? null, total_jpy: o["total_jpy"], shipping_jpy: o["shipping_jpy"] ?? 0,
      discount_jpy: o["discount_jpy"] ?? 0, discounts: o["discounts"] ?? [], shipping_tax_rate: o["shipping_tax_rate"] ?? Number(settings["tax_rate"] ?? 10),
      tax_rounding: o["tax_rounding"] ?? settings["tax_rounding"] ?? "floor", payment_provider: o["payment_provider"] ?? null, items: this.orderItemsJson(o["id"]),
      tracking: o["tracking_number"] ? { carrier: o["tracking_carrier"], number: o["tracking_number"] } : null,
    };
  }

  cancelOrder(orderId: unknown, shopId: unknown, refunded: boolean): Response {
    const o = this.tables.orders.find((x) => x["id"] === orderId && x["shop_id"] === shopId);
    if (!o) return json({ code: "P0001", message: "not_found" }, 400);
    if (o["status"] === "cancelled" || o["status"] === "refunded") return json({ order_id: o["id"], status: o["status"], already: true });
    if (o["status"] !== "paid") return json({ code: "P0001", message: "not_cancellable" }, 400);
    for (const it of this.tables.order_items.filter((i) => i["order_id"] === o["id"])) {
      const inv = this.tables.inventory.find((i) => i["sku_id"] === it["sku_id"]);
      if (inv) inv["available"] = Number(inv["available"]) + Number(it["qty"]);
    }
    this.releaseCoupons(o["reservation_id"]);
    o["status"] = refunded ? "refunded" : "cancelled";
    this.enqueue(String(shopId), "order.cancelled", { order_id: o["id"], order_number: o["number"], refunded });
    return json({ order_id: o["id"], status: o["status"], already: false, payment_provider: o["payment_provider"] ?? null, payment_ref: o["payment_ref"] ?? null });
  }

  /** クーポンの枠と使用の記録を戻す（banto_release_coupons と 0019 のトリガーの再現） */
  releaseCoupons(reservationId: unknown): void {
    for (const r of this.tables.coupon_redemptions) if (r["reservation_id"] === reservationId) r["status"] = "released";
    for (const g of this.tables.coupon_grants) if (g["reservation_id"] === reservationId && (g["status"] === "held" || g["status"] === "used")) Object.assign(g, { status: "available", reservation_id: null, used_at: null });
  }

  /** 発行済みのクーポンを作る（テスト用。本物は coupon_grants_issue） */
  addGrant(shopId: string, campaignId: string, fields: Partial<Row> = {}): Row & { id: string; code: string } {
    const row = { id: `grant-${++this.seq}`, shop_id: shopId, campaign_id: campaignId, code: `G${String(this.seq).padStart(4, "0")}-TEST-CODE`, customer_id: null, status: "available", expires_at: null, reservation_id: null, created_at: this.now(), used_at: null, ...fields };
    this.tables.coupon_grants.push(row);
    return row as Row & { id: string; code: string };
  }

  /** クーポンの使用回数（戻していないもの） */
  private couponUses(campaignId: unknown, subject?: unknown): number {
    return this.tables.coupon_redemptions.filter((r) => r["campaign_id"] === campaignId && r["status"] !== "released" && (subject === undefined || r["subject"] === subject)).length;
  }

  /** service_role 専用 RPC の模倣。本物のロジックは test/db/ で検証している */
  /** 0012_member_auth の RPC（照合・回数の制限・世代）。本物の振る舞いは test/db/member-auth.test.ts で確かめる */
  private memberRpc(fn: string, args: Record<string, unknown>): Response {
    const shopId = String(args["p_shop_id"] ?? "");
    const shop = this.tables.shops.find((x) => x["id"] === shopId);
    const enabled = (shop?.["settings"] as Row | undefined)?.["members_enabled"] === true;
    const findCustomer = (id: unknown, epoch: unknown) => this.tables.customers.find((c) => c["shop_id"] === shopId && c["id"] === id && Number(c["session_epoch"] ?? 0) === Number(epoch));
    const now = Date.now();
    switch (fn) {
      case "member_login_start": {
        const email = String(args["p_email"] ?? "").trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ code: "P0001", message: "invalid_email" }, 400);
        if (!enabled) return json({ code: "P0001", message: "members_disabled" }, 400);
        const ep = this.tables.hook_endpoints.find((e) => e["shop_id"] === shopId && e["enabled"] !== false && e["url"] === "https://banto.invalid/plugins/email_resend");
        const from = String(((ep?.["settings"] ?? {}) as Row)["from"] ?? "").trim();
        if (!from) return json({ code: "P0001", message: "mail_not_configured" }, 400);
        {
          const limitHit = this.planLimitHit("mail_per_day"); // 0053
          if (limitHit) return limitHit;
        }
        // 0029: 同じ IP から同じ人へ 15 分 3 回・1 日 10 回、同じ IP から 1 時間 30 回、アドレス全体 1 日 30 通、ショップ全体 1 時間 100・1 日 500
        const mine = this.memberChallenges.filter((c) => c["shop_id"] === shopId && c["email"] === email);
        const ip = args["p_ip_hash"] ?? null;
        const within = (rows: Row[], ms: number) => rows.filter((c) => now - Number(c["created_at"]) < ms).length;
        const all = this.memberChallenges.filter((c) => c["shop_id"] === shopId);
        const sameIp = ip ? mine.filter((c) => c["ip_hash"] === ip) : [];
        const shopLimit = (key: string, dflt: number) => {
          const v = String(((this.tables.shops.find((x) => x["id"] === shopId)?.["settings"] as Row | undefined)?.["members_login_limits"] as Row | undefined)?.[key] ?? "");
          return /^[0-9]{1,4}$/.test(v) ? Number(v) : dflt;
        };
        const limited = ip
          ? within(sameIp, 15 * 60_000) >= 3 || within(sameIp, 86400_000) >= 10 || within(all.filter((c) => c["ip_hash"] === ip), 3600_000) >= shopLimit("per_ip_per_hour", 30)
          : within(mine, 15 * 60_000) >= 5;
        if (limited || within(mine, 86400_000) >= 30 || within(all, 3600_000) >= shopLimit("per_hour", 100) || within(all, 86400_000) >= shopLimit("per_day", 500)) {
          return json({ send: false, challenge_id: crypto.randomUUID(), mail_from: from });
        }
        // 直近 3 つまで有効
        const open = mine.filter((c) => !c["consumed_at"]).sort((a, b) => Number(b["created_at"]) - Number(a["created_at"]));
        for (const c of open.slice(2)) c["consumed_at"] = now;
        const id = crypto.randomUUID();
        this.memberChallenges.push({ id, shop_id: shopId, email, code_hash: args["p_code_hash"], link_hash: args["p_link_hash"], ip_hash: ip, return_to: args["p_return_to"] ?? null, attempts: 0, created_at: now, expires_at: now + 900_000, consumed_at: null });
        return json({ send: true, challenge_id: id, mail_from: from });
      }
      case "member_login_peek": {
        const ch = this.memberChallenges.find((c) => c["id"] === args["p_challenge_id"] && c["shop_id"] === shopId && c["link_hash"] === args["p_link_hash"]);
        return json(ch && !ch["consumed_at"] && Number(ch["expires_at"]) > now && Number(ch["attempts"]) < 5 ? ch["email"] : null);
      }
      case "member_login_verify": {
        const ch = this.memberChallenges.find((c) => c["id"] === args["p_challenge_id"] && c["shop_id"] === shopId);
        if (!ch) return json({ ok: false, reason: "invalid" });
        if (ch["consumed_at"] || Number(ch["expires_at"]) < now || Number(ch["attempts"]) >= 5) return json({ ok: false, reason: "expired" });
        if (this.memberChallenges.filter((c) => c["shop_id"] === shopId && c["email"] === ch["email"] && now - Number(c["created_at"]) < 86400_000).reduce((n, c) => n + Number(c["attempts"] ?? 0), 0) >= 50) return json({ ok: false, reason: "expired" });
        const match = (args["p_code_hash"] != null && ch["code_hash"] === args["p_code_hash"]) || (args["p_link_hash"] != null && ch["link_hash"] === args["p_link_hash"]);
        if (!match) {
          ch["attempts"] = Number(ch["attempts"]) + 1;
          if (Number(ch["attempts"]) >= 5) ch["consumed_at"] = now;
          return json({ ok: false, reason: Number(ch["attempts"]) >= 5 ? "expired" : "invalid" });
        }
        ch["consumed_at"] = now;
        if (!enabled) return json({ ok: false, reason: "expired" });
        let cust = this.tables.customers.find((c) => c["shop_id"] === shopId && String(c["email"] ?? "").toLowerCase() === ch["email"]);
        let created = false;
        if (!cust) {
          const limitHit = this.planLimitHit("customers");
          if (limitHit) return limitHit;
          cust = { id: crypto.randomUUID(), shop_id: shopId, email: ch["email"], name: null, default_address: null, session_epoch: 0, created_at: new Date().toISOString() };
          this.tables.customers.push(cust);
          created = true;
        }
        cust["last_login_at"] = new Date().toISOString();
        return json({ ok: true, customer_id: cust["id"], session_epoch: Number(cust["session_epoch"] ?? 0), email: cust["email"], created, return_to: ch["return_to"] ?? null });
      }
      case "member_claim_coupon": {
        const c = findCustomer(args["p_customer_id"], args["p_epoch"]);
        if (!c) return json({ ok: false, reason: "session" });
        const k = this.tables.coupon_campaigns.find((x) => x["id"] === args["p_campaign_id"] && x["shop_id"] === shopId && x["claimable"] === true && x["active"] !== false);
        if (!k) return json({ ok: false, reason: "unavailable" });
        if (this.tables.coupon_grants.some((g) => g["campaign_id"] === k["id"] && g["customer_id"] === c["id"] && g["status"] !== "revoked")) return json({ ok: false, reason: "already" });
        const claimed = this.tables.coupon_grants.filter((g) => g["campaign_id"] === k["id"]).length;
        if (k["usage_limit"] != null && claimed >= Number(k["usage_limit"])) return json({ ok: false, reason: "exhausted" });
        const g = this.addGrant(String(shopId), String(k["id"]), { customer_id: c["id"] });
        return json({ ok: true, code: g.code });
      }
      case "member_coupons": {
        const c = findCustomer(args["p_customer_id"], args["p_epoch"]);
        if (!c) return json(null);
        return json(this.tables.coupon_grants
          .filter((g) => g["shop_id"] === shopId && g["customer_id"] === c["id"] && g["status"] === "available" && (!g["expires_at"] || Date.parse(String(g["expires_at"])) > now))
          .flatMap((g) => {
            const k = this.tables.coupon_campaigns.find((x) => x["id"] === g["campaign_id"] && x["active"] !== false);
            return k ? [{ code: g["code"], name: k["name"], kind: k["kind"], value: k["value"] ?? 0, expires_at: g["expires_at"] ?? k["ends_at"] ?? null }] : [];
          }));
      }
      case "member_order": {
        const c = findCustomer(args["p_customer_id"], args["p_epoch"]);
        if (!c) return json(null);
        const o = this.tables.orders.find((x) => x["shop_id"] === shopId && x["customer_id"] === c["id"] && x["number"] === Number(args["p_number"]));
        return json(o ? this.orderJson(o) : null);
      }
      case "member_get": {
        const c = findCustomer(args["p_customer_id"], args["p_epoch"]);
        if (!c) return json(null);
        const orders = args["p_with_orders"]
          ? this.tables.orders
              .filter((o) => o["shop_id"] === shopId && o["customer_id"] === c["id"])
              .sort((x, y) => String(y["created_at"]).localeCompare(String(x["created_at"])))
              .map((o) => ({ id: o["id"], number: o["number"], status: o["status"], total_jpy: o["total_jpy"], shipping_jpy: o["shipping_jpy"] ?? 0, discount_jpy: o["discount_jpy"] ?? 0, created_at: o["created_at"], shipped_at: o["shipped_at"] ?? null }))
          : [];
        const providers = this.memberIdentities.filter((i) => i["shop_id"] === shopId && i["customer_id"] === c["id"]).map((i) => String(i["provider"]));
        return json({ customer: { id: c["id"], shop_id: shopId, email: c["email"] ?? null, name: c["name"] ?? null, default_address: c["default_address"] ?? null, marketing_consent: c["marketing_consent"] ?? null, has_password: Boolean(c["password_hash"] || c["legacy_password_hash"]), providers }, orders });
      }
      case "member_set_marketing_consent": {
        const c = findCustomer(args["p_customer_id"], args["p_epoch"]);
        if (!c) return json(false);
        c["marketing_consent"] = Boolean(args["p_consent"]);
        c["marketing_consent_at"] = this.now();
        c["marketing_consent_source"] = "account";
        return json(true);
      }
      case "member_save_address": {
        const c = findCustomer(args["p_customer_id"], args["p_epoch"]);
        if (!c) return json(false);
        c["name"] = args["p_name"] ?? null;
        c["default_address"] = args["p_address"] ?? null;
        return json(true);
      }
      case "member_withdraw": {
        const c = findCustomer(args["p_customer_id"], args["p_epoch"]);
        if (!c) return json(false);
        this.tables.customers.splice(this.tables.customers.indexOf(c), 1);
        return json(true);
      }
      case "member_logout_all": {
        const c = findCustomer(args["p_customer_id"], args["p_epoch"]);
        if (!c) return json(false);
        c["session_epoch"] = Number(c["session_epoch"] ?? 0) + 1;
        return json(true);
      }
      case "member_password_login": {
        const settings = (shop?.["settings"] ?? {}) as Row;
        if (!enabled || settings["members_password"] !== true) return json({ ok: false, reason: "disabled" });
        const email = String(args["p_email"] ?? "").trim().toLowerCase();
        const ip = args["p_ip_hash"] ?? null;
        const fails = this.memberFailures.filter((x) => x["shop_id"] === shopId && x["email"] === email && now - Number(x["at"]) < 15 * 60_000).length;
        const ipFails = ip ? this.memberFailures.filter((x) => x["shop_id"] === shopId && x["ip"] === ip && now - Number(x["at"]) < 3600_000).length : 0;
        if (fails >= 5 || ipFails >= 30) return json({ ok: false, reason: "locked" });
        const c = this.tables.customers.find((x) => x["shop_id"] === shopId && String(x["email"] ?? "").toLowerCase() === email);
        const pw = String(args["p_password"] ?? "");
        let ok = false;
        if (c?.["password_hash"]) ok = c["password_hash"] === `fake$${pw}`;
        else if (c?.["legacy_password_hash"]) {
          ok = this.legacyPasswords.get(String(c["legacy_password_hash"])) === pw.trim();
          if (ok) {
            c["password_hash"] = `fake$${pw}`;
            c["legacy_password_hash"] = null;
          }
        }
        if (!ok || !c) {
          this.memberFailures.push({ shop_id: shopId, email, ip, at: now });
          return json({ ok: false, reason: "invalid" });
        }
        // 0016: 知らせの送信元（メール通知プラグインの「送信元」）
        const mail = this.tables.hook_endpoints.find((e) => e["shop_id"] === shopId && e["enabled"] && e["url"] === "https://banto.invalid/plugins/email_resend");
        const from = ((mail?.["settings"] ?? {}) as Row)["from"];
        return json({ ok: true, customer_id: c["id"], session_epoch: Number(c["session_epoch"] ?? 0), email: c["email"] ?? null, mail_from: typeof from === "string" && from.trim() ? from.trim() : null });
      }
      case "member_set_password": {
        if (((shop?.["settings"] ?? {}) as Row)["members_password"] !== true) return json({ code: "P0001", message: "password_disabled" }, 400);
        const pw = String(args["p_password"] ?? "");
        if (pw.length < 8) return json({ code: "P0001", message: "weak_password" }, 400);
        const c = findCustomer(args["p_customer_id"], args["p_epoch"]);
        if (!c) return json({ ok: false, reason: "session" });
        // 0057: ログインしてから 15 分以内のセッションだけ。今のセッションの行を新しい世代に付け替える
        const ms = this.liveMemberSession(shopId, args["p_customer_id"], args["p_epoch"], args["p_session_id"], Date.now());
        if (!ms) return json({ ok: false, reason: "session" });
        if (Date.now() - Date.parse(String(ms["created_at"])) > 15 * 60 * 1000) return json({ ok: false, reason: "reauth" });
        c["password_hash"] = `fake$${pw}`;
        c["legacy_password_hash"] = null;
        c["session_epoch"] = Number(c["session_epoch"] ?? 0) + 1;
        ms["session_epoch"] = c["session_epoch"];
        return json({ ok: true, epoch: c["session_epoch"], email: c["email"] ?? null, mail_from: this.mailFrom(shopId) });
      }
      case "import_member_passwords": {
        const out = { imported: 0, created: 0, skipped_format: 0, skipped_has_password: 0, skipped_invalid_email: 0 };
        for (const r of (args["p_rows"] as Row[]) ?? []) {
          const email = String(r["email"] ?? "").trim().toLowerCase();
          const hash = String(r["hash"] ?? "");
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { out.skipped_invalid_email++; continue; }
          if (!/^(\$wp)?\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$/.test(hash)) { out.skipped_format++; continue; }
          let c = this.tables.customers.find((x) => x["shop_id"] === shopId && String(x["email"] ?? "").toLowerCase() === email);
          if (!c) {
            c = { id: crypto.randomUUID(), shop_id: shopId, email, name: null, default_address: null, session_epoch: 0, created_at: new Date().toISOString() };
            this.tables.customers.push(c);
            out.created++;
          }
          if (c["password_hash"]) { out.skipped_has_password++; continue; }
          c["legacy_password_hash"] = hash;
          out.imported++;
        }
        return json(out);
      }
      case "member_oauth_login": {
        const settings = (shop?.["settings"] ?? {}) as Row;
        const provider = String(args["p_provider"]);
        if (!enabled || ((settings["modules"] ?? {}) as Row)[`${provider}_login`] !== true) return json({ ok: false, reason: "disabled" });
        const sub = String(args["p_subject"]);
        const email = args["p_email"] ? String(args["p_email"]).toLowerCase() : null;
        const verified = args["p_email_verified"] === true;
        let ident = this.memberIdentities.find((i) => i["shop_id"] === shopId && i["provider"] === provider && i["subject"] === sub);
        let created = false;
        let linked = false;
        let cid: unknown;
        if (args["p_link_customer_id"]) {
          if (!findCustomer(args["p_link_customer_id"], args["p_link_epoch"])) return json({ ok: false, reason: "session" });
          // 0057: 連携はログインしてから 15 分以内のセッションだけ
          const ms = this.liveMemberSession(shopId, args["p_link_customer_id"], args["p_link_epoch"], args["p_link_session_id"], Date.now());
          if (!ms) return json({ ok: false, reason: "session" });
          if (Date.now() - Date.parse(String(ms["created_at"])) > 15 * 60 * 1000) return json({ ok: false, reason: "reauth" });
          if (ident && ident["customer_id"] !== args["p_link_customer_id"]) return json({ ok: false, reason: "already_linked" });
          if (!ident) {
            if (this.memberIdentities.some((i) => i["shop_id"] === shopId && i["customer_id"] === args["p_link_customer_id"] && i["provider"] === provider)) return json({ ok: false, reason: "other_linked" });
            this.memberIdentities.push({ shop_id: shopId, provider, subject: sub, customer_id: args["p_link_customer_id"] });
            linked = true;
          }
          cid = args["p_link_customer_id"];
        } else if (ident) {
          cid = ident["customer_id"];
        } else {
          const byEmail = email && verified ? this.tables.customers.find((x) => x["shop_id"] === shopId && String(x["email"] ?? "").toLowerCase() === email) : undefined;
          if (byEmail) cid = byEmail["id"];
          else {
            const row = { id: crypto.randomUUID(), shop_id: shopId, email: email && verified ? email : null, name: null, default_address: null, session_epoch: 0, created_at: new Date().toISOString() };
            this.tables.customers.push(row);
            cid = row.id;
            created = true;
          }
          ident = { shop_id: shopId, provider, subject: sub, customer_id: cid };
          this.memberIdentities.push(ident);
          linked = true;
        }
        const c = this.tables.customers.find((x) => x["shop_id"] === shopId && x["id"] === cid)!;
        return json({ ok: true, customer_id: c["id"], session_epoch: Number(c["session_epoch"] ?? 0), email: c["email"] ?? null, created, linked, mail_from: args["p_link_customer_id"] && linked ? this.mailFrom(shopId) : null });
      }
      case "member_unlink_identity": {
        const c = findCustomer(args["p_customer_id"], args["p_epoch"]);
        if (!c) return json(false);
        if (!c["email"]) return json({ code: "P0001", message: "last_login_method" }, 400);
        const i = this.memberIdentities.findIndex((x) => x["shop_id"] === shopId && x["customer_id"] === c["id"] && x["provider"] === args["p_provider"]);
        if (i < 0) return json(false);
        this.memberIdentities.splice(i, 1);
        return json(true);
      }
      case "shop_oauth_client": {
        const row = this.oauthClients.find((x) => x["shop_id"] === shopId && x["provider"] === args["p_provider"]);
        return json(row ? { client_id: row["client_id"], secret_box: row["secret_box"] } : null);
      }
      case "member_handoff_create": {
        if (!findCustomer(args["p_customer_id"], args["p_epoch"])) return json({ code: "P0001", message: "member_session_invalid" }, 400);
        const id = crypto.randomUUID();
        this.memberHandoffs.push({ id, shop_id: shopId, customer_id: args["p_customer_id"], epoch: args["p_epoch"], token_hash: args["p_token_hash"], expires_at: now + 120_000, consumed_at: null });
        return json(id);
      }
      case "member_handoff_redeem": {
        const hd = this.memberHandoffs.find((x) => x["id"] === args["p_id"] && x["shop_id"] === shopId);
        if (!hd || hd["token_hash"] !== args["p_token_hash"] || hd["consumed_at"] || Number(hd["expires_at"]) < now) return json({ ok: false, reason: "expired" });
        hd["consumed_at"] = now;
        const c = findCustomer(hd["customer_id"], hd["epoch"]);
        if (!c) return json({ ok: false, reason: "expired" });
        return json({ ok: true, customer_id: c["id"], session_epoch: Number(c["session_epoch"] ?? 0), email: c["email"] ?? null });
      }
      case "member_login_cleanup":
        return json(0);
      case "member_session_start": {
        if (!findCustomer(args["p_customer_id"], args["p_epoch"])) return json(null);
        const id = crypto.randomUUID();
        this.memberSessions.push({ id, shop_id: shopId, customer_id: args["p_customer_id"], session_epoch: args["p_epoch"], kind: args["p_kind"], label: args["p_label"] ?? null, refresh_gen: 0, rotated_at: null, created_at: new Date(now).toISOString(), last_seen_at: new Date(now).toISOString(), expires_at: now + Number(args["p_ttl_seconds"]) * 1000, revoked_at: null });
        return json(id);
      }
      case "member_session_check":
      case "member_session_refresh": {
        const ms = this.liveMemberSession(shopId, args["p_customer_id"], args["p_epoch"], args["p_session_id"], now);
        if (fn === "member_session_check") {
          if (ms) ms["last_seen_at"] = new Date(now).toISOString();
          return json(Boolean(ms));
        }
        if (!ms || ms["kind"] !== "api") return json({ ok: false, reason: "invalid" });
        const gen = Number(args["p_gen"]);
        const cur = Number(ms["refresh_gen"]);
        if (gen === cur) {
          ms["refresh_gen"] = cur + 1;
          ms["rotated_at"] = now;
          return json({ ok: true, gen: cur + 1, expires_at: new Date(Number(ms["expires_at"])).toISOString() });
        }
        if (gen === cur - 1 && now - Number(ms["rotated_at"]) < 30_000) return json({ ok: true, gen: cur, expires_at: new Date(Number(ms["expires_at"])).toISOString() });
        ms["revoked_at"] = now;
        ms["revoked_reason"] = "reuse";
        return json({ ok: false, reason: "reuse" });
      }
      case "member_session_revoke": {
        if (!findCustomer(args["p_customer_id"], args["p_epoch"])) return json(false);
        const ms = this.memberSessions.find((x) => x["id"] === args["p_session_id"] && x["shop_id"] === shopId && x["customer_id"] === args["p_customer_id"] && !x["revoked_at"]);
        if (!ms) return json(false);
        ms["revoked_at"] = now;
        ms["revoked_reason"] = args["p_reason"];
        return json(true);
      }
      case "member_sessions_list": {
        if (!findCustomer(args["p_customer_id"], args["p_epoch"])) return json(null);
        return json(this.memberSessions
          .filter((x) => x["shop_id"] === shopId && x["customer_id"] === args["p_customer_id"] && x["session_epoch"] === args["p_epoch"] && !x["revoked_at"] && Number(x["expires_at"]) > now)
          .map((x) => ({ id: x["id"], kind: x["kind"], label: x["label"], created_at: x["created_at"], last_seen_at: x["last_seen_at"] })));
      }
      case "member_session_cleanup":
      case "member_passkey_cleanup":
        return json(0);
      case "member_passkey_begin": {
        const settings = (shop?.["settings"] ?? {}) as Row;
        const domain = shop?.["domain"] ? String(shop["domain"]) : null;
        if (!domain || !enabled || ((settings["modules"] ?? {}) as Row)["passkey"] !== true) return json({ ok: false, reason: "disabled" });
        const id = crypto.randomUUID();
        const row: Row = { id, shop_id: shopId, purpose: args["p_purpose"], challenge_hash: args["p_challenge_hash"], customer_id: args["p_customer_id"] ?? null, session_id: args["p_session_id"] ?? null, expires_at: now + 300_000, consumed_at: null };
        if (args["p_purpose"] === "login") {
          this.passkeyChallenges.push(row);
          return json({ ok: true, challenge_id: id, rp_id: domain });
        }
        const c = findCustomer(args["p_customer_id"], args["p_epoch"]);
        if (!c || !this.liveMemberSession(shopId, args["p_customer_id"], args["p_epoch"], args["p_session_id"], now)) return json({ ok: false, reason: "session" });
        const ms = this.memberSessions.find((x) => x["id"] === args["p_session_id"])!;
        if (ms["kind"] !== "web" || now - Date.parse(String(ms["created_at"])) > 15 * 60_000) return json({ ok: false, reason: "reauth" });
        const mine = this.memberPasskeys.filter((k) => k["shop_id"] === shopId && k["customer_id"] === c["id"]);
        if (mine.length >= 10) return json({ ok: false, reason: "too_many" });
        this.passkeyChallenges.push(row);
        return json({ ok: true, challenge_id: id, rp_id: domain, user: { email: c["email"] ?? null, name: c["name"] ?? null }, exclude: mine.filter((k) => k["rp_id"] === domain).map((k) => k["credential_id"]) });
      }
      case "member_passkey_register":
      case "member_passkey_login": {
        const domain = shop?.["domain"] ? String(shop["domain"]) : null;
        if (!domain || !enabled || ((((shop?.["settings"] ?? {}) as Row)["modules"] ?? {}) as Row)["passkey"] !== true) return json({ ok: false, reason: "disabled" });
        const purpose = fn === "member_passkey_login" ? "login" : "register";
        const ch = this.passkeyChallenges.find((x) => x["id"] === args["p_challenge_id"] && x["shop_id"] === shopId && x["purpose"] === purpose);
        const okCh = ch && !ch["consumed_at"] && Number(ch["expires_at"]) > now && ch["challenge_hash"] === args["p_challenge_hash"];
        if (ch && okCh) ch["consumed_at"] = now;
        if (fn === "member_passkey_login") {
          if (!okCh) return json({ ok: false, reason: "expired" });
          const pk = this.memberPasskeys.find((k) => k["id"] === args["p_passkey_id"] && k["shop_id"] === shopId && k["rp_id"] === domain);
          if (!pk) return json({ ok: false, reason: "invalid" });
          const n = Number(args["p_sign_count"] ?? 0);
          if ((n > 0 || Number(pk["sign_count"]) > 0) && n <= Number(pk["sign_count"])) return json({ ok: false, reason: "counter" });
          Object.assign(pk, { sign_count: n, last_used_at: new Date(now).toISOString() });
          const c = this.tables.customers.find((x) => x["id"] === pk["customer_id"] && x["shop_id"] === shopId)!;
          return json({ ok: true, customer_id: c["id"], session_epoch: Number(c["session_epoch"] ?? 0), email: c["email"] ?? null });
        }
        if (args["p_rp_id"] !== domain) return json({ ok: false, reason: "disabled" });
        if (!okCh || ch["customer_id"] !== args["p_customer_id"] || ch["session_id"] !== args["p_session_id"]) return json({ ok: false, reason: "expired" });
        if (!this.liveMemberSession(shopId, args["p_customer_id"], args["p_epoch"], args["p_session_id"], now)) return json({ ok: false, reason: "session" });
        if (this.memberPasskeys.filter((k) => k["shop_id"] === shopId && k["customer_id"] === args["p_customer_id"]).length >= 10) return json({ ok: false, reason: "too_many" });
        if (this.memberPasskeys.some((k) => k["shop_id"] === shopId && k["credential_id"] === args["p_credential_id"])) return json({ ok: false, reason: "duplicate" });
        const id = crypto.randomUUID();
        this.memberPasskeys.push({ id, shop_id: shopId, customer_id: args["p_customer_id"], credential_id: args["p_credential_id"], public_key: args["p_public_key"], alg: args["p_alg"], rp_id: args["p_rp_id"], sign_count: args["p_sign_count"], backed_up: args["p_backed_up"], label: args["p_label"] ?? null, created_at: new Date(now).toISOString(), last_used_at: null });
        const c = this.tables.customers.find((x) => x["id"] === args["p_customer_id"] && x["shop_id"] === shopId)!;
        const ep = this.tables.hook_endpoints.find((e) => e["shop_id"] === shopId && e["enabled"] !== false && e["url"] === "https://banto.invalid/plugins/email_resend");
        return json({ ok: true, id, email: c["email"] ?? null, mail_from: String(((ep?.["settings"] ?? {}) as Row)["from"] ?? "") || null });
      }
      case "member_passkey_lookup": {
        const domain = shop?.["domain"] ? String(shop["domain"]) : null;
        const pk = this.memberPasskeys.find((k) => k["shop_id"] === shopId && k["credential_id"] === args["p_credential_id"] && k["rp_id"] === domain);
        return json(pk ? { id: pk["id"], customer_id: pk["customer_id"], public_key: pk["public_key"], alg: pk["alg"] } : null);
      }
      case "member_passkeys_list": {
        if (!findCustomer(args["p_customer_id"], args["p_epoch"])) return json(null);
        return json(this.memberPasskeys
          .filter((k) => k["shop_id"] === shopId && k["customer_id"] === args["p_customer_id"])
          .map((k) => ({ id: k["id"], label: k["label"], created_at: k["created_at"], last_used_at: k["last_used_at"], backed_up: k["backed_up"], usable: k["rp_id"] === shop?.["domain"] })));
      }
      case "member_passkey_delete": {
        if (!findCustomer(args["p_customer_id"], args["p_epoch"])) return json(false);
        const i = this.memberPasskeys.findIndex((k) => k["id"] === args["p_id"] && k["shop_id"] === shopId && k["customer_id"] === args["p_customer_id"]);
        if (i < 0) return json(false);
        this.memberPasskeys.splice(i, 1);
        return json(true);
      }
      case "import_members": {
        let created = 0;
        let updated = 0;
        let skipped = 0;
        for (const r of (args["p_rows"] as Row[]) ?? []) {
          const email = String(r["email"] ?? "").trim().toLowerCase();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            skipped++;
            continue;
          }
          const cur = this.tables.customers.find((x) => x["shop_id"] === shopId && String(x["email"] ?? "").toLowerCase() === email);
          if (cur) {
            cur["name"] ??= r["name"] ?? null;
            cur["default_address"] ??= r["default_address"] ?? null;
            updated++;
          } else {
            this.tables.customers.push({ id: crypto.randomUUID(), shop_id: shopId, email, name: r["name"] ?? null, default_address: r["default_address"] ?? null, session_epoch: 0, created_at: new Date().toISOString() });
            created++;
          }
        }
        return json({ created, updated, skipped });
      }
    }
    return json({ code: "PGRST202", message: `Could not find the function ${fn}` }, 404);
  }

  private serviceRpc(fn: string, args: Record<string, unknown>): Response {
    if (fn === "site_settings_set" && args["p_key"] === "plan_limits") {
      // 0052: service_role は plan_limits を書ける（値の検査の本物は test/db/plan-limits.test.ts）
      this.siteSettings = { ...this.siteSettings, plan_limits: args["p_value"] };
      return json(this.siteSettings);
    }
    if (fn === "image_import_claim") {
      const batch = this.siteSettings["workers_plan"] === "paid" ? 150 : 12;
      const on = (shopId: string) => ((this.tables.shops.find((x) => x["id"] === shopId)?.["settings"] as Row | undefined)?.["modules"] as Row | undefined)?.["woo_import"] === true;
      const picked = this.imageJobs.filter((j) => j.status === "pending" && on(j.shop_id)).slice(0, batch);
      for (const j of picked) Object.assign(j, { status: "running", attempts: j.attempts + 1 });
      return json(picked.map((j) => ({ id: j.id, shop_id: j.shop_id, product_id: j.product_id, url: j.url })));
    }
    if (fn === "image_import_finish") {
      const r = { done: 0, retry: 0, failed: 0 };
      for (const x of (args["p_results"] as Row[]) ?? []) {
        const j = this.imageJobs.find((y) => y.id === x["id"] && y.status === "running");
        if (!j) continue;
        if (typeof x["storage_key"] === "string") {
          if (!this.tables.product_images.some((i) => i["storage_key"] === x["storage_key"]))
            this.tables.product_images.push({ id: `img-${++this.seq}`, shop_id: j.shop_id, product_id: j.product_id, storage_key: x["storage_key"], thumb_key: null, width: null, height: null, sort_order: this.tables.product_images.filter((i) => i["product_id"] === j.product_id).length, created_at: this.now() });
          Object.assign(j, { status: "done", last_error: null });
          r.done++;
        } else {
          const err = String(x["error"]);
          const retry = j.attempts < 3 && (err === "fetch_failed" || err === "storage" || /^http_(5|429)/.test(err));
          Object.assign(j, { status: retry ? "pending" : "failed", last_error: err });
          if (retry) r.retry++;
          else r.failed++;
        }
      }
      return json(r);
    }
    if (fn === "admin_login_check") {
      const since = Date.now() - 15 * 60_000;
      const fails = this.adminLoginAttempts.filter((a) => !a.success && a.at > since);
      const byEmail = fails.filter((a) => a.email_hash === args["p_email_hash"]).length;
      const byIp = args["p_ip_hash"] ? fails.filter((a) => a.ip_hash === args["p_ip_hash"]).length : 0;
      return json({ allowed: byEmail < 5 && byIp < 20, retry_after_seconds: 900 });
    }
    if (fn === "admin_login_record") {
      if (args["p_success"] === true) for (let i = this.adminLoginAttempts.length - 1; i >= 0; i--) if (this.adminLoginAttempts[i]!.email_hash === args["p_email_hash"] && !this.adminLoginAttempts[i]!.success) this.adminLoginAttempts.splice(i, 1);
      this.adminLoginAttempts.push({ email_hash: String(args["p_email_hash"]), ip_hash: (args["p_ip_hash"] as string | null) ?? null, success: args["p_success"] === true, at: Date.now() });
      return new Response(null, { status: 204 });
    }
    if (fn === "org_invitation_peek") {
      const i = this.orgInvitations.find((x) => x["token_hash"] === args["p_token_hash"]);
      if (!i) return json(null);
      const o = this.organizations.find((x) => x["id"] === i["org_id"]);
      return json({ email: i["email"], org_name: o?.["name"], role: i["role"], valid: i["accepted_at"] == null && String(i["expires_at"]) > this.now(), user_exists: [...this.users.values()].some((u) => u.email === i["email"]) });
    }
    if (fn.startsWith("api_")) return this.apiRpc(fn, args);
    if (fn === "shop_payment_options") return json(this.paymentOptions(args["p_shop_id"]));
    if (fn === "shop_public_get") return json(this.shopPublicGet(args));
    if (fn === "shop_public_list") return json(this.tables.shops.filter((s) => s["published"] === true).map((s) => this.shopPublicJson(s)));
    if ((fn.startsWith("member_") && !fn.startsWith("member_tryon_")) || fn === "import_members" || fn === "import_member_passwords" || fn === "shop_oauth_client") {
      if (!this.appliedMigrations.includes("0012_member_auth")) return json({ code: "PGRST202", message: "Could not find the function" }, 404);
      return this.memberRpc(fn, args);
    }
    if (fn === "attach_reservation_customer") {
      const res = this.tables.reservations.find((r) => r["id"] === args["p_reservation_id"] && r["shop_id"] === args["p_shop_id"] && r["status"] === "pending");
      if (!res) return json({ code: "P0001", message: "reservation_not_found" }, 400);
      const { shipping_jpy, customer_id, customer_epoch, ...customer } = (args["p_customer"] ?? {}) as Row;
      if (customer_id && !this.tables.customers.some((c) => c["shop_id"] === args["p_shop_id"] && c["id"] === customer_id && Number(c["session_epoch"] ?? 0) === Number(customer_epoch ?? -1))) {
        return json({ code: "P0001", message: "member_session_invalid" }, 400);
      }
      res["customer"] = customer;
      res["shipping_jpy"] = Number(shipping_jpy ?? 0);
      res["customer_id"] = customer_id ?? null;
      return new Response(null, { status: 204 });
    }
    if (fn === "coupon_lookup") {
      const codes = ((args["p_codes"] as string[]) ?? []).map((c) => String(c).trim().toUpperCase()).slice(0, 5);
      const subject = args["p_subject"] ?? null;
      // 0049: ログイン中の会員の独自項目を各行に載せる（p_customer_id が無ければ null）
      const attrs = args["p_customer_id"] ? ((this.tables.customers.find((x) => x["shop_id"] === args["p_shop_id"] && x["id"] === args["p_customer_id"])?.["attributes"] as Row | undefined) ?? {}) : null;
      const campaignCodes = new Set(this.tables.coupon_campaigns.filter((c) => c["shop_id"] === args["p_shop_id"]).map((c) => String(c["code"])));
      const grants = this.tables.coupon_grants
        .filter((g) => g["shop_id"] === args["p_shop_id"] && codes.includes(String(g["code"])) && !campaignCodes.has(String(g["code"])))
        .flatMap((g) => {
          const c = this.tables.coupon_campaigns.find((x) => x["id"] === g["campaign_id"]);
          return c ? [{ id: c["id"], name: c["name"], code: g["code"], kind: c["kind"], value: c["value"] ?? 0, starts_at: c["starts_at"] ?? null, ends_at: c["ends_at"] ?? null, usage_limit: null, per_customer_limit: null,
            combinable: c["combinable"] === true, audience: c["audience"] ?? "public", conditions: c["conditions"] ?? {}, active: c["active"] !== false, used_by_subject: 0, available: true, customer_attributes: attrs,
            grant: { id: g["id"], status: g["status"], expires_at: g["expires_at"] ?? null, customer_id: g["customer_id"] ?? null } }] : [];
        });
      return json([...this.tables.coupon_campaigns
        .filter((c) => c["shop_id"] === args["p_shop_id"] && codes.includes(String(c["code"])))
        .map((c) => ({ id: c["id"], name: c["name"], code: c["code"], kind: c["kind"], value: c["value"] ?? 0, starts_at: c["starts_at"] ?? null, ends_at: c["ends_at"] ?? null,
          usage_limit: c["usage_limit"] ?? null, per_customer_limit: c["per_customer_limit"] ?? null, combinable: c["combinable"] === true, audience: c["audience"] ?? "public",
          conditions: c["conditions"] ?? {}, active: c["active"] !== false,
          used_by_subject: subject && c["per_customer_limit"] ? this.couponUses(c["id"], subject) : 0,
          available: c["usage_limit"] == null || this.couponUses(c["id"]) < Number(c["usage_limit"]), customer_attributes: attrs })), ...grants]);
    }
    if (fn === "apply_reservation_discounts") {
      const res = this.tables.reservations.find((r) => r["id"] === args["p_reservation_id"] && r["shop_id"] === args["p_shop_id"] && r["status"] === "pending");
      if (!res) return json({ code: "P0001", message: "reservation_not_found" }, 400);
      const subject = String(args["p_subject"] ?? "");
      if (!/^(c|e):[0-9a-f-]{32,64}$/.test(subject)) return json({ code: "P0001", message: "invalid_subject" }, 400);
      const d = (args["p_discounts"] ?? {}) as { total_jpy?: number; lines?: { sku_id: string; discount_jpy: number }[]; applied?: Row[] };
      const items = res["items"] as Row[];
      const subtotal = items.reduce((n, it) => n + Number(it["qty"]) * Number(it["unit_price_jpy"]), 0);
      if (Number(d.total_jpy ?? 0) < 0 || Number(d.total_jpy ?? 0) > subtotal + Number(res["shipping_jpy"] ?? 0)) return json({ code: "P0001", message: "invalid_discount" }, 400);
      const now = Date.now();
      for (const a of d.applied ?? []) {
        const c = this.tables.coupon_campaigns.find((x) => x["id"] === a["campaign_id"] && x["shop_id"] === args["p_shop_id"]);
        if (!c || c["active"] === false || (c["starts_at"] && Date.parse(String(c["starts_at"])) > now) || (c["ends_at"] && Date.parse(String(c["ends_at"])) < now)) return json({ code: "P0001", message: "coupon_unavailable" }, 400);
        if (c["audience"] === "members" && !subject.startsWith("c:")) return json({ code: "P0001", message: "coupon_unavailable" }, 400);
        if (a["grant_id"]) {
          const g = this.tables.coupon_grants.find((x) => x["id"] === a["grant_id"] && x["shop_id"] === args["p_shop_id"] && x["campaign_id"] === c["id"]);
          if (!g || g["status"] !== "available" || (g["expires_at"] && Date.parse(String(g["expires_at"])) < now) || (g["customer_id"] && subject !== `c:${g["customer_id"]}`)) return json({ code: "P0001", message: "coupon_unavailable" }, 400);
          continue;
        }
        if (c["per_customer_limit"] && this.couponUses(c["id"], subject) >= Number(c["per_customer_limit"])) return json({ code: "P0001", message: "coupon_limit_reached" }, 400);
        if (c["usage_limit"] != null && this.couponUses(c["id"]) >= Number(c["usage_limit"])) return json({ code: "P0001", message: "coupon_exhausted" }, 400);
      }
      for (const a of d.applied ?? []) {
        this.tables.coupon_redemptions.push({ id: `red-${++this.seq}`, shop_id: args["p_shop_id"], campaign_id: a["campaign_id"], reservation_id: res["id"], order_id: null, subject, amount_jpy: a["amount_jpy"] ?? 0, status: "held", grant_id: a["grant_id"] ?? null, created_at: this.now() });
        if (a["grant_id"]) Object.assign(this.tables.coupon_grants.find((x) => x["id"] === a["grant_id"])!, { status: "held", reservation_id: res["id"] });
      }
      res["discount_jpy"] = Number(d.total_jpy ?? 0);
      res["discounts"] = d.applied ?? [];
      res["items"] = items.map((it) => ({ ...it, discount_jpy: Math.min(Number(it["qty"]) * Number(it["unit_price_jpy"]), Number(d.lines?.find((l) => l.sku_id === it["sku_id"])?.discount_jpy ?? 0)) }));
      return json({ discount_jpy: res["discount_jpy"] });
    }
    if (fn === "order_payment_info") {
      const o = this.tables.orders.find((x) => x["id"] === args["p_order_id"] && x["shop_id"] === args["p_shop_id"]);
      return json(o ? { order_id: o["id"], status: o["status"], payment_provider: o["payment_provider"] ?? null, payment_ref: o["payment_ref"] ?? null, total_jpy: o["total_jpy"] } : null);
    }
    if (fn === "cancel_order") return this.cancelOrder(args["p_order_id"], args["p_shop_id"], args["p_refunded"] === true);
    if (fn === "order_contact") {
      const o = this.tables.orders.find((x) => x["id"] === args["p_order_id"] && x["shop_id"] === args["p_shop_id"]);
      if (!o) return json({ code: "P0001", message: "not_found" }, 400);
      const sh = this.tables.shops.find((x) => x["id"] === o["shop_id"])!;
      return json({ order_id: o["id"], number: o["number"], status: o["status"], created_at: o["created_at"], total_jpy: o["total_jpy"], shipping_jpy: o["shipping_jpy"] ?? 0, discount_jpy: o["discount_jpy"] ?? 0, discounts: o["discounts"] ?? [], payment_provider: o["payment_provider"] ?? null,
        customer_email: o["customer_email"] ?? null, customer_name: o["customer_name"] ?? null, shipping_address: o["shipping_address"] ?? null,
        tracking: o["tracking_number"] ? { carrier: o["tracking_carrier"], number: o["tracking_number"] } : null,
        shop: { name: sh["name"], slug: sh["slug"], contact_email: (sh["settings"] as Row | undefined)?.["contact_email"] ?? null, return_policy: sh["return_policy"] ?? null, tax: {} },
        items: this.orderItemsJson(o["id"]) });
    }
    const inv = (skuId: unknown) => this.tables.inventory.find((i) => i["sku_id"] === skuId);
    const fail = (message: string, status = 400) => json({ code: "P0001", message }, status);

    if (fn === "reserve_stock") {
      const items = args["p_items"] as { sku_id: string; qty: number }[];
      if (!Array.isArray(items) || items.length === 0) return fail("empty_items");
      const shopId = args["p_shop_id"];
      // 全件検証してから減算（失敗時は何も変えない = ロールバック相当）
      for (const it of items) {
        const sku = this.tables.skus.find((k) => k["id"] === it.sku_id && k["shop_id"] === shopId);
        if (!sku || !this.productPublished(sku["product_id"])) return fail("sku_not_available");
        if (!Number.isInteger(it.qty) || it.qty <= 0) return fail("invalid_item");
        if ((inv(it.sku_id)!["available"] as number) < it.qty) return fail("insufficient_stock");
      }
      // 0029: quote は 1 回限り、同じ人・同じ IP の未確定の予約に上限
      const quoteId = (args["p_quote_id"] as string | null | undefined) ?? null;
      const subject = (args["p_subject_hash"] as string | null | undefined) ?? null;
      const ipHash = (args["p_ip_hash"] as string | null | undefined) ?? null;
      const live = this.tables.reservations.filter((r) => r["shop_id"] === shopId);
      if (quoteId && live.some((r) => r["quote_id"] === quoteId && ["pending", "confirmed"].includes(String(r["status"])))) return fail("quote_already_used");
      const limit = (section: string, key: string, dflt: number) => {
        const v = String(((this.tables.shops.find((x) => x["id"] === shopId)?.["settings"] as Row | undefined)?.[section] as Row | undefined)?.[key] ?? "");
        return /^[0-9]{1,4}$/.test(v) ? Number(v) : dflt;
      };
      if (subject && live.filter((r) => r["subject_hash"] === subject && r["status"] === "pending").length >= limit("checkout", "max_pending_per_customer", 3)) return fail("too_many_reservations");
      if (ipHash && live.filter((r) => r["ip_hash"] === ipHash && r["status"] === "pending").length >= limit("checkout", "max_pending_per_ip", 20)) return fail("too_many_reservations");
      const snapshot = items.map((it) => ({ sku_id: it.sku_id, qty: it.qty, unit_price_jpy: this.tables.skus.find((k) => k["id"] === it.sku_id)!["price_jpy"] }));
      for (const it of items) (inv(it.sku_id)!["available"] as number) && (inv(it.sku_id)!["available"] = (inv(it.sku_id)!["available"] as number) - it.qty);
      const id = `res-${++this.seq}`;
      this.tables.reservations.push({ id, shop_id: shopId, status: "pending", items: snapshot, expires_at: new Date(Date.now() + Number(args["p_ttl_seconds"] ?? 900) * 1000).toISOString(), created_at: this.now(), quote_id: quoteId, subject_hash: subject, ip_hash: ipHash });
      return json(id);
    }
    if (fn === "checkout_status") {
      // 0035: quote の識別子で最新の予約を引き、注文があれば confirmed
      const rs = this.tables.reservations.filter((r) => r["shop_id"] === args["p_shop_id"] && r["quote_id"] === args["p_quote_id"]);
      const r = rs[rs.length - 1];
      if (!r) return json({ status: "not_found", order: null, expires_at: null });
      const o = this.tables.orders.find((x) => x["reservation_id"] === r["id"]);
      if (o) return json({ status: "confirmed", expires_at: r["expires_at"] ?? null, order: { number: o["number"], status: o["status"], total_jpy: o["total_jpy"], payment_provider: o["payment_provider"] ?? null, created_at: o["created_at"] } });
      return json({ status: r["status"], order: null, expires_at: r["expires_at"] ?? null });
    }
    if (fn === "release_reservation") {
      const res = this.tables.reservations.find((r) => r["id"] === args["p_reservation_id"] && r["shop_id"] === args["p_shop_id"]);
      if (!res || res["status"] !== "pending") return json(false);
      for (const it of res["items"] as { sku_id: string; qty: number }[]) inv(it.sku_id)!["available"] = (inv(it.sku_id)!["available"] as number) + it.qty;
      this.releaseCoupons(res["id"]);
      res["status"] = "released";
      res["customer"] = null;
      return json(true);
    }
    if (fn === "release_expired_reservations") {
      let n = 0;
      for (const res of this.tables.reservations) {
        if (res["status"] === "pending" && new Date(res["expires_at"] as string).getTime() < Date.now()) {
          for (const it of res["items"] as { sku_id: string; qty: number }[]) inv(it.sku_id)!["available"] = (inv(it.sku_id)!["available"] as number) + it.qty;
          this.releaseCoupons(res["id"]);
          res["status"] = "released";
          n++;
        }
      }
      return json(n);
    }
    if (fn === "confirm_reservation") {
      const res = this.tables.reservations.find((r) => r["id"] === args["p_reservation_id"] && r["shop_id"] === args["p_shop_id"]);
      if (!res) return fail("reservation_not_found");
      const existing = this.tables.orders.find((o) => o["reservation_id"] === res["id"]);
      if (existing) return json(existing["id"]);
      const items = res["items"] as { sku_id: string; qty: number; unit_price_jpy: number }[];
      if (res["status"] === "released") {
        for (const it of items) if ((inv(it.sku_id)!["available"] as number) < it.qty) return fail("insufficient_stock_after_release");
        for (const it of items) inv(it.sku_id)!["available"] = (inv(it.sku_id)!["available"] as number) - it.qty;
      }
      const order = (args["p_order"] ?? {}) as Record<string, unknown>;
      const cust = (res["customer"] ?? {}) as Record<string, unknown>;
      const shipping = Number(res["shipping_jpy"] ?? 0);
      const discount = Number(res["discount_jpy"] ?? 0);
      // 0029: 支払額・通貨が Banto の計算と違えば確定しない（在庫も動かさない）
      const expected = Math.max(0, items.reduce((n, it) => n + it.qty * it.unit_price_jpy, 0) + shipping - discount);
      if (typeof order["amount_paid_jpy"] === "number" && order["amount_paid_jpy"] !== expected) return fail("amount_mismatch");
      if (typeof order["currency"] === "string" && order["currency"].toLowerCase() !== "jpy") return fail("amount_mismatch");
      const id = `order-${++this.seq}`;
      const shopRow = this.tables.shops.find((x) => x["id"] === res["shop_id"])!;
      shopRow["order_seq"] = Number(shopRow["order_seq"] ?? 1000) + 1;
      if (res["status"] === "released") for (const r of this.tables.coupon_redemptions) if (r["reservation_id"] === res["id"] && r["status"] === "released") r["status"] = "held";
      for (const r of this.tables.coupon_redemptions) if (r["reservation_id"] === res["id"] && r["status"] === "held") Object.assign(r, { status: "used", order_id: id });
      for (const g of this.tables.coupon_grants) if (g["reservation_id"] === res["id"] && g["status"] === "held") Object.assign(g, { status: "used", used_at: this.now() });
      // 0050: 予約の購入者情報の同意を注文に写し、会員なら customers にも写す（トリガーの再現）
      const consentAtCheckout = typeof cust["marketing_consent"] === "boolean" ? (cust["marketing_consent"] as boolean) : null;
      if (consentAtCheckout !== null && res["customer_id"]) {
        const member = this.tables.customers.find((x) => x["shop_id"] === res["shop_id"] && x["id"] === res["customer_id"]);
        if (member && member["marketing_consent"] !== consentAtCheckout) { member["marketing_consent"] = consentAtCheckout; member["marketing_consent_at"] = this.now(); member["marketing_consent_source"] = "checkout"; }
      }
      this.tables.orders.push({
        id, shop_id: res["shop_id"], reservation_id: res["id"], status: "paid", number: shopRow["order_seq"], shipping_jpy: shipping, customer_id: res["customer_id"] ?? null, marketing_consent: consentAtCheckout,
        discount_jpy: discount, discounts: res["discounts"] ?? null, amount_paid_jpy: order["amount_paid_jpy"] ?? null,
        total_jpy: Math.max(0, items.reduce((n, it) => n + it.qty * it.unit_price_jpy, 0) + shipping - discount),
        customer_email: cust["customer_email"] ?? order["customer_email"] ?? null, customer_name: cust["customer_name"] ?? order["customer_name"] ?? null,
        shipping_address: cust["shipping_address"] ?? order["shipping_address"] ?? null, payment_provider: order["payment_provider"] ?? null,
        // 0018 のトリガー: 予約の customer.delivery を写す
        delivery: cust["delivery"] && typeof cust["delivery"] === "object" ? cust["delivery"] : null,
        payment_ref: order["payment_ref"] ?? null, shipped_at: null, created_at: this.now(), updated_at: this.now(),
      });
      for (const it of items) {
        const row: Row = { id: `oi-${++this.seq}`, shop_id: res["shop_id"], order_id: id, sku_id: it.sku_id, qty: it.qty, unit_price_jpy: it.unit_price_jpy, discount_jpy: Number((it as Row)["discount_jpy"] ?? 0) };
        // 0017 のトリガー: 確定した時点の税率を残す
        row["tax_rate"] = this.taxRateOf(row);
        this.tables.order_items.push(row);
      }
      res["status"] = "confirmed";
      res["customer"] = null;
      const payload = { order_id: id, order_number: shopRow["order_seq"], shop_id: res["shop_id"], subtotal_jpy: items.reduce((n, it) => n + it.qty * it.unit_price_jpy, 0), shipping_jpy: shipping, total_jpy: items.reduce((n, it) => n + it.qty * it.unit_price_jpy, 0) + shipping, status: "paid", payment_provider: order["payment_provider"] ?? null, customer_id: res["customer_id"] ?? null, items };
      this.enqueue(res["shop_id"] as string, "order.created", payload);
      this.enqueue(res["shop_id"] as string, "order.paid", payload);
      for (const it of items) {
        const available = inv(it.sku_id)!["available"] as number;
        if (available <= 3) this.enqueue(res["shop_id"] as string, "inventory.low", { shop_id: res["shop_id"], sku_id: it.sku_id, available, threshold: 3 });
      }
      return json(id);
    }
    if (fn === "enqueue_hook") return json(this.enqueue(args["p_shop_id"] as string, args["p_event"] as string, (args["p_payload"] ?? {}) as Row));
    if (fn === "claim_hook_deliveries") {
      const out: Row[] = [];
      for (const d of this.tables.hook_deliveries) {
        if (d["status"] !== "pending" || new Date(d["next_attempt_at"] as string).getTime() > Date.now()) continue;
        const e = this.tables.hook_endpoints.find((x) => x["id"] === d["endpoint_id"]);
        if (!e || e["enabled"] !== true) continue;
        d["attempts"] = (d["attempts"] as number) + 1;
        d["next_attempt_at"] = new Date(Date.now() + 600_000).toISOString();
        out.push({ id: d["id"], shop_id: d["shop_id"], endpoint_id: d["endpoint_id"], event: d["event"], payload: d["payload"], attempts: d["attempts"], url: e["url"], settings: e["settings"] ?? {}, created_at: d["created_at"] });
        if (out.length >= Number(args["p_limit"] ?? 50)) break;
      }
      return json(out);
    }
    if (fn === "finish_hook_delivery") {
      const d = this.tables.hook_deliveries.find((x) => x["id"] === args["p_id"]);
      if (d) {
        if (args["p_success"] === true) Object.assign(d, { status: "delivered", delivered_at: this.now(), last_status: args["p_status"], last_error: null });
        else if ((d["attempts"] as number) >= 5) Object.assign(d, { status: "failed", last_status: args["p_status"], last_error: args["p_error"] });
        else Object.assign(d, { next_attempt_at: new Date(Date.now() + 2 ** (d["attempts"] as number) * 60_000).toISOString(), last_status: args["p_status"], last_error: args["p_error"] });
      }
      return new Response(null, { status: 204 });
    }
    if (fn === "record_heartbeat") {
      this.heartbeats.set(String(args["p_name"]), Date.now());
      return new Response(null, { status: 204 });
    }
    if (fn === "restore_shop_data") return this.restoreShopData(String(args["p_shop_id"]), args["p_data"] as Record<string, Row[]>);
    if (fn === "tryon_request") return this.tryonRequest(args);
    if (fn === "member_tryon_requests" || fn === "member_tryon_cancel") {
      // 0026 の再現（世代の確認・取り消せる状態）
      const cust = this.tables.customers.find((c) => c["shop_id"] === args["p_shop_id"] && c["id"] === args["p_customer_id"] && Number(c["session_epoch"] ?? 0) === Number(args["p_epoch"]));
      if (fn === "member_tryon_requests") {
        if (!cust) return json(null);
        return json(
          this.tables.tryon_requests
            .filter((r) => r["shop_id"] === args["p_shop_id"] && r["customer_id"] === args["p_customer_id"])
            .reverse()
            .map((r) => ({
              number: r["number"], status: r["status"], store_id: r["store_id"], store_name: this.tables.stores.find((x) => x["id"] === r["store_id"])?.["name"] ?? "", visit_date: r["visit_date"] ?? null, hold_until: r["hold_until"] ?? null, created_at: r["created_at"],
              items: this.tables.tryon_items.filter((i) => i["request_id"] === r["id"]).map((i) => { const k = this.tables.skus.find((x) => x["id"] === i["sku_id"]); return { name: this.tables.products.find((p) => p["id"] === k?.["product_id"])?.["name"] ?? null, sku: k?.["name"] ?? k?.["code"] ?? null, qty: i["qty"] }; }),
            })),
        );
      }
      if (!cust) return json({ ok: false, reason: "session" });
      const r = this.tables.tryon_requests.find((x) => x["shop_id"] === args["p_shop_id"] && x["customer_id"] === args["p_customer_id"] && x["number"] === Number(args["p_number"]));
      if (!r) return json({ ok: false, reason: "not_found" });
      if (!["requested", "sent", "ready"].includes(String(r["status"]))) return json({ ok: false, reason: "not_cancellable" });
      r["status"] = "cancelled";
      this.enqueue(String(r["shop_id"]), "tryon.updated", { request_id: r["id"], number: r["number"], shop_id: r["shop_id"], store_id: r["store_id"], status: "cancelled", hold_until: r["hold_until"] ?? null, customer_id: r["customer_id"] ?? null });
      return json({ ok: true });
    }
    if (fn === "tryon_contact" || fn === "tryon_line_recipient") {
      const r = this.tables.tryon_requests.find((x) => x["id"] === args["p_request_id"] && x["shop_id"] === args["p_shop_id"]);
      if (!r) return json({ code: "P0001", message: "not_found" }, 400);
      const st = this.tables.stores.find((x) => x["id"] === r["store_id"])!;
      const sh = this.tables.shops.find((x) => x["id"] === r["shop_id"])!;
      if (fn === "tryon_line_recipient") {
        const ident = this.memberIdentities.find((i) => i["shop_id"] === r["shop_id"] && i["customer_id"] === r["customer_id"] && i["provider"] === "line");
        return json(ident ? { line_user_id: ident["subject"], number: r["number"], status: r["status"], hold_until: r["hold_until"] ?? null, store_name: st["name"], shop_name: sh["name"] } : null);
      }
      const items = this.tables.tryon_items.filter((x) => x["request_id"] === r["id"]).map((it) => {
        const sku = this.tables.skus.find((k) => k["id"] === it["sku_id"]);
        const product = this.tables.products.find((p) => p["id"] === sku?.["product_id"]);
        return { name: product?.["name"] ?? null, sku: sku?.["name"] ?? sku?.["code"] ?? null, qty: it["qty"], unit_price_jpy: it["unit_price_jpy"] };
      });
      return json({ ...r, store: st, shop: { name: sh["name"], slug: sh["slug"], domain: sh["domain"] ?? null, contact_email: (sh["settings"] as Row | undefined)?.["contact_email"] ?? null }, items });
    }
    if (fn === "restore_tax" || fn === "restore_history") return json({});
    // 0047: 会員の外部の ID と独自項目を id で突き合わせて戻す
    if (fn === "restore_customer_master") {
      const rows = (((args["p_data"] ?? {}) as Row)["customers"] ?? []) as Row[];
      let n = 0;
      for (const r of rows) {
        const c = this.tables.customers.find((x) => x["shop_id"] === args["p_shop_id"] && x["id"] === r["id"]);
        if (!c || (!r["external_ref"] && !r["attributes"])) continue;
        c["external_ref"] = r["external_ref"] ?? null;
        c["attributes"] = r["attributes"] ?? {};
        n++;
      }
      return json({ customer_master: n });
    }
    if (fn === "shop_secret") return json(this.tables.shop_secret_boxes.find((r) => r["shop_id"] === args["p_shop_id"] && r["purpose"] === args["p_purpose"])?.["secret_box"] ?? null); // 受け口だけ（中身は test/db/tax.test.ts・woo-history.test.ts）
    if (fn === "tryon_expire") {
      // 0025 の再現: 取り置きの期限を過ぎたら期限切れ
      let n = 0;
      for (const r of this.tables.tryon_requests) {
        if (r["status"] === "ready" && r["hold_until"] && String(r["hold_until"]) < String(args["p_today"])) {
          r["status"] = "expired";
          n++;
        }
      }
      return json(n);
    }
    if (fn === "mask_tryon_requests") return json(0);
    if (fn === "restore_commerce") {
      // 0022 の受け口だけ再現（中身は DB テスト test/db/tracking.test.ts）
      this.lastRestoreCommerce = args["p_data"] as Record<string, Row[]>;
      return json({ coupon_campaigns: (this.lastRestoreCommerce["coupon_campaigns"] ?? []).length, coupon_grants: (this.lastRestoreCommerce["coupon_grants"] ?? []).length });
    }
    if (fn === "restore_catalog") {
      // restore_catalog（0008）の再現: カテゴリーを作り、商品・SKU の拡張列を slug / code で戻す
      const shopId = String(args["p_shop_id"]);
      const data = args["p_data"] as Record<string, Row[]>;
      const cmap = new Map<string, string>();
      for (const r of data["categories"] ?? []) cmap.set(String(r["id"]), String(this.addCategory(shopId, { slug: r["slug"], name: r["name"], sort_order: r["sort_order"] ?? 0 })["id"]));
      for (const r of data["categories"] ?? []) if (r["parent_id"] && cmap.has(String(r["parent_id"]))) this.tables.categories.find((c) => c["id"] === cmap.get(String(r["id"])))!["parent_id"] = cmap.get(String(r["parent_id"]));
      let np = 0, nk = 0;
      for (const r of data["products"] ?? []) {
        const p = this.tables.products.find((x) => x["shop_id"] === shopId && x["slug"] === r["slug"]);
        if (!p) continue;
        Object.assign(p, { tags: normalizeTags(r["tags"]), brand: r["brand"] ?? null, attributes: r["attributes"] ?? {}, category_id: cmap.get(String(r["category_id"])) ?? null });
        np++;
      }
      for (const r of data["skus"] ?? []) {
        const k = this.tables.skus.find((x) => x["shop_id"] === shopId && x["code"] === r["code"]);
        if (!k) continue;
        Object.assign(k, { options: r["options"] ?? {}, gtin: r["gtin"] ?? null, compare_at_price_jpy: r["compare_at_price_jpy"] ?? null });
        nk++;
      }
      return json({ categories: cmap.size, products_extended: np, skus_extended: nk });
    }
    if (fn === "restore_product_tags") {
      // restore_product_tags（0007）の再現: slug で突き合わせてタグを戻す
      let n = 0;
      for (const r of (args["p_products"] as Row[]) ?? []) {
        const p = this.tables.products.find((x) => x["shop_id"] === args["p_shop_id"] && x["slug"] === r["slug"]);
        if (p && Array.isArray(r["tags"]) && r["tags"].length > 0) {
          p["tags"] = normalizeTags(r["tags"]);
          n++;
        }
      }
      return json(n);
    }
    if (fn === "record_webhook_event") {
      const key = `${args["p_provider"]}:${args["p_event_id"]}`;
      const fresh = !this.webhookEvents.has(key);
      this.webhookEvents.add(key);
      return json(fresh);
    }
    if (fn === "mask_shipped_orders") {
      const days = Number(args["p_days"] ?? 180);
      let n = 0;
      for (const o of this.tables.orders) {
        if (o["status"] === "shipped" && o["shipped_at"] && new Date(o["shipped_at"] as string).getTime() < Date.now() - days * 86400_000 && o["customer_email"] !== null) {
          Object.assign(o, { customer_email: null, customer_name: "[masked]", shipping_address: null });
          n++;
        }
      }
      return json(n);
    }
    return json({ code: "PGRST202", message: `Could not find the function public.${fn}` }, 404);
  }
}

/** PostgREST の論理式（and(…) / or(…) / 列.演算子.値）。DbClient の filterExpr が作る形だけを読む */
type Logic = { kind: "and" | "or"; items: Logic[] } | { kind: "leaf"; col: string; op: string; value: string; quoted: boolean };

function parseLogic(text: string): Logic {
  let i = 0;
  const node = (): Logic => {
    for (const kind of ["and", "or"] as const) {
      if (text.startsWith(`${kind}(`, i)) {
        i += kind.length + 1;
        const items: Logic[] = [];
        while (text[i] !== ")") {
          items.push(node());
          if (text[i] === ",") i++;
        }
        i++;
        return { kind, items };
      }
    }
    const colEnd = text.indexOf(".", i);
    const col = text.slice(i, colEnd);
    const opEnd = text.indexOf(".", colEnd + 1);
    const op = text.slice(colEnd + 1, opEnd);
    i = opEnd + 1;
    if (text[i] === '"') {
      let v = "";
      for (i++; text[i] !== '"'; i++) v += text[i] === "\\" ? text[++i] : text[i];
      i++;
      return { kind: "leaf", col, op, value: v, quoted: true };
    }
    let v = "";
    while (i < text.length && text[i] !== "," && text[i] !== ")") v += text[i++];
    return { kind: "leaf", col, op, value: v, quoted: false };
  };
  return node();
}

function evalLogic(l: Logic, row: Row): boolean {
  if (l.kind !== "leaf") return l.kind === "and" ? l.items.every((x) => evalLogic(x, row)) : l.items.some((x) => evalLogic(x, row));
  const [base, key] = l.col.split("->>") as [string, string | undefined];
  const raw = key === undefined ? row[base] : ((row[base] ?? {}) as Record<string, unknown>)[key];
  if (l.op === "is") return l.value === "null" ? raw === null || raw === undefined : raw === (l.value === "true");
  if (raw === null || raw === undefined) return false;
  if (l.op === "ilike") {
    // *…* の部分一致だけ（\ でそのままの文字）
    const needle = l.value.replace(/^\*|\*$/g, "").replace(/\\(.)/g, "$1").toLowerCase();
    return String(raw).toLowerCase().includes(needle);
  }
  const num = typeof raw === "number" && !l.quoted;
  const a: string | number = num ? raw : String(raw);
  const b: string | number = num ? Number(l.value) : l.value;
  if (typeof raw === "boolean") return l.op === "eq" ? String(raw) === l.value : String(raw) !== l.value;
  switch (l.op) {
    case "eq": return a === b || (typeof raw === "number" && Number(l.value) === raw);
    case "neq": return a !== b;
    case "lt": return typeof raw === "number" ? raw < Number(l.value) : a < b;
    case "lte": return typeof raw === "number" ? raw <= Number(l.value) : a <= b;
    case "gt": return typeof raw === "number" ? raw > Number(l.value) : a > b;
    case "gte": return typeof raw === "number" ? raw >= Number(l.value) : a >= b;
  }
  return false;
}

/** SKU の id（本物と同じ UUID の形。お店の画面は UUID でない SKU の id を DB に問い合わせない） */
function fakeUuid(n: number): string {
  return `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
}

/** PostgREST の in.(…) の中身。"…" で囲んだ値（\\ と \\" のエスケープ）と、囲まない値の両方を読む */
function parseInList(body: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|([^,]+)/g;
  for (const m of body.matchAll(re)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]!);
  return out;
}

function rlsError(table: string): Response {
  return json({ code: "42501", message: `new row violates row-level security policy for table "${table}"` }, 401);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
