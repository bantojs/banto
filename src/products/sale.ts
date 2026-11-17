/**
 * 商品を買えるか（買えない理由）。メンテナの決定 2026-11-17、docs/storefront.md「発売日と公開日」。
 *   - members_only: 会員限定の商品（0098）で、見る人が条件に合わない（会員は DB の product_member_* が判定、ゲストは条件のある商品は買えない）
 *   - coming_soon: 発売日（products.released_at、0146）が未来（0148）。お店には見えるが、カートに入れられない
 * カートの値付け（src/commerce/checkout.ts の priceCart）・カートに入れる口・テーマ・ヘッドレスはここの答えだけを使う。
 * DB でも同じ判定をする（reserve_stock・tryon_request、0148）
 */
export type PurchaseBlock = "members_only" | "coming_soon";

/** 発売日が未来か（無い・読めない日付は発売済み） */
export function comingSoon(p: { released_at?: string | null }, now: number = Date.now()): boolean {
  if (!p.released_at) return false;
  const at = Date.parse(p.released_at);
  return Number.isFinite(at) && at > now;
}

/** 買えない理由（買えれば null）。audienceOk は会員の条件の判定（会員は DB の答え、ゲストは条件の無い商品だけ true） */
export function purchaseBlockOf(p: { released_at?: string | null }, audienceOk: boolean, now: number = Date.now()): PurchaseBlock | null {
  if (comingSoon(p, now)) return "coming_soon";
  if (!audienceOk) return "members_only";
  return null;
}
