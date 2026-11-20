/**
 * Cron の 1 回の実行の、外への通信（サブリクエスト）の予算。
 *
 * Workers は 1 回の実行で使える通信の回数に上限がある（Free 50・Paid 1,000。adapters.cronSubrequestLimits）。DB の呼び出し（PostgREST）も
 * 1 回と数えるので、Cron のジョブが使う fetch をここで包んで数え、hooks の配信は残りの回数から取り出す数を決める（1 件いくつと見積もる）。
 * 上限はサイトの設定 workers_plan で選ぶ。実際のプランと食い違っていて「Too many subrequests」が出たら、この isolate ではそのときの
 * 回数を上限とみなして次の回から絞り、ダッシュボードに知らせるための印（ハートビートの表の CRON_LIMIT_HEARTBEAT）を次の回に書く。
 * Node（上限なし）では数えるだけで絞らない。
 */

/** hooks の配信 1 件の見積もり（送信先への通信と finish_hook_delivery。同梱プラグインは連絡先の読み取りと送信もするので多めに） */
export const DELIVERY_COST = 4;
/** 配信の後に残しておく回数（ハートビート・配信を取り出す呼び出し・ゆとり） */
export const DELIVERY_RESERVE = 4;
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

  /** この回の数え直し。上限はプランの上限と、この isolate で当たった上限の小さいほう */
  start(planLimit: number | null): void {
    this.used = 0;
    this.planLimit = planLimit ?? Number.POSITIVE_INFINITY;
  }

  /** この回の上限を決める（数えた回数はそのまま。プランを読むのに使った分も数えたまま） */
  setPlanLimit(planLimit: number): void {
    this.planLimit = planLimit;
  }

  get limit(): number {
    return Math.min(this.planLimit, learned.limit ?? Number.POSITIVE_INFINITY);
  }

  remaining(): number {
    return this.limit - this.used;
  }

  /** 上限のある実行で、配信を何件取り出してよいか（無制限なら undefined = DB の既定） */
  deliveryLimit(): number | undefined {
    if (!Number.isFinite(this.limit)) return undefined;
    return Math.max(0, Math.floor((this.remaining() - DELIVERY_RESERVE) / DELIVERY_COST));
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
        if (isSubrequestLimitError(e)) {
          const hit = Math.max(10, this.used - 1);
          learned.limit = Math.min(learned.limit ?? Number.POSITIVE_INFINITY, hit);
          learned.pendingNotice = true;
        }
        throw e;
      }
    };
  }
}
