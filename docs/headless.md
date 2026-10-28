# ヘッドレス連携（カート API・チェックアウト API・購入リンク）

> API 全体の入口（公開 / AI 用 / hooks の使い分け、共通の決まり、一覧）は [docs/api.md](api.md)。
> 機械が読める仕様は `GET /api/openapi.json`（OpenAPI 3.1、認証なし・CORS `*`）。openapi-generator などで各言語（PHP・TypeScript・Python…）のクライアントを生成できます。生成したクライアントでも、金額の計算や判定は自分でせず、Banto が返した値を表示してください。応答の項目の意味・画面の出し方（最終確認画面など）はこのページが正です。

WordPress・LP・SNS・独自のフロント（Next.js 等）から Banto で売るための仕様です。

**画面は連携側が自由に作り、カートの中身・価格・在庫・送料・合計・注文の確定は Banto が判定します。**
連携側は Banto が返した値を表示するだけにして、金額を自分で計算しないでください。

使い方は 3 段階あり、どこまで自前の画面にするかで選びます。

| 段階 | 連携側が作る画面 | Banto の画面 | 使うもの |
| --- | --- | --- | --- |
| A. 購入リンク | 商品の紹介とボタン | カート → 配送先 → 最終確認 → 決済 | `/:shop/buy` |
| B. カート API | 商品・カート（入れる / 出す / リセット） | 配送先 → 最終確認 → 決済 | `/api/shops/:shop/cart` + `checkout_url` |
| C. チェックアウト API | 商品・カート・配送先・**最終確認画面**まで全部 | なし（決済事業者のページだけ） | 上記 + `/api/shops/:shop/checkout/*` |

Banto の商品ページ・カートの画面を使わないなら、ショップ設定の「お店の画面の使い方」で「カートと購入だけ」（A・B）か「使わない」（C）を選ぶと、使わない画面を開かれたときに連携側のサイトへ転送します（docs/storefront.md）。

A と B では、特定商取引法の最終確認画面は Banto の画面が出します。**C では連携側の画面が最終確認画面になります**（下の「C を選ぶときの責任」）。

公開読み取り API（`/api/shops`、`/api/shops/:shop`、`/api/shops/:shop/products`、`/api/shops/:shop/products/:product`）とあわせて、
`/api/shops/...` は CORS を許可しています（`Access-Control-Allow-Origin: *`）。Cookie は使わないので、別ドメインのブラウザから直接呼べます。
ただし **会員の API（`/api/shops/<shop>/members/*`）だけは、ショップ設定の「決済後の戻り先として許可するサイト」（`return_origins`）のオリジンにしか CORS を返しません**（ログインはメールを送るので、どのサイトからでも訪問者のブラウザで叩けてはいけないため）。
`/api/v1` と `/mcp`（AI 用トークンが必要）には CORS を付けていません。

決済せずに在庫を押さえ続けられないように、同じ quote で `checkout` を呼べるのは 1 回（2 回目は 400 `invalid_quote`。quote を取り直す）、同じ人（メールアドレス）の未確定の予約は 3 つ・同じ IP は 20 までです（超えると 429 `too_many_reservations`。支払いが済むか、Stripe なら 40 分、KOMOJU ならショップの設定の時間で予約が解けます）。**連携側のサーバーが Banto を中継する構成では、必ず「サーバー側で中継するとき」を読んでください**（中継元を宣言しないと、同じ IP の上限がサイト全体の上限になります）。

---

## 商品を読む（公開読み取り API）

```
GET /api/shops/<shop>/products?category=<カテゴリーの slug>&brand=<ブランド>&tag=<タグ>&q=<語>&updated_since=<ISO 8601>&sort=<並び>&limit=<件数>&cursor=<次の位置>
GET /api/shops/<shop>/products/<product_slug>
GET /api/shops/<shop>/categories
```

| パラメータ | 意味 |
| --- | --- |
| `category` | このカテゴリーと、その子孫のカテゴリーの商品だけ（主カテゴリーか追加カテゴリーのどれかが合えば出る）。存在しない slug なら 0 件 |
| `brand` | このブランドの商品だけ（完全一致） |
| `tag` | このタグを持つ商品だけ（完全一致）。タグは管理画面の商品編集、または AI 用 API で付ける |
| `q` | 名前・ブランド・タグ・説明（先頭 300 文字）の部分一致（大文字小文字を区別しない、3〜100 文字）。2 文字以下の語（「帽子」など）は `tag`・`category`・`brand` のどれかと一緒のときだけ受け付けます（それ以外は 400、`field: "q"`, `reason: "too_short"`） |
| `updated_since` | この時刻より後に更新された商品だけ。連携側でキャッシュを差分更新するときに使う |
| `sort` | `new`（既定、登録の新しい順）/ `updated` / `price_asc` / `price_desc` / `name` |
| `limit` | 1 ページの件数。既定・上限とも 100 |
| `cursor` | 次のページ。前の応答の `next_cursor` をそのまま渡す（`sort` を変えて使い回すと 400） |
| `offset` | 先頭から何件飛ばすか。10,000 まで、`q` があるときは 1,000 まで（それより先は `cursor` で辿る） |

応答:

```json
{
  "products": [
    { "id": "…", "slug": "tee", "name": "Tシャツ", "brand": "Banto",
      "category": { "slug": "tops", "name": "トップス" }, "tags": ["夏物", "トップス"],
      "image": "https://…", "thumb": "https://…", "min_price_jpy": 3000, "compare_at_price_jpy": 4000,
      "created_at": "…", "updated_at": "…" }
  ],
  "total": 42, "total_capped": false, "limit": 20, "offset": 0, "next_offset": 20, "next_cursor": "eyJzIjoibmV3Ii…",
  "tags": [ { "tag": "夏物", "count": 12 }, { "tag": "トップス", "count": 5 } ]
}
```

