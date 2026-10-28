# テーマ（Liquid）

> 状態: 作っている途中です（段階 1）。お店の画面の一覧・商品・404 のページを Liquid のテーマで描けるようになりました。テーマの取り込みと管理画面の「デザイン」は、この後の変更で入ります。カートから先（住所・最終確認・決済）と法務のページは、既定のテーマが描きます。

Banto のお店の画面は、同梱の既定のテーマ（TSX、`src/themes/default/`）で描きます。これに加えて、**Liquid で書いたテーマ**を取り込んで、Worker を配置し直さずに見た目を変えられるようにします。

## 使える条件

| 条件 | 理由 |
| --- | --- |
| Cloudflare Workers の **有料プラン**（または Node で動かす） | Liquid の描画は既定のテーマより重く、凝ったテーマは無料プランの CPU の上限（1 リクエスト 10ms）に収まりません。無料プランでは既定のテーマを使います。判定はサイトの設定の「Workers のプラン」 |
| ショップに **独自ドメイン** がある | テーマの JS は、お店の画面と同じオリジンで動きます。管理画面は独自ドメインでは開かないので、テーマの JS が管理画面に届きません。独自ドメインの無いショップは既定のテーマのままです |
| 権限の項目「デザイン（テーマ）」（`design`） | テーマを取り込み・公開できるのは、この項目を持つ人（組織の owner / admin を含む）だけです |

## 書き方

- 言語は Liquid です。オブジェクト・フィルター・タグの名前は、Shopify のテーマを書いたことのある人がそのまま書けるように合わせます（下の一覧）。Shopify のテーマのファイルをそのまま持ち込むことは想定していません（テーマごとのライセンスを確かめてください）。
- **出力は既定でエスケープします。** `{{ product.title }}` に `<` が入っていても HTML になりません。`{{ x | escape }}` と書いても二重にはなりません。生の HTML を出すときだけ `{{ x | raw }}` と書きます。
- テーマは渡されたデータを描くだけです。データベース・秘密の値・外への通信には触れません。
- 1 ページの描画には上限があります（描く手数・作る文字列の量・出力の大きさ）。超えたページは描かずに止めます。

## 置き場

- テーマの版ごとに、テンプレート・設定・翻訳を 1 つのファイルに束ねて、画像と同じ置き場（R2 など）の `themes/<ショップ>/<版>/` に置きます。データベースには置き場の鍵と、運営者が選んだ設定の値だけを持ちます（`theme_versions`、0071）。
- テーマの CSS・JS・画像は、ショップのドメインから配ります。Banto の URL の `/media/` からは配りません。
- 公開中の版は 1 つで、取り下げると既定のテーマに戻ります。公開・取り下げは監査ログに残ります。

## テーマのファイルの並び

| 置き場 | 中身 |
| --- | --- |
| `layout/theme.liquid` | ページの外枠（必須）。`{{ content_for_header }}` を `<head>` の中に、`{{ content_for_layout }}` を本文に書きます |
| `templates/index`・`collection`・`product`・`404`（`.json` か `.liquid`） | ページの種類ごとの中身。`.json` はセクションの並び（`sections` と `order`） |
| `sections/*.liquid` | セクション。`{% schema %}` に設定の宣言（既定値が使われます） |
| `sections/*.json` | セクションのまとまり（`{% sections 'header-group' %}`） |
| `snippets/*.liquid` | 部品（`{% render 'card', product: product %}`） |
| `config/settings_schema.json`・`settings_data.json` | テーマの設定の宣言と既定の値（`settings.*`） |
| `locales/ja.json`（・`*.default.json`） | 翻訳（`{{ 'products.add_to_cart' \| t }}`） |
| `assets/*` | CSS・JS・画像・フォント（`{{ 'theme.css' \| asset_url \| stylesheet_tag }}`）。HTML と SVG は置けません |

テンプレートが無い種類のページは、既定のテーマで描きます。テーマに誤りがある・上限を超えたときも、そのページは既定のテーマで描き、お店は止まりません（セクションの中の誤りは、そのセクションだけを空にします）。

## 使える名前

**ページの種類ごと**

| ページ | テンプレート | 渡すもの |
| --- | --- | --- |
| トップ | `index`（無ければ `collection`） | `collection`（すべての商品の 1 ページ目）・`products` |
| カテゴリー・タグで絞った一覧 | `collection` | `collection`・`products`・`current_tags` |
| 商品 | `product` | `product`・`current_variant` |
| 見つからない | `404` | — |

**どのページでも**: `shop`・`settings`・`routes`・`request`・`cart`（`item_count` だけ）・`customer`（ログイン中の会員のメールアドレスだけ）・`linklists['main-menu']`（カテゴリーの木から作ります）・`linklists.footer`（法務と送料のページ）・`collections['<カテゴリーのスラッグ>']`（名前と URL だけ）・`page_title`・`page_description`・`canonical_url`・`template`。

**商品**（`product`）: `id`・`handle`（スラッグ）・`title`・`url`・`description`（改行を `<br>` にした HTML）・`price` / `price_min` / `price_max` / `price_varies`・`compare_at_price`・`available`・`vendor`（ブランド）・`tags`・`featured_image`・`images`・`variants`（SKU。`id`・`title`・`sku`・`price`・`available`・`options`・`option1`〜`3`）・`options`・`options_with_values`・`selected_or_first_available_variant`。在庫は「あるか」だけで、数は渡しません。

**金額**: Shopify と同じく、最小の単位の 100 倍の整数です（¥1,200 は `120000`）。`{{ product.price | money }}` で `¥1,200` になります。

**フィルター**（標準の Liquid のフィルターに加えて）: `money`・`money_with_currency`・`money_without_currency`・`money_without_trailing_zeros`・`image_url`（`width:`。Banto の画像は本画像と長辺 400px の 2 つなので、幅 400 以下ならサムネイル）・`img_url`・`image_tag`・`asset_url`・`asset_img_url`・`stylesheet_tag`・`script_tag`・`preload_tag`・`t`・`json`・`handleize`・`pluralize`・`link_to`・`within`・`default_pagination`・`placeholder_svg_tag`・`time_tag`。整数どうしの `divided_by` は切り捨てです。

**タグ**（標準の Liquid のタグに加えて）: `section`・`sections`・`schema`・`form`（いまは `'product'` だけ。カートに入れるフォームで、Shopify と同じく `id`（バリエーション）と `quantity` を送ります）・`paginate`（1 ページの数は Banto が決めます。`paginate.next.url` / `previous.url`）・`style`・`stylesheet`・`javascript`・`layout`。

知らないフィルター・タグ（`content_for` など、まだ用意していないもの）は、テーマを取り込むときに断ります。
