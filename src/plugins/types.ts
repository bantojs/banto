/**
 * 同梱プラグイン（ARCHITECTURE.md「プラグインアーキテクチャ」）。
 * コアにバンドルし、有効/無効は DB（hook_endpoints の行）で切り替える。再デプロイ不要。
 * 外部プラグインと同じ hooks の仕組みに乗る: 有効化 = URL が `https://banto.invalid/plugins/<id>` の
 * 送信先を作ること。配信ワーカーはこの URL を見てプロセス内で handle() を呼ぶ（HTTP は使わない）。
 * API キー等のシークレットは Workers Secret から読む（CLAUDE.md §1-5）。例外は LINE のチャネルアクセストークン（ショップごと、暗号化して DB。0021）。
 */
import type { ConfigAdapter, SocketAdapter } from "../adapters/types";
import type { PrivilegedDb } from "../db/privileged";
import type { PluginManifest } from "../hooks/manifest";
import type { HookEnvelope } from "../hooks/events";

export const BUNDLED_PLUGIN_URL_PREFIX = "https://banto.invalid/plugins/";

export function bundledPluginUrl(id: string): string {
  return `${BUNDLED_PLUGIN_URL_PREFIX}${id}`;
}

export function bundledPluginIdFromUrl(url: string): string | null {
  return url.startsWith(BUNDLED_PLUGIN_URL_PREFIX) ? url.slice(BUNDLED_PLUGIN_URL_PREFIX.length) : null;
}

export interface PluginContext {
  envelope: HookEnvelope;
  settings: Record<string, string | boolean>;
  config: ConfigAdapter;
  fetch: typeof fetch;
  /** 生の TCP（SMTP でメールを送る送り手のため。無いランタイムもある） */
  socket?: SocketAdapter;
  /** 同梱プラグインはコアの一部なので service_role 経路（RPC）を使える。外部プラグインには無い */
  privileged: PrivilegedDb;
  /** サイトの秘密（ショップごとの秘密の暗号文を開く。src/members/secret-box.ts） */
  sessionSecret?: string;
}

export interface BundledPlugin {
  id: string;
  manifest: PluginManifest;
  /** 設定画面で「未設定」を警告する Secret 名（設定によって変わるなら関数。メール通知は MAIL_TRANSPORT で変わる） */
  requiredSecrets: string[] | ((config: ConfigAdapter) => string[]);
  /** 任意: Secret の値の形（接頭辞）。貼り間違い（sk_ と whsec_ の取り違え等）を管理画面で指摘する */
  secretFormats?: Record<string, { pattern: RegExp; hint: string }>;
  /** 任意: 決済事業者側に登録する Webhook（管理画面のプラグイン一覧に URL と購読イベントを表示する） */
  webhook?: { path: string; events: string[]; where: string };
  /** hooks を受け取る（manifest.events を購読）。失敗は throw（再送される） */
  handle?(ctx: PluginContext): Promise<void>;
}
