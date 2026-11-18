import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { ShopRow } from "../../db/types";
import { t } from "../../i18n";
import { formatDateTime, isoToZonedInput, zonedInputToIso } from "../../i18n/time";
import { AdminLayout, PageHead } from "../../routes/admin/layout";
import { formFields, owner, param, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { loadShop } from "../../routes/admin/shops";
import { moduleEnabled } from "../registry";
import { AUDIENCES_MODULE, audienceDisplayOnly } from "../../members/audience";
import { MEMBER_NEWS_MODULE } from "./index";

/**
 * 同梱モジュール「会員へのお知らせ」の管理画面（0155_mod_member_news、docs/member-news.md）。項目 marketing。
 *   GET  /admin/shops/:shopId/modules/member-news                 全員向けの一覧と、作る・直す欄（?id=）
 *   POST /admin/shops/:shopId/modules/member-news                 保存（id があれば直す）
 *   POST /admin/shops/:shopId/modules/member-news/:id/delete      消す（外部プラグインが置いたものも）
 * 1 人あてのお知らせは外部プラグインが AI 用 API で置く（この画面では数だけ）。形の確かめは DB（banto_member_news_norm）
 */
export const memberNewsAdmin = new Hono<AppEnv>();

interface NewsRow {
  id: string;
  customer_id: string | null;
  title: string;
  body: string;
  url: string | null;
  starts_at: string;
  ends_at: string | null;
  audience_id: string | null;
  endpoint_id: string | null;
}

interface Draft {
  id: string;
  title: string;
  body: string;
  url: string;
  starts: string;
  ends: string;
  audience_id: string;
  error?: string;
}

async function scope(c: AdminContext): Promise<ShopRow | null> {
  const shop = await loadShop(c, param(c, "shopId"), "marketing");
  return shop && moduleEnabled(shop.settings, MEMBER_NEWS_MODULE) ? shop : null;
}

const base = (shop: ShopRow) => `/admin/shops/${shop.id}/modules/member-news`;

async function audiencesOf(c: AdminContext, shop: ShopRow): Promise<{ id: string; name: string }[]> {
  if (!moduleEnabled(shop.settings, AUDIENCES_MODULE)) return [];
  const rows = await owner(c).db.from<{ id: string; name: string; condition: unknown }>("audiences").select("id,name,condition", { eq: { shop_id: shop.id }, order: "name.asc", limit: 200 });
  // 表示用の条件（URL のパラメータ）は会員の判定に使えない
  return rows.filter((r) => !audienceDisplayOnly(r.condition)).map((r) => ({ id: r.id, name: r.name }));
}

const ERRORS: Record<string, string> = {
  title: "mnews.error_title",
  body: "mnews.error_body",
  url: "mnews.error_url",
  date: "mnews.error_date",
  audience: "mnews.error_audience",
};

function errorOf(e: DbError): string {
  if (/member_news_full/.test(e.message)) return t("mnews.error_full");
  const m = /invalid_member_news:([a-z_]+)/.exec(e.message);
  const key = m ? ERRORS[m[1]!] : undefined;
  return key ? t(key as Parameters<typeof t>[0]) : t("error.generic");
}

async function render(c: AdminContext, shop: ShopRow, draft: Draft | null, status: 200 | 400 = 200) {
  const db = owner(c).db;
  const [rows, perMember, audiences] = await Promise.all([
    db.from<NewsRow>("member_news").select("id,customer_id,title,body,url,starts_at,ends_at,audience_id,endpoint_id", { eq: { shop_id: shop.id }, where: [{ col: "customer_id", op: "is", value: null }], order: "starts_at.desc", limit: 100 }),
    // 1 人あて（customer_id のある行。neq は空の行を含まない）の数だけ。1,000 を超えたら「1,000+」
    db.from<{ id: string }>("member_news").select("id", { eq: { shop_id: shop.id }, where: [{ col: "customer_id", op: "neq", value: "00000000-0000-0000-0000-000000000000" }], limit: 1000 }),
    audiencesOf(c, shop),
  ]);
  const editId = c.req.query("id") ?? "";
  const editing = draft ?? (() => {
    const r = rows.find((x) => x.id === editId && !x.endpoint_id);
    return r ? { id: r.id, title: r.title, body: r.body, url: r.url ?? "", starts: isoToZonedInput(r.starts_at), ends: isoToZonedInput(r.ends_at), audience_id: r.audience_id ?? "" } : null;
  })();
  const d: Draft = editing ?? { id: "", title: "", body: "", url: "", starts: "", ends: "", audience_id: "" };
  const now = Date.now();
  const state = (r: NewsRow) => (Date.parse(r.starts_at) > now ? t("mnews.state_scheduled") : r.ends_at && Date.parse(r.ends_at) <= now ? t("mnews.state_ended") : t("mnews.state_live"));
  const flash = c.req.query("flash");
  const audienceName = new Map(audiences.map((a) => [a.id, a.name]));
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("mnews.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("modules.title"), href: `/admin/shops/${shop.id}/modules` }, { label: t("mnews.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "modules", here: "member-news" }}>
      <PageHead title={t("mnews.title")} sub={t("mnews.intro")} />
      {flash === "saved" ? <p class="notice">{t("mnews.saved")}</p> : null}
      {flash === "deleted" ? <p class="notice">{t("mnews.deleted")}</p> : null}
      <p class="muted">{t("mnews.per_member").replace("{n}", perMember.length >= 1000 ? "1,000+" : String(perMember.length))}</p>
      <section class="card">
        <h2>{d.id ? t("mnews.edit") : t("mnews.add")}</h2>
        {d.error ? <p class="error">{d.error}</p> : null}
        <form method="post" action={base(shop)}>
          <input type="hidden" name="id" value={d.id} />
          <label for="title">{t("mnews.field_title")}</label>
          <input id="title" name="title" type="text" maxlength={100} required value={d.title} style="width:100%" />
          <label for="body">{t("mnews.field_body")}</label>
          <textarea id="body" name="body" rows={5} maxlength={1000} style="width:100%">
            {d.body}
          </textarea>
          <label for="url">{t("mnews.field_url")}</label>
          <input id="url" name="url" type="text" maxlength={500} value={d.url} placeholder="/products/tee" style="width:100%" />
          <p class="muted">{t("mnews.field_url_note")}</p>
          <label for="starts">{t("mnews.field_starts")}</label>
          <input id="starts" name="starts" type="datetime-local" value={d.starts} />
          <label for="ends">{t("mnews.field_ends")}</label>
          <input id="ends" name="ends" type="datetime-local" value={d.ends} />
          {audiences.length > 0 ? (
            <>
              <label for="audience_id">{t("mnews.field_audience")}</label>
              <select id="audience_id" name="audience_id">
                <option value="">{t("mnews.audience_all")}</option>
                {audiences.map((a) => (
                  <option value={a.id} selected={a.id === d.audience_id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <p>
            <button type="submit">{t("mnews.save")}</button> {d.id ? <a href={base(shop)}>{t("mnews.cancel_edit")}</a> : null}
          </p>
        </form>
      </section>
      <h2>{t("mnews.list")}</h2>
      {rows.length === 0 ? (
        <p class="muted">{t("mnews.none")}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("mnews.field_title")}</th>
              <th>{t("mnews.period")}</th>
              <th>{t("mnews.field_audience")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td>
                  {r.endpoint_id ? r.title : <a href={`${base(shop)}?id=${r.id}`}>{r.title}</a>}
                  {r.endpoint_id ? <div class="muted">{t("mnews.by_plugin")}</div> : null}
                </td>
                <td>
                  {state(r)}
                  <div class="muted">
                    {formatDateTime(r.starts_at)}
                    {r.ends_at ? ` 〜 ${formatDateTime(r.ends_at)}` : " 〜"}
                  </div>
                </td>
                <td>{r.audience_id ? (audienceName.get(r.audience_id) ?? "?") : t("mnews.audience_all")}</td>
                <td>
                  <form method="post" action={`${base(shop)}/${r.id}/delete`}>
                    <button type="submit" class="secondary">
                      {t("mnews.delete")}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminLayout>,
    status,
  );
}

memberNewsAdmin.get("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  return render(c, shop, null);
});

memberNewsAdmin.post("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const f = await formFields(c);
  const draft: Draft = { id: f.id ?? "", title: f.title ?? "", body: f.body ?? "", url: f.url ?? "", starts: f.starts ?? "", ends: f.ends ?? "", audience_id: f.audience_id ?? "" };
  const starts = draft.starts ? zonedInputToIso(draft.starts) : null;
  const ends = draft.ends ? zonedInputToIso(draft.ends) : null;
  if ((draft.starts && !starts) || (draft.ends && !ends)) return render(c, shop, { ...draft, error: t("mnews.error_date") }, 400);
  const values: Record<string, unknown> = { title: draft.title, body: draft.body, url: draft.url || null, ends_at: ends, audience_id: draft.audience_id || null, ...(starts ? { starts_at: starts } : {}) };
  try {
    await owner(c).db.rpc("member_news_save", { p_shop_id: shop.id, p_id: draft.id || null, p_values: values });
  } catch (e) {
    if (e instanceof DbError) return render(c, shop, { ...draft, error: errorOf(e) }, 400);
    throw e;
  }
  return c.redirect(`${base(shop)}?flash=saved`);
});

memberNewsAdmin.post("/:id/delete", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  await owner(c).db.rpc("member_news_delete", { p_shop_id: shop.id, p_id: param(c, "id") });
  return c.redirect(`${base(shop)}?flash=deleted`);
});
