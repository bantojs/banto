# API の入口（どれを使うか・共通の決まり）

Banto には用途の違う 4 つの API があります。まずこの表で自分に合うものを選び、詳しい仕様は各ページを読んでください。

| 使う人 | API | 認証 | 入口 | 詳しい仕様 |
| --- | --- | --- | --- | --- |
| 別のサイト（WordPress・LP・SPA）からショップを出したい | **公開 API・カート・チェックアウト・会員**（`/api/shops/...`） | なし（会員の操作だけ Banto の会員トークン） | `GET /api/` が一覧を返す | [docs/headless.md](headless.md) |
| AI（Claude など）や自動化ツールで商品・注文・集計を扱いたい | **AI 用 API**（`/mcp`、`/api/v1`） | 管理画面で発行する AI 用トークン（`Authorization: Bearer banto_...`） | `GET /api/v1/openapi.json`（OpenAPI 3.1） | [docs/ai-access.md](ai-access.md) と §3 |
| 注文や商品の変化を自分のサービスで受け取りたい（CRM・メール・Slack） | **hooks**（署名付き Webhook の送信） | 送信先ごとの署名シークレット（管理画面に表示） | 管理画面 → hooks | [docs/hooks.md](hooks.md)、実例 [examples/plugin-slack](../examples/plugin-slack/) |
| 稼働を監視したい | **/health** | なし | `GET /health` | [docs/monitoring.md](monitoring.md) |

購入者の画面そのもの（同梱テーマ）は API ではなく SSR のページです。商品フィード（Google / Meta）は `GET /<slug>/feed/products.xml`（同梱モジュール product_feed を ON にしたとき。[docs/product-feed.md](product-feed.md)）、サイトマップは `GET /sitemap.xml`。

---

## 1. 共通の決まり

- **URL の起点**はショップの URL（`https://banto.<アカウント>.workers.dev`、独自ドメインを付けたら `https://shop.example.jp`。[docs/custom-domain.md](custom-domain.md)）。ショップの独自ドメインの上では `/api/...` も `/mcp` も同じパスで動きます。
- **形式**は JSON（`Content-Type: application/json`）。金額はすべて**税込の整数の円**（`*_jpy`）。日時は ISO 8601（UTC）。
- **エラー**は HTTP の状態コードと `error` で返します。公開 API は `{"error": "stock"}` のように短いコード（必要なら `field` 等が付く）、AI 用 API は `{"error": {"code": "unauthorized", "message": "..."}}`。存在しない ID と他のショップの ID は区別せず `not_found` / `unauthorized` です。
- **CORS**: 公開 API（商品・カート・チェックアウト・お店で試着）は `Access-Control-Allow-Origin: *`。**会員の API（`/api/shops/<slug>/members/*`）だけは、ショップ設定の「決済後の戻り先として許可するサイト」のオリジンにしか返しません**（ログインのメールを送るため）。`/api/v1` と `/mcp` には CORS を付けていません（ブラウザから直接叩く用途ではない）。
- **回数の上限**（Banto が DB で数えるもの。[docs/hardening.md](hardening.md) の WAF はその外側）:

| 入口 | 上限 | 超えたとき |
| --- | --- | --- |
| チェックアウトの確定（`POST /api/shops/<slug>/checkout`、同梱テーマのレジ） | 同じ最終確認内容（quote）は 1 回。同じ人（メールアドレス）の未確定の予約は 3 つ、同じ IP は 20 まで | 400 `invalid_quote` / 429 `too_many_reservations` |
| お店で試着の申し込み | 同じ人の進行中の申し込み 3 件、同じ IP は 10 件 | 409 `too_many_requests` |
| 会員のログインのコードの発行 | 同じ IP から同じ人へ 15 分 3 回・1 日 10 回、アドレス全体 1 日 30 通、ショップ全体 1 時間 100 通・1 日 500 通 | 200 のまま送らない（登録の有無を外から分からなくするため） |
| 会員のコードの照合 | 1 つのコードは 5 回、アドレスごとに 1 日 50 回 | 401 `expired` |
| 会員のパスワードでのログイン | 同じ人 15 分に 5 回失敗 | 429 `locked` |
| 管理画面のログイン | 同じメールアドレス 15 分に 5 回・同じ IP 20 回の失敗 | 15 分断る |

