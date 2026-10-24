/**
 * クーポンの CSV 取り込み（同梱モジュール coupons。docs/coupon-csv.md、0043_coupon_import）。
 *   GET  .../import               取り込みの画面（列の説明・ひな形・AI への頼み方）
 *   POST .../import               step=check: 書き込まずに行ごとの結果を出す / step=import: 作る
 *   GET  .../import/template.csv  ひな形
 * CSV は Worker で行の形に直し、DB の import_coupons に 1 回で渡す（検査・既にあるかどうか・会員の発行は DB）。
 * 書き込みは owner の JWT（import_coupons が marketing の項目を確かめる）。
 */
import { Hono } from "hono";
import type { Child } from "hono/jsx";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { migrated } from "../../db/migration-state";
import { t, tf, type MessageKey } from "../../i18n";
import { AdminLayout, PageHead } from "../../routes/admin/layout";
import { owner, type AdminContext } from "../../routes/admin/context";
import { requireOwner } from "../../routes/admin/auth";
import { scope } from "./admin";
import { COUPON_CSV_COLUMNS, MAX_COUPON_CSV_BYTES, couponCsv, parseCouponCsv } from "./csv";

export const COUPON_IMPORT_MIGRATION = "0043_coupon_import";

export const couponImport = new Hono<AppEnv>();

interface RowResult {
  line: number;
  status: "ok" | "created" | "existing" | "error";
  code?: string | null;
  name?: string | null;
  error?: string;
  members?: number;
  active?: boolean;
}

/** DB と Worker の理由（invalid_value、unknown_products: a, b など）→ 画面の文。知らないものはそのまま */
function reason(raw: string): string {
  const [head, ...rest] = raw.split(":");
  const key = `coupons.import.err.${head!.trim()}` as MessageKey;
  const text = t(key);
  if (text === key) return raw;
  return rest.length > 0 ? `${text}: ${rest.join(":").trim()}` : text;
}

