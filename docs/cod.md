# 代金引換（同梱モジュール cod）

商品のお届けのときに、お客様が配達員に代金を支払う方法をレジに足します。既定は OFF です（管理画面のショップ →「機能を追加」→「代金引換」）。マイグレーション `0157_mod_cod` を当てるまでは一覧に出ません。

## 流れ

1. お客様がカートで「代金引換で支払う」を選び、配送先を入れて最終確認画面へ。最終確認画面には **代引き手数料** の行と、支払いの時期（「商品のお届けのときに、配達員に合計の金額をお支払いください」）が出ます。
2. 「注文を確定する（代金引換）」を押すと、その場で注文が **受付（未入金）**（`status = pending`・`payment_status = unpaid`）として確定します。決済ページへは行きません。在庫はここで減ります。
3. 運営者が発送します（受付のまま「発送済み」にできます。送り状 CSV にも載ります。ヤマト運輸の B2 クラウドの CSV はコレクト（代引き額と内消費税つき）で出します。佐川急便の CSV には代引きの欄が無いので載せず、知らせます）。
4. 運送会社から代金が入金されたら、注文の画面で **「入金を記録する」** を押します。入金済みになり、売上に入り、`order.paid` が出て、領収書が出せるようになります（docs/hooks.md「注文の状態とお支払いの状態」）。
5. 受け取りを拒否されたら **「受け取り拒否で取り消す」**。返金はなく、在庫が戻ります。

「確定は決済の Webhook だけ」の例外です（0 円の注文・Amazon Pay に続く 3 つ目。docs/knowledge/02-decisions.md）。待つべき支払いが配達のときにしか無いため、確定の条件は Banto が引き直した金額と手数料だけです。

## 設定（`shops.settings.cod`）

| 項目 | 意味 |
| --- | --- |
| 手数料: 一律 | すべての注文で同じ手数料（税込、0〜100,000 円） |
| 手数料: 金額の段 | 1 行に「この金額まで,手数料」（例 `10000,330`）。10 段まで。金額は **商品の合計 + 送料 − 値引き**（手数料を除く）。どの段にも当たらない注文では代金引換を選べません |
| 上限金額 | 合計（手数料込み）がこれを超える注文では選べません。既定 300,000 円（運送会社の一般的な上限） |
| 会員だけ | ゲストの注文では選べません（会員としてログインしたお客様だけ） |
| 確認画面の文 | 最終確認画面の「お支払い」に添える文（500 字まで。例: 現金のみ）。空ならショップの「支払方法の説明」 |

手数料の決まりの読み方（一律・金額の段）は、KOMOJU の支払い方法ごとの手数料（0170、docs/plugins.md「KOMOJU」）と共通です（`banto_fee_rule` / `src/commerce/payment-fees.ts`）。

手数料は送料と同じく **標準税率** の課税対象で、値引き（クーポン）の対象にしません。注文には `fee_jpy` として残り、合計（`total_jpy`）に含まれます。

**特定商取引法に基づく表記** の「代金の支払時期・方法」と「商品代金以外の必要料金」に、代金引換と手数料を書き足してください（Banto は自動では書き換えません）。

## 判定の場所

- 手数料・使えるかの計算は `src/modules/cod/`（`codFee`・`codQuote`）。確認画面（`createQuote`）と確定の直前（`recheckQuote`）で使います。
- 確定のとき DB の `confirm_reservation` が同じ決まり（`banto_cod_fee`・`banto_cod_max_total`）で引き直し、モジュールが OFF・手数料が違う・上限を超える・会員だけなのにゲスト、のどれかなら確定しません（予約は戻ります）。TS と SQL の決まりは `test/fixtures/cod-fee-cases.ts` の答え合わせの表で縛っています。
- いたずらの注文を止める上限: 代金引換はその場で確定するので、未確定の予約の上限（`settings.checkout.max_pending_per_customer` / `max_pending_per_ip`）が効きません。代わりに `confirm_reservation` が、同じ人・同じ IP の未入金の代金引換の注文（直近 30 日、取り消しを除く）を数え、`settings.checkout.max_cod_unpaid_per_customer`（既定 3）/ `max_cod_unpaid_per_ip`（既定 10）に達していれば確定しません（お店の画面は「注文が多すぎます」、ヘッドレスは 429 `too_many_reservations`）。受け取り拒否が心配なお店は「会員だけ」をおすすめします。
- 支払い方法を絞っていないクーポンは代金引換でも使えます。絞ったクーポン（条件の「使える支払い方法」）は、その中に「代金引換」（`cod`、0158）があるときだけ使えます。値引きは手数料にはかかりません。

## お知らせ

- **お客様へのメール・LINE**（同梱プラグイン「メール通知」「LINE で購入者に知らせる」）: 代金引換の注文は `order.paid` が入金の記録まで出ないので、**`order.created` で受付の知らせ**（文面は「注文の受付」、docs/notices.md）を送ります。メールの明細には手数料の行と「お支払い方法: 代金引換」が入ります。入金を記録したときは重ねて送りません。
- **運営者の LINE 通知**: 「新しい注文が入りました（未入金）」を `order.created` で送ります。
- 今あるこれらのプラグインの送信先には、マイグレーション 0157 が購読に `order.created` を足します。プラグインは `order.created` のうち `payment_status = unpaid` のものだけを扱います（決済の注文の受付は今までどおり `order.paid`）。

## ヘッドレス

- カートの `payments.cod` が `true` なら選べます（金額・会員だけの判定は quote で）。
- `POST /api/shops/:shop/checkout/quote` に `provider: "cod"`。`confirmation.fee_jpy` が手数料、`confirmation.payment.cod` が `true`。選べないときは 409 `{ error: "cod_unavailable", reason }`（`fee` = 段に当たらない / `max_total` = 上限を超える / `members_only` = 会員だけ）。
- `POST /api/shops/:shop/checkout` は `{ payment_url, cod: true, order_id, status_token, status_url }`。`payment_url` は完了画面（`success_url`）です。

## Liquid のテーマ

- カートの `cart.banto_payment_methods` に `{ id: "cod", name: "代金引換で支払う" }` が入ります。`{% form 'cart' %}` の `provider` に `cod`。
- 最終確認画面の `checkout.confirmation.fee_price`（手数料）・`checkout.confirmation.cod`。表示の項目は `{% banto_confirmation %}` が手数料の行も描きます。
- 注文照会の `order.fee_price`。