- `next_cursor` が `null` なら最後のページです。商品が多いショップでも速さが変わらないので、ページ送りは `cursor` を使ってください。`next_offset` は `offset` で辿っているときだけ（10,000 件まで）返ります。
- `total` は絞り込み後の件数で、最初のページ（`cursor` も `offset` も無いとき）だけ 10,000 件まで数えます。超えたら `10000` と `total_capped: true` を返します。2 ページ目からは `null` です。
- `tags` はショップ全体（絞り込み前、公開中の商品だけ）のタグと件数です（多い順に 200 件まで）。絞り込みボタンを並べるのに使えます。
- `compare_at_price_jpy` は最安 SKU の通常価格です。`min_price_jpy` より高ければセール中として表示できます。
- 詳細（`/products/<slug>`）は説明・画像（幅と高さつき）に加え、次を返します。
  - `brand`、`category`、`category_path`（最上位から主カテゴリーまで。パンくず用）、`extra_categories`（追加カテゴリー。主カテゴリーのほかに並ぶ棚）、`tags`、`updated_at`
  - `attributes`: カスタム項目のうち公開するもの（`[{ "key", "label", "value" }]`、管理画面で private にした項目は出ない）。公開にした項目の値はそのまま誰にでも見えるので、原価や仕入先など内部の値は private にする
  - `skus[]`: `code`・`name`・`options`（例: `{ "サイズ": "M", "色": "黒" }`）・`gtin`・`price_jpy`・`compare_at_price_jpy`・`in_stock`
  - `option_axes`: SKU を分ける軸（0065。`[{ "key": "カラー", "values": ["レッド", "ブルー"] }, …]`。`values` は SKU に出てくる値）。軸ごとの選択欄（カラー → サイズ）を作り、選んだ値が `skus[].options` とすべて合う SKU の `id` をカートに入れてください。軸の無い商品は `[]`（SKU を 1 つの選択欄で選ぶ）。値は配列・オブジェクトのまま返すので、カンマや読点を含む値（`1,000mm`）も 1 つの値です（文字で区切って読まないでください）
  - `image_variants[].options`: その画像を結んだ SKU の選択肢（0063。`{}` は商品全体）。画像の `options` の鍵と値がすべて SKU の `options` にあれば、その SKU の画像です。SKU を選んだら「当てはまる画像（鍵の多いもの先）→ 商品全体の画像 → ほかの画像」の順に並べると、同梱テーマと同じになります
- `/categories` はカテゴリーの木です（3 段まで、`[{ "slug", "name", "count", "children": [...] }]`、`count` は子孫を含む公開中の商品数）。
- パラメータの形が違えば `400 { "error": "invalid_request", "field": "<名前>" }` を返します。

同梱テーマでも `/<shop>?category=<slug>` がカテゴリー別、`/<shop>?tag=<タグ>` がタグ別の一覧になり、商品ページにパンくず・ブランド・公開項目・タグのリンクが出ます。

---

## A. 購入リンク

```
GET /<shop>/buy?sku=<sku_id>&qty=1
GET /<shop>/buy?items=<sku_id>:2,<sku_id>:1
```

今のカートに足してカート画面へ移動します。非公開・削除済みの SKU は 404。SKU の id は `GET /api/shops/<shop>/products/<product>` の `skus[].id` です。

```html
<a href="https://shop.example.com/my-shop/buy?sku=0d6f...&qty=1">購入する</a>
```

LINE のメッセージ、Instagram のプロフィールや DM にもそのまま貼れます。

---

## B. カート API

カートは **署名付きトークン**（文字列）です。Banto はカートをサーバーに保存しません。連携側はトークンを保持し（`localStorage` 等）、毎回そのまま送ります。
トークンには SKU の id と数量（と、入力されたクーポンのコード）しか入っておらず、価格・在庫・送料・値引きは呼び出しのたびに Banto が最新の値で判定し直します。

### カートを操作する

```
POST /api/shops/<shop>/cart
Content-Type: application/json

{ "cart": "<トークン。初回は省略>", "op": "add", "sku_id": "<sku_id>", "qty": 1 }
```

| op | 意味 | 必須 |
| --- | --- | --- |
| `add` | 数量を足す（`qty` 省略時は 1） | `sku_id` |
| `set` | 数量を指定（0 で削除） | `sku_id`, `qty` |
| `remove` | その SKU を外す | `sku_id` |
| `clear` | 空にする | なし |
| `coupon_add` | クーポンのコードを入れる（大文字に揃える。最大 5 件） | `code` |
| `coupon_remove` | クーポンのコードを外す | `code` |

クーポンは同梱モジュール「クーポン」を ON にしたショップでだけ使えます（OFF なら `coupon_*` は 409 `coupons_disabled`、応答の `coupons` は `null`）。

### カートを読む

```
GET /api/shops/<shop>/cart?cart=<トークン>
```

### 応答（どちらも同じ形）

```json
{
  "cart": "<新しいトークン。次の呼び出しではこれを使う>",
  "items": [
    { "sku_id": "…", "sku_code": "TEE-M", "sku_name": "M", "product_id": "…", "product_slug": "tee", "product_name": "Tシャツ",
      "unit_price_jpy": 3000, "qty": 2, "line_total_jpy": 6000, "in_stock": true, "short": false }
  ],
  "removed": [],
  "count": 2,
  "subtotal_jpy": 6000,
  "tax_rate": 10,
  "tax_included": true,
  "shipping": { "summary": "全国一律 ¥500", "free_over_jpy": 10000, "remaining_for_free_jpy": 4000, "by_prefecture": null },
  "payments": { "stripe": true, "komoju": false },
  "delivery": { "dates": [{ "value": "2026-10-20", "label": "10月20日（火）" }], "slots": [{ "value": "am", "label": "午前中" }] },
  "can_checkout": true,
  "checkout_url": "https://shop.example.com/my-shop/cart/load?cart=…",
  "coupons": {
    "applied": [{ "code": "TEN", "name": "10% オフ", "kind": "percent", "amount_jpy": 600 }],
    "rejected": [{ "code": "OLD", "reason": "ended", "message": "このクーポンの利用期間は終了しました" }],
    "discount_jpy": 600,
    "subtotal_after_discount_jpy": 5400
  },
  "limits": { "max_lines": 20, "max_qty": 99, "max_coupons": 5 }
}
```

- `short: true` は在庫が足りない行です。`can_checkout` が false のあいだは購入に進めません。
- `removed` は非公開になった・削除された SKU です。返したトークンからは外してあります。
- 価格はすべて税込です。
- `checkout_url` を開くと、そのブラウザのカートになり、Banto のカート画面から配送先 → 最終確認 → 決済へ進みます（B の終点）。クーポンのコードも引き継ぎます。
- `delivery` は配送日時の選択肢（同梱モジュール「配送日時の指定」が ON のときだけ。OFF なら `null`）。`dates[].value`（`YYYY-MM-DD`）と `slots[].value` を、チェックアウト API の配送先の `delivery_date` / `delivery_slot` にそのまま渡します。`label` は表示用（デプロイのロケール）。日付は応答した時点の「今日」から数えるので、カートの応答を使い回さないでください（日付をまたいで古い日を送ると quote が `invalid_address` の `delivery_date` を返すので、カートを取り直して選び直してもらいます）。
- `coupons.discount_jpy` は商品の値引きです。送料無料のクーポンは、送料が決まる quote（最終確認の内容）で反映されます。
- `coupons.rejected` は入力されたが使えないクーポンと理由です（`reason`: `not_found` / `inactive` / `not_started` / `ended` / `members_only` / `limit_reached` / `exhausted` / `not_combinable` / `too_many` / `no_eligible_items` / `min_subtotal` / `max_subtotal` / `min_qty`）。`message` をそのまま表示できます。条件を満たせば使えるようになるもの（`min_subtotal` など）はトークンに残しています。
- 1 人あたりの回数は、ゲストではカートの時点で分からない（購入者のメールアドレスが未定）ので、quote で判定します。会員のトークン（下の「会員」）を付けると、カートの時点から会員 ID で判定し、会員限定のクーポンも使えます。

