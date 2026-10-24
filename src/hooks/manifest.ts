/**
 * 外部プラグインのマニフェスト（docs/hooks.md）。登録 URL に GET して取得する。
 * 取得できなくても登録は可能（イベントは手動で選ぶ）。シークレット型の設定項目は受け付けない。
 */
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
    const res = await doFetch(url, { headers: { Accept: "application/json", "User-Agent": "banto-hooks" }, signal: controller.signal });
    if (!res.ok) return null;
    return parseManifest(await res.json());
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
    else out[s.key] = (raw ?? "").slice(0, 1000);
  }
  return out;
}
