/**
 * service_role を使う唯一のモジュール（CLAUDE.md §1-3）。
 * ここから呼べるのは在庫 RPC・注文確定・Webhook 処理・Cron ジョブだけ。
 * 新しい関数を追加するときは、必ず shop_id を引数に取り、RPC 側で検証すること。
 * テーブルを直接読み書きする汎用メソッドは意図的に用意しない。
 */
import { AuthError } from "../auth/supabase";

export interface PrivilegedDbOptions {
  url: string;
  serviceRoleKey: string;
  fetch?: typeof fetch;
  /**
   * 監査ログに残す「誰が」（0051、src/audit/index.ts の actorHeader）。運営者の操作がこの特権経路を通るとき
   * （管理画面のキャンセル = 返金 → cancel_order）に "user:<uuid>" を渡す。Webhook・Cron は渡さない（system）
   */
  actor?: string;
}

export class PrivilegedRpcError extends Error {
  constructor(
    public readonly fn: string,
    public readonly status: number,
    /** PostgreSQL の例外メッセージ（例: insufficient_stock） */
    public readonly dbMessage: string,
    public readonly details?: string,
  ) {
    super(`RPC ${fn} ${status}: ${dbMessage}`);
    this.name = "PrivilegedRpcError";
  }
  is(name: string): boolean {
    return this.dbMessage === name || this.dbMessage.startsWith(`${name}`);
  }
}

export interface ReserveItem {
  sku_id: string;
  qty: number;
}

export interface OrderInput {
  customer_email?: string | null;
  customer_name?: string | null;
  shipping_address?: Record<string, unknown> | null;
  payment_provider: string;
  payment_ref: string;
  /** 決済事業者が受け取った額（照合用。Banto の計算と違えば confirm_reservation が amount_mismatch で確定しない、0029） */
  amount_paid_jpy?: number | null;
  /** 決済事業者の通貨（jpy 以外なら amount_mismatch） */
  currency?: string | null;
}

/** 在庫予約の上限の材料（0029）。quote は 1 回限り、同じ人・同じ IP の未確定の予約に上限 */
export interface ReserveLimits {
  quoteId: string | null;
  subjectHash: string | null;
  ipHash: string | null;
}

/** apply_reservation_discounts に渡す値引き（金額は src/commerce/discounts.ts が計算したもの） */
export interface ReservationDiscounts {
  total_jpy: number;
  lines: { sku_id: string; discount_jpy: number }[];
  applied: { campaign_id: string; code: string; name: string; kind: string; amount_jpy: number }[];
}

export interface HookDeliveryRow {
  id: string;
  shop_id: string;
  endpoint_id: string;
  event: string;
  payload: Record<string, unknown>;
  attempts: number;
  url: string;
  settings: Record<string, string | boolean>;
  created_at: string;
}

export interface ReservationCustomer extends Omit<OrderInput, "payment_provider" | "payment_ref"> {
  shipping_jpy?: number;
  /** 配送の指定（0018、同梱モジュール delivery_time） */
  delivery?: { date: string | null; slot: string | null };
  customer_id?: string;
  /** 会員のセッションの世代（0012）。customer_id があるときは必須。今の世代と違えば member_session_invalid */
  customer_epoch?: number;
}

/** 会員のマイクーポン（0019 の member_coupons） */
export interface MemberCoupon {
  code: string;
  name: string;
  kind: "percent" | "fixed" | "free_shipping";
  value: number;
  expires_at: string | null;
}

/** パスワード（0013）・LINE（0014）でのログインの結果 */
export type MemberLoginResult =
  | { ok: true; customer_id: string; session_epoch: number; email: string | null; created?: boolean; linked?: boolean; /** パスワードでのログインの知らせの送信元（0016。無ければ送らない） */ mail_from?: string | null }
  | { ok: false; reason: "invalid" | "locked" | "disabled" | "already_linked" | "other_linked" | "session" | "expired" };

/** 会員のログイン（0012_member_auth） */
export interface MemberLoginStart {
  send: boolean;
  challenge_id: string;
  mail_from: string;
}
export type MemberLoginVerify =
  | { ok: true; customer_id: string; session_epoch: number; email: string; created: boolean; return_to: string | null }
  | { ok: false; reason: "invalid" | "expired" | "limit" };
/** 会員のセッション（0045_member_sessions）。端末ごとに 1 行 */
export interface MemberSessionRow {
  id: string;
  kind: "web" | "api";
  /** 端末の目安（「Chrome / macOS」）。無ければ null */
  label: string | null;
  created_at: string;
  last_seen_at: string;
}
/** パスキー（0046_mod_passkey） */
export type PasskeyBegin =
  | { ok: true; challenge_id: string; rp_id: string; user?: { email: string | null; name: string | null }; exclude?: string[] }
  | { ok: false; reason: "disabled" | "limited" | "session" | "reauth" | "too_many" };
