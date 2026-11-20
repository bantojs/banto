/**
 * 画像を裏で取り込む（同梱モジュール woo_import、0039）。Cron ごとに、期限の来た予約を決まった枚数だけ取り出し、
 * URL から取得 → ストレージ → 商品に紐づける。枚数はデプロイの設定（0038 の workers_plan）で DB が決める。
 * 1 枚ごとの失敗は理由のコードで記録し（一時的なものは DB がやり直す）、ジョブ全体は落とさない。
 */
import type { Adapters } from "../../adapters/types";
import type { ImageImportJob, PrivilegedDb } from "../../db/privileged";
import { fetchImage, ImageFetchError } from "../../media/fetch-image";
import { wcImageKey } from "./keys";

/** 同時に取りに行く数（相手のサイトに負担をかけすぎない） */
const CONCURRENCY = 4;

type Result = { id: number; storage_key: string } | { id: number; error: string };

/**
 * maxJobs: その回に進めてよい数（Cron の通信の予算、src/jobs/budget.ts）。予算で絞る回（0160 を当てた Workers）だけ有限で、
 * その数だけ取り出す（取り出すと貸し出しの回数が進むので、進められない分は取り出さない）
 */
export async function runImageImport(adapters: Adapters, db: PrivilegedDb, doFetch: typeof fetch, maxJobs?: () => number): Promise<{ done: number; retry: number; failed: number } | null> {
  // 進められないなら取り出さない（取り出すと貸し出しの回数だけ進む）
  const allowed = maxJobs ? Math.max(0, maxJobs()) : Number.MAX_SAFE_INTEGER;
  if (allowed === 0) return null;
  const jobs = await db.imageImportClaim(allowed < Number.MAX_SAFE_INTEGER ? allowed : undefined);
  if (jobs.length === 0) return null;
  const results: Result[] = [];
  const queue = [...jobs];
  const work = async (job: ImageImportJob): Promise<Result> => {
    try {
      const img = await fetchImage(job.url, adapters.publicFetch ?? doFetch);
      const key = wcImageKey(job.shop_id, job.product_id, job.url, img.ext);
      await adapters.storage.put(key, img.body, img.contentType);
      return { id: job.id, storage_key: key };
    } catch (e) {
      return { id: job.id, error: e instanceof ImageFetchError ? e.code : "storage" };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) results.push(await work(job));
    }),
  );
  // 書けなかったら、置いた画像はそのまま（キーは URL から決まるので、10 分後に取り出し直したとき同じキーに上書きされる）
  return db.imageImportFinish(results);
}

export function registerImageImportJob(adapters: Adapters, db: PrivilegedDb, doFetch: typeof fetch, maxJobs?: () => number): void {
  adapters.scheduler.register("image_import", async () => {
    await runImageImport(adapters, db, doFetch, maxJobs);
  });
}
