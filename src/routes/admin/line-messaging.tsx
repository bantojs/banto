import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { t } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { sealSecret } from "../../members/secret-box";
import { LINE_SECRET_PURPOSE } from "../../plugins/line_token";
import { AdminLayout, PageHead } from "./layout";
import { formFields, owner, param, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";
import { can } from "./access";
import { NotSavedNotice, failCode, updateShop } from "./shop-save";
import { createPrivilegedDb } from "../../db/privileged";
import { lineTokenFor } from "../../plugins/line_token";
import { LINE_PUSH_URL } from "../../plugins/line_notify";
import { bundledPluginUrl } from "../../plugins/types";
import { noticeLine, type NoticeKind } from "../../notices/templates";
import { kindsFor, sampleValues } from "./notices";
import type { MessageKey } from "../../i18n";
import { actorHeader } from "../../audit";
import { migrated } from "../../db/migration-state";
import { UUID_RE } from "../../util/cursor";

/** テスト送信の宛先を会員のメールアドレスで選ぶ（0177） */
export const LINE_TEST_MEMBER_MIGRATION = "0177_line_test_member";
/** 会員の詳細から会員の id で選ぶ（0178。メールアドレスの無い会員にも） */
export const LINE_TEST_MEMBER_ID_MIGRATION = "0178_line_test_member_id";

/** 宣伝の月の上限の既定（0105 の banto_line_marketing_limit と同じ） */
export const LINE_MARKETING_LIMIT_DEFAULT = 150;
export const lineMarketingLimit = (settings: Record<string, unknown> | null | undefined): number => {
  const v = settings?.["line_marketing_limit"];
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 9_999_999 ? v : LINE_MARKETING_LIMIT_DEFAULT;
};

/**
 * ショップの LINE 公式アカウント（Messaging API のチャネルアクセストークン、0021、docs/line.md）。
 *   GET  /admin/shops/:shopId/line-messaging          設定済みかどうか（トークンは二度と出さない）
 *   POST /admin/shops/:shopId/line-messaging          保存（サイトの秘密から作った鍵で暗号化してから送る）
 *   POST /admin/shops/:shopId/line-messaging/delete   消す
 *   POST /admin/shops/:shopId/line-messaging/limit    宣伝の月の上限（0105。外部プラグインが LINE で送る口の分だけ数える。項目 settings）
 *   POST /admin/shops/:shopId/line-messaging/test     テスト送信（知らせの種類を選び、今の文面に見本の値を差し込んで、指定の利用者 ID へ 1 通。結果をその場で出す）
 * 画面には「LINE で購入者に知らせる」の最近の配信（日時・出来事・状態・エラー・メールへの配り直し）も出す。お客様の LINE の利用者 ID・氏名は出さない
 * 同梱プラグイン「LINE 通知」「LINE で購入者に知らせる」が使う。CLAUDE.md §1-5 の例外（メンテナの決定 2026-10-17）。
 */
export const lineMessaging = new Hono<AppEnv>();

lineMessaging.get("/:shopId/line-messaging", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "integrations");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const row = await owner(c).db.from<{ updated_at: string }>("shop_secret_boxes").selectOne("updated_at", { eq: { shop_id: shop.id, purpose: LINE_SECRET_PURPOSE } });
  const base = `/admin/shops/${shop.id}/line-messaging`;
  const flash = c.req.query("flash");
  // 宣伝の月の上限と今月の数（0105）
  const usage = can(c.get("shopAccess"), "marketing") ? await owner(c).db.rpc<{ count: number; limit: number }>("line_marketing_usage", { p_shop_id: shop.id }) : null;
  const { buyerEndpoint, mailEndpoint, notifyTo } = await lineEndpoints(c, shop.id);
  const recent = buyerEndpoint ? await recentLineDeliveries(c, shop.id, buyerEndpoint, mailEndpoint) : [];
  const kinds = kindsFor(shop.settings);
  const sentTo = c.req.query("to") ?? "";
  // テスト送信は文面（項目 settings でしか読めない shop_notice_texts）を使うので、settings も持つ人だけ
  const canTest = can(c.get("shopAccess"), "settings");
  // 会員のメールアドレスで宛先を選ぶ（0177）のは、会員の項目も持つ人だけ
  const canMember = canTest && can(c.get("shopAccess"), "customers") && (await migrated({ db: owner(c).db, cache: c.get("adapters").cache }, LINE_TEST_MEMBER_MIGRATION));
  const testFlash = (TEST_FLASHES as readonly string[]).includes(flash ?? "") ? (flash as TestFlash) : null;
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("linemsg.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("plugins.title"), href: `/admin/shops/${shop.id}/plugins` }, { label: t("linemsg.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "plugins", here: "line-messaging" }}>
      <PageHead title={t("linemsg.title")} />
      {flash === "saved" ? <p class="notice">{t("linemsg.saved")}</p> : null}
      {flash === "deleted" ? <p class="notice">{t("linemsg.deleted")}</p> : null}
      {flash === "invalid" ? <p class="error">{t("linemsg.invalid")}</p> : null}
      {flash === "generic" ? <p class="error">{t("error.generic")}</p> : null}
      <NotSavedNotice flash={flash} />
      <p>{t("linemsg.intro")}</p>
      <p class={row ? "notice" : "muted"}>{row ? `${t("linemsg.status_set")}（${formatDateTime(row.updated_at)}）` : t("linemsg.status_missing")}</p>
      <ol class="muted">
        <li>{t("linemsg.step_channel")}</li>
        <li>{t("linemsg.step_token")}</li>
        <li>{t("linemsg.step_provider")}</li>
        <li>{t("linemsg.step_plugin")}</li>
      </ol>
      <form method="post" action={base}>
        <label for="token">{t("linemsg.token")}</label>
        <input id="token" name="token" type="password" maxlength={500} autocomplete="new-password" required style="width:100%;max-width:36rem" />
        <p class="muted">{t("linemsg.token_note")}</p>
        <p>
          <button type="submit">{t("linemsg.save")}</button>
        </p>
      </form>
      <section class="card">
        <h2>{t("linemsg.marketing_title")}</h2>
        <p class="muted">{t("linemsg.marketing_intro")}</p>
        {flash === "limit_saved" ? <p class="notice">{t("linemsg.limit_saved")}</p> : null}
        {usage ? <p>{t("linemsg.marketing_count").replace("{count}", String(usage.count)).replace("{limit}", String(usage.limit))}</p> : null}
        {can(c.get("shopAccess"), "admin") ? (
          <form method="post" action={`${base}/limit`}>
            <label for="limit">{t("linemsg.limit")}</label>
            <input id="limit" name="limit" type="number" min={0} max={9999999} step={1} value={String(lineMarketingLimit(shop.settings))} required style="width:10rem" />
            <p class="muted">{t("linemsg.limit_note")}</p>
            <p>
              <button type="submit">{t("linemsg.save")}</button>
            </p>
          </form>
        ) : null}
      </section>
    
      <section class="card" id="test">
        <h2>{t("linemsg.test_title")}</h2>
        <p class="muted">{t("linemsg.test_intro")}</p>
        {testFlash ? <p class={testFlash === "test_ok" || testFlash === "test_ok_env" ? "notice" : "error"}>{t(`linemsg.${testFlash}`)}</p> : null}
        {!canTest ? <p class="muted">{t("linemsg.test_needs_settings")}</p> : (
        <form method="post" action={`${base}/test`}>
          <label for="kind">{t("linemsg.test_kind")}</label>
          <select id="kind" name="kind">
            {kinds.map((k) => (
              <option value={k} selected={c.req.query("kind") === k}>
                {t(`notices.kind.${k}` as MessageKey)}
              </option>
            ))}
          </select>
          {canMember ? (
            <>
              <label for="test-email">{t("linemsg.test_email")}</label>
              <input id="test-email" name="email" type="email" maxlength={320} autocomplete="off" style="width:100%;max-width:24rem" />
              <p class="muted">{t("linemsg.test_email_note")}</p>
            </>
          ) : null}
          <label for="to">{t(canMember ? "linemsg.test_to_or" : "linemsg.test_to")}</label>
          <input id="to" name="to" value={LINE_USER_ID_RE.test(sentTo) ? sentTo : notifyTo} pattern="U[0-9a-f]{32}" maxlength={33} required={!canMember} style="width:100%;max-width:24rem" />
          <p class="muted">{t("linemsg.test_to_note")}</p>
          <p>
            <button type="submit">{t("linemsg.test_send")}</button>
          </p>
        </form>
        )}
        <p>
          <a href={`/admin/shops/${shop.id}/notices`}>{t("linemsg.edit_texts")}</a>
        </p>
      </section>
      <section class="card" id="recent">
        <h2>{t("linemsg.recent_title")}</h2>
        {!buyerEndpoint ? (
          <p class="muted">{t("linemsg.recent_off")}</p>
        ) : recent.length === 0 ? (
          <p class="muted">{t("linemsg.recent_empty")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("linemsg.recent_at")}</th>
                <th>{t("linemsg.recent_event")}</th>
                <th>{t("linemsg.recent_status")}</th>
                <th>{t("linemsg.recent_note")}</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((d) => (
                <tr>
                  <td>{formatDateTime(d.created_at)}</td>
                  <td>
                    {d.orderId ? <a href={`/admin/shops/${shop.id}/orders/${d.orderId}`}>{eventLabel(d.event)}</a> : eventLabel(d.event)}
                    {d.lineOnly ? <span class="muted">（{t("linemsg.recent_line_only")}）</span> : null}
                  </td>
                  <td>{t(`linemsg.status_${d.status === "delivered" || d.status === "failed" ? d.status : "pending"}` as MessageKey)}{d.attempts > 1 ? `（${d.attempts}）` : ""}</td>
                  <td>
                    {d.fellBack ? <span>{t("linemsg.recent_fell_back")}</span> : null}
                    {d.last_error ? <span class="muted"> {d.last_error.slice(0, 120)}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p class="muted">{t("linemsg.recent_note_privacy")}</p>
      </section>
      {row ? (
        <form method="post" action={`${base}/delete`}>
          <button type="submit">{t("linemsg.delete")}</button>
        </form>
      ) : null}
    </AdminLayout>,
  );
});

lineMessaging.post("/:shopId/line-messaging", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "integrations");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const base = `/admin/shops/${shop.id}/line-messaging`;
  const token = ((await formFields(c)).token ?? "").trim();
  const secret = c.get("sessionSecret");
  // チャネルアクセストークン（長期）は英数字と + / = の長い文字列
  if (!secret || token.length < 20 || token.length > 500 || !/^[A-Za-z0-9+/=._-]+$/.test(token)) return c.redirect(`${base}?flash=invalid`);
  const box = await sealSecret(secret, shop.id, LINE_SECRET_PURPOSE, token);
  try {
    await owner(c).db.rpc("shop_secret_save", { p_shop_id: shop.id, p_purpose: LINE_SECRET_PURPOSE, p_secret_box: box });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${base}?flash=invalid`);
    throw e;
  }
  return c.redirect(`${base}?flash=saved`);
});

lineMessaging.post("/:shopId/line-messaging/delete", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "integrations");
  if (!shop) return c.text(t("shop.not_found"), 404);
  await owner(c).db.rpc("shop_secret_save", { p_shop_id: shop.id, p_purpose: LINE_SECRET_PURPOSE, p_secret_box: null });
  return c.redirect(`/admin/shops/${shop.id}/line-messaging?flash=deleted`);
});

lineMessaging.post("/:shopId/line-messaging/limit", requireOwner, async (c: AdminContext) => {
  // 鍵 line_marketing_limit は組織の owner / admin（0129）
  const shop = await loadShop(c, param(c, "shopId"), "admin");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const base = `/admin/shops/${shop.id}/line-messaging`;
  const n = Number((await formFields(c)).limit ?? "");
  if (!Number.isInteger(n) || n < 0 || n > 9_999_999) return c.redirect(`${base}?flash=invalid`);
  try {
    await updateShop(c, shop.id, { settings: { ...(shop.settings ?? {}), line_marketing_limit: n } });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${base}?flash=${failCode(e)}`);
    throw e;
  }
  return c.redirect(`${base}?flash=limit_saved`);
});

