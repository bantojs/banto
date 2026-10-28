import { Hono } from "hono";
import { storefrontSettings } from "../../storefront/mode";
import type { AppEnv } from "../../app";
import { DbError, type DbClient } from "../../db/client";
import type { CategoryRow, CouponCampaignRow, ProductRow, ShopRow } from "../../db/types";
import { t, tf, type MessageKey } from "../../i18n";
import { formatDateTime, isoToZonedInput, zonedInputToIso } from "../../i18n/time";
import { AdminLayout, PageHead } from "../../routes/admin/layout";
import { formFields, owner, param, publicBaseUrl, type AdminContext } from "../../routes/admin/context";
import { shopHome } from "../../storefront/urls";
import { requireOwner } from "../../routes/admin/auth";
import { loadShop } from "../../routes/admin/shops";
import { categoryOptions, loadCategories } from "../../routes/admin/categories";
import { normalizeTags } from "../../products/tags";
import { normalizeCode, type CouponConditions } from "../../commerce/discounts";
import { moduleEnabled } from "../registry";
import { customerFields, type CustomerField } from "../../customers/fields";
import { membersEnabled } from "../../routes/storefront/members";
import { ADMIN_PAGE_SIZE, Pager, olderThan, readAfter, splitPage, type PagePosition } from "../../routes/admin/paging";

/** 管理画面の一覧の材料を表示する分だけ数える（coupon_stats_for）。docs/knowledge/02-decisions.md 2026-10-26 */

/**
 * 同梱モジュール「クーポン」（coupons、既定 OFF）の管理画面。docs/coupons.md
 *   GET  /admin/shops/:shopId/modules/coupons            一覧
 *   GET  .../new                                         作成フォーム
 *   POST .../                                            作成
 *   GET  .../:campaignId                                 編集（使用状況とクーポン付きリンク）
 *   POST .../:campaignId                                 更新
 *   POST .../:campaignId/delete                          削除
 * 書き込みは owner の JWT（RLS）で coupon_campaigns に行う。全体の上限の枠はトリガーが作る（0010）。
 * 判定（カート・確認画面・確定）はコアの src/commerce/discounts.ts で、このモジュールは条件を登録するだけ。
 */
export const couponsAdmin = new Hono<AppEnv>();

export async function scope(c: AdminContext): Promise<ShopRow | null> {
  const shop = await loadShop(c, param(c, "shopId"), "marketing");
  if (!shop || !moduleEnabled(shop.settings, "coupons")) return null;
  return shop;
}

/** キャンペーンの一覧の 1 ページ（新しい順、after より後ろ） */
const loadCampaigns = (db: DbClient, shopId: string, after?: PagePosition) =>
  db.from<CouponCampaignRow>("coupon_campaigns").select("*", { eq: { shop_id: shopId }, where: after ? [olderThan(after)] : [], order: "created_at.desc,id.desc", limit: ADMIN_PAGE_SIZE + 1 });

/** 使われた・押さえ中の数。表示するキャンペーンの分だけ数える（0059） */
async function loadStats(c: AdminContext, shopId: string, campaignIds: string[]): Promise<Record<string, { used: number; held: number }>> {
  const { db } = owner(c);
  try {
    return campaignIds.length === 0 ? {} : ((await db.rpc<Record<string, { used: number; held: number }> | null>("coupon_stats_for", { p_shop_id: shopId, p_campaign_ids: campaignIds })) ?? {});
  } catch {
    return {};
  }
}

const FLASH: Record<string, MessageKey> = {
  saved: "shop.saved",
  deleted: "coupons.deleted",
  code_taken: "coupons.error.code_taken",
  usage_below_used: "coupons.error.usage_below_used",
  invalid: "coupons.error.invalid",
  unknown_products: "coupons.error.unknown_products",
  generic: "error.generic",
};

function flash(code: string | undefined): { kind: "ok" | "error"; text: string } | null {
  const key = code ? FLASH[code] : undefined;
  return key ? { kind: code === "saved" || code === "deleted" ? "ok" : "error", text: t(key) } : null;
}

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

function describeValue(r: CouponCampaignRow): string {
  if (r.kind === "percent") return `${r.value}%`;
  if (r.kind === "fixed") return yen(r.value);
  return t("coupons.kind.free_shipping");
}

/** 一覧の状態の点の色（使える = 緑、これから = 黄、それ以外 = 灰） */
const STATUS_DOT: Partial<Record<MessageKey, string>> = { "coupons.status.active": "on", "coupons.status.scheduled": "warn" };

function statusOf(r: CouponCampaignRow, used: number, now: number): MessageKey {
  if (!r.active) return "coupons.status.inactive";
  if (r.starts_at && Date.parse(r.starts_at) > now) return "coupons.status.scheduled";
  if (r.ends_at && Date.parse(r.ends_at) < now) return "coupons.status.ended";
  if (r.usage_limit !== null && used >= r.usage_limit) return "coupons.status.exhausted";
  return "coupons.status.active";
}

