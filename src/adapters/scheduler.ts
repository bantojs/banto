import type { ScheduledJob, ScheduledJobOptions } from "./types";

export interface RegisteredJob {
  name: string;
  job: ScheduledJob;
  opts: ScheduledJobOptions;
}

/**
 * 登録した順にジョブを走らせ、落ちたジョブの名前を返す（Workers と Node のスケジューラで共通）。
 * - 1 つが落ちても残りは走らせる（在庫の解放・個人情報のマスキングを、hooks の配信の失敗で止めない）
 * - afterAllSucceeded のジョブ（ハートビート）は、それより前のジョブがすべて成功した回だけ走らせる
 * - 落ちたジョブは名前を付けてログに出す（どのジョブかが Workers のログでも分かるように）
 */
export async function runScheduledJobs(jobs: Iterable<RegisteredJob>, log: (message: string, error: unknown) => void = (m, e) => console.error(m, e)): Promise<string[]> {
  const failed: string[] = [];
  for (const { name, job, opts } of jobs) {
    if (opts.afterAllSucceeded && failed.length > 0) continue;
    try {
      await job();
    } catch (e) {
      failed.push(name);
      log(`[banto] job ${name} failed:`, e);
    }
  }
  return failed;
}

/** 登録の器（名前で上書き。登録した順を保つ） */
export class JobRegistry {
  private readonly jobs = new Map<string, RegisteredJob>();
  register(name: string, job: ScheduledJob, opts: ScheduledJobOptions = {}): void {
    this.jobs.set(name, { name, job, opts });
  }
  list(): RegisteredJob[] {
    return [...this.jobs.values()];
  }
}