/** テスト送信の結果（画面に出すのはこの決まった知らせだけ） */
const TEST_FLASHES = ["test_ok", "test_ok_env", "test_invalid", "test_member_not_found", "test_member_needs_customers", "test_no_token", "test_token_broken", "test_bad_token", "test_not_friend", "test_limit", "test_failed"] as const;
type TestFlash = (typeof TEST_FLASHES)[number];

/** LINE の利用者 ID（Messaging API の送り先、U と 32 桁の 16 進） */
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/;

const eventLabel = (event: string): string => {
  const key = `linemsg.event.${event}` as MessageKey;
  const label = t(key);
  return label === key ? event : label;
};

/** 「LINE で購入者に知らせる」「メール通知」の送信先と、「LINE 通知」の送り先（テスト送信の宛先の初期値） */
async function lineEndpoints(c: AdminContext, shopId: string): Promise<{ buyerEndpoint: string | null; mailEndpoint: string | null; notifyTo: string }> {
  const rows = await owner(c).db.from<{ id: string; url: string; settings: Record<string, unknown> | null }>("hook_endpoints").select("id,url,settings", {
    eq: { shop_id: shopId },
    in: { url: [bundledPluginUrl("line_buyer_notify"), bundledPluginUrl("email_resend"), bundledPluginUrl("line_notify")] },
  });
  const by = (id: string) => rows.find((r) => r.url === bundledPluginUrl(id));
  const to = by("line_notify")?.settings?.["to"];
  return { buyerEndpoint: by("line_buyer_notify")?.id ?? null, mailEndpoint: by("email_resend")?.id ?? null, notifyTo: typeof to === "string" && LINE_USER_ID_RE.test(to.trim()) ? to.trim() : "" };
}