export interface PasskeyRow {
  id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  backed_up: boolean;
  /** ショップの今のドメインで使えるか（ドメインを変えると使えなくなる） */
  usable: boolean;
}
export type MemberSessionRefresh = { ok: true; gen: number; expires_at: string } | { ok: false; reason: "invalid" | "reuse" };
export interface MemberRecord {
  customer: {
    id: string;
    shop_id: string;
    email: string | null;
    name: string | null;
    default_address: Record<string, unknown> | null;
    /** 0013 から: パスワード（WordPress から取り込んだものを含む）があるか */
    has_password?: boolean;
    /** 0014 から: 結びついた外部アカウント（["line"]） */
    providers?: string[];
    /** 0050 から: 「お得な情報やセールの案内を受け取る」（null = 未回答） */
    marketing_consent?: boolean | null;
  };
  orders: Record<string, unknown>[];
}

/** 会員の試着の申し込み（0026 の member_tryon_requests） */
export interface MemberTryonRequest {
  number: number;
  status: string;
  store_id: string;
  store_name: string;
  visit_date: string | null;
  hold_until: string | null;
  created_at: string;
  items: { name: string | null; sku: string | null; qty: number }[];
}

export interface PrivilegedDb {
  /** 在庫を原子的に減算して予約を作る。在庫不足なら insufficient_stock */
  reserveStock(shopId: string, items: ReserveItem[], ttlSeconds: number, limits?: ReserveLimits | null): Promise<string>;
  /** 予約を注文に変換（冪等）。戻り値は order id */
  confirmReservation(reservationId: string, shopId: string, order: OrderInput): Promise<string>;
  /** 予約に購入者情報・送料・会員 ID を一時保持させる（確定時に orders へ移る） */
  attachReservationCustomer(reservationId: string, shopId: string, customer: ReservationCustomer): Promise<void>;
  /** クーポンのコードからキャンペーンを引く（0010）。subject があればその人の使用回数も返す */
  /** customerId は 0049 が当たっているときだけ渡す（関数の引数が増えるのは 0049 から） */
  couponLookup(shopId: string, codes: string[], subject: string | null, customerId?: string | null): Promise<unknown[]>;
  /** 予約に値引きを付け、クーポンの回数（全体・1 人あたり）を原子的に予約する。取れなければ coupon_* で失敗し、何も変えない */
  applyReservationDiscounts(reservationId: string, shopId: string, subject: string, discounts: ReservationDiscounts): Promise<void>;
  /** 会員の取り込み（0012）: メールアドレスで引いて無ければ作る / 足りない項目だけ埋める。呼び出し側が owner の所有を確かめてから呼ぶ */
  importMembers(shopId: string, rows: { email: string; name: string | null; default_address: Record<string, unknown> | null }[]): Promise<{ created: number; updated: number; skipped: number }>;
  /** 会員のログインを始める（0012）。HMAC の値だけを渡す。回数の上限を超えたら send = false */
  memberLoginStart(shopId: string, email: string, codeHash: string, linkHash: string, ipHash: string | null, returnTo: string | null): Promise<MemberLoginStart>;
  /** コードかリンクのトークンを照合する（0012）。成功したら会員を返す（初回なら作る） */
  memberLoginVerify(shopId: string, challengeId: string, codeHash: string | null, linkHash: string | null): Promise<MemberLoginVerify>;
  /** メールのリンクの確認画面に出すアドレス（使わない）。合わなければ null */
  memberLoginPeek(shopId: string, challengeId: string, linkHash: string): Promise<string | null>;
  /** ログイン中の会員（世代が違えば null） */
  memberGet(shopId: string, customerId: string, epoch: number, withOrders: boolean): Promise<MemberRecord | null>;
  /** ショップごとの秘密の暗号文（0021。今は line_messaging だけ）。無ければ null */
  shopSecret(shopId: string, purpose: "line_messaging"): Promise<string | null>;
  /** 注文を LINE で知らせる相手（0021）。会員の注文で LINE と結びついているときだけ */
  orderLineRecipient(orderId: string, shopId: string): Promise<{ line_user_id: string; number: number; total_jpy: number; shop_name: string; status: string } | null>;
  /** お店で試着の申し込み（0025）。在庫を減らし、番号を返す */
  tryonRequest(shopId: string, storeId: string, items: { sku_id: string; qty: number }[], customer: Record<string, unknown>, visitDate: string | null): Promise<{ id: string; number: number }>;
  /** 試着の申し込みのお知らせ用（メール通知プラグイン） */
  tryonContact(requestId: string, shopId: string): Promise<Record<string, unknown>>;
  /** 試着の申し込みの LINE の送り先（LINE でログインした会員のときだけ） */
  tryonLineRecipient(requestId: string, shopId: string): Promise<{ line_user_id: string; number: number; status: string; hold_until: string | null; store_name: string; shop_name: string } | null>;
  /** 会員の試着の申し込み（0026、新しい順に 50 件）。世代が合わなければ null */
  memberTryonRequests(shopId: string, customerId: string, epoch: number): Promise<MemberTryonRequest[] | null>;
  /** 会員が自分の申し込みを取り消す（0026。取り置きが終わる前だけ） */
  memberTryonCancel(shopId: string, customerId: string, epoch: number, number: number): Promise<{ ok: true } | { ok: false; reason: "session" | "not_found" | "not_cancellable" }>;
  /** 取り置きの期限切れ（Cron。today はショップの時間帯の日付） */
  tryonExpire(today: string): Promise<number>;
  /** 終わった試着の申し込みの個人情報を消す（Cron） */
  maskTryonRequests(days: number): Promise<number>;
  /** 組織への招待のリンクを開いたとき（0024）。token_hash は SHA-256。無ければ null */
  orgInvitationPeek(tokenHash: string): Promise<{ email: string; org_name: string; role: string; valid: boolean; user_exists: boolean } | null>;
  /** 先着のクーポンを獲得する（0020） */
  memberClaimCoupon(shopId: string, customerId: string, epoch: number, campaignId: string): Promise<{ ok: true; code: string | null } | { ok: false; reason: "session" | "unavailable" | "already" | "exhausted" }>;
  /** 会員のマイクーポン（0019、使えるものだけ）。世代が合わなければ null */
  memberCoupons(shopId: string, customerId: string, epoch: number): Promise<MemberCoupon[] | null>;
  /** 会員の注文 1 件（0017、領収書。lookup_order と同じ形）。世代が合わない・無ければ null */
  memberOrder(shopId: string, customerId: string, epoch: number, number: number): Promise<Record<string, unknown> | null>;
  memberSaveAddress(shopId: string, customerId: string, epoch: number, name: string | null, address: Record<string, unknown>): Promise<boolean>;
  /** 「お得な情報やセールの案内を受け取る」を本人が変える（0050。世代を確かめる） */
  memberSetMarketingConsent(shopId: string, customerId: string, epoch: number, consent: boolean): Promise<boolean>;
  memberWithdraw(shopId: string, customerId: string, epoch: number): Promise<boolean>;
  memberLogoutAll(shopId: string, customerId: string, epoch: number): Promise<boolean>;
  /** パスワードでログインする（0013）。照合・回数の制限は DB。パスワードは保存しない・ログに出さない */
  memberPasswordLogin(shopId: string, email: string, password: string, ipHash: string | null): Promise<MemberLoginResult>;
  /** パスワードを決める・変える（0013）。新しい世代を返す（世代が合わなければ null） */
  memberSetPassword(shopId: string, customerId: string, epoch: number, password: string): Promise<number | null>;
  /** WordPress のパスワードの取り込み（0013、bcrypt の形式だけ）。呼び出し側が owner の所有を確かめてから呼ぶ */
  importMemberPasswords(shopId: string, rows: { email: string; hash: string }[]): Promise<Record<string, number>>;
  /** 外部のアカウントでログインする（0014）。link があればログイン中のその会員に結びつける */
  memberOauthLogin(shopId: string, provider: "line" | "google", subject: string, email: string | null, emailVerified: boolean, link: { customerId: string; epoch: number } | null): Promise<MemberLoginResult>;
  memberUnlinkIdentity(shopId: string, customerId: string, epoch: number, provider: "line" | "google"): Promise<boolean>;
  /** ショップごとの提供元の設定（0014）。secret_box は暗号文（src/members/secret-box.ts で開く）。無ければ null */
  shopOauthClient(shopId: string, provider: "line" | "google"): Promise<{ client_id: string; secret_box: string } | null>;
  /** ヘッドレスの引き換え券（0014、2 分・1 回限り） */
  memberHandoffCreate(shopId: string, customerId: string, epoch: number, tokenHash: string): Promise<string>;
  memberHandoffRedeem(shopId: string, id: string, tokenHash: string): Promise<MemberLoginResult>;
  /** 期限切れのチャレンジを消す（Cron） */
  memberLoginCleanup(): Promise<number>;
  /** 会員のセッション（0045）。作る: 世代が今と違えば null */
  memberSessionStart(shopId: string, customerId: string, epoch: number, kind: "web" | "api", label: string | null, ttlSeconds: number): Promise<string | null>;
  /** Cookie のセッションが生きているか（最後に使った日時も更新する） */
  memberSessionCheck(shopId: string, customerId: string, epoch: number, sessionId: string): Promise<boolean>;
  /** ヘッドレスの refresh を回す。使い回しならその行を取り消して reuse */
  memberSessionRefresh(shopId: string, customerId: string, epoch: number, sessionId: string, gen: number): Promise<MemberSessionRefresh>;
  /** 取り消す（logout: 自分の端末 / revoked: 一覧から別の端末） */
  memberSessionRevoke(shopId: string, customerId: string, epoch: number, sessionId: string, reason: "logout" | "revoked"): Promise<boolean>;
  /** ログイン中の端末。世代が合わなければ null */
  memberSessionsList(shopId: string, customerId: string, epoch: number): Promise<MemberSessionRow[] | null>;
  /** 終わったセッションを消す（Cron） */
  memberSessionCleanup(): Promise<number>;
  /** パスキーの challenge を出す（0046）。register はログインしてから 15 分以内のセッションだけ */
  memberPasskeyBegin(shopId: string, purpose: "login" | "register", challengeHash: string, ipHash: string | null, member?: { customerId: string; epoch: number; sessionId: string }): Promise<PasskeyBegin>;
  memberPasskeyRegister(
    shopId: string,
    challengeId: string,
    challengeHash: string,
    member: { customerId: string; epoch: number; sessionId: string },
    key: { credentialId: string; publicKey: string; alg: number; signCount: number; rpId: string; backedUp: boolean; label: string | null },
  ): Promise<{ ok: true; id: string; email: string | null; mail_from: string | null } | { ok: false; reason: "expired" | "session" | "reauth" | "duplicate" | "too_many" | "disabled" }>;
  /** 署名を確かめるための公開鍵（今のドメインで登録したものだけ）。無ければ null */
  memberPasskeyLookup(shopId: string, credentialId: string): Promise<{ id: string; customer_id: string; public_key: string; alg: number } | null>;
  memberPasskeyLogin(shopId: string, challengeId: string, challengeHash: string, passkeyId: string, signCount: number, backedUp: boolean): Promise<MemberLoginResult | { ok: false; reason: "counter" }>;
  memberPasskeysList(shopId: string, customerId: string, epoch: number): Promise<PasskeyRow[] | null>;
  memberPasskeyDelete(shopId: string, customerId: string, epoch: number, id: string): Promise<boolean>;
  /** 期限切れの challenge を消す（Cron） */
  memberPasskeyCleanup(): Promise<number>;
  /** 返金に必要な情報（キャンセル処理の前段） */
  orderPaymentInfo(orderId: string, shopId: string): Promise<{ order_id: string; status: string; payment_provider: string | null; payment_ref: string | null; total_jpy: number } | null>;
  /** キャンセル: 在庫を戻し cancelled / refunded にする（返金は呼び出し側が先に行う） */
  cancelOrder(orderId: string, shopId: string, refunded: boolean): Promise<{ order_id: string; status: string; already: boolean }>;
  /** 取引メール用の連絡先と明細（同梱メールプラグイン専用） */
  orderContact(orderId: string, shopId: string): Promise<Record<string, unknown>>;
  /** 予約を解放（pending のときだけ）。戻り値: 解放したか */
  releaseReservation(reservationId: string, shopId: string): Promise<boolean>;
  /** TTL 切れ予約の一括解放（Cron） */
  releaseExpiredReservations(): Promise<number>;
  /** Webhook の冪等化。初見なら true */
  recordWebhookEvent(provider: string, eventId: string): Promise<boolean>;
  /** 発送から p_days 日経過した注文の個人情報をマスク（Cron） */
  maskShippedOrders(days?: number): Promise<number>;
  /** 監査ログの保持（0051）。既定 365 日より古い行を消す（30 日より短くはならない）。戻り値: 消した行数 */
  pruneAuditLog(days?: number): Promise<number>;
  /** hooks: 配信待ちを取り出す（リース付き） */
  claimHookDeliveries(limit: number): Promise<HookDeliveryRow[]>;
  /** hooks: 配信結果を記録（失敗は DB 側でバックオフ） */
  finishHookDelivery(id: string, success: boolean, status: number | null, error: string | null): Promise<void>;
  /** hooks: service_role からイベントを積む（Webhook 処理等） */
  enqueueHook(shopId: string, event: string, payload: Record<string, unknown>): Promise<number>;
  /** Cron の生存記録（/health が読む） */
  recordHeartbeat(name: string): Promise<void>;
  /**
   * バックアップ JSON（export.json の tables）を空のショップに復元する。id は振り直す。
   * 呼び出し側（管理画面）が owner JWT で shop の所有を確認してから呼ぶこと。戻り値はテーブルごとの件数。
   */
  restoreShopData(shopId: string, tables: Record<string, unknown[]>): Promise<Record<string, number>>;
  /** restore_shop_data の後に呼ぶ: 商品のタグを slug で突き合わせて戻す（0007_tags.sql） */
  restoreProductTags(shopId: string, products: unknown[]): Promise<number>;
  /** restore_shop_data の後に呼ぶ: カテゴリーと、商品・SKU の拡張列を slug / code で突き合わせて戻す（0008_catalog.sql） */
  restoreCatalog(shopId: string, data: { categories: unknown[]; products: unknown[]; skus: unknown[] }): Promise<Record<string, number>>;
  /** 復元の後で税の区分と注文の税率を戻す（0017） */
  restoreTax(shopId: string, products: unknown[], orders: unknown[]): Promise<Record<string, number>>;
  /** 復元の後でクーポン・注文の値引き・配送の指定・お問い合わせ番号を戻す（0022）。tables は書き出しのまま */
  restoreCommerce(shopId: string, tables: Record<string, unknown>): Promise<Record<string, number>>;
  /** 復元の後で取り込み元の ID・明細の品名・SKU の無い明細を戻す（0023） */
  restoreHistory(shopId: string, tables: Record<string, unknown>): Promise<Record<string, number>>;
  /** 復元の後で会員の外部の ID と独自項目を戻す（0047）。customers は書き出しのまま */
  restoreCustomerMaster(shopId: string, customers: unknown[]): Promise<Record<string, number>>;
  /**
   * AI 用トークン経由の操作（docs/ai-access.md）。呼べるのは api_* だけで、各 RPC が SQL 側で
   * トークン・スコープ・ショップ所有を検証する。p_token_hash は Worker で SHA-256 にした値。
   */
  /** Stripe Connect の接続先 ID（お客様の画面には渡さない列。決済ページを作るときだけ読む、0028） */
  shopStripeAccount(shopId: string): Promise<string | null>;
  /** 戻り先の画面のための注文の状態（0035。quote の識別子で引く。個人情報は返さない） */
  checkoutStatus(shopId: string, quoteId: string): Promise<CheckoutStatusResult>;
  /** ショップの settings.headless（中継元の IP を含む。公開の settings には無い、0034）。X-Banto-Client-IP が付いた通信のときだけ読む */
  shopHeadless(shopId: string): Promise<Record<string, unknown> | null>;
  /** 管理者ログインの回数の制限（0030）。Supabase に問い合わせる前に確かめ、結果を記録する */
  adminLoginCheck(emailHash: string, ipHash: string | null): Promise<{ allowed: boolean; retry_after_seconds?: number }>;
  adminLoginRecord(emailHash: string, ipHash: string | null, success: boolean): Promise<void>;
  apiRpc<T>(fn: `api_${string}`, args: Record<string, unknown>): Promise<T>;
  /** 画像を裏で取り込む（同梱モジュール woo_import、0039）。Cron が期限の来た分を取り出し、結果を書く */
  imageImportClaim(): Promise<ImageImportJob[]>;
  imageImportFinish(results: ({ id: number; storage_key: string } | { id: number; error: string })[]): Promise<{ done: number; retry: number; failed: number }>;
}

