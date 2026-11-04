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
import { DIALOGS_MODULE, DIALOG_AUDIENCES, DIALOG_LAYOUTS, DIALOG_PAGE_KINDS, type DialogAudience, type DialogLayout, type DialogPageKind, type DialogTrigger } from "./dialogs";

/**
 * 同梱モジュール「お店の画面のダイアログ」の管理画面（0110_mod_dialogs、docs/dialogs.md）。項目 marketing。
 *   GET  /admin/shops/:shopId/modules/dialogs              一覧
 *   GET  /admin/shops/:shopId/modules/dialogs/new          作る
 *   GET  /admin/shops/:shopId/modules/dialogs/:id          直す
 *   POST /admin/shops/:shopId/modules/dialogs[/:id]        保存
 *   POST /admin/shops/:shopId/modules/dialogs/:id/delete   消す
 * 形の確かめと組み直しは DB（banto_dialogs_guard）。ここは欄を値にするだけ（商品はスラッグで受けて id にする）
 */
export const dialogsAdmin = new Hono<AppEnv>();

interface DialogRow {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  layout: DialogLayout;
  title: string;
  body: string;
  image_url: string | null;
  buttons: { label: string; url: string }[];
  coupon_code: string | null;
  audience: DialogAudience;
  audience_id: string | null;
  pages: { kinds: DialogPageKind[]; products?: string[]; categories?: string[]; tags?: string[] };
  trigger: DialogTrigger;
  snooze_days: number;
  starts_at: string | null;
  ends_at: string | null;
  /** つないだ外部プラグイン（連携）が作ったもの（0111）。当たる前は無い */
  endpoint_id?: string | null;
}

/** 入れたまま描き直すための値 */
interface Draft {
  name: string;
  enabled: boolean;
  priority: string;
  layout: DialogLayout;
  title: string;
  body: string;
  image_url: string;
  buttons: { label: string; url: string }[];
  coupon_code: string;
  audience: DialogAudience;
  audience_id: string;
  kinds: DialogPageKind[];
  products: string;
  categories: string[];
  tags: string;
  delay_s: string;
  scroll_pct: string;
  exit_intent: boolean;
  visit_pages: string;
  cart_min_jpy: string;
  snooze_days: string;
  starts: string;
  ends: string;
}

const EMPTY: Draft = {
  name: "",
  enabled: true,
  priority: "0",
  layout: "bar",
  title: "",
  body: "",
  image_url: "",
  buttons: [
    { label: "", url: "" },
    { label: "", url: "" },
  ],
  coupon_code: "",
  audience: "all",
  audience_id: "",
  kinds: ["all"],
  products: "",
  categories: [],
  tags: "",
  delay_s: "5",
  scroll_pct: "",
  exit_intent: false,
  visit_pages: "",
  cart_min_jpy: "",
  snooze_days: "7",
  starts: "",
  ends: "",
};

async function scope(c: AdminContext): Promise<ShopRow | null> {
  const shop = await loadShop(c, param(c, "shopId"), "marketing");
  return shop && moduleEnabled(shop.settings, DIALOGS_MODULE) ? shop : null;
}

const base = (shop: ShopRow) => `/admin/shops/${shop.id}/modules/dialogs`;
const list = (s: string) => s.split(/[,、\n]/).map((v) => v.trim()).filter(Boolean);
const num = (s: string) => (s === "" ? undefined : Number(s));

async function audiencesOf(c: AdminContext, shop: ShopRow): Promise<{ id: string; name: string }[]> {
  if (!moduleEnabled(shop.settings, AUDIENCES_MODULE)) return [];
  const rows = await owner(c).db.from<{ id: string; name: string; condition: unknown }>("audiences").select("id,name,condition", { eq: { shop_id: shop.id }, order: "name.asc", limit: 200 }).catch(() => []);
  return rows.map((r) => ({ id: r.id, name: r.name + (audienceDisplayOnly(r.condition) ? " *" : "") }));
}

