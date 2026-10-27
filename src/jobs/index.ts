/**
 * 定期処理（SchedulerAdapter 経由。Workers では Cron Trigger が runAll を呼ぶ）。
 *   - release_expired_reservations: TTL 切れ予約の在庫を戻す（CLAUDE.md §6-3）
 *   - mask_shipped_orders: 発送から既定 180 日経過した注文の個人情報をマスク（§8）。監査ログの保持（0051、既定 365 日）も同じ回で
 *   - deliver_hooks: hooks の配信と再送（§5）
 *   - product_feeds: 商品フィードを 1 時間ごとに作り直す（同梱モジュール product_feed）
 *   - tryon: お店で試着の取り置きの期限切れと、終わった申し込みの個人情報のマスキング（同梱モジュール store_tryon、0025）
 */
import { INQUIRIES_MIGRATION } from "../modules/inquiries";
import { removeAttachments } from "../modules/inquiries/attachments";
import type { Adapters } from "../adapters/types";
import { createPrivilegedDb } from "../db/privileged";
import { deliverPendingHooks } from "../hooks/deliver";
import { resolveSessionSecret } from "../auth/session";
import { setLocale } from "../i18n";
import { setTimeZone } from "../i18n/time";
import { registerFeedJob } from "../modules/product-feed/job";
import { registerImageImportJob } from "../modules/woo-import/job";
import { todayHere } from "../modules/store-tryon";
import { createDbClient } from "../db/client";
import { migrated } from "../db/migration-state";
import { MEMBER_SESSIONS_MIGRATION } from "../members/auth";
import { PASSKEY_MIGRATION } from "../modules/passkey";
import { AUDIT_LOG_MIGRATION, auditKeepDays } from "../audit";

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
  const doFetch: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const db = createPrivilegedDb({ url, serviceRoleKey, fetch: doFetch });
  setLocale(cfg.get("BANTO_LOCALE")); // メールプラグイン等の文言用（リクエスト外で動くため）
  setTimeZone(cfg.get("BANTO_TIMEZONE"));

  adapters.scheduler.register("release_expired_reservations", async () => {
    await db.releaseExpiredReservations();
  });

  // 法務上の処理（個人情報のマスキング）は hooks の配信より前に走らせる（配信が通信の上限に当たって同じ回の後続を止めても影響しないように。0056）
  adapters.scheduler.register("mask_shipped_orders", async () => {
    const raw = cfg.get("MASK_ORDERS_AFTER_DAYS");
    const days = raw && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MASK_AFTER_DAYS;
    await db.maskShippedOrders(days);
    // 監査ログの保持（0051。適用されるまでは呼ばない）
    const anonKey = cfg.get("SUPABASE_ANON_KEY");
    if (anonKey && (await migrated({ db: createDbClient({ url, anonKey, fetch: doFetch }), cache: adapters.cache }, AUDIT_LOG_MIGRATION))) {
      await db.pruneAuditLog(auditKeepDays(cfg.get("AUDIT_LOG_KEEP_DAYS")));
    }
  });

  // hooks の配信。1 回に取り出す数は DB が Workers のプランで決める（claim_hook_deliveries、0056）
  adapters.scheduler.register("deliver_hooks", async () => {
    const sessionSecret = await resolveSessionSecret(cfg);
    if (!sessionSecret) return;
    await deliverPendingHooks({ db, sessionSecret, fetch: doFetch, config: cfg, socket: adapters.socket });
  });

  // 期限切れのログインのコードを消す（0012）。終わった会員のセッション（0045）とパスキーの challenge（0046）も消す（適用されるまでは呼ばない）
  adapters.scheduler.register("member_login_cleanup", async () => {
    await db.memberLoginCleanup();
    const anonKey = cfg.get("SUPABASE_ANON_KEY");
    const state = anonKey ? { db: createDbClient({ url, anonKey, fetch: doFetch }), cache: adapters.cache } : null;
    if (state && (await migrated(state, MEMBER_SESSIONS_MIGRATION))) await db.memberSessionCleanup();
    if (state && (await migrated(state, PASSKEY_MIGRATION))) await db.memberPasskeyCleanup();
  });

  // お店で試着（0025）。期限はショップの時間帯の日付で比べる
  adapters.scheduler.register("tryon", async () => {
    const raw = cfg.get("MASK_ORDERS_AFTER_DAYS");
    const days = raw && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MASK_AFTER_DAYS;
    await db.tryonExpire(todayHere());
    await db.maskTryonRequests(days);
  });

  // お問い合わせ（0061）: 完了から MASK_ORDERS_AFTER_DAYS 日の連絡先と本文を消す・未確認のまま 30 日のものを消す（適用されるまでは呼ばない）
  adapters.scheduler.register("inquiries", async () => {
    const anonKey = cfg.get("SUPABASE_ANON_KEY");
    if (!anonKey || !(await migrated({ db: createDbClient({ url, anonKey, fetch: doFetch }), cache: adapters.cache }, INQUIRIES_MIGRATION))) return;
    const raw = cfg.get("MASK_ORDERS_AFTER_DAYS");
    await db.maskInquiries(raw && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MASK_AFTER_DAYS);
    // マスキング・削除で外れた添付の実体を、公開しない置き場から消す（消せたものだけ待ち行列から外す。残りは次の回）
    const storage = adapters.privateStorage;
    if (storage) {
      const keys = await db.inquiryAttachmentTrashClaim(50);
      if (keys.length > 0) await db.inquiryAttachmentTrashDone(await removeAttachments(storage, keys));
    }
  });

  // 商品フィード（同梱モジュール product_feed、既定 OFF）
  registerFeedJob(adapters, doFetch);

  // 画像を裏で取り込む（同梱モジュール woo_import、0039）。通信の回数を使うので、ほかのジョブの後に置く
  registerImageImportJob(adapters, db, doFetch);

  // 最後に登録する = 上のジョブがすべて成功したときだけ時刻が進む（途中で落ちれば /health が stale を報告する）
  adapters.scheduler.register("heartbeat", async () => {
    await db.recordHeartbeat(CRON_HEARTBEAT);
  });
}
