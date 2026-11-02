/**
 * 本文の「見せる相手」の囲み（同梱モジュール audiences、0097。メンテナの決定 2026-11-02、docs/audiences.md「本文のブロック」）。
 *
 *   ::: audience id=<条件の id> title="ゴールド会員"
 *   ゴールド会員の方だけに見える文
 *   :::
 *
 * - HTML にする **前に** 本文から取り除く（見せない相手には、中身が HTML にも生の本文にも残らない）。
 *   お店の画面（既定のテーマ・Liquid）とヘッドレスの公開 API の両方がここを通る
 * - 合えば囲みの行だけを外して中身を残す。合わない・条件が無い・モジュールが OFF なら閉じの行まで消す（分からなければ見せない）
 * - 入れ子はレイアウトの囲みと同じ数え方（src/pages/layout.ts の layoutEnd）。閉じずに終わった囲みは最後まで
 * - 判定は画面の写し（src/members/audience.ts の audienceOk、Cookie に入れた独自項目の値）。中身は読み物の出し分けで、
 *   お金と在庫は関わらない（買える・単価は DB が判定する。0098・0099）
 */
import { isLayoutClose, parseAudienceOpen, parseLayoutOpen } from "../pages/layout";
import { audienceOk, type AudienceContext } from "../members/audience";

/** お店の画面で使う条件（shop_audiences_render の 1 件） */
export interface RenderAudience {
  id: string;
  name: string;
  condition: unknown;
}

const HAS = /^\s{0,3}:{3,}\s*audience\b/m;

/** 本文に見せる相手の囲みがあるか（無ければ条件を取りに行かない） */
export const hasAudienceBlocks = (body: string | null | undefined): boolean => Boolean(body) && HAS.test(body!);

/**
 * 見る人に合わせて囲みを外す。show(id) が真なら中身を残す。
 * key は残した囲みの id（重ねずに並べたもの）。HTML のキャッシュをこの組み合わせごとに分ける
 */
export function filterAudienceBlocks(body: string, show: (id: string) => boolean): { body: string; key: string } {
  if (!hasAudienceBlocks(body)) return { body, key: "" };
  const rows = body.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  // 開いている囲み: 見せる相手（残す / 消す）か、レイアウトの囲み
  const stack: ("keep" | "hide" | "layout")[] = [];
  let hidden = 0;
  const shown = new Set<string>();
  for (const row of rows) {
    const ao = parseAudienceOpen(row);
    if (ao) {
      const keep = hidden === 0 && ao.id !== null && show(ao.id);
      if (keep) shown.add(ao.id!);
      else hidden++;
      stack.push(keep ? "keep" : "hide");
      continue;
    }
    if (parseLayoutOpen(row)) {
      stack.push("layout");
      if (hidden === 0) out.push(row);
      continue;
    }
    if (isLayoutClose(row)) {
      const top = stack.pop();
      if (top === "hide") hidden--;
      else if (top !== "keep" && hidden === 0) out.push(row);
      continue;
    }
    if (hidden === 0) out.push(row);
  }
  return { body: out.join("\n"), key: [...shown].sort().join(",") };
}

/** だれにも見せない形（ゲストとして）。一覧の抜粋・RSS など、見る人を決めずに本文の文字を使うところ */
export const stripAudienceBlocks = (body: string): string => filterAudienceBlocks(body, () => false).body;

/** 条件の一覧と見る人から「この id を見せるか」を作る。一覧に無い id は見せない */
export function audienceShow(list: readonly RenderAudience[], viewer: AudienceContext): (id: string) => boolean {
  const memo = new Map<string, boolean>();
  const byId = new Map(list.map((a) => [a.id, a]));
  return (id) => {
    let v = memo.get(id);
    if (v === undefined) {
      const a = byId.get(id);
      v = a ? audienceOk(a.condition, viewer) : false;
      memo.set(id, v);
    }
    return v;
  };
}

/** 見る人が合う条件の名前（Liquid の customer.audiences） */
export const matchedAudienceNames = (list: readonly RenderAudience[], viewer: AudienceContext): string[] => list.filter((a) => audienceOk(a.condition, viewer)).map((a) => a.name);
