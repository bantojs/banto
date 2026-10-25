/**
 * 外部プラグインのマニフェスト（docs/hooks.md）。登録 URL に GET して取得する。
 * 取得できなくても登録は可能（イベントは手動で選ぶ）。シークレット型の設定項目は受け付けない。
 */
import { readTextCapped } from "../util/read-capped";

export interface ManifestSetting {
  key: string;
  label: string;
  type: "text" | "boolean" | "select";
  options?: { value: string; label: string }[];
  required?: boolean;
  description?: string;
}

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  /** 購読したいイベント */
  events: string[];
  settings: ManifestSetting[];
  /** 管理画面に iframe で埋め込む独自画面（任意） */
  admin_url?: string;
}

const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function parseManifest(input: unknown): PluginManifest | null {
  if (!input || typeof input !== "object") return null;
  const m = input as Record<string, unknown>;
  if (typeof m["name"] !== "string" || !m["name"].trim()) return null;
  const events = Array.isArray(m["events"]) ? m["events"].filter((e): e is string => typeof e === "string" && /^[a-z_]+\.[a-z_]+$/.test(e)) : [];
  const settings: ManifestSetting[] = [];
  if (Array.isArray(m["settings"])) {
    for (const raw of m["settings"]) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as Record<string, unknown>;
      if (typeof s["key"] !== "string" || !KEY_RE.test(s["key"])) continue;
      const type = s["type"] === "boolean" || s["type"] === "select" ? s["type"] : "text";
      if (s["type"] === "secret" || s["type"] === "password") continue; // シークレットはプラグイン側で持つ
      const options = Array.isArray(s["options"])
        ? s["options"]
            .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === "object")
            .map((o) => ({ value: String(o["value"] ?? ""), label: String(o["label"] ?? o["value"] ?? "") }))
        : undefined;
      settings.push({
        key: s["key"],
        label: typeof s["label"] === "string" ? s["label"] : s["key"],
        type,
        ...(options ? { options } : {}),
        ...(s["required"] === true ? { required: true } : {}),
        ...(typeof s["description"] === "string" ? { description: s["description"] } : {}),
      });
      if (settings.length >= 30) break;
    }
  }
  const admin_url = typeof m["admin_url"] === "string" && /^https:\/\//.test(m["admin_url"]) ? m["admin_url"] : undefined;
  return {
    name: m["name"].trim().slice(0, 200),
    ...(typeof m["version"] === "string" ? { version: m["version"].slice(0, 50) } : {}),
    ...(typeof m["description"] === "string" ? { description: m["description"].slice(0, 1000) } : {}),
    events,
    settings,
    ...(admin_url ? { admin_url } : {}),
  };
}

export async function fetchManifest(url: string, doFetch: typeof fetch, timeoutMs = 8000): Promise<PluginManifest | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // リダイレクトは追わない（登録時に確かめた行き先以外へ出ない）。本文は 64KB まで
    const res = await doFetch(url, { headers: { Accept: "application/json", "User-Agent": "banto-hooks" }, signal: controller.signal, redirect: "manual" });
    if (!res.ok) return null;
    return parseManifest(JSON.parse(await readTextCapped(res, 64 * 1024)));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** マニフェストの宣言に沿ってフォーム値を settings に正規化する */
export function settingsFromForm(manifest: PluginManifest | null, form: Record<string, string>): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const s of manifest?.settings ?? []) {
    const raw = form[`setting_${s.key}`];
    if (s.type === "boolean") out[s.key] = raw === "on";
    else if (s.type === "select") out[s.key] = s.options?.some((o) => o.value === raw) ? (raw as string) : (s.options?.[0]?.value ?? "");
    // 制御文字（改行を含む）は落とす。値はメールの送信元などに使われる（2026-10-25 の監査）
    else out[s.key] = (raw ?? "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 1000);
  }
  return out;
}
