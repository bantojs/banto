/**
 * WooCommerce から取り込む画像の置き場所のキー。URL から決めるので、同じ画像を 2 回取り込まない
 * （管理画面の /images と、裏で取り込む Cron の両方が使う）。
 */

/** URL → 取り込み済みかを見分けるためのキーの一部（FNV-1a） */
export function urlHash(url: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** キーに含まれる目印（拡張子は取得してみるまで分からないので、ここまでで見分ける） */
export const wcImageTag = (url: string) => `/wc-${urlHash(url)}.`;

export const wcImageKey = (shopId: string, productId: string, url: string, ext: string) => `shops/${shopId}/products/${productId}/wc-${urlHash(url)}.${ext}`;
