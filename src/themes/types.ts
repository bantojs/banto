import type { HtmlEscapedString } from "hono/utils/html";

/** JSX 要素（c.html() にそのまま渡せる型） */
export type Rendered = HtmlEscapedString | Promise<HtmlEscapedString>;
import type { ProductDetail, ProductSummary, PublicShop, SkuWithStock } from "../storefront/data";
import type { ProductRow } from "../db/types";
import type { Confirmation } from "../commerce/checkout";
import type { CategoryNode } from "../products/categories";
import type { PageRow } from "../pages";

/**
 * テーマ = SSR テンプレートの集合。src/themes/<name>/ に置き、storefront ルートが呼ぶ。
 * テーマはデータ取得をしない（引数で受け取る）。拡張スロット（プラグイン HTML 断片）は後で足す。
 */
export interface ThemeContext {
  shop: PublicShop;
  /** 例: "/my-shop" */
  shopPath: string;
  mediaBaseUrl: string;
  cartCount: number;
  /** 会員機能が有効で、ログイン中なら入る */
  member?: { email: string } | null;
  /** 会員機能が有効か（ヘッダにログイン導線を出す） */
  membersEnabled?: boolean;
  /** 外から見た URL（canonical / OG 用） */
  publicBaseUrl?: string;
  /** テーマ設定（shops.settings.theme_settings）。テーマが解釈する */
  themeSettings?: Record<string, unknown>;
  /** お問い合わせ（同梱モジュール inquiries）が使える。フッター・ログイン画面に GET `${shopPath}/inquiries/new` へのリンクを出す */
  inquiries?: boolean;
}

export interface PaymentOptions {
  stripe: boolean;
  komoju: boolean;
}

export interface ShippingInfo {
  summary: string;
  freeOver: number | null;
  table: { prefecture: string; fee: number }[] | null;
  taxRate: number;
}

export interface AddressFormValues {
  customer_name?: string;
  customer_email?: string;
  phone?: string;
  postal_code?: string;
  state?: string;
  city?: string;
  line1?: string;
  line2?: string;
  /** お届け希望日（YYYY-MM-DD）と時間帯（同梱モジュール delivery_time。空なら指定なし） */
  delivery_date?: string;
  delivery_slot?: string;
  /** 「お得な情報やセールの案内を受け取る」（0050。チェックされていれば "1"、それ以外は ""。欄を出すショップだけ） */
  marketing_consent?: string;
}

export interface CartLine {
  sku: SkuWithStock;
  product: ProductRow;
  qty: number;
  /** 在庫不足 */
  short: boolean;
}

/** カート画面のクーポン欄（同梱モジュール coupons が ON のときだけ渡る）。discount は商品の値引き（送料無料は確認画面で反映） */
export interface CartCoupons {
  applied: { code: string; name: string; amount_jpy: number; free_shipping: boolean }[];
  rejected: { code: string; reason: string; message: string }[];
  discount: number;
}