- **バージョン**: `GET /api/` と `GET /health` が Banto の版を返します。破壊的な変更はマイナー版で行い、[docs/upgrade.md](upgrade.md) の「変更ごとの注意」に書きます。

---

## 2. 公開 API・カート・チェックアウト・会員（`/api/shops/...`）

連携側の画面から、認証なしで呼べます（会員の操作だけ会員トークン）。詳しい入出力・エラーの一覧・埋め込みスニペットは [docs/headless.md](headless.md)。

| メソッドとパス | 何をするか | 備考 |
| --- | --- | --- |
| `GET /api/` | この一覧と版 | |
| `GET /api/shops` | 公開中のショップ（id・slug・name） | |
| `GET /api/shops/<slug>` | ショップの名前と法務 3 項目 | `settings` や Stripe の情報は出ない |
| `GET /api/shops/<slug>/products` | 商品一覧。`?tag=&category=&brand=&q=&updated_since=&sort=new\|updated\|price_asc\|price_desc\|name&limit=&offset=` | `limit` は既定・上限 100。カテゴリーは子孫を含み、主カテゴリーか追加カテゴリーのどれかが合えば出る |
| `GET /api/shops/<slug>/products/<slug>` | 商品 1 件（SKU・在庫・画像・公開のカスタム項目） | |
| `GET /api/shops/<slug>/categories` | カテゴリーの木 | |
| `GET /<slug>/buy?sku=<sku_id>&qty=1` | 購入リンク（カートに入れて同梱テーマのカートへ） | JavaScript なしで使える |
| `GET /api/shops/<slug>/cart?cart=<token>` | カートの内容（価格・合計は Banto が計算）。送料の要約・使える決済・配送日時の選択肢（`delivery`）も | カートは署名付きトークン。サーバーに状態を持たない |
| `POST /api/shops/<slug>/cart` | `{ op: add \| set \| remove \| clear \| coupon_add \| coupon_remove, sku_id, qty, code, cart }` | 新しいトークンが返る |
| `GET /api/shops/<slug>/checkout/status?token=<照会トークン>` | 注文の状態（`pending` / `confirmed` + 注文番号 / `released` / `not_found`）。照会トークンは `POST /checkout` の `status_token`（`success_url` の `banto_status`） | 個人情報は返さない。24 時間。戻り先の画面用（headless.md「4. 戻り先の画面」） |
| `POST /api/shops/<slug>/checkout/quote` | `{ cart, provider: stripe \| komoju, address }` → 最終確認の内容（`confirmation`）と署名付き `quote` | 特商法の最終確認画面は連携側が出す（headless.md「C を選ぶときの責任」） |
| `POST /api/shops/<slug>/checkout` | `{ quote, success_url?, cancel_url? }` → 決済ページの URL | 内容が変わっていれば 409 `changed` と新しい quote。戻り先は許可リストのオリジンだけ |
| `GET /api/shops/<slug>/members/config` | 会員機能が有効か・ログインの方法 | |
| `POST /api/shops/<slug>/members/login` → `verify` → `refresh` | メールのコード / リンクでログインし、会員トークン（access 15 分 / refresh 30 日・1 回ごとに回す）を受け取る | CORS は許可リストのオリジンだけ |
| `GET /api/shops/<slug>/members/me`、`POST .../logout-all` | 会員の情報と注文、全端末からログアウト | `Authorization: Bearer <会員トークン>` |
| `POST .../members/password-login`、`POST .../members/password` | パスワードでログイン・パスワードを決める | ショップの設定で有効なとき |
| `GET .../members/oauth/<line\|google>?return_to=` | LINE・Google でログイン（ブラウザで開く） | 戻ったら `verify` に引き換え券を渡す |
| `GET /api/shops/<slug>/stores`、`POST /api/shops/<slug>/tryon` | お店で試着の店舗と申し込み（同梱モジュール store_tryon） | 会員トークンを付ければ `GET .../members/tryon` で一覧・取り消し |
| `POST /<slug>/orders/lookup`（同梱テーマの画面） | 購入者の注文照会（番号 + メール） | API ではなく画面。住所は出さない |