### エラー

| status | `error` | 意味 |
| --- | --- | --- |
| 400 | `invalid_request` | `op` / `sku_id` / `qty` の形が違う（`field` に項目名） |
| 400 | `invalid_cart` | トークンの署名が合わない。保持しているトークンを捨てて作り直す |
| 404 | `sku_not_available` | 非公開・削除済みの SKU |
| 404 | `not_found` | ショップが無い・非公開 |
| 503 | `not_configured` | Banto の設定が終わっていない |

---

## C. チェックアウト API

```
POST /api/shops/<shop>/checkout/quote   カート + 配送先 → 最終確認の内容（confirmation）と quote
POST /api/shops/<shop>/checkout         quote → 決済ページの URL
```

### 1. 最終確認の内容を受け取る

```json
POST /api/shops/<shop>/checkout/quote
{
  "cart": "<カートのトークン>",
  "provider": "stripe",
  "address": {
    "customer_name": "山田 太郎", "customer_email": "buyer@example.com", "phone": "0312345678",
    "postal_code": "100-0001", "state": "東京都", "city": "千代田区", "line1": "千代田1-1", "line2": ""
  }
}
```

`provider` は `stripe` か `komoju`（カートの `payments` で true のもの）。`state` は都道府県名。`line2` 以外は必須です。

応答:

```json
{
  "quote": "<署名付き。購入者に見せた内容そのもの>",
  "expires_at": "2026-10-16T12:34:56.000Z",
  "confirmation": {
    "shop": { "name": "マイショップ", "slug": "my-shop" },
    "lines": [ { "sku_id": "…", "code": "TEE-M", "product_name": "Tシャツ", "sku_name": "M", "unit_price_jpy": 3000, "qty": 2, "line_total_jpy": 6000, "tax_rate": 10, "reduced": false } ],
    "subtotal_jpy": 6000,
    "shipping_jpy": 500,
    "discounts": [{ "code": "TEN", "name": "10% オフ", "amount_jpy": 600 }],
    "discount_jpy": 600,
    "total_jpy": 5900,
    "coupon_notices": [],
    "tax_rate": 10,
    "tax": [ { "rate": 10, "amount_jpy": 5900, "tax_jpy": 536 } ],
    "tax_included": true,
    "payment": { "provider": "stripe", "method": "クレジットカード等（Stripe）", "timing": "決済ページでお支払い手続きを完了した時点で決済されます。", "note": null },
    "delivery": "ご入金確認後 3 営業日以内に発送します。",
    "cancellation": "決済完了後のキャンセルはお受けできません。…",
    "ship_to": { "name": "山田 太郎", "email": "…", "phone": "…", "postal_code": "…", "state": "東京都", "city": "…", "line1": "…", "line2": "" },
    "links": { "legal": "https://…/my-shop/legal", "privacy": "https://…/my-shop/privacy", "returns": "https://…/my-shop/returns" },
    "submit_label": "注文を確定する（決済ページへ）"
  }
}
```

- `tax` は税率ごとの対象額（税込、値引きの按分後）と消費税額です（docs/tax.md）。軽減税率の商品（`lines[].reduced`）があるときは、確認画面で「※ は軽減税率の対象です」と税率ごとの内訳も出してください。

`delivery` / `cancellation` / `payment.note` は管理画面 → ショップ設定 →「購入前の確認画面」で運営者が入れた文言です（連携側の管理画面からは AI 用 API の `PATCH /api/v1/shop` の `checkout_terms` で編集できます。docs/api.md）。
未設定のときは `null` になります。そのときは `links.legal`（引渡時期）と `links.returns`（取消し・返品）への案内を表示してください。

`total_jpy` は値引き後の支払総額です（小計 + 送料 − 値引き）。`coupon_notices` は使えなかったクーポンと理由で、値引きに含まれていません。

`total_jpy` が 0 のとき（クーポンで全額値引き・0 円の商品）は `payment.free: true` になり、`submit_label` は「注文を確定する」です。3 で決済ページへは行かずに注文が確定します。

エラー: 400 `invalid_address`（`fields` に不備のある項目名）、400 `invalid_cart`、409 `empty_cart`、409 `stock`、409 `payment_unavailable`、409 `minimum_amount`（値引き後の支払額が 1〜49 円。決済の最低額は 50 円）。

### 2. 最終確認画面を表示する（連携側の責任）

**申込みボタン（`submit_label`）の直前の画面に、`confirmation` の次の項目をすべて表示してください。**

- 商品ごとの名前・単価・数量・金額（`lines`）
- 商品合計・送料・値引き・**支払総額**（`subtotal_jpy` / `shipping_jpy` / `discounts` / `total_jpy`、税込であること）
- 支払方法と支払時期（`payment.method` / `payment.timing` / `payment.note`）
- 引渡時期（`delivery`、null なら `links.legal` への案内）
- 申込みの撤回・解除（キャンセル・返品）の条件（`cancellation`、null なら `links.returns` への案内）
- お届け先・連絡先（`ship_to`）
- 「お得な情報やセールの案内を受け取る」の選択（`marketing_consent`。ショップがこの欄を使うときだけ true / false、使わなければ null。quote の `address.marketing_consent` に true か `"1"` を渡すと受け取る、無ければ受け取らない。0050）
- 特商法表記・プライバシーポリシー・返品ポリシーへのリンク（`links`）

ボタンの文言は、押すと申込みになることが分かるもの（`submit_label` をそのまま使うのを推奨）にしてください。
表示を省いたり、金額を連携側で計算し直したりしないでください。

### 3. 注文を確定する

```json
POST /api/shops/<shop>/checkout
{ "quote": "<1 で受け取った quote>", "success_url": "https://example.com/thanks", "cancel_url": "https://example.com/cart" }
```

成功すると次が返ります。ブラウザを `payment_url` へ移動させてください。

```json
{
  "payment_url": "https://checkout.stripe.com/…",
  "status_token": "<照会トークン。戻り先の画面で注文の状態を引く（4）>",
  "status_url": "https://shop.example.com/api/shops/my-shop/checkout/status?token=…"
}
```

`success_url` には同じ照会トークンが `banto_status=<トークン>` として付きます（例: `https://example.com/thanks?order=1&banto_status=…`）。戻り先の画面はクエリから拾うか、`status_token` を連携側のセッションに置いておきます。

