/**
 * 管理画面の権限（0024_organizations、docs/knowledge/11-organizations.md）。
 * 判定の正は DB（RLS と関数の banto_shop_perm）。ここは画面を出し分けるためと、ハンドラの入口で早めに止めるため。
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../app";
import { DbError } from "../../db/client";
import type { ShopRow } from "../../db/types";
import { owner, type AdminContext } from "./context";

export const SHOP_PERMS = ["catalog", "orders", "orders_cancel", "customers", "marketing", "reports", "stores", "settings", "integrations", "support", "design", "content"] as const;
export type ShopPerm = (typeof SHOP_PERMS)[number];
export type OrgRole = "owner" | "admin" | "member";

export function isShopPerm(v: unknown): v is ShopPerm {
  return typeof v === "string" && (SHOP_PERMS as readonly string[]).includes(v);
}

/** よく使う組み合わせ（ひな形）。中身はいつでも直せる */
export const PERM_TEMPLATES: Record<string, readonly ShopPerm[]> = {
  shop_admin: SHOP_PERMS.filter((p) => p !== "integrations"),
  catalog: ["catalog"],
  fulfillment: ["orders", "orders_cancel"],
  marketing: ["marketing", "reports"],
  stores: ["stores"],
  support: ["support"],
  design: ["design"],
  content: ["content"],
};

export interface ShopAccess {
  role: OrgRole;
  perms: ShopPerm[];
}

/** ショップの行と自分の権限。触れないショップなら null（1 回の往復） */
export async function shopAccess(c: AdminContext, shopId: string): Promise<{ shop: ShopRow; access: ShopAccess } | null> {
  const { db } = owner(c);
  try {
    const r = await db.rpc<{ shop: ShopRow; role: OrgRole; perms: string[] } | null>("banto_admin_shop", { p_shop_id: shopId });
    if (!r) return null;
    return { shop: r.shop, access: { role: r.role, perms: r.perms.filter(isShopPerm) } };
  } catch (e) {
    if (e instanceof DbError && e.code === "22P02") return null; // id の形が違う
    throw e;
  }
}

export function can(access: ShopAccess | undefined, perm: ShopPerm | "admin" | "any"): boolean {
  if (!access) return false;
  if (perm === "admin") return access.role === "owner" || access.role === "admin";
  if (perm === "any") return access.perms.length > 0;
  return access.perms.includes(perm);
}

export interface MyOrg {
  org_id: string;
  name: string;
  role: OrgRole;
}

/** 自分が入っている組織 */
export async function myOrgs(c: AdminContext): Promise<MyOrg[]> {
  const { db, session } = owner(c);
  const [members, orgs] = await Promise.all([
    db.from<{ org_id: string; role: OrgRole }>("org_members").select("org_id,role", { eq: { user_id: session.user_id } }),
    db.from<{ id: string; name: string }>("organizations").select("id,name", { order: "created_at.asc" }),
  ]);
  const name = new Map(orgs.map((o) => [o.id, o.name]));
  return members.map((m) => ({ org_id: m.org_id, role: m.role, name: name.get(m.org_id) ?? "" }));
}

/** どこかの組織の owner / admin か（アップデート・セットアップ・ショップの追加） */
export async function isOrgAdmin(c: AdminContext): Promise<boolean> {
  const { db, session } = owner(c);
  const rows = await db.from<{ role: OrgRole }>("org_members").select("role", { eq: { user_id: session.user_id } });
  return rows.some((r) => r.role === "owner" || r.role === "admin");
}

/** 組織の owner / admin だけの画面（アップデート・ショップの追加・組織の管理）。requireOwner の後に置く */
export const requireOrgAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!(await isOrgAdmin(c))) return c.redirect("/admin?flash=forbidden");
  await next();
};

export interface MyShop {
  id: string;
  slug: string;
  name: string;
  published: boolean;
  perms: ShopPerm[];
}

/** 自分が触れるショップ（ダッシュボード） */
export async function myShops(c: AdminContext): Promise<MyShop[]> {
  const { db } = owner(c);
  const rows = await db.rpc<{ id: string; slug: string; name: string; published: boolean; perms: string[] }[]>("banto_my_shops", {});
  return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, published: r.published, perms: r.perms.filter(isShopPerm) }));
}