export interface Theme {
  ShopIndex(props: { shops: PublicShop[] }): Rendered;
  /** 商品一覧。tag はタグ別一覧（/:shop?tag=…）のときのタグ、tags はショップ全体のタグと件数 */
  ShopHome(props: {
    ctx: ThemeContext;
    products: ProductSummary[];
    tag?: string;
    tags?: { tag: string; count: number }[];
    /** カテゴリーの木（ナビゲーション用）と、カテゴリー別一覧（/:shop?category=…）のときのカテゴリー */
    categories?: CategoryNode[];
    category?: { slug: string; name: string };
    /** ページ送りの URL（0058）。next は次のページ、first は 2 ページ目以降のときの最初のページ。2 ページ目以降は検索エンジンに載せない */
    pagination?: { next?: string; first?: string };
    /** 検索（/:shop/search）の案内（語が短すぎる・見つからない）。あれば商品が無いときの文言の代わりに出す */
    notice?: string;
  }): Rendered;
  /** categoryPath は最上位から主カテゴリーまで（パンくず）、attributes は公開するカスタム項目 */
  ProductPage(props: { ctx: ThemeContext; detail: ProductDetail; added?: boolean; selectedSku?: string | null; categoryPath?: { slug: string; name: string }[]; attributes?: { key: string; label: string; value: string | number }[] }): Rendered;
  /** coupons が null / 省略なら、クーポン欄を出さない。入力は `${ctx.shopPath}/cart/coupon` に code、外すときは remove を POST する */
  /** tryon が true なら（同梱モジュール store_tryon）、GET `${ctx.shopPath}/tryon` への「お店で試着を申し込む」を出す */
  CartPage(props: { ctx: ThemeContext; lines: CartLine[]; total: number; payments: PaymentOptions; shipping: ShippingInfo; coupons?: CartCoupons | null; error?: string; tryon?: boolean }): Rendered;
  /** 決済ページへ行く前の配送先入力（全決済手段で共通）。prefectures は都道府県の選択肢 */
  /**
   * delivery があれば（同梱モジュール delivery_time）、delivery_date・delivery_slot の選択欄を出す（value が "" なら指定なし）
   */
  AddressPage(props: { ctx: ThemeContext; provider: string; values: AddressFormValues; prefectures: readonly string[]; shipping: ShippingInfo; subtotal: number; error?: string; delivery?: { dates: { value: string; label: string }[]; slots: { value: string; label: string }[] } | null; /** 「お得な情報やセールの案内を受け取る」の欄を出す（ショップの設定、0050） */ consent?: boolean }): Rendered;
  /**
   * 最終確認画面（特商法の「申込みの最終確認画面」）。confirmation の全項目を表示し、
   * quote を hidden で `${ctx.shopPath}/checkout/${confirmation.payment.provider}` に POST するボタンを置く。
   * 「修正する」は住所の項目と provider を `${ctx.shopPath}/checkout` に POST する。
   */
  ConfirmPage(props: { ctx: ThemeContext; confirmation: Confirmation; quote: string; error?: string }): Rendered;
  /** 送料・支払い方法の案内ページ */
  ShippingPage(props: { ctx: ThemeContext; shipping: ShippingInfo; payments: PaymentOptions }): Rendered;
  /** 会員: ログイン / 登録 */
  /**
   * 会員（パスワードなし。docs/members.md）:
   *   login  メールアドレスを入れる（初回はそのまま会員登録）。POST `${shopPath}/account/login`（email）
   *   code   メールのコードを入れる。POST `${shopPath}/account/code`（code）
   *   verify メールのリンクを開いた先の確認画面。GET では使わず、ボタンで POST `${shopPath}/account/verify`（c, t）
   *   passkey ヘッドレスの連携サイトから来た、パスキーだけでログインする画面（同梱モジュール passkey）。押すと returnTo へ戻る
   * email は code では送り先、verify では伏せ字（t***@example.com）。
   *
   * パスキー（options.passkey、同梱モジュール passkey、0046）: `<script src="${shopPath}/account/passkey.js" defer>` を読み、
   * 押すボタンに data-banto-passkey="login"（passkey の画面では data-return-to={returnTo} も）を付ける。失敗の文言を入れる要素に
   * data-banto-passkey-error（data-msg-failed / data-msg-cancelled）、パスキーの使えないブラウザで隠す範囲に data-banto-passkey-block を付ける
   */
  MemberAuthPage(props: {
    ctx: ThemeContext;
    /**
     * passkey_add: ヘッドレスの会員がパスキーを追加する確かめの画面（0070）。ticket を POST `${shopPath}/account/passkey/add`（t, return_to）で送るボタン。
     * passkey_register: 券を使った後の、この端末のパスキーを追加するボタン（data-banto-passkey="register" と data-return-to）
     */
    mode: "login" | "code" | "verify" | "passkey" | "passkey_add" | "passkey_register";
    ticket?: string;
    error?: string;
    info?: string;
    email?: string;
    challenge?: string;
    token?: string;
    /**
     * login で出すほかの方法: password = POST `${shopPath}/account/password-login`（email, password）、
     * providers = 外部のアカウント（GET `${shopPath}/account/oauth/<line|google>`）
     */
    options?: { password?: boolean; providers?: ("line" | "google")[]; passkey?: boolean };
    /** passkey の画面だけ: ログインしたら戻る連携サイトの URL（Banto が許可リストで確かめたもの） */
    returnTo?: string;
  }): Rendered;
  /** 会員: 注文履歴・既定の住所 */
  AccountPage(props: {
    ctx: ThemeContext;
    customer: { email: string | null; name: string | null; default_address: Record<string, unknown> | null; marketing_consent?: boolean | null } | null;
    orders: Record<string, unknown>[];
    /** 「お得な情報やセールの案内を受け取る」の欄を出す（ショップの設定、0050） */
    consent?: boolean;
    prefectures: readonly string[];
    flash?: string;
    error?: string;
    /**
     * ログインの方法。password なら POST `${shopPath}/account/password`（password）でパスワードを決める・変える。
     * providers は外部のアカウント。未連携は POST `${shopPath}/account/oauth/<id>/link`、連携済みは POST `${shopPath}/account/oauth/<id>/unlink`
     */
    security?: { password: boolean; hasPassword: boolean; providers: { id: "line" | "google"; linked: boolean }[] };
    /** 領収書を出せる（同梱モジュール receipt）。支払い済みの注文に GET `${shopPath}/account/orders/<番号>/receipt` へのリンクを出す */
    receipt?: boolean;
    /**
     * マイクーポン（同梱モジュール coupons、0019）。null ならクーポンの欄を出さない。
     * 「カートで使う」は POST `${shopPath}/cart/coupon`（code）
     */
    coupons?: { code: string; name: string; kind: "percent" | "fixed" | "free_shipping"; value: number; expires_at: string | null }[] | null;
    /**
     * お店で試着の申し込み（同梱モジュール store_tryon、0026）。null なら欄を出さない。
     * cancellable なら「取り消す」は POST `${shopPath}/account/tryon/<番号>/cancel`
     */
    tryon?: { number: number; status: string; store_name: string; /** 表示用の日付（「10月24日（土）」） */ visit_label: string | null; hold_label: string | null; created_at: string; items: { name: string | null; sku: string | null; qty: number }[]; cancellable: boolean }[] | null;
    /** ログイン中の端末の画面がある（0045）。true なら GET `${shopPath}/account/sessions` へのリンクを出す */
    sessions?: boolean;
    /** パスキーの画面がある（同梱モジュール passkey、0046）。true なら GET `${shopPath}/account/passkeys` へのリンクを出す */
    passkeys?: boolean;
  }): Rendered;
  /**
   * 会員: パスキー（同梱モジュール passkey、0046）。省略したテーマでは、このページは出ない。
   * canAdd なら「この端末のパスキーを追加」のボタン（data-banto-passkey="register"、MemberAuthPage と同じスクリプト）。
   * canAdd でない（ログインしてから時間が経った）なら、確認のコードを送るフォーム: POST `${shopPath}/account/login`（email、next=passkeys）。
   * 消すのは POST `${shopPath}/account/passkeys/<id>/delete`。usable でないものは、ショップのドメインが変わって使えなくなったもの
   */
  MemberPasskeysPage?(props: {
    ctx: ThemeContext;
    passkeys: { id: string; label: string | null; created_at: string; last_used_at: string | null; backed_up: boolean; usable: boolean }[];
    canAdd: boolean;
    email: string | null;
    flash?: string;
    error?: string;
  }): Rendered;
  /**
   * 会員: ログイン中の端末（0045）。省略したテーマでは、このページは出ない。
   * 「ログアウトさせる」は POST `${shopPath}/account/sessions/<id>/revoke`（current の行ならこの端末のログアウト）
   */
  MemberSessionsPage?(props: {
    ctx: ThemeContext;
    sessions: { id: string; kind: "web" | "api"; /** 端末の目安（「Chrome / macOS」）。無ければ null */ label: string | null; created_at: string; last_seen_at: string; current: boolean }[];
    flash?: string;
  }): Rendered;
  /**
   * 先着の「クーポンを獲得する」ページ（同梱モジュール coupons、0020）。省略したテーマでは、このページは出ない。
   * 獲得は POST `${shopPath}/coupons/<id>/claim`（ログイン中の会員だけ）
   */
  CouponClaimPage?(props: { ctx: ThemeContext; coupon: { id: string; name: string; label: string; ends_at: string | null; min_subtotal_jpy: number | null; remaining: number | null; live: boolean }; loggedIn: boolean; error?: string }): Rendered;
  /** 実店舗の一覧と営業時間（同梱モジュール store_tryon、GET `${shopPath}/stores`）。省略したテーマでは、このページは出ない */
  StoresPage?(props: { ctx: ThemeContext; stores: StoreView[] }): Rendered;
  /**
   * お店で試着の申し込み（同梱モジュール store_tryon、決済なし）。省略したテーマでは出ない。step:
   *   store   試着する店舗を選ぶ（GET `${shopPath}/tryon?store=<id>` へのリンク）
   *   details 来店日（settings.mode が visit のとき dates から）と連絡先 → POST `${shopPath}/tryon/confirm`
   *           （store・visit_date・customer_name・customer_email・customer_phone・note）
   *   confirm 内容の確認 → 同じ項目を hidden で POST `${shopPath}/tryon/submit`。「修正する」は GET `${shopPath}/tryon?store=<id>`
   *   done    受け付けた（number）
   */
  TryonPage?(props: {
    ctx: ThemeContext;
    step: "store" | "details" | "confirm" | "done";
    lines: CartLine[];
    stores: StoreView[];
    store?: StoreView | null;
    dates?: { value: string; label: string }[];
    settings: { mode: "shop" | "visit"; hold_days: number; max_items: number; notice: string };
    values: TryonFormValues;
    visitLabel?: string | null;
    error?: string;
    number?: number;
  }): Rendered;
  /**
   * お問い合わせ（同梱モジュール inquiries、0061）。省略したテーマでは出ない。メールにはリンクだけが届き、やり取りはこの画面でする。step:
   *   form    種類・本文・お名前（askEmail ならメールアドレス）・注文番号（order が決まっていなければ。orders があれば会員の注文から選ぶ）
   *           → POST `${shopPath}/inquiries/confirm`（category・body・name・email・order_number と hidden の値）
   *   confirm 内容の確認（order があれば結ぶ注文の要約。orderUnmatched なら「番号は合いませんでしたが、そのまま書き添えて送ります」）
   *           → 同じ値を hidden で POST `${shopPath}/inquiries/submit`。「修正する」は同じ値を POST `${shopPath}/inquiries/new`
   *   sent    受け付けた（sent.verified でなければ「届いたメールのリンクを開いてください」。mailSent でなければ送り直しの案内）
   *   open    メールのリンクを開いた先の確認画面（sent.number が受付番号）。GET では使わず、ボタンで POST `${shopPath}/inquiries/open`（t = token）
   *   thread  やり取り（inquiry）。inquiry.canReply なら本文を POST `${shopPath}/inquiries/reply`（body と hidden の値。inquiry.canAttach なら
   *           enctype="multipart/form-data" で files も）。添付は messages[].attachments の href（GET）
   *   resend  リンクを送り直す: POST `${shopPath}/inquiries/resend`（number・email）
   *   list    会員の問い合わせの一覧（list）。それぞれ GET `${shopPath}/inquiries/thread?n=<番号>`
   * 本文はテキストとして出す（改行だけ活かす。HTML として描画しない）
   */
  InquiryPage?(props: {
    ctx: ThemeContext;
    step: "form" | "confirm" | "sent" | "open" | "thread" | "resend" | "list";
    categories: { value: string; label: string }[];
    values: InquiryFormValues;
    hidden?: Record<string, string>;
    askEmail?: boolean;
    order?: InquiryOrderView | null;
    orders?: { number: number; label: string }[] | null;
    orderUnmatched?: boolean;
    sent?: { number: number; verified: boolean; mailSent: boolean };
    token?: string;
    inquiry?: InquiryThreadView | null;
    list?: { number: number; status: string; statusLabel: string; categoryLabel: string; created_at: string; last_message_at: string; order_number: number | null }[];
    error?: string;
    info?: string;
  }): Rendered;
  /** 注文照会（番号 + メール） */
  /** receipt: 領収書を出せる（同梱モジュール receipt）。支払い済みなら POST `${shopPath}/orders/receipt`（number・email・name）のフォームを出す */
  /** inquiry: 同梱モジュール inquiries が ON なら、結果の注文について問い合わせるフォーム（POST `${shopPath}/inquiries/new`、hidden の o = inquiry.token） */
  /**
   * 注文照会。member: ログイン中の会員の自分の注文（注文メールのリンクから、0066）。そのときは番号とメールアドレスの欄を出さず、
   * 領収書（receiptUrl、GET）とお問い合わせ（inquiryUrl、GET）はリンクで出す
   */
  OrderLookupPage(props: { ctx: ThemeContext; result?: Record<string, unknown> | null; error?: string; values: { number?: string; email?: string }; receipt?: boolean; inquiry?: { token: string } | null; member?: { receiptUrl: string | null; inquiryUrl: string | null } }): Rendered;
  LegalPage(props: { ctx: ThemeContext; title: string; body: string }): Rendered;
  /**
   * ショップのページ（同梱モジュール pages、0079、/pages/<handle>）。html は本文を src/pages/markdown.ts で HTML にしたもの
   * （決まった形のタグだけで、そのまま出してよい）。無いテーマではページを出さない
   */
  ContentPage?(props: { ctx: ThemeContext; page: PageRow; html: string }): Rendered;
  /**
   * 決済ページから戻ってきた直後。注文確定は Webhook で行うので、status が無ければ「受付済み」の表示に留める。
   * status（0035、照会トークン付きで開いたとき）: confirmed なら orderNumber を出す、pending なら「確認中」（refresh が true なら数秒後に自動で再読み込み）、
   * released なら「成立しなかった」。free: 0 円の注文で、この時点で確定している
   */
  /** inquiryUrl: 同梱モジュール inquiries が ON で注文が確定していれば、この注文について問い合わせる GET の URL */
  CheckoutDone(props: { ctx: ThemeContext; free?: boolean; status?: "pending" | "confirmed" | "released" | "not_found"; orderNumber?: number | null; refresh?: boolean; inquiryUrl?: string | null }): Rendered;
  NotFound(props: { ctx?: ThemeContext }): Rendered;
}

