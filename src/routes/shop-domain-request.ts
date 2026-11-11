/**
 * ショップの独自ドメインとして振り分けたリクエストの印（src/routes/storefront/domain.ts の shopDomainRouting が付ける）。
 * Host の形ではなく「DB に登録されたショップのドメインとして振り分けたか」で決めるため、振り分けで作り直したリクエストに
 * そのショップのドメインを結んでおく（WeakMap なので、リクエストが終われば消える）。
 * common.ts と domain.ts の両方から使うので、どちらにも依らない小さなモジュールに置く
 */
const shopDomains = new WeakMap<Request, string>();

/** 振り分けで作ったリクエストに、そのショップのドメインを結ぶ */
export function markShopDomainRequest(req: Request, domain: string): void {
  shopDomains.set(req, domain);
}

/** ショップの独自ドメインとして振り分けたリクエストなら、そのショップのドメイン（登録された値）。ほかは null */
export function shopDomainOfRequest(req: Request): string | null {
  return shopDomains.get(req) ?? null;
}
