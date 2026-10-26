# 商品フィード（Google・Meta）と構造化データ

公開中の商品を **Google Merchant Center**（Google ショッピング・無料リスティング）と **Meta**（Facebook・Instagram のショップ・広告）のカタログに載せるための機能です。

## 1. 構造化データ（JSON-LD）— 設定なし

既定のテーマは、商品ページに schema.org の `Product`（名前・画像・ブランド・カテゴリー・SKU ごとの価格と在庫・JAN）を入れています。Google の検索結果に価格や在庫が出ることがあります（出すかどうかは Google が決めます）。

確かめ方: [リッチリザルト テスト](https://search.google.com/test/rich-results) に商品ページの URL を入れます。

## 2. 商品フィード — 同梱モジュール「商品フィード（Google・Meta）」

1. ショップ設定 → **モジュール** →「商品フィード（Google・Meta）」を ON にします。
2. モジュールの「開く」で、**フィードの URL**（`https://<ショップの URL>/feed/products.xml`）が出ます。「今すぐ作る」を押すと、すぐに作ります。以後は **1 時間ごと** に自動で作り直します。
   - 商品が多いショップ（数千件を超える）は、5 分ごとの定期処理で少しずつ作ります（1 回に Workers 無料プランは 3,000 商品、有料プランは 10,000 商品。`/admin/site` の「Workers のプラン」で決まります）。作り終えるまでは前のフィードを配ります。10 万商品なら無料プランで 3 時間ほど、100 万商品なら有料プランで 8 時間ほどかかります。
3. URL を各サービスに登録します。
   - **Google**: Merchant Center →「商品」→「フィード」→ 追加 →「スケジュールされた取得」で URL を登録（毎日取得）。送料・返品の設定は Merchant Center 側で行います。
   - **Meta**: コマースマネージャ →「カタログ」→「データソース」→「データフィード」→「スケジュールされたフィード」で URL を登録。

- Banto は Google・Meta の API キーを **預かりません**。各サービスが URL を読みに来る形です。
- 定期的に作るには、変数 `PUBLIC_BASE_URL` が要ります（独自ドメインのショップは不要）。
- 載る内容: SKU ごとに 1 件（サイズ違いなどは `item_group_id` で束ねます）。タイトル（商品名 + 選択肢）、説明、商品ページの URL、画像（最大 11 枚）、在庫の有無、価格（セール中は通常価格と販売価格）、ブランド、JAN（無ければ `identifier_exists=no`）、カテゴリー。
- 載らないもの: 非公開の商品、**画像の無い商品**（Google の必須項目）、価格が 0 円の SKU。件数はモジュールの画面に出ます。
- 在庫が変わってもフィードに出るのは最大 1 時間後です（Google・Meta が読みに来る間隔はそれより長いのが普通です）。
- 形式は RSS 2.0 + Google の名前空間（`g:`）です。Meta も同じ XML を読めます。

## 3. 仕組み（開発者向け）

- 構造化データ: `src/storefront/structured-data.ts`（データ取得なし）をテーマの `Layout` が `<script type="application/ld+json">` に入れる。`</script>` で抜けられないように `<` `>` `&` を逃がす。
- フィード: `src/modules/product-feed/`。Cron（`product_feeds`）が anon の経路で公開中の商品を読み、XML を StorageAdapter の `feeds/<shop_id>/products.xml` に置く（状態は `meta.json`）。配信は `/<スラッグ>/feed/products.xml`（10 分のキャッシュ）。管理画面の「今すぐ作る」は owner の JWT で読む。
- リクエストの中では作らない（配るだけ）。DB を引くのはキャッシュ済みのショップ行だけ。
