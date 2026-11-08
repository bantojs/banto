/**
 * 最新リリースの確認（ARCHITECTURE.md「バージョニング」）。
 * GitHub Releases API を読むだけで、開発チームへ何も送らない（CLAUDE.md §1-9: テレメトリなし。
 * これは運営者のブラウザではなく Worker からの読み取りで、送るのは GitHub の公開 API へのリクエストのみ）。
 * 取得に失敗したら null を返し、表示しないだけで動作に影響させない。CacheAdapter で 1 時間キャッシュ。
 */
import type { CacheAdapter } from "../adapters/types";

export const RELEASES_URL = "https://api.github.com/repos/bantojs/banto/releases/latest";
export const RELEASES_CACHE_TTL = 60 * 60;

/** リリースの一覧（リンク先として許すのはこの下だけ） */
export const RELEASES_PAGE = "https://github.com/bantojs/banto/releases";
const RELEASE_PAGE_PREFIX = "https://github.com/bantojs/banto/";

export interface LatestRelease {
  version: string;
  url: string;
}

export function parseVersion(tag: string): [number, number, number] | null {
  const m = tag.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** a < b なら true */
export function isNewer(current: string, latest: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i]! > a[i]!) return true;
    if (b[i]! < a[i]!) return false;
  }
  return false;
}

export async function fetchLatestRelease(deps: { fetch: typeof fetch; cache: CacheAdapter }): Promise<LatestRelease | null> {
  const key = "release:latest";
  const hit = await deps.cache.get<LatestRelease | "none">(key);
  if (hit === "none") return null;
  if (hit) return hit;
  try {
    const res = await deps.fetch(RELEASES_URL, { headers: { Accept: "application/vnd.github+json", "User-Agent": "banto" } });
    if (!res.ok) {
      await deps.cache.set(key, "none", RELEASES_CACHE_TTL);
      return null;
    }
    const j = (await res.json()) as { tag_name?: string; html_url?: string };
    if (!j.tag_name || !parseVersion(j.tag_name)) {
      await deps.cache.set(key, "none", RELEASES_CACHE_TTL);
      return null;
    }
    // リンクにするのは Banto のリリースの URL だけ（応答をそのまま画面に出さない）
    const url = typeof j.html_url === "string" && j.html_url.startsWith(RELEASE_PAGE_PREFIX) ? j.html_url : RELEASES_PAGE;
    const release: LatestRelease = { version: j.tag_name.replace(/^v/, ""), url };
    await deps.cache.set(key, release, RELEASES_CACHE_TTL);
    return release;
  } catch {
    await deps.cache.set(key, "none", RELEASES_CACHE_TTL);
    return null;
  }
}
