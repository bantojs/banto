/**
 * 回数の制限の既定（メモリ、固定の窓）。Workers・Node のどちらでも動く（ランタイム固有のものを使わない）。
 * Workers では isolate ごとに分かれるので、上限は「だいたい」。確かな上限が要る運営者は WAF のレート制限を併用する（docs/hardening.md）
 */
import type { Adapters, RateLimitAdapter } from "./types";

const MAX_KEYS = 10_000;

export function memoryRateLimit(now: () => number = () => Date.now()): RateLimitAdapter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    async hit(key, limit, windowSeconds) {
      const t = now();
      const w = windows.get(key);
      if (!w || t - w.start >= windowSeconds * 1000) {
        // 鍵が増えすぎたら、期限切れ → 古い順に必要な数だけ捨てる（メモリを食い続けない。全部は消さない:
        // 鍵を大量に送って全員の窓を消させないため。Map は入れた順なので先頭が古い）
        if (windows.size >= MAX_KEYS) {
          for (const [k, v] of windows) if (t - v.start >= windowSeconds * 1000) windows.delete(k);
          for (const k of windows.keys()) {
            if (windows.size < MAX_KEYS) break;
            windows.delete(k);
          }
        }
        windows.set(key, { start: t, count: 1 });
        return limit >= 1;
      }
      w.count++;
      return w.count <= limit;
    },
  };
}

const shared = memoryRateLimit();

/** 使う回数の制限（アダプタが無ければ isolate に 1 つのメモリ） */
export const rateLimiter = (adapters: Pick<Adapters, "rateLimit">): RateLimitAdapter => adapters.rateLimit ?? shared;
