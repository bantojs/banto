import type { Adapters, CacheAdapter, ConfigAdapter, SchedulerAdapter, ScheduledJob, StorageAdapter } from "../types";
import { normalizeConfigValue } from "../types";
import { workersSockets } from "./socket";

export interface WorkersEnv {
  MEDIA: R2Bucket;
  PUBLIC_BASE_URL: string;
  MEDIA_BASE_URL: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  STRIPE_CLIENT_ID?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  SESSION_SECRET?: string;
  /** 同梱プラグイン用 Secret（任意） */
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  RESEND_API_KEY?: string;
  /** メールの送り手（docs/email.md）: resend（既定）/ smtp / sendgrid / ses */
  MAIL_TRANSPORT?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_TLS?: string;
  SENDGRID_API_KEY?: string;
  SES_REGION?: string;
  SES_ACCESS_KEY_ID?: string;
  SES_SECRET_ACCESS_KEY?: string;
  KOMOJU_SECRET_KEY?: string;
  KOMOJU_WEBHOOK_SECRET?: string;
  /** 発送からこの日数で個人情報をマスク（既定 180） */
  MASK_ORDERS_AFTER_DAYS?: string;
}

class R2Storage implements StorageAdapter {
  constructor(private bucket: R2Bucket, private baseUrl: string) {}
  async put(key: string, body: ReadableStream | ArrayBuffer | Blob, contentType: string) {
    await this.bucket.put(key, body, { httpMetadata: { contentType } });
    return { url: `${this.baseUrl}/${key}` };
  }
  async get(key: string) {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return { body: obj.body, contentType: obj.httpMetadata?.contentType ?? "application/octet-stream" };
  }
  async delete(key: string) {
    await this.bucket.delete(key);
  }
}

class EnvConfig implements ConfigAdapter {
  constructor(private env: WorkersEnv) {}
  get(name: string) {
    return normalizeConfigValue((this.env as unknown as Record<string, string | undefined>)[name]);
  }
  secret(name: string) {
    const v = this.get(name);
    if (!v) throw new Error(`Missing secret: ${name}`);
    return v;
  }
}

/** Cache API + isolate 内メモリ。KV は使わない（CLAUDE.md §1-2） */
class WorkersCache implements CacheAdapter {
  private memory = new Map<string, { value: unknown; expires: number }>();
  async get<T>(key: string) {
    const hit = this.memory.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as T;
    this.memory.delete(key);
    return null;
  }
  async set<T>(key: string, value: T, ttlSeconds: number) {
    this.memory.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
  }
  async delete(key: string) {
    this.memory.delete(key);
  }
}

class CronScheduler implements SchedulerAdapter {
  private jobs = new Map<string, ScheduledJob>();
  register(name: string, job: ScheduledJob) {
    this.jobs.set(name, job);
  }
  async runAll() {
    for (const [, job] of this.jobs) await job();
  }
}

export function createWorkersAdapters(env: WorkersEnv): Adapters {
  return {
    storage: new R2Storage(env.MEDIA, env.MEDIA_BASE_URL),
    config: new EnvConfig(env),
    cache: new WorkersCache(),
    scheduler: new CronScheduler(),
    socket: workersSockets,
  };
}
