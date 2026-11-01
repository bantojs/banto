import { Hono, type Context } from "hono";
import type { AppEnv } from "../app";
import { createDbClient } from "../db/client";
import { BANTO_VERSION } from "../version";
import { CRON_HEARTBEAT } from "../jobs";
import type { ConfigAdapter } from "../adapters/types";
import { mailTransportMissing } from "../mail/send";
import { stripeDirect } from "../plugins/stripe_direct";

/**
 * 死活監視用。GET /health
 *   200 { ok: true,  checks: { db: "ok" | "not_configured", cron, stripe, mail } }
 *   503 { ok: false, checks: { db: "error" } }
 * stripe・mail は設定があるかだけ（ok / incomplete / not_configured）。使わない運営者もいるので ok（503）には効かせない。
 * 値・送り手の種類は返さない（名前の有無と形だけを見る）
 * DB の確認は anon キーで shops を 1 行読むだけ（RLS が効くので公開情報以外は出ない）。
 * 監視サービスが 1 分ごとに叩いても DB に負荷をかけないよう、結果は 30 秒キャッシュする。
 * 秘密・接続先・エラー詳細は返さない（docs/monitoring.md）。
 */
export const health = new Hono<AppEnv>();

const CACHE_KEY = "health:db";
const CACHE_TTL = 30;

type DbStatus = "ok" | "error" | "not_configured";
/** Cron（5 分ごと）の最終実行: 15 分以内なら ok、超えていれば stale、一度も動いていなければ unknown */
type CronStatus = "ok" | "stale" | "unknown";
export const CRON_STALE_SECONDS = 15 * 60;

interface Checks {
  db: DbStatus;
  cron: CronStatus;
}

/** 外のサービスの設定: そろって形も合う / 一部だけ・形が違う / 何も無い */
type ConfigStatus = "ok" | "incomplete" | "not_configured";

/** Stripe: シークレットキーと Webhook の署名シークレットがそろい、形が合うか（Connect の STRIPE_CLIENT_ID だけでは決済できないので incomplete） */
export function stripeConfigStatus(config: ConfigAdapter): ConfigStatus {
  const names = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_CLIENT_ID"] as const;
  if (!names.some((n) => config.get(n))) return "not_configured";
  const formats = stripeDirect.secretFormats ?? {};
  const fmtOk = (n: string) => {
    const v = config.get(n);
    const f = formats[n];
    return Boolean(v) && (!f || f.pattern.test(v!));
  };
  return fmtOk("STRIPE_SECRET_KEY") && fmtOk("STRIPE_WEBHOOK_SECRET") ? "ok" : "incomplete";
}

/** メールの送り手（MAIL_TRANSPORT、既定 resend）。何も設定していなければ not_configured */
export function mailConfigStatus(config: ConfigAdapter): ConfigStatus {
  const missing = mailTransportMissing(config);
  if (missing.length === 0) return "ok";
  return config.get("MAIL_TRANSPORT") ? "incomplete" : "not_configured";
}

async function runChecks(c: Context<AppEnv>): Promise<Checks> {
  const { config, cache } = c.get("adapters");
  const url = config.get("SUPABASE_URL");
  const anonKey = config.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) return { db: "not_configured", cron: "unknown" };
  const cached = await cache.get<Checks>(CACHE_KEY);
  if (cached) return cached;
  const checks: Checks = { db: "ok", cron: "unknown" };
  const db = createDbClient({ url, anonKey, fetch: c.get("deps").fetch });
  try {
    await db.from("shops").select("id", { limit: 1 });
  } catch (e) {
    console.error("[banto] health: db check failed:", e instanceof Error ? e.message : e);
    checks.db = "error";
  }
  if (checks.db === "ok") {
    try {
      const age = await db.rpc<number | null>("heartbeat_age_seconds", { p_name: CRON_HEARTBEAT });
      checks.cron = age === null || age === undefined ? "unknown" : age <= CRON_STALE_SECONDS ? "ok" : "stale";
    } catch (e) {
      // 0006 未適用など。cron は判定できないだけで DB は生きている
      console.error("[banto] health: cron check failed:", e instanceof Error ? e.message : e);
      checks.cron = "unknown";
    }
  }
  await cache.set(CACHE_KEY, checks, CACHE_TTL);
  return checks;
}

health.get("/", async (c) => {
  const checks = await runChecks(c);
  const ok = checks.db !== "error" && checks.cron !== "stale";
  const config = c.get("adapters").config;
  const all = { ...checks, stripe: stripeConfigStatus(config), mail: mailConfigStatus(config) };
  return c.json({ ok, name: "banto", version: BANTO_VERSION, checks: all, time: new Date().toISOString() }, ok ? 200 : 503, { "Cache-Control": "no-store" });
});
