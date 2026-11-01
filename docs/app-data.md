# 外部プラグインの拡張データ（レビューなど）

> 0084_app_data（メンテナの決定 2026-11-01）。外部プラグイン（docs/hooks.md）が、商品に付くデータを Banto に置き直す仕組みです。
> 種類は 2 つです: Banto が形を知っていて自分で描くレビューの要約（`reviews.v1`）と、形を決めない `custom.v1`（0085）。

## 1. 考え方

- **押し込む形**です。プラグインは自分の DB（D1 でも何でも）を正にして、変わるたびに Banto の API で要約を置き直します。
  お客様の画面は Banto の中のデータだけで描き、**リクエストのたびにプラグインへ取りに行きません**（速さと、プラグインが落ちてもお店が崩れないため）。
- **種類は「プラグインごと」ではなく「データの種類ごと」**です。`reviews.v1` はどのレビューのプラグインでも共通で、2 つめのレビューのプラグインのために Banto を変える必要はありません。
  - Banto が形を知っている種類（`reviews.v1`）は、Banto 自身が既定のテーマと構造化データに描きます。
  - それ以外は **`custom.v1`**（形を決めない JSON）で、Banto の更新を待たずに置けます。Banto 自身は描かず、Liquid のテーマとヘッドレスだけが読みます。広く使われる種類になったら、形を決めた種類（例: `qa.v1`）に格上げして Banto が描くようにします。
- HTML やスクリプトは受けません（受けた文字は、すべて文字として描きます）。コアに第三者のコードを読み込まない決まり（CLAUDE.md §7）のままです。
- **誰のデータかは、種類ではなく連携で分かれます**。同じ種類・同じ名前を 2 つのプラグインが使っても別の行で、お客様の画面には連携の名前（`app`）を付けて渡します。
- 平均の星・件数・新しい 20 件は、サーバーで**見える HTML と構造化データ**（schema.org の `AggregateRating` と `Review`）の両方に描きます。
  検索エンジンの決まりで、マークアップしたレビューはページにも見えている必要があるためです。

## 2. つなぎ方（運営者）

1. 「連携」でプラグインの URL を登録し、**プラグインの名前**（拡張データの名前の空間。例: `reviews`）を付けます。
   - 英小文字で始まり、英小文字・数字・ハイフンの 40 文字まで。同じショップで重なりません。
   - マニフェストに `app` があれば、それが初めの値になります（決めるのは運営者です）。
2. 「AI 連携」でトークンを発行します。スコープ `app_data:write` を選び、**書き込む先のプラグイン**を選びます。
   - このトークンは、選んだプラグインの名前の空間にだけ書けます。ほかのプラグインのデータは書けません。
   - 発行できるのは、そのショップで項目「プラグインのデータ」（`apps`）を持つ人です。
     商品の担当（`catalog`）には付きません（外のサービスに書かせる許可を、商品の担当の権限に混ぜないため）。
3. トークンをプラグインの設定に貼ります（Banto の外。プラグインの説明に従います）。

- **連携を消すと、そのトークンとプラグインのデータも消えます**。
- 連携を無効にすると、データは残ったまま、お客様の画面に出なくなります。プラグインの名前を空にしても同じです。

## 3. 書き方（プラグインの作り手）

`Authorization: Bearer banto_...`（`app_data:write`）で:

| 操作 | REST |
| --- | --- |
| 置き直す | `PUT /api/v1/products/{商品の id}/app-data/reviews.v1`、本文 `{ "data": {...}, "public": true }` |
| 置き直す（custom.v1） | `PUT /api/v1/products/{商品の id}/app-data/custom.v1/{名前}`（本文は同じ） |
| 消す | `DELETE /api/v1/products/{商品の id}/app-data/reviews.v1`（custom.v1 は `…/custom.v1/{名前}`、名前を省くと自分の名前をすべて） |
| 置いたものの一覧 | `GET /api/v1/app-data?product_id=…&limit=…&offset=…` |