couponsAdmin.get("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const { db } = owner(c);
  const after = readAfter(c.req.query("after"));
  if (after === null) return c.text(t("error.generic"), 400);
  const page = splitPage(await loadCampaigns(db, shop.id, after), (r) => r.created_at);
  const rows = page.rows;
  const stats = await loadStats(c, shop.id, rows.map((r) => r.id));
  const base = `/admin/shops/${shop.id}/modules/coupons`;
  const f = flash(c.req.query("flash"));
  const now = Date.now();
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("mod.coupons.name")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("modules.title"), href: `/admin/shops/${shop.id}/modules` }, { label: t("mod.coupons.name") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "modules" }}>
      <PageHead title={t("mod.coupons.name")}>
        <a class="btn secondary" href={`${base}/import`}>
          {t("coupons.import.title")}
        </a>
        <a class="btn" href={`${base}/new`}>
          {t("coupons.new")}
        </a>
      </PageHead>
      {f ? <p class={f.kind === "ok" ? "notice" : "error"}>{f.text}</p> : null}
        <div>
          <p class="muted" style="margin-top:-.75rem">{t("coupons.intro")}</p>
          {rows.length === 0 ? (
            <div class="empty">
              {t("coupons.none")} <a href={`${base}/new`}>{t("coupons.new")}</a>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t("coupons.name")}</th>
                  <th>{t("coupons.code")}</th>
                  <th>{t("coupons.value")}</th>
                  <th>{t("coupons.period")}</th>
                  <th>{t("coupons.used")}</th>
                  <th>{t("coupons.status")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const s = stats[r.id] ?? { used: 0, held: 0 };
                  return (
                    <tr>
                      <td>
                        <a href={`${base}/${r.id}`}>{r.name}</a>
                      </td>
                      <td>
                        <code>{r.code ?? "-"}</code>
                      </td>
                      <td>{describeValue(r)}</td>
                      <td>
                        {r.starts_at || r.ends_at ? `${r.starts_at ? formatDateTime(r.starts_at) : ""} 〜 ${r.ends_at ? formatDateTime(r.ends_at) : ""}` : t("coupons.always")}
                      </td>
                      <td>
                        {s.used}
                        {r.usage_limit !== null ? ` / ${r.usage_limit}` : ""}
                        {s.held > 0 ? <span class="muted"> {t("coupons.held").replace("{n}", String(s.held))}</span> : null}
                      </td>
                      <td>
                        <span class={`status ${STATUS_DOT[statusOf(r, s.used + s.held, now)] ?? "off"}`}>{t(statusOf(r, s.used + s.held, now))}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <Pager base={base} next={page.next} paged={Boolean(after)} />
        </div>
    </AdminLayout>,
  );
});

interface FormContext {
  shop: ShopRow;
  categories: CategoryRow[];
  products: Pick<ProductRow, "id" | "slug" | "name">[];
  base: string;
}

/** 条件に使える会員の項目（ショップ設定の customer_fields、0047。10 個まで） */
function attributeFields(fc: FormContext): CustomerField[] {
  return customerFields(fc.shop.settings).slice(0, 10);
}

