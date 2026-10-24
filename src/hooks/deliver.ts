/**
 * hooks の配信ワーカー。Cron から service_role で呼ぶ（src/jobs/）。
 * claim_hook_deliveries で取り出し → 署名付き POST → finish_hook_delivery。
 * 2xx を成功、それ以外とネットワークエラー・タイムアウトを失敗として扱う（再送は DB 側で判断）。
 */
import type { PrivilegedDb } from "../db/privileged";
import type { ConfigAdapter, SocketAdapter } from "../adapters/types";
import { endpointSecret, signHookPayload } from "./signing";
import type { HookEnvelope } from "./events";
import { bundledPluginIdFromUrl, findBundledPlugin } from "../plugins";

export const HOOK_TIMEOUT_MS = 10_000;

export interface DeliverResult {
  claimed: number;
  delivered: number;
  failed: number;
}

export async function deliverPendingHooks(opts: {
  db: PrivilegedDb;
  sessionSecret: string;
  fetch: typeof fetch;
  /** 同梱プラグインが Secret を読むのに使う。省略時は同梱プラグインへの配信を失敗扱いにする */
  config?: ConfigAdapter;
  /** 生の TCP（SMTP の送り手）。Workers と Node のアダプタが持つ */
  socket?: SocketAdapter;
  limit?: number;
  timeoutMs?: number;
}): Promise<DeliverResult> {
  // プロパティ経由で呼ばない（Workers の "Illegal invocation" 対策）
  const rawFetch = opts.fetch;
  const doFetch: typeof fetch = (input, init) => rawFetch(input, init);
  const rows = await opts.db.claimHookDeliveries(opts.limit ?? 50);
  const result: DeliverResult = { claimed: rows.length, delivered: 0, failed: 0 };

  await Promise.all(
    rows.map(async (row) => {
      const envelope: HookEnvelope = {
        id: row.id,
        event: row.event,
        created_at: row.created_at,
        shop_id: row.shop_id,
        attempt: row.attempts,
        data: row.payload,
      };
      // 同梱プラグイン: HTTP ではなくプロセス内で呼ぶ
      const pluginId = bundledPluginIdFromUrl(row.url);
      if (pluginId !== null) {
        const plugin = findBundledPlugin(pluginId);
        try {
          if (!plugin) throw new Error(`unknown bundled plugin: ${pluginId}`);
          const handle = plugin.handle;
          if (!handle) {
            // 受信処理を持たないプラグイン（Stripe / KOMOJU は決済事業者の Webhook を受ける側）。配信対象外として完了にする
            await opts.db.finishHookDelivery(row.id, true, 204, null);
            result.delivered++;
            return;
          }
          if (!opts.config) throw new Error("config adapter missing");
          await handle.call(plugin, { envelope, settings: row.settings ?? {}, config: opts.config, socket: opts.socket, fetch: doFetch, privileged: opts.db, sessionSecret: opts.sessionSecret });
          await opts.db.finishHookDelivery(row.id, true, 200, null);
          result.delivered++;
        } catch (e) {
          await opts.db.finishHookDelivery(row.id, false, null, e instanceof Error ? e.message : String(e));
          result.failed++;
        }
        return;
      }

      const body = JSON.stringify(envelope);
      const secret = await endpointSecret(opts.sessionSecret, row.endpoint_id);
      const signature = await signHookPayload(secret, body);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? HOOK_TIMEOUT_MS);
      try {
        const res = await doFetch(row.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "banto-hooks",
            "X-Banto-Event": row.event,
            "X-Banto-Delivery": row.id,
            "X-Banto-Signature": signature,
          },
          body,
          signal: controller.signal,
        });
        const ok = res.status >= 200 && res.status < 300;
        const text = ok ? null : (await res.text().catch(() => "")).slice(0, 500);
        await opts.db.finishHookDelivery(row.id, ok, res.status, text);
        if (ok) result.delivered++;
        else result.failed++;
      } catch (e) {
        await opts.db.finishHookDelivery(row.id, false, null, e instanceof Error ? e.message : String(e));
        result.failed++;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return result;
}