export interface ImageImportJob {
  id: number;
  shop_id: string;
  product_id: string;
  url: string;
}

/** checkout_status（0035）の応答。confirmed のときだけ order が入る */
export interface CheckoutStatusResult {
  status: "pending" | "confirmed" | "released" | "not_found";
  order: { number: number; status: string; total_jpy: number; payment_provider: string | null; created_at: string } | null;
  expires_at: string | null;
}

export function createPrivilegedDb(opts: PrivilegedDbOptions): PrivilegedDb {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.url.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    apikey: opts.serviceRoleKey,
    Authorization: `Bearer ${opts.serviceRoleKey}`,
    "Content-Type": "application/json",
  };
  if (opts.actor) headers["X-Banto-Actor"] = opts.actor;

  async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const res = await doFetch(`${base}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(args) });
    if (!res.ok) {
      const text = await res.text();
      let message = text;
      let details: string | undefined;
      try {
        const j = JSON.parse(text) as { message?: string; details?: string; hint?: string };
        message = j.message ?? text;
        details = j.details ?? j.hint;
      } catch {
        /* not JSON */
      }
      throw new PrivilegedRpcError(fn, res.status, message, details);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    reserveStock: (shopId, items, ttlSeconds, limits) =>
      rpc<string>("reserve_stock", {
        p_shop_id: shopId, p_items: items, p_ttl_seconds: ttlSeconds,
        // 0029 より前の DB には渡さない（引数の名前が合わず関数が見つからない）。呼び出し側が migrated() で決める
        ...(limits ? { p_quote_id: limits.quoteId, p_subject_hash: limits.subjectHash, p_ip_hash: limits.ipHash } : {}),
      }),
    confirmReservation: (reservationId, shopId, order) =>
      rpc<string>("confirm_reservation", { p_reservation_id: reservationId, p_shop_id: shopId, p_order: order }),
    attachReservationCustomer: (reservationId, shopId, customer) =>
      rpc<void>("attach_reservation_customer", { p_reservation_id: reservationId, p_shop_id: shopId, p_customer: customer }),
    couponLookup: (shopId, codes, subject, customerId) => rpc("coupon_lookup", { p_shop_id: shopId, p_codes: codes, p_subject: subject, ...(customerId ? { p_customer_id: customerId } : {}) }),
    importMembers: (shopId, rows) => rpc("import_members", { p_shop_id: shopId, p_rows: rows }),
    memberLoginStart: (shopId, email, codeHash, linkHash, ipHash, returnTo) =>
      rpc("member_login_start", { p_shop_id: shopId, p_email: email, p_code_hash: codeHash, p_link_hash: linkHash, p_ip_hash: ipHash, p_return_to: returnTo }),
    memberLoginVerify: (shopId, challengeId, codeHash, linkHash) =>
      rpc("member_login_verify", { p_shop_id: shopId, p_challenge_id: challengeId, p_code_hash: codeHash, p_link_hash: linkHash }),
    memberLoginPeek: (shopId, challengeId, linkHash) => rpc("member_login_peek", { p_shop_id: shopId, p_challenge_id: challengeId, p_link_hash: linkHash }),
    memberGet: (shopId, customerId, epoch, withOrders) => rpc("member_get", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch, p_with_orders: withOrders }),
    shopSecret: (shopId, purpose) => rpc("shop_secret", { p_shop_id: shopId, p_purpose: purpose }),
    orderLineRecipient: (orderId, shopId) => rpc("order_line_recipient", { p_order_id: orderId, p_shop_id: shopId }),
    tryonRequest: (shopId, storeId, items, customer, visitDate) => rpc("tryon_request", { p_shop_id: shopId, p_store_id: storeId, p_items: items, p_customer: customer, p_visit_date: visitDate }),
    orgInvitationPeek: (tokenHash) => rpc("org_invitation_peek", { p_token_hash: tokenHash }),
    memberTryonRequests: (shopId, customerId, epoch) => rpc("member_tryon_requests", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch }),
    memberTryonCancel: (shopId, customerId, epoch, number) => rpc("member_tryon_cancel", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch, p_number: number }),
    tryonContact: (requestId, shopId) => rpc("tryon_contact", { p_request_id: requestId, p_shop_id: shopId }),
    tryonLineRecipient: (requestId, shopId) => rpc("tryon_line_recipient", { p_request_id: requestId, p_shop_id: shopId }),
    tryonExpire: (today) => rpc("tryon_expire", { p_today: today }),
    maskTryonRequests: (days) => rpc("mask_tryon_requests", { p_days: days }),
    memberClaimCoupon: (shopId, customerId, epoch, campaignId) => rpc("member_claim_coupon", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch, p_campaign_id: campaignId }),
    memberCoupons: (shopId, customerId, epoch) => rpc("member_coupons", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch }),
    memberOrder: (shopId, customerId, epoch, number) => rpc("member_order", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch, p_number: number }),
    memberSetMarketingConsent: (shopId, customerId, epoch, consent) => rpc<boolean>("member_set_marketing_consent", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch, p_consent: consent }),
    memberSaveAddress: (shopId, customerId, epoch, name, address) =>
      rpc("member_save_address", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch, p_name: name, p_address: address }),
    memberWithdraw: (shopId, customerId, epoch) => rpc("member_withdraw", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch }),
    memberLogoutAll: (shopId, customerId, epoch) => rpc("member_logout_all", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch }),
    memberLoginCleanup: () => rpc<number>("member_login_cleanup", {}),
    imageImportClaim: () => rpc<ImageImportJob[]>("image_import_claim", {}),
    imageImportFinish: (results) => rpc("image_import_finish", { p_results: results }),
    memberPasswordLogin: (shopId, email, password, ipHash) => rpc("member_password_login", { p_shop_id: shopId, p_email: email, p_password: password, p_ip_hash: ipHash }),
    memberSetPassword: (shopId, customerId, epoch, password) => rpc("member_set_password", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch, p_password: password }),
    importMemberPasswords: (shopId, rows) => rpc("import_member_passwords", { p_shop_id: shopId, p_rows: rows }),
    memberOauthLogin: (shopId, provider, subject, email, emailVerified, link) =>
      rpc("member_oauth_login", { p_shop_id: shopId, p_provider: provider, p_subject: subject, p_email: email, p_email_verified: emailVerified, p_link_customer_id: link?.customerId ?? null, p_link_epoch: link?.epoch ?? null }),
    memberUnlinkIdentity: (shopId, customerId, epoch, provider) => rpc("member_unlink_identity", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch, p_provider: provider }),
    shopOauthClient: (shopId, provider) => rpc("shop_oauth_client", { p_shop_id: shopId, p_provider: provider }),
    memberHandoffCreate: (shopId, customerId, epoch, tokenHash) => rpc("member_handoff_create", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch, p_token_hash: tokenHash }),
    memberHandoffRedeem: (shopId, id, tokenHash) => rpc("member_handoff_redeem", { p_shop_id: shopId, p_id: id, p_token_hash: tokenHash }),
    memberSessionStart: (shopId, customerId, epoch, kind, label, ttlSeconds) =>
      rpc("member_session_start", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch, p_kind: kind, p_label: label, p_ttl_seconds: ttlSeconds }),
    memberSessionCheck: (shopId, customerId, epoch, sessionId) => rpc("member_session_check", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch, p_session_id: sessionId }),
    memberSessionRefresh: (shopId, customerId, epoch, sessionId, gen) =>
      rpc("member_session_refresh", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch, p_session_id: sessionId, p_gen: gen }),
    memberSessionRevoke: (shopId, customerId, epoch, sessionId, reason) =>
      rpc("member_session_revoke", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch, p_session_id: sessionId, p_reason: reason }),
    memberSessionsList: (shopId, customerId, epoch) => rpc("member_sessions_list", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch }),
    memberSessionCleanup: () => rpc<number>("member_session_cleanup", {}),
    memberPasskeyBegin: (shopId, purpose, challengeHash, ipHash, member) =>
      rpc("member_passkey_begin", {
        p_shop_id: shopId,
        p_purpose: purpose,
        p_challenge_hash: challengeHash,
        p_ip_hash: ipHash,
        p_customer_id: member?.customerId ?? null,
        p_epoch: member?.epoch ?? null,
        p_session_id: member?.sessionId ?? null,
      }),
    memberPasskeyRegister: (shopId, challengeId, challengeHash, m, k) =>
      rpc("member_passkey_register", {
        p_shop_id: shopId,
        p_challenge_id: challengeId,
        p_challenge_hash: challengeHash,
        p_customer_id: m.customerId,
        p_epoch: m.epoch,
        p_session_id: m.sessionId,
        p_credential_id: k.credentialId,
        p_public_key: k.publicKey,
        p_alg: k.alg,
        p_sign_count: k.signCount,
        p_rp_id: k.rpId,
        p_backed_up: k.backedUp,
        p_label: k.label,
      }),
    memberPasskeyLookup: (shopId, credentialId) => rpc("member_passkey_lookup", { p_shop_id: shopId, p_credential_id: credentialId }),
    memberPasskeyLogin: (shopId, challengeId, challengeHash, passkeyId, signCount, backedUp) =>
      rpc("member_passkey_login", { p_shop_id: shopId, p_challenge_id: challengeId, p_challenge_hash: challengeHash, p_passkey_id: passkeyId, p_sign_count: signCount, p_backed_up: backedUp }),
    memberPasskeysList: (shopId, customerId, epoch) => rpc("member_passkeys_list", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch }),
    memberPasskeyDelete: (shopId, customerId, epoch, id) => rpc("member_passkey_delete", { p_shop_id: shopId, p_customer_id: customerId, p_epoch: epoch, p_id: id }),
    memberPasskeyCleanup: () => rpc<number>("member_passkey_cleanup", {}),
    async applyReservationDiscounts(reservationId, shopId, subject, discounts) {
      await rpc("apply_reservation_discounts", { p_reservation_id: reservationId, p_shop_id: shopId, p_subject: subject, p_discounts: discounts });
    },
    orderPaymentInfo: (orderId, shopId) => rpc("order_payment_info", { p_order_id: orderId, p_shop_id: shopId }),
    cancelOrder: (orderId, shopId, refunded) => rpc("cancel_order", { p_order_id: orderId, p_shop_id: shopId, p_refunded: refunded }),
    orderContact: (orderId, shopId) => rpc("order_contact", { p_order_id: orderId, p_shop_id: shopId }),
    releaseReservation: (reservationId, shopId) => rpc<boolean>("release_reservation", { p_reservation_id: reservationId, p_shop_id: shopId }),
    releaseExpiredReservations: () => rpc<number>("release_expired_reservations", {}),
    recordWebhookEvent: (provider, eventId) => rpc<boolean>("record_webhook_event", { p_provider: provider, p_event_id: eventId }),
    maskShippedOrders: (days = 180) => rpc<number>("mask_shipped_orders", { p_days: days }),
    pruneAuditLog: (days = 365) => rpc<number>("prune_audit_log", { p_days: days }),
    claimHookDeliveries: (limit) => rpc<HookDeliveryRow[]>("claim_hook_deliveries", { p_limit: limit }),
    finishHookDelivery: (id, success, status, error) =>
      rpc<void>("finish_hook_delivery", { p_id: id, p_success: success, p_status: status, p_error: error }),
    enqueueHook: (shopId, event, payload) => rpc<number>("enqueue_hook", { p_shop_id: shopId, p_event: event, p_payload: payload }),
    recordHeartbeat: (name) => rpc<void>("record_heartbeat", { p_name: name }),
    restoreShopData: (shopId, tables) => rpc<Record<string, number>>("restore_shop_data", { p_shop_id: shopId, p_data: tables }),
    restoreProductTags: (shopId, products) => rpc<number>("restore_product_tags", { p_shop_id: shopId, p_products: products }),
    restoreCatalog: (shopId, data) => rpc<Record<string, number>>("restore_catalog", { p_shop_id: shopId, p_data: data }),
    restoreTax: (shopId, products, orders) => rpc("restore_tax", { p_shop_id: shopId, p_products: products, p_orders: orders }),
    restoreCommerce: (shopId, tables) => rpc("restore_commerce", { p_shop_id: shopId, p_data: tables }),
    restoreHistory: (shopId, tables) => rpc("restore_history", { p_shop_id: shopId, p_data: tables }),
    restoreCustomerMaster: (shopId, customers) => rpc("restore_customer_master", { p_shop_id: shopId, p_data: { customers } }),
    async shopStripeAccount(shopId) {
      // お客様の画面（anon）には渡さない列（0028）。決済ページを作るときだけ service_role で読む
      const res = await doFetch(`${base}/rest/v1/shops?select=stripe_account_id&id=eq.${encodeURIComponent(shopId)}`, { headers });
      if (!res.ok) throw new PrivilegedRpcError("shops.stripe_account_id", res.status, await res.text());
      const rows = (await res.json()) as { stripe_account_id?: string | null }[];
      return rows[0]?.stripe_account_id ?? null;
    },
    checkoutStatus: (shopId, quoteId) => rpc<CheckoutStatusResult>("checkout_status", { p_shop_id: shopId, p_quote_id: quoteId }),
    async shopHeadless(shopId) {
      const res = await doFetch(`${base}/rest/v1/shops?select=settings&id=eq.${encodeURIComponent(shopId)}`, { headers });
      if (!res.ok) throw new PrivilegedRpcError("shops.settings", res.status, await res.text());
      const rows = (await res.json()) as { settings?: Record<string, unknown> | null }[];
      const h = rows[0]?.settings?.["headless"];
      return h && typeof h === "object" && !Array.isArray(h) ? (h as Record<string, unknown>) : null;
    },
    adminLoginCheck: (emailHash, ipHash) => rpc("admin_login_check", { p_email_hash: emailHash, p_ip_hash: ipHash }),
    adminLoginRecord: (emailHash, ipHash, success) => rpc<void>("admin_login_record", { p_email_hash: emailHash, p_ip_hash: ipHash, p_success: success }),
    apiRpc: (fn, args) => {
      if (!/^api_[a-z_]+$/.test(fn)) throw new Error(`apiRpc: not an api_* function: ${fn}`);
      return rpc(fn, args);
    },
  };
}

/**
 * GoTrue の Admin API（service_role）。運営者の初回作成に使う:
 * 確認メールを待たずに「確認済み」ユーザーを作れるので、Supabase の Site URL を直していなくても
 * セットアップが止まらない（確認メールの既定リンク先は http://localhost:3000）。
 * ここ以外で service_role を使わない（CLAUDE.md §1-3）。
 */
export interface PrivilegedAuth {
  /** メール確認済みのユーザーを作る（運営者）。既存なら code = "email_exists" の AuthError */
  createConfirmedUser(email: string, password: string): Promise<{ id: string; email: string }>;
  /**
   * 運営者の二段階認証の登録をすべて消す（0054。認証アプリをなくしたメンバーを、同じ組織の owner / admin が戻すとき）。
   * 呼ぶ前に必ず org_member_mfa_reset_authorize で許可を確かめる（監査ログもそこで書く）。消した数を返す
   */
  deleteAllFactors(userId: string): Promise<number>;
}

export function createPrivilegedAuth(opts: PrivilegedDbOptions): PrivilegedAuth {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.url.replace(/\/+$/, "");
  return {
    async createConfirmedUser(email, password) {
      const res = await doFetch(`${base}/auth/v1/admin/users`, {
        method: "POST",
        headers: { apikey: opts.serviceRoleKey, Authorization: `Bearer ${opts.serviceRoleKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, email_confirm: true }),
      });
      const text = await res.text();
      if (!res.ok) {
        let msg = text;
        let code: string | undefined;
        try {
          const j = JSON.parse(text) as { msg?: string; message?: string; error_code?: string; code?: string | number };
          msg = j.msg ?? j.message ?? text;
          code = j.error_code ?? (typeof j.code === "string" ? j.code : undefined);
        } catch {
          /* プレーンテキスト */
        }
        if (code === "email_exists" || /already (been )?registered|already exists/i.test(msg)) code = "email_exists";
        throw new AuthError(msg, res.status, code);
      }
      const u = JSON.parse(text) as { id: string; email: string };
      return { id: u.id, email: u.email };
    },
    async deleteAllFactors(userId) {
      const headers = { apikey: opts.serviceRoleKey, Authorization: `Bearer ${opts.serviceRoleKey}` };
      const uid = encodeURIComponent(userId);
      const res = await doFetch(`${base}/auth/v1/admin/users/${uid}`, { headers });
      if (!res.ok) throw new AuthError(await res.text(), res.status);
      const user = (await res.json()) as { factors?: { id: string }[] };
      let n = 0;
      for (const f of user.factors ?? []) {
        const del = await doFetch(`${base}/auth/v1/admin/users/${uid}/factors/${encodeURIComponent(f.id)}`, { method: "DELETE", headers });
        if (!del.ok && del.status !== 404) throw new AuthError(await del.text(), del.status);
        n++;
      }
      return n;
    },
  };
}
