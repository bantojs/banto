/**
 * AWS Signature Version 4（WebCrypto だけで署名。SDK を使わない）。
 * S3 互換ストレージ（src/adapters/node/s3.ts）と Amazon SES（src/mail/transports/ses.ts）が使う。
 * Workers と Node の両方で動く（依存は crypto.subtle のみ）。
 */

const enc = new TextEncoder();

export function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
}

async function hmac(key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

export function amzDate(d: Date): { date: string; dateTime: string } {
  const iso = d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { date: iso.slice(0, 8), dateTime: iso };
}

/** SigV4（単一チャンク、ペイロードハッシュ付き）で署名したヘッダを返す */
export async function signAwsRequest(opts: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}): Promise<Record<string, string>> {
  const { date, dateTime } = amzDate(opts.now);
  const headers: Record<string, string> = { ...opts.headers, host: opts.url.host, "x-amz-content-sha256": opts.payloadHash, "x-amz-date": dateTime };
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n] ?? headers[Object.keys(headers).find((k) => k.toLowerCase() === n)!]).trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = [...opts.url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [opts.method, opts.url.pathname, canonicalQuery, canonicalHeaders, signedHeaders, opts.payloadHash].join("\n");
  const scope = `${date}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", dateTime, scope, await sha256Hex(canonicalRequest)].join("\n");
  const kDate = await hmac(`AWS4${opts.secretAccessKey}`, date);
  const kRegion = await hmac(kDate, opts.region);
  const kService = await hmac(kRegion, opts.service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));
  return {
    ...opts.headers,
    "x-amz-content-sha256": opts.payloadHash,
    "x-amz-date": dateTime,
    Authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
