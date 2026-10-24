import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { t, tf, type MessageKey } from "../../i18n";
import { AdminLayout, type Crumb, PageHead } from "../../routes/admin/layout";
import { formFields, owner, param, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { myOrgs, type MyOrg } from "../../routes/admin/access";
import { formatRanges, formatSpecialDays, parseRanges, parseSpecialDays, specialDays, todayHere, weekdayLabel, weeklyHours, type OrgStore, type StorePerm, type TimeRange } from "./index";
import { Flash, RequestList, RequestPage, TRYON_STATUSES, loadRequest, postStatus, type RequestRow } from "./requests";

/**
 * 組織の実店舗（0025 の stores。正本）と、実店舗のスタッフの画面（docs/store-tryon.md、docs/knowledge/11-organizations.md）。
 *   GET  /admin/stores                         実店舗の一覧（owner / admin）・担当の実店舗（スタッフ）・臨時休業のまとめての登録
 *   GET  /admin/stores/new, POST /admin/stores  実店舗の追加（owner / admin）
 *   GET  /admin/stores/:id, POST /admin/stores/:id  実店舗（owner / admin は全部、hours の項目のスタッフは営業時間・臨時休業だけ）
 *   POST /admin/stores/special-days            臨時休業・臨時営業をまとめて登録 / 消す（選んだ店舗。項目の無い店舗は DB が飛ばす）
 *   GET  /admin/stores/:id/requests[/:rid], POST .../:rid/status   その実店舗の試着の申し込み（tryon の項目。在庫は戻せない）
 * 判定の正は DB（RLS と store_set_hours・stores_set_special_days・tryon_update）。ここは画面の出し分け。
 */
export const storesAdmin = new Hono<AppEnv>();

interface MyStore {
  id: string;
  org_id: string;
  name: string;
  perms: StorePerm[];
}

const myStores = (c: AdminContext) => owner(c).db.rpc<MyStore[]>("banto_my_stores", {});

/** 自分がこの実店舗でできること（owner / admin は全部） */
async function storeAccess(c: AdminContext, storeId: string): Promise<{ store: OrgStore; admin: boolean; perms: StorePerm[] } | null> {
  let store: OrgStore | null;
  try {
    store = await owner(c)
      .db.from<OrgStore>("stores")
      .selectOne("*", { eq: { id: storeId } });
  } catch (e) {
    if (e instanceof DbError && e.code === "22P02") return null; // id の形が違う
    throw e;
  }
  if (!store) return null;
  const orgs = await myOrgs(c);
  if (orgs.some((o) => o.org_id === store.org_id && o.role !== "member")) return { store, admin: true, perms: ["tryon", "hours"] };
  const mine = (await myStores(c)).find((s) => s.id === storeId);
  return mine ? { store, admin: false, perms: mine.perms } : null;
}

function crumbs(here?: string): Crumb[] {
  return here ? [{ label: t("stores.title"), href: "/admin/stores" }, { label: here }] : [{ label: t("stores.title") }];
}

storesAdmin.get("/", requireOwner, async (c: AdminContext) => {
  const { db } = owner(c);
  const [orgs, mine] = await Promise.all([myOrgs(c), myStores(c)]);
  const adminOrgs = orgs.filter((o) => o.role !== "member");
  const org: MyOrg | undefined = adminOrgs.find((o) => o.org_id === c.req.query("org")) ?? adminOrgs[0];
  if (!org && mine.length === 0) return c.redirect("/admin?flash=forbidden");
  const stores = org ? await db.from<OrgStore>("stores").select("*", { eq: { org_id: org.org_id }, order: "sort_order.asc" }) : [];
  // まとめての登録の対象: owner / admin なら組織の店舗、スタッフなら hours の項目を持つ店舗
  const bulkTargets = org ? stores : mine.filter((s) => s.perms.includes("hours"));
  const bulkOrg = org?.org_id ?? bulkTargets[0]?.org_id;
  return c.html(
    <AdminLayout title={t("stores.title")} nav crumbs={crumbs()}>
      <PageHead title={t("stores.title")} />
      <Flash code={c.req.query("flash")} />
      {c.req.query("flash") === "bulk_saved" ? <p class="notice">{tf("stores.bulk_saved", { n: c.req.query("n") ?? "0" })}</p> : null}
      {c.req.query("flash") === "bulk_invalid" ? <p class="error">{tf("tryon.invalid_special_days", { lines: c.req.query("lines") ?? "" })}</p> : null}
      <p>{t("stores.intro")}</p>

      {mine.length > 0 ? (
        <>
          <h2>{t("stores.mine")}</h2>
          <ul>
            {mine.map((s) => (
              <li>
                {s.name}
                {s.perms.includes("tryon") ? (
                  <>
                    {" — "}
                    <a href={`/admin/stores/${s.id}/requests`}>{t("tryon.requests")}</a>
                  </>
                ) : null}
                {s.perms.includes("hours") ? (
                  <>
                    {" · "}
                    <a href={`/admin/stores/${s.id}`}>{t("tryon.store_hours")}</a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {org ? (
        <>
          <h2>{t("stores.all")}</h2>
          {stores.length === 0 ? <p>{t("tryon.no_org_stores")}</p> : null}
          <ul>
            {stores.map((st) => (
              <li>
                <a href={`/admin/stores/${st.id}`}>{st.name}</a>
                {!st.active ? ` (${t("tryon.store_inactive")})` : ""} — <a href={`/admin/stores/${st.id}/requests`}>{t("tryon.requests")}</a>
              </li>
            ))}
          </ul>
          <p>
            <a class="btn secondary small" href={`/admin/stores/new?org=${org.org_id}`}>
              {t("tryon.store_new")}
            </a>
          </p>
        </>
      ) : null}

      {bulkTargets.length > 0 && bulkOrg ? (
        <>
          <h2>{t("stores.bulk_title")}</h2>
          <p class="muted">{t("stores.bulk_intro")}</p>
          <form method="post" action="/admin/stores/special-days">
            <input type="hidden" name="org" value={bulkOrg} />
            <p>
              {bulkTargets.map((st) => (
                <label style="display:inline-block;margin-right:1rem">
                  <input type="checkbox" name="store" value={st.id} checked /> {st.name}
                </label>
              ))}
            </p>
            <textarea name="days" rows={4} placeholder={"2026-12-31〜2027-01-03 休業 年末年始\n2027-01-04 11:00-17:00 初売り"} />
            <p class="muted">{t("stores.bulk_hint")}</p>
            <label>
              <input type="radio" name="mode" value="set" checked /> {t("stores.bulk_set")}
            </label>
            <label>
              <input type="radio" name="mode" value="remove" /> {t("stores.bulk_remove")}
            </label>
            <p>
              <button type="submit">{t("tryon.save")}</button>
            </p>
          </form>
        </>
      ) : null}
    </AdminLayout>,
  );
});

storesAdmin.post("/special-days", requireOwner, async (c: AdminContext) => {
  const body = await c.req.parseBody({ all: true });
  const ids = (Array.isArray(body.store) ? body.store : body.store === undefined ? [] : [body.store]).filter((v): v is string => typeof v === "string");
  const text = typeof body.days === "string" ? body.days : "";
  const orgId = typeof body.org === "string" ? body.org : "";
  // 消すときは日付（期間）だけでよい: 「休業」を補って同じ読み方にする
  const lines =
    body.mode === "remove"
      ? text
          .split(/\r?\n/)
          .map((l) => (l.trim() && l.trim().split(/\s+/).length === 1 ? `${l.trim()} 休業` : l))
          .join("\n")
      : text;
  const parsed = parseSpecialDays(lines, todayHere());
  if (parsed.errors.length > 0) return c.redirect(`/admin/stores?flash=bulk_invalid&lines=${parsed.errors.join(",")}`);
  if (parsed.days.length === 0 || ids.length === 0) return c.redirect("/admin/stores?flash=generic");
  const days = body.mode === "remove" ? parsed.days.map((d) => ({ date: d.date, remove: true })) : parsed.days;
  try {
    const n = await owner(c).db.rpc<number>("stores_set_special_days", { p_org_id: orgId, p_store_ids: ids, p_days: days });
    return c.redirect(`/admin/stores?flash=bulk_saved&n=${n}`);
  } catch (e) {
    if (e instanceof DbError) return c.redirect("/admin/stores?flash=generic");
    throw e;
  }
});

// ---------- 実店舗 ----------
function StoreForm({ store, orgId, values, error, hoursOnly }: { store: OrgStore | null; orgId?: string; values?: Record<string, string | undefined>; error?: string; hoursOnly?: boolean }) {
  const hours = weeklyHours(store?.hours);
  const v = (k: string, fallback: string) => values?.[k] ?? fallback;
  const text = (name: string, label: MessageKey, value: string, max: number, type = "text") => (
    <>
      <label for={name}>{t(label)}</label>
      <input id={name} name={name} type={type} value={value} maxlength={max} />
    </>
  );
  const check = (name: string, label: MessageKey, checked: boolean) => (
    <label>
      <input type="checkbox" name={name} value="on" checked={checked} /> {t(label)}
    </label>
  );
  return (
    <form method="post" action={store ? `/admin/stores/${store.id}` : `/admin/stores?org=${orgId ?? ""}`}>
      {error ? <p class="error">{error}</p> : null}
      {hoursOnly ? null : (
        <>
          {text("name", "tryon.store_name", v("name", store?.name ?? ""), 100)}
          {text("postal_code", "tryon.store_postal_code", v("postal_code", store?.postal_code ?? ""), 10)}
          {text("address", "tryon.store_address", v("address", store?.address ?? ""), 200)}
          {text("phone", "tryon.store_phone", v("phone", store?.phone ?? ""), 20, "tel")}
          {text("email", "tryon.store_email", v("email", store?.email ?? ""), 254, "email")}
          {check("notify_email", "tryon.store_notify_email", values ? values["notify_email"] === "on" : (store?.notify_email ?? false))}
          {check("active", "tryon.store_active", values ? values["active"] === "on" : (store?.active ?? true))}
        </>
      )}
      <fieldset>
        <legend>{t("tryon.store_hours")}</legend>
        <p class="muted">{t("tryon.store_hours_hint")}</p>
        {[1, 2, 3, 4, 5, 6, 0].map((d) => (
          <p>
            <label for={`h${d}`} style="display:inline-block;width:3rem">
              {weekdayLabel(d)}
            </label>
            <input id={`h${d}`} name={`h${d}`} value={v(`h${d}`, formatRanges(hours[String(d)] ?? []))} placeholder="10:00-20:00" style="width:16rem" />
          </p>
        ))}
      </fieldset>
      <label for="special_days">{t("tryon.store_special_days")}</label>
      <textarea id="special_days" name="special_days" rows={6} placeholder={"2026-12-31〜2027-01-03 休業 年末年始\n2027-01-04 11:00-17:00 初売り"}>
        {v("special_days", formatSpecialDays(specialDays(store?.special_days)))}
      </textarea>
      <p class="muted">{t("tryon.store_special_days_hint")}</p>
      {hoursOnly ? null : (
        <>
          <label for="note">{t("tryon.store_note")}</label>
          <textarea id="note" name="note" rows={2} maxlength={500}>
            {v("note", store?.note ?? "")}
          </textarea>
          <label for="sort_order">{t("tryon.store_sort_order")}</label>
          <input id="sort_order" type="number" name="sort_order" value={v("sort_order", String(store?.sort_order ?? 0))} style="width:6rem" />
        </>
      )}
      <p>
        <button type="submit">{t("tryon.save")}</button>
      </p>
    </form>
  );
}

/** フォーム → 営業時間と臨時休業。読めなければ error（どの曜日 / 何行目か） */
function hoursFromForm(f: Record<string, string | undefined>): { hours: Record<string, TimeRange[]>; special_days: ReturnType<typeof parseSpecialDays>["days"]; error: string | null } {
  const hours: Record<string, TimeRange[]> = {};
  for (let d = 0; d < 7; d++) {
    const r = parseRanges(f[`h${d}`] ?? "");
    if (r === null) return { hours, special_days: [], error: tf("tryon.invalid_hours", { detail: weekdayLabel(d) }) };
    hours[String(d)] = r;
  }
  const sp = parseSpecialDays(f.special_days ?? "", todayHere());
  if (sp.errors.length > 0) return { hours, special_days: [], error: tf("tryon.invalid_special_days", { lines: sp.errors.join(", ") }) };
  return { hours, special_days: sp.days, error: null };
}

/** フォーム → 実店舗の行（owner / admin） */
function storeFromForm(f: Record<string, string | undefined>): { row: Partial<OrgStore>; error: string | null } {
  const h = hoursFromForm(f);
  if (h.error) return { row: {}, error: h.error };
  const name = (f.name ?? "").trim().slice(0, 100);
  if (!name) return { row: {}, error: t("tryon.invalid_store") };
  const email = (f.email ?? "").trim().toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { row: {}, error: t("tryon.invalid_store_email") };
  const opt = (k: string, max: number) => (f[k] ?? "").trim().slice(0, max) || null;
  const sort = Number.parseInt(f.sort_order ?? "0", 10);
  return {
    row: {
      name,
      postal_code: opt("postal_code", 10),
      address: opt("address", 200),
      phone: opt("phone", 20),
      email: email || null,
      notify_email: f.notify_email === "on" && !!email,
      active: f.active === "on",
      hours: h.hours,
      special_days: h.special_days,
      note: opt("note", 500),
      sort_order: Number.isInteger(sort) ? Math.max(-1000, Math.min(1000, sort)) : 0,
    },
    error: null,
  };
}

storesAdmin.get("/new", requireOwner, async (c: AdminContext) => {
  const org = (await myOrgs(c)).find((o) => o.org_id === c.req.query("org") && o.role !== "member");
  if (!org) return c.redirect("/admin?flash=forbidden");
  return c.html(
    <AdminLayout title={t("tryon.store_new")} nav crumbs={crumbs(t("tryon.store_new"))}>
      <PageHead title={t("tryon.store_new")} />
      <StoreForm store={null} orgId={org.org_id} />
    </AdminLayout>,
  );
});

storesAdmin.post("/", requireOwner, async (c: AdminContext) => {
  const org = (await myOrgs(c)).find((o) => o.org_id === c.req.query("org") && o.role !== "member");
  if (!org) return c.redirect("/admin?flash=forbidden");
  const f = await formFields(c);
  const { row, error } = storeFromForm(f);
  if (error) {
    return c.html(
      <AdminLayout title={t("tryon.store_new")} nav crumbs={crumbs(t("tryon.store_new"))}>
        <PageHead title={t("tryon.store_new")} />
        <StoreForm store={null} orgId={org.org_id} values={f} error={error} />
      </AdminLayout>,
      400,
    );
  }
  try {
    const [created] = await owner(c)
      .db.from<OrgStore>("stores")
      .insert({ ...row, org_id: org.org_id });
    return c.redirect(`/admin/stores/${created!.id}?flash=saved`);
  } catch (e) {
    if (e instanceof DbError) return c.redirect("/admin/stores?flash=generic");
    throw e;
  }
});

storesAdmin.get("/:storeId", requireOwner, async (c: AdminContext) => {
  const a = await storeAccess(c, param(c, "storeId"));
  if (!a || (!a.admin && !a.perms.includes("hours"))) return c.notFound();
  return c.html(
    <AdminLayout title={a.store.name} nav crumbs={crumbs(a.store.name)}>
      <PageHead title={a.store.name} />
      <Flash code={c.req.query("flash")} />
      <StoreForm store={a.store} hoursOnly={!a.admin} />
    </AdminLayout>,
  );
});

storesAdmin.post("/:storeId", requireOwner, async (c: AdminContext) => {
  const a = await storeAccess(c, param(c, "storeId"));
  if (!a || (!a.admin && !a.perms.includes("hours"))) return c.notFound();
  const f = await formFields(c);
  const back = `/admin/stores/${a.store.id}`;
  const fail = (error: string) =>
    c.html(
      <AdminLayout title={a.store.name} nav crumbs={crumbs(a.store.name)}>
        <PageHead title={a.store.name} />
        <StoreForm store={a.store} values={f} error={error} hoursOnly={!a.admin} />
      </AdminLayout>,
      400,
    );
  const { db } = owner(c);
  try {
    if (a.admin) {
      const { row, error } = storeFromForm(f);
      if (error) return fail(error);
      await db.from<OrgStore>("stores").update({ ...row, updated_at: new Date().toISOString() } as Partial<OrgStore>, { id: a.store.id });
    } else {
      const h = hoursFromForm(f);
      if (h.error) return fail(h.error);
      await db.rpc("store_set_hours", { p_store_id: a.store.id, p_hours: h.hours, p_special_days: h.special_days });
    }
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${back}?flash=generic`);
    throw e;
  }
  return c.redirect(`${back}?flash=saved`);
});

// ---------- 実店舗の試着の申し込み（スタッフ） ----------
storesAdmin.get("/:storeId/requests", requireOwner, async (c: AdminContext) => {
  const a = await storeAccess(c, param(c, "storeId"));
  if (!a || !a.perms.includes("tryon")) return c.notFound();
  const { db } = owner(c);
  const status = (TRYON_STATUSES as readonly string[]).includes(c.req.query("status") ?? "") ? c.req.query("status")! : "";
  const eq: Record<string, string> = { store_id: a.store.id };
  if (status) eq["status"] = status;
  const [requests, shops] = await Promise.all([
    db.from<RequestRow>("tryon_requests").select("*", { eq, order: "created_at.desc", limit: 200 }),
    // スタッフはショップの表を読めないので、名前だけ関数で（0027）
    db.rpc<{ id: string; name: string }[]>("tryon_store_shops", { p_store_id: a.store.id }),
  ]);
  const shopName = new Map(shops.map((s) => [s.id, s.name]));
  const base = `/admin/stores/${a.store.id}`;
  return c.html(
    <AdminLayout title={`${a.store.name} · ${t("tryon.requests")}`} nav crumbs={crumbs(a.store.name)}>
      <h1>
        {a.store.name} · {t("tryon.requests")}
      </h1>
      <RequestList action={`${base}/requests`} requests={requests} stores={[{ id: a.store.id, name: a.store.name }]} status={status} store="" href={(r) => `${base}/requests/${r.id}`} shopName={shopName.size > 0 ? (r) => shopName.get(r.shop_id) ?? "" : undefined} />
    </AdminLayout>,
  );
});

async function staffRequest(c: AdminContext) {
  const a = await storeAccess(c, param(c, "storeId"));
  if (!a || !a.perms.includes("tryon")) return null;
  const d = await loadRequest(c, param(c, "rid"));
  return d && d.request.store_id === a.store.id ? { a, d } : null;
}

storesAdmin.get("/:storeId/requests/:rid", requireOwner, async (c: AdminContext) => {
  const x = await staffRequest(c);
  if (!x) return c.notFound();
  const base = `/admin/stores/${x.a.store.id}`;
  const trail: Crumb[] = [{ label: t("stores.title"), href: "/admin/stores" }, { label: x.a.store.name, href: `${base}/requests` }, { label: `#${x.d.request.number}` }];
  return c.html(<RequestPage d={x.d} base={base} crumbs={trail} flash={c.req.query("flash")} detail={c.req.query("detail")} />);
});

storesAdmin.post("/:storeId/requests/:rid/status", requireOwner, async (c: AdminContext) => {
  const x = await staffRequest(c);
  if (!x) return c.notFound();
  return c.redirect(await postStatus(c, x.d, `/admin/stores/${x.a.store.id}`));
});
