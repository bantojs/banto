import { Hono } from "hono";
import type { ShopEvent } from "./storefront/events";
import type { ShopAccess } from "./routes/admin/access";
import type { Adapters } from "./adapters/types";
import { storefront } from "./routes/storefront";
import { admin } from "./routes/admin";
import { api } from "./routes/api";
import { webhooks } from "./routes/webhooks";
import { media } from "./routes/media";
import { health } from "./routes/health";
import { shopDomainRouting } from "./routes/storefront/domain";
import { mcp } from "./routes/mcp";
import { apiV1 } from "./routes/api/v1";
import { BANTO_VERSION } from "./version";
import type { DbClient } from "./db/client";
import type { ApiService } from "./api/service";
import { resolveSessionSecret, type SessionData } from "./auth/session";
import { getLocale, setLocale, t } from "./i18n";
import { setTimeZone } from "./i18n/time";

/**
 * ランタイム非依存のアプリ本体（CLAUDE.md §1-1, §4）。
 * Cloudflare 固有の型や API はここに持ち込まない。Workers 向けの入口は src/index.ts、
 * 将来の Node 向け入口は src/entry/node.ts に置き、どちらも createApp() を呼ぶだけにする。
 */
export interface AppDeps {
  /** 外部 HTTP（Supabase 等）。テストで差し替える */
  fetch: typeof fetch;
}

export type AppEnv = {
  Bindings: Record<string, unknown>;
  Variables: {
    adapters: Adapters;
    deps: AppDeps;
    /** SESSION_SECRET、無ければ service_role キーからの導出値。どちらも無ければ undefined */
    sessionSecret?: string;
    /** requireOwner を通ったあとだけ入る */
    session?: SessionData;
    db?: DbClient;
    /** loadShop を通ったあとだけ入る（そのショップでの自分の役割と権限の項目、0024） */
    shopAccess?: ShopAccess;
    /** /api/v1 と /mcp: Bearer トークンで認証済みの ApiService */
    api?: ApiService;
    /** お店の画面で起きた出来事（src/storefront/events.ts）。同梱モジュールが <head> の口から外の形にする */
    shopEvents?: ShopEvent[];
  };
};

export { BANTO_VERSION };

function errorPage(): string {
  return `<!doctype html><html lang="${getLocale()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${t("error.title")}</title><style>body{font-family:system-ui,sans-serif;margin:3rem auto;max-width:36rem;padding:0 1rem;line-height:1.6}</style></head><body><h1>${t("error.title")}</h1><p>${t("error.body")}</p></body></html>`;
}

export function createApp(
  resolveAdapters: (bindings: Record<string, unknown>) => Adapters,
  deps: Partial<AppDeps> = {},
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const resolvedDeps: AppDeps = { fetch: deps.fetch ?? ((input, init) => fetch(input, init)) };

  app.use("*", async (c, next) => {
    const adapters = resolveAdapters(c.env);
    c.set("adapters", adapters);
    c.set("deps", resolvedDeps);
    c.set("sessionSecret", await resolveSessionSecret(adapters.config));
    setLocale(adapters.config.get("BANTO_LOCALE"));
    setTimeZone(adapters.config.get("BANTO_TIMEZONE"));
    await next();
  });

  // 共通のセキュリティヘッダ（監査 L 群、2026-10-18）。ルートが自分で付けたものは上書きしない（会員ページの Referrer-Policy: same-origin 等）
  app.use("*", async (c, next) => {
    await next();
    const h = c.res.headers;
    if (!h.has("X-Content-Type-Options")) h.set("X-Content-Type-Options", "nosniff");
    if (!h.has("Referrer-Policy")) h.set("Referrer-Policy", "strict-origin-when-cross-origin");
    // 管理画面は他のページに埋め込ませない（外部プラグインの画面を埋め込む側なので、埋め込まれる必要が無い）
    if (c.req.path.startsWith("/admin") && !h.has("X-Frame-Options")) {
      h.set("X-Frame-Options", "DENY");
      if (!h.has("Content-Security-Policy")) h.set("Content-Security-Policy", "frame-ancestors 'none'");
    }
    if (c.req.url.startsWith("https:") && !h.has("Strict-Transport-Security")) h.set("Strict-Transport-Security", "max-age=31536000");
  });

  // ショップごとの独自ドメイン（0015）: そのドメインへのアクセスをストアフロントのルートへ
  app.use("*", shopDomainRouting(app));

  // 予期しない例外: スタックや接続先の情報を外に出さない。ログには残す。
  app.onError((err, c) => {
    console.error(`[banto] ${c.req.method} ${c.req.path}:`, err);
    const path = c.req.path;
    if (path.startsWith("/api") || path.startsWith("/webhooks") || path.startsWith("/mcp")) return c.json({ error: "internal_error" }, 500);
    return c.html(errorPage(), 500);
  });

  app.route("/health", health);

  app.route("/admin", admin);
  app.route("/api/v1", apiV1);
  app.route("/api", api);
  app.route("/mcp", mcp);
  app.route("/webhooks", webhooks);
  app.route("/media", media);
  app.route("/", storefront);

  return app;
}
