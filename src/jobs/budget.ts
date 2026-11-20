import type { StorageAdapter } from "../adapters/types";

/**
 * Cron の 1 回の実行の、外への通信（サブリクエスト）の予算。
 *
 * Workers は 1 回の実行で使える通信の回数に上限がある（Free 50・Paid 1,000。adapters.cronSubrequestLimits）。DB の呼び出し（PostgREST）も
 * 1 回と数えるので、Cron のジョブが使う fetch をここで包んで数え、hooks の配信は残りの回数から取り出す数を決める（1 件いくつと見積もる）。
 * 上限はサイトの設定 workers_plan で選ぶ。実際のプランと食い違っていて「Too many subrequests」が出たら、この isolate ではそのときの
 * 回数を上限とみなして次の回から絞り、ダッシュボードに知らせるための印（ハートビートの表の CRON_LIMIT_HEARTBEAT）を次の回に書く。
 * Node（上限なし）では数えるだけで絞らない。
 */

/**
 * hooks の配信 1 件の見積もり。外の送信先は 2（送信と finish_hook_delivery）。同梱プラグインは連絡先・文面（0154）・秘密の読み取りと
 * 送信もするので 7（メールの試着の知らせは 2 通・LINE はトークンも読む。数えた最大は 6 に 1 のゆとり）。まとめて受けるもの（batchEvents）は件数 + 3
 */
export const DELIVERY_COST = { external: 2, bundled: 7, batchBase: 3 } as const;
/** 取り出す数の上限を決めるときの 1 件の見積もり（いちばん安い外の送信先。取り出した後で種類ごとに確かめ直し、入らない分は返す） */
export const DELIVERY_COST_MIN = DELIVERY_COST.external;
/** 配信の後に残しておく回数（ハートビート・取り出し・返す呼び出し・ゆとり） */
export const DELIVERY_RESERVE = 5;
/** 「通信の上限に当たった」の印（ハートビートの表。ダッシュボードが経過秒数を読む） */
export const CRON_LIMIT_HEARTBEAT = "cron_subrequest_limit";

/** Workers が通信の上限で投げる例外か */
export function isSubrequestLimitError(e: unknown): boolean {
  return e instanceof Error && /too many subrequests/i.test(e.message);
}

/** この isolate で実際に当たった上限（次の回から使う）と、まだ DB に書いていない「当たった」印 */
const learned: { limit: number | null; pendingNotice: boolean } = { limit: null, pendingNotice: false };

/** テスト用: isolate の覚えを消す */
export function resetLearnedSubrequestLimit(): void {
  learned.limit = null;
  learned.pendingNotice = false;
}

export class SubrequestBudget {
  used = 0;
  private planLimit = Number.POSITIVE_INFINITY;
  /** 覚える上限の下限（Free の上限。adapters.cronSubrequestLimits.free） */
  private floor = 50;

  /** 覚える上限の下限を決める（ランタイムの Free の上限） */
  setFloor(n: number): void {
    this.floor = n;
  }

  /** この回の数え直し。上限はプランの上限と、この isolate で当たった上限の小さいほう */
  start(planLimit: number | null): void {
    this.used = 0;
    this.planLimit = planLimit ?? Number.POSITIVE_INFINITY;
  }

  /** この回の上限を決める（数えた回数はそのまま。プランを読むのに使った分も数えたまま） */
  setPlanLimit(planLimit: number): void {
    this.planLimit = planLimit;
  }

  /** 予算で絞る回か（プランの上限が決まった回 = 0160 を当てた Workers）。決まっていなければ、覚えた上限も使わない（今までどおり） */
  get active(): boolean {
    return Number.isFinite(this.planLimit);
  }

  get limit(): number {
    if (!this.active) return Number.POSITIVE_INFINITY;
    return Math.min(this.planLimit, learned.limit ?? Number.POSITIVE_INFINITY);
  }

  remaining(): number {
    return this.limit - this.used;
  }

  /** 上限のある実行で、配信を何件取り出してよいか（無制限なら undefined = DB の既定）。取り出した後で種類ごとに確かめ直す（deliverPendingHooks） */
  deliveryLimit(): number | undefined {
    if (!Number.isFinite(this.limit)) return undefined;
    return Math.max(0, Math.floor((this.remaining() - DELIVERY_RESERVE) / DELIVERY_COST_MIN));
  }

  /** 1 件 perItem 回の処理を何件まで進めてよいか（reserve を残す）。無制限なら max */
  allowance(perItem: number, reserve: number, max: number): number {
    if (!Number.isFinite(this.limit)) return max;
    return Math.max(0, Math.min(max, Math.floor((this.remaining() - reserve) / perItem)));
  }

  /** 置き場（R2）の呼び出しも通信の回数に入る（Cloudflare の数え方）ので、数えながら呼ぶ置き場を返す */
  wrapStorage(storage: StorageAdapter): StorageAdapter {
    const count = async <R>(f: () => Promise<R>): Promise<R> => {
      this.used += 1;
      try {
        return await f();
      } catch (e) {
        this.noteError(e);
        throw e;
      }
    };
    return {
      put: (key, body, contentType) => count(() => storage.put(key, body, contentType)),
      get: (key) => count(() => storage.get(key)),
      delete: (key) => count(() => storage.delete(key)),
      ...(storage.getRange ? { getRange: (key: string, start: number, end: number | null) => count(() => storage.getRange!(key, start, end)) } : {}),
    };
  }

  /** 前の回に当たった印があれば、書いて消す（書くのに 1 回使う） */
  takePendingNotice(): boolean {
    const v = learned.pendingNotice;
    learned.pendingNotice = false;
    return v;
  }

  /** 数えながら呼ぶ fetch。上限に当たったら、その回数をこの isolate の上限として覚える */
  wrap(f: typeof fetch): typeof fetch {
    return async (input, init) => {
      this.used += 1;
      try {
        return await f(input, init);
      } catch (e) {
        this.noteError(e);
        throw e;
      }
    };
  }

  /** 通信の上限の例外なら、その回数をこの isolate の上限として覚える（握りつぶす呼び出し側でも覚えられるよう、公開する） */
  noteError(e: unknown): void {
    if (!isSubrequestLimitError(e)) return;
    // 数えていない呼び出しで当たったときに、Free の上限より下まで絞って配信を止めないよう、Free の上限より下にはしない
    const hit = Math.max(this.floor, this.used - 1);
    learned.limit = Math.min(learned.limit ?? Number.POSITIVE_INFINITY, hit);
    learned.pendingNotice = true;
  }
}
