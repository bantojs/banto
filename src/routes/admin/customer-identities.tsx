/**
 * 会員の LINE・Google のログインの ID の取り込み（0168、メンテナの決定 2026-11-23、docs/members.md「LINE・Google のログインを移す」）。
 *   GET  /admin/shops/:shopId/customers/import/identities   取り込みの画面
 *   POST 同じ                                                 step=check: 書かずに結果を出す / step=import: 結ぶ
 * 使えるのは組織の owner / admin だけ（どの会員として入れるかを決める力なので、メールアドレスの変更と同じ線）。
 * CSV は Worker で行に直し、500 行ずつ DB の member_identities_import に渡す（会員の引き当て・上書きしない判定は DB）。
 * 画面にも DB の応答にも LINE・Google の ID は出さない（行の番号と理由だけ）。AI 用 API には出さない。
 */
import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { migrated } from "../../db/migration-state";
import { t, tf, type MessageKey } from "../../i18n";
import { customerFields } from "../../customers/fields";
import { parseCsv } from "../../util/csv";
import { AdminLayout, PageHead } from "./layout";
import { owner, param, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";

export const IDENTITY_IMPORT_MIGRATION = "0168_member_identity_import";
/** 1 回の取り込みの上限（行・バイト）。DB には 500 行ずつ渡す */
export const IDENTITY_IMPORT_MAX_ROWS = 5000;
export const IDENTITY_IMPORT_MAX_BYTES = 1024 * 1024;
const CHUNK = 500;

export const customerIdentities = new Hono<AppEnv>();

type Match = "email" | "external_ref" | "attribute";
const OUTCOMES = ["linked", "unchanged", "not_found", "ambiguous", "invalid", "subject_taken", "member_has_other"] as const;
type Outcome = (typeof OUTCOMES)[number];

interface DbResult {
  counts: Partial<Record<Outcome, number>>;
  issues: { row: number; provider?: string; reason: Outcome }[];
}
interface Issue {
  line: number;
  provider?: string;
  reason: Outcome;
}
interface Parsed {
  rows: { key: string; line?: string; google?: string }[];
  /** rows[i] の CSV の行番号（1 から、見出しを含む、空行は数えない） */
  lines: number[];
}

/** CSV → 行。見出し（key・line・google）があれば列の名前で、無ければ key, line, google の順 */
export function parseIdentityCsv(text: string): Parsed | "too_many_rows" | "empty" {
  const table = parseCsv(text);
  if (table.length === 0) return "empty";
  const head = table[0]!.map((c) => c.trim().toLowerCase());
  const hasHeader = head.includes("key");
  const col = (name: string, pos: number) => (hasHeader ? head.indexOf(name) : pos);
  const ki = col("key", 0);
  const li = col("line", 1);
  const gi = col("google", 2);
  const body = hasHeader ? table.slice(1) : table;
  if (body.length === 0) return "empty";
  if (body.length > IDENTITY_IMPORT_MAX_ROWS) return "too_many_rows";
  const at = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  const rows = body.map((r) => {
    const line = at(r, li);
    const google = at(r, gi);
    return { key: at(r, ki), ...(line ? { line } : {}), ...(google ? { google } : {}) };
  });
  return { rows, lines: body.map((_, i) => i + 1 + (hasHeader ? 1 : 0)) };
}

function matchOf(v: unknown): Match {
  return v === "external_ref" || v === "attribute" ? v : "email";
}

interface PageProps {
  base: string;
  fields: { key: string; label: string }[];
  match?: Match;
  matchKey?: string;
  csv?: string;
  counts?: Record<Outcome, number>;
  issues?: Issue[];
  done?: boolean;
  fatal?: string | null;
}

function Page(p: PageProps) {
  const match = p.match ?? "email";
  return (
    <div>
      <p class="muted">{t("identities.intro")}</p>
      <p class="muted">{t("identities.provider_note")}</p>
      {p.fatal ? <p class="error">{t(`identities.fatal.${p.fatal}` as MessageKey)}</p> : null}
      {p.counts ? (
        <div>
          <h2>{p.done ? t("identities.done_title") : t("identities.check_title")}</h2>
          <ul>
            {OUTCOMES.map((o) => (
              <li class={o === "linked" || o === "unchanged" ? undefined : p.counts![o] > 0 ? "error" : undefined}>
                {t(`identities.outcome.${o}` as MessageKey)}: {p.counts![o]}
              </li>
            ))}
          </ul>
          {p.issues && p.issues.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>{t("identities.col_line")}</th>
                  <th>{t("identities.col_provider")}</th>
                  <th>{t("identities.col_reason")}</th>
                </tr>
              </thead>
              <tbody>
                {p.issues.slice(0, 1000).map((x) => (
                  <tr>
                    <td>{x.line}</td>
                    <td>{x.provider === "line" ? "LINE" : x.provider === "google" ? "Google" : ""}</td>
                    <td>{t(`identities.outcome.${x.reason}` as MessageKey)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {!p.done && p.counts.linked > 0 ? (
            <form method="post" action={p.base}>
              <input type="hidden" name="step" value="import" />
              <input type="hidden" name="match" value={match} />
              <input type="hidden" name="match_key" value={p.matchKey ?? ""} />
              <textarea name="csv" hidden>
                {p.csv ?? ""}
              </textarea>
              <p>
                <button type="submit">{tf("identities.go", { n: p.counts.linked })}</button>
              </p>
            </form>
          ) : null}
        </div>
      ) : null}

      <h2>{t("identities.upload_title")}</h2>
      <form method="post" action={p.base} enctype="multipart/form-data">
        <input type="hidden" name="step" value="check" />
        <fieldset>
          <legend>{t("identities.match")}</legend>
          <label>
            <input type="radio" name="match" value="email" checked={match === "email"} /> {t("identities.match.email")}
          </label>
          <label>
            <input type="radio" name="match" value="external_ref" checked={match === "external_ref"} /> {t("identities.match.external_ref")}
          </label>
          <label>
            <input type="radio" name="match" value="attribute" checked={match === "attribute"} disabled={p.fields.length === 0} /> {t("identities.match.attribute")}
          </label>
          <label for="provider">{t("identities.match.provider")}</label>
          <input id="provider" name="provider" maxlength={100} value={match === "external_ref" ? (p.matchKey ?? "") : ""} placeholder="pocket" />
          {p.fields.length > 0 ? (
            <div>
              <label for="field">{t("identities.match.field")}</label>
              <select id="field" name="field">
                {p.fields.map((f) => (
                  <option value={f.key} selected={match === "attribute" && p.matchKey === f.key}>
                    {f.label}（{f.key}）
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </fieldset>
        <label for="file">{t("identities.file")}</label>
        <input id="file" type="file" name="file" accept=".csv,text/csv" />
        <label for="csv">{t("identities.paste")}</label>
        <textarea id="csv" name="csv" rows={6} style="width:100%;max-width:60rem;font-family:monospace" placeholder={"key,line,google\nC001,U0123456789abcdef0123456789abcdef,"}></textarea>
        <p>
          <button type="submit">{t("identities.check")}</button>
        </p>
      </form>

      <h2>{t("identities.format_title")}</h2>
      <p class="muted">{t("identities.format")}</p>
      <p class="muted">
        <a href="https://github.com/bantojs/banto/blob/main/docs/members.md" target="_blank" rel="noopener">
          docs/members.md
        </a>
      </p>
    </div>
  );
}

async function guard(c: AdminContext) {
  const shopId = param(c, "shopId");
  const shop = await loadShop(c, shopId, "admin");
  if (!shop) return null;
  if (!(await migrated({ db: owner(c).db, cache: c.get("adapters").cache }, IDENTITY_IMPORT_MIGRATION))) return null;
  return shop;
}

function layout(c: AdminContext, shop: { id: string; name: string; settings?: Record<string, unknown> | null }, props: Omit<PageProps, "base" | "fields">) {
  const base = `/admin/shops/${shop.id}/customers/import/identities`;
  const fields = customerFields(shop.settings ?? {}).map((f) => ({ key: f.key, label: f.label }));
  return c.html(
    <AdminLayout
      title={`${shop.name} · ${t("identities.title")}`}
      nav
      crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("customers.title"), href: `/admin/shops/${shop.id}/customers` }, { label: t("identities.title") }]}
      shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings ?? {} }, access: c.get("shopAccess"), active: "customers" }}
    >
      <PageHead title={t("identities.title")} />
      <Page base={base} fields={fields} {...props} />
    </AdminLayout>,
  );
}

customerIdentities.get("/:shopId/customers/import/identities", requireOwner, async (c: AdminContext) => {
  const shop = await guard(c);
  if (!shop) return c.text(t("shop.not_found"), 404);
  return layout(c, shop, {});
});

customerIdentities.post("/:shopId/customers/import/identities", requireOwner, async (c: AdminContext) => {
  const shop = await guard(c);
  if (!shop) return c.text(t("shop.not_found"), 404);
  const body = await c.req.parseBody();
  const match = matchOf(body["match"]);
  const matchKey = match === "external_ref" ? String(body["provider"] ?? body["match_key"] ?? "").trim() : match === "attribute" ? String(body["field"] ?? body["match_key"] ?? "").trim() : "";
  const keep = { match, matchKey };
  const file = body["file"];
  let csv = typeof body["csv"] === "string" ? body["csv"] : "";
  if (file && typeof file !== "string" && file.size > 0) {
    if (file.size > IDENTITY_IMPORT_MAX_BYTES) return layout(c, shop, { ...keep, fatal: "too_large" });
    csv = await file.text();
  }
  if (csv.length > IDENTITY_IMPORT_MAX_BYTES) return layout(c, shop, { ...keep, fatal: "too_large" });
  if (match !== "email" && !matchKey) return layout(c, shop, { ...keep, fatal: "match_key" });
  const parsed = parseIdentityCsv(csv);
  if (parsed === "empty" || parsed === "too_many_rows") return layout(c, shop, { ...keep, fatal: parsed });
  const write = body["step"] === "import";
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  const issues: Issue[] = [];
  const { db } = owner(c);
  for (let i = 0; i < parsed.rows.length; i += CHUNK) {
    let r: DbResult;
    try {
      r = await db.rpc<DbResult>("member_identities_import", { p_shop_id: shop.id, p_match: match, p_match_key: match === "email" ? null : matchKey, p_rows: parsed.rows.slice(i, i + CHUNK), p_dry_run: !write });
    } catch (e) {
      if (e instanceof DbError) {
        const fatal = /invalid_match_key/.test(e.message) ? "match_key" : "db";
        // 途中の塊まで結んだときは、そこまでの結果も見せる（結んだ分は残る。もう一度取り込めば「変わらない」になる）
        return layout(c, shop, { ...keep, fatal, ...(i > 0 ? { counts, issues, done: write } : {}) });
      }
      throw e;
    }
    for (const o of OUTCOMES) counts[o] += Number(r.counts[o] ?? 0);
    for (const x of r.issues) issues.push({ line: parsed.lines[i + x.row] ?? i + x.row + 1, reason: x.reason, ...(x.provider ? { provider: x.provider } : {}) });
  }
  return layout(c, shop, { ...keep, csv, counts, issues, done: write });
});
