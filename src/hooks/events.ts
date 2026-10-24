/** コアが送る hooks の一覧（CLAUDE.md §5）。プラグインはこの中から購読する */
export const HOOK_EVENTS = [
  "order.created",
  "order.paid",
  "order.shipped",
  "order.cancelled",
  // 会員（0047 のトリガーで積む。ペイロードは customer_id / shop_id / external_ref だけ。docs/knowledge/13-external-customer-master.md）
  "customer.created",
  "customer.updated",
  "customer.deleted",
  "product.updated",
  "inventory.low",
  // お店で試着（同梱モジュール store_tryon、0025）: 申し込み・状態の変化（status: sent / ready / purchased / not_purchased / expired / cancelled）
  "tryon.requested",
  "tryon.updated",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export function isHookEvent(s: string): s is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(s);
}

/** 送信ボディ。個人情報は入れない（必要ならプラグインがヘッドレス API で取る） */
export interface HookEnvelope {
  id: string;
  event: HookEvent | string;
  created_at: string;
  shop_id: string;
  attempt: number;
  data: Record<string, unknown>;
}