0 円の注文は、決済なしでこの時点で確定し、`{ "payment_url": "<success_url>?…&free=1", "free": true, "order_id": "…", "status_token": "…", "status_url": "…" }` が返ります（`payment_url` は完了画面）。

Banto は確定の直前に、価格・送料・在庫・クーポンを **引き直します**。quote の時点と 1 円でも違えば（クーポンの期間が終わった・上限に達した場合を含む）確定せず、次を返します。

```json
409 { "error": "changed", "quote": "<新しい quote>", "expires_at": "…", "confirmation": { … 新しい内容 … } }
```

この場合は、新しい `confirmation` で最終確認画面を表示し直し、購入者にもう一度ボタンを押してもらってください。
購入者に見せていない金額で申込みが成立することはありません。

| status | `error` | 意味 |
| --- | --- | --- |
| 400 | `invalid_quote` | 署名が合わない・期限切れ（1 時間）・別ショップ。quote から作り直す |
| 409 | `changed` | 確認後に内容が変わった（上記） |
| 409 | `stock` | 在庫が確保できなかった |
| 409 | `coupon_unavailable` | 確定の瞬間にクーポンの枠が無くなった・回数の上限に達した（在庫も戻してある）。quote から作り直す |
| 409 | `payment_unavailable` | その決済手段が使えなくなった |
| 502 | `payment_failed` | 決済ページを作れなかった（在庫は即座に戻す） |
| 503 | `not_configured` | Banto の設定が終わっていない |

`success_url` / `cancel_url` は、管理画面 → ショップ設定 →「ヘッドレス連携」で許可したサイト（オリジン）のものだけ使います。
許可していない URL は無視し、Banto の完了画面（`/<shop>/checkout/done`）とカート画面に戻します（オープンリダイレクト対策）。

**注文が確定するのは、決済事業者の Webhook を Banto が受けたときだけです。** `success_url` に戻ってきたことは、支払い完了の証拠になりません。戻り先の画面で確定と注文番号を出すには、次の 4 を使います。

### 4. 戻り先の画面（完了画面）で確定と注文番号を出す

```
GET /api/shops/<shop>/checkout/status?token=<照会トークン>
```

```json
{ "status": "confirmed", "order": { "number": 1023, "status": "paid", "total_jpy": 6500, "payment_provider": "stripe", "created_at": "…" }, "expires_at": "…" }
```

| `status` | 意味 | 画面の出し方 |
| --- | --- | --- |
| `pending` | 在庫を押さえて決済待ち（Webhook がまだ） | 「お支払いの確認中です」。数秒おきに呼び直す（Stripe の Webhook はふつう数秒で届きます） |
| `confirmed` | 注文が確定した | 「ご注文が確定しました（注文番号 1023）」。`order.status` は `paid` / `shipped` / `cancelled` / `refunded` |
| `released` | 決済が完了しないまま予約が解放された（期限切れ・金額の不一致で返金） | 「ご注文は成立しませんでした」。もう一度カートから |
| `not_found` | その quote の予約が無い（確定の前に失敗した） | 同上 |

- 照会トークンは quote の識別子をショップごとに署名したもので、**個人情報を含みません**。返るのも注文番号・状態・合計だけです（宛先・連絡先は返しません。それは注文照会 `/<shop>/orders/lookup` の仕事）。期限は 24 時間。
- `pending` のまま 10 分以上経つなら、Webhook が届いていない可能性があります。「確認でき次第メールでお知らせします」に切り替えてください（Banto の Cron が予約を解放し、支払いがあれば Webhook の再送で確定します）。
- 応答はキャッシュしないでください（`cache-control: no-store`）。
- 同梱テーマの完了画面（`/<shop>/checkout/done?s=…`）も同じ仕組みで、確認中は 4 秒おきに自動更新し、確定したら注文番号を出します。
- 一覧で確定を知りたい（在庫や会計と連動したい）場合は hooks の `order.paid`（docs/hooks.md）を使ってください。

### C を選ぶときの責任

特定商取引法上の義務（最終確認画面の表示など）を負うのは **販売業者＝ショップの運営者** です。Banto（ソフトウェア）でも、連携側のシステムでもありません。
A・B では Banto の画面が表示を担いますが、**C では連携側の画面が最終確認画面になるため、表示の漏れは連携側の実装の問題になります。**
制作会社に連携側を作らせる場合は、上の「2. 最終確認画面を表示する」を仕様として渡してください。
文言が法令に合っているかは、運営者が消費者庁のガイドライン等で確認してください（Banto は無保証の OSS です）。

---

## 会員（会員限定のクーポン・会員の注文）

会員機能（管理画面 → ショップ設定 → 会員）を有効にしたショップでは、連携側の画面で会員にログインしてもらい、Banto が発行するトークンを API に付けられます。
アカウントはショップごと、**パスワードはありません**。メールに届く 6 桁のコードかリンクで入ります（docs/members.md）。

1. `POST /api/shops/<shop>/members/login` `{ "email": "...", "return_to": "https://wp.example.com/my-account/" }` → `{ "challenge_id": "..." }`
   - 登録の有無・送信回数の上限にかかわらず、同じ形で返します（どのアドレスが会員か外から分からないように）。初めてのアドレスは、verify の時点で会員になります。
   - `return_to` はメールのリンクの行き先です。**ショップ設定の「決済後の戻り先として許可するサイト」（`return_origins`）のオリジンだけ** 使えます。リンクは `<return_to>?banto_challenge=<id>&banto_token=<token>` になります。省くか許可されていなければ、Banto の確認画面へのリンクになります。
2. 会員がコードを入れたら、またはリンクで連携側のページが開いたら:
   `POST /api/shops/<shop>/members/verify` `{ "challenge_id": "...", "code": "123456" }` か `{ "challenge_id": "...", "token": "<banto_token>" }`
   → `{ "access_token": "bm1....", "refresh_token": "bm1....", "expires_in": 900, "member": { "id", "email", "created" } }`
   - リンクのページは、開いただけで verify せず、ボタンを押してもらってから呼んでください（メールの安全検査がリンクを先に開くと、使用済みになるため）。
3. カート・quote・確定の呼び出しに付ける: `Authorization: Bearer <access_token>`。期限（15 分）が切れたら `POST /api/shops/<shop>/members/refresh` `{ "refresh_token": "..." }` で新しい組を受け取ります（refresh は 30 日）。
   - **refresh は 1 回ごとに変わります**（データベースの更新 `0045_member_sessions` の後）。受け取った新しい `refresh_token` で、保存していたものを置き換えてください。前のものをもう一度使うと、盗まれたトークンの使い回しと見なして **その端末のログインごと取り消します**（401 `refresh_token_reused`。本人の新しい refresh も使えなくなるので、login からやり直し）。同時に refresh した 2 つ目の呼び出し（タブを 2 つ開いていた等）のために、回した直後の 30 秒だけは前のものも通します。
   - ログインはログインした時点から最長 90 日です（refresh で延ばせません）。過ぎたら login からやり直します。
   - トークンの中身は署名付きの平文（暗号化していない）なので、メールアドレスは入れていません。

