import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { AccountPageProps, StoreView, Theme, ThemeContext } from "../types";
import { t, tf, type MessageKey, getLocale } from "../../i18n";
import { formatDateTime } from "../../i18n/time";
import { SKU_IMAGE_SCRIPT, imageOptionsOf, orderImagesForSku } from "../../products/images";
import { OPTION_AXES_SCRIPT, displayOptionAxes } from "../../products/option-axes";

/** パスキーのボタン（同梱モジュール passkey）。動きは `${shopPath}/account/passkey.js`（src/modules/passkey）が付ける */
function PasskeyButton({ ctx, kind, returnTo }: { ctx: ThemeContext; kind: "login" | "register"; returnTo?: string | undefined }) {
  return (
    <div data-banto-passkey-block>
      <p>
        <button type="button" data-banto-passkey={kind} data-return-to={returnTo}>
          {t(kind === "login" ? "passkey.login" : "passkey.add")}
        </button>
      </p>
      <p class="error" hidden data-banto-passkey-error data-msg-failed={t("passkey.failed")} data-msg-cancelled={t("passkey.cancelled")} data-msg-reauth={t("passkey.reauth")} />
      <script src={`${ctx.shopPath}/account/passkey.js`} defer />
    </div>
  );
}

const PROVIDER_LABELS = { line: "LINE", google: "Google" } as const;
import { imageUrl, responsiveImage } from "../../media/images";
import { jsonLdText, productJsonLd } from "../../storefront/structured-data";
import { yen } from "../../routes/common";
import { carrierLabel, trackingOf, trackingUrl } from "../../orders/tracking";
import { ConfirmationBlock } from "./confirmation";
import { pagePath, pagesNav } from "../../pages";
import { articlePath, blogPath, blogsNav } from "../../blog";

const css = `
:root{color-scheme:light dark;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Hiragino Sans","Noto Sans JP",sans-serif}
body{margin:0;background:Canvas;color:CanvasText;line-height:1.6}
header{display:flex;justify-content:space-between;align-items:center;padding:.75rem 1rem;border-bottom:1px solid color-mix(in srgb,CanvasText 15%,transparent)}
header a{text-decoration:none;color:inherit}header .brand{font-weight:700;font-size:1.1rem}
main{max-width:60rem;margin:0 auto;padding:1.5rem 1rem}
footer{max-width:60rem;margin:3rem auto 2rem;padding:0 1rem;font-size:.85rem;opacity:.8}footer a{margin-right:1rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:1.25rem}
.card{border:1px solid color-mix(in srgb,CanvasText 12%,transparent);border-radius:.5rem;overflow:hidden}
.msg{border:1px solid color-mix(in srgb,CanvasText 12%,transparent);border-radius:.5rem;padding:.25rem 1rem;margin:.75rem 0}
.card a{display:block;color:inherit;text-decoration:none}
.card .thumb{aspect-ratio:1/1;background:color-mix(in srgb,CanvasText 6%,transparent);display:flex;align-items:center;justify-content:center;overflow:hidden}
.card img{width:100%;height:100%;object-fit:cover}
.card .body{padding:.75rem}
.banto-products{margin:1.5rem 0}.banto-button{margin:1.25rem 0}
.banto-button__link{display:inline-block;padding:.65rem 1.5rem;border-radius:.4rem;background:var(--accent,#1f6feb);color:#fff!important;text-decoration:none;font-weight:600}
.price{font-weight:600}
.gallery img{max-width:100%;height:auto;max-height:32rem;object-fit:contain;display:block;margin-bottom:.5rem}
.product{display:grid;grid-template-columns:1fr 1fr;gap:2rem}@media(max-width:40rem){.product{grid-template-columns:1fr}}
label{display:block;margin:.75rem 0 .25rem}select,input[type=number]{font:inherit;padding:.4rem}
button{padding:.6rem 1.25rem;font:inherit;cursor:pointer}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.5rem;border-bottom:1px solid color-mix(in srgb,CanvasText 12%,transparent)}
.notice{padding:.75rem 1rem;border-left:4px solid #f9a825;background:color-mix(in srgb,#f9a825 12%,transparent);margin:1rem 0}
.error{color:#c62828}.muted{opacity:.7}
pre.legal{white-space:pre-wrap;font:inherit}
.blog-list{list-style:none;padding:0;margin:0;max-width:44rem}.blog-list li{padding:1.25rem 0;border-bottom:1px solid color-mix(in srgb,CanvasText 12%,transparent)}.blog-list h2{margin:.25rem 0}.blog-list a{text-decoration:none;color:inherit}.blog-list img{width:100%;max-height:16rem;object-fit:cover;border-radius:.5rem}.blog-meta{font-size:.85rem;color:color-mix(in srgb,CanvasText 60%,transparent)}.blog-tags a{margin-right:.5rem}
.page-body{max-width:44rem;line-height:1.8}.page-body img{max-width:100%;height:auto}.page-body blockquote{margin:1rem 0;padding-left:1rem;border-left:3px solid color-mix(in srgb,CanvasText 20%,transparent)}.banto-table{overflow-x:auto}
a{color:var(--accent,#1f6feb)}header a,.card a{color:inherit}
button{background:var(--accent,#1f6feb);color:#fff;border:0;border-radius:.3rem}button[disabled]{opacity:.5;cursor:not-allowed}
a.button{display:inline-block;padding:.6rem 1.25rem;background:var(--accent,#1f6feb);color:#fff;border-radius:.3rem;text-decoration:none}
.store{border-color:color-mix(in srgb,CanvasText 15%,transparent)!important}
.announcement{background:var(--accent,#1f6feb);color:#fff;text-align:center;padding:.4rem 1rem;font-size:.9rem}
.hero{padding:1.5rem 0 .5rem}.hero p{max-width:40rem;opacity:.85}
.card:hover{box-shadow:0 2px 12px color-mix(in srgb,CanvasText 15%,transparent)}
.tags{display:flex;flex-wrap:wrap;gap:.4rem}.tags a{padding:.15rem .6rem;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:1rem;text-decoration:none;font-size:.9rem}.tags a.active{background:var(--accent,#1f6feb);color:#fff;border-color:transparent}
.categories{display:flex;flex-wrap:wrap;gap:.25rem .9rem;margin:.5rem 0 1rem}.categories a{text-decoration:none}.categories a.active{font-weight:700}.categories a.sub{font-size:.9rem;margin-left:.5rem;opacity:.8}
table.attributes th{width:30%;font-weight:600}
.pager{display:flex;justify-content:space-between;gap:1rem;margin:2rem 0}
.thumbs{display:flex;gap:.5rem;flex-wrap:wrap}.thumbs img{width:4.5rem;height:4.5rem;object-fit:cover;border-radius:.25rem;border:1px solid color-mix(in srgb,CanvasText 15%,transparent)}
`;

/** SKU の表示名: 選択肢（サイズ / 色）があれば値を並べ、無ければ名前か品番 */
function skuLabel(s: { name: string | null; code: string; options?: Record<string, string | number> }): string {
  const values = Object.values(s.options ?? {});
  return values.length > 0 ? values.join(" / ") : (s.name ?? s.code);
}

interface Seo {
  /** ページの説明（160 文字程度） */
  description?: string;
  /** OG 画像の URL */
  image?: string;
  /** canonical のパス（shopPath からの相対ではなく絶対パス） */
  path?: string;
  /** 検索エンジンに載せないページ（カート・会員等） */
  noindex?: boolean;
  type?: "website" | "product";
  /** 構造化データ（JSON-LD）。src/storefront/structured-data.ts で組む */
  jsonLd?: unknown;
}

