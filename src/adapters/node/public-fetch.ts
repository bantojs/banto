/**
 * 外から渡された URL（画像の取り込み）を開くための fetch（Node 用、監査 M12）。
 * 名前を引いた先のアドレスを、接続の直前（node:http の lookup）に確かめる。社内のアドレスが 1 つでも返れば繋がない。
 * 先に引いて確かめてから fetch で繋ぐと、2 回目の名前の解決で社内のアドレスを返される（DNS リバインディング）ので、
 * 確かめたアドレスにそのまま繋ぐ。GET だけ。リダイレクトは追わない（呼び出し側が行き先ごとに確かめて追う）。
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

export function createPublicFetch(): typeof fetch {
  return (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const mod = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
    if (!mod || req.method !== "GET") return Promise.reject(new TypeError("publicFetch: only GET over http(s)"));
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    return new Promise<Response>((resolve, reject) => {
      const r = mod.request(url, { method: "GET", headers, lookup: publicLookup, timeout: TIMEOUT_MS, signal: req.signal }, (res) => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
          else if (v !== undefined) h.set(k, String(v));
        }
        const status = res.statusCode ?? 502;
        const empty = status === 204 || status === 304;
        if (empty) res.resume();
        resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers: h }));
      });
      r.on("timeout", () => r.destroy(new Error("publicFetch: timeout")));
      r.on("error", reject);
      r.end();
    });
  };
}
