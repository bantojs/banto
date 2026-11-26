/**
 * 定期処理（SchedulerAdapter 経由。Workers では Cron Trigger が runAll を呼ぶ）。
 *   - release_expired_reservations: TTL 切れ予約の在庫を戻す（CLAUDE.md §6-3）
 *   - mask_shipped_orders: 発送から既定 180 日経過した注文の個人情報をマスク（§8）。監査ログの保持（0051、既定 365 日）も同じ回で
 *   - deliver_hooks: hooks の配信と再送（§5）
 *   - product_feeds: 商品フィードを 1 時間ごとに作り直す（同梱モジュール product_feed）
 *   - tryon: お店で試着の取り置きの期限切れと、終わった申し込みの個人情報のマスキング（同梱モジュール store_tryon、0025）
 *   - legal_links: 法務のページを向けた外の URL が生きているか（0062）
 *   - hook_manifests: 外部プラグインのマニフェストを 1 日 1 回取り直す（0096）
 */
import { removeAttachments } from "../modules/inquiries/attachments";
import type { Adapters } from "../adapters/types";
import { createPrivilegedDb } from "../db/privileged";
import { deliverPendingHooks } from "../hooks/deliver";
import { resolveSessionSecret } from "../auth/session";
import { setLocale } from "../i18n";
import { setTimeZone } from "../i18n/time";
import { registerFeedJob } from "../modules/product-feed/job";
import { registerImageImportJob } from "../modules/woo-import/job";
import { TRYON_REMINDER_MIGRATION, hourHere, todayHere } from "../modules/store-tryon";
import { SALE_DATES_MIGRATION } from "../products/fields";
import { auditKeepDays } from "../audit";
import { checkLegalLinks } from "../storefront/legal-links";
import { PAGES_TRASH_DAYS } from "../pages";
import { fetchManifest } from "../hooks/manifest";
import { CRON_LIMIT_HEARTBEAT, SubrequestBudget } from "./budget";
import { PAYMENT_REMINDER_MIGRATION } from "../notices/templates";

/** Cron の通信の予算と、取り出したまま終わらなかった配信の打ち切り（0160）。当てる前の DB では予算で絞らない */
export const CRON_RESILIENCE_MIGRATION = "0160_cron_resilience";
/** 外へ取りに行くジョブ（法務のリンク・マニフェスト・商品フィード）が残しておく回数（後の画像の取り込み・hooks の配信・ハートビートの分） */
const LATER_RESERVE = 15;
/** 法務のリンクの確かめ 1 ショップの最大（3 種類 × リダイレクト 3 回 + 期限の読み取りと記録） */
const LEGAL_LINKS_COST = 14;
/** マニフェストの取り直し 1 件（取りに行く 1 回 + 記録 1 回 + ゆとり） */
const MANIFEST_COST = 3;
/** 商品フィードを 1 ショップ作り直す見積もり（読み取りのページ・置き場の読み書き。計った値は約 12）と、残しておく回数 */
const FEED_COST = 14;
const FEED_RESERVE = 8;
/**
 * お問い合わせの添付の後始末で残しておく回数（後のジョブと hooks の配信の分）。個人情報の後始末なので、法務のリンクの確かめより先に進める
 * （Free でも 1 回に数件は消える。法務のリンクはそのあいだ次の回に回ることがある）
 */
const INQUIRY_TRASH_RESERVE = 25;
/** 画像の取り込み 1 件の見積もり（取りに行く 1 回 + リダイレクト 3 回 + 置き場に置く 1 回）と、残しておく回数（配信とハートビートの分） */
const IMAGE_IMPORT_COST = 5;
const IMAGE_IMPORT_RESERVE = 20;

/** マニフェストの取り直し（0096）: 1 回に取り直す数と、1 件の待ち時間。5 分ごとなら 1 日に 576 件 */
export const MANIFEST_REFRESH_PER_RUN = 2;
const MANIFEST_REFRESH_TIMEOUT_MS = 5000;

/** Cron のハートビート名（/health が heartbeat_age_seconds で読む） */
export const CRON_HEARTBEAT = "cron";

export const DEFAULT_MASK_AFTER_DAYS = 180;

