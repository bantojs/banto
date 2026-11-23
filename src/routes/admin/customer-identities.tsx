/**
 * 会員の LINE・Google のログインの ID の取り込み（0168、メンテナの決定 2026-11-23、docs/members.md「LINE・Google のログインを移す」）。
 *   GET  /admin/shops/:shopId/customers/import/identities   取り込みの画面
 *   POST 同じ                                                 step=check: 書かずに結果を出す / step=import: 結ぶ
 * 使えるのは組織の owner / admin だけ（どの会員として入れるかを決める力なので、メールアドレスの変更と同じ線）。
 * CSV は Worker で行に直し、CSV の中で重なる行（同じ ID・同じ引く値の 2 つ目から）を外してから、500 行ずつ DB の
 * member_identities_import に渡す（会員の引き当て・上書きしない判定は DB）。重なりを先に外すので、確かめるときと結ぶときの結果が同じになる。
 * 結果（件数と行の番号・理由）に ID は出さない。ただし「確かめる」の後の「結ぶ」のフォームには上げた CSV をそのまま入れて渡す
 * （覚えておく場所を持たないため）ので、その画面は覚えさせない（no-store）。AI 用 API には出さない。
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
const OUTCOMES = ["linked", "unchanged", "not_found", "ambiguous", "invalid", "duplicate_in_csv", "subject_taken", "member_has_other"] as const;
const ISSUES_SHOWN = 1000;
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

/** DB と同じ形（0168）。形の誤りは DB が invalid にする */
const LINE_ID_RE = /^U[0-9a-f]{32}$/;
const GOOGLE_ID_RE = /^[0-9]{1,200}$/;

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

/**
 * CSV の中の重なり: LINE・Google ごとに、同じ ID・同じ引く値（メールは大文字小文字を区別しない）の 2 つ目からを外す。
 * 同じ会員の LINE と Google が別の行にあるのは重なりではない（両方送る）。形の誤った ID・引く値は DB が invalid にするので、
 * ここでは覚えない（後の正しい行を止めない）。
 * DB には塊ごとに渡すので、塊をまたぐ重なりは DB では見えない（確かめるときは塊ごとに巻き戻すため）。先にここで外す
 */
export function splitDuplicates(rows: Parsed["rows"], match: Match): { send: number[]; duplicates: number[] } {
  const seen = new Set<string>();
  const send: number[] = [];
  const duplicates: number[] = [];
  rows.forEach((r, i) => {
    const raw = r.key.trim();
    const k = raw && raw.length <= 254 ? (match === "email" ? raw.toLowerCase() : raw) : "";
    const own: [string, string][] = [];
    if (r.line && LINE_ID_RE.test(r.line)) own.push(["line", r.line]);
    if (r.google && GOOGLE_ID_RE.test(r.google)) own.push(["google", r.google]);
    const marks = own.flatMap(([p, id]) => [`id:${p}:${id}`, ...(k ? [`key:${p}:${k}`] : [])]);
    if (marks.some((m) => seen.has(m))) {
      duplicates.push(i);
      return;
    }
    for (const m of marks) seen.add(m);
    send.push(i);
  });
  return { send, duplicates };
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
                {p.issues.slice(0, ISSUES_SHOWN).map((x) => (
                  <tr>
                    <td>{x.line}</td>
                    <td>{x.provider === "line" ? "LINE" : x.provider === "google" ? "Google" : ""}</td>
                    <td>{t(`identities.outcome.${x.reason}` as MessageKey)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {p.issues && p.issues.length > ISSUES_SHOWN ? <p class="muted">{tf("identities.more_issues", { n: p.issues.length - ISSUES_SHOWN })}</p> : null}
          {!p.done && !p.fatal && p.counts.linked > 0 ? (
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
          <input id="provider" name="provider" maxlength={100} value={match === "external_ref" ? (p.matchKey ?? "") : ""} placeholder="crm" />
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

function sortIssues(xs: Issue[]): Issue[] {
  return xs.sort((a, b) => a.line - b.line);
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
  // 引く値にできるのは文字と数の項目だけ（DB も同じに断る。保存してある文字のまま比べる）
  const fields = customerFields(shop.settings ?? {})
    .filter((f) => f.type === "text" || f.type === "number")
    .map((f) => ({ key: f.key, label: f.label }));
  c.header("cache-control", "no-store");
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
  if (new TextEncoder().encode(csv).byteLength > IDENTITY_IMPORT_MAX_BYTES) return layout(c, shop, { ...keep, fatal: "too_large" });
  if (match !== "email" && !matchKey) return layout(c, shop, { ...keep, fatal: "match_key" });
  const parsed = parseIdentityCsv(csv);
  if (parsed === "empty" || parsed === "too_many_rows") return layout(c, shop, { ...keep, fatal: parsed });
  const write = body["step"] === "import";
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  const issues: Issue[] = [];
  const { send, duplicates } = splitDuplicates(parsed.rows, match);
  counts.duplicate_in_csv = duplicates.length;
  const dupIssues: Issue[] = duplicates.map((i) => ({ line: parsed.lines[i] ?? i + 1, reason: "duplicate_in_csv" }));
  const { db } = owner(c);
  for (let i = 0; i < send.length; i += CHUNK) {
    const part = send.slice(i, i + CHUNK);
    let r: DbResult;
    try {
      r = await db.rpc<DbResult>("member_identities_import", { p_shop_id: shop.id, p_match: match, p_match_key: match === "email" ? null : matchKey, p_rows: part.map((j) => parsed.rows[j]), p_dry_run: !write });
    } catch (e) {
      if (e instanceof DbError) {
        const fatal = /invalid_match_key/.test(e.message) ? "match_key" : "db";
        // 途中の塊まで結んだときは、そこまでの結果も見せる（結んだ分は残る。もう一度取り込めば「変わらない」になる）
        return layout(c, shop, { ...keep, fatal, ...(i > 0 ? { counts, issues: sortIssues([...issues, ...dupIssues]), done: write } : {}) });
      }
      throw e;
    }
    for (const o of OUTCOMES) counts[o] += Number(r.counts[o] ?? 0);
    for (const x of r.issues) {
      const j = part[x.row] ?? 0;
      issues.push({ line: parsed.lines[j] ?? j + 1, reason: x.reason, ...(x.provider ? { provider: x.provider } : {}) });
    }
  }
  return layout(c, shop, { ...keep, csv, counts, issues: sortIssues([...issues, ...dupIssues]), done: write });
});
