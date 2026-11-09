import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { CategoryRow, ShopRow } from "../../db/types";
import { t, tf, type MessageKey } from "../../i18n";
import { isoToZonedInput, zonedInputToIso, formatDateTime } from "../../i18n/time";
import { AdminLayout, PageHead } from "../../routes/admin/layout";
import { owner, param, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { loadShop } from "../../routes/admin/shops";
import { loadCategories } from "../../routes/admin/categories";
import { moduleEnabled } from "../registry";
import { AUDIENCES_MODULE, audienceDisplayOnly } from "../../members/audience";
import { yen } from "../../routes/common";

/**
 * 会員価格の決まり（同梱モジュール audiences の段 D、0099、docs/audiences.md「会員価格」）。
 *   GET  /admin/shops/:shopId/modules/audiences/prices            一覧
 *   GET  /admin/shops/:shopId/modules/audiences/prices/new        作る
 *   GET  /admin/shops/:shopId/modules/audiences/prices/:id        直す
 *   POST /admin/shops/:shopId/modules/audiences/prices[/:id]      保存
 *   POST /admin/shops/:shopId/modules/audiences/prices/:id/delete 消す
 * 単価を決めるのは DB（banto_sku_member_price）。ここは決まりを登録するだけ（形の確かめも DB の banto_price_rules_guard）。
 * 対象は「商品・SKU を指定」と「カテゴリー・タグ・ブランドのどれかに当てはまる商品」の和。それより細かい条件は JSON の欄で
 */
export const priceRulesAdmin = new Hono<AppEnv>();

interface PriceRuleRow {
  id: string;
  name: string;
  audience_id: string;
  product_ids: string[];
  sku_ids: string[];
  product_condition: unknown;
  price_jpy: number | null;
  percent_off: number | null;
  starts_at: string | null;
  ends_at: string | null;
  enabled: boolean;
}

/** 入れたまま描き直すための値（保存できなかったとき） */
interface Draft {
  name: string;
  audience_id: string;
  products: string;
  skus: string;
  categories: string[];
  tags: string;
  brands: string;
  json: string;
  kind: "price" | "percent";
  amount: string;
  starts: string;
  ends: string;
  enabled: boolean;
}

async function scope(c: AdminContext): Promise<ShopRow | null> {
  const shop = await loadShop(c, param(c, "shopId"), "marketing");
  return shop && moduleEnabled(shop.settings, AUDIENCES_MODULE) ? shop : null;
}

const base = (shop: ShopRow) => `/admin/shops/${shop.id}/modules/audiences/prices`;
const list = (s: string) => s.split(/[,、\n]/).map((v) => v.trim()).filter(Boolean);

async function audiencesOf(c: AdminContext, shop: ShopRow) {
  const rows = await owner(c).db.from<{ id: string; name: string; condition: unknown }>("audiences").select("id,name,condition", { eq: { shop_id: shop.id }, order: "name.asc", limit: 200 });
  return rows.filter((r) => !audienceDisplayOnly(r.condition)).map((r) => ({ id: r.id, name: r.name }));
}

/** 保存してある決まり → 画面の値（商品・SKU は slug・品番に戻す。条件が組み立てで表せなければ JSON の欄に） */
async function toDraft(c: AdminContext, shop: ShopRow, r: PriceRuleRow): Promise<Draft> {
  const db = owner(c).db;
  const [products, skus] = await Promise.all([
    r.product_ids.length ? db.from<{ id: string; slug: string }>("products").select("id,slug", { eq: { shop_id: shop.id }, in: { id: r.product_ids } }) : [],
    r.sku_ids.length ? db.from<{ id: string; code: string }>("skus").select("id,code", { eq: { shop_id: shop.id }, in: { id: r.sku_ids } }) : [],
  ]);
  const simple = simpleCondition(r.product_condition);
  return {
    name: r.name,
    audience_id: r.audience_id,
    products: products.map((p) => p.slug).join(", "),
    skus: skus.map((k) => k.code).join(", "),
    categories: simple?.category ?? [],
    tags: (simple?.tag ?? []).join(", "),
    brands: (simple?.brand ?? []).join(", "),
    json: r.product_condition && !simple ? JSON.stringify(r.product_condition, null, 2) : "",
    kind: r.price_jpy !== null ? "price" : "percent",
    amount: String(r.price_jpy ?? r.percent_off ?? ""),
    starts: isoToZonedInput(r.starts_at),
    ends: isoToZonedInput(r.ends_at),
    enabled: r.enabled,
  };
}

/** { any: [{category}, {tag}, {brand}] }（それぞれ 0〜1 個）だけを組み立ての欄に戻せる */
function simpleCondition(cond: unknown): { category?: string[]; tag?: string[]; brand?: string[] } | null {
  if (cond === null || cond === undefined) return {};
  if (!cond || typeof cond !== "object") return null;
  const o = cond as Record<string, unknown>;
  const leaves = Array.isArray(o["any"]) ? (o["any"] as unknown[]) : [cond];
  const out: { category?: string[]; tag?: string[]; brand?: string[] } = {};
  for (const l of leaves) {
    if (!l || typeof l !== "object") return null;
    const keys = Object.keys(l);
    const k = keys[0];
    if (keys.length !== 1 || (k !== "category" && k !== "tag" && k !== "brand") || out[k] || !Array.isArray((l as Record<string, unknown>)[k])) return null;
    out[k] = ((l as Record<string, unknown>)[k] as unknown[]).map(String);
  }
  return out;
}

function describe(r: PriceRuleRow, audiences: Map<string, string>): string {
  const price = r.price_jpy !== null ? yen(r.price_jpy) : tf("mprice.percent_label", { n: String(r.percent_off) });
  return `${audiences.get(r.audience_id) ?? "?"} · ${price}`;
}

const FLASH: Record<string, { kind: "ok" | "error"; key: MessageKey }> = {
  saved: { kind: "ok", key: "mprice.saved" },
  deleted: { kind: "ok", key: "mprice.deleted" },
};

priceRulesAdmin.get("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const [rows, audiences] = await Promise.all([
    owner(c).db.from<PriceRuleRow>("price_rules").select("*", { eq: { shop_id: shop.id }, order: "name.asc", limit: 500 }),
    owner(c).db.from<{ id: string; name: string }>("audiences").select("id,name", { eq: { shop_id: shop.id }, limit: 200 }),
  ]);
  const names = new Map(audiences.map((a) => [a.id, a.name]));
  const fl = FLASH[c.req.query("flash") ?? ""];
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("mprice.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("aud.title"), href: `/admin/shops/${shop.id}/modules/audiences` }, { label: t("mprice.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "modules", here: "member-prices" }}>
      <PageHead title={t("mprice.title")} sub={t("mprice.intro")}>
        <a class="btn" href={`${base(shop)}/new`}>
          {t("mprice.add")}
        </a>
      </PageHead>
      {fl ? <p class={fl.kind === "ok" ? "notice" : "error"}>{t(fl.key)}</p> : null}
      {rows.length === 0 ? (
        <p class="muted">{t("mprice.none")}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("mprice.name")}</th>
              <th>{t("mprice.summary")}</th>
              <th>{t("mprice.period")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td>
                  <a href={`${base(shop)}/${r.id}`}>{r.name}</a>
                </td>
                <td>{describe(r, names)}</td>
                <td>
                  {r.starts_at ? formatDateTime(r.starts_at) : ""}
                  {r.starts_at || r.ends_at ? " 〜 " : ""}
                  {r.ends_at ? formatDateTime(r.ends_at) : ""}
                </td>
                <td>{r.enabled ? "" : <span class="status off">{t("mprice.disabled")}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p class="muted">{t("mprice.hint")}</p>
    </AdminLayout>,
  );
});

