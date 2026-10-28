# テーマ（Liquid）

> 状態: 段階 2。管理画面の「デザイン」か、コマンド（`cli/banto-theme.mjs`）・GitHub Actions からテーマを取り込み、プレビューで確かめて公開できます。Liquid のテーマで描くのは一覧・商品・404 のページで、カートから先（住所・最終確認・決済）と法務のページは既定のテーマが描きます。設定の値を画面で変えること・カートのページ・検索は、この後の段階で入ります。

Banto のお店の画面は、同梱の既定のテーマ（TSX、`src/themes/default/`）で描きます。これに加えて、**Liquid で書いたテーマ**を取り込んで、Worker を配置し直さずに見た目を変えられるようにします。

## 使える条件

| 条件 | 理由 |
| --- | --- |
| Cloudflare Workers の **有料プラン**（または Node で動かす） | Liquid の描画は既定のテーマより重く、凝ったテーマは無料プランの CPU の上限（1 リクエスト 10ms）に収まりません。無料プランでは既定のテーマを使います。判定はサイトの設定の「Workers のプラン」 |
| ショップに **独自ドメイン** がある | テーマの JS は、お店の画面と同じオリジンで動きます。管理画面は独自ドメインでは開かないので、テーマの JS が管理画面に届きません。独自ドメインの無いショップは既定のテーマのままです |
| 権限の項目「デザイン（テーマ）」（`design`） | テーマを取り込み・公開できるのは、この項目を持つ人（組織の owner / admin を含む）だけです。テーマの JS はショップのドメインでお客様の画面に入るので、この項目は「お店の画面に任意の JS を置ける」強い権限です（信頼できる人にだけ渡してください） |

## 書き方

- 言語は Liquid です。オブジェクト・フィルター・タグの名前は、Shopify のテーマを書いたことのある人がそのまま書けるように合わせます（下の一覧）。Shopify のテーマのファイルをそのまま持ち込むことは想定していません（テーマごとのライセンスを確かめてください）。
- **出力は既定でエスケープします。** `{{ product.title }}` に `<` が入っていても HTML になりません。`{{ x | escape }}` と書いても二重にはなりません。生の HTML を出すときだけ `{{ x | raw }}` と書きます。
- テーマは渡されたデータを描くだけです。データベース・秘密の値・外への通信には触れません。
- 1 ページの描画には上限があります（描く手数・作る文字列の量・出力の大きさ。テンプレート・セクション・レイアウトで 1 ページ分を分け合います）。超えたページは描かずに止めます。JSON のテンプレートのセクションは 25 まで、1 つのセクションのブロックは 50 までです。
- `{% capture %}` で作った文字列と、設定の種類が `richtext`・`inline_richtext`・`html` の値は、HTML のまま出ます（中の `{{ }}` はその時点でエスケープ済み）。`text` などほかの種類の設定は文字としてエスケープします。
- エスケープは出すときに 1 回だけです。`{{ x | escape | upcase }}` のように `escape` のあとに別のフィルターを通すと、文字列に戻ってもう一度エスケープされます（`escape` は最後に書きます）。
- `json` の出力は `<script>` の中に書くためのもので、`<`・`>`・`&` だけを逃がします。HTML の属性の中に書くときは `{{ x | json | escape }}` にします（Shopify と同じ）。

## 置き場

- テーマの版ごとに、テンプレート・設定・翻訳を 1 つのファイルに束ねて、画像と同じ置き場（R2 など）の `themes/<ショップ>/<版>/` に置きます。データベースには置き場の鍵と、運営者が選んだ設定の値だけを持ちます（`theme_versions`、0071）。
- テーマの CSS・JS・画像は、ショップのドメインから配ります。Banto の URL の `/media/` からは配りません。
- 公開中の版は 1 つで、取り下げると既定のテーマに戻ります。公開・取り下げと、プレビューを開いたことは監査ログに残ります。
- 本番で `MEDIA_BASE_URL`（R2 のカスタムドメイン）を使っているときは、置き場のファイルがその URL から直接読めます。テーマのファイルにはテンプレートと設定の値しか入れないので、秘密の値をテーマに書かないでください（テンプレートはお店の画面を描くためのもので、もともと見られて困るものではない前提です）。
- 管理画面の JSON の書き出し（バックアップ）にテーマは入りません。zip を手元に残しておいてください。

## 取り込み・プレビュー・公開（管理画面の「デザイン」）

1. ショップの画面の「デザイン」のタブを開きます（項目「デザイン（テーマ）」を持つ人と、組織の owner / admin に出ます）。
2. テーマのフォルダ（`layout`・`templates`・`sections`・`snippets`・`config`・`locales`・`assets`）を zip にして取り込みます。zip はブラウザの中で開き、Banto がすべてのテンプレートを確かめてから版として置きます。知らないフィルター・タグ、壊れた JSON、置けない資産があれば、ファイルの名前と理由を出して断ります。資産を送り終えるまでの版には「取り込み途中」と出て、公開できません（途中で止まったら取り込み直します）。送り終えた版の資産は差し替えられません。翻訳はデプロイの言語のものと `*.default.json` だけを取り込みます。Workers の無料プランでは取り込めません。
3. 版の「プレビュー」で、ショップのドメインに、まだ公開していない版を開けます（リンクは 30 分。開いた端末でだけ、そのあいだ続きます。ショップを公開する前は開けません）。プレビューの画面では下に帯が出て、テンプレートの誤りはその場所に赤く出ます。検索エンジンには載せません。
4. 「公開する」で切り替わります（お店の画面は 30 秒ほどで切り替わります）。「取り下げる」と既定のテーマに戻ります。版は 1 つのショップに 20 まで置け、公開中でない版は消せます。

