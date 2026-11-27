/**
 * hooks の配信ワーカー。Cron から service_role で呼ぶ（src/jobs/）。
 * claim_hook_deliveries で取り出し → 署名付き POST → finish_hook_delivery。
 * 2xx を成功、それ以外とネットワークエラー・タイムアウトを失敗として扱う（再送は DB 側で判断）。
 *
 * 1 件の配信はほかの配信を巻き込まない（docs/hooks.md §5「配信の分け方」）:
 * - 「送る」と「結果を書く」を分ける。送る側の例外はその配信の失敗として受け止め、結果を書く側の例外は送った結果を変えない
 *   （送れたのに書き込みが 1 回落ちたからといって「失敗」と書き直さない。書き直すと再送で二重に届く）
 * - 結果を書けなかった配信は回の最後にもう 1 回だけ書き直し、それでも書けなければ数えて返す（unrecorded）。
 *   貸し出し（10 分）が切れたら取り出し直される。ジョブを失敗にするかは呼ぶ側が、全部を最後まで進めた後で決める
 * - 同梱プラグイン（取引の知らせのメール・LINE）は外部プラグインを待たずに並べて送り、外部プラグインへは同時に開く数を絞って送る
 *   （Workers の同時接続の枠を遅い外部の送信先が握り、メールの送信や結果の書き込みを待たせないため）。
 *   同梱プラグインの通信にも打ち切りを付ける（メール・LINE の API が止まっても、その回が終わらなくならないように）
 * - 通信の回数の上限に当たったら、まだ送っていない外部の配信は送らずに返す（送っても結果を書けず、貸し出しの後で二重に届く）
 * - 外部の応答の本文は、2xx なら読まずに閉じる（読まれない本文は接続を開いたままにする）
 * 送る直前に行き先を確かめ（blockedHookTarget）、私設のアドレス・社内の名前には送らない。
 * 渡す fetch は Node では adapters.publicFetch（名前を引いた先も接続の直前に確かめる）。
 */
import { DELIVERY_COST, isSubrequestLimitError } from "../jobs/budget";
import { PrivilegedRpcError, type PrivilegedDb } from "../db/privileged";
import type { ConfigAdapter, SocketAdapter } from "../adapters/types";
import { connectionSecretPurpose, endpointSecret, signHookPayload } from "./signing";
import { openSecret } from "../members/secret-box";
import type { HookEnvelope } from "./events";
import { bundledPluginIdFromUrl, findBundledPlugin } from "../plugins";
import { readTextCapped } from "../util/read-capped";
import { BLOCKED_HOOK_TARGET, blockedHookTarget } from "./target";

export const HOOK_TIMEOUT_MS = 10_000;
/**
 * 外部プラグインへ同時に送る数。Workers は同時に開ける接続が 6 本で、それを超えた通信は待たされる。
 * 外部の送信先が全部の枠を握らないよう、結果の書き込み（PostgREST）の分を残す
 */
export const EXTERNAL_CONCURRENCY = 4;
/** 同梱プラグインの 1 回の通信（メール・LINE の API など）の打ち切り。応答の本文を読み終えるまでを含む */
export const BUNDLED_FETCH_TIMEOUT_MS = 20_000;
/** 記録に残す失敗の文の長さ（文字。DB の last_error） */
const ERROR_TEXT_MAX = 500;
/** 結果の書き込みが文の中身のために断られたとき、書き直しで代わりに残す文 */
const UNRECORDABLE_ERROR_TEXT = "(the error text could not be recorded)";

export interface DeliverResult {
  claimed: number;
  delivered: number;
  failed: number;
  /** 送った（または失敗と決めた）が、その結果を DB に書けなかった数。貸し出しが切れたら取り出し直される */
  unrecorded: number;
}

/** 1 件の配信の結果（finish_hook_delivery に書く中身） */
interface Outcome {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/** ログに出す原因（Workers の fetch の例外は文が空のことがあるので、種類も出す。個人情報は持たない） */
export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const msg = e.message.trim();
    return msg ? `${e.name}: ${msg}` : `${e.name} (no message)`;
  }
  return String(e);
}

/** 失敗の記録に残す文（DB の last_error）。空の文は種類に置き換える */
function errorText(e: unknown): string {
  if (e instanceof Error) return e.message.trim() || e.name;
  return String(e);
}

