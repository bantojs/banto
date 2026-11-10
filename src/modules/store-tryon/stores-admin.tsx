import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { t, tf, type MessageKey } from "../../i18n";
import { AdminLayout, type Crumb, PageHead } from "../../routes/admin/layout";
import { formFields, owner, param, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { myOrgs, type MyOrg } from "../../routes/admin/access";
import { formatRanges, parseRanges, parseSpecialDays, specialDays, todayHere, weekdayLabel, weeklyHours, type OrgStore, type SpecialDay, type StorePerm, type TimeRange } from "./index";
import { Flash, RequestList, RequestPage, TRYON_STATUSES, loadRequest, postStatus, statusLabel, type RequestRow } from "./requests";
import { migrated } from "../../db/migration-state";
import { mediaBaseUrl } from "../../routes/common";
import type { ProductField } from "../../products/fields";
import { STORE_FIELDS_MIGRATION, formatStoreFieldRows, parseStoreFieldRows, storeFieldDefs, storeFieldsForDb, storeFieldsFromForm } from "../../stores/fields";

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

/** 組織の実店舗の独自項目の定義（0126。当たる前は null = 欄を出さない） */
async function orgStoreFields(c: AdminContext, orgId: string): Promise<ProductField[] | null> {
  const { db } = owner(c);
  if (!(await migrated({ db, cache: c.get("adapters").cache }, STORE_FIELDS_MIGRATION).catch(() => false))) return null;
  const row = await db.from<{ store_fields: unknown }>("organizations").selectOne("store_fields", { eq: { id: orgId } }).catch(() => null);
  return storeFieldDefs(row?.store_fields);
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
  const defs = org ? await orgStoreFields(c, org.org_id) : null;
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
          {defs ? (
            <details open={defs.length > 0}>
              <summary>{t("stores.fields")}</summary>
              <form method="post" action={`/admin/stores/fields?org=${org.org_id}`}>
                <textarea name="rows" rows={6} style="width:100%" placeholder={"parking | 駐車場 | select | あり/なし\nbrands | 取扱ブランド | text\nmanager | 担当者 | text | | private"}>
                  {formatStoreFieldRows(defs)}
                </textarea>
                <p class="muted">{t("stores.fields_help")}</p>
                <p>
                  <button type="submit">{t("tryon.save")}</button>
                </p>
              </form>
            </details>
          ) : null}
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
/**
 * 営業時間の入れ方（メンテナの決定 2026-11-08、保存の形は今のまま）: 曜日ごとに「営業 / 定休日」と時刻を選ぶ欄（休憩をはさむときの 2 つ目も）。
 * 臨時休業・臨時営業は、今ある日を 1 行ずつ（消す印つき）と、日付を選んで「休み / 時間を変える」を足す行。まとめて貼るのは開いて使う欄。
 * スクリプト無しで動く。送られた欄は hoursFromForm が今までの書式（10:00-20:00・2026-12-31 休業）に直して同じ読み方で確かめる
 */
function HoursFields(props: { hours: Record<string, TimeRange[]>; days: SpecialDay[]; values?: Record<string, string | undefined> | undefined }) {
  const v = (k: string, fallback: string) => props.values?.[k] ?? fallback;
  return (
    <>
      <fieldset class="hours-week">
        <legend>{t("tryon.store_hours")}</legend>
        {[1, 2, 3, 4, 5, 6, 0].map((d) => {
          const r = props.hours[String(d)] ?? [];
          const closed = v(`h${d}_mode`, r.length === 0 ? "closed" : "open") === "closed";
          return (
            <div class="hours-row">
              <strong class="hours-day">{weekdayLabel(d)}</strong>
              <select name={`h${d}_mode`} aria-label={tf("hours.mode_for", { day: weekdayLabel(d) })}>
                <option value="open" selected={!closed}>
                  {t("hours.open")}
                </option>
                <option value="closed" selected={closed}>
                  {t("hours.closed")}
                </option>
              </select>
              {[0, 1].map((i) => (
                <span class="hours-range">
                  <input type="time" name={`h${d}_s${i}`} value={v(`h${d}_s${i}`, r[i]?.[0] ?? "")} aria-label={tf(i === 0 ? "hours.open_at" : "hours.open_at2", { day: weekdayLabel(d) })} />
                  〜
                  <input type="time" name={`h${d}_e${i}`} value={v(`h${d}_e${i}`, r[i]?.[1] ?? "")} aria-label={tf(i === 0 ? "hours.close_at" : "hours.close_at2", { day: weekdayLabel(d) })} />
                </span>
              ))}
            </div>
          );
        })}
        <p class="muted">{t("hours.week_hint")}</p>
      </fieldset>
      <fieldset class="hours-special">
        <legend>{t("tryon.store_special_days")}</legend>
        {props.days.length > 0 ? (
          <ul class="plainlist">
            {props.days.map((d, i) => (
              <li>
                <input type="hidden" name={`sd_${i}`} value={specialDayLine(d)} />
                <label>
                  <input type="checkbox" name={`sd_${i}_remove`} value="on" /> {t("hours.remove")}
                </label>{" "}
                <strong>{d.date}</strong> {d.closed ? t("hours.closed") : formatRanges(d.hours)} <span class="muted">{d.note ?? ""}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted">{t("hours.no_special")}</p>
        )}
        <div class="hours-add">
          <strong>{t("hours.add_day")}</strong>
          <label>
            {t("hours.from")} <input type="date" name="add_from" value={v("add_from", "")} />
          </label>
          <label>
            {t("hours.to")} <input type="date" name="add_to" value={v("add_to", "")} />
          </label>
          <select name="add_kind" aria-label={t("hours.add_kind")}>
            <option value="closed" selected={v("add_kind", "closed") === "closed"}>
              {t("hours.add_closed")}
            </option>
            <option value="hours" selected={v("add_kind", "closed") === "hours"}>
              {t("hours.add_hours")}
            </option>
          </select>
          <span class="hours-range">
            <input type="time" name="add_s" value={v("add_s", "")} aria-label={t("hours.add_open_at")} />〜<input type="time" name="add_e" value={v("add_e", "")} aria-label={t("hours.add_close_at")} />
          </span>
          <input type="text" name="add_note" value={v("add_note", "")} maxlength={50} placeholder={t("hours.add_note")} aria-label={t("hours.add_note")} />
        </div>
        <details>
          <summary>{t("hours.bulk")}</summary>
          <textarea name="special_days_bulk" rows={4} placeholder={"2026-12-31〜2027-01-03 休業 年末年始\n2027-01-04 11:00-17:00 初売り"}>
            {v("special_days_bulk", "")}
          </textarea>
          <p class="muted">{t("tryon.store_special_days_hint")}</p>
        </details>
      </fieldset>
    </>
  );
}

/** 臨時の日 → 今までの書式の 1 行（範囲はカンマで続ける。空白で区切ると備考と取り違えるため） */
const specialDayLine = (d: SpecialDay): string => [d.date, d.closed ? "休業" : d.hours.map(([a, b]) => `${a}-${b}`).join(","), d.note ?? ""].join(" ").trim();

/** 曜日の欄 → 今までの書式（10:00-14:00,15:00-20:00 / 空 = 定休日）。今までの文字の欄（h<曜日>）が送られたらそれを使う */
function weekdayText(f: Record<string, string | undefined>, d: number): string {
  if (f[`h${d}`] !== undefined) return f[`h${d}`] ?? "";
  if (f[`h${d}_mode`] === "closed") return "";
  return [0, 1]
    .map((i) => [f[`h${d}_s${i}`] ?? "", f[`h${d}_e${i}`] ?? ""] as const)
    .filter(([a, b]) => a || b)
    .map(([a, b]) => `${a}-${b}`)
    .join(",");
}

/** 臨時の日の欄 → 今までの書式の行（残す行・足す行・まとめて貼った行）。今までの textarea（special_days）が送られたらそれを使う */
function specialDaysText(f: Record<string, string | undefined>): string {
  if (f.special_days !== undefined) return f.special_days ?? "";
  const lines: string[] = [];
  for (let i = 0; f[`sd_${i}`] !== undefined; i++) if (f[`sd_${i}_remove`] !== "on") lines.push(f[`sd_${i}`] ?? "");
  const from = (f.add_from ?? "").trim();
  if (from) {
    const to = (f.add_to ?? "").trim();
    const word = f.add_kind === "hours" ? `${f.add_s ?? ""}-${f.add_e ?? ""}` : "休業";
    lines.push([to && to !== from ? `${from}〜${to}` : from, word, (f.add_note ?? "").trim().replace(/\s+/g, " ")].join(" ").trim());
  }
  if (f.special_days_bulk) lines.push(f.special_days_bulk);
  return lines.join("\n");
}

function StoreForm({ store, orgId, values, error, hoursOnly, defs }: { store: OrgStore | null; orgId?: string; values?: Record<string, string | undefined>; error?: string; hoursOnly?: boolean; defs?: ProductField[] | null }) {
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
      <HoursFields hours={hours} days={specialDays(store?.special_days)} values={values} />
      {hoursOnly ? null : (
        <>
          <label for="note">{t("tryon.store_note")}</label>
          <textarea id="note" name="note" rows={2} maxlength={500}>
            {v("note", store?.note ?? "")}
          </textarea>
          <label for="sort_order">{t("tryon.store_sort_order")}</label>
          <input id="sort_order" type="number" name="sort_order" value={v("sort_order", String(store?.sort_order ?? 0))} style="width:6rem" />
          {defs ? (
            <fieldset>
              <legend>{t("stores.fields")}</legend>
              <input type="hidden" name="fields_present" value="1" />
              {defs.map((fd) => {
                const id = `sf_${fd.key}`;
                const cur = store?.fields?.[fd.key];
                const val = v(id, typeof cur === "string" || typeof cur === "number" ? String(cur) : "");
                return (
                  <>
                    <label for={id}>
                      {fd.label}
                      {fd.public ? null : <span class="muted"> {t("fields.private")}</span>}
                    </label>
                    {fd.type === "select" ? (
                      <select id={id} name={id}>
                        <option value="">-</option>
                        {(fd.options ?? []).map((o) => (
                          <option value={o} selected={o === val}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : fd.type === "textarea" ? (
                      <textarea id={id} name={id} rows={3}>
                        {val}
                      </textarea>
                    ) : (
                      <input id={id} name={id} value={val} type={fd.type === "number" ? "number" : fd.type === "url" ? "url" : "text"} step={fd.type === "number" ? "any" : undefined} placeholder={fd.type === "image" ? "/media/…" : undefined} />
                    )}
                  </>
                );
              })}
              <label for="external_ref">{t("stores.external_ref")}</label>
              <input id="external_ref" name="external_ref" value={v("external_ref", store?.external_ref ?? "")} maxlength={64} pattern="[A-Za-z0-9._:\-]{1,64}" />
              <p class="muted">{t("stores.external_ref_help")}</p>
            </fieldset>
          ) : null}
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
    const r = parseRanges(weekdayText(f, d));
    if (r === null) return { hours, special_days: [], error: tf("tryon.invalid_hours", { detail: weekdayLabel(d) }) };
    hours[String(d)] = r;
  }
  const sp = parseSpecialDays(specialDaysText(f), todayHere());
  if (sp.errors.length > 0) return { hours, special_days: [], error: tf("tryon.invalid_special_days", { lines: sp.errors.join(", ") }) };
  return { hours, special_days: sp.days, error: null };
}

/** フォーム → 実店舗の行（owner / admin） */
function storeFromForm(f: Record<string, string | undefined>, defs: ProductField[] | null = null, mediaBase?: string): { row: Partial<OrgStore>; error: string | null } {
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
      // 独自項目と外部コード（0126）。欄があったフォームからだけ
      ...(defs && f.fields_present === "1" ? { fields: storeFieldsFromForm(defs, f, mediaBase), external_ref: (f.external_ref ?? "").trim() || null } : {}),
    },
    error: null,
  };
}

/** 実店舗の独自項目の定義（0126、組織の owner / admin。形は DB が確かめる） */
storesAdmin.post("/fields", requireOwner, async (c: AdminContext) => {
  const org = (await myOrgs(c)).find((o) => o.org_id === c.req.query("org") && o.role !== "member");
  if (!org) return c.redirect("/admin?flash=forbidden");
  const defs = parseStoreFieldRows((await formFields(c))["rows"] ?? "");
  try {
    await owner(c).db.rpc("store_fields_set", { p_org_id: org.org_id, p_defs: storeFieldsForDb(defs) });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`/admin/stores?org=${org.org_id}&flash=generic`);
    throw e;
  }
  return c.redirect(`/admin/stores?org=${org.org_id}&flash=saved`);
});

storesAdmin.get("/new", requireOwner, async (c: AdminContext) => {
  const org = (await myOrgs(c)).find((o) => o.org_id === c.req.query("org") && o.role !== "member");
  if (!org) return c.redirect("/admin?flash=forbidden");
  const defs = await orgStoreFields(c, org.org_id);
  return c.html(
    <AdminLayout title={t("tryon.store_new")} nav crumbs={crumbs(t("tryon.store_new"))}>
      <PageHead title={t("tryon.store_new")} />
      <StoreForm store={null} orgId={org.org_id} defs={defs} />
    </AdminLayout>,
  );
});

storesAdmin.post("/", requireOwner, async (c: AdminContext) => {
  const org = (await myOrgs(c)).find((o) => o.org_id === c.req.query("org") && o.role !== "member");
  if (!org) return c.redirect("/admin?flash=forbidden");
  const f = await formFields(c);
  const defs = await orgStoreFields(c, org.org_id);
  const { row, error } = storeFromForm(f, defs, mediaBaseUrl(c));
  if (error) {
    return c.html(
      <AdminLayout title={t("tryon.store_new")} nav crumbs={crumbs(t("tryon.store_new"))}>
        <PageHead title={t("tryon.store_new")} />
        <StoreForm store={null} orgId={org.org_id} values={f} error={error} defs={defs} />
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
      <StoreForm store={a.store} hoursOnly={!a.admin} defs={a.admin ? await orgStoreFields(c, a.store.org_id) : null} />
    </AdminLayout>,
  );
});

storesAdmin.post("/:storeId", requireOwner, async (c: AdminContext) => {
  const a = await storeAccess(c, param(c, "storeId"));
  if (!a || (!a.admin && !a.perms.includes("hours"))) return c.notFound();
  const f = await formFields(c);
  const back = `/admin/stores/${a.store.id}`;
  const defs = a.admin ? await orgStoreFields(c, a.store.org_id) : null;
  const fail = (error: string) =>
    c.html(
      <AdminLayout title={a.store.name} nav crumbs={crumbs(a.store.name)}>
        <PageHead title={a.store.name} />
        <StoreForm store={a.store} values={f} error={error} hoursOnly={!a.admin} defs={defs} />
      </AdminLayout>,
      400,
    );
  const { db } = owner(c);
  try {
    if (a.admin) {
      const { row, error } = storeFromForm(f, defs, mediaBaseUrl(c));
      if (error) return fail(error);
      try {
        await db.from<OrgStore>("stores").update({ ...row, updated_at: new Date().toISOString() } as Partial<OrgStore>, { id: a.store.id });
      } catch (e) {
        // 外部コードの重なり・項目の値の形（0126）
        if (e instanceof DbError && e.code === "23505") return fail(t("stores.external_ref_taken"));
        if (e instanceof DbError && /store_field_invalid/.test(e.message)) return fail(t("stores.field_invalid"));
        throw e;
      }
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
  const to = await postStatus(c, x.d, `/admin/stores/${x.a.store.id}`);
  // 店舗のホームのボタンから押したら、ホームへ戻る（結果の知らせはそのまま）
  if ((await formFields(c)).back === "home") return c.redirect(`/admin/stores/${x.a.store.id}/home${to.slice(to.indexOf("?"))}`);
  return c.redirect(to);
});

// ---------- 店舗のホーム（スタッフ、スマホ向け。メンテナの決定 2026-11-08） ----------
// 今日の来店予定・取り置き中・届くのを待っている数と、対応中の申し込みのカード。片手で押せる大きなボタン（購入された / されなかった）。
// 店舗に届いた（取り置き）は取り置きの期限を選ぶので、申し込みの画面へ。EC の在庫に戻すボタンは出さない（実店舗のスタッフには戻させない）
storesAdmin.get("/:storeId/home", requireOwner, async (c: AdminContext) => {
  const a = await storeAccess(c, param(c, "storeId"));
  if (!a) return c.notFound();
  const base = `/admin/stores/${a.store.id}`;
  const today = todayHere();
  const tryon = a.perms.includes("tryon");
  const active = tryon ? await owner(c).db.from<RequestRow>("tryon_requests").select("*", { eq: { store_id: a.store.id }, in: { status: ["requested", "sent", "ready"] }, order: "visit_date.asc.nullslast,created_at.asc", limit: 100 }) : [];
  const count = (f: (r: RequestRow) => boolean) => active.filter(f).length;
  return c.html(
    <AdminLayout title={`${a.store.name} · ${t("storehome.title")}`} nav crumbs={crumbs(a.store.name)}>
      <PageHead title={a.store.name} sub={t("storehome.title")} />
      <Flash code={c.req.query("flash")} />
      {tryon ? (
        <>
          <div class="kpis">
            <div class="kpi">
              {t("storehome.today")}
              <strong>{count((r) => r.visit_date === today)}</strong>
            </div>
            <div class="kpi">
              {t("storehome.ready")}
              <strong>{count((r) => r.status === "ready")}</strong>
            </div>
            <div class="kpi">
              {t("storehome.sent")}
              <strong>{count((r) => r.status === "sent")}</strong>
            </div>
          </div>
          <h2>{t("storehome.active")}</h2>
          {active.length === 0 ? (
            <p class="muted">{t("storehome.none")}</p>
          ) : (
            <div class="req-cards">
              {active.map((r) => (
                <section class="req-card">
                  <div>
                    <a href={`${base}/requests/${r.id}`}>
                      <strong>#{r.number}</strong> {r.customer_name ?? ""}
                    </a>{" "}
                    <span class={`status ${r.status === "ready" ? "on" : "info"}`}>{statusLabel(r.status)}</span>
                  </div>
                  <div class="muted">
                    {r.visit_date ? tf("tryon.visit_short", { date: r.visit_date }) : null}
                    {r.status === "ready" && r.hold_until ? ` · ${tf("tryon.hold_short", { date: r.hold_until })}` : null}
                  </div>
                  <div class="actions">
                    {r.status === "ready" ? (
                      <>
                        {(["purchased", "not_purchased"] as const).map((st) => (
                          <form method="post" action={`${base}/requests/${r.id}/status`}>
                            <input type="hidden" name="status" value={st} />
                            <input type="hidden" name="back" value="home" />
                            <button type="submit" class={st === "purchased" ? "big-btn" : "big-btn secondary"}>
                              {t(st === "purchased" ? "storehome.purchased" : "storehome.not_purchased")}
                            </button>
                          </form>
                        ))}
                      </>
                    ) : (
                      <a class="btn big-btn secondary" href={`${base}/requests/${r.id}`}>
                        {r.status === "sent" ? t("storehome.arrived") : t("storehome.open")}
                      </a>
                    )}
                  </div>
                </section>
              ))}
            </div>
          )}
          <p>
            <a href={`${base}/requests`}>{t("storehome.all_requests")}</a>
          </p>
        </>
      ) : null}
      {a.admin || a.perms.includes("hours") ? (
        <p>
          <a href={base}>{t("storehome.hours")}</a>
        </p>
      ) : null}
    </AdminLayout>,
  );
});
