/**
 * ページ送りの位置（キーセット）を URL に載せる形。JSON を base64url にしただけで、署名はしない
 * （位置を偽っても、その人が読める行の別の場所が出るだけ。読む権限は DB の RLS が決める）。
 */
export function encodeCursor(value: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 形が違えば null（長すぎるもの・base64url でないもの・JSON のオブジェクトでないもの） */
export function decodeCursor(text: string): Record<string, unknown> | null {
  try {
    if (text.length > 500 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const v: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
