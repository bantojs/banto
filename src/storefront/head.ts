/**
 * 同梱モジュールがお店の画面の <head> に差し込む口（拡張点。CLAUDE.md §7）。docs/storefront.md
 * 受けるのは決まった形のタグだけ（外部の https のスクリプトと、モジュールのコードが作るインラインのスクリプト）。
 * 運営者が入力した HTML をそのまま出す口は作らない。ON のモジュールが無ければ応答を書き換えない。
 * 管理画面には差し込まない（ストアフロントのルートからだけ呼ぶ）。
 */
import type { PublicShop } from "./data";
import type { ShopEvent } from "./events";

export type HeadTag = { kind: "script"; src: string } | { kind: "inline-script"; code: string };

export interface StorefrontHeadContributor {
  /** 同梱モジュールの id（registry.ts）。ON のショップだけで呼ぶ */
  module: string;
  tags(shop: PublicShop, events: readonly ShopEvent[]): HeadTag[];
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** タグを HTML にする。https 以外の src・</script や <!-- を含むインラインは捨てる（モジュールの不具合でページを壊さない） */
export function renderHeadTags(tags: readonly HeadTag[]): string {
  return tags
    .map((tag) => {
      if (tag.kind === "script") {
        try {
          if (new URL(tag.src).protocol !== "https:") return "";
        } catch {
          return "";
        }
        return `<script async src="${escAttr(tag.src)}"></script>`;
      }
      return /<\/script|<!--/i.test(tag.code) ? "" : `<script>${tag.code}</script>`;
    })
    .join("");
}

/** HTML の </head> の前に差し込む（無ければそのまま） */
export function injectHead(html: string, snippet: string): string {
  const i = html.indexOf("</head>");
  return i < 0 || !snippet ? html : html.slice(0, i) + snippet + html.slice(i);
}
