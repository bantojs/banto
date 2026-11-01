# 貼れるタグ（同梱モジュール embed）

STUDIO・Wix・ペライチ・Jimdo・Webflow・はてなブログ・手書きの LP など、**HTML を貼れるサイト**に Banto の商品とカートを置くためのタグです。
WordPress を使わない人でも、今あるサイトにそのまま「カートに入れる」を足せます。

- 商品の情報・価格・在庫は Banto から読みます。金額の計算はすべて Banto が行います。
- カートは貼った側のページに置き、**配送先・最終確認（特定商取引法の表示）・決済は Banto の画面**で進みます（docs/headless.md の段階 A / B）。貼った側のサイトで法務の画面を作る必要はありません。
- スクリプトはあなたの Banto（Worker）が配ります。開発チームや CDN を通らず、あなたの Banto とお客様のブラウザのあいだだけで動きます。

## 使い方

1. 管理画面 → ショップ → モジュール →「貼れるタグ」を ON にし、「開く」で貼るコードの画面へ。
2. **読み込みのタグ**をページに 1 回貼ります（サイト全体の `<head>` に入れられるなら、そこに 1 回）。

   ```html
   <script src="https://<あなたの Banto>/api/embed/v1.js" defer></script>
   ```

3. 置きたい場所に**部品**を貼ります。

   ```html
   <banto-cart shop="my-shop"></banto-cart>
   <banto-product shop="my-shop" product="tee"></banto-product>
   <banto-products shop="my-shop" tag="夏物" limit="12"></banto-products>
   <banto-buy-button shop="my-shop" sku="<SKU の id>" qty="1"></banto-buy-button>
   ```

管理画面の画面には、ショップのスラッグと公開中の商品（新しく更新した 30 件）を埋めたコードが出ます。

お店の画面の使い方（docs/storefront.md）が「使わない」だと、「購入手続きへ」の先（Banto のカートとレジ）が開けません。「すべて」か「カートと購入だけ」にしてください。

## 部品

| 部品 | 属性 | 内容 |
| --- | --- | --- |
| `<banto-product>` | `shop`・`product`（商品のスラッグ）・`sku`（最初に選んでおく SKU の id、省略可） | 画像・名前・価格（税込）・種類の選択・「カートに入れる」。在庫切れの種類は押せない |
| `<banto-products>` | `shop`・`tag`・`category`・`brand`・`sort`（`new` / `updated` / `price_asc` / `price_desc` / `name`）・`limit`（既定 12、100 まで）・`product-url` | 商品のカードの一覧。カードは商品ページへのリンク。`product-url="https://example.com/items/{slug}"` のように書くと、`{slug}` を置き換えたあなたのサイトのページへ。無ければ Banto の商品ページ |
| `<banto-buy-button>` | `shop`・`sku`・`qty`（既定 1）・`label`（ボタンの文字）・`mode` | 「カートに入れる」のボタン 1 つ。`mode="link"` なら JavaScript のカートを使わず、購入リンク（`/<shop>/buy`）へ移るだけ |
| `<banto-cart>` | `shop`・`expanded`（付けると常に開いた形） | 「カート（n）」のボタンと中身（数量の変更・削除・小計・送料無料まであといくら・購入手続きへ） |

同じページの部品どうしは同じカートを使い、どれかでカートに入れると `<banto-cart>` がすぐ変わります。

## 見た目を変える

部品は Shadow DOM の中で描くので、あなたのサイトの CSS と混ざりません。文字の大きさ・字体・色は貼った場所のものを引き継ぎます。次の CSS の変数で変えられます。

| 変数 | 既定 | 使うところ |
| --- | --- | --- |
| `--banto-accent` / `--banto-accent-text` | `#1f6feb` / `#fff` | ボタン |
| `--banto-radius` | `6px` | カード・ボタンの角 |
| `--banto-border` | `#d0d7de` | 枠線 |
| `--banto-bg` | 透明 | カードの背景 |
| `--banto-panel-bg` / `--banto-panel-text` | `#fff` / `#1f2328` | カートの中身の背景と文字 |
| `--banto-card-min` / `--banto-gap` | `160px` / `16px` | 一覧のカードの最小の幅と間隔 |

```html
<style>
  banto-product, banto-products, banto-cart, banto-buy-button { --banto-accent: #c0392b; --banto-radius: 0; }
</style>
```

## カートのしくみ

- カートは署名付きのトークン（docs/headless.md「B. カート API」）で、貼った側のサイトのブラウザの `localStorage` に `banto-cart-<shop>` の名前で入ります。Banto はカートを保存しません。Cookie は使いません。
- 「購入手続きへ」を押すと、カートを Banto のカートの画面へ移し、貼った側のサイトのカートは空にします（買い終えた後に古いカートが残らないように）。続きは Banto の画面です。
- 同じサイトの別のタブにも、カートの変更は伝わります。

## 知っておくこと

- **サイトの作成サービスの制限**: スクリプトを貼れるのが有料のプランだけのサービスや、HTML を iframe の中に閉じ込めるサービスがあります。iframe の中でも部品は描けますが、そのサービスの設定によっては動かないことがあります。スクリプトを貼れないときは、`<banto-buy-button mode="link">` と同じ購入リンク（`https://<あなたの Banto>/<shop>/buy?sku=<SKU の id>&qty=1`）を、そのサービスのボタンのリンクに入れてください。
- **貼った側のサイトの CSP**: Content-Security-Policy を設定しているサイトでは、`script-src`・`connect-src`・`img-src` にあなたの Banto（と画像の配信元、`MEDIA_BASE_URL`）を足してください。
- **速さ**: 部品は表示のたびに Banto の公開 API を読みます。1 ページに `<banto-product>` を何十個も並べるより、`<banto-products>` の一覧を使ってください。
- **会員・クーポン**: 部品は会員のログインとクーポンの入力を持ちません。会員の値引きとクーポンは、購入手続きへ進んだ先の Banto のカートの画面で使えます。
- **スクリプトの版**: URL の `v1` が版です。部品の形を変えるときは `v2` を足し、`v1` はしばらく残します。スクリプトの中身は Banto のアップデートと一緒に変わります。
- 部品を自分で作りたい人は、同じ API（docs/headless.md）を直接使えます。