ほかのログインの方法（ショップの設定で有効なときだけ。`/members/config` の `login` に出ます）:

- **パスワード**（`password`）: `POST /api/shops/<shop>/members/password-login` `{ "email", "password" }` → verify と同じ形のトークン。間違いが続くと 429 `locked`（コードでは入れる）。パスワードを決める・変えるのは `POST /api/shops/<shop>/members/password` `{ "password" }`（Bearer）→ 新しいトークンの組（ほかの端末はログアウト）。password-login に成功すると、会員に「パスワードでログインしました」のメールが毎回届きます（同梱テーマの画面では、初めての端末のときだけ。docs/members.md 3-2）。
- **パスキー**（`passkey`。同梱モジュール passkey、ショップに独自ドメインがあるときだけ）: ブラウザで `GET /api/shops/<shop>/members/passkey?return_to=<許可リストの URL>` を開くと、**ショップのドメインの** パスキーの画面へ進み、ログインすると `<return_to>?banto_handoff=<券>` に戻ります。あとは LINE・Google と同じく `verify` `{ "handoff" }` でトークンに引き換えます。パスキーはショップのドメインに結びつくので、連携サイトの画面の上では使いません（会員がパスキーを追加するのも、ショップのドメインのマイページです）。
- **LINE・Google**（`line`・`google`）: ブラウザで `GET /api/shops/<shop>/members/oauth/<line|google>?return_to=<許可リストの URL>` を開くと同意画面へ進み、戻ると `<return_to>?banto_handoff=<券>` に戻ります（失敗したら `banto_error=…`）。連携側は `POST /api/shops/<shop>/members/verify` `{ "handoff": "<券>" }` でトークンに引き換えます（2 分・1 回限り。トークンそのものは URL に載せません）。

トークンはショップごとです（別のショップでは使えません）。本文で受け渡すので、Cookie は使いません。保存するなら連携側のサーバーのセッションに置き、ブラウザの localStorage には置かないでください。

トークンを付けると、Banto は会員として判定します。

- 会員限定のクーポンが使える。1 人あたりの回数は会員 ID で数える（メールアドレスを変えても同じ人）
- 注文が会員に紐づく（会員ページの注文履歴に出る）
- カートの応答の `member` に会員 ID が入る（トークンなしなら `null`）

| status | `error` | 意味 |
| --- | --- | --- |
| 400 | `invalid_email` | メールアドレスの形が違う（login） |
| 401 | `invalid_code` | コードが違う（verify。あと何回か試せる） |
| 401 | `expired` | 期限切れ・使用済み・5 回間違えた（verify。login からやり直す） |
| 409 | `plan_limit_exceeded` | 初めての方の登録が、この Banto のプランの会員数の上限（0052）に達した（verify）。お店に知らせる |
| 429 | `plan_limit_exceeded` | この Banto のプランの 1 日のメール（ログインのコード・招待）の上限（0053）に達した（login）。しばらくしてからやり直す |
| 401 | `invalid_member_token` | トークンが確かめられない（期限切れ・改ざん・他店のトークン・全端末からログアウトした後）。refresh して呼び直す。黙ってゲスト扱いにはしない |
| 401 | `invalid_refresh_token` | refresh できない（期限切れ・退会・ログアウト・全端末からログアウトした後・`0045` より前に発行した refresh）。login からやり直す |
| 401 | `refresh_token_reused` | 前の refresh を使い回した。その端末のログインを取り消した。login からやり直す |
| 502 | `mail_failed` | メールを送れなかった |
| 503 | `unavailable` | ショップのメール（メール通知プラグインの送信元）の設定が済んでいない |

- quote を作ったときと確定のときで会員が違う・トークンを外した場合は、判定し直して 409 `changed` で出し直します（会員限定の値引きは付きません）。
- `GET /api/shops/<shop>/members/me`（トークン必須）で、会員 ID・メールアドレスと、このショップでの注文の一覧（番号・状態・金額・日時。住所は返さない）を返します。注文 1 件の中身と領収書は `/members/orders/<番号>`（下の「注文照会・領収書」）。
- `POST /api/shops/<shop>/members/logout`（`Authorization: Bearer <access_token>` か本文の `{ "refresh_token": "..." }`）で、**この端末のログインを取り消します**（refresh はすぐ使えなくなります。access は期限の 15 分までは通るので、連携側でも捨ててください）。
- `GET /api/shops/<shop>/members/sessions`（トークン必須）→ `{ "sessions": [{ "id", "kind": "web" | "api", "label": "Chrome / macOS" | null, "created_at", "last_seen_at", "current" }] }`。ログイン中の端末（同梱テーマの画面でのログインを含む）。`POST /api/shops/<shop>/members/sessions/<id>/revoke` でその端末のログインを取り消します（`web` は数分以内、`api` は次の refresh で止まります）。
- `POST /api/shops/<shop>/members/logout-all`（トークン必須）で、その会員のすべての端末のログインを切ります（発行済みのトークンも使えなくなります）。
- `GET /api/shops/<shop>/members/config` → `{ "enabled": true, "login": ["email_code", "email_link", "password", "line", "google"] }`（有効なものだけ）。
- 会員機能が OFF のショップでは、トークンを無視してゲストとして扱います。

## お店で試着（同梱モジュール store_tryon）

同梱モジュール「お店で試着」を ON にしたショップでは、連携側の画面から実店舗の案内と試着の申し込みを出せます（docs/store-tryon.md）。**決済はしません**（購入は店舗のレジ）。モジュールが OFF なら `404 { "error": "tryon_disabled" }`。

```
GET  /api/shops/<shop>/stores
POST /api/shops/<shop>/tryon   { "cart": "<カートのトークン>", "store": "<店舗の id>", "visit_date": "2026-10-24", "customer_name": "...", "customer_email": "...", "customer_phone": "...", "note": "..." }
```

- `/stores` は、このショップで使う実店舗（住所・電話・ご案内・`hours`（曜日ごと、キーは 0 = 日曜）・`special_days`・表示用の `week`・`today`（`open`・`hours`・`text`）・`specials`）と、試着の設定（`tryon.mode`・`max_items`・`hold_days`・`notice`）を返します。店舗のメールアドレスは返しません。
  - `tryon: false` の店舗は案内だけ（試着は受けません）。
  - 来店日を選ぶ形（`mode: "visit"`）のときは、試着を受ける店舗ごとに選べる日（`visit_dates`。定休日・臨時休業を除く）が付きます。
