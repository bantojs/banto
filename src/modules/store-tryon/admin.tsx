import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { ShopRow } from "../../db/types";
import { t } from "../../i18n";
import { AdminLayout, type Crumb, type ShopTabs, PageHead } from "../../routes/admin/layout";
import { formFields, owner, param, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { can } from "../../routes/admin/access";
import { loadShop } from "../../routes/admin/shops";
import { moduleEnabled } from "../registry";
import { TRYON_MODULE, tryonSettings, type OrgStore, type ShopStoreLink } from "./index";
import { Flash, RequestList, RequestPage, TRYON_STATUSES, loadRequest, postStatus, type RequestRow } from "./requests";

/**
 * 同梱モジュール「お店で試着」のショップの画面（docs/store-tryon.md）。ショップの stores の項目を持つ人。
 * 実店舗そのもの（住所・営業時間・臨時休業）は組織の正本（/admin/stores）。ここは「このショップで使う店舗」と申し込みと設定。
 *   GET  /admin/shops/:shopId/modules/store-tryon                申し込みの一覧・使う店舗・設定
 *   POST .../settings                                            設定（受付の形・取り置きの日数・点数の上限・案内）
 *   POST .../stores                                              このショップで使う店舗（試着を受けるか・並び順）
 *   GET  .../requests/:id, POST .../requests/:id/status, .../restock  申し込み 1 件（状態を進める・在庫を EC に戻す）
 */
export const tryonAdmin = new Hono<AppEnv>();

async function scope(c: AdminContext): Promise<ShopRow | null> {
  const shop = await loadShop(c, param(c, "shopId"), "stores");
  return shop && moduleEnabled(shop.settings, TRYON_MODULE) ? shop : null;
}

const base = (shop: ShopRow) => `/admin/shops/${shop.id}/modules/store-tryon`;

function crumbs(shop: ShopRow, here?: string): Crumb[] {
  return [
    { label: shop.name, href: `/admin/shops/${shop.id}` },
    { label: t("modules.title"), href: `/admin/shops/${shop.id}/modules` },
    here ? { label: t("mod.store_tryon.name"), href: base(shop) } : { label: t("mod.store_tryon.name") },
    ...(here ? [{ label: here }] : []),
  ];
}

const tabs = (c: AdminContext, shop: ShopRow): ShopTabs => ({ shop, access: c.get("shopAccess"), active: "modules" });

tryonAdmin.get("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const { db } = owner(c);
  const s = tryonSettings(shop.settings);
  const statusFilter = (TRYON_STATUSES as readonly string[]).includes(c.req.query("status") ?? "") ? c.req.query("status")! : "";
  const storeFilter = c.req.query("store") ?? "";
  const eq: Record<string, string> = { shop_id: shop.id };
  if (statusFilter) eq["status"] = statusFilter;
  if (storeFilter) eq["store_id"] = storeFilter;
  const [stores, links, requests] = await Promise.all([
    shop.org_id ? db.from<OrgStore>("stores").select("id,name,active,sort_order", { eq: { org_id: shop.org_id }, order: "sort_order.asc" }) : Promise.resolve([] as OrgStore[]),
    db.from<ShopStoreLink>("shop_stores").select("store_id,tryon,sort_order", { eq: { shop_id: shop.id } }),
    db.from<RequestRow>("tryon_requests").select("*", { eq, order: "created_at.desc", limit: 200 }),
  ]);
  const link = new Map(links.map((l) => [l.store_id, l]));
  const used = stores.filter((x) => link.has(x.id));
  const intOpt = (name: string, value: number, min: number, max: number) => <input id={name} type="number" name={name} min={min} max={max} value={String(value)} style="width:6rem" />;
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("mod.store_tryon.name")}`} nav crumbs={crumbs(shop)} shopTabs={tabs(c, shop)}>
      <PageHead title={t("mod.store_tryon.name")} />
      <Flash code={c.req.query("flash")} />
      <p>{t("tryon.admin_intro")}</p>

      <h2>{t("tryon.requests")}</h2>
      <RequestList action={base(shop)} requests={requests} stores={used} status={statusFilter} store={storeFilter} href={(r) => `${base(shop)}/requests/${r.id}`} />

      <h2>{t("tryon.stores")}</h2>
      <p class="muted">{t("tryon.shop_stores_intro")}</p>
      {stores.length === 0 ? <p>{t("tryon.no_org_stores")}</p> : null}
      {stores.length > 0 ? (
        <form method="post" action={`${base(shop)}/stores`}>
          <table>
            <thead>
              <tr>
                <th>{t("tryon.store_name")}</th>
                <th>{t("tryon.use_in_shop")}</th>
                <th>{t("tryon.store_tryon")}</th>
                <th>{t("tryon.store_sort_order")}</th>
              </tr>
            </thead>
            <tbody>
              {stores.map((st) => {
                const l = link.get(st.id);
                return (
                  <tr>
                    <td>
                      {st.name}
                      {!st.active ? ` (${t("tryon.store_inactive")})` : ""}
                    </td>
                    <td>
                      <input type="checkbox" name={`use.${st.id}`} value="on" checked={!!l} />
                    </td>
                    <td>
                      <input type="checkbox" name={`tryon.${st.id}`} value="on" checked={l ? l.tryon : true} />
                    </td>
                    <td>
                      <input type="number" name={`sort.${st.id}`} value={String(l?.sort_order ?? st.sort_order)} style="width:6rem" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p>
            <button type="submit">{t("tryon.save")}</button>
          </p>
        </form>
      ) : null}
      {can(c.get("shopAccess"), "admin") ? (
        <p>
          <a href="/admin/stores">{t("stores.title")}</a>
        </p>
      ) : null}

      <h2>{t("tryon.settings")}</h2>
      <form method="post" action={`${base(shop)}/settings`}>
        <fieldset>
          <legend>{t("tryon.mode")}</legend>
          <label>
            <input type="radio" name="mode" value="shop" checked={s.mode === "shop"} /> {t("tryon.mode_shop")}
          </label>
          <label>
            <input type="radio" name="mode" value="visit" checked={s.mode === "visit"} /> {t("tryon.mode_visit")}
          </label>
        </fieldset>
        <label for="hold_days">{t("tryon.hold_days")}</label>
        {intOpt("hold_days", s.hold_days, 1, 60)}
        <label for="min_days">{t("tryon.min_days")}</label>
        {intOpt("min_days", s.min_days, 0, 60)}
        <label for="max_days">{t("tryon.max_days")}</label>
        {intOpt("max_days", s.max_days, 0, 90)}
        <label for="max_items">{t("tryon.max_items")}</label>
        {intOpt("max_items", s.max_items, 1, 20)}
        <label for="notice">{t("tryon.notice")}</label>
        <textarea id="notice" name="notice" rows={3} maxlength={500}>
          {s.notice}
        </textarea>
        <p>
          <button type="submit">{t("tryon.save")}</button>
        </p>
      </form>
    </AdminLayout>,
  );
});

tryonAdmin.post("/settings", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const f = await formFields(c);
  const int = (v: string | undefined) => {
    const n = Number.parseInt(v ?? "", 10);
    return Number.isInteger(n) ? n : undefined;
  };
  const store_tryon = tryonSettings({
    store_tryon: { mode: f.mode, hold_days: int(f.hold_days), min_days: int(f.min_days), max_days: int(f.max_days), max_items: int(f.max_items), notice: (f.notice ?? "").trim() },
  });
  try {
    await owner(c)
      .db.from<ShopRow>("shops")
      .update({ settings: { ...(shop.settings ?? {}), store_tryon } }, { id: shop.id });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${base(shop)}?flash=generic`);
    throw e;
  }
  return c.redirect(`${base(shop)}?flash=saved`);
});