function EditPage(props: { shop: ShopRow; id: string | null; draft: Draft; audiences: { id: string; name: string }[]; categories: CategoryRow[]; access: { role: string; perms: readonly string[] } | undefined; error?: string }) {
  const { shop, draft: d } = props;
  const action = props.id ? `${base(shop)}/${props.id}` : base(shop);
  return (
    <AdminLayout title={`${shop.name} · ${t("mprice.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("mprice.title"), href: base(shop) }, { label: d.name || t("mprice.add") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: props.access, active: "modules", here: "member-prices" }}>
      <PageHead title={d.name || t("mprice.add")} />
      {props.error ? (
        <p class="error" role="alert">
          {props.error}
        </p>
      ) : null}
      <form method="post" action={action} class="card">
        <label for="name">{t("mprice.name")}</label>
        <input id="name" name="name" required maxlength={60} value={d.name} />
        <label for="audience_id">{t("mprice.audience")}</label>
        <select id="audience_id" name="audience_id" required>
          <option value="">—</option>
          {props.audiences.map((a) => (
            <option value={a.id} selected={a.id === d.audience_id}>
              {a.name}
            </option>
          ))}
        </select>
        <fieldset>
          <legend>{t("mprice.target")}</legend>
          <p class="muted">{t("mprice.target_hint")}</p>
          <label for="products">{t("mprice.products")}</label>
          <input id="products" name="products" value={d.products} placeholder="tee, cap" style="width:100%;max-width:40rem" />
          <label for="skus">{t("mprice.skus")}</label>
          <input id="skus" name="skus" value={d.skus} placeholder="TEE-M, TEE-L" style="width:100%;max-width:40rem" />
          {props.categories.length > 0 ? (
            <>
              <p style="margin-bottom:.25rem">{t("mprice.categories")}</p>
              <div style="display:flex;flex-wrap:wrap;gap:.25rem 1rem">
                {props.categories.map((cat) => (
                  <label style="display:inline">
                    <input type="checkbox" name={`cat_${cat.id}`} value="on" checked={d.categories.includes(cat.id)} /> {cat.name}
                  </label>
                ))}
              </div>
            </>
          ) : null}
          <label for="tags">{t("mprice.tags")}</label>
          <input id="tags" name="tags" value={d.tags} style="width:100%;max-width:40rem" />
          <label for="brands">{t("mprice.brands")}</label>
          <input id="brands" name="brands" value={d.brands} style="width:100%;max-width:40rem" />
          <details open={Boolean(d.json)}>
            <summary>{t("mprice.json")}</summary>
            <p class="muted">{t("mprice.json_hint")}</p>
            <textarea name="condition_json" rows={6} style="width:100%;font-family:monospace">
              {d.json}
            </textarea>
          </details>
        </fieldset>
        <fieldset>
          <legend>{t("mprice.price")}</legend>
          <label style="display:block">
            <input type="radio" name="kind" value="price" checked={d.kind === "price"} /> {t("mprice.kind_price")}
          </label>
          <label style="display:block">
            <input type="radio" name="kind" value="percent" checked={d.kind === "percent"} /> {t("mprice.kind_percent")}
          </label>
          <input name="amount" value={d.amount} required inputmode="numeric" pattern="[0-9]{1,8}" aria-label={t("mprice.price")} style="width:10rem" />
          <p class="muted">{t("mprice.price_hint")}</p>
        </fieldset>
        <label for="starts">{t("mprice.starts")}</label>
        <input id="starts" type="datetime-local" name="starts" value={d.starts} />
        <label for="ends">{t("mprice.ends")}</label>
        <input id="ends" type="datetime-local" name="ends" value={d.ends} />
        <label style="display:block;margin-top:.75rem">
          <input type="checkbox" name="enabled" value="on" checked={d.enabled} /> {t("mprice.enabled")}
        </label>
        <p>
          <button type="submit">{t("shop.save")}</button>{" "}
          <a class="btn secondary" href={base(shop)}>
            {t("aud.cancel")}
          </a>
        </p>
      </form>
      {props.id ? (
        <form method="post" action={`${base(shop)}/${props.id}/delete`}>
          <button type="submit" class="secondary small">
            {t("mprice.delete")}
          </button>
        </form>
      ) : null}
    </AdminLayout>
  );
}

const EMPTY: Draft = { name: "", audience_id: "", products: "", skus: "", categories: [], tags: "", brands: "", json: "", kind: "percent", amount: "", starts: "", ends: "", enabled: true };

async function page(c: AdminContext, shop: ShopRow, id: string | null, draft: Draft, error?: string, status: 200 | 400 = 200) {
  const [audiences, categories] = await Promise.all([audiencesOf(c, shop), loadCategories(owner(c).db, shop.id)]);
  return c.html(<EditPage shop={shop} id={id} draft={draft} audiences={audiences} categories={categories} access={c.get("shopAccess")} {...(error ? { error } : {})} />, status);
}

priceRulesAdmin.get("/new", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  return page(c, shop, null, EMPTY);
});

priceRulesAdmin.get("/:id", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const [row] = await owner(c).db.from<PriceRuleRow>("price_rules").select("*", { eq: { id: param(c, "id"), shop_id: shop.id }, limit: 1 });
  if (!row) return c.notFound();
  return page(c, shop, row.id, await toDraft(c, shop, row));
});

async function save(c: AdminContext, id: string | null) {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const f = (await c.req.parseBody()) as Record<string, string | File>;
  const s = (k: string) => (typeof f[k] === "string" ? (f[k] as string).trim() : "");
  const draft: Draft = {
    name: s("name"),
    audience_id: s("audience_id"),
    products: s("products"),
    skus: s("skus"),
    categories: Object.keys(f).filter((k) => k.startsWith("cat_") && f[k] === "on").map((k) => k.slice(4)),
    tags: s("tags"),
    brands: s("brands"),
    json: s("condition_json"),
    kind: s("kind") === "price" ? "price" : "percent",
    amount: s("amount"),
    starts: s("starts"),
    ends: s("ends"),
    enabled: s("enabled") === "on",
  };
  const fail = (key: MessageKey, vars?: Record<string, string>) => page(c, shop, id, draft, vars ? tf(key, vars) : t(key), 400);
  const db = owner(c).db;
  // 商品・SKU は slug・品番で受け、同じショップのものだけ id にする（無いものがあれば保存しない）
  const slugs = list(draft.products);
  const codes = list(draft.skus);
  const [products, skus] = await Promise.all([
    slugs.length ? db.from<{ id: string; slug: string }>("products").select("id,slug", { eq: { shop_id: shop.id }, in: { slug: slugs } }) : [],
    codes.length ? db.from<{ id: string; code: string }>("skus").select("id,code", { eq: { shop_id: shop.id }, in: { code: codes } }) : [],
  ]);
  const missingP = slugs.filter((x) => !products.some((p) => p.slug === x));
  if (missingP.length) return fail("mprice.product_missing", { list: missingP.join(", ") });
  const missingK = codes.filter((x) => !skus.some((k) => k.code === x));
  if (missingK.length) return fail("mprice.sku_missing", { list: missingK.join(", ") });
  let condition: unknown = null;
  if (draft.json) {
    try {
      condition = JSON.parse(draft.json);
    } catch {
      return fail("mprice.invalid_condition");
    }
  } else {
    const leaves = [
      ...(draft.categories.length ? [{ category: draft.categories }] : []),
      ...(list(draft.tags).length ? [{ tag: list(draft.tags) }] : []),
      ...(list(draft.brands).length ? [{ brand: list(draft.brands) }] : []),
    ];
    condition = leaves.length === 0 ? null : leaves.length === 1 ? leaves[0] : { any: leaves };
  }
  if (!products.length && !skus.length && condition === null) return fail("mprice.target_empty");
  const amount = Number(draft.amount);
  if (!/^[0-9]{1,8}$/.test(draft.amount) || (draft.kind === "percent" && (amount < 1 || amount > 99))) return fail("mprice.invalid_amount");
  if (!draft.audience_id) return fail("mprice.audience_required");
  const startsIso = draft.starts ? zonedInputToIso(draft.starts) : null;
  const endsIso = draft.ends ? zonedInputToIso(draft.ends) : null;
  if ((draft.starts && !startsIso) || (draft.ends && !endsIso) || (startsIso && endsIso && startsIso >= endsIso)) return fail("mprice.invalid_period");
  const values = {
    name: draft.name,
    audience_id: draft.audience_id,
    product_ids: products.map((p) => p.id),
    sku_ids: skus.map((k) => k.id),
    product_condition: condition,
    price_jpy: draft.kind === "price" ? amount : null,
    percent_off: draft.kind === "percent" ? amount : null,
    starts_at: startsIso,
    ends_at: endsIso,
    enabled: draft.enabled,
  };
  try {
    if (id) await db.from("price_rules").update(values, { id, shop_id: shop.id });
    else await db.from("price_rules").insert({ ...values, shop_id: shop.id });
  } catch (e) {
    if (e instanceof DbError) return fail(/audience_display_only/.test(e.message) ? "product.audience_display_only" : /invalid_product_condition/.test(e.message) ? "mprice.invalid_condition" : "mprice.invalid");
    throw e;
  }
  return c.redirect(`${base(shop)}?flash=saved`);
}

priceRulesAdmin.post("/", requireOwner, (c: AdminContext) => save(c, null));
priceRulesAdmin.post("/:id", requireOwner, (c: AdminContext) => save(c, param(c, "id")));
priceRulesAdmin.post("/:id/delete", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  await owner(c).db.from("price_rules").delete({ id: param(c, "id"), shop_id: shop.id });
  return c.redirect(`${base(shop)}?flash=deleted`);
});