- `/tryon` はカート API のトークンの中身を申し込みます。在庫はこの時点で減ります。応答は `201 { "number": 受付番号, "store": {…}, "visit_date", "cart": "<商品を外したトークン>", "member" }`。クーポンはカートに残します。
- `Authorization: Bearer <会員トークン>` を付けると会員の申し込みになり、`GET /api/shops/<shop>/members/tryon` で一覧（`cancellable` つき）、`POST /api/shops/<shop>/members/tryon/<受付番号>/cancel` で取り消せます（取り置きが終わる前だけ。取り消しても在庫はショップの担当者が戻すまで戻りません）。
- 申し込みのお知らせ（お客様・店舗へのメール、LINE、hooks の `tryon.requested`）は、同梱テーマから申し込んだときと同じです。

| status | `error` | 意味 |
| --- | --- | --- |
| 400 | `invalid_cart` | カートのトークンが無い・署名が合わない |
| 400 | `store_unavailable` | 店舗が無い・試着を受けない |
| 400 | `invalid_request` | `field` が `date`（来店日が選べる日でない）・`name`・`email`・`phone` |
| 409 | `empty_cart` / `too_many_items`（`max_items`）/ `stock` | カートが空・点数の上限を超えた・在庫が足りない |

---

## 注文照会・領収書

注文の状況と領収書を、連携サイトの画面で出せます。**Banto が返すのはデータ（JSON）だけ**で、レイアウト・宛名の欄・印刷の体裁は連携サイトが決めます。

```
POST /api/shops/<shop>/orders/lookup                    { "number": 1001, "email": "..." } → { order, receipt_available, order_token }
POST /api/shops/<shop>/orders/receipt                   { "order_token": "..." } → { receipt }
GET  /api/shops/<shop>/members/orders/<番号>            （会員トークン）→ { order, receipt_available }
GET  /api/shops/<shop>/members/orders/<番号>/receipt    （会員トークン）→ { receipt }
```

- **ゲストの注文**は、注文番号と注文時のメールアドレスで開きます（同梱テーマの注文照会と同じ）。合わなければ `404 not_found`（番号とアドレスのどちらが違ったかは返しません）。`order_token`（24 時間）は領収書と、この注文についてのお問い合わせ（`/inquiries` の `order_token`）にそのまま渡せます。
- **会員の注文**は会員トークンで開きます（その会員の注文だけ。別の会員の注文・ゲストで買った注文は `404 not_found`）。ゲストで買った注文は会員に結びつけません（番号とメールアドレスで開いてください）。
- `order` は `number` `status`（`paid` / `shipped` / `cancelled` / `refunded`）`created_at` `shipped_at` `total_jpy` `shipping_jpy` `discount_jpy` `discounts` `tracking`（`carrier` `number`）`items`（`name` `sku` `qty` `unit_price_jpy` `tax_rate`）など。**住所・メールアドレスは返しません。**
- `receipt`（同梱モジュール receipt が ON で、支払い済み・発送済みの注文だけ。ほかは `409 receipt_not_available`、モジュールが OFF なら `404 receipt_disabled`）は、領収書（適格簡易請求書）の記載事項と計算結果です: `kind`（登録番号があれば `qualified_simplified_invoice`、無ければ `receipt`）`issuer` `invoice_number` `proviso`（但し書き）`issued_at` `number` `order_date` `items`（`line_total_jpy`、軽減税率の対象は `reduced: true`。表示に ※ を付けて凡例を添える）`shipping_jpy` `discounts` `total_jpy` `tax`（税率ごとの `rate` `amount_jpy`（税込の対象額）`tax_jpy`（うち消費税額））。**税の計算は Banto の結果をそのまま表示してください**（連携側で計算し直すと端数が合わなくなります）。宛名は購入者が連携側の画面で入れるものとして、Banto は受け取りません。
- 応答はキャッシュさせません（`Cache-Control: no-store`）。メールアドレスを URL に載せないため、ゲストの呼び出しは POST です。

### 注文メールのリンクを連携サイトに向ける

管理画面 → ショップ設定 → ヘッドレス連携の「注文照会のページ」に連携サイトのページの URL を入れると（`settings.headless.order_page_url`、0066。上の「決済後の戻り先として許可するサイト」にあるサイトの https の URL だけ）、

- 注文メール（注文確認・発送）の「ご注文の状況」のリンクが `<ページ>?banto_order=<注文番号>` になります。会員の注文なら `&banto_member=1` も付きます。**URL にメールアドレスや秘密は載せません。**
- Banto の注文照会の画面（`/<shop>/orders/lookup`）は、同じクエリのままそのページへ 302 で移ります。
- 公開の settings（`GET /api/shops/:shop` が使う `shop_public_get`）の `headless.order_page_url` にも出ます。

連携サイトのページの作り方（おすすめの流れ）:

1. `banto_member=1` が付いていて、会員がログインしていれば `GET /members/orders/<banto_order>` で開いて表示する。
2. `banto_member=1` が付いていて、ログインしていなければログインの画面を出し、ログインした後にこのページ（同じクエリ）へ戻して 1 へ。**ログインした後に戻すのは連携サイトの仕事**です（Banto のメールのリンク・LINE・Google・パスキーを通るログインでは、`return_to` にこのページの URL を入れておけば、そこへ戻ります）。
3. `banto_member` が無ければ、注文番号を埋めた欄とメールアドレスの欄を出し、`POST /orders/lookup` で開く。
4. `receipt_available` が `true` なら領収書のボタンを出し、会員は `/members/orders/<番号>/receipt`、ゲストは `POST /orders/receipt`（`order_token`）でデータを受け取って、連携サイトのレイアウトで表示・印刷する。

入れなければ、リンクは Banto の注文照会の画面（`/<shop>/orders/lookup?banto_order=…`）になります。同梱テーマも同じ動きです（会員の注文はログインしていればそのまま出し、していなければログインしてから戻します。ゲストの注文は番号を埋めてメールアドレスを入れてもらいます）。

注意: 注文照会（`orders/lookup`）には回数の上限がありません（同梱テーマの注文照会の画面と同じ）。番号とメールアドレスの両方が合わなければ何も返しません。

| status | `error` | 意味 |
| --- | --- | --- |
| 400 | `invalid_request` | 番号かメールアドレスの形が違う（lookup） |
| 400 | `invalid_order_token` | 注文トークンの署名・期限が合わない（receipt。lookup からやり直す） |
| 401 | `invalid_member_token` / `member_token_required` | 会員トークンが確かめられない・付いていない |
| 404 | `not_found` / `receipt_disabled` | 注文が開けない・領収書のモジュールが OFF |
| 409 | `receipt_not_available` / `members_disabled` | 支払い済みでない（キャンセル・返金済み）・会員機能が OFF |

