/**
 * アダプタ層のインターフェース。
 * Cloudflare 固有機能はここを通してのみ使う（CLAUDE.md §1, §4）。
 * 実装は src/adapters/workers/（既定）と、将来の src/adapters/node/ に置く。
 */

export interface StorageAdapter {
  /** オブジェクトを保存し、公開 URL（MEDIA_BASE_URL ベース）を返す */
  put(key: string, body: ReadableStream | ArrayBuffer | Blob, contentType: string): Promise<{ url: string }>;
  get(key: string): Promise<{ body: ReadableStream; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

/**
 * 未入力を表すプレースホルダ。.dev.vars.example に書いておき、Deploy ボタンの画面で置き換えてもらう。
 * そのまま配置された場合は「未設定」として扱う（セットアップ画面が案内する）。
 */
export const CONFIG_PLACEHOLDER = "REPLACE_ME";

/** 空文字とプレースホルダは未設定とみなす（各 ConfigAdapter の get() で使う） */
export function normalizeConfigValue(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const v = String(value).trim();
  return v === "" || v === CONFIG_PLACEHOLDER ? undefined : v;
}

export interface ConfigAdapter {
  /** 公開可能な設定値（PUBLIC_BASE_URL など） */
  get(name: string): string | undefined;
  /** シークレット。未設定なら throw */
  secret(name: string): string;
}

export interface CacheAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 定期処理はこのハンドラを登録する。Workers では Cron Trigger が呼ぶ */
export type ScheduledJob = () => Promise<void>;
export interface SchedulerAdapter {
  register(name: string, job: ScheduledJob): void;
  runAll(): Promise<void>;
}

/**
 * 生の TCP 接続（SMTP でメールを送るため。src/mail/transports/smtp.ts）。
 * Workers は cloudflare:sockets、Node は node:net / node:tls で実装する。読み書きはバイト列、STARTTLS は同じ接続を TLS に切り替える。
 */
export interface RawConnection {
  /** 次のデータ。接続が閉じたら null */
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  /** STARTTLS: この接続を TLS にして返す。以後は返った接続だけを使う（"starttls" で開いた接続だけ） */
  startTls(): Promise<RawConnection>;
  close(): Promise<void>;
}

export interface SocketAdapter {
  /** tls: "on" は最初から TLS（465）、"starttls" は平文で開いてあとで startTls()（587）、"off" は平文のまま */
  connect(host: string, port: number, tls: "on" | "off" | "starttls"): Promise<RawConnection>;
}

/**
 * 独自ドメインの提供元（Cloudflare for SaaS のカスタムホスト名など。人間の決定 2026-10-23、docs/knowledge/02-decisions.md）。
 * 無ければ Banto は「運営者が Cloudflare で Worker にドメインを付けてから保存する」案内だけを出す（docs/custom-domain.md §6）。
 * 所有の確認・証明書・DNS の指示は提供元の仕事で、Banto は結果を受け取って画面に出すだけ。Banto をホスティングして提供する側の実装が入る継ぎ目。
 */
export interface DomainInstruction {
  type: "cname" | "txt" | "a";
  name: string;
  value: string;
}
export interface DomainState {
  /** active: 提供元で有効。pending: DNS や確認の待ち（instructions に何をすればよいか） */
  status: "active" | "pending";
  instructions?: DomainInstruction[];
  message?: string;
}
export type DomainAttachResult = { ok: true; state: DomainState } | { ok: false; reason: "invalid" | "taken" | "unverified" | "unavailable"; message?: string };
export interface DomainAdapter {
  /** ショップにドメインを付ける前に呼ぶ（提供元で所有の確認・ホスト名の登録）。断るなら理由 */
  attach(domain: string, shop: { id: string; slug: string }): Promise<DomainAttachResult>;
  /** ドメインを外した・変えたあとに呼ぶ（提供元の登録を消す）。失敗しても Banto 側の設定は戻さない */
  detach(domain: string, shop: { id: string; slug: string }): Promise<void>;
  /** 今の状態（管理画面に出す）。提供元に無ければ null */
  status(domain: string, shop: { id: string; slug: string }): Promise<DomainState | null>;
}

export interface Adapters {
  storage: StorageAdapter;
  config: ConfigAdapter;
  cache: CacheAdapter;
  scheduler: SchedulerAdapter;
  /** 生の TCP（SMTP）。無いランタイムでは SMTP の送り手を選べない */
  socket?: SocketAdapter;
  /**
   * 外から渡された URL（画像の取り込み）を開くための fetch。名前を引いた先が社内のアドレスなら繋がない（監査 M12）。
   * Node で使う（src/adapters/node/public-fetch.ts）。Workers は社内の網にそもそも届かないので持たない（無ければ deps.fetch）
   */
  publicFetch?: typeof fetch;
  /** 独自ドメインの提供元。無ければ案内だけ（セルフホストの既定） */
  domain?: DomainAdapter;
}