/** このショップで使う店舗。組織の店舗のうち、チェックしたものを結ぶ（結び直す） */
tryonAdmin.post("/stores", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop || !shop.org_id) return c.notFound();
  const { db } = owner(c);
  const f = await formFields(c);
  try {
    const [stores, links] = await Promise.all([
      db.from<OrgStore>("stores").select("id", { eq: { org_id: shop.org_id } }),
      db.from<ShopStoreLink>("shop_stores").select("store_id", { eq: { shop_id: shop.id } }),
    ]);
    const linked = new Set(links.map((l) => l.store_id));
    for (const st of stores) {
      const use = f[`use.${st.id}`] === "on";
      const sort = Number.parseInt(f[`sort.${st.id}`] ?? "0", 10);
      const row = { tryon: f[`tryon.${st.id}`] === "on", sort_order: Number.isInteger(sort) ? Math.max(-1000, Math.min(1000, sort)) : 0 };
      if (use && linked.has(st.id)) await db.from<ShopStoreLink>("shop_stores").update(row, { shop_id: shop.id, store_id: st.id });
      else if (use) await db.from<ShopStoreLink>("shop_stores").insert({ shop_id: shop.id, store_id: st.id, ...row });
      else if (linked.has(st.id)) await db.from("shop_stores").delete({ shop_id: shop.id, store_id: st.id });
    }
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${base(shop)}?flash=generic`);
    throw e;
  }
  return c.redirect(`${base(shop)}?flash=saved`);
});

// ---------- 申し込み 1 件 ----------
async function scopedRequest(c: AdminContext) {
  const shop = await scope(c);
  if (!shop) return null;
  const d = await loadRequest(c, param(c, "id"));
  return d && d.request.shop_id === shop.id ? { shop, d } : null;
}

tryonAdmin.get("/requests/:id", requireOwner, async (c: AdminContext) => {
  const x = await scopedRequest(c);
  if (!x) return c.notFound();
  return c.html(<RequestPage d={x.d} base={base(x.shop)} crumbs={crumbs(x.shop, `#${x.d.request.number}`)} shopTabs={tabs(c, x.shop)} flash={c.req.query("flash")} detail={c.req.query("detail")} />);
});

tryonAdmin.post("/requests/:id/status", requireOwner, async (c: AdminContext) => {
  const x = await scopedRequest(c);
  if (!x) return c.notFound();
  return c.redirect(await postStatus(c, x.d, base(x.shop)));
});

tryonAdmin.post("/requests/:id/restock", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const id = param(c, "id");
  const back = `${base(shop)}/requests/${id}`;
  try {
    await owner(c).db.rpc("tryon_restock", { p_shop_id: shop.id, p_request_id: id });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${back}?flash=generic`);
    throw e;
  }
  return c.redirect(`${back}?flash=restocked`);
});