---

## 法務のページ（特商法・プライバシー・返品）

連携サイトのデザインで法務のページを出すには、2 つのやり方があります。どちらでも**文面の正は Banto**です（管理画面のショップ設定で入れ、公開に必要な入力も今までどおり）。

1. **本文を読んで出す**: `GET /api/shops/:shop` の `legal_notice` / `privacy_policy` / `return_policy` を、連携サイトのページに表示します。
2. **Banto のページを連携サイトに向ける**（0062）: 管理画面 → ショップ設定 →「法務のページを連携サイトで出す」に、連携サイトのページの URL を入れます。お客様が Banto のページ（`/<ショップ>/legal`・`/privacy`・`/returns`）を開くと、外のページが生きていればそちらへ 302 で移り、届かなければ Banto のページを出します。
   - 使えるのは、上の「決済後の戻り先として許可するサイト」（`return_origins`）にあるサイトの https の URL だけです。変えるには「連携」の項目（`integrations`）が要ります。
   - 生きているかは、お客様が開くたびではなく、決まった間隔（1 時間・6 時間・**1 日（既定）**・1 週間）と、保存したとき・「今すぐ確かめる」を押したときに確かめます。2xx で HTML が返れば生きているとみなします。
   - **メール・領収書・最終確認の API の `links.*` は Banto の URL のまま**です。そこから上の振り分けで外のページへ移ります（送ったメールのリンクも、開いた時点で生きている方へ着きます）。
   - `GET /api/shops/:shop` の `legal_links` に、今お客様を向けている外の URL が入ります（向けていない・落ちているものは入りません）。

注意:
- 外のページが落ちてから次に確かめるまでのあいだは、外のサイトのエラー画面へ案内してしまいます。止めたくないショップは間隔を短くしてください。
- 外のページの中身が古い・違うこと、200 を返すエラー画面は見分けられません。外のページは 1 のやり方（API の本文を表示する）で作ることをおすすめします。

---

## お問い合わせ（同梱モジュール inquiries）

同梱モジュール「お問い合わせ」を ON にしたショップでは、連携側の画面からお問い合わせを受け、やり取りを続けられます（docs/inquiries.md）。
判定（アドレスの確認・注文への結びつけ・回数の上限）は同梱テーマと同じです。モジュールが OFF か 0061 が未適用なら `404 { "error": "inquiries_disabled" }`。
`Authorization: Bearer <会員トークン>` を付けると会員として扱います（確認のメールなし・会員の受付番号で開ける）。

```
GET  /api/shops/<shop>/inquiries/config        → { categories: [{ value, label }], member }
POST /api/shops/<shop>/inquiries/order-check   { "number": 1001, "email": "..." } → { order, order_token }
POST /api/shops/<shop>/inquiries               { "category": "order", "body": "...", "name": "...", "email": "...", "order_number": "1001",
                                                 "order_token": "...", "checkout_token": "...", "return_to": "https://wp.example.com/contact/thread" }
                                               → 201 { number, verified, mail_sent }
POST /api/shops/<shop>/inquiries/view          { "token": "<リンクのトークン>" } か（会員）{ "number": 3 } → { inquiry }
POST /api/shops/<shop>/inquiries/reply         { "token" | "number", "body": "..." } → { number }
POST /api/shops/<shop>/inquiries/resend        { "number": 3, "email": "...", "return_to": "..." } → 202
GET  /api/shops/<shop>/inquiries               （会員）→ { inquiries: [...] }
```

- `category` は `product` / `order` / `account` / `other`。`email` はゲストだけ必須（会員・注文の根拠があるときは使いません）。
- 注文の根拠（どちらか）: `checkout_token`（決済の照会トークン。`/checkout` の応答・戻り先の URL のもの）、`order_token`（`order-check` で番号とメールアドレスが合ったときの値、24 時間）。どちらも無ければ `order_number` は「申告された番号」として扱い、注文時のアドレスと合えば結びます。
- メールのリンク: `return_to` が `settings.headless.return_origins` のオリジンなら `<return_to>?banto_inquiry=<トークン>`、それ以外は Banto の画面（`/<shop>/inquiries/open?t=…`）。連携側はその値を `view` / `reply` の `token` に渡します。リンクは 30 日有効です。**ゲストのチケットは、リンクで初めて `view` したときに確定します**（それまで `reply` は 404）。
- `inquiry` は `number` `status`（`waiting_shop` / `waiting_customer` / `closed`）`status_label` `category` `category_label` `verified` `order`（`number` `status` `created_at` `total_jpy`）`claimed_order_number` `messages`（`author`: `customer` / `shop`、`body`、`created_at`）`can_reply`。連絡先は返しません。**`body` はお客様と運営者が書いたテキストです。HTML として描画しないでください。**
- `resend` は番号とアドレスが合ったかどうかを返しません（いつも 202）。
- **添付ファイル**（公開しないバケットがあるときだけ）: `reply` を `multipart/form-data`（`token` か `number`・`body`・`files` を 3 個まで）で送ります。画像（JPEG・PNG・WebP）と PDF、1 個 5MB まで。確定したチケットだけです。`messages[].attachments` は `id` `filename` `content_type` `size` で、ファイルは `POST /api/shops/<shop>/inquiries/attachments/<id>`（`{ "token" }` か会員の `{ "number" }`）で受け取ります（トークンを URL に載せないため POST）。連携側で表示するときは、同じオリジンに置かず、ダウンロードとして渡してください。

| status | `error` | 意味 |
| --- | --- | --- |
| 400 | `invalid_request` | `field` が `category` / `body` / `email` |
| 400 | `invalid_order_token` / `invalid_checkout_token` | 注文の根拠の署名・期限が合わない |
| 401 | `invalid_member_token` / `invalid_member` | 会員トークンが確かめられない |
| 404 | `not_found` | トークン・受付番号でチケットが開けない（期限切れなら `resend`） |
| 409 | `closed` / `order_not_found` | 完了したチケット・注文が無い |
| 429 | `too_many` / `limit` | 回数の上限・1 日のメールの上限（docs/inquiries.md §5） |
| 503 | `unavailable` | メールの送信元が設定されていない |

---

## 埋め込みスニペット（WordPress・LP・ブログ）

どれもコピーして `shop.example.com` と `my-shop` を自分のものに変えるだけで使えます。WordPress ならブロックエディタの「カスタム HTML」に貼ります。

### 購入ボタン（段階 A、JavaScript なし）

```html
<a href="https://shop.example.com/my-shop/buy?sku=SKUのID&qty=1"
   style="display:inline-block;padding:.6rem 1.25rem;background:#1f6feb;color:#fff;border-radius:.3rem;text-decoration:none">
  購入する
</a>
```

