import type { Hono, MiddlewareHandler } from "hono";
import type { AppEnv } from "../../app";
import { createDbClient } from "../../db/client";
import { StorefrontData, type PublicShop } from "../../storefront/data";
import { SLUG_RE, type Ctx } from "../common";

/**
 * ショップごとの独自ドメイン（0015_shop_domain、docs/custom-domain.md）。
 *
 * - 独自ドメインへのアクセス（Host がショップの domain）: パスの前にスラッグを足して、いつものストアフロントのルートで処理する
 *   （https://shop.example.jp/p/tee → /<スラッグ>/p/tee）。API・Webhook・画像・/_oauth などはそのまま。
 * - 管理画面（/admin）はショップのドメインでは出さない: Banto 自身の URL（PUBLIC_BASE_URL）へ転送する（無ければ 404）。
 *   店主がドメインの DNS を握っているので、そこに運営者のログイン画面が出ると、そっくりの偽画面を置いて運営者を誘える
 *   （2026-10-18 のコード監査の§3「独自ドメイン上の /admin」）。運営者の入口は 1 つのオリジンに限る。
 * - Banto の URL のショップのページ（GET /<スラッグ>/...）: ショップに独自ドメインがあれば、そのドメインへ転送する。
 *   会員の Cookie・LINE / Google の戻り先がドメインごとなので、ショップの画面は 1 つのドメインにそろえる。
 *
 * Host を信じてよいか: Cloudflare ではそのホスト名がこの Worker に向いているときだけ届く。違うショップを名乗っても、
 * 見えるのはそのショップの公開ページだけで、Cookie はホストごとなので他のショップのログインには触れない。
 * 戻り先（redirect_uri 等）は Host ではなく DB の domain から組む（src/storefront/urls.ts）。
 */

/** ショップのドメインでもスラッグを足さないパス（Banto 全体のもの） */
const PASSTHROUGH = ["/api", "/media", "/health", "/_oauth"];
const PASSTHROUGH_FILES = new Set(["/robots.txt", "/sitemap.xml"]);
/**
 * Banto 自身のホストでだけ出すパス（運営者と連携の入口）。ショップのドメインでは 404。
 * 店主がドメインの DNS を握る構成で、AI 用トークンや決済事業者の Webhook が店主のサーバーへ向かないように（2026-10-25 の監査）
 */
const PLATFORM_ONLY = ["/mcp", "/api/v1", "/webhooks"];

/** Host を比べる形にそろえる（小文字・末尾のドットを落とす。`shop.example.jp.` も同じショップ） */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, "");
}

export function storefrontData(c: Ctx): StorefrontData | null {
  const cfg = c.get("adapters").config;
  const url = cfg.get("SUPABASE_URL");
  const anonKey = cfg.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) return null;
  return new StorefrontData(createDbClient({ url, anonKey, fetch: c.get("deps").fetch }), c.get("adapters").cache);
}

/** Banto 自身のホスト（ショップのドメインを探さない）。PUBLIC_BASE_URL・workers.dev・ローカル */
function isPlatformHost(c: Ctx, host: string): boolean {
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".workers.dev")) return true;
  const configured = c.get("adapters").config.get("PUBLIC_BASE_URL");
  if (!configured) return false;
  try {
    return normalizeHost(new URL(configured).hostname) === host;
  } catch {
    return false;
  }
}

function passthrough(path: string): boolean {
  return PASSTHROUGH_FILES.has(path) || PASSTHROUGH.some((p) => path === p || path.startsWith(`${p}/`));
}

function platformOnly(path: string): boolean {
  return PLATFORM_ONLY.some((p) => path === p || path.startsWith(`${p}/`));
}

function isAdminPath(path: string): boolean {
  return path === "/admin" || path.startsWith("/admin/");
}

/** このリクエストのホストがショップの独自ドメインなら、そのショップ（Banto 自身の URL なら DB を引かない） */
export async function hostShop(c: Ctx): Promise<PublicShop | null> {
  const host = normalizeHost(new URL(c.req.url).hostname);
  if (isPlatformHost(c, host)) return null;
  const sf = storefrontData(c);
  return sf ? sf.shopByDomain(host) : null;
}

/** 今のリクエストがショップの独自ドメインの上か */
export function onShopDomain(c: Ctx, shop: { domain?: string | null }): boolean {
  return Boolean(shop.domain) && normalizeHost(new URL(c.req.url).hostname) === shop.domain;
}

/**
 * 独自ドメインのショップを Banto の URL で開いたとき、同じページのドメイン側の URL（GET だけ使う）。
 * /<スラッグ>/... はスラッグを外す。それ以外（/api/shops/... 等）はパスのまま。
 */
export function domainUrlFor(c: Ctx, shop: { slug: string; domain?: string | null }): string | null {
  if (!shop.domain || onShopDomain(c, shop)) return null;
  const u = new URL(c.req.url);
  const prefix = `/${shop.slug}`;
  const path = u.pathname === prefix ? "/" : u.pathname.startsWith(`${prefix}/`) ? u.pathname.slice(prefix.length) : u.pathname;
  return `https://${shop.domain}${path}${u.search}`;
}

/** app.ts の最初のほうに置く。独自ドメインへのアクセスをストアフロントのルートへ振り分ける */
export function shopDomainRouting(app: Hono<AppEnv>): MiddlewareHandler<AppEnv> {
  const rewritten = new WeakSet<Request>();
  return async (c, next) => {
    if (rewritten.has(c.req.raw)) return next();
    const url = new URL(c.req.url);
    if (platformOnly(url.pathname)) {
      // 運営者と連携の入口はショップのドメインでは出さない
      return (await hostShop(c)) ? c.notFound() : next();
    }
    if (passthrough(url.pathname)) return next();
    const shop = await hostShop(c);
    if (!shop) return next();
    if (isAdminPath(url.pathname)) {
      // 運営者の入口はショップのドメインに置かない。開いた人は Banto 自身の URL へ（GET だけ。フォームの送信は転送しない）
      const configured = c.get("adapters").config.get("PUBLIC_BASE_URL");
      if (configured && (c.req.method === "GET" || c.req.method === "HEAD")) {
        try {
          return c.redirect(new URL(url.pathname + url.search, configured).toString(), 302);
        } catch {
          /* PUBLIC_BASE_URL が URL でなければ 404 */
        }
      }
      return c.notFound();
    }
    url.pathname = url.pathname === "/" ? `/${shop.slug}` : `/${shop.slug}${url.pathname}`;
    const method = c.req.method;
    const body = method === "GET" || method === "HEAD" ? undefined : await c.req.raw.arrayBuffer();
    const req = new Request(url.toString(), { method, headers: c.req.raw.headers, body, redirect: "manual" });
    rewritten.add(req);
    let ctx;
    try {
      ctx = c.executionCtx;
    } catch {
      ctx = undefined;
    }
    return app.fetch(req, c.env, ctx);
  };
}

/** GET /<スラッグ>/... を独自ドメインへ転送する（storefront の最初のミドルウェア） */
export const redirectToShopDomain: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
  const seg = new URL(c.req.url).pathname.split("/")[1] ?? "";
  if (!SLUG_RE.test(seg)) return next();
  const shop = (await storefrontData(c)?.shopBySlug(seg)) ?? null;
  const to = shop ? domainUrlFor(c, shop) : null;
  // 302: 運営者がドメインを外したとき、ブラウザに転送を覚えさせない（検索エンジンには canonical で伝える）
  return to ? c.redirect(to, 302) : next();
};