カートと quote のトークンは Banto だけが開けます。連携側は中身を解釈せず、そのまま次の呼び出しに渡してください。

---

## 3. AI 用 API（`/mcp` と `/api/v1`）

管理画面 → ショップ設定 → **AI 連携（トークン）** で発行したトークンを使います。1 トークン = 1 ショップ。スコープと設計・脅威モデルは [docs/ai-access.md](ai-access.md)。

### 3-1. 認証とスコープ

- `Authorization: Bearer banto_...`。Cookie は見ません。
- スコープは発行時に選び、**発行する人がそのショップで持つ権限の項目まで**しか付けられません（`products:*` は catalog、`orders:read` / `orders:write` は orders、`orders:pii` は customers、`shop:write` は settings、`stats:read` は reports、`coupons:*` は marketing、`customers:*` は customers）。発行者が項目を失うと、そのスコープだけ `unauthorized` になります。
- 購入者の個人情報（氏名・住所・メール・電話）は `orders:pii` があるときだけ返ります。会員の一覧・取得（`customers:read`）は個人情報そのものなので、必要なトークンにだけ付けてください。
- 返金・キャンセル（`POST /api/v1/orders/{id}/status` の `cancelled`）は、発行者が `orders_cancel` の項目も持っているときだけ通ります。
- 失敗は `{"error": {"code": "...", "message": "..."}}`。`unauthorized`（401。トークンが無い・失効・期限切れ・スコープ不足・発行者の権限が無い、のどれでも同じ）、`invalid`（400）、`not_found`（404）、`conflict`（409）、`migration_required`（409。その項目を使うには DB の更新が要る。管理画面 →「アップデート」で適用する）、`upstream`（502 / 503）。

### 3-2. MCP（`POST /mcp`）