/** 実店舗の表示用（ルートが営業時間を計算して渡す。テーマは計算しない） */
export interface StoreView {
  id: string;
  name: string;
  postal_code: string | null;
  address: string | null;
  phone: string | null;
  note: string | null;
  /** 試着を受け付ける店舗か */
  tryon: boolean;
  /** 曜日ごとの営業時間（月曜から） */
  week: { day: string; text: string }[];
  /** 今日の営業（「本日 10:00〜20:00」「本日は休業日です」） */
  today: string;
  /** 近い臨時休業・臨時営業（日付の表示・内容） */
  specials: { date: string; text: string }[];
}

export interface TryonFormValues {
  store?: string;
  visit_date?: string;
  customer_name?: string;
  customer_email?: string;
  customer_phone?: string;
  note?: string;
}

export interface InquiryFormValues {
  category?: string;
  body?: string;
  name?: string;
  email?: string;
  order_number?: string;
}

/** 問い合わせに結ぶ注文の要約（住所・連絡先は入らない） */
export interface InquiryOrderView {
  number: number;
  status: string;
  created_at: string;
  total_jpy: number;
  items: { name: string | null; qty: number }[];
}

export interface InquiryThreadView {
  number: number;
  status: string;
  statusLabel: string;
  categoryLabel: string;
  created_at: string;
  order: { number: number } | null;
  claimed_order_number: number | null;
  messages: { author: "customer" | "shop"; body: string; created_at: string; attachments: { href: string; filename: string; content_type: string; size: number }[] }[];
  canReply: boolean;
  /** 返事のフォームでファイルを添付できる（公開しない置き場があるとき）。フォームは multipart/form-data、入力は files（複数、accept は attachAccept） */
  canAttach: boolean;
  attachAccept: string;
  /** 返事のフォームに hidden で入れる値（会員は受付番号 n） */
  replyHidden: Record<string, string>;
}

/** 会員ページの値（既定のテーマの AccountPage と、Liquid のテーマの {% banto_account %} が受け取る） */
export type AccountPageProps = Parameters<Theme["AccountPage"]>[0];