function themeSetting(ctx: ThemeContext | undefined, key: string): string | undefined {
  const v = ctx?.themeSettings?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function Layout(props: { title: string; ctx?: ThemeContext; seo?: Seo; refreshSeconds?: number; children?: Child }) {
  const { ctx, seo } = props;
  const fullTitle = ctx ? `${props.title} · ${ctx.shop.name}` : props.title;
  const description = seo?.description ?? themeSetting(ctx, "description") ?? (ctx ? ctx.shop.name : t("app.name"));
  const canonical = ctx?.publicBaseUrl && seo?.path ? `${ctx.publicBaseUrl}${seo.path}` : undefined;
  const accent = themeSetting(ctx, "accent_color") ?? "#1f6feb";
  const announcement = themeSetting(ctx, "announcement");
  const logo = themeSetting(ctx, "logo_url");
  return (
    <html lang={getLocale()}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{fullTitle}</title>
        <meta name="description" content={description.slice(0, 200)} />
        {props.refreshSeconds ? <meta http-equiv="refresh" content={String(props.refreshSeconds)} /> : null}
        {seo?.noindex ? <meta name="robots" content="noindex" /> : null}
        {canonical ? <link rel="canonical" href={canonical} /> : null}
        <meta property="og:title" content={fullTitle} />
        <meta property="og:description" content={description.slice(0, 200)} />
        <meta property="og:type" content={seo?.type === "product" ? "product" : "website"} />
        {ctx ? <meta property="og:site_name" content={ctx.shop.name} /> : null}
        {canonical ? <meta property="og:url" content={canonical} /> : null}
        {seo?.image ? <meta property="og:image" content={seo.image} /> : null}
        <meta name="twitter:card" content={seo?.image ? "summary_large_image" : "summary"} />
        {seo?.jsonLd ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(seo.jsonLd) }} /> : null}
        <style>{raw(css)}</style>
        <style>{`:root{--accent:${accent.replace(/[^#0-9a-zA-Z(),.% ]/g, "")}}`}</style>
      </head>
      <body>
        {announcement ? <div class="announcement">{announcement}</div> : null}
        <header>
          <a class="brand" href={ctx ? ctx.shopPath || "/" : "/"}>
            {logo ? <img src={logo} alt={ctx ? ctx.shop.name : ""} style="height:2rem;vertical-align:middle;margin-right:.5rem" /> : null}
            {ctx ? ctx.shop.name : t("app.name")}
          </a>
          {ctx ? (
            <span>
              {pagesNav(ctx.shop, "header").map((pg) => (
                <a href={pagePath(ctx.shopPath, pg.handle)} style="margin-right:1rem">
                  {pg.title}
                </a>
              ))}
              {blogsNav(ctx.shop, "header").map((b) => (
                <a href={blogPath(ctx.shopPath, b.handle)} style="margin-right:1rem">
                  {b.title}
                </a>
              ))}
              {ctx.membersEnabled ? (
                <a href={`${ctx.shopPath}/account`} style="margin-right:1rem">
                  {ctx.member ? t("member.account") : t("member.login")}
                </a>
              ) : null}
              <a href={`${ctx.shopPath}/cart`}>
                {t("store.cart")}
                {ctx.cartCount > 0 ? ` (${ctx.cartCount})` : ""}
              </a>
            </span>
          ) : null}
        </header>
        <main>{props.children}</main>
        <footer>
          {ctx ? (
            <p>
              {pagesNav(ctx.shop, "footer").map((pg) => (
                <a href={pagePath(ctx.shopPath, pg.handle)}>{pg.title}</a>
              ))}
              {blogsNav(ctx.shop, "footer").map((b) => (
                <a href={blogPath(ctx.shopPath, b.handle)}>{b.title}</a>
              ))}
              <a href={`${ctx.shopPath}/legal`}>{t("shop.legal_notice")}</a>
              <a href={`${ctx.shopPath}/privacy`}>{t("shop.privacy_policy")}</a>
              <a href={`${ctx.shopPath}/returns`}>{t("shop.return_policy")}</a>
              <a href={`${ctx.shopPath}/shipping`}>{t("store.shipping_title")}</a>
              <a href={`${ctx.shopPath}/orders/lookup`}>{t("store.lookup_title")}</a>
              {ctx.inquiries ? <a href={`${ctx.shopPath}/inquiries/new`}>{t("inq.title")}</a> : null}
            </p>
          ) : null}
          <p class="muted">{t("store.powered_by")}</p>
        </footer>
      </body>
    </html>
  );
}