/**
 * 記録に残す文を DB が受け取れる形にする: 制御文字（PostgreSQL の text は NUL を受け取らない）と片割れのサロゲートを外し、
 * 文字（コードポイント）で上限まで切る（UTF-16 の途中で切らない）
 */
export function recordableText(text: string | null, max = ERROR_TEXT_MAX): string | null {
  if (text === null) return null;
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
  const chars = Array.from(clean);
  return chars.length > max ? chars.slice(0, max).join("") : clean;
}

/** 結果の書き込みが、送り直しても通らない理由で断られたか（PostgREST の 4xx。文の中身・形の誤り） */
function permanentRecordError(e: unknown): boolean {
  return e instanceof PrivilegedRpcError && e.status >= 400 && e.status < 500;
}

/** 打ち切りを付けた fetch（呼ぶ側の signal も効かせる）。本文を読み終えるまでを含むので、時計は止めずに走らせる */
function fetchWithTimeout(rawFetch: typeof fetch, ms: number): typeof fetch {
  return (input, init) => {
    const controller = new AbortController();
    const outer = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener("abort", () => controller.abort(outer.reason), { once: true });
    }
    setTimeout(() => controller.abort(new Error(`bundled plugin request timed out after ${ms}ms`)), ms);
    return rawFetch(input, { ...init, signal: controller.signal });
  };
}