export function registerJobs(adapters: Adapters, deps: { fetch?: typeof fetch } = {}): void {
  const cfg = adapters.config;
  const url = cfg.get("SUPABASE_URL");
  const serviceRoleKey = cfg.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) return; // セットアップ前は何もしない

  // Workers では素の fetch をオブジェクトのプロパティ経由で呼ぶと "Illegal invocation"（this が違う）になる。
  // 常にラッパーにして渡す（app.ts も同じ扱い）。
  const rawFetch: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  // 1 回の実行の通信の予算（Workers の上限。src/jobs/budget.ts）。DB の呼び出しも外への通信も、ここで数える
  const budget = new SubrequestBudget();
  const doFetch = budget.wrap(rawFetch);
  const outbound = adapters.publicFetch ? budget.wrap(adapters.publicFetch) : doFetch;
  // 置き場（R2）の呼び出しも Workers の通信の回数に入るので、Cron のジョブには数えながら呼ぶ置き場を渡す
  const counted: Adapters = { ...adapters, storage: budget.wrapStorage(adapters.storage), ...(adapters.privateStorage ? { privateStorage: budget.wrapStorage(adapters.privateStorage) } : {}) };
  const db = createPrivilegedDb({ url, serviceRoleKey, fetch: doFetch });
  setLocale(cfg.get("BANTO_LOCALE")); // メールプラグイン等の文言用（リクエスト外で動くため）
  setTimeZone(cfg.get("BANTO_TIMEZONE"));

  // 最初に: この回の数え直しと、上限（サイトの設定 workers_plan。0160 を当てる前の DB では絞らない）。前の回に通信の上限に当たっていたら印を書く
  adapters.scheduler.register("cron_start", async () => {
    const limits = adapters.cronSubrequestLimits;
    budget.start(null);
    if (!limits) return;
    budget.setFloor(limits.free);
    const applied = await db.appliedMigrations();
    if (!applied.includes(CRON_RESILIENCE_MIGRATION)) return;
    const plan = (await db.cronSettings()).workers_plan;
    budget.setPlanLimit(plan === "paid" ? limits.paid : limits.free);
    if (budget.takePendingNotice()) await db.recordHeartbeat(CRON_LIMIT_HEARTBEAT);
  });

  adapters.scheduler.register("release_expired_reservations", async () => {
    await db.releaseExpiredReservations();
  });

  // 法務上の処理（個人情報のマスキング）は hooks の配信より前に走らせる（配信が通信の上限に当たって同じ回の後続を止めても影響しないように。0056）
  adapters.scheduler.register("mask_shipped_orders", async () => {
    const raw = cfg.get("MASK_ORDERS_AFTER_DAYS");
    const days = raw && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MASK_AFTER_DAYS;
    await db.maskShippedOrders(days);
    // 監査ログの保持（0051）
    await db.pruneAuditLog(auditKeepDays(cfg.get("AUDIT_LOG_KEEP_DAYS")));
  });

  // 商品の予約公開（0148）: 公開日を過ぎた非公開の商品を公開する。当てる前の DB では何もしない（関数が無いまま呼んで Cron を止めない）
  adapters.scheduler.register("publish_scheduled_products", async () => {
    if (!(await db.appliedMigrations()).includes(SALE_DATES_MIGRATION)) return;
    await db.publishScheduledProducts();
  });

  // ショップのページ（0080）とブログの記事（0081）のゴミ箱: 30 日を過ぎたものを消す
  adapters.scheduler.register("pages_trash", async () => {
    await db.purgePagesTrash(PAGES_TRASH_DAYS);
    await db.purgeArticlesTrash(PAGES_TRASH_DAYS);
  });

  // 期限切れのログインのコードを消す（0012）。終わった会員のセッション（0045）とパスキーの challenge（0046）も消す
  adapters.scheduler.register("member_login_cleanup", async () => {
    await db.memberLoginCleanup();
    await db.memberSessionCleanup();
    await db.memberPasskeyCleanup();
  });

  // お店で試着（0025）。期限はショップの時間帯の日付で比べる
  adapters.scheduler.register("tryon", async () => {
    const raw = cfg.get("MASK_ORDERS_AFTER_DAYS");
    const days = raw && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MASK_AFTER_DAYS;
    await db.tryonExpire(todayHere());
    await db.maskTryonRequests(days);
    // 来店期限の前日のお知らせ（0152。当てる前の DB では何もしない）。個人情報のマスキングの後に（失敗してもマスキングを止めない）
    if ((await db.appliedMigrations()).includes(TRYON_REMINDER_MIGRATION)) await db.tryonRemind(todayHere(), hourHere());
  });

  // お問い合わせ（0061）: 完了から MASK_ORDERS_AFTER_DAYS 日の連絡先と本文を消す・未確認のまま 30 日のものを消す
  adapters.scheduler.register("inquiries", async () => {
    const raw = cfg.get("MASK_ORDERS_AFTER_DAYS");
    await db.maskInquiries(raw && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MASK_AFTER_DAYS);
    // マスキング・削除で外れた添付の実体を、公開しない置き場から消す（消せたものだけ待ち行列から外す。残りは次の回）
    const storage = counted.privateStorage;
    // 1 件の削除が 1 回。後のジョブの分（INQUIRY_TRASH_RESERVE）を残して取り出す
    const n = budget.allowance(1, INQUIRY_TRASH_RESERVE, 50);
    if (storage && n > 0) {
      const keys = await db.inquiryAttachmentTrashClaim(n);
      if (keys.length > 0) await db.inquiryAttachmentTrashDone(await removeAttachments(storage, keys));
    }
  });

  // 法務のページの外の URL が生きているか（0062）。期限の来たショップを 1 回に 1 つだけ（外への通信は 3 種類 × リダイレクト 3 回で最大 12 回。
  // Workers の 1 回あたりの通信の上限をほかの処理と分け合う。5 分ごとなら 1 日に 288 ショップ）
  adapters.scheduler.register("legal_links", async () => {
    if (budget.allowance(LEGAL_LINKS_COST, LATER_RESERVE, 1) === 0) return;
    for (const due of await db.legalLinksDue(1)) {
      await db.legalLinksRecord(due.shop_id, await checkLegalLinks(due.urls, outbound));
    }
  });

  // 外部プラグインのマニフェストを取り直す（0096）。プラグインを上げたのに前のマニフェスト（capabilities・ブロック・設定の項目）のまま、を防ぐ。
  // 取れなければ前のまま時刻だけ進める
  adapters.scheduler.register("hook_manifests", async () => {
    const n = budget.allowance(MANIFEST_COST, LATER_RESERVE, MANIFEST_REFRESH_PER_RUN);
    if (n === 0) return;
    for (const due of await db.hookManifestsDue(n)) {
      await db.hookManifestRecord(due.id, due.url, await fetchManifest(due.url, outbound, MANIFEST_REFRESH_TIMEOUT_MS));
    }
  });

  // 商品フィード（同梱モジュール product_feed、既定 OFF）
  registerFeedJob(counted, doFetch, () => budget.allowance(FEED_COST, FEED_RESERVE, 1) > 0);

  // 画像を裏で取り込む（同梱モジュール woo_import、0039）。通信の回数を使うので、ほかのジョブの後に置く
  registerImageImportJob(counted, db, doFetch, () => budget.allowance(IMAGE_IMPORT_COST, IMAGE_IMPORT_RESERVE, Number.MAX_SAFE_INTEGER));

  // お支払いのお願い（0181）: 24 時間たった未払いの KOMOJU の予約に checkout.payment_pending を積む（送るのは同じ回の hooks の配信）。
  // 送るかはショップの設定 payment_reminder（DB が見る）。当てる前の DB では何もしない
  adapters.scheduler.register("payment_reminders", async () => {
    if (!(await db.appliedMigrations()).includes(PAYMENT_REMINDER_MIGRATION)) return;
    await db.enqueuePaymentReminders(50);
  });

  // hooks の配信。決まった回数で済むジョブの後に置き、その回の残りの通信の回数から取り出す数を決める（1 件 DELIVERY_COST 回と見積もる。
  // DB も Workers のプランで上限を決める、claim_hook_deliveries、0056）。残りが足りなければこの回は取り出さない（次の回に回す）
  adapters.scheduler.register("deliver_hooks", async () => {
    const sessionSecret = await resolveSessionSecret(cfg);
    if (!sessionSecret) return;
    const limit = budget.deliveryLimit();
    if (limit === 0) return;
    // 行き先は Node では publicFetch（名前を引いた先が社内のアドレスなら繋がない）。同梱プラグインの中の通信（メール・LINE）も同じ fetch を通る。
    // 取り出した後は種類ごとの見積もりで確かめ直し、残りに入らない分は返す（ハートビートの分を残す）
    await deliverPendingHooks({
      db,
      sessionSecret,
      fetch: outbound,
      config: cfg,
      socket: adapters.socket,
      ...(limit !== undefined ? { limit, budget: { remaining: () => budget.remaining(), reserve: 2 } } : {}),
    });
  });

  // 上のジョブがその回ですべて成功したときだけ時刻が進む（1 つでも落ちれば /health が stale を報告する。残りのジョブは走る）
  adapters.scheduler.register(
    "heartbeat",
    async () => {
      await db.recordHeartbeat(CRON_HEARTBEAT);
    },
    { afterAllSucceeded: true },
  );
}