/** フォームの商品の欄（slug を改行・空白・カンマ区切り）→ 小文字の slug の並び */
function slugList(text: string | undefined): string[] {
  return (text ?? "")
    .split(/[\s,、]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * フォームに要る材料。商品はクーポンの条件に書かれた分だけ（表示は id → slug、保存は slug → id）を引く。
 * ショップ全体の商品を読むと、商品が多いショップで 1,000 行の上限に掛かって条件が欠けるため
 */
async function formContext(c: AdminContext, shop: ShopRow, need: { ids?: string[]; slugs?: string[] } = {}): Promise<FormContext> {
  const { db } = owner(c);
  const pick = (col: "id" | "slug", values: string[]) =>
    values.length === 0 ? Promise.resolve([]) : db.from<ProductRow>("products").select("id,slug,name", { eq: { shop_id: shop.id }, in: { [col]: [...new Set(values)].slice(0, 400) } });
  const [categories, byId, bySlug] = await Promise.all([loadCategories(db, shop.id), pick("id", need.ids ?? []), pick("slug", need.slugs ?? [])]);
  const products = [...new Map([...byId, ...bySlug].map((p) => [p.id, p])).values()];
  return { shop, categories, products, base: `/admin/shops/${shop.id}/modules/coupons` };
}

/** 保存のとき: フォームの商品の欄に書かれた slug */
const formSlugs = (f: Record<string, string>) => [...slugList(f["product_slugs"]), ...slugList(f["exclude_product_slugs"])];

function CampaignForm({ fc, row, action, stats, link, claimUrl }: { fc: FormContext; row: Partial<CouponCampaignRow> | null; action: string; stats?: { used: number; held: number }; link?: string | null; claimUrl?: string }) {
  const cond = (row?.conditions ?? {}) as CouponConditions;
  const slugs = (ids: string[] | undefined) => (ids ?? []).map((id) => fc.products.find((p) => p.id === id)?.slug ?? id).join("\n");
  const catBoxes = (name: string, selected: string[] | undefined) => (
    <div style="display:flex;flex-wrap:wrap;gap:.25rem 1rem">
      {categoryOptions(fc.categories).map((o) => (
        <label style="white-space:nowrap">
          <input type="checkbox" name={`${name}_${o.id}`} checked={(selected ?? []).includes(o.id)} /> {o.label.trim()}
        </label>
      ))}
    </div>
  );
  const members = membersEnabled(fc.shop);
  const num = (v: unknown) => (typeof v === "number" ? String(v) : "");
  return (
    <form method="post" action={action}>
      {stats ? (
        <p class="muted">
          {t("coupons.used")}: {stats.used}
          {row?.usage_limit ? ` / ${row.usage_limit}` : ""} {stats.held > 0 ? t("coupons.held").replace("{n}", String(stats.held)) : ""}
        </p>
      ) : null}
      {link ? (
        <p>
          {t("coupons.link")}: <code>{link}</code>
          <br />
          <span class="muted">{t("coupons.link_hint")}</span>
        </p>
      ) : null}
      <label for="name">{t("coupons.name")}</label>
      <input id="name" type="text" name="name" value={row?.name ?? ""} required maxlength={100} />
      <label for="code">{t("coupons.code")}</label>
      <input id="code" type="text" name="code" value={row?.code ?? ""} maxlength={32} pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,31}" style="text-transform:uppercase" />
      <p class="muted">{t("coupons.code_hint")}</p>

      <h2>{t("coupons.discount")}</h2>
      <label for="kind">{t("coupons.kind")}</label>
      <select id="kind" name="kind">
        {(["percent", "fixed", "free_shipping"] as const).map((k) => (
          <option value={k} selected={(row?.kind ?? "percent") === k}>
            {t(`coupons.kind.${k}`)}
          </option>
        ))}
      </select>
      <label for="value">{t("coupons.value")}</label>
      <input id="value" type="number" name="value" min={0} max={10000000} value={row?.value !== undefined ? String(row.value) : ""} style="width:10rem" />
      <p class="muted">{t("coupons.value_hint")}</p>
      <label>
        <input type="checkbox" name="combinable" checked={row?.combinable === true} /> {t("coupons.combinable")}
      </label>

      <h2>{t("coupons.period")}</h2>
      <label for="starts_at">{t("coupons.starts_at")}</label>
      <input id="starts_at" type="datetime-local" name="starts_at" value={isoToZonedInput(row?.starts_at)} />
      <label for="ends_at">{t("coupons.ends_at")}</label>
      <input id="ends_at" type="datetime-local" name="ends_at" value={isoToZonedInput(row?.ends_at)} />
      <p class="muted">{t("coupons.period_hint")}</p>

      <label for="grant_valid_days">{t("grants.valid_days")}</label>
      <input id="grant_valid_days" type="number" name="grant_valid_days" min={1} max={3650} value={num(row?.grant_valid_days)} style="width:10rem" />
      <p class="muted">{t("grants.valid_days_hint")}</p>
      {members ? (
        <div>
          <label for="auto_grant">{t("coupons.auto_grant")}</label>
          <select id="auto_grant" name="auto_grant">
            <option value="">{t("coupons.auto_grant_none")}</option>
            <option value="first_login" selected={row?.auto_grant === "first_login"}>
              {t("coupons.auto_grant_first_login")}
            </option>
            <option value="after_purchase" selected={row?.auto_grant === "after_purchase"}>
              {t("coupons.auto_grant_after_purchase")}
            </option>
          </select>
          <p class="muted">{t("coupons.auto_grant_hint")}</p>
          <label>
            <input type="checkbox" name="claimable" checked={row?.claimable === true} /> {t("coupons.claimable")}
          </label>
          {/* 獲得ページ（/:shop/coupons/:id）は Banto のお店の画面。「使わない」のショップでは外のサイトへ転送されて開けない */}
          {storefrontSettings(fc.shop.settings).mode === "off" ? <p class="notice">{t("coupons.claim_storefront_off")}</p> : null}
          {row?.claimable && row.id && claimUrl ? (
            <p>
              {t("coupons.claim_url")}: <code>{`${claimUrl}/${row.id}`}</code>
            </p>
          ) : null}
        </div>
      ) : null}
      <h2>{t("coupons.limits")}</h2>
      <label for="usage_limit">{t("coupons.usage_limit")}</label>
      <input id="usage_limit" type="number" name="usage_limit" min={1} max={100000} value={num(row?.usage_limit)} style="width:10rem" />
      <p class="muted">{t("coupons.usage_limit_hint")}</p>
      <label for="per_customer_limit">{t("coupons.per_customer_limit")}</label>
      <input id="per_customer_limit" type="number" name="per_customer_limit" min={1} max={1000} value={num(row?.per_customer_limit)} style="width:10rem" />
      <p class="muted">{t("coupons.per_customer_hint")}</p>
      <label for="audience">{t("coupons.audience")}</label>
      <select id="audience" name="audience">
        <option value="public" selected={(row?.audience ?? "public") === "public"}>
          {t("coupons.audience.public")}
        </option>
        <option value="members" selected={row?.audience === "members"} disabled={!members && row?.audience !== "members"}>
          {t("coupons.audience.members")}
        </option>
      </select>
      {!members ? (
        <p class="muted">
          {t("coupons.members_disabled")} <a href={`/admin/shops/${fc.shop.id}#members`}>{t("shop.members_open_settings")}</a>
        </p>
      ) : null}

      <h2>{t("coupons.conditions")}</h2>
      <p class="muted">{t("coupons.conditions_hint")}</p>
      <label for="min_subtotal_jpy">{t("coupons.min_subtotal")}</label>
      <input id="min_subtotal_jpy" type="number" name="min_subtotal_jpy" min={0} value={num(cond.min_subtotal_jpy)} style="width:10rem" />
      <label for="max_subtotal_jpy">{t("coupons.max_subtotal")}</label>
      <input id="max_subtotal_jpy" type="number" name="max_subtotal_jpy" min={0} value={num(cond.max_subtotal_jpy)} style="width:10rem" />
      <label for="min_qty">{t("coupons.min_qty")}</label>
      <input id="min_qty" type="number" name="min_qty" min={0} max={999} value={num(cond.min_qty)} style="width:10rem" />
      <label>
        <input type="checkbox" name="exclude_sale" checked={cond.exclude_sale === true} /> {t("coupons.exclude_sale")}
      </label>
      {fc.categories.length > 0 ? (
        <div>
          <h3>{t("coupons.categories")}</h3>
          {catBoxes("cat", cond.category_ids)}
          <h3>{t("coupons.exclude_categories")}</h3>
          {catBoxes("xcat", cond.exclude_category_ids)}
        </div>
      ) : null}
      <label for="cond_tags">{t("coupons.tags")}</label>
      <input id="cond_tags" type="text" name="cond_tags" value={(cond.tags ?? []).join(", ")} style="width:100%;max-width:40rem" />
      <label for="cond_exclude_tags">{t("coupons.exclude_tags")}</label>
      <input id="cond_exclude_tags" type="text" name="cond_exclude_tags" value={(cond.exclude_tags ?? []).join(", ")} style="width:100%;max-width:40rem" />
      <p class="muted">{t("coupons.tags_hint")}</p>
      <label for="cond_brands">{t("coupons.brands")}</label>
      <input id="cond_brands" type="text" name="cond_brands" value={(cond.brands ?? []).join(", ")} style="width:100%;max-width:40rem" />
      <label for="cond_exclude_brands">{t("coupons.exclude_brands")}</label>
      <input id="cond_exclude_brands" type="text" name="cond_exclude_brands" value={(cond.exclude_brands ?? []).join(", ")} style="width:100%;max-width:40rem" />
      <fieldset>
        <legend>{t("coupons.payment_methods")}</legend>
        <p class="muted" style="margin-top:0">{t("coupons.payment_methods_hint")}</p>
        <label>
          <input type="checkbox" name="pm_stripe" checked={(cond.payment_methods ?? []).includes("stripe")} /> {t("coupons.pm_stripe")}
        </label>
        <label>
          <input type="checkbox" name="pm_komoju" checked={(cond.payment_methods ?? []).includes("komoju")} /> {t("coupons.pm_komoju_all")}
        </label>
        <label for="pm_komoju_types">{t("coupons.pm_komoju_types")}</label>
        <input
          id="pm_komoju_types"
          type="text"
          name="pm_komoju_types"
          value={(cond.payment_methods ?? []).filter((m) => m.startsWith("komoju:")).map((m) => m.slice(7)).join(", ")}
          placeholder="credit_card, paypay"
        />
      </fieldset>
      <fieldset>
        <legend>{t("coupons.attributes")}</legend>
        <p class="muted" style="margin-top:0">{t("coupons.attributes_hint")}</p>
        {attributeFields(fc).length === 0 ? (
          <p class="muted">{t("coupons.attributes_none")}</p>
        ) : (
          attributeFields(fc).map((fd) => {
            const allowed = ((cond.attributes ?? {})[fd.key] ?? []).map((v) => String(v));
            return fd.type === "select" ? (
              <div>
                <strong>{fd.label}</strong>
                {(fd.options ?? []).map((o, i) => (
                  <label style="margin-left:0.75rem">
                    <input type="checkbox" name={`attr_${fd.key}__${i}`} checked={allowed.includes(o)} /> {o}
                  </label>
                ))}
              </div>
            ) : (
              <label>
                {fd.label}（{t("coupons.attributes_values")}）
                <input type="text" name={`attr_${fd.key}`} value={allowed.join(", ")} style="width:100%;max-width:40rem" />
              </label>
            );
          })
        )}
      </fieldset>
      <label for="product_slugs">{t("coupons.products")}</label>
      <textarea id="product_slugs" name="product_slugs" rows={3}>
        {slugs(cond.product_ids)}
      </textarea>
      <label for="exclude_product_slugs">{t("coupons.exclude_products")}</label>
      <textarea id="exclude_product_slugs" name="exclude_product_slugs" rows={3}>
        {slugs(cond.exclude_product_ids)}
      </textarea>
      <p class="muted">{t("coupons.products_hint")}</p>

      <h2>{t("coupons.status")}</h2>
      <label>
        <input type="checkbox" name="active" checked={row ? row.active !== false : true} /> {t("coupons.active")}
      </label>
      <p>
        <button type="submit">{t("coupons.save")}</button>
      </p>
    </form>
  );
}

/** フォーム → 行。形の違う値は invalid、存在しない商品のスラッグは unknown_products */
function campaignValues(f: Record<string, string>, fc: FormContext): Partial<CouponCampaignRow> | "invalid" | "unknown_products" {
  const name = (f.name ?? "").trim().slice(0, 100);
  // コードは任意（空なら、発行して配るだけのクーポン。0019）
  const codeRaw = (f.code ?? "").trim();
  const code = codeRaw ? normalizeCode(codeRaw) : null;
  const kind = f.kind === "fixed" || f.kind === "free_shipping" ? f.kind : f.kind === "percent" ? "percent" : null;
  if (!name || (codeRaw && !code) || !kind) return "invalid";
  const int = (v: string | undefined, min: number, max: number): number | null | "bad" => {
    const s = (v ?? "").trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isInteger(n) && n >= min && n <= max ? n : "bad";
  };
  const value = kind === "free_shipping" ? 0 : int(f.value, 1, kind === "percent" ? 100 : 10_000_000);
  if (value === null || value === "bad") return "invalid";
  const usage = int(f.usage_limit, 1, 100_000);
  const perCustomer = int(f.per_customer_limit, 1, 1000);
  const minSub = int(f.min_subtotal_jpy, 0, 100_000_000);
  const maxSub = int(f.max_subtotal_jpy, 0, 100_000_000);
  const minQty = int(f.min_qty, 0, 999);
  const validDays = int(f.grant_valid_days, 1, 3650);
  const autoGrant = f.auto_grant === "first_login" || f.auto_grant === "after_purchase" ? f.auto_grant : null;
  if ([usage, perCustomer, minSub, maxSub, minQty, validDays].includes("bad")) return "invalid";
  const startsAt = f.starts_at ? zonedInputToIso(f.starts_at) : null;
  const endsAt = f.ends_at ? zonedInputToIso(f.ends_at) : null;
  if ((f.starts_at && !startsAt) || (f.ends_at && !endsAt) || (startsAt && endsAt && startsAt >= endsAt)) return "invalid";
  const bySlug = new Map(fc.products.map((p) => [p.slug, p.id]));
  const productIds = (text: string | undefined): string[] | "unknown" => {
    const wanted = slugList(text);
    const out: string[] = [];
    for (const w of wanted) {
      const id = bySlug.get(w);
      if (!id) return "unknown";
      if (!out.includes(id)) out.push(id);
    }
    return out.slice(0, 200);
  };
  const include = productIds(f.product_slugs);
  const exclude = productIds(f.exclude_product_slugs);
  if (include === "unknown" || exclude === "unknown") return "unknown_products";
  const cats = (prefix: string) => fc.categories.filter((cat) => f[`${prefix}_${cat.id}`] === "on").map((cat) => cat.id);
  const conditions: CouponConditions = {};
  if (minSub !== null) conditions.min_subtotal_jpy = minSub as number;
  if (maxSub !== null) conditions.max_subtotal_jpy = maxSub as number;
  if (minQty !== null && minQty !== 0) conditions.min_qty = minQty as number;
  if (f.exclude_sale === "on") conditions.exclude_sale = true;
  if (include.length > 0) conditions.product_ids = include;
  if (exclude.length > 0) conditions.exclude_product_ids = exclude;
  const inc = cats("cat");
  const exc = cats("xcat");
  if (inc.length > 0) conditions.category_ids = inc;
  if (exc.length > 0) conditions.exclude_category_ids = exc;
  const tags = normalizeTags(f.cond_tags ?? "");
  const excludeTags = normalizeTags(f.cond_exclude_tags ?? "");
  if (tags.length > 0) conditions.tags = tags;
  if (excludeTags.length > 0) conditions.exclude_tags = excludeTags;
  const names = (v: string | undefined) => [...new Set((v ?? "").split(/[,、\n]/).map((x) => x.trim().slice(0, 100)).filter(Boolean))].slice(0, 20);
  const brands = names(f.cond_brands);
  const excludeBrands = names(f.cond_exclude_brands);
  if (brands.length > 0) conditions.brands = brands;
  if (excludeBrands.length > 0) conditions.exclude_brands = excludeBrands;
  // 支払い方法: どれにも印が無ければ条件なし（どの支払い方法でも使える）
  const komojuTypes = (f.pm_komoju_types ?? "").split(/[\s,、]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (komojuTypes.some((x) => !/^[a-z_]{1,40}$/.test(x))) return "invalid";
  const methods = [...(f.pm_stripe === "on" ? ["stripe"] : []), ...(f.pm_komoju === "on" ? ["komoju"] : komojuTypes.map((x) => `komoju:${x}`))];
  if (methods.length > 0) conditions.payment_methods = [...new Set(methods)].slice(0, 20);
  // 会員の項目の条件（0049）: select は選択肢の印、それ以外はカンマ区切りの値。空なら条件なし
  const attributes: Record<string, (string | number)[]> = {};
  for (const fd of attributeFields(fc)) {
    const values =
      fd.type === "select"
        ? (fd.options ?? []).filter((_, i) => f[`attr_${fd.key}__${i}`] === "on")
        : [...new Set((f[`attr_${fd.key}`] ?? "").split(/[,、\n]/).map((x) => x.trim().slice(0, 100)).filter(Boolean))].slice(0, 20);
    if (values.length > 0) attributes[fd.key] = values;
  }
  if (Object.keys(attributes).length > 0) conditions.attributes = attributes;
  return {
    name,
    code,
    kind,
    value: value as number,
    starts_at: startsAt,
    ends_at: endsAt,
    usage_limit: usage as number | null,
    per_customer_limit: perCustomer as number | null,
    combinable: f.combinable === "on",
    audience: f.audience === "members" ? "members" : "public",
    conditions: conditions as Record<string, unknown>,
    active: f.active === "on",
    grant_valid_days: validDays as number | null,
    auto_grant: autoGrant,
    claimable: f.claimable === "on",
  };
}

function errorCode(e: unknown): string {
  if (!(e instanceof DbError)) throw e;
  if (e.status === 409 || /duplicate key/.test(e.message)) return "code_taken";
  if (/usage_limit_below_used/.test(e.message)) return "usage_below_used";
  if (e.status === 400) return "invalid";
  return "generic";
}

couponsAdmin.get("/new", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const fc = await formContext(c, shop);
  const f = flash(c.req.query("flash"));
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("coupons.new")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("mod.coupons.name"), href: fc.base }, { label: t("coupons.new") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "modules" }}>
      <PageHead title={t("coupons.new")} />
      {f ? <p class={f.kind === "ok" ? "notice" : "error"}>{f.text}</p> : null}
      <CampaignForm fc={fc} row={null} action={fc.base} />
    </AdminLayout>,
  );
});

