import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../app";
import { t, tf, type MessageKey } from "../../i18n";
import { AdminLayout, PageHead } from "./layout";
import type { AdminContext } from "./context";

/**
 * 権限の無いページ（メンテナの決定 2026-11-08「見えないものは出さない、押せないものは理由を出す」）。
 * リンクをもらって、ショップには入れるが項目の無い画面に来たとき、404 の文字の代わりに「どの項目が要るか」を出し、ホームへ戻れるようにする。
 * loadShop が項目の不足で断ったとき（c.get("deniedShop")）の GET の 404 だけを置き換える。触れないショップ・無いページは今までどおり 404
 */
export function permLabel(perm: string): string {
  if (perm === "admin") return t("access.perm_admin");
  if (perm === "any") return t("access.perm_any");
  return perm
    .split("|")
    .map((alt) =>
      alt
        .split("+")
        .map((p) => t(`perm.${p}` as MessageKey))
        .join(" + "),
    )
    .join(t("access.perm_or"));
}

export const deniedPage: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const denied = c.get("deniedShop");
  if (!denied || c.req.method !== "GET" || c.res.status !== 404) return;
  const { shop, perm } = denied;
  c.res = undefined;
  c.res = await (c as AdminContext).html(
    <AdminLayout title={`${shop.name} · ${t("access.denied_title")}`} nav crumbs={[{ label: shop.name, href: `/admin/shops/${shop.id}/home` }, { label: t("access.denied_title") }]} shopTabs={{ shop, access: c.get("shopAccess") }}>
      <PageHead title={t("access.denied_title")} />
      <div class="notice">
        <p>{tf("access.denied_body", { perm: permLabel(perm) })}</p>
        <p>
          <a href={`/admin/shops/${shop.id}/home`}>{t("access.denied_home")}</a>
        </p>
      </div>
    </AdminLayout>,
    403,
  );
};
