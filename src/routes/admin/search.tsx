import type { Child } from "hono/jsx";
import { t } from "../../i18n";

/**
 * 管理画面の一覧の検索の形（メンテナの決定 2026-11-08「検索は同じ形」）: キーワード 1 つ ＋ 条件 ＋ 並び ＋ 条件のチップ。
 * スクリプトが無くても動く: 条件はフォームの GET、チップは「その条件を外した URL」へのリンク。絞り込みは DB（admin_search_ids、0132）。
 * 保存したビューは src/routes/admin/views.tsx（0135）。
 */

/** 一覧の並び（0132。古い順は DB が逆向きのキーセットで読む） */
export type ListSort = "new" | "old";
export const readSort = (v: string | undefined): ListSort => (v === "old" ? "old" : "new");

/** 今の条件（URL の値）。空の値は持たない */
export type SearchParams = Record<string, string>;

/** 条件の URL（after は付けない。ページの位置は条件が変わると意味を失うため） */
export function searchHref(base: string, params: SearchParams): string {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "")).toString();
  return qs ? `${base}?${qs}` : base;
}

/** 条件のチップ: 表示と、その条件だけを外した URL。label が null の条件はチップにしない（キーワード・既定の並びなど） */
export function searchChips(base: string, params: SearchParams, label: (name: string, value: string) => string | null): { label: string; href: string }[] {
  return Object.entries(params)
    .filter(([, v]) => v !== "")
    .flatMap(([name, value]) => {
      const text = label(name, value);
      if (text === null) return [];
      const rest = { ...params };
      delete rest[name];
      return [{ label: text, href: searchHref(base, rest) }];
    });
}

/**
 * 検索の欄。children は「＋ 条件」を開いた中に並べる欄（name は URL の値の名前）。
 * 条件が 1 つでも付いていれば開いて出す。並びの選択は sortable のときだけ（DB が古い順に対応していない版では出さない）
 */
export function SearchBar(props: {
  action: string;
  q: string;
  placeholder: string;
  sort?: ListSort;
  sortable?: boolean;
  chips: { label: string; href: string }[];
  clearHref: string;
  children?: Child;
}) {
  return (
    <form method="get" action={props.action} class="search">
      <div class="search-row">
        <input type="search" name="q" value={props.q} placeholder={props.placeholder} aria-label={props.placeholder} maxlength={100} />
        {props.sortable ? (
          <select name="sort" aria-label={t("search.sort")}>
            <option value="new" selected={props.sort !== "old"}>
              {t("search.sort_new")}
            </option>
            <option value="old" selected={props.sort === "old"}>
              {t("search.sort_old")}
            </option>
          </select>
        ) : null}
        <button type="submit" class="secondary small">
          {t("search.submit")}
        </button>
      </div>
      {props.children ? (
        <details class="search-more" open={props.chips.length > 0}>
          <summary>{t("search.more")}</summary>
          <div class="search-fields">{props.children}</div>
        </details>
      ) : null}
      {props.chips.length > 0 ? (
        <p class="chips">
          {props.chips.map((c) => (
            <a class="chip" href={c.href} title={t("search.remove")}>
              {c.label} <span aria-hidden="true">×</span>
            </a>
          ))}
          <a href={props.clearHref}>{t("search.clear")}</a>
        </p>
      ) : null}
    </form>
  );
}