couponsAdmin.post("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const form = await formFields(c);
  const fc = await formContext(c, shop, { slugs: formSlugs(form) });
  const v = campaignValues(form, fc);
  if (typeof v === "string") return c.redirect(`${fc.base}/new?flash=${v}`);
  try {
    const [row] = await owner(c).db.from<CouponCampaignRow>("coupon_campaigns").insert({ ...v, shop_id: shop.id });
    return c.redirect(`${fc.base}/${row!.id}?flash=saved`);
  } catch (e) {
    return c.redirect(`${fc.base}/new?flash=${errorCode(e)}`);
  }
});

couponsAdmin.get("/:campaignId", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const { db } = owner(c);
  const row = await db.from<CouponCampaignRow>("coupon_campaigns").selectOne("*", { eq: { id: param(c, "campaignId"), shop_id: shop.id } });
  if (!row) return c.notFound();
  const cond = (row.conditions ?? {}) as CouponConditions;
  const gafter = readAfter(c.req.query("gafter"));
  if (gafter === null) return c.text(t("error.generic"), 400);
  const [fc, stats, grants] = await Promise.all([formContext(c, shop, { ids: [...(cond.product_ids ?? []), ...(cond.exclude_product_ids ?? [])] }), loadStats(c, shop.id, [row.id]), loadGrants(c, shop.id, row.id, gafter)]);
  const f = flash(c.req.query("flash"));
  const link = row.code ? `${shopHome(publicBaseUrl(c), shop)}/cart?coupon=${encodeURIComponent(row.code)}` : null;
  return c.html(
    <AdminLayout title={`${shop.name} · ${row.name}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("mod.coupons.name"), href: fc.base }, { label: row.name }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "modules" }}>
      <PageHead title={row.name} />
      {f ? <p class={f.kind === "ok" ? "notice" : "error"}>{f.text}</p> : null}
      <CampaignForm fc={fc} row={row} action={`${fc.base}/${row.id}`} stats={stats[row.id] ?? { used: 0, held: 0 }} link={link} claimUrl={`${shopHome(publicBaseUrl(c), shop)}/coupons`} />
      <GrantsSection fc={fc} row={row} grants={grants} flash={c.req.query("grants")} />
      <form method="post" action={`${fc.base}/${row.id}/delete`}>
        <p class="muted">{t("coupons.delete_hint")}</p>
        <button type="submit">{t("coupons.delete")}</button>
      </form>
    </AdminLayout>,
  );
});

couponsAdmin.post("/:campaignId", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const form = await formFields(c);
  const fc = await formContext(c, shop, { slugs: formSlugs(form) });
  const id = param(c, "campaignId");
  const v = campaignValues(form, fc);
  if (typeof v === "string") return c.redirect(`${fc.base}/${id}?flash=${v}`);
  try {
    const rows = await owner(c).db.from<CouponCampaignRow>("coupon_campaigns").update(v, { id, shop_id: shop.id });
    if (rows.length === 0) return c.notFound();
    return c.redirect(`${fc.base}/${id}?flash=saved`);
  } catch (e) {
    return c.redirect(`${fc.base}/${id}?flash=${errorCode(e)}`);
  }
});

// ---------- 発行して配るクーポン（0019） ----------

interface GrantRow {
  id: string;
  code: string;
  customer_id: string | null;
  status: "available" | "held" | "used" | "revoked";
  expires_at: string | null;
  created_at: string;
}

/** 発行済みのクーポン（新しい順に最大 5,000） */
const GRANT_STATUSES = ["available", "held", "used", "revoked"] as const;
/** 配布用のコードの CSV に入れる上限（使える・会員に結んでいないものの新しい順） */
const GRANTS_CSV_MAX = 10000;

/** 発行したクーポン: 状態ごとの数（DB で数える）と、新しい順の 1 ページ（after より後ろ） */
async function loadGrants(c: AdminContext, shopId: string, campaignId: string, after?: PagePosition) {
  const { db } = owner(c);
  // 状態ごとの数: 権限を 1 回確かめて数える関数（0059。RLS 越しだと行ごとに権限の関数を呼ぶので 10 万枚で秒単位）
  const countAll = async (): Promise<number[]> => {
    const r = (await db.rpc<Record<string, number> | null>("coupon_grant_counts", { p_shop_id: shopId, p_campaign_id: campaignId })) ?? {};
    return GRANT_STATUSES.map((st) => Number(r[st] ?? 0));
  };
  const [counts, rows] = await Promise.all([
    countAll(),
    db.from<GrantRow>("coupon_grants").select("id,code,customer_id,status,expires_at,created_at", { eq: { campaign_id: campaignId }, where: after ? [olderThan(after)] : [], order: "created_at.desc,id.desc", limit: ADMIN_PAGE_SIZE + 1 }),
  ]);
  return { counts: Object.fromEntries(GRANT_STATUSES.map((st, i) => [st, counts[i]!])) as Record<GrantRow["status"], number>, ...splitPage(rows, (g) => g.created_at), paged: Boolean(after) };
}

function GrantsSection({ fc, row, grants, flash }: { fc: FormContext; row: CouponCampaignRow; grants: Awaited<ReturnType<typeof loadGrants>>; flash?: string }) {
  const base = `${fc.base}/${row.id}/grants`;
  const count = (s: GrantRow["status"]) => grants.counts[s];
  const total = GRANT_STATUSES.reduce((n, st) => n + grants.counts[st], 0);
  return (
    <section>
      <h2 id="grants">{t("grants.title")}</h2>
      <p class="muted">{t("grants.intro")}</p>
      {flash === "issued" ? <p class="notice">{t("grants.issued")}</p> : null}
      {flash === "none" ? <p class="error">{t("grants.none_issued")}</p> : null}
      {flash === "invalid" ? <p class="error">{t("grants.invalid")}</p> : null}
      <p>{tf("grants.counts", { available: count("available"), held: count("held"), used: count("used"), revoked: count("revoked") })}</p>
      {membersEnabled(fc.shop) ? (
        <form method="post" action={`${base}/members`}>
          <h3>{t("grants.to_members")}</h3>
          <label>
            <input type="checkbox" name="all" value="on" /> {t("grants.all_members")}
          </label>
          <label for="emails">{t("grants.emails")}</label>
          <textarea id="emails" name="emails" rows={3} placeholder="a@example.com"></textarea>
          <p>
            <button type="submit">{t("grants.issue")}</button>
          </p>
        </form>
      ) : null}
      <form method="post" action={`${base}/codes`}>
        <h3>{t("grants.codes")}</h3>
        <label for="count">{t("grants.count")}</label>
        <input id="count" type="number" name="count" min={1} max={5000} value="10" style="width:8rem" />
        <p>
          <button type="submit">{t("grants.issue")}</button>
        </p>
      </form>
      {total > 0 ? (
        <p>
          <a href={`${base}.csv`}>{t("grants.csv")}</a>
        </p>
      ) : null}
      {grants.rows.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t("coupons.code")}</th>
              <th>{t("grants.owner")}</th>
              <th>{t("coupons.status")}</th>
              <th>{t("grants.expires")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {grants.rows.map((g) => (
              <tr>
                <td>
                  <code>{g.code}</code>
                </td>
                <td>{g.customer_id ? t("grants.member") : t("grants.anyone")}</td>
                <td>{t(`grants.status_${g.status}` as MessageKey)}</td>
                <td>{g.expires_at ? formatDateTime(g.expires_at) : "-"}</td>
                <td>
                  {g.status === "available" ? (
                    <form method="post" action={`${base}/${g.id}/revoke`} style="display:inline">
                      <button type="submit">{t("grants.revoke")}</button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <Pager base={`${fc.base}/${row.id}`} param="gafter" next={grants.next} paged={grants.paged} />
    </section>
  );
}

async function issue(c: AdminContext, customerIds: string[], count: number): Promise<Response> {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const id = param(c, "campaignId");
  const back = `/admin/shops/${shop.id}/modules/coupons/${id}`;
  try {
    const r = await owner(c).db.rpc<{ issued: number }>("coupon_grants_issue", { p_shop_id: shop.id, p_campaign_id: id, p_customer_ids: customerIds, p_count: count });
    return c.redirect(`${back}?grants=${r && r.issued > 0 ? "issued" : "none"}#grants`);
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${back}?grants=invalid#grants`);
    throw e;
  }
}

couponsAdmin.post("/:campaignId/grants/members", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const f = await formFields(c);
  const { db } = owner(c);
  let ids: string[];
  // PostgREST は 1 回 1,000 行までなので、ページを送って読む（最大 5,000 人）
  const allCustomers = async () => {
    const out: { id: string; email: string | null }[] = [];
    for (let offset = 0; offset < 5000; offset += 1000) {
      const page = await db.from<{ id: string; email: string | null }>("customers").select("id,email", { eq: { shop_id: shop.id }, order: "created_at.asc", limit: 1000, offset });
      out.push(...page);
      if (page.length < 1000) break;
    }
    return out;
  };
  if (f.all === "on") {
    ids = (await allCustomers()).map((r) => r.id);
  } else {
    const wanted = new Set(
      (f.emails ?? "")
        .split(/[\s,、]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    );
    if (wanted.size === 0 || wanted.size > 5000) return c.redirect(`/admin/shops/${shop.id}/modules/coupons/${param(c, "campaignId")}?grants=invalid#grants`);
    ids = (await allCustomers()).filter((r) => r.email && wanted.has(r.email.toLowerCase())).map((r) => r.id);
  }
  return issue(c, ids, 0);
});

couponsAdmin.post("/:campaignId/grants/codes", requireOwner, async (c: AdminContext) => {
  const n = Number.parseInt((await formFields(c)).count ?? "", 10);
  if (!Number.isInteger(n) || n < 1 || n > 5000) {
    const shop = await scope(c);
    return shop ? c.redirect(`/admin/shops/${shop.id}/modules/coupons/${param(c, "campaignId")}?grants=invalid#grants`) : c.notFound();
  }
  return issue(c, [], n);
});

couponsAdmin.post("/:campaignId/grants/:grantId/revoke", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  await owner(c).db.rpc("coupon_grant_revoke", { p_shop_id: shop.id, p_grant_id: param(c, "grantId") });
  return c.redirect(`/admin/shops/${shop.id}/modules/coupons/${param(c, "campaignId")}#grants`);
});

