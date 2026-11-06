/**
 * 管理画面の左上の名前とアイコン（デプロイの変数 BANTO_ADMIN_NAME・BANTO_ADMIN_ICON_URL。メンテナの決定 2026-11-06、docs/env.md）。
 * 導入する会社が自分の名前を出すため。ロケールと同じくデプロイ単位の設定で、app.ts のミドルウェアが毎リクエスト setAdminBrand() する
 * （リクエストごとに変わらないので isolate の中で競合しない）。お店の画面には使わない（お店の画面はショップの名前）
 */
import { t } from "../../i18n";

export const ADMIN_NAME_MAX = 40;

let name: string | null = null;
let icon: string | null = null;

/** 名前: 制御文字を外して 40 文字まで（空なら既定） */
export function adminNameOf(v: string | undefined | null): string | null {
  const s = Array.from((v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, ADMIN_NAME_MAX).join("");
  return s || null;
}

/** アイコン: https の URL か、このサイトのパス（/media/… など）。空白・引用符・山かっこを含むものは使わない（無ければ文字のアイコン） */
export function adminIconOf(v: string | undefined | null): string | null {
  const s = (v ?? "").trim();
  if (!s || s.length > 2000 || /[\s"'<>`\\]/.test(s)) return null;
  if (/^https:\/\/[^/]/i.test(s)) return s;
  if (/^\/[^/]/.test(s)) return s;
  return null;
}

export function setAdminBrand(nameVar: string | undefined | null, iconVar: string | undefined | null): void {
  name = adminNameOf(nameVar);
  icon = adminIconOf(iconVar);
}

/** 今の名前・アイコンの画像・文字のアイコン（名前を変えたら名前の最初の 1 文字、既定は「番」） */
export function adminBrand(): { name: string; icon: string | null; mark: string } {
  return { name: name ?? t("app.name"), icon, mark: name ? Array.from(name)[0]!.toUpperCase() : "番" };
}