/** 並べて走らせ、すべてが終わるまで待つ。1 つの例外でほかを止めない（各処理は自分で例外を受け止める前提の、最後の砦） */
async function settleAll(tasks: (() => Promise<void>)[], concurrency = Infinity): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++]!;
      await task().catch((e: unknown) => console.error(`[banto] hooks: delivery task failed unexpectedly: ${describeError(e)}`));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker));
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
  /** 外部プラグインへ同時に送る数（既定 EXTERNAL_CONCURRENCY） */
  externalConcurrency?: number;
  /** 同梱プラグインの 1 回の通信の打ち切り（既定 BUNDLED_FETCH_TIMEOUT_MS） */
  bundledTimeoutMs?: number;
  /**
   * その回の通信の残り（Cron の予算、src/jobs/budget.ts）。あれば、取り出した配信を種類ごとの見積もりで確かめ直し、
   * 残りに入らない分は送らずに返す（release_hook_deliveries、回数を戻す。0160）
   */
  budget?: { remaining(): number; reserve: number };
}): Promise<DeliverResult> {
  // プロパティ経由で呼ばない（Workers の "Illegal invocation" 対策）
  const rawFetch = opts.fetch;
  const doFetch: typeof fetch = (input, init) => rawFetch(input, init);
  const pluginFetch = fetchWithTimeout(doFetch, opts.bundledTimeoutMs ?? BUNDLED_FETCH_TIMEOUT_MS);
  const claimed = await opts.db.claimHookDeliveries(opts.limit ?? 50);
  const result: DeliverResult = { claimed: claimed.length, delivered: 0, failed: 0, unrecorded: 0 };
  type Row = (typeof claimed)[number];
  const envelopeOf = (row: Row): HookEnvelope => ({
    id: row.id,
    event: row.event,
    created_at: row.created_at,
    shop_id: row.shop_id,
    attempt: row.attempts,
    data: row.payload,
  });

  // 結果を書く。送った結果（delivered / failed）は書けたかどうかに関わらず決まっている。
  // 書けなければ回の最後にもう 1 回だけ書き直す（その場で繰り返さない: 同じ一時的な不調に当たりやすく、通信の予算も食う）
  const retry: { id: string; outcome: Outcome; limit: boolean; permanent: boolean }[] = [];
  // 通信の回数の上限に当たった（この回はもう何も通らない）
  let limitHit = false;
  const record = async (id: string, raw: Outcome): Promise<void> => {
    const outcome = { ...raw, error: recordableText(raw.error) };
    if (outcome.ok) result.delivered++;
    else result.failed++;
    try {
      await opts.db.finishHookDelivery(id, outcome.ok, outcome.status, outcome.error);
    } catch (e) {
      const limit = isSubrequestLimitError(e);
      if (limit) limitHit = true;
      console.warn(`[banto] hooks: could not record delivery ${id} (${outcome.ok ? "delivered" : "failed"}), will retry: ${describeError(e)}`);
      retry.push({ id, outcome, limit, permanent: permanentRecordError(e) });
    }
  };

  // 同梱プラグインが「まとめて受け取る」と決めた出来事は、送信先と出来事ごとに 1 回で渡す（batchEvents、LINE 通知の inventory.low など）
  const batches = new Map<string, Row[]>();
  const bundledRows: Row[] = [];
  const externalRows: Row[] = [];
  for (const row of claimed) {
    const id = bundledPluginIdFromUrl(row.url);
    const plugin = id !== null ? findBundledPlugin(id) : undefined;
    if (plugin?.handleBatch && plugin.batchEvents?.includes(row.event)) {
      const key = `${row.endpoint_id} ${row.event}`;
      batches.set(key, [...(batches.get(key) ?? []), row]);
    } else if (id !== null) bundledRows.push(row);
    else externalRows.push(row);
  }

  // 通信の残りに入る分だけ送る（同梱プラグインを先に。まとめて受けるものは群ごと）。入らない分は、送った後で回数を戻して返す
  // （返すのに失敗しても、送れる分は送る。返せなかった分は 10 分の貸し出しが切れたら取り出し直される）
  let releaseLater: string[] = [];
  if (opts.budget) {
    let spare = opts.budget.remaining() - opts.budget.reserve;
    const deferred: string[] = [];
    for (const [key, group] of [...batches]) {
      const cost = group.length + DELIVERY_COST.batchBase;
      if (cost <= spare) spare -= cost;
      else {
        batches.delete(key);
        deferred.push(...group.map((r) => r.id));
      }
    }
    const admit = (list: Row[], cost: number) => {
      const admitted = list.filter((row) => {
        if (cost <= spare) {
          spare -= cost;
          return true;
        }
        deferred.push(row.id);
        return false;
      });
      list.length = 0;
      list.push(...admitted);
    };
    admit(bundledRows, DELIVERY_COST.bundled);
    admit(externalRows, DELIVERY_COST.external);
    result.claimed -= deferred.length;
    releaseLater = deferred;
  }

  const deliverBatch = async (group: Row[]): Promise<void> => {
    const plugin = findBundledPlugin(bundledPluginIdFromUrl(group[0]!.url)!)!;
    let outcome: Outcome = { ok: true, status: 200, error: null };
    try {
      if (!opts.config) throw new Error("config adapter missing");
      const config = opts.config;
      await plugin.handleBatch!.call(
        plugin,
        group.map((row) => ({ envelope: envelopeOf(row), settings: row.settings ?? {}, config, socket: opts.socket, fetch: pluginFetch, privileged: opts.db, sessionSecret: opts.sessionSecret })),
      );
    } catch (e) {
      outcome = { ok: false, status: null, error: errorText(e) };
    }
    for (const row of group) await record(row.id, outcome);
  };

  // 同梱プラグイン: HTTP ではなくプロセス内で呼ぶ
  const deliverBundled = async (row: Row): Promise<void> => {
    const pluginId = bundledPluginIdFromUrl(row.url)!;
    const plugin = findBundledPlugin(pluginId);
    let outcome: Outcome;
    try {
      if (!plugin) throw new Error(`unknown bundled plugin: ${pluginId}`);
      const handle = plugin.handle;
      if (!handle) {
        // 受信処理を持たないプラグイン（Stripe / KOMOJU は決済事業者の Webhook を受ける側）。配信対象外として完了にする
        outcome = { ok: true, status: 204, error: null };
      } else {
        if (!opts.config) throw new Error("config adapter missing");
        await handle.call(plugin, { envelope: envelopeOf(row), settings: row.settings ?? {}, config: opts.config, socket: opts.socket, fetch: pluginFetch, privileged: opts.db, sessionSecret: opts.sessionSecret });
        outcome = { ok: true, status: 200, error: null };
      }
    } catch (e) {
      outcome = { ok: false, status: null, error: errorText(e) };
    }
    await record(row.id, outcome);
  };

  const sendExternal = async (row: Row): Promise<Outcome> => {
    // 行き先が私設のアドレス・社内の名前なら送らずに失敗にする（登録時の検査を通らずに入った行の最後の砦）
    if (blockedHookTarget(row.url)) return { ok: false, status: null, error: BLOCKED_HOOK_TARGET };
    const body = JSON.stringify(envelopeOf(row));
    // つないだ連携（0088）は接続ごとの署名シークレット。開けなければ（サイトの秘密が変わった）送らずに失敗にする（つなぎ直してもらう）
    const secret = row.secret_box ? await openSecret(opts.sessionSecret, row.shop_id, connectionSecretPurpose(row.endpoint_id), row.secret_box) : await endpointSecret(opts.sessionSecret, row.endpoint_id);
    if (!secret) return { ok: false, status: null, error: "connection signing secret could not be opened (the site secret changed?); reconnect the plugin" };
    const signature = await signHookPayload(secret, body);
    const controller = new AbortController();
    // 打ち切りは応答の本文を読み終えるまで（遅い本文で枠を握らせない）
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
        // リダイレクトは追わない（登録時に確かめた行き先以外へ出ない）。3xx は失敗として再送に回る
        redirect: "manual",
      });
      const ok = res.status >= 200 && res.status < 300;
      if (ok) {
        // 本文は使わないので読まずに閉じる（読まれない本文は接続を開いたままにし、Workers の同時接続の枠を握る）
        await res.body?.cancel().catch(() => undefined);
        return { ok, status: res.status, error: null };
      }
      // 失敗の本文は 4KB まで読み（読み終えたら閉じる）、記録は 500 文字（上限なしに読まない。record が DB に入る形に整える）
      const text = await readTextCapped(res, 4096).catch(() => "");
      return { ok, status: res.status, error: text };
    } catch (e) {
      if (isSubrequestLimitError(e)) limitHit = true;
      return { ok: false, status: null, error: controller.signal.aborted ? `timeout after ${opts.timeoutMs ?? HOOK_TIMEOUT_MS}ms` : errorText(e) };
    } finally {
      clearTimeout(timer);
    }
  };

  // 通信の上限に当たった後の外部の配信は送らずに返す（回数を戻す）
  const skipped: string[] = [];
  const deliverExternal = async (row: Row): Promise<void> => {
    if (limitHit) {
      skipped.push(row.id);
      return;
    }
    let outcome: Outcome;
    try {
      outcome = await sendExternal(row);
    } catch (e) {
      // 署名・暗号の失敗など、送る前の不調もその配信の失敗にとどめる
      outcome = { ok: false, status: null, error: errorText(e) };
    }
    await record(row.id, outcome);
  };

  try {
    // 1. 同梱プラグイン（取引の知らせ）は外部を待たずに並べて送り、外部プラグインは同時に開く数を絞って送る（結果の書き込みの枠を残す）。
    //    どちらも 1 件ずつ例外を受け止めるので、片方が遅くても落ちてももう片方は最後まで進む
    await Promise.all([
      settleAll([...[...batches.values()].map((g) => () => deliverBatch(g)), ...bundledRows.map((r) => () => deliverBundled(r))]),
      settleAll(
        externalRows.map((r) => () => deliverExternal(r)),
        opts.externalConcurrency ?? EXTERNAL_CONCURRENCY,
      ),
    ]);
    if (skipped.length > 0) {
      result.claimed -= skipped.length;
      releaseLater = [...releaseLater, ...skipped];
    }
    // 2. 書けなかった結果をもう 1 回だけ書く（送り直さない。書けなければ貸し出しが切れたら取り出し直される）
    for (const { id, outcome, limit, permanent } of retry) {
      try {
        // 通信の上限に当たった回・予算の残りが無い回は書き直さない（同じ理由で落ちる。ハートビートの分を食わない）
        if (limit || limitHit || (opts.budget && opts.budget.remaining() <= opts.budget.reserve)) throw new Error("subrequest budget exhausted");
        // 文の中身で断られた失敗の記録は、文を差し替えて書く（同じ文では何度書いても通らない）
        await opts.db.finishHookDelivery(id, outcome.ok, outcome.status, permanent && !outcome.ok ? UNRECORDABLE_ERROR_TEXT : outcome.error);
      } catch (e) {
        result.unrecorded++;
        console.error(`[banto] hooks: could not record delivery ${id} (${outcome.ok ? "delivered" : "failed"}); it will be claimed again after the lease expires: ${describeError(e)}`);
      }
    }
  } finally {
    // 入らずに返す分は、送る途中で落ちても返す（回数を進めたまま 10 分待たせない）。返すのに失敗しても送った結果は変えない
    if (releaseLater.length > 0) {
      await opts.db.releaseHookDeliveries(releaseLater).catch((e: unknown) => console.error(`[banto] hooks: release of deferred deliveries failed: ${describeError(e)}`));
    }
  }
  return result;
}