- 同じ商品・同じ形の分は**丸ごと入れ替わります**（差分ではありません）。
- `public: false` なら、置いたままお客様の画面に出しません。
- 商品の id は `products:read` のトークン（`GET /api/v1/products`）か、hooks の `product.updated` で知ります。
- MCP には出しません（プラグインのサーバーが使う口です）。

### `reviews.v1` の形

```json
{
  "rating_avg": 4.6,
  "rating_count": 128,
  "items": [
    {
      "id": "r_123",
      "rating": 5,
      "title": "着心地がよい",
      "body": "洗っても縮みませんでした。",
      "author_display": "東京都 T さん",
      "created_at": "2026-10-01T09:00:00+09:00",
      "verified_purchase": true,
      "incentivized": false
    }
  ]
}
```

| 項目 | 決まり |
| --- | --- |
| `rating_avg` | 0〜5 の数（件数が 1 以上なら 1 以上）。小数 2 桁に丸めます |
| `rating_count` | 0 以上の整数。`items` の数以上 |
| `items` | 新しい順に **20 件まで**。21 件目からは置きません |
| `items[].id` | プラグインのレビューの ID（100 文字まで） |
| `items[].rating` | 1〜5 の整数 |
| `items[].title` | 任意。200 文字まで |
| `items[].body` | 2,000 文字まで。HTML は文字のまま出ます |
| `items[].author_display` | 表示名（100 文字まで）。**メールアドレスなどの個人情報は入れません**（Banto に置くのは表示名だけ） |
| `items[].created_at` | 日時（ISO 8601） |
| `items[].verified_purchase` | 任意。購入者のレビューなら true（「購入者」の印） |
| `items[].incentivized` | 任意。**お礼（クーポンなど）を渡したレビューなら true**（「PR」の印）。景品表示法のステルスマーケティングの規制（2023 年 10 月から）に合わせて、必ず付けてください |

- 知らない鍵は落として保存します。誤りは 400 `invalid_app_data_<場所>`（`invalid_app_data_rating_avg`・`invalid_app_data_item_body` など）。
- 64KB を超える本文は受けません。
- 名前の無い連携に結んだトークンは 409 `app_handle_required`。

### `custom.v1` の形（0085）

形は決めませんが、次を確かめます。

- 名前（`{名前}`）: 英小文字で始まり、英小文字・数字・ハイフンの 40 文字まで。**1 つの商品に 20 まで**（超えると 409 `app_data_keys_full`）。名前ごとに丸ごと入れ替わります。
- 中身: JSON のオブジェクト。全体で 64KB・入れ子は 5 段・1 つのオブジェクトの鍵は 50 個・配列は 100 個・文字は 5,000 字まで。鍵の名前は英小文字・数字・`_`（`^[a-z][a-z0-9_]{0,63}$`）。
- **URL**: 鍵が `url` か `…_url` の値は `https://` で始まるものだけで、**テーマが `href` にそのまま使ってよいのはこの鍵だけ**です。どの文字も `javascript:`・`data:`・`vbscript:`・`file:` で始まるもの（スキームの途中にタブ・改行を挟んだものも）は受けませんが、ほかの鍵の文字は URL として確かめていないので `href` に入れないでください。
- 中身は組み直さずに、そのまま保存します。誤りは 400 `invalid_app_data_<場所>`（`invalid_app_data_key`・`invalid_app_data_url`・`invalid_app_data_too_deep` など）。
- 個人情報は置かないでください（お客様の画面に出ます）。

**消したレビューは、すぐに置き直してください**（取り下げ・非表示・削除の依頼）。Banto はプラグインの DB を見に行かないので、置き直すまで前のものが出ます。

## 4. 出るところ