### タグで絞った商品カード（公開読み取り API + 購入リンク）

```html
<div id="banto-products"></div>
<script>
(async () => {
  const base = "https://shop.example.com", shop = "my-shop", tag = "夏物";
  const el = document.getElementById("banto-products");
  const res = await fetch(`${base}/api/shops/${shop}/products?tag=${encodeURIComponent(tag)}&limit=12`);
  if (!res.ok) return;
  const { products } = await res.json();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  el.innerHTML = products.map((p) => `
    <a href="${base}/${shop}/p/${encodeURIComponent(p.slug)}" style="display:inline-block;width:12rem;margin:.5rem;color:inherit;text-decoration:none">
      ${p.thumb ? `<img src="${esc(p.thumb)}" alt="${esc(p.name)}" style="width:100%;aspect-ratio:1;object-fit:cover">` : ""}
      <div>${esc(p.name)}</div>
      ${p.min_price_jpy !== null ? `<div>¥${p.min_price_jpy.toLocaleString("ja-JP")}〜（税込）</div>` : ""}
    </a>`).join("");
})();
</script>
```

商品名などは運営者が入れた文字列なので、上のように必ずエスケープしてから HTML に入れてください。

### サイト内のカート（段階 B）

```html
<button id="add">カートに入れる</button> <span id="count"></span> <a id="go" hidden>購入手続きへ</a>
<script>
const base = "https://shop.example.com", shop = "my-shop", sku = "SKUのID";
const key = `banto-cart-${shop}`;
async function cart(body) {
  const res = await fetch(`${base}/api/shops/${shop}/cart`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cart: localStorage.getItem(key) || undefined, ...body }),
  });
  const v = await res.json();
  if (res.status === 400 && v.error === "invalid_cart") { localStorage.removeItem(key); return cart(body); }
  if (!res.ok) throw new Error(v.error);
  localStorage.setItem(key, v.cart);
  document.getElementById("count").textContent = `${v.count} 点 / ¥${v.subtotal_jpy.toLocaleString("ja-JP")}`;
  const go = document.getElementById("go");
  go.href = v.checkout_url; go.hidden = !v.can_checkout;
  return v;
}
document.getElementById("add").onclick = () => cart({ op: "add", sku_id: sku, qty: 1 });
</script>
```

「購入手続きへ」は Banto のカート画面に引き継ぎ、配送先 → 最終確認 → 決済は Banto の画面で進みます。

WordPress のプラグイン（Gutenberg ブロック）にする場合も、この 3 つの薄い皮にとどめ、注文・決済・カートのロジックは WordPress 側に置かないでください（別リポジトリで作る予定）。

---

## サーバー側で中継するとき（WordPress の PHP などが Banto を呼ぶ構成）

ブラウザではなく連携側のサーバーが Banto の API を呼ぶと、Banto から見た購入者の IP は全員そのサーバーの 1 つになります。Banto は IP ごとの上限を持っているので（同じ IP の未確定の予約は 20 まで、同じ IP からの会員ログインのコード発行は 1 時間に 30 回）、何もしないとそれが **サイト全体の上限** になります。決済ページを開いたまま支払っていない人が 20 人になると 21 人目が 429 になり、1 時間に 30 人しかログインできません。

対処は 2 段階です（データベースの更新 `0033_relay_limits` と `0034_relay_ips_private` が要ります）。

1. **中継元を宣言し、購入者の IP を申告する**（推奨）。管理画面 → ショップ設定 → ヘッドレス連携 → 「サーバー側で中継する連携サイトの送信元 IP」に、連携側のサーバーが Banto へ出て行くときの IP を入れます（複数可、IPv6 可。書き方は Banto 側でそろえるので、省略形でなくても構いません）。連携側は Banto を呼ぶとき、購入者の IP を `X-Banto-Client-IP` ヘッダーに入れます（PHP なら `$_SERVER['REMOTE_ADDR']`。自分のサイトが CDN の後ろなら、その CDN が付ける本当の IP のヘッダーの値）。Banto は宣言した IP から来た通信だけこのヘッダーを信じ、購入者ごとに数えます。ヘッダーが無い・IP の形でないときは中継元の IP のまま数えます（= 対処しないのと同じ）。宣言していない IP からのヘッダーは無視します（誰でも名乗れるため）。
   - **自分のサーバーの出口の IP が分からないとき**: 連携側のサーバーから AI 用トークン（スコープ `shop:read`）で `GET /api/v1/relay-check` を呼びます。`{ "ip": "<Banto に届いた送信元>", "forwarded_ip": "<X-Banto-Client-IP の値>", "trusted_relay": true/false, "effective_ip": "<回数の制限に使う IP>" }` が返るので、プラグインの接続テストで「この IP を中継元に登録してください / 登録済みです」と出せます（応答はキャッシュしません。設定の反映は 30 秒ほど）。
   - 中継元の IP の一覧は **お客様の画面や公開 API には出ません**（連携側のサーバーの素の IP なので。読むのは Banto の Worker と管理画面だけ）。
2. **上限を上げる**。送信元 IP が固定でなく宣言できないときは、同じ画面の「同じ IP の未確定の予約の上限」「同じ IP からの会員ログインのコード発行の上限」を上げます（1〜9999。AI 用トークンの `shop_update` / `PATCH /api/v1/shop` の `max_pending_per_ip` `login_per_ip_per_hour` でも変えられます）。同じ人（メールアドレス）ごとの上限とショップ全体の上限は変わらないので、上げても在庫の空押しの歯止めは残ります。

Cloudflare 側のレート制限（docs/hardening.md）も、中継構成では連携側のサーバーの IP しか見えません。Banto のドメインのルールは「中継元の IP を除外」するか、しきい値を中継の量に合わせてください。購入者ごとの制限は連携側のサイト（WordPress の前の CDN / WAF）で掛けます。

## 連携側の作り方の注意

- **サーバー側で中継するなら中継元を宣言する**（上の節）。しないと IP ごとの上限がサイト全体の上限になります。
- **読み取り API は自分でもキャッシュする。** Banto のキャッシュは isolate のメモリで短時間だけです。商品一覧・詳細は連携側（WordPress なら transients 等）で数分キャッシュしてください。カートとチェックアウトはキャッシュしないでください。
- **WordPress 側に注文・決済のロジックを置かない。** ボタン（購入リンク）とカートの表示だけにすると、WordPress の更新に巻き込まれません。
- **トークンは秘密ではありません**（中身は SKU と数量、quote は購入者自身の入力）が、改ざんは署名で検出します。quote は URL に載せず POST の本文で送ってください（配送先が入っているため）。
- 在庫はカートに入れた時点では確保しません。確保は「注文を確定する」（3）の時点で、決済ページの期限 + 5 分だけです（CLAUDE.md §6）。
