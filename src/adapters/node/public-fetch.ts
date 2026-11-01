/**
 * 外から渡された URL（画像の取り込み・hooks の配信・マニフェストの取得・法務のリンクの確認）を開くための fetch（Node 用、監査 M12）。
 * 名前を引いた先のアドレスを、接続の直前（node:http の lookup）に確かめる。社内のアドレスが 1 つでも返れば繋がない。
 * 先に引いて確かめてから fetch で繋ぐと、2 回目の名前の解決で社内のアドレスを返される（DNS リバインディング）ので、
 * 確かめたアドレスにそのまま繋ぐ。http(s) だけ。本文とヘッダはそのまま送る（hooks の署名付き POST）。
 * リダイレクトは追わない（呼び出し側が行き先ごとに確かめて追うか、3xx を失敗にする）。
 * Workers は社内の網にそもそも届かないので使わない（src/adapters/types.ts の publicFetch）。
 */
import http from "node:http";
import https from "node:https";
import { lookup, type LookupAddress, type LookupOptions } from "node:dns";
import { Readable } from "node:stream";
import { isPublicIp } from "../../media/address";
import { BLOCKED_ADDRESS } from "../../media/fetch-image";

const TIMEOUT_MS = 20_000;

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** 引いたアドレスがすべて公開のときだけ返す */
export function publicLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((a) => !isPublicIp(a.address))) {
      return callback(Object.assign(new Error(`address of ${hostname} is not public`), { code: BLOCKED_ADDRESS }), "");
    }
    if (options.all) callback(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  });
}

/** 本文を持たないメソッド（送らない） */
const NO_BODY = new Set(["GET", "HEAD"]);

/**
 * @param lookupImpl 名前の解決（既定は publicLookup）。テストで引いた先を差し替えるためだけ。本番では渡さない
 */
export function createPublicFetch(lookupImpl: typeof publicLookup = publicLookup): typeof fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const mod = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
    if (!mod) throw new TypeError("publicFetch: only http(s)");
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    // 本文は先に全部読む（hooks のペイロードとマニフェストの要求は小さい。流しながら送らない）
    const body = NO_BODY.has(req.method) || req.body === null ? null : Buffer.from(await req.arrayBuffer());
    if (body) headers["content-length"] = String(body.byteLength);
    return new Promise<Response>((resolve, reject) => {
      const r = mod.request(url, { method: req.method, headers, lookup: lookupImpl, timeout: TIMEOUT_MS, signal: req.signal }, (res) => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
          else if (v !== undefined) h.set(k, String(v));
        }
        const status = res.statusCode ?? 502;
        const empty = status === 204 || status === 304 || req.method === "HEAD";
        if (empty) res.resume();
        resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers: h }));
      });
      r.on("timeout", () => r.destroy(new Error("publicFetch: timeout")));
      r.on("error", reject);
      r.end(body ?? undefined);
    });
  };
}
