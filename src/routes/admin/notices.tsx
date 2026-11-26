import { Hono } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import { migrated } from "../../db/migration-state";
import { t, type MessageKey } from "../../i18n";
import {
  DEFAULT_NOTICE_TEXTS,
  NOTICE_KINDS,
  NOTICE_SUBJECT_MAX,
  NOTICE_TEXTS_MIGRATION,
  LINE_NOTICE_LINKS_MIGRATION,
  PAYMENT_REMINDER_MIGRATION,
  defaultLineText,
  checkNoticeText,
  fillNotice,
  noticeBodyMax,
  noticeSpec,
  noticeTextErrorOf,
  staleNoticeTexts,
  type NoticeChannel,
  type NoticeKind,
  type NoticeTextError,
  type NoticeTextRow,
} from "../../notices/templates";
import { AdminLayout, PageHead } from "./layout";
import { formFields, owner, param, type AdminContext } from "./context";
import { requireOwner } from "./auth";
import { loadShop } from "./shops";
import { moduleEnabled } from "../../modules/registry";
import { LINE_NOTICE_STYLES, lineNoticeStyle } from "../../notices/line-card";
import { NotSavedNotice, failCode, updateShop } from "./shop-save";

/**
 * お知らせの文面（0154、docs/notices.md）。項目 settings。注文の知らせと、お店で試着のお客様あての知らせ（モジュールが ON のとき）
 *   GET  /admin/shops/:shopId/notices   知らせごとのメールと LINE の文面・使える差し込み・見本
 *   POST /admin/shops/:shopId/notices   1 つ保存（kind・channel・subject・body）か、既定に戻す（reset）
 * 決まりに合わない文面は保存させない（DB の notice_text_set も断る）。保存済みで今の決まりに合わない文面は警告を出す（送るときは既定で送っている）
 */
export const notices = new Hono<AppEnv>();

export const ORDER_KINDS: readonly NoticeKind[] = ["order_paid", "order_shipped"];
export const TRYON_KINDS: readonly NoticeKind[] = ["tryon_requested", "tryon_ready", "tryon_reminder", "tryon_extended", "tryon_cancelled"];
/** この画面で扱う知らせ。お店で試着はモジュールが ON のショップと、OFF でも直した文面が残っているとき（見て・既定に戻せるように） */
export const kindsFor = (settings: Record<string, unknown> | null | undefined, rows: readonly NoticeTextRow[] = [], reminders = false): readonly NoticeKind[] => [
  ...ORDER_KINDS,
  ...(moduleEnabled(settings, "store_tryon") || rows.some((r) => (TRYON_KINDS as readonly string[]).includes(r.kind)) ? TRYON_KINDS : []),
  // お支払いのお願い（0181。reminders = 当てたか）: 送る設定にしたショップと、直した文面が残っているとき
  ...(reminders && (settings?.["payment_reminder"] === true || rows.some((r) => r.kind === "payment_reminder")) ? (["payment_reminder"] as const) : []),
];

/** お支払いのお願い（0181）を当てたか（kindsFor の reminders） */
export const remindersReady = (c: AdminContext): Promise<boolean> => migrated({ db: owner(c).db, cache: c.get("adapters").cache }, PAYMENT_REMINDER_MIGRATION);

/** 見本の値（プレビューと LINE のテスト送信） */
export function sampleValues(kind: NoticeKind, shopName: string): Record<string, string> {
  return {
    shop_name: shopName,
    customer_name: t("notices.sample_customer"),
    number: "1001",
    total: "¥3,300",
    order_details: t("notices.sample_order_details"),
    tracking: kind === "order_shipped" ? t("notices.sample_tracking") : "",
    return_policy: t("notices.sample_return_policy"),
    order_link: t("notices.sample_order_link"),
    contact: t("notices.sample_contact"),
    store_name: t("notices.sample_store_name"),
    hold_until: t("notices.sample_hold_until"),
    visit: t("notices.sample_visit"),
    items: t("notices.sample_items"),
    store_info: t("notices.sample_store_info"),
    pay_until: t("notices.sample_pay_until"),
    payment_link: t("notices.sample_payment_link"),
    shop_link: "https://…",
    ...(kind.startsWith("tryon_") ? { number: "7" } : {}),
  };
}

const tagLabel = (name: string): string => t(`notices.tag.${name}` as MessageKey);

/** 誤りの文 */
function errorText(e: NoticeTextError): string {
  const msg = t(`notices.error.${e.code}` as MessageKey);
  return e.tag ? msg.replace("{tag}", `{{${e.tag}}}`) : msg;
}

function Tags(props: { names: readonly string[]; required: readonly string[] }) {
  return (
    <ul class="muted">
      {props.names.map((n) => (
        <li>
          <code>{`{{${n}}}`}</code> {tagLabel(n)}
          {props.required.includes(n) ? <strong> {t("notices.required")}</strong> : null}
        </li>
      ))}
    </ul>
  );
}

interface Draft {
  kind: NoticeKind;
  channel: NoticeChannel;
  subject: string | null;
  body: string;
  error: NoticeTextError;
}

