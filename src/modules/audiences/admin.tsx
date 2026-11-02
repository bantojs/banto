import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { ShopRow } from "../../db/types";
import { t, type MessageKey } from "../../i18n";
import { AdminLayout, PageHead } from "../../routes/admin/layout";
import { owner, param, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { loadShop } from "../../routes/admin/shops";
import { moduleEnabled } from "../registry";
import { customerFields, type CustomerField } from "../../customers/fields";
import { describeAudience } from "../../members/audience";
import { audiencesCacheKey } from "../../routes/audience-render";

/**
 * 同梱モジュール「会員の条件」（0097_audiences、docs/audiences.md）。項目 marketing。
 *   GET  /admin/shops/:shopId/modules/audiences              一覧
 *   GET  /admin/shops/:shopId/modules/audiences/new          作る
 *   GET  /admin/shops/:shopId/modules/audiences/:id          直す
 *   POST /admin/shops/:shopId/modules/audiences[/:id]        保存
 *   POST /admin/shops/:shopId/modules/audiences/:id/delete   消す
 * 形の確かめと組み直しは DB（banto_audiences_guard）。画面は「会員であること」と、独自項目の条件の並び（かつ / または）を組み立てるだけ。
 * それより複雑な入れ子は「JSON で書く」の欄に書く。
 */
export const audiencesAdmin = new Hono<AppEnv>();

import { AUDIENCES_MODULE } from "../../members/audience";
export { AUDIENCES_MODULE };
const MAX_ROWS = 10;
type Op = "in" | "not_in" | "gte" | "lte" | "set";
const OPS: Op[] = ["in", "not_in", "gte", "lte", "set"];
interface Row {
  attr: string;
  op: Op;
  value: string;
}
interface AudienceRow {
  id: string;
  name: string;
  condition: unknown;
  updated_at: string;
}

async function scope(c: AdminContext): Promise<ShopRow | null> {
  const shop = await loadShop(c, param(c, "shopId"), "marketing");
  return shop && moduleEnabled(shop.settings, AUDIENCES_MODULE) ? shop : null;
}

const base = (shop: ShopRow) => `/admin/shops/${shop.id}/modules/audiences`;

export function audienceWords() {
  return { member: t("aud.member"), and: t("aud.and"), or: t("aud.or"), not: t("aud.not"), set: t("aud.set"), anyone: t("aud.anyone") };
}

/** 保存してある条件を画面の組み立ての形に戻す（戻せなければ null = JSON の欄で直す） */
function toBuilder(cond: unknown): { member: boolean; join: "all" | "any"; rows: Row[] } | null {
  const leaf = (x: unknown): Row | null => {
    if (!x || typeof x !== "object") return null;
    const o = x as Record<string, unknown>;
    if (o["not"] && typeof o["not"] === "object") {
      const n = o["not"] as Record<string, unknown>;
      return typeof n["attr"] === "string" && Array.isArray(n["in"]) ? { attr: n["attr"], op: "not_in", value: (n["in"] as unknown[]).map(String).join(", ") } : null;
    }
    if (typeof o["attr"] !== "string") return null;
    if (Array.isArray(o["in"])) return { attr: o["attr"], op: "in", value: (o["in"] as unknown[]).map(String).join(", ") };
    if (typeof o["gte"] === "number") return { attr: o["attr"], op: "gte", value: String(o["gte"]) };
    if (typeof o["lte"] === "number") return { attr: o["attr"], op: "lte", value: String(o["lte"]) };
    if (o["set"] === true) return { attr: o["attr"], op: "set", value: "" };
    return null;
  };
  const group = (x: unknown): { join: "all" | "any"; rows: Row[] } | null => {
    const one = leaf(x);
    if (one) return { join: "all", rows: [one] };
    if (!x || typeof x !== "object") return null;
    const o = x as Record<string, unknown>;
    for (const j of ["all", "any"] as const) {
      if (Array.isArray(o[j])) {
        const rows = (o[j] as unknown[]).map(leaf);
        return rows.every((r): r is Row => r !== null) ? { join: j, rows } : null;
      }
    }
    return null;
  };
  if (!cond || typeof cond !== "object") return null;
  const o = cond as Record<string, unknown>;
  if (o["member"] === true) return { member: true, join: "all", rows: [] };
  if (Array.isArray(o["all"])) {
    const parts = o["all"] as unknown[];
    if (parts.length >= 1 && (parts[0] as Record<string, unknown>)?.["member"] === true) {
      if (parts.length === 1) return { member: true, join: "all", rows: [] };
      if (parts.length === 2) {
        const g = group(parts[1]);
        if (g) return { member: true, ...g };
      }
      const rows = parts.slice(1).map(leaf);
      if (rows.every((r): r is Row => r !== null)) return { member: true, join: "all", rows };
      return null;
    }
  }
  const g = group(cond);
  return g ? { member: false, ...g } : null;
}

/** 画面の組み立てから条件の JSON を作る（形の確かめは DB） */
function fromBuilder(member: boolean, join: "all" | "any", rows: Row[]): unknown {
  const leaves = rows.map((r) => {
    const vals = r.value.split(/[,、\n]/).map((v) => v.trim()).filter(Boolean);
    if (r.op === "in") return { attr: r.attr, in: vals };
    if (r.op === "not_in") return { not: { attr: r.attr, in: vals } };
    if (r.op === "set") return { attr: r.attr, set: true };
    return { attr: r.attr, [r.op]: Number(r.value) };
  });
  const body = leaves.length === 0 ? null : leaves.length === 1 ? leaves[0] : { [join]: leaves };
  if (member) return body ? { all: [{ member: true }, body] } : { member: true };
  return body;
}

const FLASH: Record<string, { kind: "ok" | "error"; key: MessageKey }> = {
  saved: { kind: "ok", key: "aud.saved" },
  deleted: { kind: "ok", key: "aud.deleted" },
  invalid: { kind: "error", key: "aud.invalid" },
  invalid_attr: { kind: "error", key: "aud.invalid_attr" },
  empty: { kind: "error", key: "aud.empty" },
  duplicate: { kind: "error", key: "aud.duplicate" },
  in_use: { kind: "error", key: "aud.in_use" },
};

audiencesAdmin.get("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const rows = await owner(c).db.from<AudienceRow>("audiences").select("id,name,condition,updated_at", { eq: { shop_id: shop.id }, order: "name.asc", limit: 200 });
  const labels = Object.fromEntries(customerFields(shop.settings).map((f) => [f.key, f.label]));
  const fl = FLASH[c.req.query("flash") ?? ""];
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("aud.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("modules.title"), href: `/admin/shops/${shop.id}/modules` }, { label: t("aud.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "modules" }}>
      <PageHead title={t("aud.title")} sub={t("aud.intro")}>
        <a class="btn" href={`${base(shop)}/new`}>
          {t("aud.add")}
        </a>
      </PageHead>
      {fl ? <p class={fl.kind === "ok" ? "notice" : "error"}>{t(fl.key)}</p> : null}
      {customerFields(shop.settings).length === 0 ? <p class="notice">{t("aud.no_fields")}</p> : null}
      {rows.length === 0 ? (
        <p class="muted">{t("aud.none")}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("aud.name")}</th>
              <th>{t("aud.condition")}</th>
              <th>{t("aud.snippet")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td>
                  <a href={`${base(shop)}/${r.id}`}>{r.name}</a>
                </td>
                <td>{describeAudience(r.condition, labels, audienceWords())}</td>
                <td>
                  <code style="user-select:all;white-space:nowrap">{audienceSnippet(r)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > 0 ? <p class="muted">{t("aud.snippet_hint")}</p> : null}
      <p class="muted">{t("aud.cookie_hint")}</p>
    </AdminLayout>,
  );
});

