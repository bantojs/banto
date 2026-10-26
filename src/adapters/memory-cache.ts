import type { CacheAdapter } from "./types";

/**
 * isolate / プロセスの中のメモリのキャッシュ（Workers と Node で共通。ランタイム固有の型を使わない）。
 * 行数に上限を持つ: キーを変えたリクエスト（未知の Host・検索の語・ページの位置など）を送り続けられても、
 * メモリを使い切って isolate が落ちないように。あふれたら期限切れを消し、それでも足りなければ古いものから。
 */
export const MEMORY_CACHE_MAX_ENTRIES = 5000;

export class MemoryCache implements CacheAdapter {
  private readonly memory = new Map<string, { value: unknown; expires: number }>();
  constructor(private readonly maxEntries = MEMORY_CACHE_MAX_ENTRIES) {}
  async get<T>(key: string) {
    const hit = this.memory.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as T;
    this.memory.delete(key);
    return null;
  }
  async set<T>(key: string, value: T, ttlSeconds: number) {
    if (this.memory.size >= this.maxEntries && !this.memory.has(key)) {
      const now = Date.now();
      for (const [k, v] of this.memory) if (v.expires <= now) this.memory.delete(k);
      // 期限切れを消しても足りなければ古いものから（Map は挿入順）
      while (this.memory.size >= this.maxEntries) {
        const oldest = this.memory.keys().next().value;
        if (oldest === undefined) break;
        this.memory.delete(oldest);
      }
    }
    this.memory.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
  }
  async delete(key: string) {
    this.memory.delete(key);
  }
  /** 今の行数（テスト用） */
  get size(): number {
    return this.memory.size;
  }
}