async function renderPage(c: AdminContext, shop: { id: string; name: string; settings: Record<string, unknown> | null }, draft: Draft | null, status: 200 | 400 = 200) {
  const db = owner(c).db;
  const enabled = await migrated({ db, cache: c.get("adapters").cache }, NOTICE_TEXTS_MIGRATION);
  // LINE の注文の知らせのリンク（0179）。当てるまで差し込みの一覧・既定の文面に出さない
  const lineLinks = enabled && (await migrated({ db, cache: c.get("adapters").cache }, LINE_NOTICE_LINKS_MIGRATION));
  // お支払いのお願い（0181）。当てるまで欄を出さない
  const reminders = enabled && (await migrated({ db, cache: c.get("adapters").cache }, PAYMENT_REMINDER_MIGRATION));
  const rows = enabled ? await db.from<NoticeTextRow>("shop_notice_texts").select("kind,channel,subject,body", { eq: { shop_id: shop.id } }) : [];
  const stale = staleNoticeTexts(rows);
  const flash = c.req.query("flash");
  const base = `/admin/shops/${shop.id}/notices`;
  const section = (kind: NoticeKind, channel: NoticeChannel) => {
    const spec = noticeSpec(kind, channel, lineLinks);
    const row = rows.find((r) => r.kind === kind && r.channel === channel);
    const def = DEFAULT_NOTICE_TEXTS[kind];
    const mine = draft && draft.kind === kind && draft.channel === channel ? draft : null;
    const subject = mine ? (mine.subject ?? "") : channel === "mail" ? (row?.subject ?? def.mail.subject) : "";
    const body = mine ? mine.body : (row?.body ?? (channel === "mail" ? def.mail.body : defaultLineText(kind, lineLinks)));
    const preview = fillNotice(body, sampleValues(kind, shop.name));
    const id = `${kind}-${channel}`;
    return (
      <form method="post" action={base} class="card">
        <h3>{t(channel === "mail" ? "notices.mail" : "notices.line")}</h3>
        <p class="muted">{row ? t("notices.customized") : t("notices.default_in_use")}</p>
        {stale.some((r) => r.kind === kind && r.channel === channel) ? <p class="error">{t("notices.stale")}</p> : null}
        {mine ? <p class="error">{errorText(mine.error)}</p> : null}
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="channel" value={channel} />
        {channel === "mail" ? (
          <>
            <label for={`${id}-subject`}>{t("notices.subject")}</label>
            <input id={`${id}-subject`} name="subject" type="text" maxlength={NOTICE_SUBJECT_MAX} value={subject} required style="width:100%" />
            <p class="muted">
              {t("notices.tags_subject")} {(spec.subjectAllowed ?? []).map((n) => `{{${n}}}`).join(" ")}
            </p>
          </>
        ) : null}
        <label for={`${id}-body`}>{t("notices.body")}</label>
        <textarea id={`${id}-body`} name="body" rows={channel === "mail" ? 16 : 6} maxlength={noticeBodyMax(channel)} required style="width:100%">
          {body}
        </textarea>
        <details>
          <summary>{t("notices.tags_body")}</summary>
          <Tags names={spec.bodyAllowed} required={spec.bodyRequired} />
          {spec.once.some((n) => spec.bodyAllowed.includes(n)) ? <p class="muted">{t("notices.once_note")}</p> : null}
        </details>
        <details>
          <summary>{t("notices.preview")}</summary>
          {channel === "mail" ? <p><strong>{fillNotice(subject, sampleValues(kind, shop.name))}</strong></p> : null}
          <pre style="white-space:pre-wrap">{preview}</pre>
        </details>
        <p>
          <button type="submit" name="action" value="save">
            {t("notices.save")}
          </button>{" "}
          {row ? (
            <button type="submit" name="action" value="reset" formnovalidate>
              {t("notices.reset")}
            </button>
          ) : null}
        </p>
      </form>
    );
  };
  return c.html(
    <AdminLayout title={`${shop.name} · ${t("notices.title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}` }, { label: t("notices.title") }]} shopTabs={{ shop: { id: shop.id, name: shop.name, settings: shop.settings }, access: c.get("shopAccess"), active: "settings", here: "notices" }}>
      <PageHead title={t("notices.title")} />
      {flash === "saved" ? <p class="notice">{t("notices.saved")}</p> : null}
      {flash === "reset" ? <p class="notice">{t("notices.reset_done")}</p> : null}
      <NotSavedNotice flash={flash} />
      <p>{t("notices.intro")}</p>
      {!enabled ? (
        <p class="notice">
          {t("notices.needs_update")} <a href="/admin/update">{t("inventory.open_update")}</a>
        </p>
      ) : (
        <>
        {lineLinks ? (
          <form method="post" action={`${base}/line-style`} class="card" id="line-style">
            <h2>{t("notices.line_style_title")}</h2>
            <p class="muted">{t("notices.line_style_intro")}</p>
            {LINE_NOTICE_STYLES.map((v) => (
              <label>
                <input type="radio" name="line_style" value={v} checked={lineNoticeStyle(shop.settings?.["line_notice_style"]) === v} /> {t(`notices.line_style_${v}` as MessageKey)}
              </label>
            ))}
            <p>
              <button type="submit">{t("notices.save")}</button>
            </p>
          </form>
        ) : null}
        {reminders ? (
          <form method="post" action={`${base}/payment-reminder`} class="card" id="payment-reminder">
            <h2>{t("notices.payment_reminder_title")}</h2>
            <p class="muted">{t("notices.payment_reminder_intro")}</p>
            <label>
              <input type="checkbox" name="on" value="1" checked={shop.settings?.["payment_reminder"] === true} /> {t("notices.payment_reminder_on")}
            </label>
            <p>
              <button type="submit">{t("notices.save")}</button>
            </p>
          </form>
        ) : null}
        {kindsFor(shop.settings, rows, reminders).map((kind) => (
          <section>
            <h2>{t(`notices.kind.${kind}` as MessageKey)}</h2>
            {section(kind, "mail")}
            {section(kind, "line")}
          </section>
        ))}
        </>
      )}
    </AdminLayout>,
    status,
  );
}