/** ページ・記事の本文に貼る囲みの始まりの行（src/content/audience-blocks.ts。title は編集の画面の目印だけ） */
export const audienceSnippet = (r: { id: string; name: string }) => `::: audience id=${r.id} title="${r.name.replace(/["\n\r]/g, "").slice(0, 200)}"`;

function EditPage(props: { shop: ShopRow; row: AudienceRow | null; fields: CustomerField[]; access: { role: string; perms: readonly string[] } | undefined; flash?: { kind: "ok" | "error"; key: MessageKey } }) {
  const { shop, row, fields } = props;
  const b = row ? toBuilder(row.condition) : { member: true, join: "all" as const, rows: [] };
  const slots = Math.min(MAX_ROWS, Math.max((b?.rows.length ?? 0) + 2, 3));
  const action = row ? `${base(shop)}/${row.id}` : base(shop);
  const opLabel: Record<Op, MessageKey> = { in: "aud.op_in", not_in: "aud.op_not_in", gte: "aud.op_gte", lte: "aud.op_lte", set: "aud.op_set" };
  return (
    <AdminLayout title={`${shop.name} · ${t("aud.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("aud.title"), href: base(shop) }, { label: row?.name ?? t("aud.add") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: props.access, active: "modules" }}>
      <PageHead title={row?.name ?? t("aud.add")} />
      {props.flash ? <p class={props.flash.kind === "ok" ? "notice" : "error"}>{t(props.flash.key)}</p> : null}
      <form method="post" action={action} class="card">
        <label for="name">{t("aud.name")}</label>
        <input id="name" name="name" required maxlength={60} value={row?.name ?? ""} />
        <fieldset>
          <legend>{t("aud.builder")}</legend>
          <label>
            <input type="checkbox" name="member" value="on" checked={b?.member ?? true} /> {t("aud.member_required")}
          </label>
          <p>
            <label style="display:inline-block;margin-right:1rem">
              <input type="radio" name="join" value="all" checked={(b?.join ?? "all") === "all"} /> {t("aud.join_all")}
            </label>
            <label style="display:inline-block">
              <input type="radio" name="join" value="any" checked={b?.join === "any"} /> {t("aud.join_any")}
            </label>
          </p>
          <table>
            <thead>
              <tr>
                <th>{t("aud.attr")}</th>
                <th>{t("aud.op")}</th>
                <th>{t("aud.value")}</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: slots }, (_, i) => {
                const r = b?.rows[i];
                return (
                  <tr>
                    <td>
                      <select name={`attr_${i}`} aria-label={t("aud.attr")}>
                        <option value="">—</option>
                        {fields.map((f) => (
                          <option value={f.key} selected={r?.attr === f.key}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select name={`op_${i}`} aria-label={t("aud.op")}>
                        {OPS.map((op) => (
                          <option value={op} selected={(r?.op ?? "in") === op}>
                            {t(opLabel[op])}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input name={`value_${i}`} value={r?.value ?? ""} maxlength={2000} aria-label={t("aud.value")} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p class="muted">{t("aud.value_hint")}</p>
        </fieldset>
        <details open={row !== null && b === null}>
          <summary>{t("aud.json")}</summary>
          <p class="muted">{t("aud.json_hint")}</p>
          <textarea name="condition_json" rows={8} style="width:100%;font-family:monospace">
            {row && b === null ? JSON.stringify(row.condition, null, 2) : ""}
          </textarea>
        </details>
        <p>
          <button type="submit">{t("shop.save")}</button>
        </p>
      </form>
      {row ? (
        <form method="post" action={`${base(shop)}/${row.id}/delete`}>
          <button type="submit" class="secondary small">
            {t("aud.delete")}
          </button>
        </form>
      ) : null}
    </AdminLayout>
  );
}

audiencesAdmin.get("/new", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const fl = FLASH[c.req.query("flash") ?? ""];
  return c.html(<EditPage shop={shop} row={null} fields={customerFields(shop.settings)} access={c.get("shopAccess")} {...(fl ? { flash: fl } : {})} />);
});

audiencesAdmin.get("/:id", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const [row] = await owner(c).db.from<AudienceRow>("audiences").select("id,name,condition,updated_at", { eq: { id: param(c, "id"), shop_id: shop.id }, limit: 1 });
  if (!row) return c.notFound();
  const fl = FLASH[c.req.query("flash") ?? ""];
  return c.html(<EditPage shop={shop} row={row} fields={customerFields(shop.settings)} access={c.get("shopAccess")} {...(fl ? { flash: fl } : {})} />);
});

async function save(c: AdminContext, id: string | null) {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const f = (await c.req.parseBody()) as Record<string, string | File>;
  const s = (k: string) => (typeof f[k] === "string" ? (f[k] as string).trim() : "");
  const back = id ? `${base(shop)}/${id}` : `${base(shop)}/new`;
  let condition: unknown;
  const json = s("condition_json");
  if (json) {
    try {
      condition = JSON.parse(json);
    } catch {
      return c.redirect(`${back}?flash=invalid`);
    }
  } else {
    const rows: Row[] = [];
    for (let i = 0; i < MAX_ROWS; i++) {
      const attr = s(`attr_${i}`);
      const op = s(`op_${i}`) as Op;
      if (!attr || !OPS.includes(op)) continue;
      const value = s(`value_${i}`);
      if (op !== "set" && !value) continue;
      rows.push({ attr, op, value });
    }
    condition = fromBuilder(s("member") === "on", s("join") === "any" ? "any" : "all", rows);
    if (condition === null) return c.redirect(`${back}?flash=empty`);
  }
  const db = owner(c).db;
  try {
    if (id) await db.from("audiences").update({ name: s("name"), condition }, { id, shop_id: shop.id });
    else id = String((await db.from<{ id: string; shop_id: string; name: string; condition: unknown }>("audiences").insert({ shop_id: shop.id, name: s("name"), condition }))[0]?.id ?? "");
  } catch (e) {
    if (e instanceof DbError) {
      const code = /invalid_audience_attr/.test(e.message) ? "invalid_attr" : /duplicate|unique/.test(e.message) ? "duplicate" : "invalid";
      return c.redirect(`${back}?flash=${code}`);
    }
    throw e;
  }
  // お店の画面が覚えている条件の一覧を捨てる（この isolate の分。ほかは AUDIENCES_CACHE_TTL で入れ替わる）
  await c.get("adapters").cache.delete(audiencesCacheKey(shop.id));
  return c.redirect(`${base(shop)}?flash=saved`);
}

audiencesAdmin.post("/", requireOwner, (c: AdminContext) => save(c, null));
audiencesAdmin.post("/:id", requireOwner, (c: AdminContext) => save(c, param(c, "id")));
audiencesAdmin.post("/:id/delete", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  try {
    await owner(c).db.from("audiences").delete({ id: param(c, "id"), shop_id: shop.id });
  } catch (e) {
    // 使っている場所（0098 以降の商品・ページ・価格の決まり）があれば DB が断る
    if (e instanceof DbError) return c.redirect(`${base(shop)}/${param(c, "id")}?flash=in_use`);
    throw e;
  }
  await c.get("adapters").cache.delete(audiencesCacheKey(shop.id));
  return c.redirect(`${base(shop)}?flash=deleted`);
});
