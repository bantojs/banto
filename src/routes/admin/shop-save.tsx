import { DbError } from "../../db/client";
import type { ShopRow } from "../../db/types";
import { t } from "../../i18n";
import { owner, type AdminContext } from "./context";

/**
 * shops の行を管理画面から更新する（ショップの設定・同梱モジュールの設定の保存はすべてここを通す）。
 * member の更新は RLS（0024 の shops_member_update）が settings の項目を求め、足りないと PostgREST は
 * 0 行・エラーなしで終える。それを「保存しました」と出さないように、0 行なら NotSaved を投げる。
 * 画面は flash=not_saved で「保存できませんでした」を出す（文言は settings.not_saved）
 */
export class NotSaved extends DbError {
  constructor() {
    super("shop_not_updated", 403, "42501");
  }
}

export async function updateShop(c: AdminContext, shopId: string, values: Partial<ShopRow>): Promise<void> {
  const rows = await owner(c).db.from<ShopRow>("shops").update(values, { id: shopId });
  if (rows.length === 0) throw new NotSaved();
}

/** 保存の失敗の flash の値（権限が足りず 0 行なら not_saved、ほかは渡した値） */
export const failCode = (e: DbError, other = "generic"): string => (e instanceof NotSaved ? "not_saved" : other);

/** flash=not_saved のときの知らせ（自分の flash の表を持たない画面用） */
export function NotSavedNotice(props: { flash: string | undefined }) {
  return props.flash === "not_saved" ? <p class="error">{t("settings.not_saved")}</p> : null;
}