notices.get("/:shopId/notices", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "settings");
  if (!shop) return c.text(t("shop.not_found"), 404);
  return renderPage(c, shop, null);
});

// お支払いのお願い（0181、KOMOJU の未払いの予約に翌日 1 回）。鍵 payment_reminder は項目 settings（banto_shop_settings_perm の既定）
notices.post("/:shopId/notices/payment-reminder", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "settings");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const base = `/admin/shops/${shop.id}/notices`;
  if (!(await migrated({ db: owner(c).db, cache: c.get("adapters").cache }, PAYMENT_REMINDER_MIGRATION))) return c.text(t("error.generic"), 400);
  const f = await formFields(c);
  const on = f.on === "1";
  try {
    await updateShop(c, shop.id, { settings: { ...(shop.settings ?? {}), payment_reminder: on } });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${base}?flash=${failCode(e, "not_saved")}`);
    throw e;
  }
  return c.redirect(`${base}?flash=saved#payment-reminder`);
});

// LINE の注文の知らせの見た目（0179、文字だけ / カード）。鍵 line_notice_style は項目 settings（banto_shop_settings_perm の既定）
notices.post("/:shopId/notices/line-style", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "settings");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const base = `/admin/shops/${shop.id}/notices`;
  const f = await formFields(c);
  const style = LINE_NOTICE_STYLES.find((v) => v === f.line_style);
  if (!style || !(await migrated({ db: owner(c).db, cache: c.get("adapters").cache }, LINE_NOTICE_LINKS_MIGRATION))) return c.text(t("error.generic"), 400);
  try {
    await updateShop(c, shop.id, { settings: { ...(shop.settings ?? {}), line_notice_style: style } });
  } catch (e) {
    if (e instanceof DbError) return c.redirect(`${base}?flash=${failCode(e, "not_saved")}`);
    throw e;
  }
  return c.redirect(`${base}?flash=saved#line-style`);
});

notices.post("/:shopId/notices", requireOwner, async (c: AdminContext) => {
  const shop = await loadShop(c, param(c, "shopId"), "settings");
  if (!shop) return c.text(t("shop.not_found"), 404);
  const base = `/admin/shops/${shop.id}/notices`;
  const f = await formFields(c);
  // 既定に戻すのはどの知らせでも（モジュールを OFF にしたあとに残った文面も消せる）。保存は画面に出す知らせだけ
  const kind = (f.action === "reset" ? NOTICE_KINDS : kindsFor(shop.settings, [], await remindersReady(c))).find((k) => k === f.kind);
  const channel = f.channel === "mail" || f.channel === "line" ? f.channel : null;
  if (!kind || !channel) return c.text(t("error.generic"), 400);
  const db = owner(c).db;
  if (f.action === "reset") {
    await db.rpc("notice_text_set", { p_shop_id: shop.id, p_kind: kind, p_channel: channel, p_subject: null, p_body: null });
    return c.redirect(`${base}?flash=reset`);
  }
  const subject = channel === "mail" ? (f.subject ?? "") : null;
  const body = f.body ?? "";
  // 画面でも同じ決まりで確かめて、書いた文を残したまま理由を出す（DB も同じ決まりで断る）
  const lineLinks = await migrated({ db, cache: c.get("adapters").cache }, LINE_NOTICE_LINKS_MIGRATION);
  const err = checkNoticeText(kind, channel, subject, body, lineLinks);
  if (err) return renderPage(c, shop, { kind, channel, subject, body, error: err }, 400);
  try {
    await db.rpc("notice_text_set", { p_shop_id: shop.id, p_kind: kind, p_channel: channel, p_subject: subject, p_body: body });
  } catch (e) {
    const dbErr = e instanceof DbError ? noticeTextErrorOf(e.message) : null;
    if (dbErr) return renderPage(c, shop, { kind, channel, subject, body, error: dbErr }, 400);
    throw e;
  }
  return c.redirect(`${base}?flash=saved`);
});
