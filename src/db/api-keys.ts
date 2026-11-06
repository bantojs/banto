/**
 * Supabase の API キーの 2 つの形（メンテナの決定 2026-11-06、docs/env.md「Supabase のキー」）。
 * - 新しいキー: `sb_publishable_…`（今までの anon の代わり）と `sb_secret_…`（service_role の代わり）。JWT ではない。
 *   Supabase の入口が `apikey` の見出しだけを見て役割（anon / service_role）を決めるので、`Authorization: Bearer` には載せない
 *   （載せられるのは運営者のログインの JWT だけ）。Supabase は今までのキーを 2026 年末に廃止する予定
 * - 今までのキー（JWT、`eyJ…`）: `apikey` と `Authorization: Bearer` の両方に載せる。自前で立てた PostgREST + GoTrue（selfhost/）はこちらだけ
 * 環境変数の名前（SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY）は変えない。どちらの形の値も入れられる
 */

export type SupabaseKeyKind = "publishable" | "secret" | "legacy" | "unknown";

/** キーの形（値は見せない） */
export function supabaseKeyKind(key: string | undefined | null): SupabaseKeyKind {
  if (!key) return "unknown";
  if (key.startsWith("sb_publishable_")) return "publishable";
  if (key.startsWith("sb_secret_")) return "secret";
  if (/^eyJ[\w-]*\.[\w-]+\.[\w-]*$/.test(key)) return "legacy";
  return "unknown";
}

/** 今までの JWT のキーの役割（payload の role）。読めなければ null（署名は確かめない。取り違えに気づくためだけ） */
export function legacyKeyRole(key: string): string | null {
  const part = key.split(".")[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    const role = (JSON.parse(json) as { role?: unknown }).role;
    return typeof role === "string" ? role : null;
  } catch {
    return null;
  }
}

/**
 * Supabase に送る見出し。token は運営者のログインの JWT（無ければキーの役割で動く）。
 * 新しいキーは apikey だけ、今までのキーは Bearer にもキーを載せる（token があれば token）
 */
export function supabaseHeaders(key: string, token?: string | null): Record<string, string> {
  const kind = supabaseKeyKind(key);
  if (kind === "publishable" || kind === "secret") return token ? { apikey: key, Authorization: `Bearer ${token}` } : { apikey: key };
  return { apikey: key, Authorization: `Bearer ${token ?? key}` };
}

/**
 * 取り違え（公開側の欄に秘密のキー・秘密の欄に公開のキー）。秘密のキーを公開側に入れると RLS を通らずに読めてしまうので、
 * 見つけたら動かさない。問題の無いときは null
 */
export function supabaseKeyMisplaced(anonKey: string | undefined, serviceRoleKey: string | undefined): "SUPABASE_ANON_KEY" | "SUPABASE_SERVICE_ROLE_KEY" | null {
  if (anonKey) {
    const k = supabaseKeyKind(anonKey);
    if (k === "secret" || (k === "legacy" && legacyKeyRole(anonKey) === "service_role")) return "SUPABASE_ANON_KEY";
  }
  if (serviceRoleKey) {
    const k = supabaseKeyKind(serviceRoleKey);
    if (k === "publishable" || (k === "legacy" && legacyKeyRole(serviceRoleKey) === "anon")) return "SUPABASE_SERVICE_ROLE_KEY";
  }
  return null;
}