async function toDraft(c: AdminContext, shop: ShopRow, r: DialogRow): Promise<Draft> {
  const ids = r.pages.products ?? [];
  const products = ids.length ? await owner(c).db.from<{ id: string; slug: string }>("products").select("id,slug", { eq: { shop_id: shop.id }, in: { id: ids } }) : [];
  const buttons = [...r.buttons, { label: "", url: "" }, { label: "", url: "" }].slice(0, 2);
  const str = (v: number | undefined) => (v === undefined ? "" : String(v));
  return {
    name: r.name,
    enabled: r.enabled,
    priority: String(r.priority),
    layout: r.layout,
    title: r.title,
    body: r.body,
    image_url: r.image_url ?? "",
    buttons,
    coupon_code: r.coupon_code ?? "",
    audience: r.audience,
    audience_id: r.audience_id ?? "",
    kinds: r.pages.kinds,
    products: products.map((p) => p.slug).join(", "),
    categories: r.pages.categories ?? [],
    tags: (r.pages.tags ?? []).join(", "),
    delay_s: str(r.trigger.delay_s),
    scroll_pct: str(r.trigger.scroll_pct),
    exit_intent: r.trigger.exit_intent === true,
    visit_pages: str(r.trigger.visit_pages),
    cart_min_jpy: str(r.trigger.cart_min_jpy),
    snooze_days: String(r.snooze_days),
    starts: isoToZonedInput(r.starts_at),
    ends: isoToZonedInput(r.ends_at),
  };
}

function describe(r: DialogRow): string {
  const kinds = r.pages.kinds.map((k) => t(`dlg.kind.${k}` as MessageKey)).join("・");
  return `${t(`dlg.audience.${r.audience}` as MessageKey)} · ${kinds} · ${t(`dlg.layout.${r.layout}` as MessageKey).replace(/（.*$|\s*\(.*$/, "")}`;
}

const FLASH: Record<string, { kind: "ok" | "error"; key: MessageKey }> = {
  saved: { kind: "ok", key: "dlg.saved" },
  deleted: { kind: "ok", key: "dlg.deleted" },
};

const crumbs = (shop: ShopRow, last?: string) => [{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("modules.title"), href: `/admin/shops/${shop.id}/modules` }, ...(last ? [{ label: t("dlg.title"), href: base(shop) }, { label: last }] : [{ label: t("dlg.title") }])];

