/**
 * 本文の最初の画像を「すぐ読む」にする（主な表示 LCP を早めるため）。
 *
 * ページ・記事・ひな形（お店のトップ・商品詳細・商品一覧・ブログの一覧・法務）の本文は、描いた画像をすべて loading="lazy" で出す。
 * いちばん上のカバーや大きな写真まで遅れて読まれるので、本文がそのページの主な中身のときだけ、文書の順で最初の画像を
 * loading="eager" fetchpriority="high" にする。決まりは 1 つ（どのテーマ・既定のテーマ・Liquid でも同じ）:
 *
 * - 最初に出会った <img> だけを見る。それが lazy でない（部品のアイキャッチ・商品の画像のように、もともとすぐ読む）なら何もしない
 *   （先に出る画像がもう主な画像なので、後ろの画像を上げない）
 * - すでに fetchpriority を持つ画像（テーマの snippet が決めたもの）は変えない
 * - <script>・<template>・閉じた <details>（アコーディオン）の中は数えない（見えない画像を急がせない）
 *
 * 描いた HTML の文字の置き換えだけで、DB にもキャッシュの鍵にも触らない。アイキャッチを本文の上に出すページは呼ぶ側が使わない。
 */
const SCAN = /<(script|template)\b[\s\S]*?<\/\1\s*>|<details\b(?![^>]*\sopen\b)[\s\S]*?<\/details\s*>|<img\b[^>]*>/gi;

export function promoteLeadImage(html: string): string {
  SCAN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCAN.exec(html))) {
    const tag = m[0];
    if (!/^<img\b/i.test(tag)) continue;
    if (!/\sloading=["']?lazy\b/i.test(tag) || /\sfetchpriority=/i.test(tag)) return html;
    const next = tag.replace(/\sloading=["']?lazy["']?/i, ' loading="eager" fetchpriority="high"');
    return html.slice(0, m.index) + next + html.slice(m.index + tag.length);
  }
  return html;
}