/** 使い捨てコードの一覧（配布用）。会員に発行したものは含めない（会員はマイクーポンで見る） */
couponsAdmin.get("/:campaignId/grants.csv", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const { db } = owner(c);
  const codes: GrantRow[] = [];
  // 1 回 1,000 行まで。新しい順に GRANTS_CSV_MAX 件まで
  for (let after: PagePosition | undefined; codes.length < GRANTS_CSV_MAX; ) {
    const page = await db.from<GrantRow>("coupon_grants").select("id,code,expires_at,created_at", {
      eq: { campaign_id: param(c, "campaignId"), shop_id: shop.id, status: "available" },
      where: [{ col: "customer_id", op: "is", value: null }, ...(after ? [olderThan(after)] : [])],
      order: "created_at.desc,id.desc",
      limit: 1000,
    });
    codes.push(...page);
    if (page.length < 1000) break;
    const last = page[page.length - 1]!;
    after = { k: last.created_at, id: last.id };
  }
  const rows = codes.slice(0, GRANTS_CSV_MAX).map((g) => `${g.code},${g.expires_at ?? ""}`);
  return c.body(`\uFEFFcode,expires_at\r\n${rows.join("\r\n")}\r\n`, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="coupon-codes-${param(c, "campaignId").slice(0, 8)}.csv"`, "Cache-Control": "no-store" });
});

couponsAdmin.post("/:campaignId/delete", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const base = `/admin/shops/${shop.id}/modules/coupons`;
  await owner(c).db.from<CouponCampaignRow>("coupon_campaigns").delete({ id: param(c, "campaignId"), shop_id: shop.id });
  return c.redirect(`${base}?flash=deleted`);
});