/** 店舗の住所・営業時間・臨時休業（お店で試着と店舗一覧で使う） */
function StoreCard({ store, children }: { store: StoreView; children?: Child }) {
  return (
    <section class="store" style="border:1px solid;border-radius:6px;padding:.75rem 1rem;margin:.75rem 0">
      <h3 style="margin-top:0">{store.name}</h3>
      {store.address ? (
        <p>
          {store.postal_code ? `〒${store.postal_code} ` : ""}
          {store.address}
        </p>
      ) : null}
      {store.phone ? <p>{tf("tryon.phone", { phone: store.phone })}</p> : null}
      <p>
        <strong>{store.today}</strong>
      </p>
      <details>
        <summary>{t("tryon.hours")}</summary>
        <table>
          <tbody>
            {store.week.map((w) => (
              <tr>
                <th>{w.day}</th>
                <td>{w.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      {store.specials.length > 0 ? (
        <ul class="muted">
          {store.specials.map((d) => (
            <li>
              {d.date}: {d.text}
            </li>
          ))}
        </ul>
      ) : null}
      {store.note ? <p class="muted">{store.note}</p> : null}
      {children}
    </section>
  );
}

/**
 * 会員ページの中身（注文の一覧・住所・ログインの方法・クーポン・試着・ログアウト・退会）。既定のテーマの AccountPage と、
 * Liquid のテーマの会員ページ（{% banto_account %}、src/routes/storefront/liquid.ts）が同じものを使う。strict はインラインのスクリプトを使わない形
 */
export function AccountBody({ ctx, customer, orders, prefectures, flash, error, security, receipt, coupons, tryon, sessions, passkeys, consent, strict }: AccountPageProps & { strict?: boolean }) {
  const a = (customer?.default_address ?? {}) as Record<string, unknown>;
  const v = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  const field = (name: string, label: string, value: string, type = "text", required = true) => (
    <div>
      <label for={name}>{label}</label>
      <input id={name} type={type} name={name} value={value} required={required} style="width:100%;max-width:28rem;padding:.5rem;font:inherit;box-sizing:border-box" />
    </div>
  );
  return (
    <>
      <h1>{t("member.account")}</h1>
      <p class="muted">{ctx.member?.email}</p>
      {flash === "saved" ? <p class="notice">{t("shop.saved")}</p> : null}
      {flash === "logged_out_all" ? <p class="notice">{t("member.logged_out_all")}</p> : null}
      {flash === "password_saved" ? <p class="notice">{t("member.password_saved")}</p> : null}
      {flash === "oauth_linked" ? <p class="notice">{t("member.oauth_linked_done")}</p> : null}
      {flash === "oauth_unlinked" ? <p class="notice">{t("member.oauth_unlinked_done")}</p> : null}
      {flash === "coupon_claimed" ? <p class="notice">{t("claim.done")}</p> : null}
      {flash === "tryon_cancelled" ? <p class="notice">{t("member.tryon_cancelled")}</p> : null}
      {error ? <p class="error">{error}</p> : null}
      {coupons ? (
        <section>
          <h2>{t("member.coupons")}</h2>
          {coupons.length === 0 ? <p>{t("member.coupons_none")}</p> : null}
          {coupons.map((cp) => (
            <form method="post" action={`${ctx.shopPath}/cart/coupon`} style="margin:.5rem 0">
              <input type="hidden" name="code" value={cp.code} />
              <strong>{cp.name}</strong> <span class="muted">{cp.kind === "percent" ? `${cp.value}%` : cp.kind === "fixed" ? yen(cp.value) : t("store.coupon_free_shipping")}</span>{" "}
              {cp.expires_at ? <span class="muted">{tf("member.coupon_expires", { date: formatDateTime(cp.expires_at, { dateOnly: true }) })}</span> : null} <code>{cp.code}</code>{" "}
              <button type="submit">{t("member.coupon_use")}</button>
            </form>
          ))}
        </section>
      ) : null}
      {tryon && tryon.length > 0 ? (
        <section>
          <h2>{t("member.tryon")}</h2>
          <table>
            <thead>
              <tr>
                <th>{t("tryon.number")}</th>
                <th>{t("tryon.store")}</th>
                <th>{t("tryon.items")}</th>
                <th>{t("tryon.status")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tryon.map((r) => (
                <tr>
                  <td>{r.number}</td>
                  <td>{r.store_name}</td>
                  <td>{r.items.map((i) => `${i.name ?? ""}${i.sku ? ` / ${i.sku}` : ""} × ${i.qty}`).join("、")}</td>
                  <td>
                    {t(`tryon.status_${r.status}` as MessageKey)}
                    {r.status === "ready" && r.hold_label ? (
                      <>
                        <br />
                        <span class="muted">{tf("tryon.hold_until_short", { date: r.hold_label })}</span>
                      </>
                    ) : r.visit_label && (r.status === "requested" || r.status === "sent") ? (
                      <>
                        <br />
                        <span class="muted">{tf("tryon.visit_short", { date: r.visit_label })}</span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {r.cancellable ? (
                      <form method="post" action={`${ctx.shopPath}/account/tryon/${r.number}/cancel`}>
                        <button type="submit">{t("member.tryon_cancel")}</button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      <h2>{t("member.orders")}</h2>
      {ctx.inquiries ? (
        <p>
          <a href={`${ctx.shopPath}/inquiries`}>{t("inq.my_inquiries")}</a>
        </p>
      ) : null}
      {orders.length === 0 ? <p>{t("member.no_orders")}</p> : null}
      {orders.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t("store.lookup_number")}</th>
              <th>{t("order.date")}</th>
              <th>{t("store.total")}</th>
              <th>{t("order.status")}</th>
              {receipt ? <th></th> : null}
              {ctx.inquiries ? <th></th> : null}
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr>
                <td>{String(o["number"])}</td>
                <td>{formatDateTime(String(o["created_at"]), { dateOnly: true })}</td>
                <td>{yen(Number(o["total_jpy"]))}</td>
                <td>{t(`order.status.${String(o["status"])}` as MessageKey)}</td>
                {receipt ? (
                  <td>
                    {o["status"] === "paid" || o["status"] === "shipped" ? (
                      <a href={`${ctx.shopPath}/account/orders/${String(o["number"])}/receipt`} target="_blank" rel="noopener">
                        {t("receipt.link")}
                      </a>
                    ) : null}
                  </td>
                ) : null}
                {ctx.inquiries ? (
                  <td>
                    <a href={`${ctx.shopPath}/inquiries/new?order=${String(o["number"])}`}>{t("inq.about_order")}</a>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <h2>{t("member.address")}</h2>
      <form method="post" action={`${ctx.shopPath}/account/address`}>
        {field("customer_name", t("store.address_name"), customer?.name ?? v("name"))}
        {field("phone", t("store.address_phone"), v("phone"), "tel")}
        {field("postal_code", t("store.address_postal"), v("postal_code"))}
        <div>
          <label for="state">{t("store.address_state")}</label>
          <select id="state" name="state" required>
            <option value="">---</option>
            {prefectures.map((p) => (
              <option value={p} selected={v("state") === p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        {field("city", t("store.address_city"), v("city"))}
        {field("line1", t("store.address_line1"), v("line1"))}
        {field("line2", t("store.address_line2"), v("line2"), "text", false)}
        <p>
          <button type="submit">{t("shop.save")}</button>
        </p>
      </form>
      {consent ? (
        <form method="post" action={`${ctx.shopPath}/account/consent`}>
          <h2>{t("consent.title")}</h2>
          <label>
            <input type="checkbox" name="marketing_consent" value="1" checked={customer?.marketing_consent === true} /> {t("consent.checkbox")}
          </label>
          <p>
            <button type="submit">{t("shop.save")}</button>
          </p>
        </form>
      ) : null}
      {security && (security.password || security.providers.length > 0) ? (
        <div>
          <h2>{t("member.login_methods")}</h2>
          {security.password ? (
            <form method="post" action={`${ctx.shopPath}/account/password`}>
              <label for="new-password">{t("member.password_new")}</label>
              <input id="new-password" type="password" name="password" required minlength={8} maxlength={200} autocomplete="new-password" style="width:100%;max-width:28rem;padding:.5rem;font:inherit;box-sizing:border-box" />
              <p>
                <button type="submit">{t(security.hasPassword ? "member.password_change" : "member.password_set")}</button>
              </p>
            </form>
          ) : null}
          {security.providers.map((p) =>
            p.linked ? (
              <form method="post" action={`${ctx.shopPath}/account/oauth/${p.id}/unlink`}>
                {tf("member.oauth_linked", { name: PROVIDER_LABELS[p.id] })} <button type="submit">{t("member.oauth_unlink")}</button>
              </form>
            ) : (
              <form method="post" action={`${ctx.shopPath}/account/oauth/${p.id}/link`}>
                <button type="submit">{tf("member.oauth_link", { name: PROVIDER_LABELS[p.id] })}</button>
              </form>
            ),
          )}
        </div>
      ) : null}
      {sessions ? (
        <p>
          <a href={`${ctx.shopPath}/account/sessions`}>{t("member.sessions")}</a>
        </p>
      ) : null}
      {passkeys ? (
        <p>
          <a href={`${ctx.shopPath}/account/passkeys`}>{t("passkey.title")}</a>
        </p>
      ) : null}
      <form method="post" action={`${ctx.shopPath}/account/logout`} style="display:inline">
        <button type="submit">{t("nav.logout")}</button>
      </form>{" "}
      <form method="post" action={`${ctx.shopPath}/account/logout-all`} style="display:inline">
        <button type="submit">{t("member.logout_all")}</button>
      </form>{" "}
      {strict ? (
        // インラインのスクリプトを止めた画面（Liquid のテーマの会員ページ、CSP）では、確かめの欄を付ける
        <form method="post" action={`${ctx.shopPath}/account/delete`} style="display:inline">
          <label>
            <input type="checkbox" name="confirm" value="1" required /> {t("member.delete_confirm")}
          </label>{" "}
          <button type="submit">{t("member.delete")}</button>
        </form>
      ) : (
        <form method="post" action={`${ctx.shopPath}/account/delete`} style="display:inline" onsubmit={`return confirm(${JSON.stringify(t("member.delete_confirm"))})`}>
          <button type="submit">{t("member.delete")}</button>
        </form>
      )}
    </>
  );
}

export const defaultTheme: Theme = {
  ShopIndex({ shops }) {
    return (
      <Layout title={t("app.name")}>
        <h1>{t("store.shops")}</h1>
        {shops.length === 0 ? <p>{t("store.no_shops")}</p> : null}
        <ul>
          {shops.map((s) => (
            <li>
              <a href={`/${s.slug}`}>{s.name}</a>
            </li>
          ))}
        </ul>
      </Layout>
    );
  },

  ShopHome({ ctx, products, tag, tags, categories, category, pagination, notice }) {
    const intro = themeSetting(ctx, "description");
    const home = ctx.shopPath || "/";
    const heading = category ? category.name : tag;
    return (
      <Layout
        title={heading ? `${heading} · ${t("store.products")}` : t("store.products")}
        ctx={ctx}
        seo={{ path: category ? `${home}?category=${encodeURIComponent(category.slug)}` : tag ? `${home}?tag=${encodeURIComponent(tag)}` : home, description: intro, image: products.find((p) => p.image)?.image ? imageUrl(ctx.mediaBaseUrl, products.find((p) => p.image)!.image!.storage_key) : undefined, ...(pagination?.first ? { noindex: true } : {}) }}
      >
        <div class="hero">
          <h1>{ctx.shop.name}</h1>
          {intro ? <p>{intro}</p> : null}
        </div>
        {categories && categories.length > 0 ? (
          <nav class="categories" aria-label={t("store.categories")}>
            <a href={home} class={category ? "" : "active"}>
              {t("store.all_products")}
            </a>
            {categories.map((n) => (
              <span>
                <a href={`${home}?category=${encodeURIComponent(n.slug)}`} class={category?.slug === n.slug ? "active" : ""}>
                  {n.name}
                </a>
                {n.children.map((ch) => (
                  <a href={`${home}?category=${encodeURIComponent(ch.slug)}`} class={category?.slug === ch.slug ? "active sub" : "sub"}>
                    {ch.name}
                  </a>
                ))}
              </span>
            ))}
          </nav>
        ) : null}
        {category ? <h2>{category.name}</h2> : null}
        {tags && tags.length > 0 ? (
          <p class="tags">
            <a href={home} class={tag ? "" : "active"}>
              {t("store.all_products")}
            </a>
            {tags.map((x) => (
              <a href={`${home}?tag=${encodeURIComponent(x.tag)}`} class={x.tag === tag ? "active" : ""}>
                {x.tag} <span class="muted">({x.count})</span>
              </a>
            ))}
          </p>
        ) : null}
        {notice ? <p class="notice">{notice}</p> : products.length === 0 ? <p>{t("store.no_products")}</p> : null}
        <div class="grid">
          {products.map(({ product, image, minPrice, compareAt }) => (
            <div class="card">
              <a href={`${ctx.shopPath}/p/${product.slug}`}>
                <div class="thumb">{image ? <img {...responsiveImage(ctx.mediaBaseUrl, image)} alt={product.name} loading="lazy" decoding="async" /> : null}</div>
                <div class="body">
                  <div>{product.name}</div>
                  {product.brand ? <div class="muted">{product.brand}</div> : null}
                  {minPrice !== null ? (
                    <div class="price">
                      {compareAt ? <s class="muted">{yen(compareAt)}</s> : null} {yen(minPrice)}〜 <span class="muted">{t("store.tax_included")}</span>
                    </div>
                  ) : null}
                </div>
              </a>
            </div>
          ))}
        </div>
        {pagination?.next || pagination?.first ? (
          <nav class="pager" aria-label={t("store.pagination")}>
            {pagination.first ? <a href={pagination.first}>{t("store.first_page")}</a> : null}
            {pagination.next ? (
              <a href={pagination.next} rel="next">
                {t("store.next_page")}
              </a>
            ) : null}
          </nav>
        ) : null}
      </Layout>
    );
  },

  ProductPage({ ctx, detail, added, selectedSku, categoryPath, attributes }) {
    const { product, skus } = detail;
    const inStock = skus.filter((s) => s.available > 0);
    // SKU ごとの画像（0063）: ?sku= で選んだ SKU に結んだ画像を先頭に（スクリプトは選び直したときに同じ規則で並べ替える）
    const chosen = skus.find((s) => s.code === selectedSku) ?? null;
    const images = orderImagesForSku(detail.images, chosen?.options);
    const skuImages = detail.images.some((img) => Object.keys(imageOptionsOf(img.options)).length > 0);
    // SKU を分ける軸（0065）: 軸ごとの選択欄にする（スクリプト。無ければ下の 1 つの選択欄のまま）。軸を決めていない商品は SKU の項目から推す
    const axes = skus.length > 1 ? displayOptionAxes(product.option_axes, skus) : [];
    const axesOn = axes.length > 0;
    const first = images[0];
    return (
      <Layout
        title={product.name}
        ctx={ctx}
        seo={{
          path: `${ctx.shopPath}/p/${product.slug}`,
          type: "product",
          description: product.description ?? undefined,
          image: first ? imageUrl(ctx.mediaBaseUrl, first.storage_key) : undefined,
          jsonLd: ctx.publicBaseUrl
            ? productJsonLd({
                url: `${ctx.publicBaseUrl}${ctx.shopPath}/p/${product.slug}`,
                product,
                images: images.map((img) => imageUrl(ctx.mediaBaseUrl, img.storage_key)),
                skus,
                category: (categoryPath ?? []).map((cat) => cat.name),
              })
            : undefined,
        }}
      >
        <p>
          <a href={ctx.shopPath || "/"}>{ctx.shop.name}</a> ›{" "}
          {(categoryPath ?? []).map((cat) => (
            <span>
              <a href={`${ctx.shopPath || "/"}?category=${encodeURIComponent(cat.slug)}`}>{cat.name}</a> ›{" "}
            </span>
          ))}
          {product.name}
        </p>
        <div class="product">
          <div class="gallery" data-sku-images={skuImages ? "" : undefined}>
            {first ? <img src={imageUrl(ctx.mediaBaseUrl, first.storage_key)} width={first.width ?? undefined} height={first.height ?? undefined} alt={product.name} fetchpriority="high" decoding="async" data-main="" /> : null}
            {images.length > 1 ? (
              <div class="thumbs">
                {images.map((img) => (
                  <a
                    href={imageUrl(ctx.mediaBaseUrl, img.storage_key)}
                    target="_blank"
                    rel="noopener"
                    {...(skuImages ? { "data-image-options": JSON.stringify(imageOptionsOf(img.options)), "data-index": String(detail.images.indexOf(img)), "data-src": imageUrl(ctx.mediaBaseUrl, img.storage_key) } : {})}
                  >
                    <img src={imageUrl(ctx.mediaBaseUrl, img.thumb_key ?? img.storage_key)} alt="" loading="lazy" decoding="async" />
                  </a>
                ))}
              </div>
            ) : null}
          </div>
          <div>
            {product.brand ? <p class="muted">{product.brand}</p> : null}
            <h1>{product.name}</h1>
            {added ? (
              <p class="notice">
                {t("store.added")} <a href={`${ctx.shopPath}/cart`}>{t("store.view_cart")}</a>
              </p>
            ) : null}
            {product.description ? <pre class="legal">{product.description}</pre> : null}
            {attributes && attributes.length > 0 ? (
              <table class="attributes">
                <tbody>
                  {attributes.map((a) => (
                    <tr>
                      <th>{a.label}</th>
                      <td>{String(a.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {(product.tags ?? []).length > 0 ? (
              <p class="tags">
                {(product.tags ?? []).map((x) => (
                  <a href={`${ctx.shopPath || "/"}?tag=${encodeURIComponent(x)}`}>{x}</a>
                ))}
              </p>
            ) : null}
            {skus.length === 0 ? <p class="muted">{t("store.unavailable")}</p> : null}
            {skus.length > 0 ? (
              <form method="post" action={`${ctx.shopPath}/cart/add`} {...(axesOn ? { "data-axes": JSON.stringify(axes.map((a) => ({ key: a.key }))) } : {})}>
                <label for="sku_id">{t("store.variant")}</label>
                <select id="sku_id" name="sku_id" required>
                  {skus.map((s) => (
                    <option value={s.id} disabled={s.available <= 0} selected={chosen?.id === s.id} {...(skuImages || axesOn ? { "data-options": JSON.stringify(s.options ?? {}), "data-code": s.code } : {})}>
                      {skuLabel(s)} — {s.compare_at_price_jpy ? `${t("store.regular_price")} ${yen(s.compare_at_price_jpy)} → ` : ""}
                      {yen(s.price_jpy)}
                      {s.available <= 0 ? ` (${t("store.sold_out")})` : s.available <= 5 ? ` (${t("store.low_stock")})` : ""}
                    </option>
                  ))}
                </select>
                {axesOn ? <p data-axes-price="" aria-live="polite"></p> : null}
                <label for="qty">{t("store.qty")}</label>
                <input id="qty" type="number" name="qty" value="1" min={1} max={99} />
                <p>
                  <button type="submit" disabled={inStock.length === 0}>
                    {inStock.length === 0 ? t("store.sold_out") : t("store.add_to_cart")}
                  </button>
                </p>
              </form>
            ) : null}
            {skuImages && skus.length > 1 ? <script dangerouslySetInnerHTML={{ __html: SKU_IMAGE_SCRIPT }} /> : null}
            {axesOn ? <script dangerouslySetInnerHTML={{ __html: OPTION_AXES_SCRIPT }} /> : null}
          </div>
        </div>
      </Layout>
    );
  },

  CartPage({ ctx, lines, total, payments, shipping, coupons, error, tryon }) {
    const checkoutEnabled = payments.stripe || payments.komoju;
    const short = lines.some((l) => l.short);
    return (
      <Layout title={t("store.cart")} ctx={ctx} seo={{ noindex: true }}>
        <h1>{t("store.cart")}</h1>
        {error ? <p class="error">{error}</p> : null}
        {lines.length === 0 ? (
          <p>
            {t("store.cart_empty")} <a href={ctx.shopPath || "/"}>{t("store.continue")}</a>
          </p>
        ) : (
          <div>
            <table>
              <thead>
                <tr>
                  <th>{t("store.item")}</th>
                  <th>{t("store.unit_price")}</th>
                  <th>{t("store.qty")}</th>
                  <th>{t("store.subtotal")}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr>
                    <td>
                      <a href={`${ctx.shopPath}/p/${l.product.slug}`}>{l.product.name}</a>
                      {l.sku.name ? <span class="muted"> / {l.sku.name}</span> : null}
                      {l.short ? (
                        <div class="error">
                          {t("store.short_stock")} ({l.sku.available})
                        </div>
                      ) : null}
                    </td>
                    <td>{yen(l.sku.price_jpy)}</td>
                    <td>
                      <form method="post" action={`${ctx.shopPath}/cart/update`} style="display:inline">
                        <input type="hidden" name="sku_id" value={l.sku.id} />
                        <input type="number" name="qty" value={String(l.qty)} min={0} max={99} style="width:4rem" />{" "}
                        <button type="submit">{t("store.update")}</button>
                      </form>
                    </td>
                    <td>{yen(l.sku.price_jpy * l.qty)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colspan={3}>{t("store.subtotal_tax_included")}</th>
                  <th>{yen(total)}</th>
                </tr>
                {coupons && coupons.applied.length > 0 ? (
                  <>
                    {coupons.applied.map((a) => (
                      <tr>
                        <td colspan={3}>
                          {t("store.coupon_discount")}（{a.code} {a.name}）
                        </td>
                        <td>{a.free_shipping ? t("store.coupon_free_shipping") : `−${yen(a.amount_jpy)}`}</td>
                      </tr>
                    ))}
                    <tr>
                      <th colspan={3}>{t("store.total_after_discount")}</th>
                      <th>{yen(total - coupons.discount)}</th>
                    </tr>
                  </>
                ) : null}
              </tfoot>
            </table>
            {coupons ? (
              <div>
                <h2>{t("store.coupon_title")}</h2>
                {coupons.rejected.map((r) => (
                  <div class="error" style="margin:.5rem 0">
                    {r.code}: {r.message}{" "}
                    <form method="post" action={`${ctx.shopPath}/cart/coupon`} style="display:inline">
                      <input type="hidden" name="remove" value={r.code} />
                      <button type="submit">{t("store.coupon_remove")}</button>
                    </form>
                  </div>
                ))}
                {coupons.applied.map((a) => (
                  <div style="margin:.5rem 0">
                    ✓ {a.code} {a.name}{" "}
                    <form method="post" action={`${ctx.shopPath}/cart/coupon`} style="display:inline">
                      <input type="hidden" name="remove" value={a.code} />
                      <button type="submit">{t("store.coupon_remove")}</button>
                    </form>
                  </div>
                ))}
                <form method="post" action={`${ctx.shopPath}/cart/coupon`}>
                  <label for="coupon-code">{t("store.coupon_code")}</label>{" "}
                  <input id="coupon-code" type="text" name="code" maxlength={32} autocomplete="off" style="text-transform:uppercase" />{" "}
                  <button type="submit">{t("store.coupon_apply")}</button>
                </form>
                {coupons.applied.some((a) => a.free_shipping) ? <p class="muted">{t("store.coupon_shipping_note")}</p> : null}
              </div>
            ) : null}
            <p class="muted">
              {shipping.summary}
              {shipping.freeOver !== null ? `（${yen(shipping.freeOver)}以上で送料無料）` : ""} · <a href={`${ctx.shopPath}/shipping`}>{t("store.shipping_details")}</a>
            </p>
            {checkoutEnabled ? (
              <div>
                {payments.stripe ? (
                  <form method="post" action={`${ctx.shopPath}/checkout`} style="display:inline-block;margin-right:.5rem">
                    <input type="hidden" name="provider" value="stripe" />
                    <p>
                      <button type="submit" disabled={short}>
                        {payments.komoju ? t("store.pay_with_stripe") : t("store.checkout")}
                      </button>
                    </p>
                  </form>
                ) : null}
                {payments.komoju ? (
                  <form method="post" action={`${ctx.shopPath}/checkout`} style="display:inline-block">
                    <input type="hidden" name="provider" value="komoju" />
                    <p>
                      <button type="submit" disabled={short}>
                        {t("store.pay_with_komoju")}
                      </button>
                    </p>
                  </form>
                ) : null}
              </div>
            ) : tryon ? null : (
              <p class="notice">{t("store.checkout_unavailable")}</p>
            )}
            {tryon ? (
              <p>
                <a class="button" href={`${ctx.shopPath}/tryon`}>
                  {t("tryon.cart_button")}
                </a>{" "}
                <span class="muted">{t("tryon.cart_hint")}</span>
              </p>
            ) : null}
            <p>
              <a href={ctx.shopPath || "/"}>{t("store.continue")}</a>
            </p>
          </div>
        )}
      </Layout>
    );
  },

  LegalPage({ ctx, title, body }) {
    return (
      <Layout title={title} ctx={ctx} seo={{ path: undefined }}>
        <h1>{title}</h1>
        <pre class="legal">{body}</pre>
      </Layout>
    );
  },

  ContentPage({ ctx, page, html }) {
    return (
      <Layout title={page.seo_title || page.title} ctx={ctx} seo={{ path: pagePath(ctx.shopPath, page.handle), ...(page.seo_description ? { description: page.seo_description } : {}), ...(page.image_url ? { image: page.image_url } : {}) }}>
        <article class="page">
          <h1>{page.title}</h1>
          {page.image_url ? <img class="page-image" src={page.image_url} alt="" decoding="async" style="width:100%;height:auto;border-radius:.5rem;margin:0 0 1.5rem" /> : null}
          <div class="page-body">{raw(html)}</div>
        </article>
      </Layout>
    );
  },

  BlogPage({ ctx, blog, articles, tag, tags, newer, older, feedUrl }) {
    const title = tag ? tf("blog.tagged", { tag }) : blog.title;
    return (
      <Layout title={tag ? `${title} | ${blog.title}` : blog.seo_title || blog.title} ctx={ctx} seo={{ path: blogPath(ctx.shopPath, blog.handle), ...(blog.seo_description || blog.description ? { description: blog.seo_description || blog.description || "" } : {}), ...(tag ? { noindex: true } : {}) }}>
        <link rel="alternate" type="application/atom+xml" title={blog.title} href={feedUrl} />
        <h1>{title}</h1>
        {blog.description && !tag ? <p style="max-width:44rem">{blog.description}</p> : null}
        {tags.length > 0 ? (
          <p class="blog-tags">
            {tag ? <a href={blogPath(ctx.shopPath, blog.handle)}>{t("blog.all_articles")}</a> : null}
            {tags.map((x) => (
              <a href={`${blogPath(ctx.shopPath, blog.handle)}?tag=${encodeURIComponent(x)}`} aria-current={x === tag ? "page" : undefined}>
                #{x}
              </a>
            ))}
          </p>
        ) : null}
        {articles.length === 0 ? <p>{t("blog.no_published")}</p> : null}
        <ul class="blog-list">
          {articles.map(({ article, summary }) => (
            <li>
              <a href={articlePath(ctx.shopPath, blog.handle, article.handle)}>
                {article.image_url ? <img src={article.image_url} alt="" loading="lazy" decoding="async" /> : null}
                <div class="blog-meta">{article.published_at ? formatDateTime(article.published_at, { dateOnly: true }) : null}</div>
                <h2>{article.title}</h2>
                {summary ? <p>{summary}</p> : null}
              </a>
            </li>
          ))}
        </ul>
        {newer || older ? (
          <nav class="pager" aria-label={t("store.pagination")}>
            {newer ? <a href={newer}>{t("blog.newer")}</a> : <span />}
            {older ? (
              <a href={older} rel="next">
                {t("blog.older")}
              </a>
            ) : null}
          </nav>
        ) : null}
        <p class="blog-meta">
          <a href={feedUrl}>{t("blog.feed")}</a>
        </p>
      </Layout>
    );
  },

  ArticlePage({ ctx, blog, article, html, feedUrl }) {
    return (
      <Layout title={article.seo_title || article.title} ctx={ctx} seo={{ path: articlePath(ctx.shopPath, blog.handle, article.handle), ...(article.seo_description || article.excerpt ? { description: article.seo_description || article.excerpt || "" } : {}), ...(article.image_url ? { image: article.image_url } : {}) }}>
        <link rel="alternate" type="application/atom+xml" title={blog.title} href={feedUrl} />
        <article class="page">
          <p class="blog-meta">
            <a href={blogPath(ctx.shopPath, blog.handle)}>{blog.title}</a>
            {article.published_at ? <> · {formatDateTime(article.published_at, { dateOnly: true })}</> : null}
            {article.author ? <> · {article.author}</> : null}
          </p>
          <h1>{article.title}</h1>
          {article.image_url ? <img class="page-image" src={article.image_url} alt="" decoding="async" style="width:100%;height:auto;border-radius:.5rem;margin:0 0 1.5rem" /> : null}
          <div class="page-body">{raw(html)}</div>
          {article.tags.length > 0 ? (
            <p class="blog-tags">
              {article.tags.map((x) => (
                <a href={`${blogPath(ctx.shopPath, blog.handle)}?tag=${encodeURIComponent(x)}`}>#{x}</a>
              ))}
            </p>
          ) : null}
        </article>
      </Layout>
    );
  },

  AddressPage({ ctx, provider, values, prefectures, shipping, subtotal, error, delivery, consent }) {
    const field = (name: keyof typeof values, label: string, type = "text", required = true, autocomplete?: string) => (
      <div>
        <label for={name}>{label}</label>
        <input id={name} type={type} name={name} value={values[name] ?? ""} required={required} autocomplete={autocomplete} style="width:100%;max-width:28rem;padding:.5rem;font:inherit;box-sizing:border-box" />
      </div>
    );
    return (
      <Layout title={t("store.address_title")} ctx={ctx} seo={{ noindex: true }}>
        <h1>{t("store.address_title")}</h1>
        <p>{t("store.address_intro")}</p>
        <p class="muted">
          {t("store.subtotal_tax_included")}: {yen(subtotal)} · {shipping.summary}
          {shipping.freeOver !== null && subtotal >= shipping.freeOver ? `（${t("store.free_shipping_applied")}）` : ""}
        </p>
        {error ? <p class="error">{error}</p> : null}
        <form method="post" action={`${ctx.shopPath}/checkout/${provider}`}>
          {field("customer_name", t("store.address_name"), "text", true, "name")}
          {field("customer_email", t("store.address_email"), "email", true, "email")}
          {field("phone", t("store.address_phone"), "tel", true, "tel")}
          {field("postal_code", t("store.address_postal"), "text", true, "postal-code")}
          <div>
            <label for="state">{t("store.address_state")}</label>
            <select id="state" name="state" required autocomplete="address-level1">
              <option value="">---</option>
              {prefectures.map((p) => (
                <option value={p} selected={values.state === p}>
                  {p}
                  {shipping.table ? `（送料 ${yen(shipping.table.find((x) => x.prefecture === p)?.fee ?? 0)}）` : ""}
                </option>
              ))}
            </select>
          </div>
          {field("city", t("store.address_city"), "text", true, "address-level2")}
          {field("line1", t("store.address_line1"), "text", true, "address-line1")}
          {field("line2", t("store.address_line2"), "text", false, "address-line2")}
          {delivery ? (
            <div>
              <label for="delivery_date">{t("delivery.date")}</label>
              <select id="delivery_date" name="delivery_date">
                <option value="">{t("delivery.none")}</option>
                {delivery.dates.map((d) => (
                  <option value={d.value} selected={values.delivery_date === d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
              {delivery.slots.length > 0 ? (
                <div>
                  <label for="delivery_slot">{t("delivery.slot")}</label>
                  <select id="delivery_slot" name="delivery_slot">
                    <option value="">{t("delivery.none")}</option>
                    {delivery.slots.map((sl) => (
                      <option value={sl.value} selected={values.delivery_slot === sl.value}>
                        {sl.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <p class="muted">{t("delivery.note")}</p>
            </div>
          ) : null}
          <p>
            {consent ? (
              <p>
                <label>
                  <input type="checkbox" name="marketing_consent" value="1" checked={values.marketing_consent === "1"} /> {t("consent.checkbox")}
                </label>
              </p>
            ) : null}
            <button type="submit">{t("store.address_submit")}</button>
          </p>
        </form>
      </Layout>
    );
  },

  ConfirmPage({ ctx, confirmation: cf, quote, error }) {
    return (
      <Layout title={t("confirm.title")} ctx={ctx} seo={{ noindex: true }}>
        <h1>{t("confirm.title")}</h1>
        <ConfirmationBlock shopPath={ctx.shopPath} confirmation={cf} quote={quote} {...(error ? { error } : {})} />
      </Layout>
    );
  },

  ShippingPage({ ctx, shipping, payments }) {
    return (
      <Layout title={t("store.shipping_title")} ctx={ctx}>
        <h1>{t("store.shipping_title")}</h1>
        <p>{shipping.summary}</p>
        {shipping.freeOver !== null ? <p>{`${yen(shipping.freeOver)}以上のご注文で送料無料`}</p> : null}
        {shipping.table ? (
          <table>
            <tbody>
              {shipping.table.map((row) => (
                <tr>
                  <td>{row.prefecture}</td>
                  <td>{yen(row.fee)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <p class="muted">{t("store.tax_note").replace("{rate}", String(shipping.taxRate))}</p>
        <h2>{t("store.payment_methods")}</h2>
        <ul>
          {payments.stripe ? <li>{t("store.pay_with_stripe")}</li> : null}
          {payments.komoju ? <li>{t("store.pay_with_komoju")}</li> : null}
          {!payments.stripe && !payments.komoju ? <li>{t("store.checkout_unavailable")}</li> : null}
        </ul>
      </Layout>
    );
  },

  MemberAuthPage({ ctx, mode, error, info, email, challenge, token, options, returnTo, ticket }) {
    const input = "width:100%;max-width:28rem;padding:.5rem;font:inherit;box-sizing:border-box";
    const titles = { login: "member.login_title", code: "member.code_title", verify: "member.verify_title", passkey: "member.login_title", passkey_add: "passkey.add_title", passkey_register: "passkey.add_title" } as const;
    const title = t(titles[mode]);
    let body: Child;
    if (mode === "passkey_add") {
      body = ticket ? (
        <form method="post" action={`${ctx.shopPath}/account/passkey/add`}>
          <p>{t("passkey.add_intro")}</p>
          <input type="hidden" name="t" value={ticket} />
          <input type="hidden" name="return_to" value={returnTo ?? ""} />
          <p>
            <button type="submit">{t("passkey.add_continue")}</button>
          </p>
        </form>
      ) : (
        <p>{returnTo ? <a href={returnTo}>{t("passkey.add_back")}</a> : null}</p>
      );
    } else if (mode === "passkey_register") {
      body = (
        <div>
          <p>{t("passkey.add_ready")}</p>
          <PasskeyButton ctx={ctx} kind="register" returnTo={returnTo} />
          <p class="muted">{returnTo ? <a href={returnTo}>{t("passkey.add_back")}</a> : null}</p>
        </div>
      );
    } else if (mode === "passkey") {
      body = (
        <div>
          <PasskeyButton ctx={ctx} kind="login" returnTo={returnTo} />
          <p class="muted">{t("passkey.headless_note")}</p>
        </div>
      );
    } else if (mode === "login") {
      body = (
        <div>
          {options?.passkey ? <PasskeyButton ctx={ctx} kind="login" /> : null}
          {(options?.providers ?? []).map((p) => (
            <p>
              <a
                href={`${ctx.shopPath}/account/oauth/${p}`}
                style={`display:inline-block;padding:.6rem 1.2rem;text-decoration:none;border-radius:4px;font-weight:bold;${p === "line" ? "background:#06c755;color:#fff" : "background:#fff;color:#1f1f1f;border:1px solid #747775"}`}
              >
                {tf("member.oauth_login", { name: PROVIDER_LABELS[p] })}
              </a>
            </p>
          ))}
          {options?.password ? (
            <form method="post" action={`${ctx.shopPath}/account/password-login`}>
              <label for="pw-email">{t("store.address_email")}</label>
              <input id="pw-email" type="email" name="email" value={email ?? ""} required autocomplete="username" style={input} />
              <label for="pw">{t("member.password")}</label>
              <input id="pw" type="password" name="password" required autocomplete="current-password" style={input} />
              <p>
                <button type="submit">{t("member.password_login")}</button>
              </p>
              <p class="muted">{t("member.or_code")}</p>
            </form>
          ) : null}
          <p>{t("member.login_intro")}</p>
          <form method="post" action={`${ctx.shopPath}/account/login`}>
            <label for="email">{t("store.address_email")}</label>
            <input id="email" type="email" name="email" value={email ?? ""} required autocomplete="email" style={input} />
            <p>
              <button type="submit">{t("member.send_code")}</button>
            </p>
          </form>
          <p class="muted">
            {t("member.login_first_time")} <a href={`${ctx.shopPath}/privacy`}>{t("member.privacy_link")}</a>
          </p>
          {ctx.inquiries ? (
            <p class="muted">
              {t("inq.login_trouble")} <a href={`${ctx.shopPath}/inquiries/new?category=account`}>{t("inq.title")}</a>
            </p>
          ) : null}
        </div>
      );
    } else if (mode === "code") {
      body = (
        <div>
          <p>{tf("member.code_intro", { email: email ?? "" })}</p>
          <form method="post" action={`${ctx.shopPath}/account/code`}>
            <label for="code">{t("member.code")}</label>
            <input id="code" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,8}" maxlength={8} required style={input} />
            <p>
              <button type="submit">{t("member.code_submit")}</button>
            </p>
          </form>
          <p class="muted">{t("member.code_note")}</p>
          <p>
            <a href={`${ctx.shopPath}/account/login`}>{t("member.resend")}</a>
          </p>
          {ctx.inquiries ? (
            <p class="muted">
              {t("inq.code_trouble")} <a href={`${ctx.shopPath}/inquiries/new?category=account`}>{t("inq.title")}</a>
            </p>
          ) : null}
        </div>
      );
    } else {
      body = (
        <div>
          <p>{tf("member.verify_intro", { email: email ?? "" })}</p>
          <form method="post" action={`${ctx.shopPath}/account/verify`}>
            <input type="hidden" name="c" value={challenge ?? ""} />
            <input type="hidden" name="t" value={token ?? ""} />
            <p>
              <button type="submit">{t("member.verify_submit")}</button>
            </p>
          </form>
          <p class="muted">{t("member.verify_note")}</p>
        </div>
      );
    }
    return (
      <Layout title={title} ctx={ctx} seo={{ noindex: true }}>
        <h1>{title}</h1>
        {error ? <p class="error">{error}</p> : null}
        {info ? <p class="notice">{info}</p> : null}
        {body}
      </Layout>
    );
  },

  AccountPage(props) {
    return (
      <Layout title={t("member.account")} ctx={props.ctx} seo={{ noindex: true }}>
        <AccountBody {...props} />
      </Layout>
    );
  },

  MemberPasskeysPage({ ctx, passkeys, canAdd, email, flash, error }) {
    return (
      <Layout title={t("passkey.title")} ctx={ctx} seo={{ noindex: true }}>
        <h1>{t("passkey.title")}</h1>
        <p class="muted">{t("passkey.intro")}</p>
        {flash ? <p class="notice">{flash}</p> : null}
        {error ? <p class="error">{error}</p> : null}
        {passkeys.length === 0 ? <p>{t("passkey.none")}</p> : null}
        {passkeys.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>{t("member.session_device")}</th>
                <th>{t("passkey.created")}</th>
                <th>{t("member.session_last_seen")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {passkeys.map((k) => (
                <tr>
                  <td>
                    {k.label ?? t("member.session_unknown")}
                    {k.backed_up ? <span class="muted"> ({t("passkey.synced")})</span> : null}
                    {k.usable ? null : <span class="muted"> ({t("passkey.unusable")})</span>}
                  </td>
                  <td>{formatDateTime(k.created_at)}</td>
                  <td>{k.last_used_at ? formatDateTime(k.last_used_at) : "-"}</td>
                  <td>
                    <form method="post" action={`${ctx.shopPath}/account/passkeys/${k.id}/delete`} onsubmit={`return confirm(${JSON.stringify(t("passkey.delete_confirm"))})`}>
                      <button type="submit">{t("passkey.delete")}</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {canAdd ? (
          <PasskeyButton ctx={ctx} kind="register" />
        ) : (
          <form method="post" action={`${ctx.shopPath}/account/login`}>
            <p>{t("passkey.reauth")}</p>
            <input type="hidden" name="email" value={email ?? ""} />
            <input type="hidden" name="next" value="passkeys" />
            <button type="submit">{t("member.send_code")}</button>
          </form>
        )}
        <p>
          <a href={`${ctx.shopPath}/account`}>{t("member.account")}</a>
        </p>
      </Layout>
    );
  },

  MemberSessionsPage({ ctx, sessions, flash }) {
    return (
      <Layout title={t("member.sessions")} ctx={ctx} seo={{ noindex: true }}>
        <h1>{t("member.sessions")}</h1>
        <p class="muted">{t("member.sessions_help")}</p>
        {flash ? <p class="notice">{flash}</p> : null}
        <table>
          <thead>
            <tr>
              <th>{t("member.session_device")}</th>
              <th>{t("member.session_signed_in")}</th>
              <th>{t("member.session_last_seen")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((x) => (
              <tr>
                <td>
                  {x.label ?? t("member.session_unknown")}
                  {x.kind === "api" ? <span class="muted"> ({t("member.session_api")})</span> : null}
                  {x.current ? <strong> {t("member.session_current")}</strong> : null}
                </td>
                <td>{formatDateTime(x.created_at)}</td>
                <td>{formatDateTime(x.last_seen_at)}</td>
                <td>
                  <form method="post" action={`${ctx.shopPath}/account/sessions/${x.id}/revoke`}>
                    <button type="submit">{t(x.current ? "nav.logout" : "member.session_revoke")}</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          <a href={`${ctx.shopPath}/account`}>{t("member.account")}</a>
        </p>
      </Layout>
    );
  },

  StoresPage({ ctx, stores }) {
    return (
      <Layout title={t("tryon.stores_title")} ctx={ctx}>
        <h1>{t("tryon.stores_title")}</h1>
        {stores.length === 0 ? <p>{t("tryon.no_stores")}</p> : stores.map((st) => <StoreCard store={st} />)}
      </Layout>
    );
  },

  TryonPage({ ctx, step, lines, stores, store, dates, settings, values, visitLabel, error, number }) {
    const hidden = (name: keyof typeof values) => <input type="hidden" name={name} value={values[name] ?? ""} />;
    const items = (
      <table>
        <tbody>
          {lines.map((l) => (
            <tr>
              <td>
                {l.product.name}
                {l.sku.name ? ` / ${l.sku.name}` : ""}
              </td>
              <td>×{l.qty}</td>
              <td>{yen(l.sku.price_jpy * l.qty)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
    const howto = settings.mode === "visit" ? tf("tryon.howto_visit", { days: settings.hold_days }) : tf("tryon.howto_shop", { days: settings.hold_days });
    return (
      <Layout title={t("tryon.title")} ctx={ctx} seo={{ noindex: true }}>
        <h1>{t("tryon.title")}</h1>
        {error ? <p class="error">{error}</p> : null}
        {step === "done" ? (
          <div>
            <p class="notice">{tf("tryon.done", { number: number ?? "" })}</p>
            <p>{t("tryon.done_hint")}</p>
            {store ? <StoreCard store={store} /> : null}
            <p>
              <a href={ctx.shopPath || "/"}>{t("store.continue")}</a>
            </p>
          </div>
        ) : step === "store" ? (
          <div>
            <p>{howto}</p>
            {settings.notice ? <p class="muted">{settings.notice}</p> : null}
            {items}
            <h2>{t("tryon.choose_store")}</h2>
            {stores.length === 0 ? <p>{t("tryon.no_stores")}</p> : null}
            {stores.map((st) => (
              <StoreCard store={st}>
                <p>
                  <a class="button" href={`${ctx.shopPath}/tryon?store=${st.id}`}>
                    {t("tryon.choose_this_store")}
                  </a>
                </p>
              </StoreCard>
            ))}
          </div>
        ) : step === "details" ? (
          <form method="post" action={`${ctx.shopPath}/tryon/confirm`}>
            {store ? <StoreCard store={store} /> : null}
            <p>
              <a href={`${ctx.shopPath}/tryon`}>{t("tryon.change_store")}</a>
            </p>
            {items}
            {hidden("store")}
            {settings.mode === "visit" ? (
              <>
                <label for="visit_date">{t("tryon.visit_date")}</label>
                <select id="visit_date" name="visit_date" required>
                  <option value="">{t("tryon.visit_date_choose")}</option>
                  {(dates ?? []).map((d) => (
                    <option value={d.value} selected={d.value === values.visit_date}>
                      {d.label}
                    </option>
                  ))}
                </select>
                <p class="muted">{tf("tryon.visit_hint", { days: settings.hold_days })}</p>
              </>
            ) : (
              <p class="muted">{howto}</p>
            )}
            <label for="customer_name">{t("store.address_name")}</label>
            <input id="customer_name" name="customer_name" value={values.customer_name ?? ""} maxlength={100} required autocomplete="name" />
            <label for="customer_email">{t("store.address_email")}</label>
            <input id="customer_email" type="email" name="customer_email" value={values.customer_email ?? ""} maxlength={254} required autocomplete="email" />
            <label for="customer_phone">{t("store.address_phone")}</label>
            <input id="customer_phone" type="tel" name="customer_phone" value={values.customer_phone ?? ""} maxlength={20} required autocomplete="tel" />
            <label for="note">{t("tryon.note")}</label>
            <textarea id="note" name="note" maxlength={500} rows={3}>
              {values.note ?? ""}
            </textarea>
            <p>
              <button type="submit">{t("tryon.to_confirm")}</button>
            </p>
          </form>
        ) : (
          <div>
            <h2>{t("tryon.confirm_title")}</h2>
            {items}
            <table>
              <tbody>
                <tr>
                  <th>{t("tryon.store")}</th>
                  <td>{store?.name ?? ""}</td>
                </tr>
                {visitLabel ? (
                  <tr>
                    <th>{t("tryon.visit_date")}</th>
                    <td>{visitLabel}</td>
                  </tr>
                ) : null}
                <tr>
                  <th>{t("store.address_name")}</th>
                  <td>{values.customer_name}</td>
                </tr>
                <tr>
                  <th>{t("store.address_email")}</th>
                  <td>{values.customer_email}</td>
                </tr>
                <tr>
                  <th>{t("store.address_phone")}</th>
                  <td>{values.customer_phone}</td>
                </tr>
                {values.note ? (
                  <tr>
                    <th>{t("tryon.note")}</th>
                    <td>{values.note}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            <p class="muted">{t("tryon.no_payment")}</p>
            <p class="muted">{howto}</p>
            <form method="post" action={`${ctx.shopPath}/tryon/submit`}>
              {hidden("store")}
              {hidden("visit_date")}
              {hidden("customer_name")}
              {hidden("customer_email")}
              {hidden("customer_phone")}
              {hidden("note")}
              <button type="submit">{t("tryon.submit")}</button>
            </form>
            <p>
              <a href={`${ctx.shopPath}/tryon?store=${values.store ?? ""}`}>{t("tryon.edit")}</a>
            </p>
          </div>
        )}
      </Layout>
    );
  },

  CouponClaimPage({ ctx, coupon, loggedIn, error }) {
    return (
      <Layout title={coupon.name} ctx={ctx} seo={{ noindex: true }}>
        <h1>{coupon.name}</h1>
        <p style="font-size:1.5rem;font-weight:bold">{coupon.label}</p>
        {coupon.min_subtotal_jpy ? <p class="muted">{tf("claim.min_subtotal", { amount: yen(coupon.min_subtotal_jpy) })}</p> : null}
        {coupon.ends_at ? <p class="muted">{tf("claim.until", { date: formatDateTime(coupon.ends_at) })}</p> : null}
        {coupon.remaining !== null ? <p class="muted">{tf("claim.remaining", { n: coupon.remaining })}</p> : null}
        {error ? <p class="error">{error}</p> : null}
        {!coupon.live || coupon.remaining === 0 ? (
          <p class="error">{t("claim.closed")}</p>
        ) : loggedIn ? (
          <form method="post" action={`${ctx.shopPath}/coupons/${coupon.id}/claim`}>
            <button type="submit">{t("claim.button")}</button>
          </form>
        ) : (
          <p>
            {t("claim.login_first")} <a href={`${ctx.shopPath}/account/login`}>{t("member.login")}</a>
          </p>
        )}
      </Layout>
    );
  },

  InquiryPage({ ctx, step, categories, values, hidden, askEmail, order, orders, orderUnmatched, sent, token, inquiry, list, error, info }) {
    const hiddenFields = (h: Record<string, string> | undefined) => Object.entries(h ?? {}).map(([k, v]) => <input type="hidden" name={k} value={v} />);
    const text = (body: string) => <div style="white-space:pre-wrap;overflow-wrap:anywhere">{body}</div>;
    const orderBox = order ? (
      <div class="msg">
        <p>
          <strong>{tf("inq.order_heading", { number: order.number })}</strong>
          {` · ${formatDateTime(order.created_at, { dateOnly: true })} · ${yen(order.total_jpy)} · ${t(`order.status.${order.status}` as MessageKey)}`}
        </p>
        <p class="muted">{order.items.map((i) => `${i.name ?? ""} ×${i.qty}`).join("、")}</p>
      </div>
    ) : null;
    const resendForm = (
      <form method="post" action={`${ctx.shopPath}/inquiries/resend`}>
        <p>{t("inq.resend_intro")}</p>
        <label for="r-number">{t("inq.number")}</label>
        <input id="r-number" type="text" name="number" inputmode="numeric" required />
        <label for="r-email">{t("store.address_email")}</label>
        <input id="r-email" type="email" name="email" value={values.email ?? ""} required autocomplete="email" />
        <p>
          <button type="submit">{t("inq.resend_submit")}</button>
        </p>
      </form>
    );
    let body: Child;
    if (step === "form") {
      body = (
        <form method="post" action={`${ctx.shopPath}/inquiries/confirm`}>
          {hiddenFields(hidden)}
          <p>{t("inq.form_intro")}</p>
          {orderBox}
          <label for="category">{t("inq.category")}</label>
          <select id="category" name="category" required>
            <option value="">{t("inq.category_choose")}</option>
            {categories.map((c) => (
              <option value={c.value} selected={c.value === values.category}>
                {c.label}
              </option>
            ))}
          </select>
          {!order ? (
            <>
              <label for="order_number">{t("inq.order_number")}</label>
              {orders && orders.length > 0 ? (
                <select id="order_number" name="order_number">
                  <option value="">{t("inq.order_none_choose")}</option>
                  {orders.map((o) => (
                    <option value={String(o.number)} selected={String(o.number) === values.order_number}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input id="order_number" type="text" name="order_number" inputmode="numeric" value={values.order_number ?? ""} maxlength={12} />
              )}
              <p class="muted">{t("inq.order_number_help")}</p>
            </>
          ) : null}
          <label for="body">{t("inq.body")}</label>
          <textarea id="body" name="body" rows={8} maxlength={5000} required>
            {values.body ?? ""}
          </textarea>
          <label for="name">{t("store.address_name")}</label>
          <input id="name" name="name" value={values.name ?? ""} maxlength={100} autocomplete="name" />
          {askEmail ? (
            <>
              <label for="email">{t("store.address_email")}</label>
              <input id="email" type="email" name="email" value={values.email ?? ""} maxlength={254} required autocomplete="email" />
              <p class="muted">{t("inq.email_help")}</p>
            </>
          ) : (
            <p class="muted">{order ? t("inq.reply_to_order") : t("inq.reply_to_member")}</p>
          )}
          <p class="muted">{t("inq.attach_after_verify")}</p>
          <p>
            <button type="submit">{t("inq.to_confirm")}</button>
          </p>
        </form>
      );
    } else if (step === "confirm") {
      const label = categories.find((c) => c.value === values.category)?.label ?? "";
      body = (
        <div>
          <h2>{t("inq.confirm_title")}</h2>
          {orderBox}
          {orderUnmatched ? <p class="muted">{tf("inq.order_unmatched", { number: values.order_number ?? "" })}</p> : null}
          <table>
            <tbody>
              <tr>
                <th>{t("inq.category")}</th>
                <td>{label}</td>
              </tr>
              {values.name ? (
                <tr>
                  <th>{t("store.address_name")}</th>
                  <td>{values.name}</td>
                </tr>
              ) : null}
              {askEmail ? (
                <tr>
                  <th>{t("store.address_email")}</th>
                  <td>{values.email}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          {text(values.body ?? "")}
          <form method="post" action={`${ctx.shopPath}/inquiries/submit`}>
            {hiddenFields(hidden)}
            <p>
              <button type="submit">{t("inq.submit")}</button>
            </p>
          </form>
          <form method="post" action={`${ctx.shopPath}/inquiries/new`}>
            {hiddenFields(hidden)}
            <button type="submit">{t("inq.edit")}</button>
          </form>
        </div>
      );
    } else if (step === "sent") {
      body = (
        <div>
          <p class="notice">{tf("inq.sent", { number: sent?.number ?? "" })}</p>
          <p>{sent?.verified ? t("inq.sent_verified") : t("inq.sent_verify")}</p>
          {sent && !sent.mailSent ? (
            <>
              <p class="error">{t("inq.sent_mail_failed")}</p>
              {resendForm}
            </>
          ) : null}
          <p>
            <a href={ctx.shopPath || "/"}>{t("store.continue")}</a>
          </p>
        </div>
      );
    } else if (step === "open") {
      body = (
        <div>
          <p>{tf("inq.open_intro", { number: sent?.number ?? "" })}</p>
          <form method="post" action={`${ctx.shopPath}/inquiries/open`}>
            <input type="hidden" name="t" value={token ?? ""} />
            <p>
              <button type="submit">{t("inq.open_submit")}</button>
            </p>
          </form>
        </div>
      );
    } else if (step === "thread" && inquiry) {
      body = (
        <div>
          <p>
            {tf("inq.number_label", { number: inquiry.number })} · {inquiry.categoryLabel} · {inquiry.statusLabel}
            {inquiry.order ? ` · ${tf("inq.order_heading", { number: inquiry.order.number })}` : inquiry.claimed_order_number ? ` · ${tf("inq.order_heading", { number: inquiry.claimed_order_number })}` : ""}
          </p>
          {inquiry.messages.map((m) => (
            <div class="msg" style={m.author === "shop" ? "margin-left:2rem" : "margin-right:2rem"}>
              <p class="muted">
                {m.author === "shop" ? ctx.shop.name : t("inq.from_you")} · {formatDateTime(m.created_at)}
              </p>
              {text(m.body)}
              {m.attachments.length > 0 ? (
                <ul>
                  {m.attachments.map((a) => (
                    <li>
                      <a href={a.href} target="_blank" rel="noopener noreferrer">
                        {a.filename}
                      </a>{" "}
                      <span class="muted">({Math.max(1, Math.round(a.size / 1024))} KB)</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
          {inquiry.canReply ? (
            <form method="post" action={`${ctx.shopPath}/inquiries/reply`} enctype={inquiry.canAttach ? "multipart/form-data" : undefined}>
              {hiddenFields(inquiry.replyHidden)}
              <label for="body">{t("inq.reply")}</label>
              <textarea id="body" name="body" rows={6} maxlength={5000} required></textarea>
              {inquiry.canAttach ? (
                <>
                  <label for="files">{t("inq.attach")}</label>
                  <input id="files" type="file" name="files" multiple accept={inquiry.attachAccept} />
                  <p class="muted">{t("inq.attach_help")}</p>
                </>
              ) : null}
              <p>
                <button type="submit">{t("inq.reply_submit")}</button>
              </p>
            </form>
          ) : (
            <p class="muted">
              {t("inq.closed_note")} <a href={`${ctx.shopPath}/inquiries/new`}>{t("inq.new")}</a>
            </p>
          )}
        </div>
      );
    } else if (step === "list") {
      body = (
        <div>
          <p>
            <a class="button" href={`${ctx.shopPath}/inquiries/new`}>
              {t("inq.new")}
            </a>
          </p>
          {ctx.member ? (
            (list ?? []).length === 0 ? (
              <p class="muted">{t("inq.list_empty")}</p>
            ) : (
              <table>
                <tbody>
                  {(list ?? []).map((r) => (
                    <tr>
                      <td>
                        <a href={`${ctx.shopPath}/inquiries/thread?n=${r.number}`}>{tf("inq.number_label", { number: r.number })}</a>
                      </td>
                      <td>{r.categoryLabel}</td>
                      <td>{r.statusLabel}</td>
                      <td>{formatDateTime(r.last_message_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : (
            resendForm
          )}
        </div>
      );
    } else {
      body = resendForm;
    }
    return (
      <Layout title={t("inq.title")} ctx={ctx} seo={{ noindex: true }}>
        <h1>{t("inq.title")}</h1>
        {error ? <p class="error">{error}</p> : null}
        {info ? <p class="notice">{info}</p> : null}
        {body}
      </Layout>
    );
  },

  OrderLookupPage({ ctx, result, error, values, receipt, inquiry, member }) {
    const r = result ?? null;
    return (
      <Layout title={t("store.lookup_title")} ctx={ctx} seo={{ noindex: true }}>
        <h1>{t("store.lookup_title")}</h1>
        {member ? null : <p>{t("store.lookup_intro")}</p>}
        {error ? <p class="error">{error}</p> : null}
        {member ? null : (
          <form method="post" action={`${ctx.shopPath}/orders/lookup`}>
            <label for="number">{t("store.lookup_number")}</label>
            <input id="number" type="text" name="number" inputmode="numeric" value={values.number ?? ""} required />
            <label for="email">{t("store.address_email")}</label>
            <input id="email" type="email" name="email" value={values.email ?? ""} required />
            <p>
              <button type="submit">{t("store.lookup_submit")}</button>
            </p>
          </form>
        )}
        {r ? (
          <div>
            <h2>
              {t("store.lookup_number")} {String(r["number"])}
            </h2>
            <p>
              {t("order.status")}: {t(`order.status.${String(r["status"])}` as MessageKey)}
              {r["shipped_at"] ? ` (${formatDateTime(String(r["shipped_at"]), { dateOnly: true })})` : ""}
            </p>
            {(() => {
              const tr = trackingOf(r["tracking"]);
              if (!tr) return null;
              const url = trackingUrl(tr.carrier, tr.number);
              return (
                <p>
                  {tf("store.tracking", { carrier: carrierLabel(tr.carrier), number: tr.number })}
                  {url ? (
                    <>
                      {" "}
                      <a href={url} target="_blank" rel="noopener noreferrer">
                        {t("tracking.check")}
                      </a>
                    </>
                  ) : null}
                </p>
              );
            })()}
            <table>
              <tbody>
                {((r["items"] as { name: string; sku: string; qty: number; unit_price_jpy: number }[]) ?? []).map((it) => (
                  <tr>
                    <td>
                      {it.name} / {it.sku}
                    </td>
                    <td>×{it.qty}</td>
                    <td>{yen(it.unit_price_jpy * it.qty)}</td>
                  </tr>
                ))}
                <tr>
                  <td>{t("store.shipping")}</td>
                  <td></td>
                  <td>{yen(Number(r["shipping_jpy"] ?? 0))}</td>
                </tr>
                {((r["discounts"] as { code: string; name: string; amount_jpy: number }[] | undefined) ?? []).map((d) => (
                  <tr>
                    <td>
                      {t("confirm.discount")}（{d.code}）
                    </td>
                    <td></td>
                    <td>−{yen(d.amount_jpy)}</td>
                  </tr>
                ))}
                <tr>
                  <th colspan={2}>{t("store.total")}</th>
                  <th>{yen(Number(r["total_jpy"] ?? 0))}</th>
                </tr>
              </tbody>
            </table>
            {receipt && (r["status"] === "paid" || r["status"] === "shipped") ? (
              <form method="post" action={`${ctx.shopPath}/orders/receipt`} target="_blank">
                <input type="hidden" name="number" value={String(r["number"])} />
                <input type="hidden" name="email" value={values.email ?? ""} />
                <label for="receipt_name">{t("receipt.addressee_label")}</label>
                <input id="receipt_name" type="text" name="name" maxlength={100} />
                <p>
                  <button type="submit">{t("receipt.get")}</button>
                </p>
              </form>
            ) : null}
            {member?.receiptUrl ? (
              <p>
                <a href={member.receiptUrl} target="_blank" rel="noopener">
                  {t("receipt.get")}
                </a>
              </p>
            ) : null}
            {member?.inquiryUrl ? (
              <p>
                <a href={member.inquiryUrl}>{t("inq.about_order")}</a>
              </p>
            ) : null}
            {inquiry ? (
              <form method="post" action={`${ctx.shopPath}/inquiries/new`}>
                <input type="hidden" name="o" value={inquiry.token} />
                <button type="submit">
                  {t("inq.about_order")}
                </button>
              </form>
            ) : null}
          </div>
        ) : null}
      </Layout>
    );
  },

  CheckoutDone({ ctx, free, status, orderNumber, refresh, inquiryUrl }) {
    const body =
      status === "confirmed" && orderNumber != null
        ? tf("store.thanks_confirmed", { n: orderNumber })
        : status === "released"
          ? t("store.thanks_released")
          : status === "pending" && refresh
            ? t("store.thanks_pending")
            : free
              ? t("store.thanks_free")
              : t("store.thanks_body");
    return (
      <Layout title={t("store.thanks_title")} ctx={ctx} seo={{ noindex: true }} refreshSeconds={status === "pending" && refresh ? 4 : undefined}>
        <h1>{t("store.thanks_title")}</h1>
        <p>{body}</p>
        {inquiryUrl ? (
          <p>
            <a href={inquiryUrl}>{t("inq.about_order")}</a>
          </p>
        ) : null}
        <p>
          <a href={ctx.shopPath || "/"}>{t("store.continue")}</a>
        </p>
      </Layout>
    );
  },

  NotFound({ ctx }) {
    return (
      <Layout title={t("store.not_found")} ctx={ctx}>
        <h1>{t("store.not_found")}</h1>
        <p>
          <a href={ctx ? ctx.shopPath || "/" : "/"}>{t("store.continue")}</a>
        </p>
      </Layout>
    );
  },
};
