/**
 * Node.js 向けアダプタ（脱出経路、ARCHITECTURE.md「ポータビリティ方針」）。
 *   StorageAdapter  … S3 互換 API（S3_* が設定されていれば）/ ローカルディレクトリ（MEDIA_DIR、既定 ./data/media）
 *   privateStorage  … 公開しない置き場（お問い合わせの添付）。S3 なら S3_PRIVATE_BUCKET、ローカルなら PRIVATE_MEDIA_DIR（既定 ./data/private。/media からは読めない）
 *   ConfigAdapter   … process.env
 *   CacheAdapter    … プロセス内メモリ
 *   SchedulerAdapter… setInterval（CRON_INTERVAL_SECONDS、既定 300）
 *   SocketAdapter   … node:net / node:tls（SMTP でメールを送るため）
 * Cloudflare 固有の型はここに現れない。
 */
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { clampRange, type Adapters, type ConfigAdapter, type SchedulerAdapter, type ScheduledJob, type ScheduledJobOptions, type StorageAdapter, type StorageRange } from "../types";
import { normalizeConfigValue } from "../types";
import { JobRegistry, runScheduledJobs } from "../scheduler";
import { S3Storage } from "./s3";
import { createPublicFetch } from "./public-fetch";
import { nodeSockets } from "./socket";
import { rootCertificates } from "node:tls";

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

  /** 置き場のキーは相対の形だけ（/themes/… や a//b は、畳むと別のキーと同じファイルになる） */
  private validKey(key: string): boolean {
    return !(key.startsWith("/") || key.includes("//") || key.includes("\\"));
  }

  private pathFor(key: string): string {
    if (!this.validKey(key)) throw new Error(`invalid storage key: ${key}`);
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
    // 形の合わないキー（読む側が URL の名前から組み立てたもの）は「無い」で返す。置く・消すは今までどおり例外
    if (!this.validKey(key)) return null;
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

  async getRange(key: string, start: number, end: number | null): Promise<StorageRange | "unsatisfiable" | null> {
    if (!this.validKey(key)) return null;
    const path = this.pathFor(key);
    let fh;
    try {
      fh = await open(path, "r");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    try {
      const size = (await fh.stat()).size;
      const r = clampRange(size, start, end);
      if (!r) return "unsatisfiable";
      const buf = new Uint8Array(r.end - r.start + 1);
      await fh.read(buf, 0, buf.length, r.start);
      const type = await readFile(`${path}.type`, "utf8").catch(() => "application/octet-stream");
      return { body: new Blob([buf]).stream(), contentType: type.trim(), size, ...r };
    } finally {
      await fh.close();
    }
  }
}

export class IntervalScheduler implements SchedulerAdapter {
  private readonly registry = new JobRegistry();
  private timer: ReturnType<typeof setInterval> | undefined;
  register(name: string, job: ScheduledJob, opts?: ScheduledJobOptions) {
    this.registry.register(name, job, opts);
  }
  private running = false;
  /** 前の回がまだ走っていれば飛ばす（間隔より長引いたときに重ならない） */
  async runAll() {
    if (this.running) return;
    this.running = true;
    try {
      // 1 つが落ちても残りは走らせ、ハートビートは全部が成功した回だけ（Workers と同じ。src/adapters/scheduler.ts）
      await runScheduledJobs(this.registry.list());
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
      publicCache: true,
      fetch: fetchImpl,
    });
  }
  return new FsStorage(config.get("MEDIA_DIR") ?? join(process.cwd(), "data", "media"), publicBaseUrl);
}

/** 公開しない置き場。S3 を使う構成は S3_PRIVATE_BUCKET があるときだけ（公開のバケットとは別に作る）。無ければ添付を出さない */
export function createPrivateStorage(config: ConfigAdapter, fetchImpl?: typeof fetch): StorageAdapter | undefined {
  const endpoint = config.get("S3_ENDPOINT");
  if (endpoint) {
    const bucket = config.get("S3_PRIVATE_BUCKET");
    if (!bucket) return undefined;
    return new S3Storage({
      endpoint,
      region: config.get("S3_REGION") ?? "auto",
      bucket,
      accessKeyId: config.secret("S3_ACCESS_KEY_ID"),
      secretAccessKey: config.secret("S3_SECRET_ACCESS_KEY"),
      publicBaseUrl: "",
      pathStyle: config.get("S3_PATH_STYLE") !== "false",
      fetch: fetchImpl,
    });
  }
  return new FsStorage(config.get("PRIVATE_MEDIA_DIR") ?? join(process.cwd(), "data", "private"), "");
}

export function createNodeAdapters(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): Adapters & { scheduler: IntervalScheduler } {
  const config = new EnvConfig(env);
  return {
    storage: createStorage(config, fetchImpl),
    ...((p) => (p ? { privateStorage: p } : {}))(createPrivateStorage(config, fetchImpl)),
    config,
    cache: new MemoryCache(),
    scheduler: new IntervalScheduler(),
    // 画像の URL 取り込みは、名前を引いた先が社内のアドレスなら繋がない
    publicFetch: createPublicFetch(),
    cpuUnlimited: true,
    socket: nodeSockets,
    tlsRootCertificates: rootCertificates,
  };
}
