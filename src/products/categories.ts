/**
 * カテゴリー（0008_catalog.sql、3 段まで）。木の組み立てと、子孫を含む絞り込み。
 */
import type { CategoryRow } from "../db/types";

export interface CategoryNode {
  id: string;
  slug: string;
  name: string;
  parent_id: string | null;
  children: CategoryNode[];
}

export function sortCategories<T extends Pick<CategoryRow, "sort_order" | "name">>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.sort_order - b.sort_order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function categoryTree(rows: CategoryRow[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>();
  for (const r of sortCategories(rows)) nodes.set(r.id, { id: r.id, slug: r.slug, name: r.name, parent_id: r.parent_id, children: [] });
  const roots: CategoryNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parent_id ? nodes.get(n.parent_id) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  return roots;
}

/** 追加カテゴリー（products.extra_category_ids）とクーポンのタグの条件が使える DB の版（migrated() で判定） */
export const EXTRA_CATEGORIES_MIGRATION = "0042_product_extra_categories";

/** 商品が属するカテゴリー（主カテゴリー + 追加カテゴリー、0042）。絞り込みとクーポンの条件はこれで判定する */
export function productCategoryIds(p: { category_id?: string | null; extra_category_ids?: string[] | null }): string[] {
  const out = p.category_id ? [p.category_id] : [];
  for (const id of Array.isArray(p.extra_category_ids) ? p.extra_category_ids : []) if (typeof id === "string" && !out.includes(id)) out.push(id);
  return out;
}

/** 商品がカテゴリーの集合（descendantIds の結果）のどれかに入っているか */
export function inCategories(p: { category_id?: string | null; extra_category_ids?: string[] | null }, ids: Set<string>): boolean {
  return productCategoryIds(p).some((id) => ids.has(id));
}

/** 自分と子孫の id（絞り込み用） */
export function descendantIds(rows: CategoryRow[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) if (r.parent_id && out.has(r.parent_id) && !out.has(r.id)) {
      out.add(r.id);
      grew = true;
    }
  }
  return out;
}

/** 最上位から自分までの並び（パンくず用） */
export function categoryPath(rows: CategoryRow[], id: string | null | undefined): CategoryRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const path: CategoryRow[] = [];
  let cur = id ? byId.get(id) : undefined;
  while (cur && path.length < 3) {
    path.unshift(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return path;
}