- **既定のテーマ**: 商品の名前の下に星と件数（一覧へのリンク）、商品の下に「レビュー」の一覧。構造化データに `aggregateRating` と `review`。
- **Liquid のテーマ**（docs/themes.md）:
  - `product.reviews` … `rating`・`rating_count`・`items`（`id`・`rating`・`title`・`body`・`author`・`created_at`・`verified_purchase`・`incentivized`）・`app`。無ければ `nil`。
  - `product.apps` … `custom.v1` を「プラグインの名前 → 名前 → 中身」で。`{{ product.apps['size-guide']['size-table'].note }}`。文字は既定でエスケープされます。`href` に使ってよいのは `url` / `…_url` の鍵の値だけです（`https://` のものしか入っていません。ほかの鍵は URL として確かめていません）。
  - `product.app_data` … 公開の分すべて（`app`・`kind`・`key`・`data`）。
  - 構造化データは Banto が入れます（テーマで二重に入れないでください）。
- **ヘッドレスの公開 API**（docs/headless.md）: 商品の `app_data`（`key` 付き）と `reviews`。
- **既定のテーマは `custom.v1` を描きません**（形を知らないため）。
- 複数のプラグインがレビューを置いていたら、プラグインの名前の順で最初のものを使います。

## 6. プラグインのブロック（`::: app`、0086）

プラグインは**ブロックを提案**できます。決めるのは名前・使うデータの種類・設定の欄だけで、**見た目（HTML・スクリプト）は渡せません**。見せ方はテーマ（無ければ Banto の既定の見た目）が決めます。

### 提案のしかた（マニフェストの `blocks`、docs/hooks.md §4）

```json
{
  "name": "サイズ表",
  "app": "size-guide",
  "blocks": [
    { "id": "size-table", "label": "サイズ表", "kind": "custom.v1", "description": "採寸の表",
      "fields": [{ "key": "unit", "label": "単位", "type": "select", "options": [{ "value": "cm", "label": "cm" }, { "value": "inch", "label": "inch" }], "default": "cm" }] }
  ]
}
```

| 項目 | 決まり |
| --- | --- |
| `id` | 英小文字で始まり、英小文字・数字・ハイフンの 40 文字まで。1 つのマニフェストに 10 まで |
| `kind` | `reviews.v1` か `custom.v1` |
| `fields[]` | 8 つまで。`type` は `number`（`min`・`max`・`default`）か `select`（`options` の `value` は英小文字・数字・`_`・`-` の 40 文字まで）。鍵は `^[a-z][a-z0-9_]{0,30}$`、`product` と `style` は Banto が使うので使えません |

- 連携の登録・保存のときにマニフェストを読み直します。ブロックを足したら、連携の画面で一度「保存」してください。
- 編集の画面に出るのは、**有効で名前のある連携**のブロックだけです。

### 本文の書式

```
::: app size-guide size-table product=tee unit=cm
```

- 1 つ目は連携の名前（`app_handle`）、2 つ目はブロックの `id`、`product` はどの商品のデータを出すか（商品の URL の名前）。そのあとに設定の欄の値（`key=value`）と `style`（テーマのスタイル）。
- **1 ページに 2 つまで**（速度の予算。3 つ目からは描きません）。編集の画面では「プラグイン」の組から選び、設定の欄はマニフェストから作られます。
- 連携を外す・無効にする・名前を空にすると、印は残っても何も出さず、ページは崩れません。公開していない商品のデータも出ません。

### 見せ方（テーマ）

Liquid のテーマは、次の順に snippet を探して描きます。

1. `snippets/app-<連携の名前>-<ブロック>.liquid`（例: `app-size-guide-size-table`。連携の名前は運営者が付けるので重なりません）
2. `snippets/app-<ブロック>.liquid`（同じ種類のブロックをまとめて描く汎用の見た目）
3. どちらも無ければ Banto の既定の見た目（**`reviews.v1` だけ**。`custom.v1` は何も出しません）

snippet に渡すもの:

| 名前 | 中身 |
| --- | --- |
| `block` | `app`（連携の名前）・`id`・`settings`（設定の欄の値。文字）・`style`・`index` |
| `product` | `id`・`handle`・`title`・`url` |
| `reviews` | その連携のレビューの要約（`product.reviews` と同じ形。無ければ `nil`） |
| `data` | その連携の `custom.v1`（名前 → 中身。`data["size-table"].rows` のように） |

- 文字は既定でエスケープされます（`| raw` を使わないでください）。
- **見本の snippet はプラグインが説明書（README）で配り、運営者かテーマの作者が自分のテーマに入れます**。プラグインから Liquid を受け取って描くことはしません（`| raw` で HTML・スクリプトを出せてしまうため。CLAUDE.md §7）。
- 既定の見た目（`reviews.v1`）は、設定の `layout=summary` で星と件数だけ、`limit=1〜20` で一覧の件数です。
- ヘッドレスの公開 API のページ・記事の `html` には、既定の見た目が入ります。

## 7. もっと見る（0087）

Banto に置くレビューは新しい 20 件までです。21 件目からは、お客様が「もっと見る」を押したときに、**その人のブラウザがプラグインの公開 API から取り**、Banto の決まった形で描きます。お店の画面を描くときにはプラグインへ取りに行きません。

### プラグインの作り手

マニフェストに、種類ごとの公開 API の URL を書きます（`https://` だけ。問い合わせの文字列は付けてよい）。

```json
{ "name": "レビュー", "app": "reviews", "more": { "reviews.v1": "https://reviews.example/api/banto/reviews" } }
```

Banto のスクリプトは次のように取りに行きます。

```
GET https://reviews.example/api/banto/reviews?product=<商品の id>&offset=20&limit=20
```

- 返すのは `{ "items": [ …reviews.v1 の items と同じ形… ], "next_offset": 40 }`。続きが無ければ `next_offset` を `null` にします。
- **CORS を許してください**（`Access-Control-Allow-Origin: *` で十分です。Cookie は送られません）。
- `offset` は Banto に置いた並び（新しい順）と同じ数え方です。既定の見た目は置いた分のあとから、`::: app` のブロックは画面に出した件数のあとから取りに行きます。
- 形の違う項目は描きません。1 回に 20 件、1 つの一覧で合わせて 200 件までです。

### Banto がすること

- 置いた件数より `rating_count` が多く、マニフェストに URL があるとき、一覧の下に「もっと見る」のボタンを出します。
- スクリプトは Banto のもの（`src/apps/reviews-html.ts`）だけです。受け取った文字は `textContent` で入れ、HTML として解釈しません。Cookie と参照元（Referer）は送りません。
- 足すのは `[data-banto-reviews]` の中の `ol.review-list` に、既定の見た目と同じ形の `li.review` です。

### テーマ（Liquid）

- 自分でレビューを描くテーマは、`[data-banto-reviews]` を付けた要素の中に `ol.review-list` と `{{ product.reviews.more_html }}` を置きます（ボタンとスクリプト。押すと `li.review` が足されます）。
- URL だけが要るときは `product.reviews.more_url`。

### 運営者へ

- 「もっと見る」を押した人のブラウザは、プラグインのドメインに問い合わせます（IP アドレスなどがプラグインに届きます）。**プライバシーポリシーにレビューのサービスを書いてください**。

## 5. 権限と保存

- 表は `app_data`（ショップ・連携・商品・形ごとに 1 行）。RLS があり、運営者は項目 `apps` で読めます。
  書くのは service_role の `api_app_data_*` だけです（トークン・スコープ・連携の持ち主の確認は SQL）。
- お客様の画面は `product_public_get` が、公開・連携が有効・名前のある分だけを商品と一緒に返します（DB の往復は増えません）。
- バックアップの書き出しには入れません（プラグインが置き直せるため）。
- 商品を消すと、その商品のデータも消えます。
