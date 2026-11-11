/**
 * S3 互換 API（AWS S3 / Cloudflare R2 の S3 API / Backblaze B2 / MinIO）向け StorageAdapter。
 * SDK を使わず、SigV4 を WebCrypto で署名する（src/util/sigv4.ts）。Node 以外のランタイムでも動く（依存は fetch と crypto.subtle のみ）。
 */
import { mediaCacheControl, type StorageAdapter, type StorageRange } from "../types";
import { sha256Hex, signAwsRequest } from "../../util/sigv4";

export interface S3Options {
  endpoint: string; // 例: https://s3.ap-northeast-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com
  region: string; // R2 は "auto"
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 公開 URL の起点（MEDIA_BASE_URL）。CDN やバケットの公開ドメイン */
  publicBaseUrl: string;
  /** パス形式（endpoint/bucket/key）。既定 true。仮想ホスト形式は bucket.endpoint/key */
  pathStyle?: boolean;
  /** 公開の置き場（MEDIA_BASE_URL から直接配る）。置くときに Cache-Control を付ける（Worker の /media/ と同じ値） */
  publicCache?: boolean;
  fetch?: typeof fetch;
  /** テスト用: 署名に使う時刻 */
  now?: () => Date;
}

/** S3 のキーは "/" を保ったまま各セグメントを RFC3986 でエンコードする */
export function encodeKey(key: string): string {
  return key
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

/** SigV4（単一チャンク、ペイロードハッシュ付き）で署名したヘッダを返す。実体は src/util/sigv4.ts（SES と共用） */
export async function signS3Request(opts: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}): Promise<Record<string, string>> {
  return signAwsRequest({ ...opts, service: "s3" });
}

export class S3Storage implements StorageAdapter {
  private readonly doFetch: typeof fetch;
  constructor(private readonly o: S3Options) {
    this.doFetch = o.fetch ?? fetch;
  }

  private objectUrl(key: string): URL {
    const base = this.o.endpoint.replace(/\/+$/, "");
    const encoded = encodeKey(key);
    if (this.o.pathStyle === false) {
      const u = new URL(base);
      u.host = `${this.o.bucket}.${u.host}`;
      u.pathname = `/${encoded}`;
      return u;
    }
    return new URL(`${base}/${this.o.bucket}/${encoded}`);
  }

  private async send(method: string, key: string, body?: ArrayBuffer, contentType?: string, range?: string, cacheControl?: string | null): Promise<Response> {
    const url = this.objectUrl(key);
    const payloadHash = await sha256Hex(body ?? "");
    const headers = await signS3Request({
      method,
      url,
      headers: { ...(contentType ? { "content-type": contentType } : {}), ...(cacheControl ? { "cache-control": cacheControl } : {}) },
      payloadHash,
      region: this.o.region,
      accessKeyId: this.o.accessKeyId,
      secretAccessKey: this.o.secretAccessKey,
      now: this.o.now?.() ?? new Date(),
    });
    // Range は署名に入れない（署名する見出しは signS3Request が決めたものだけ）
    return this.doFetch(url.toString(), { method, headers: range ? { ...headers, range } : headers, body });
  }

  async put(key: string, body: ReadableStream | ArrayBuffer | Blob, contentType: string) {
    const buf = body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer();
    const cacheControl = this.o.publicCache ? mediaCacheControl(key) : null;
    const res = await this.send("PUT", key, buf, contentType, undefined, cacheControl);
    if (!res.ok) throw new Error(`S3 PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { url: `${this.o.publicBaseUrl.replace(/\/+$/, "")}/${key}` };
  }

  async get(key: string) {
    const res = await this.send("GET", key);
    if (res.status === 404) return null;
    if (!res.ok || !res.body) throw new Error(`S3 GET ${res.status}`);
    return { body: res.body, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  async getRange(key: string, start: number, end: number | null): Promise<StorageRange | "unsatisfiable" | null> {
    const res = await this.send("GET", key, undefined, undefined, `bytes=${start}-${end ?? ""}`);
    if (res.status === 404) return null;
    if (res.status === 416) return "unsatisfiable";
    if (!res.ok || !res.body) throw new Error(`S3 GET ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
    if (res.status === 206 && m) return { body: res.body, contentType, start: Number(m[1]), end: Number(m[2]), size: Number(m[3]) };
    // Range を無視して全体を返す互換の置き場: 全体として扱う
    const size = Number(res.headers.get("content-length") ?? "NaN");
    if (!Number.isFinite(size)) throw new Error("S3 GET: no length");
    return { body: res.body, contentType, start: 0, end: size - 1, size };
  }

  async delete(key: string) {
    const res = await this.send("DELETE", key);
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${res.status}`);
  }
}
