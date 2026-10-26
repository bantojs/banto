/**
 * Node.js 向けアダプタ（脱出経路、ARCHITECTURE.md「ポータビリティ方針」）。
 *   StorageAdapter  … S3 互換 API（S3_* が設定されていれば）/ ローカルディレクトリ（MEDIA_DIR、既定 ./data/media）
 *   ConfigAdapter   … process.env
 *   CacheAdapter    … プロセス内メモリ
 *   SchedulerAdapter… setInterval（CRON_INTERVAL_SECONDS、既定 300）
 *   SocketAdapter   … node:net / node:tls（SMTP でメールを送るため）
 * Cloudflare 固有の型はここに現れない。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import type { Adapters, ConfigAdapter, SchedulerAdapter, ScheduledJob, StorageAdapter } from "../types";
import { normalizeConfigValue } from "../types";
import { S3Storage } from "./s3";
import { createPublicFetch } from "./public-fetch";
import { nodeSockets } from "./socket";

export class EnvConfig implements ConfigAdapter {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}
  get(name: string) {
    return normalizeConfigValue(this.env[name]);
  }
  secret(name: string) {
    const v = this.get(name);
    if (!v) throw new Error(`Missing secret: ${name}`);
    return v;
  }
}

import { MemoryCache } from "../memory-cache";
export { MEMORY_CACHE_MAX_ENTRIES, MemoryCache } from "../memory-cache";

/** ローカルディレクトリ。開発用、または単一サーバーの Docker ボリューム向け */
export class FsStorage implements StorageAdapter {
  constructor(
    private readonly dir: string,
    private readonly publicBaseUrl: string,
  ) {}

  private pathFor(key: string): string {
    const p = normalize(join(this.dir, key));
    const root = normalize(this.dir + sep);
    if (!p.startsWith(root)) throw new Error(`invalid storage key: ${key}`);
    return p;
  }

  async put(key: string, body: ReadableStream | ArrayBuffer | Blob, contentType: string) {
    const buf = body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer();
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, new Uint8Array(buf));
    await writeFile(`${path}.type`, contentType);
    return { url: `${this.publicBaseUrl.replace(/\/+$/, "")}/${key}` };
  }

  async get(key: string) {
    const path = this.pathFor(key);
    try {
      const [data, type] = await Promise.all([readFile(path), readFile(`${path}.type`, "utf8").catch(() => "application/octet-stream")]);
      return { body: new Blob([new Uint8Array(data)]).stream(), contentType: type.trim() };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async delete(key: string) {
    const path = this.pathFor(key);
    await rm(path, { force: true });
    await rm(`${path}.type`, { force: true });
  }
}

export class IntervalScheduler implements SchedulerAdapter {
  private readonly jobs = new Map<string, ScheduledJob>();
  private timer: ReturnType<typeof setInterval> | undefined;
  register(name: string, job: ScheduledJob) {
    this.jobs.set(name, job);
  }
  private running = false;
  /** 前の回がまだ走っていれば飛ばす（間隔より長引いたときに重ならない） */
  async runAll() {
    if (this.running) return;
    this.running = true;
    try {
      for (const [name, job] of this.jobs) {
        try {
          await job();
        } catch (e) {
          console.error(`[banto] job ${name} failed:`, e);
        }
      }
    } finally {
      this.running = false;
    }
  }
  start(intervalSeconds: number) {
    this.stop();
    this.timer = setInterval(() => void this.runAll(), intervalSeconds * 1000);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export function createStorage(config: ConfigAdapter, fetchImpl?: typeof fetch): StorageAdapter {
  const publicBaseUrl = config.get("MEDIA_BASE_URL") ?? `${config.get("PUBLIC_BASE_URL") ?? "http://localhost:8787"}/media`;
  const endpoint = config.get("S3_ENDPOINT");
  if (endpoint) {
    return new S3Storage({
      endpoint,
      region: config.get("S3_REGION") ?? "auto",
      bucket: config.secret("S3_BUCKET"),
      accessKeyId: config.secret("S3_ACCESS_KEY_ID"),
      secretAccessKey: config.secret("S3_SECRET_ACCESS_KEY"),
      publicBaseUrl,
      pathStyle: config.get("S3_PATH_STYLE") !== "false",
      fetch: fetchImpl,
    });
  }
  return new FsStorage(config.get("MEDIA_DIR") ?? join(process.cwd(), "data", "media"), publicBaseUrl);
}

export function createNodeAdapters(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): Adapters & { scheduler: IntervalScheduler } {
  const config = new EnvConfig(env);
  return {
    storage: createStorage(config, fetchImpl),
    config,
    cache: new MemoryCache(),
    scheduler: new IntervalScheduler(),
    // 画像の URL 取り込みは、名前を引いた先が社内のアドレスなら繋がない（監査 M12）
    publicFetch: createPublicFetch(),
    socket: nodeSockets,
  };
}