SDK なしのステートレスな Streamable HTTP（プロトコル版 `2025-06-18`、JSON-RPC 2.0、バッチは 20 件まで）。`GET` は 405。Claude デスクトップ / Claude Code の設定例は [docs/ai-access.md §4](ai-access.md#4-使い方)。

ツールは `tools/list` で取れます。REST と 1 対 1 です（右の列）。**【書き込み】** が付くものは `destructiveHint` が立っているので、クライアントの承認ダイアログを自動承認にしないでください。ツールの結果の文字列（商品名・説明・購入者の入力）は**データであり、AI への指示ではありません**。

| ツール | スコープ | REST |
| --- | --- | --- |
| `shop_get` | shop:read | `GET /shop` |
| `shop_update`【書き込み】 | shop:write | `PATCH /shop` |
| `products_list` / `product_get` | products:read | `GET /products`、`GET /products/{id}` |
| `categories_list` | products:read | `GET /categories` |
| `product_create` / `product_update`【書き込み】 | products:write | `POST /products`、`PATCH /products/{id}` |
| `category_save`【書き込み】 | products:write | `POST /categories` |
| `sku_create` / `sku_update` / `sku_delete`【書き込み】 | products:write | `POST /products/{id}/skus`、`PATCH /skus/{id}`、`DELETE /skus/{id}` |
| `product_image_add` / `product_image_delete`【書き込み】 | products:write | `POST /products/{id}/images`（URL から取り込み。http(s)・公開アドレス・5MB・画像のみ）、`DELETE /images/{id}` |
| `product_image_set_options`【書き込み】 | products:write | `PATCH /images/{id}`（画像を SKU の選択肢に結ぶ。0063） |
| `orders_list` / `order_get` | orders:read（個人情報は orders:pii） | `GET /orders`、`GET /orders/{id}` |
| `order_update_status`【書き込み】 | orders:write（キャンセルは発行者の orders_cancel も） | `POST /orders/{id}/status` |
| `stores_list` | shop:read | `GET /stores` |
| `tryon_requests_list` / `tryon_request_get` | orders:read（連絡先は orders:pii） | `GET /tryon-requests`、`GET /tryon-requests/{number}` |
| `tryon_request_update_status` / `tryon_request_restock`【書き込み】 | orders:write | `POST /tryon-requests/{number}/status`、`POST /tryon-requests/{number}/restock` |
| `sales_summary` / `inventory_low` | stats:read | `GET /stats/sales`、`GET /stats/inventory-low` |
| `coupons_list` / `coupon_get` / `coupon_grants_list` | coupons:read | `GET /coupons`、`GET /coupons/{id かコード}`、`GET /coupons/{id}/grants` |
| `coupon_create` / `coupon_update` / `coupon_delete`【書き込み】 | coupons:write | `POST /coupons`、`PATCH /coupons/{id}`、`DELETE /coupons/{id}` |
| `coupon_grants_issue` / `coupon_grant_revoke`【書き込み】 | coupons:write | `POST /coupons/{id}/grants`、`POST /coupon-grants/{id}/revoke` |
| `customers_list` / `customer_get` | customers:read | `GET /customers`、`GET /customers/{id}` |
| `customer_create` / `customer_upsert` / `customer_update` / `customer_delete`【書き込み】 | customers:write | `POST /customers`、`POST /customers/upsert`、`PATCH /customers/{id}`、`DELETE /customers/{id}` |

### 3-3. REST（`/api/v1`）

機械可読の仕様は `GET /api/v1/openapi.json`（認証なし）。一覧の応答は `{ items, total, limit, offset }`、`limit` は上限 100。

| メソッドとパス | スコープ | 引数 |
| --- | --- | --- |
| `GET /shop` | shop:read | |
| `GET /relay-check` | shop:read | なし。この通信を Banto がどの IP として数えるか（`ip` `forwarded_ip` `trusted_relay` `effective_ip`）。サーバー側で中継する連携の接続テスト用（docs/headless.md「サーバー側で中継するとき」） |
| `PATCH /shop` | shop:write | `name` `legal_notice` `privacy_policy` `return_policy` `checkout_terms` `published` `low_stock_threshold` `max_pending_per_ip`（同じ IP の未確定の予約の上限、1〜9999）`login_per_ip_per_hour`（同じ IP からの会員ログインのコード発行の 1 時間の上限、1〜9999。0033） |
| `GET /products` | products:read | `?q=&published=&limit=&offset=` |
| `POST /products` | products:write | `slug` `name` `description` `tags` `category`（主カテゴリーの slug） `extra_categories`（追加カテゴリーの slug の配列、20 個まで。0042） `brand` `attributes` `published` |
| `GET /products/{id}` | products:read | id か slug |
| `PATCH /products/{id}` | products:write | `POST /products` と同じ項目 |
| `POST /products/{id}/skus` | products:write | `code` `name` `price_jpy` `available` `options` `compare_at_price_jpy` `gtin` |
| `PATCH /skus/{id}` | products:write | 同上（`available` で在庫数を直接セット） |
| `DELETE /skus/{id}` | products:write | 注文履歴がある SKU は削除できない（非公開にする） |
| `POST /products/{id}/images` | products:write | `image_url`（Banto がその URL から取ってくる） |
| `POST /products/{id}/images/upload` | products:write | 画像のファイルそのもの。下の「画像のファイルを送る」 |
| `PATCH /images/{id}` | products:write | `options`（SKU の `options` の一部。`{ "color": "レッド" }` でそのカラーの全 SKU、`{ "color": "レッド", "size": "M" }` でその SKU だけ、`{}` で商品全体。鍵 5 つまで・値は 60 文字までの文字列）。返すのは商品。0063 |
| `DELETE /images/{id}` | products:write | |
| `GET /categories` | products:read | |
| `POST /categories` | products:write | `slug` `name` `parent`（親の slug） `sort_order`。slug が同じなら更新 |
| `GET /orders` | orders:read | `?q=&status=&from=&to=&limit=&offset=` |
| `GET /orders/{id}` | orders:read | |
| `POST /orders/{id}/status` | orders:write | `status`: `shipped` / `cancelled`（キャンセルは決済事業者で返金してから在庫を戻す） |
| `GET /stores` | shop:read | |
| `GET /tryon-requests` | orders:read | `?status=&store_id=&limit=&offset=` |
| `GET /tryon-requests/{number}` | orders:read | 受付番号 |
| `POST /tryon-requests/{number}/status` | orders:write | `status`: `sent` / `ready`（`hold_until` YYYY-MM-DD 必須）/ `purchased` / `not_purchased` / `cancelled`。在庫は戻らない |
| `POST /tryon-requests/{number}/restock` | orders:write | 終わった申し込みの在庫を EC に戻す。1 回だけ |
| `GET /stats/sales` | stats:read | `?from=&to=`（ISO 8601、必須）`&group_by=day\|month\|product` |
| `GET /stats/inventory-low` | stats:read | `?threshold=` |
| `GET /coupons` | coupons:read | `?q=`（名前・コードの部分一致）`&active=&limit=&offset=` |
| `POST /coupons` | coupons:write | `name` `code` `kind`（`percent` / `fixed` / `free_shipping`）`value` `starts_at` `ends_at` `usage_limit` `per_customer_limit` `combinable` `audience`（`public` / `members`）`active` `grant_valid_days` `auto_grant` `claimable` `external_ref` `conditions` |
| `GET /coupons/{id}` | coupons:read | id かコード。使用回数（`usage`）と発行済みの枚数（`grants`）つき |
| `PATCH /coupons/{id}` | coupons:write | `POST /coupons` と同じ項目。渡した項目だけ変わる |
| `DELETE /coupons/{id}` | coupons:write | 使われたことのないものだけ。使われたものは 409 `coupon_in_use`（`active: false` で止める） |
| `GET /coupons/{id}/grants` | coupons:read | 発行済みのクーポン。`?status=available\|held\|used\|revoked&limit=&offset=` |
| `POST /coupons/{id}/grants` | coupons:write | `customer_ids`（会員 id ごとに 1 枚）`count`（誰でも 1 回使えるコードの枚数）。合わせて 500 まで。発行したコードが返る |
| `POST /coupon-grants/{id}/revoke` | coupons:write | 使っていない発行済みのクーポンを取り消す |
| `GET /customers` | customers:read | `?q=`（メールアドレス・氏名の部分一致）`&email=`（完全一致）`&external_provider=&external_id=`（外部の ID の完全一致）`&updated_since=`（その時刻以後に変わった会員だけ、`updated_at` の昇順。同期の取り込み向け）`&marketing_consent=true|false`（案内メールの同意で絞る。0050）`&limit=&offset=` |
| `POST /customers` | customers:write | `email` `name` `default_address` `external_ref` `attributes`。同じアドレスがあれば 409 `email_taken` |
| `POST /customers/upsert` | customers:write | メールアドレスで引いて、あれば渡した鍵だけ更新（200）、無ければ作る（201、`created: true`）。外部の顧客マスタから Banto へ写す窓口。`email` は変えない。同じ `external_ref` が別の会員にあれば 409 `external_ref_taken` |
| `GET /customers/{id}` | customers:read | 注文の件数と合計つき。`orders:read` もあれば最近の注文 20 件（個人情報なし） |
| `PATCH /customers/{id}` | customers:write | `name` `default_address` `external_ref` `attributes`（渡した鍵だけ重ね、null で消す）`marketing_consent`（**false だけ**。配信停止の書き戻し。true は 400 `consent_requires_person`）。**`email` は変えられない**（400 `email_change_not_allowed`） |
| `DELETE /customers/{id}` | customers:write | 退会。注文は残る |

`checkout_terms` は購入前の確認画面の文言（管理画面 → ショップ設定 →「購入前の確認画面」と同じもの。0032）で、`GET /shop` は `{ "delivery", "cancellation", "payment_note" }`（未設定は `null`）を返します。
`PATCH /shop` では渡した鍵だけを変え、`null` か空文字で消します（各 2000 文字まで、超えると 400 `invalid_checkout_terms`）。
チェックアウト API の `confirmation`（docs/headless.md「C. チェックアウト API」）にはこの値がそのまま出るので、連携側（WordPress 等）の管理画面から Banto の表示を編集するのに使えます。表示の正本は Banto に置いたまま、連携側には保存しないでください。
DB が 0032 より前のあいだは、`GET /shop` に `checkout_terms` が無く、`PATCH /shop` に `checkout_terms` を渡すと 409 `migration_required` です（ほかの項目も保存しません）。

**画像のファイルを送る**（`POST /products/{id}/images/upload`、0037）: 本文に画像そのものを入れる（`Content-Type: image/jpeg` など）か、`multipart/form-data` で `image`（必須）と `thumbnail`（任意）を送ります。
Banto は画像を縮小しないので（Worker の CPU の制限）、**長辺 1600px 程度に縮小した本画像**と、あれば **長辺 400px 程度のサムネイル**を送ってください（管理画面からのアップロードと同じ大きさ。サムネイルがあると一覧のページが軽くなります）。
種類は中身の先頭のバイトで決め、申告の Content-Type は使いません。JPEG・PNG・WebP・GIF・AVIF だけで、SVG は受けません。本画像は 5MB、サムネイルは 1MB まで。`Content-Length` が要ります（無いと 411、大きすぎると 413）。寸法は見出しから読んで残します（AVIF は残しません）。
応答は `{ "image_id", "product" }`。公開 URL のある画像なら、今までどおり `POST /products/{id}/images`（`image_url`）でも取り込めます（こちらはサムネイルなし）。

```bash
curl -X POST -H "Authorization: Bearer banto_..." -H "Content-Type: image/webp" --data-binary @main.webp https://<ショップの URL>/api/v1/products/<id>/images/upload
curl -X POST -H "Authorization: Bearer banto_..." -F image=@main.webp -F thumbnail=@thumb.webp https://<ショップの URL>/api/v1/products/<id>/images/upload
```

クーポン（`/coupons`）はモジュール「クーポン」が ON のショップだけ使えます（OFF なら 409、`module_disabled`）。値引きの判定は今までどおりコア（docs/coupons.md）で、API は条件を登録するだけです。
`conditions` の鍵は `product_ids` `exclude_product_ids` `category_ids` `exclude_category_ids`（このショップの id だけ。主カテゴリーか追加カテゴリーのどれかが合えば対象・除外）`tags` `exclude_tags`（商品のタグ、20 個まで。0042）`brands` `exclude_brands`（商品のブランド、20 個まで）`payment_methods`（`stripe` / `komoju` / `komoju:<種類>`。0044、docs/coupons.md）`attributes`（会員の独自項目の条件 `{ "rank": ["gold", "silver"] }`。鍵はショップの設定「会員の項目」にあるものだけ、10 個まで・値は 20 個まで。ログイン中の会員の値がどれかに合うときだけ。0049）`exclude_sale` `min_subtotal_jpy` `max_subtotal_jpy` `min_qty`。知らない鍵は 400 です。
会員（`/customers`）は Banto がショップごとに持つ会員です（docs/members.md）。作っても Banto からは知らせず、会員は初回もメールのコードかリンクでログインします。
**会員のメールアドレスは API では変えられません**（会員はメールでログインするので、アドレスを変えられるとトークンが漏れたときに会員のアカウントを乗っ取れてしまうため）。変えるときは管理画面の「会員」から（前後のアドレスに知らせ、全端末からログアウトします）。パスワードのハッシュは返しません。
`external_ref` は外部の顧客マスタ（HubSpot など）でのその会員の ID `{ "provider": "hubspot", "id": "..." }`（provider は英小文字・数字・_、ショップ × provider × id で一意）、`attributes` は管理画面 → ショップ設定 →「会員の項目」で定義した鍵の値だけです（知らない鍵は 400 `invalid_attribute_<鍵>`、select は選択肢の中だけ）。どちらも 0047 から（それより前の DB では 409 `migration_required`）。設計は [docs/knowledge/13-external-customer-master.md](knowledge/13-external-customer-master.md)、使い方は [docs/ai-access.md](ai-access.md) §7。
クーポン・会員の窓口は DB が 0036 より前のあいだ 409 `migration_required` です。WordPress などのサーバーからの使い方は [docs/ai-access.md](ai-access.md)「5. サーバーから使う」。

**できないこと**: トークンの発行、運営者アカウントの操作、Secret の参照、商品の物理削除、会員のメールアドレスの変更、決済設定や hooks の送信先の変更、SQL の実行。

---

## 4. hooks（Banto から自分のサービスへ）

注文・商品・試着の変化を、登録した URL に署名付きで POST します。送るのは ID と金額などで、**購入者の個人情報は送りません**（必要なら注文 ID で AI 用 API から取る）。

- イベント: `order.created` `order.paid` `order.shipped` `order.cancelled` `product.updated` `inventory.low` `tryon.requested` `tryon.updated`
- ヘッダー: `X-Banto-Event`、`X-Banto-Delivery`（配信 ID。再送でも同じ）、`X-Banto-Signature: t=<epoch 秒>,v1=<hex(HMAC-SHA256(secret, "<t>.<body>"))>`
- 失敗は指数バックオフで最大 5 回再送。受け取り側は配信 ID で冪等にする。
- 外部プラグインは、マニフェスト（JSON）で設定項目を宣言すると管理画面がフォームを描きます。

署名の検証のサンプル・マニフェストの形・配信履歴の見方は [docs/hooks.md](hooks.md)。

---

## 5. 変更の履歴（API に影響するもの）

| 日付 | 変更 |
| --- | --- |
| 2026-10-18 | `POST /checkout` が照会トークン（`status_token` / `status_url`、`success_url` の `banto_status`）を返し、`GET /checkout/status` で戻り先の画面が確定と注文番号を出せる（0035） |
| 2026-10-18 | カート API の応答に `delivery`（配送日時の選択肢。モジュールが OFF なら `null`）を追加（docs/delivery-time.md §2） |
| 2026-10-18 | 中継元の IP の一覧を公開の settings から外す（0034。連携側のサーバーの素の IP）。`GET /api/v1/relay-check` を追加。IPv6 は書き方をそろえて比較 |
| 2026-10-18 | サーバー側で中継する連携（WordPress の PHP など）のために、ショップ設定で宣言した中継元からの `X-Banto-Client-IP` を購入者の IP として数える（docs/headless.md「サーバー側で中継するとき」）。`shop_get` / `PATCH /shop` に `max_pending_per_ip` `login_per_ip_per_hour`（0033） |
| 2026-10-18 | 会員の API の CORS を許可リストのオリジンだけに。チェックアウトの確定は quote 1 回限り・同じ人 3 つ・同じ IP 20 まで。AI 用トークンのスコープは発行者の項目まで、キャンセルは `orders_cancel` が要る。`order.cancelled` に `refunded` `restocked` を追加。公開の `GET /api/shops/<slug>` の応答は変わらない（内部では `shops` の列を絞った） |
| 2026-10-17 | お店で試着（`/api/shops/<slug>/stores`、`/tryon`、`/members/tryon`、AI 用の `tryon_*`） |
| 2026-10-16 | カート API・チェックアウト API・最終確認画面、会員の API、商品一覧の絞り込みとページング |