interface RecentLine {
  id: string;
  event: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  orderId: string | null;
  lineOnly: boolean;
  fellBack: boolean;
}

/** 最近の 50 件。お客様の LINE の利用者 ID・氏名は持たない（payload は注文・申し込みの id と印だけ） */
async function recentLineDeliveries(c: AdminContext, shopId: string, endpointId: string, mailEndpointId: string | null): Promise<RecentLine[]> {
  type Row = { id: string; event: string; status: string; attempts: number; last_error: string | null; created_at: string; payload: Record<string, unknown> | null };
  const rows = await owner(c).db.from<Row>("hook_deliveries").select("id,event,status,attempts,last_error,created_at,payload", { eq: { shop_id: shopId, endpoint_id: endpointId }, order: "created_at.desc", limit: 50 });
  // メールへの配り直し（0176）: メール通知の配信のうち fallback_of がこの一覧の配信を指すもの
  const fellBack = new Set<string>();
  const oldest = rows.at(-1)?.created_at;
  if (mailEndpointId && oldest && rows.some((r) => r.payload?.["notice_line_only"] === true)) {
    // 配り直しは元の配信より後にできる。一覧のいちばん古い配信より後のメール通知の配信だけを見る
    const mails = await owner(c).db.from<{ payload: Record<string, unknown> | null }>("hook_deliveries").select("payload", { eq: { shop_id: shopId, endpoint_id: mailEndpointId }, where: [{ col: "created_at", op: "gte", value: oldest }], order: "created_at.desc", limit: 500 });
    for (const m of mails) if (typeof m.payload?.["fallback_of"] === "string") fellBack.add(m.payload["fallback_of"]);
  }
  return rows.map((r) => ({
    id: r.id,
    event: r.event,
    status: r.status,
    attempts: r.attempts,
    last_error: r.last_error,
    created_at: r.created_at,
    orderId: typeof r.payload?.["order_id"] === "string" ? r.payload["order_id"] : null,
    lineOnly: r.payload?.["notice_line_only"] === true,
    fellBack: fellBack.has(r.id),
  }));
}