## コマンドから（`cli/banto-theme.mjs`）

テーマのフォルダから直接取り込めます。Shopify CLI の `theme push` / `theme dev` に当たるものです。依存のない 1 ファイルの Node スクリプト（Node 20 以上）なので、テーマのリポジトリに写して使えます。

1. 管理画面 → ショップ → **AI 連携** でトークンを発行します。取り込みとプレビューは `theme:write`、公開まで行うなら `theme:publish` も付けます（付けられるのは「デザイン（テーマ）」の項目を持つ人だけ。0072）。
2. Banto の URL とトークンを環境変数で渡します（トークンはコマンドの引数に書かない）。

```bash
export BANTO_URL=https://banto.example.com  # Banto の URL（管理画面を開く URL。AI 用 API はショップの独自ドメインでは開かない）
export BANTO_TOKEN=banto_...
node cli/banto-theme.mjs push ./theme              # 新しい版として取り込み、プレビューのリンクを出す
node cli/banto-theme.mjs push ./theme --publish    # 取り込んで公開する（theme:publish）
node cli/banto-theme.mjs dev ./theme               # 見張って、変えるたびに取り込み直す（前の dev の版は消す）
node cli/banto-theme.mjs list                      # 版の一覧（* が公開中）
node cli/banto-theme.mjs publish <版の id>         # 公開（theme:publish）
node cli/banto-theme.mjs unpublish                 # 既定のテーマに戻す（theme:publish）
node cli/banto-theme.mjs prune --keep 5            # 公開していない古い版を消す
```

- 取り込む中身は管理画面の zip と同じです（`layout`・`templates`・`sections`・`snippets` の `.liquid`、`templates`・`sections`・`config`・`locales` の `.json`、`assets/` の直下）。翻訳はデプロイの言語と `*.default.json` だけ。それ以外のファイル（`README.md` など）と `.` で始まるものは送りません。
- 検査は Banto がします。誤りはファイルの名前と理由がそのまま出ます。資産を送り終える前に止まった版は、CLI が消します。
- `dev` はプレビューのリンクを毎回出します（版が変わるので、新しいリンクを開き直します）。手元でテーマを描くことはしません（描くのは Banto。手元にお店のデータを持ち出さないため）。
- 経路は AI 用 API の REST（`/api/v1/themes`、docs/ai-access.md）です。公開・取り下げ・プレビューを開いたことは監査ログにトークンの名前で残ります。

### GitHub Actions から

プルリクエストでプレビュー、`main` への push で公開する例を `examples/theme-github-actions/` に置いています。プレビュー用（`theme:write`）と公開用（`theme:write` + `theme:publish`）でトークンを分け、公開用は GitHub の Environment の承認の後ろに置くのを勧めます。

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

**商品**（`product`）: `id`・`handle`（スラッグ）・`title`・`url`・`description`（改行を `<br>` にした HTML）・`price` / `price_min` / `price_max` / `price_varies`・`compare_at_price`・`available`・`vendor`（ブランド）・`tags`・`featured_image`・`images`・`variants`（SKU。`id`・`title`・`sku`・`price`・`available`・`options`・`option1`〜`3`）・`options`・`options_with_values`・`selected_or_first_available_variant`。在庫は「あるか」だけで、数は渡しません。一覧（`collection.products`）の `available` は「値段のついた SKU があるか」で、在庫の有無は商品のページでだけ分かります（一覧で在庫を引かないため）。

**金額**: Shopify と同じく、最小の単位の 100 倍の整数です（¥1,200 は `120000`）。`{{ product.price | money }}` で `¥1,200` になります。

**フィルター**（標準の Liquid のフィルターに加えて）: `money`・`money_with_currency`・`money_without_currency`・`money_without_trailing_zeros`・`image_url`（`width:`。Banto の画像は本画像と長辺 400px の 2 つなので、幅 400 以下ならサムネイル）・`img_url`・`image_tag`・`asset_url`・`asset_img_url`・`stylesheet_tag`・`script_tag`・`preload_tag`・`t`・`json`・`handleize`・`pluralize`・`link_to`・`within`・`default_pagination`・`placeholder_svg_tag`・`time_tag`。整数どうしの `divided_by` は切り捨てです。

**タグ**（標準の Liquid のタグに加えて）: `section`・`sections`・`schema`・`form`（いまは `'product'` だけ。カートに入れるフォームで、Shopify と同じく `id`（バリエーション）と `quantity` を送ります）・`paginate`（1 ページの数は Banto が決めます（48）。Banto は位置で次のページへ進むので、`paginate.parts` は今のページと前後だけ、2 ページ目より先の `current_page` は 2 です。`paginate.pages`・`items` は全体の数から出します。`paginate.next.url` / `previous.url`）・`style`・`stylesheet`・`javascript`・`layout`。

知らないフィルター・タグ（`content_for` など、まだ用意していないもの）は、テーマを取り込むときに断ります。
