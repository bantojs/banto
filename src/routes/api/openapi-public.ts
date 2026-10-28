/**
 * ヘッドレスの公開 API（/api/shops/...）の OpenAPI 3.1 ドキュメント。連携側（WordPress・Next.js 等）が読み、各言語のクライアントを生成する。
 * 説明の正は docs/headless.md。ここは形（パス・引数・主な応答の項目・エラーのコード）を機械が読める形で持つ。
 * ルートとの食い違いは test/openapi-public.test.ts が検査する（ルートを足したらここにも足す）
 */
export function publicOpenapiDocument(origin: string, version: string): Record<string, unknown> {
  const obj = (props: Record<string, unknown>, required: string[] = [], description?: string) => ({ type: "object", properties: props, required, ...(description ? { description } : {}) });
  const str = { type: "string" };
  const int = { type: "integer" };
  const bool = { type: "boolean" };
  const nStr = { type: ["string", "null"] };
  const nInt = { type: ["integer", "null"] };
  const arr = (items: unknown, description?: string) => ({ type: "array", items, ...(description ? { description } : {}) });
  const any = (description: string) => ({ type: "object", description });
  const json = (schema: unknown) => ({ content: { "application/json": { schema } } });
  const ok = (schema: unknown, description = "ok") => ({ description, ...json(schema) });
  /** エラーの応答。本文は { error: "<コード>", ... }。コードは docs/headless.md の表 */
  const err = (description: string) => ({ description, ...json({ $ref: "#/components/schemas/Error" }) });
  const body = (schema: unknown, required = true) => ({ required, ...json(schema) });
  const shopPath = { name: "shop", in: "path", required: true, schema: str, description: "ショップのスラッグ" };
  const member = [{ memberBearer: [] }];
  const memberOptional = [{}, { memberBearer: [] }];
  const common = { 404: err("not_found（ショップが無い・非公開）"), 503: err("not_configured") };
  const ref = obj({ slug: str, name: str });

  const cartItem = obj({ sku_id: str, sku_code: str, sku_name: nStr, product_id: str, product_slug: str, product_name: str, unit_price_jpy: int, qty: int, line_total_jpy: int, in_stock: bool, short: { ...bool, description: "在庫が足りない" } });
  const cart = obj(
    {
      cart: { ...str, description: "新しいカートのトークン。次の呼び出しにはこれを渡す（毎回置き換える）" },
      items: arr(cartItem),
      removed: arr(str, "非公開になった・削除された SKU（トークンからは外してある）"),
      count: int,
      subtotal_jpy: int,
      coupons: { type: ["object", "null"], description: "同梱モジュール coupons が OFF なら null。applied・rejected・discount_jpy・subtotal_after_discount_jpy" },
      tax_rate: int,
      tax_included: bool,
      shipping: obj({ summary: str, free_over_jpy: nInt, remaining_for_free_jpy: nInt, by_prefecture: { type: ["object", "null"] } }),
      payments: obj({ stripe: bool, komoju: bool }),
      delivery: { type: ["object", "null"], description: "配送日時の選択肢（同梱モジュール delivery_time）。dates[].value・slots[].value を配送先の delivery_date / delivery_slot に" },
      can_checkout: bool,
      member: { type: ["object", "null"], description: "会員トークンが有効なら { id }" },
      checkout_url: { ...str, description: "同梱テーマのレジで続けるときの URL" },
      limits: obj({ max_lines: int, max_qty: int, max_coupons: int }),
    },
    ["cart", "items", "count", "subtotal_jpy", "can_checkout"],
  );
  const address = obj(
    {
      customer_name: str, customer_email: str, phone: str, postal_code: str, state: { ...str, description: "都道府県名" }, city: str, line1: str, line2: str,
      delivery_date: { ...str, description: "配送日時の指定（カートの delivery.dates[].value）" },
      delivery_slot: { ...str, description: "カートの delivery.slots[].value" },
      marketing_consent: { type: ["boolean", "string"], description: "案内メールを受け取る（true か \"1\"）。ショップがこの欄を使うときだけ（0050）" },
    },
    ["customer_name", "customer_email", "phone", "postal_code", "state", "city", "line1"],
  );
  const quoted = obj({ quote: { ...str, description: "購入者に見せた内容の署名。POST /checkout にそのまま渡す（1 回限り）" }, expires_at: str, confirmation: any("最終確認画面に表示する内容（特商法）。申込みボタンの直前に全部表示する。項目は docs/headless.md「2. 最終確認画面を表示する」") }, ["quote", "expires_at", "confirmation"]);
  const tokens = obj({ access_token: { ...str, description: "bm1. で始まる（15 分）。Authorization: Bearer に付ける" }, refresh_token: { ...str, description: "30 日。1 回使うごとに新しいものに置き換わる（使い回すとその端末のセッションが止まる）" }, expires_in: int }, ["access_token", "refresh_token", "expires_in"]);
  const loggedIn = { allOf: [tokens, obj({ member: obj({ id: str, email: str, created: bool }) })] };
  const store = any("実店舗。id・name・住所・hours（曜日ごと）・special_days・today・visit_dates（来店日を選ぶとき）など");
  const orderView = obj(
    {
      number: int,
      status: { type: "string", enum: ["paid", "shipped", "cancelled", "refunded"] },
      created_at: str,
      shipped_at: nStr,
      total_jpy: int,
      shipping_jpy: int,
      discount_jpy: int,
      shipping_tax_rate: { type: ["number", "string", "null"] },
      tax_rounding: nStr,
      payment_provider: nStr,
      tracking: { type: ["object", "null"], description: "carrier・number（発送のお問い合わせ番号）" },
      discounts: arr(obj({ code: str, name: str, amount_jpy: int })),
      items: arr(obj({ name: str, sku: nStr, qty: int, unit_price_jpy: int, tax_rate: { type: ["number", "string", "null"] }, discount_jpy: nInt })),
    },
    [],
    "住所・メールアドレスは返さない",
  );
  const receipt = obj(
    {
      kind: { type: "string", enum: ["qualified_simplified_invoice", "receipt"], description: "qualified_simplified_invoice = 適格簡易請求書（登録番号あり）" },
      issuer: str,
      invoice_number: nStr,
      proviso: { ...str, description: "但し書き" },
      issued_at: str,
      number: int,
      order_date: str,
      items: arr(obj({ name: str, sku: nStr, qty: int, unit_price_jpy: int, line_total_jpy: int, reduced: { ...bool, description: "軽減税率の対象（表示に ※ を付ける）" } })),
      shipping_jpy: int,
      discounts: arr(obj({ code: str, name: str, amount_jpy: int })),
      total_jpy: int,
      tax: arr(obj({ rate: { type: "number", description: "%。0 は非課税・不課税" }, amount_jpy: { ...int, description: "税込の対象額" }, tax_jpy: { ...int, description: "うち消費税額" } })),
    },
    [],
    "記載事項と計算結果だけ。宛名・レイアウト・印刷は連携サイトが決める",
  );
  const inquiry = obj(
    {
      number: int,
      status: { type: "string", enum: ["waiting_shop", "waiting_customer", "closed"] },
      status_label: str,
      category: { type: "string", enum: ["product", "order", "account", "other"] },
      category_label: str,
      verified: bool,
      order: { type: ["object", "null"], description: "結んだ注文の number・status・created_at・total_jpy" },
      claimed_order_number: nInt,
      messages: arr(obj({ author: { type: "string", enum: ["customer", "shop"] }, body: { ...str, description: "お客様と運営者が書いたテキスト。HTML として描画しない" }, created_at: str, attachments: arr(obj({ id: str, filename: str, content_type: str, size: int })) })),
      can_reply: bool,
    },
    [],
    "連絡先は返さない",
  );
  const inquiryAccess = obj({ token: { ...str, description: "メールのリンクのトークン（banto_inquiry）" }, number: { ...int, description: "会員（会員トークンが要る）の受付番号" } }, [], "token か（会員なら）number のどちらか");

  const doc = {
    openapi: "3.1.0",
    info: {
      title: "Banto ヘッドレス API",
      version,
      license: { name: "MIT", identifier: "MIT" },
      description:
        "連携側の画面（WordPress・Next.js・LP など）から使う公開 API。認証なし・CORS *（会員の API だけは許可リストのオリジン）。判定（価格・在庫・送料・税・クーポン・確定）は Banto が行い、連携側は返った値を表示する。使い方は docs/headless.md。運営者の道具・AI 向けは /api/v1/openapi.json。",
    },
    servers: [{ url: `${origin}/api` }],
    // 既定は認証なし（公開 API）。会員トークンを付けられる操作・要る操作だけが security を上書きする
    security: [{}],
    components: {
      securitySchemes: { memberBearer: { type: "http", scheme: "bearer", description: "会員トークン（/members/verify などで受け取る bm1. のトークン）。付けなければゲスト" } },
      schemas: { Error: obj({ error: { ...str, description: "エラーのコード（invalid_request・not_found・invalid_cart など）" }, field: { ...str, description: "invalid_request のとき、形の違う項目" }, message: { ...str, description: "表示用の文（一部のエンドポイントだけ）" } }, ["error"]) },
    },
    paths: {
      "/openapi.json": { get: { summary: "この文書", responses: { 200: ok(any("OpenAPI 3.1")) } } },
      "/shops": { get: { summary: "公開中のショップの一覧", responses: { 200: ok(obj({ shops: arr(obj({ id: str, slug: str, name: str })) })), 503: common[503] } } },
      "/shops/{shop}": {
        get: {
          summary: "ショップと法務の文面（特商法・プライバシー・返品）",
          parameters: [shopPath],
          responses: { 200: ok(obj({ shop: obj({ id: str, slug: str, name: str, legal_notice: nStr, privacy_policy: nStr, return_policy: nStr, legal_links: any("法務のページを連携サイトに向けていて、最後の確認で生きていた外の URL（0062）") }) })), ...common },
        },
      },
      "/shops/{shop}/products": {
        get: {
          summary: "商品の一覧（公開中のものだけ）",
          parameters: [
            shopPath,
            { name: "tag", in: "query", schema: str },
            { name: "category", in: "query", schema: str, description: "カテゴリーのスラッグ。子孫のカテゴリーと追加カテゴリーも含む" },
            { name: "brand", in: "query", schema: str },
            { name: "q", in: "query", schema: str, description: "3 文字から（2 文字以下は tag・category・brand と一緒のときだけ）" },
            { name: "updated_since", in: "query", schema: { type: "string", format: "date-time" } },
            { name: "sort", in: "query", schema: { type: "string", enum: ["new", "updated", "price_asc", "price_desc", "name"] } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
            { name: "offset", in: "query", schema: { type: "integer", minimum: 0, maximum: 10000 } },
            { name: "cursor", in: "query", schema: str, description: "前の応答の next_cursor。ページ送りはこちらを使う" },
          ],
          responses: {
            200: ok(
              obj({
                products: arr(obj({ id: str, slug: str, name: str, brand: nStr, category: { type: ["object", "null"] }, extra_categories: arr(ref), tags: arr(str), image: nStr, thumb: nStr, min_price_jpy: int, compare_at_price_jpy: nInt, created_at: str, updated_at: str })),
                total: { ...nInt, description: "最初のページだけ（10,000 まで）" },
                total_capped: bool,
                limit: int,
                offset: int,
                next_offset: nInt,
                next_cursor: nStr,
                tags: arr(obj({ tag: str, count: int }), "ショップ全体のタグと件数（多い順に 200 件まで）"),
              }),
            ),
            400: err("invalid_request（field: sort・updated_since・limit・offset・q・cursor）"),
            ...common,
          },
        },
      },
      "/shops/{shop}/products/{product}": {
        get: {
          summary: "商品の詳細（SKU・画像・公開のカスタム項目）",
          parameters: [shopPath, { name: "product", in: "path", required: true, schema: str, description: "商品のスラッグ" }],
          responses: {
            200: ok(
              obj({
                product: obj({
                  id: str, slug: str, name: str, description: nStr, brand: nStr, category: { type: ["object", "null"] }, category_path: arr(ref, "最上位から主カテゴリーまで"), extra_categories: arr(ref), tags: arr(str),
                  attributes: arr(obj({ key: str, label: str, value: {} }), "公開のカスタム項目"), updated_at: str, images: arr(str),
                  image_variants: arr(obj({ url: str, thumb: str, width: nInt, height: nInt, options: { type: "object", additionalProperties: str, description: "結んだ SKU の選択肢（0063。{} は商品全体）" } })),
                  skus: arr(obj({ id: str, code: str, name: nStr, options: { type: "object", additionalProperties: str }, gtin: nStr, price_jpy: int, compare_at_price_jpy: nInt, in_stock: bool })),
                  option_axes: arr(obj({ key: str, values: arr(str) }), "SKU を分ける軸（0065）。軸ごとの選択欄に使う。values は SKU に出てくる値。軸の無い商品は []"),
                }),
              }),
            ),
            ...common,
          },
        },
      },
      "/shops/{shop}/categories": { get: { summary: "カテゴリーの木（公開中の商品数つき、子孫を含む）", parameters: [shopPath], responses: { 200: ok(obj({ categories: arr(obj({ slug: str, name: str, count: int, children: arr({ type: "object" }) })) })), ...common } } },

      "/shops/{shop}/cart": {
        get: { summary: "カートの中身（最新の価格・在庫で計算し直す）", security: memberOptional, parameters: [shopPath, { name: "cart", in: "query", schema: str, description: "カートのトークン。省略で空のカート" }], responses: { 200: ok(cart), 400: err("invalid_cart（トークンを捨てて作り直す）"), 401: err("invalid_member_token"), ...common } },
        post: {
          summary: "カートを変える（追加・数量・削除・空にする・クーポン）",
          security: memberOptional,
          parameters: [shopPath],
          requestBody: body(obj({ cart: str, op: { type: "string", enum: ["add", "set", "remove", "clear", "coupon_add", "coupon_remove"] }, sku_id: str, qty: int, code: { ...str, description: "クーポンのコード" } }, ["op"])),
          responses: { 200: ok(cart), 400: err("invalid_request・invalid_cart"), 401: err("invalid_member_token"), 404: err("sku_not_available・not_found"), 409: err("coupons_disabled"), 503: common[503] },
        },
      },
      "/shops/{shop}/checkout/quote": {
        post: {
          summary: "カート + 配送先 → 最終確認の内容（confirmation）と quote",
          security: memberOptional,
          parameters: [shopPath],
          requestBody: body(obj({ cart: str, provider: { type: "string", enum: ["stripe", "komoju"] }, address }, ["cart", "address"])),
          responses: { 200: ok(quoted), 400: err("invalid_address（fields に不備の項目）・invalid_cart・invalid_request"), 401: err("invalid_member_token"), 409: err("empty_cart・stock・payment_unavailable・minimum_amount"), ...common },
        },
      },
      "/shops/{shop}/checkout": {
        post: {
          summary: "quote で注文を作り、決済ページの URL を返す（確定は決済の Webhook だけ）",
          security: memberOptional,
          parameters: [shopPath],
          requestBody: body(obj({ quote: str, success_url: { ...str, description: "許可リスト（return_origins）のオリジンだけ" }, cancel_url: str }, ["quote"])),
          responses: {
            200: ok(obj({ payment_url: str, free: { ...bool, description: "0 円の注文（その場で確定）" }, order_id: str, status_token: str, status_url: str }, ["payment_url"])),
            400: err("invalid_quote（作り直す）"),
            401: err("invalid_member_token"),
            409: err("changed（新しい quote と confirmation つき。表示し直して押し直してもらう）・stock・coupon_unavailable・payment_unavailable"),
            429: err("too_many_reservations"),
            502: err("payment_failed"),
            ...common,
          },
        },
      },
      "/shops/{shop}/orders/lookup": {
        post: {
          summary: "ゲストの注文照会（注文番号と注文時のメールアドレス）",
          parameters: [shopPath],
          requestBody: body(obj({ number: int, email: str }, ["number", "email"])),
          responses: { 200: ok(obj({ order: orderView, receipt_available: bool, order_token: { ...str, description: "24 時間。領収書（POST /orders/receipt）とお問い合わせ（order_token）に渡す" } })), 400: err("invalid_request"), ...common, 404: err("not_found（番号かアドレスが違う・ショップが無い）") },
        },
      },
      "/shops/{shop}/orders/receipt": {
        post: { summary: "ゲストの注文の領収書のデータ（同梱モジュール receipt）", parameters: [shopPath], requestBody: body(obj({ order_token: str }, ["order_token"])), responses: { 200: ok(obj({ receipt })), 400: err("invalid_order_token"), 409: err("receipt_not_available（支払い済みでない）"), ...common, 404: err("not_found・receipt_disabled") } },
      },
      "/shops/{shop}/checkout/status": {
        get: {
          summary: "戻り先の画面で、確定したか・注文番号を引く（照会トークン）",
          parameters: [shopPath, { name: "token", in: "query", required: true, schema: str, description: "status_token か、success_url の banto_status" }],
          responses: { 200: ok(obj({ status: { type: "string", enum: ["pending", "confirmed", "released", "not_found"] }, order: { type: ["object", "null"], description: "number・status・total_jpy・payment_provider・created_at" }, expires_at: str }, ["status"])), 400: err("invalid_token"), ...common },
        },
      },

      "/shops/{shop}/members/config": { get: { summary: "会員機能の有無とログインの方法", parameters: [shopPath], responses: { 200: ok(obj({ enabled: bool, login: arr({ type: "string", enum: ["email_code", "email_link", "password", "line", "google", "passkey"] }) })), 404: common[404] } } },
      "/shops/{shop}/members/login": {
        post: {
          summary: "メールでログインのコード（とリンク）を送る",
          parameters: [shopPath],
          requestBody: body(obj({ email: str, return_to: { ...str, description: "リンクの戻り先（許可リストのオリジン）。無ければ Banto の確認画面" } }, ["email"])),
          responses: { 200: ok(obj({ challenge_id: str })), 400: err("invalid_email"), 409: err("members_disabled"), 429: err("plan_limit_exceeded（1 日のメールの上限）"), 502: err("mail_failed"), ...common },
        },
      },
      "/shops/{shop}/members/verify": {
        post: {
          summary: "コード・リンクのトークン・引き換え券（LINE / Google / パスキーから戻った後）で会員トークンを受け取る",
          parameters: [shopPath],
          requestBody: body(obj({ challenge_id: str, code: { ...str, description: "6 桁" }, token: { ...str, description: "リンクの banto_token" }, handoff: { ...str, description: "引き換え券（<id>.<token>、2 分・1 回限り）" } }, [], "challenge_id と code か token、または handoff")),
          responses: { 200: ok(loggedIn), 401: err("invalid_code・expired"), 409: err("members_disabled・plan_limit_exceeded"), ...common },
        },
      },
      "/shops/{shop}/members/refresh": { post: { summary: "access_token を作り直す（refresh_token は毎回置き換わる）", parameters: [shopPath], requestBody: body(obj({ refresh_token: str }, ["refresh_token"])), responses: { 200: ok(tokens), 401: err("invalid_refresh_token・refresh_token_reused（使い回し。ログインからやり直す）"), 409: err("members_disabled"), ...common } } },
      "/shops/{shop}/members/logout": { post: { summary: "この端末をログアウト（Bearer の access か本文の refresh_token）", security: memberOptional, parameters: [shopPath], requestBody: body(obj({ refresh_token: str }), false), responses: { 200: ok(obj({ ok: bool })), 401: err("invalid_member_token"), 409: err("members_disabled"), ...common } } },
      "/shops/{shop}/members/logout-all": { post: { summary: "すべての端末からログアウト", security: member, parameters: [shopPath], responses: { 200: ok(obj({ ok: bool })), 401: err("invalid_member_token・member_token_required"), 409: err("members_disabled"), ...common } } },
      "/shops/{shop}/members/sessions": { get: { summary: "ログイン中の端末の一覧", security: member, parameters: [shopPath], responses: { 200: ok(obj({ sessions: arr(any("id・端末の名前・作った時刻・最後に使った時刻・current")) })), 401: err("invalid_member_token・member_token_required"), 409: err("members_disabled"), ...common } } },
      "/shops/{shop}/members/sessions/{id}/revoke": { post: { summary: "端末を 1 つ取り消す", security: member, parameters: [shopPath, { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { 200: ok(obj({ ok: bool })), 401: err("invalid_member_token"), 404: err("not_found"), 409: err("members_disabled"), 503: common[503] } } },
      "/shops/{shop}/members/me": { get: { summary: "会員と注文の一覧（住所は返さない）", security: member, parameters: [shopPath], responses: { 200: ok(obj({ id: str, email: str, orders: arr(obj({ number: int, status: str, total_jpy: int, shipping_jpy: int, discount_jpy: int, created_at: str, shipped_at: nStr })) })), 401: err("invalid_member_token・member_token_required"), 409: err("members_disabled"), ...common } } },
      "/shops/{shop}/members/password-login": {
        post: { summary: "パスワードでログイン（ショップがパスワードを使うときだけ）", parameters: [shopPath], requestBody: body(obj({ email: str, password: str }, ["email", "password"])), responses: { 200: ok(loggedIn), 401: err("invalid_password"), 409: err("password_disabled"), 429: err("locked"), ...common } },
      },
      "/shops/{shop}/members/password": {
        post: { summary: "パスワードを決める・変える（ログインしてから 15 分以内。ほかの端末はログアウト）", security: member, parameters: [shopPath], requestBody: body(obj({ password: { type: "string", minLength: 8, maxLength: 200 } }, ["password"])), responses: { 200: ok(tokens, "この端末の新しいトークン"), 400: err("weak_password"), 401: err("invalid_member_token"), 403: err("reauth（ログインし直してから）"), 409: err("password_disabled"), ...common } },
      },
      "/shops/{shop}/members/oauth/{provider}": {
        get: { summary: "LINE / Google のログインを始める（リダイレクト。戻ると return_to に引き換え券）", parameters: [shopPath, { name: "provider", in: "path", required: true, schema: { type: "string", enum: ["line", "google"] } }, { name: "return_to", in: "query", required: true, schema: str }], responses: { 302: { description: "提供元の同意画面へ" }, 400: err("invalid_return_to"), 409: err("provider_disabled"), 404: common[404] } },
      },
      "/shops/{shop}/members/passkey": {
        get: { summary: "パスキーのログイン画面へ（ショップの独自ドメインの上。戻ると return_to に引き換え券）", parameters: [shopPath, { name: "return_to", in: "query", required: true, schema: str }], responses: { 302: { description: "ショップのドメインのパスキーの画面へ" }, 400: err("invalid_return_to"), 409: err("passkey_disabled"), 404: common[404] } },
      },
      "/shops/{shop}/members/orders/{number}": { get: { summary: "会員の注文 1 件（注文照会のページ。lookup_order と同じ形）", security: member, parameters: [shopPath, { name: "number", in: "path", required: true, schema: int }], responses: { 200: ok(obj({ order: orderView, receipt_available: bool })), 401: err("invalid_member_token・member_token_required"), 404: err("not_found（この会員の注文ではない）"), 409: err("members_disabled"), 503: common[503] } } },
      "/shops/{shop}/members/orders/{number}/receipt": { get: { summary: "会員の注文の領収書のデータ（同梱モジュール receipt）", security: member, parameters: [shopPath, { name: "number", in: "path", required: true, schema: int }], responses: { 200: ok(obj({ receipt })), 401: err("invalid_member_token・member_token_required"), 404: err("not_found・receipt_disabled"), 409: err("receipt_not_available（支払い済みでない）・members_disabled"), 503: common[503] } } },
      "/shops/{shop}/members/tryon": { get: { summary: "会員の試着の申し込みの一覧（同梱モジュール「お店で試着」）", security: member, parameters: [shopPath], responses: { 200: ok(obj({ requests: arr(any("number・status・店舗・来店日・商品・cancellable")) })), 401: err("invalid_member_token"), 404: err("tryon_disabled"), 409: err("members_disabled"), 503: common[503] } } },
      "/shops/{shop}/members/tryon/{number}/cancel": { post: { summary: "試着の申し込みを取り消す", security: member, parameters: [shopPath, { name: "number", in: "path", required: true, schema: int }], responses: { 200: ok(obj({ ok: bool })), 401: err("invalid_member_token"), 404: err("not_found・tryon_disabled"), 409: err("取り消せない状態"), 503: common[503] } } },

      "/shops/{shop}/stores": { get: { summary: "実店舗と試着の設定（同梱モジュール「お店で試着」）", security: memberOptional, parameters: [shopPath], responses: { 200: ok(obj({ stores: arr(store), tryon: obj({ mode: str, hold_days: int, max_items: int, notice: nStr }), today: str })), ...common } } },
      "/shops/{shop}/tryon": {
        post: {
          summary: "カートの商品を実店舗で試着する申し込み（在庫を店舗に取り置く）",
          security: memberOptional,
          parameters: [shopPath],
          requestBody: body(obj({ cart: str, store: { ...str, description: "店舗の id" }, visit_date: str, customer_name: str, customer_email: str, customer_phone: str, note: str }, ["cart", "store"])),
          responses: { 201: ok(obj({ number: int, store, visit_date: nStr, cart: { ...str, description: "申し込んだ商品を外したカート" }, member: { type: ["object", "null"] } })), 400: err("invalid_request（field）・invalid_cart・store_unavailable"), 409: err("empty_cart・stock・too_many_items・too_many_requests"), ...common },
        },
      },

      "/shops/{shop}/inquiries/config": { get: { summary: "お問い合わせのフォームの選択肢（同梱モジュール「お問い合わせ」）", security: memberOptional, parameters: [shopPath], responses: { 200: ok(obj({ categories: arr(obj({ value: str, label: str })), member: { type: ["object", "null"] } })), 404: err("inquiries_disabled・not_found") } } },
      "/shops/{shop}/inquiries/order-check": { post: { summary: "ゲストの注文を番号とメールアドレスで確かめる（注文トークン、24 時間）", parameters: [shopPath], requestBody: body(obj({ number: int, email: str }, ["number", "email"])), responses: { 200: ok(obj({ order: any("number・status・created_at・total_jpy・items"), order_token: str })), 400: err("invalid_request"), 404: err("inquiries_disabled"), 409: err("order_not_found"), 429: err("too_many") } } },
      "/shops/{shop}/inquiries": {
        get: { summary: "会員の自分のお問い合わせの一覧", security: member, parameters: [shopPath], responses: { 200: ok(obj({ inquiries: arr(any("number・status・category・created_at・last_message_at・order_number")) })), 401: err("member_required・invalid_member_token"), 404: err("inquiries_disabled") } },
        post: {
          summary: "お問い合わせを送る（ゲストは確認のメールのリンクを開いた時点で確定）",
          security: memberOptional,
          parameters: [shopPath],
          requestBody: body(obj({ category: { type: "string", enum: ["product", "order", "account", "other"] }, body: str, name: str, email: { ...str, description: "ゲストだけ必須" }, order_number: str, order_token: str, checkout_token: str, return_to: { ...str, description: "連携サイトのチケットの画面（許可リストのオリジン）。メールのリンクがここに向く" } }, ["category", "body"])),
          responses: { 201: ok(obj({ number: int, verified: bool, mail_sent: bool })), 400: err("invalid_request（field）・invalid_order_token・invalid_checkout_token"), 401: err("invalid_member_token・invalid_member"), 404: err("inquiries_disabled"), 409: err("order_not_found"), 429: err("too_many・limit"), 503: err("unavailable（メールの送信元が未設定）") },
        },
      },
      "/shops/{shop}/inquiries/view": { post: { summary: "お問い合わせの中身とやり取り（リンクのトークンか会員の受付番号）", security: memberOptional, parameters: [shopPath], requestBody: body(inquiryAccess), responses: { 200: ok(obj({ inquiry })), 401: err("invalid_member_token"), 404: err("not_found（期限切れなら resend）・inquiries_disabled") } } },
      "/shops/{shop}/inquiries/reply": {
        post: {
          summary: "お客様として返事を書く。添付は multipart/form-data（files を 3 個まで、画像・PDF、1 個 5MB。確定したチケットだけ）",
          security: memberOptional,
          parameters: [shopPath],
          requestBody: { required: true, content: { "application/json": { schema: { allOf: [inquiryAccess, obj({ body: str }, ["body"])] } }, "multipart/form-data": { schema: obj({ token: str, number: int, body: str, files: arr({ type: "string", format: "binary" }) }, ["body"]) } } },
          responses: { 200: ok(obj({ number: int })), 400: err("invalid・attachment_too_many・attachment_too_large・attachment_type"), 401: err("invalid_member_token"), 404: err("not_found・inquiries_disabled"), 409: err("closed・attachments_unavailable"), 429: err("too_many") },
        },
      },
      "/shops/{shop}/inquiries/attachments/{id}": {
        post: {
          summary: "添付を受け取る（トークンを URL に載せないため POST）。応答はファイルそのもの",
          security: memberOptional,
          parameters: [shopPath, { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: body(inquiryAccess),
          responses: { 200: { description: "ファイル（nosniff・sandbox・no-store。PDF は保存として）" }, 401: err("invalid_member_token"), 404: err("not_found・inquiries_disabled") },
        },
      },
      "/shops/{shop}/inquiries/resend": { post: { summary: "リンクを送り直す（番号とアドレスが合ったかは返さない）", parameters: [shopPath], requestBody: body(obj({ number: int, email: str, return_to: str }, ["number", "email"])), responses: { 202: { description: "受け付けた" }, 400: err("invalid_request"), 404: err("inquiries_disabled"), 429: err("too_many・limit") } } },
    },
  };
  // 生成したクライアントのメソッド名（operationId）。ルートを足したらここにも足す（test/openapi-public.test.ts が抜けを検査する）
  for (const [path, ops] of Object.entries(doc.paths) as [string, Record<string, Record<string, unknown>>][]) {
    for (const [method, op] of Object.entries(ops)) {
      const id = OPERATION_IDS[`${method} ${path}`];
      if (id) op["operationId"] = id;
    }
  }
  return doc;
}

const OPERATION_IDS: Record<string, string> = {
  "get /openapi.json": "getOpenapi",
  "get /shops": "listShops",
  "get /shops/{shop}": "getShop",
  "get /shops/{shop}/products": "listProducts",
  "get /shops/{shop}/products/{product}": "getProduct",
  "get /shops/{shop}/categories": "listCategories",
  "get /shops/{shop}/cart": "getCart",
  "post /shops/{shop}/cart": "updateCart",
  "post /shops/{shop}/checkout/quote": "createCheckoutQuote",
  "post /shops/{shop}/checkout": "placeCheckout",
  "get /shops/{shop}/checkout/status": "getCheckoutStatus",
  "post /shops/{shop}/orders/lookup": "lookupOrder",
  "post /shops/{shop}/orders/receipt": "getOrderReceipt",
  "get /shops/{shop}/members/config": "getMemberConfig",
  "post /shops/{shop}/members/login": "startMemberLogin",
  "post /shops/{shop}/members/verify": "verifyMemberLogin",
  "post /shops/{shop}/members/refresh": "refreshMemberToken",
  "post /shops/{shop}/members/logout": "logoutMember",
  "post /shops/{shop}/members/logout-all": "logoutMemberEverywhere",
  "get /shops/{shop}/members/sessions": "listMemberSessions",
  "post /shops/{shop}/members/sessions/{id}/revoke": "revokeMemberSession",
  "get /shops/{shop}/members/me": "getMember",
  "post /shops/{shop}/members/password-login": "loginMemberWithPassword",
  "post /shops/{shop}/members/password": "setMemberPassword",
  "get /shops/{shop}/members/oauth/{provider}": "startMemberOAuth",
  "get /shops/{shop}/members/passkey": "startMemberPasskey",
  "get /shops/{shop}/members/orders/{number}": "getMemberOrder",
  "get /shops/{shop}/members/orders/{number}/receipt": "getMemberOrderReceipt",
  "get /shops/{shop}/members/tryon": "listMemberTryonRequests",
  "post /shops/{shop}/members/tryon/{number}/cancel": "cancelMemberTryonRequest",
  "get /shops/{shop}/stores": "listStores",
  "post /shops/{shop}/tryon": "createTryonRequest",
  "get /shops/{shop}/inquiries/config": "getInquiryConfig",
  "post /shops/{shop}/inquiries/order-check": "checkInquiryOrder",
  "get /shops/{shop}/inquiries": "listMemberInquiries",
  "post /shops/{shop}/inquiries": "createInquiry",
  "post /shops/{shop}/inquiries/view": "viewInquiry",
  "post /shops/{shop}/inquiries/reply": "replyToInquiry",
  "post /shops/{shop}/inquiries/attachments/{id}": "getInquiryAttachment",
  "post /shops/{shop}/inquiries/resend": "resendInquiryLink",
};