dialogsAdmin.get("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const rows = await owner(c).db.from<DialogRow>("dialogs").select("*", { eq: { shop_id: shop.id }, order: "priority.desc,created_at.asc", limit: 100 });
  const plugins = await endpointNames(c, shop, rows);
  const fl = FLASH[c.req.query("flash") ?? ""];
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("dlg.title")}`} nav crumbs={crumbs(shop)} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "modules" }}>
      <PageHead title={t("dlg.title")} sub={t("dlg.intro")}>
        <a class="btn" href={`${base(shop)}/new`}>
          {t("dlg.add")}
        </a>
      </PageHead>
      {fl ? <p class={fl.kind === "ok" ? "notice" : "error"}>{t(fl.key)}</p> : null}
      {rows.length === 0 ? (
        <p class="muted">{t("dlg.none")}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("dlg.name")}</th>
              <th>{t("dlg.summary")}</th>
              <th>{t("dlg.period")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td>
                  <a href={`${base(shop)}/${r.id}`}>{r.name}</a>
                </td>
                <td>
                  {describe(r)}
                  {r.endpoint_id ? <div class="muted">{tf("dlg.by_plugin", { name: plugins.get(r.endpoint_id) ?? "?" })}</div> : null}
                </td>
                <td>
                  {r.starts_at ? formatDateTime(r.starts_at) : ""}
                  {r.starts_at || r.ends_at ? " 〜 " : ""}
                  {r.ends_at ? formatDateTime(r.ends_at) : ""}
                </td>
                <td>{r.enabled ? "" : <span class="status off">{t("dlg.disabled")}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p class="muted">{t("dlg.note")}</p>
    </AdminLayout>,
  );
});

/** プラグインが作ったダイアログの連携の名前（0111） */
async function endpointNames(c: AdminContext, shop: ShopRow, rows: readonly { endpoint_id?: string | null }[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.endpoint_id).filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return new Map();
  const eps = await owner(c).db.from<{ id: string; name: string }>("hook_endpoints").select("id,name", { eq: { shop_id: shop.id }, in: { id: ids } }).catch(() => []);
  return new Map(eps.map((e) => [e.id, e.name]));
}

function EditPage(props: { shop: ShopRow; id: string | null; draft: Draft; plugin?: string | null; audiences: { id: string; name: string }[]; categories: CategoryRow[]; access: { role: string; perms: readonly string[] } | undefined; error?: string }) {
  const { shop, draft: d } = props;
  const action = props.id ? `${base(shop)}/${props.id}` : base(shop);
  const numInput = (name: keyof Draft, label: MessageKey, max: number) => (
    <>
      <label for={name}>{t(label)}</label>
      <input id={name} name={name} type="number" min={0} max={max} value={String(d[name])} style="width:10rem" />
    </>
  );
  return (
    <AdminLayout title={`${shop.name} · ${t("dlg.title")}`} nav crumbs={crumbs(shop, d.name || t("dlg.add"))} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: props.access, active: "modules" }}>
      <PageHead title={d.name || t("dlg.add")} />
      {props.plugin ? (
        <p class="notice">
          {tf("dlg.by_plugin", { name: props.plugin })}。{t("dlg.plugin_note")}
        </p>
      ) : null}
      {props.error ? (
        <p class="error" role="alert">
          {props.error}
        </p>
      ) : null}
      <form method="post" action={action} class="card">
        <label for="name">{t("dlg.name")}</label>
        <input id="name" name="name" required maxlength={60} value={d.name} />
        <label style="display:block;margin-top:.5rem">
          <input type="checkbox" name="enabled" value="on" checked={d.enabled} /> {t("dlg.enabled")}
        </label>
        <fieldset>
          <legend>{t("dlg.content")}</legend>
          <label for="layout">{t("dlg.layout")}</label>
          <select id="layout" name="layout">
            {DIALOG_LAYOUTS.map((l) => (
              <option value={l} selected={d.layout === l}>
                {t(`dlg.layout.${l}` as MessageKey)}
              </option>
            ))}
          </select>
          <label for="title">{t("dlg.heading")}</label>
          <input id="title" name="title" required maxlength={100} value={d.title} style="width:100%;max-width:40rem" />
          <label for="body">{t("dlg.body")}</label>
          <textarea id="body" name="body" rows={4} maxlength={500} style="width:100%;max-width:40rem">
            {d.body}
          </textarea>
          <label for="image_url">{t("dlg.image_url")}</label>
          <input id="image_url" name="image_url" type="url" maxlength={500} value={d.image_url} placeholder="https://" style="width:100%;max-width:40rem" />
          {d.buttons.map((b, i) => (
            <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:end">
              <div>
                <label for={`button_label_${i}`}>{tf("dlg.button", { n: String(i + 1) })} · {t("dlg.button_label")}</label>
                <input id={`button_label_${i}`} name={`button_label_${i}`} maxlength={40} value={b.label} />
              </div>
              <div style="flex:1;min-width:16rem">
                <label for={`button_url_${i}`}>{t("dlg.button_url")}</label>
                <input id={`button_url_${i}`} name={`button_url_${i}`} maxlength={500} value={b.url} style="width:100%" />
              </div>
            </div>
          ))}
          <label for="coupon_code">{t("dlg.coupon_code")}</label>
          <input id="coupon_code" name="coupon_code" maxlength={40} pattern="[A-Za-z0-9_\-]{1,40}" value={d.coupon_code} />
        </fieldset>
        <fieldset>
          <legend>{t("dlg.who")}</legend>
          {DIALOG_AUDIENCES.filter((a) => a !== "audience" || props.audiences.length > 0).map((a) => (
            <label style="display:block">
              <input type="radio" name="audience" value={a} checked={d.audience === a} /> {t(`dlg.audience.${a}` as MessageKey)}
            </label>
          ))}
          {props.audiences.length > 0 ? (
            <select name="audience_id" aria-label={t("dlg.audience.audience")}>
              <option value="">—</option>
              {props.audiences.map((a) => (
                <option value={a.id} selected={a.id === d.audience_id}>
                  {a.name}
                </option>
              ))}
            </select>
          ) : null}
        </fieldset>
        <fieldset>
          <legend>{t("dlg.where")}</legend>
          <div style="display:flex;flex-wrap:wrap;gap:.25rem 1rem">
            {DIALOG_PAGE_KINDS.map((k) => (
              <label style="display:inline">
                <input type="checkbox" name={`kind_${k}`} value="on" checked={d.kinds.includes(k)} /> {t(`dlg.kind.${k}` as MessageKey)}
              </label>
            ))}
          </div>
          <p class="muted">{t("dlg.where_hint")}</p>
          <p class="muted">{t("dlg.filter_hint")}</p>
          <label for="products">{t("dlg.filter_products")}</label>
          <input id="products" name="products" value={d.products} placeholder="tee, cap" style="width:100%;max-width:40rem" />
          {props.categories.length > 0 ? (
            <>
              <p style="margin-bottom:.25rem">{t("dlg.filter_categories")}</p>
              <div style="display:flex;flex-wrap:wrap;gap:.25rem 1rem">
                {props.categories.map((cat) => (
                  <label style="display:inline">
                    <input type="checkbox" name={`cat_${cat.id}`} value="on" checked={d.categories.includes(cat.id)} /> {cat.name}
                  </label>
                ))}
              </div>
            </>
          ) : null}
          <label for="tags">{t("dlg.filter_tags")}</label>
          <input id="tags" name="tags" value={d.tags} style="width:100%;max-width:40rem" />
        </fieldset>
        <fieldset>
          <legend>{t("dlg.when")}</legend>
          {numInput("delay_s", "dlg.delay_s", 600)}
          {numInput("scroll_pct", "dlg.scroll_pct", 100)}
          <label style="display:block;margin-top:.5rem">
            <input type="checkbox" name="exit_intent" value="on" checked={d.exit_intent} /> {t("dlg.exit_intent")}
          </label>
          {numInput("visit_pages", "dlg.visit_pages", 50)}
          {numInput("cart_min_jpy", "dlg.cart_min_jpy", 100000000)}
          <p class="muted">{t("dlg.when_hint")}</p>
        </fieldset>
        {numInput("snooze_days", "dlg.snooze_days", 365)}
        {numInput("priority", "dlg.priority", 100)}
        <fieldset>
          <legend>{t("dlg.period")}</legend>
          <label for="starts">{t("dlg.starts_at")}</label>
          <input id="starts" type="datetime-local" name="starts" value={d.starts} />
          <label for="ends">{t("dlg.ends_at")}</label>
          <input id="ends" type="datetime-local" name="ends" value={d.ends} />
        </fieldset>
        <p>
          <button type="submit">{t("dlg.save")}</button>{" "}
          <a class="btn secondary" href={base(shop)}>
            {t("aud.cancel")}
          </a>
        </p>
      </form>
      {props.id ? (
        <form method="post" action={`${base(shop)}/${props.id}/delete`} onsubmit={`return confirm(${JSON.stringify(t("dlg.delete_confirm"))})`}>
          <button type="submit" class="secondary small">
            {t("dlg.delete")}
          </button>
        </form>
      ) : null}
    </AdminLayout>
  );
}

async function page(c: AdminContext, shop: ShopRow, id: string | null, draft: Draft, error?: string, status: 200 | 400 = 200, plugin: string | null = null) {
  const [audiences, categories] = await Promise.all([audiencesOf(c, shop), loadCategories(owner(c).db, shop.id)]);
  return c.html(<EditPage shop={shop} id={id} draft={draft} plugin={plugin} audiences={audiences} categories={categories} access={c.get("shopAccess")} {...(error ? { error } : {})} />, status);
}

dialogsAdmin.get("/new", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  return page(c, shop, null, EMPTY);
});

dialogsAdmin.get("/:id", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const [row] = await owner(c).db.from<DialogRow>("dialogs").select("*", { eq: { id: param(c, "id"), shop_id: shop.id }, limit: 1 });
  if (!row) return c.notFound();
  const plugin = row.endpoint_id ? ((await endpointNames(c, shop, [row])).get(row.endpoint_id) ?? "?") : null;
  return page(c, shop, row.id, await toDraft(c, shop, row), undefined, 200, plugin);
});

async function save(c: AdminContext, id: string | null) {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const f = (await c.req.parseBody()) as Record<string, string | File>;
  const s = (k: string) => (typeof f[k] === "string" ? (f[k] as string).trim() : "");
  const pick = <T extends string>(v: string, allowed: readonly T[], fallback: T): T => ((allowed as readonly string[]).includes(v) ? (v as T) : fallback);
  const draft: Draft = {
    name: s("name"),
    enabled: s("enabled") === "on",
    priority: s("priority") || "0",
    layout: pick(s("layout"), DIALOG_LAYOUTS, "bar"),
    title: s("title"),
    body: typeof f["body"] === "string" ? (f["body"] as string).replace(/\r\n/g, "\n").trim() : "",
    image_url: s("image_url"),
    buttons: [0, 1].map((i) => ({ label: s(`button_label_${i}`), url: s(`button_url_${i}`) })),
    coupon_code: s("coupon_code"),
    audience: pick(s("audience"), DIALOG_AUDIENCES, "all"),
    audience_id: s("audience_id"),
    kinds: DIALOG_PAGE_KINDS.filter((k) => s(`kind_${k}`) === "on"),
    products: s("products"),
    categories: Object.keys(f).filter((k) => k.startsWith("cat_") && f[k] === "on").map((k) => k.slice(4)),
    tags: s("tags"),
    delay_s: s("delay_s"),
    scroll_pct: s("scroll_pct"),
    exit_intent: s("exit_intent") === "on",
    visit_pages: s("visit_pages"),
    cart_min_jpy: s("cart_min_jpy"),
    snooze_days: s("snooze_days") || "0",
    starts: s("starts"),
    ends: s("ends"),
  };
  const fail = (field: string) => page(c, shop, id, draft, tf("dlg.invalid", { field }), 400);
  const db = owner(c).db;
  // 商品はスラッグで受け、同じショップのものだけ id にする（無いものがあれば保存しない）
  const slugs = list(draft.products);
  const products = slugs.length ? await db.from<{ id: string; slug: string }>("products").select("id,slug", { eq: { shop_id: shop.id }, in: { slug: slugs } }) : [];
  const missing = slugs.filter((x) => !products.some((p) => p.slug === x));
  if (missing.length) return fail(`${t("dlg.filter_products")}: ${missing.join(", ")}`);
  if (draft.kinds.length === 0) return fail(t("dlg.where"));
  const nums = { delay_s: num(draft.delay_s), scroll_pct: num(draft.scroll_pct), visit_pages: num(draft.visit_pages), cart_min_jpy: num(draft.cart_min_jpy) };
  if (Object.values(nums).some((v) => v !== undefined && !Number.isInteger(v))) return fail(t("dlg.when"));
  const trigger: DialogTrigger = {};
  if (nums.delay_s !== undefined && nums.delay_s > 0) trigger.delay_s = nums.delay_s;
  if (nums.scroll_pct !== undefined && nums.scroll_pct > 0) trigger.scroll_pct = nums.scroll_pct;
  if (draft.exit_intent) trigger.exit_intent = true;
  if (nums.visit_pages !== undefined && nums.visit_pages > 0) trigger.visit_pages = nums.visit_pages;
  if (nums.cart_min_jpy !== undefined && nums.cart_min_jpy > 0) trigger.cart_min_jpy = nums.cart_min_jpy;
  const startsIso = draft.starts ? zonedInputToIso(draft.starts) : null;
  const endsIso = draft.ends ? zonedInputToIso(draft.ends) : null;
  if ((draft.starts && !startsIso) || (draft.ends && !endsIso) || (startsIso && endsIso && startsIso >= endsIso)) return fail(t("dlg.period"));
  const tags = list(draft.tags);
  const values = {
    name: draft.name,
    enabled: draft.enabled,
    priority: Number(draft.priority) || 0,
    layout: draft.layout,
    title: draft.title,
    body: draft.body,
    image_url: draft.image_url || null,
    buttons: draft.buttons.filter((b) => b.label || b.url),
    coupon_code: draft.coupon_code || null,
    audience: draft.audience,
    audience_id: draft.audience === "audience" ? draft.audience_id || null : null,
    pages: { kinds: draft.kinds, ...(products.length ? { products: products.map((p) => p.id) } : {}), ...(draft.categories.length ? { categories: draft.categories } : {}), ...(tags.length ? { tags } : {}) },
    trigger,
    snooze_days: Number(draft.snooze_days) || 0,
    starts_at: startsIso,
    ends_at: endsIso,
  };
  try {
    if (id) await db.from("dialogs").update(values, { id, shop_id: shop.id });
    else await db.from("dialogs").insert({ ...values, shop_id: shop.id });
  } catch (e) {
    if (e instanceof DbError) {
      if (/dialogs_limit/.test(e.message)) return page(c, shop, id, draft, t("dlg.limit"), 400);
      const field = /invalid_dialog:(\w+)/.exec(e.message)?.[1];
      const label: Record<string, MessageKey> = { buttons: "dlg.button_url", pages: "dlg.where", trigger: "dlg.when", audience: "dlg.who" };
      return fail(field && label[field] ? t(label[field]!).replace("{n}", "") : e.message.slice(0, 200));
    }
    throw e;
  }
  return c.redirect(`${base(shop)}?flash=saved`);
}

dialogsAdmin.post("/", requireOwner, (c: AdminContext) => save(c, null));
dialogsAdmin.post("/:id", requireOwner, (c: AdminContext) => save(c, param(c, "id")));
dialogsAdmin.post("/:id/delete", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  await owner(c).db.from("dialogs").delete({ id: param(c, "id"), shop_id: shop.id });
  return c.redirect(`${base(shop)}?flash=deleted`);
});