/** テスト送信の結果（LINE の応答 → 画面の知らせ） */
export function lineTestResult(status: number): TestFlash {
  if (status >= 200 && status < 300) return "test_ok";
  if (status === 400 || status === 403) return "test_not_friend";
  if (status === 401) return "test_bad_token";
  if (status === 429) return "test_limit";
  return "test_failed";
}

lineMessaging.post("/:shopId/line-messaging/test", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "integrations");
  // 文面（項目 settings でしか読めない）を使うので、settings も要る
  if (!shop || !can(c.get("shopAccess"), "settings")) return c.text(t("shop.not_found"), 404);
  const base = `/admin/shops/${shop.id}/line-messaging`;
  const f = await formFields(c);
  // 会員の詳細の「この会員に LINE のテスト送信」（0178）: 会員の id で選び、結果は会員の詳細に戻す
  const memberId = UUID_RE.test(f.customer_id ?? "") ? (f.customer_id as string) : null;
  const email = memberId ? "" : (f.email ?? "").trim();
  let to = email || memberId ? "" : (f.to ?? "").trim();
  const kind = kindsFor(shop.settings).find((k) => k === f.kind) as NoticeKind | undefined;
  // 宛先の UID は、運営者が入れたもの（LINE_USER_ID_RE に合うもの）だけを画面に戻す。会員のメール・id で引いた UID・メールは戻さない
  const typed = email || memberId ? "" : to;
  const back = (code: string) =>
    memberId
      ? c.redirect(`/admin/shops/${shop.id}/customers/${memberId}?flash=line_${code}#line-test`)
      : c.redirect(`${base}?flash=${code}&to=${encodeURIComponent(LINE_USER_ID_RE.test(typed) ? typed : "")}${kind ? `&kind=${kind}` : ""}#test`);
  if (!kind || (!email && !memberId && !LINE_USER_ID_RE.test(to)) || email.length > 320) return back("test_invalid");
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) return back("test_failed");
  // 権限は上の loadShop（項目 integrations）と settings で確かめた。トークンの暗号文は運営者には読ませないので service_role で読み、Worker で開く（connect.tsx と同じ）。
  // 会員の宛先を引いたことは監査ログに運営者の名で残す（X-Banto-Actor）
  const privileged = createPrivilegedDb({ url, serviceRoleKey, fetch: c.get("deps").fetch, actor: actorHeader("user", owner(c).session.user_id) });
  if (email || memberId) {
    // 会員のメールアドレス（0177）か会員の id（0178）で宛先を選ぶ: 会員の項目も要る。UID は Worker の中だけで使う
    if (!can(c.get("shopAccess"), "customers")) return back("test_member_needs_customers");
    const state = { db: owner(c).db, cache: c.get("adapters").cache };
    if (!(await migrated(state, memberId ? LINE_TEST_MEMBER_ID_MIGRATION : LINE_TEST_MEMBER_MIGRATION))) return back("test_failed");
    let r: Awaited<ReturnType<typeof privileged.lineTestRecipient>>;
    try {
      r = memberId ? await privileged.lineTestRecipientMember(shop.id, memberId) : await privileged.lineTestRecipient(shop.id, email);
    } catch {
      return back("test_failed");
    }
    if (!r) return back("test_member_not_found");
    to = r.line_user_id;
  }
  let token: string | null;
  let fromShop: boolean;
  try {
    // ショップのトークンが無ければ、プラグインと同じくデプロイの変数（LINE_CHANNEL_ACCESS_TOKEN）。どちらで送ったかを知らせる
    fromShop = Boolean(await privileged.shopSecret(shop.id, LINE_SECRET_PURPOSE));
    token = await lineTokenFor({ db: privileged, secret: c.get("sessionSecret") ?? null, config: cfg }, shop.id);
  } catch {
    return back("test_token_broken");
  }
  if (!token) return back("test_no_token");
  // 今の文面（直していなければ既定）に見本の値を差し込む。テストと分かるように頭に印
  const body = noticeLine(kind, await privileged.shopNoticeTexts(shop.id, kind), sampleValues(kind, shop.name));
  const text = `${t("linemsg.test_prefix")}\n${body}`;
  try {
    const res = await c.get("deps").fetch(LINE_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Line-Retry-Key": crypto.randomUUID() },
      body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
    });
    const result = lineTestResult(res.status);
    return back(result === "test_ok" && !fromShop ? "test_ok_env" : result);
  } catch {
    return back("test_failed");
  }
});