function Page(props: { base: string; ready: boolean; csv?: string; results?: RowResult[]; done?: boolean; fatal?: string | null }) {
  const counts = { ok: 0, created: 0, existing: 0, error: 0 };
  for (const r of props.results ?? []) counts[r.status]++;
  return (
    <div>
      <p class="muted">{t("coupons.import.intro")}</p>
      {!props.ready ? <p class="error">{tf("coupons.import.migration_required", { version: COUPON_IMPORT_MIGRATION })}</p> : null}
      {props.fatal ? <p class="error">{t(`coupons.import.fatal.${props.fatal}` as MessageKey)}</p> : null}
      {props.results ? (
        <div>
          <h2>{props.done ? t("coupons.import.done_title") : t("coupons.import.check_title")}</h2>
          <p class={counts.error > 0 ? "error" : "notice"}>
            {tf(props.done ? "coupons.import.done_line" : "coupons.import.check_line", { ok: counts.ok, created: counts.created, existing: counts.existing, error: counts.error })}
          </p>
          <table>
            <thead>
              <tr>
                <th>{t("coupons.import.col_line")}</th>
                <th>{t("coupons.code")}</th>
                <th>{t("coupons.name")}</th>
                <th>{t("coupons.import.col_result")}</th>
              </tr>
            </thead>
            <tbody>
              {props.results.map((r) => (
                <tr>
                  <td>{r.line}</td>
                  <td>
                    <code>{r.code ?? "-"}</code>
                  </td>
                  <td>{r.name ?? ""}</td>
                  <td class={r.status === "error" ? "error" : undefined}>
                    {r.status === "error"
                      ? reason(r.error ?? "")
                      : t(`coupons.import.status.${r.status}` as MessageKey) +
                        (r.members ? ` ${tf("coupons.import.members", { n: r.members })}` : "") +
                        (r.active === false ? ` ${t("coupons.import.inactive")}` : "")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!props.done && counts.ok > 0 ? (
            <form method="post" action={`${props.base}/import`}>
              <input type="hidden" name="step" value="import" />
              <textarea name="csv" hidden>
                {props.csv ?? ""}
              </textarea>
              <p>
                <button type="submit">{tf("coupons.import.go", { n: counts.ok })}</button>
              </p>
              {counts.error > 0 ? <p class="muted">{t("coupons.import.go_hint")}</p> : null}
            </form>
          ) : null}
        </div>
      ) : null}

      <h2>{t("coupons.import.upload_title")}</h2>
      <form method="post" action={`${props.base}/import`} enctype="multipart/form-data">
        <input type="hidden" name="step" value="check" />
        <label for="file">{t("coupons.import.file")}</label>
        <input id="file" type="file" name="file" accept=".csv,text/csv" />
        <label for="csv">{t("coupons.import.paste")}</label>
        <textarea id="csv" name="csv" rows={6} style="width:100%;max-width:60rem;font-family:monospace"></textarea>
        <p>
          <button type="submit" disabled={!props.ready}>
            {t("coupons.import.check")}
          </button>{" "}
          <a href={`${props.base}/import/template.csv`}>{t("coupons.import.template")}</a>
        </p>
      </form>

      <h2>{t("coupons.import.columns_title")}</h2>
      <table>
        <tbody>
          {COUPON_CSV_COLUMNS.map((k) => (
            <tr>
              <td>
                <code>{k}</code>
              </td>
              <td>{t(`coupons.import.column.${k}` as MessageKey)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="muted">{t("coupons.import.rules")}</p>

      <h2>{t("coupons.import.ai_title")}</h2>
      <p class="muted">{t("coupons.import.ai_hint")}</p>
      <textarea readonly rows={12} style="width:100%;max-width:60rem">
        {t("coupons.import.ai_prompt")}
      </textarea>
      <p class="muted">
        <a href="https://github.com/bantojs/banto/blob/main/docs/coupon-csv.md" target="_blank" rel="noopener">
          docs/coupon-csv.md
        </a>
      </p>
    </div>
  );
}

const ready = (c: AdminContext) => migrated({ db: owner(c).db, cache: c.get("adapters").cache }, COUPON_IMPORT_MIGRATION);

function layout(c: AdminContext, shop: { id: string; name: string }, body: Child) {
  const base = `/admin/shops/${shop.id}/modules/coupons`;
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("coupons.import.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("mod.coupons.name"), href: base }, { label: t("coupons.import.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name }, access: c.get("shopAccess"), active: "modules" }}>
      <PageHead title={t("coupons.import.title")} />
      {body}
    </AdminLayout>,
  );
}

couponImport.get("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  return layout(c, shop, <Page base={`/admin/shops/${shop.id}/modules/coupons`} ready={await ready(c)} />);
});

couponImport.get("/template.csv", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const csv = couponCsv([
    { code: "AUTUMN10", name: "秋の 10% OFF", kind: "percent", value: 10, starts_at: "2026-10-01", ends_at: "2026-10-31", usage_limit: 100, per_customer_limit: 1, min_subtotal_jpy: 3000, active: true },
    { code: "VIP500", name: "VIP の方へ 500 円引き", kind: "fixed", value: 500, member_emails: "vip1@example.com;vip2@example.com", ends_at: "2026-12-31", active: true, note: "member_emails の人ごとに 1 枚ずつ発行（共通のコードは作らない）" },
  ]);
  return c.body(csv, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="banto-coupons-template.csv"', "Cache-Control": "no-store" });
});

couponImport.post("/", requireOwner, async (c: AdminContext) => {
  const shop = await scope(c);
  if (!shop) return c.notFound();
  const base = `/admin/shops/${shop.id}/modules/coupons`;
  if (!(await ready(c))) return layout(c, shop, <Page base={base} ready={false} />);
  const body = await c.req.parseBody();
  const file = body["file"];
  let csv = typeof body["csv"] === "string" ? body["csv"] : "";
  if (file && typeof file !== "string" && file.size > 0) {
    if (file.size > MAX_COUPON_CSV_BYTES) return layout(c, shop, <Page base={base} ready fatal="too_large" />);
    csv = await file.text();
  }
  if (csv.length > MAX_COUPON_CSV_BYTES) return layout(c, shop, <Page base={base} ready fatal="too_large" />);
  if (!csv.trim()) return layout(c, shop, <Page base={base} ready fatal="empty" />);
  const parsed = parseCouponCsv(csv);
  if (parsed.fatal) return layout(c, shop, <Page base={base} ready fatal={parsed.fatal} />);
  const write = body["step"] === "import";
  let fromDb: RowResult[] = [];
  if (parsed.rows.length > 0) {
    try {
      fromDb = await owner(c).db.rpc<RowResult[]>("import_coupons", { p_shop_id: shop.id, p_rows: parsed.rows, p_dry_run: !write });
    } catch (e) {
      if (e instanceof DbError) return layout(c, shop, <Page base={base} ready fatal="db" />);
      throw e;
    }
  }
  const results = [...fromDb, ...parsed.errors.map((x): RowResult => ({ line: x.line, status: "error", code: x.code || null, error: x.error }))].sort((a, b) => a.line - b.line);
  return layout(c, shop, <Page base={base} ready csv={csv} results={results} done={write} />);
});
