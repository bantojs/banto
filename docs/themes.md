# テーマ（Liquid）

> 状態: 段階 3 まで（2026-10-29）。管理画面の「デザイン」か、コマンド（`cli/banto-theme.mjs`）・GitHub Actions からテーマを取り込み、プレビューで確かめて公開できます。Liquid のテーマで描くのは一覧・商品・カート・検索・レジ（配送先・最終確認）・購入の完了・法務・会員ページ・404 です。決済はいつも Stripe・KOMOJU のページです。会員のログイン・注文照会・お問い合わせ・送料のページは既定のテーマが描きます。

Banto のお店の画面は、同梱の既定のテーマ（TSX、`src/themes/default/`）で描きます。これに加えて、**Liquid で書いたテーマ**を取り込んで、Worker を配置し直さずに見た目を変えられるようにします。

## 使える条件

| 条件 | 理由 |
| --- | --- |
| Cloudflare Workers の **有料プラン**（または Node で動かす） | Liquid の描画は既定のテーマより重く、凝ったテーマは無料プランの CPU の上限（1 リクエスト 10ms）に収まりません。無料プランでは既定のテーマを使います。判定はサイトの設定の「Workers のプラン」 |
| ショップに **独自ドメイン** がある | テーマの JS は、お店の画面と同じオリジンで動きます。管理画面は独自ドメインでは開かないので、テーマの JS が管理画面に届きません。独自ドメインの無いショップは既定のテーマのままです |
| 権限の項目「デザイン（テーマ）」（`design`） | テーマを取り込み・公開できるのは、この項目を持つ人（組織の owner / admin を含む）だけです。テーマの JS はショップのドメインでお客様の画面に入るので、この項目は「お店の画面に任意の JS を置ける」強い権限です（信頼できる人にだけ渡してください） |

## 書き方

- 言語は Liquid です。オブジェクト・フィルター・タグの名前は、Shopify のテーマを書いたことのある人がそのまま書けるように合わせます（下の一覧）。Shopify のテーマのファイルをそのまま持ち込むことは想定していません（テーマごとのライセンスを確かめてください）。Shopify は Shopify Inc. の商標です。Banto は Shopify Inc. と関係ありません。
- **出力は既定でエスケープします。** `{{ product.title }}` に `<` が入っていても HTML になりません。`{{ x | escape }}` と書いても二重にはなりません。生の HTML を出すときだけ `{{ x | raw }}` と書きます。
- テーマは渡されたデータを描くだけです。データベース・秘密の値・外への通信には触れません。
- 1 ページの描画には上限があります（描く手数・作る文字列の量・出力の大きさ。テンプレート・セクション・レイアウトで 1 ページ分を分け合います）。超えたページは描かずに止めます。JSON のテンプレートのセクションは 25 まで、1 つのセクションのブロックは 50 までです。
- `{% capture %}` で作った文字列と、設定の種類が `richtext`・`inline_richtext`・`html` の値は、HTML のまま出ます（中の `{{ }}` はその時点でエスケープ済み）。`text` などほかの種類の設定は文字としてエスケープします。
- エスケープは出すときに 1 回だけです。`{{ x | escape | upcase }}` のように `escape` のあとに別のフィルターを通すと、文字列に戻ってもう一度エスケープされます（`escape` は最後に書きます）。
- `json` の出力は `<script>` の中に書くためのもので、`<`・`>`・`&` だけを逃がします。HTML の属性の中に書くときは `{{ x | json | escape }}` にします（Shopify と同じ）。

## 置き場

- Banto をホスティングして貸す構成では、プランの上限 `plan_limits.theme_versions`（0073）で、この Banto 全体で置けるテーマの版の数を決められます（0 なら Liquid のテーマを取り込めず、公開中の版も描きません。0074）。1 つのショップに 20 までの上限はそのままです。

- テーマの版ごとに、テンプレート・設定・翻訳を 1 つのファイルに束ねて、画像と同じ置き場（R2 など）の `themes/<ショップ>/<版>/` に置きます。データベースには置き場の鍵と、運営者が選んだ設定の値だけを持ちます（`theme_versions`、0071）。
- テーマの CSS・JS・画像は、ショップのドメインから配ります。Banto の URL の `/media/` からは配りません。
- 公開中の版は 1 つで、取り下げると既定のテーマに戻ります。公開・取り下げと、プレビューを開いたことは監査ログに残ります。
- 本番で `MEDIA_BASE_URL`（R2 のカスタムドメイン）を使っているときは、置き場のファイルがその URL から直接読めます。テーマのファイルにはテンプレートと設定の値しか入れないので、秘密の値をテーマに書かないでください（テンプレートはお店の画面を描くためのもので、もともと見られて困るものではない前提です）。
- 管理画面の JSON の書き出し（バックアップ）にテーマは入りません。zip を手元に残しておいてください。

## 取り込み・プレビュー・公開（管理画面の「デザイン」）

1. ショップの画面の「デザイン」のタブを開きます（項目「デザイン（テーマ）」を持つ人と、組織の owner / admin に出ます）。
2. テーマのフォルダ（`layout`・`templates`・`sections`・`snippets`・`config`・`locales`・`assets`）を zip にして取り込みます。zip はブラウザの中で開き、Banto がすべてのテンプレートを確かめてから版として置きます。知らないフィルター・タグ、壊れた JSON、置けない資産があれば、ファイルの名前と理由を出して断ります。資産を送り終えるまでの版には「取り込み途中」と出て、公開できません（途中で止まったら取り込み直します）。送り終えた版の資産は差し替えられません。翻訳はデプロイの言語のものと `*.default.json` だけを取り込みます。Workers の無料プランでは取り込めません。
3. 版の「プレビュー」で、ショップのドメインに、まだ公開していない版を開けます（リンクは 30 分。開いた端末でだけ、そのあいだ続きます。ショップを公開する前は開けません）。プレビューの画面では下に帯が出て、テンプレートの誤りはその場所に赤く出ます。検索エンジンには載せません。版に保存した設定の値もプレビューに効きます（0074）。
4. 「公開する」で切り替わります（お店の画面は 30 秒ほどで切り替わります）。「取り下げる」と既定のテーマに戻ります。版は 1 つのショップに 20 まで置け、公開中でない版は消せます。

## 設定を変える（管理画面の「デザイン」→ 版の「設定」）

テーマのファイルを直さずに、色・文字・画像・オン / オフなどの値を画面で変えられます（Shopify のテーマエディタの値の欄に当たります）。

- 欄はテーマの宣言から作ります: `config/settings_schema.json`（テーマ全体）、JSON のテンプレート（`templates/*.json`）とセクションのまとまり（`sections/*.json`）に置いたセクションの `{% schema %}`、`{% section %}` で置いたセクション。ブロックの値も変えられます。
- 画面で変えられる種類: `text`・`textarea`・`richtext`・`inline_richtext`・`html`・`url`・`video_url`・`number`・`range`・`checkbox`・`select`・`radio`・`color`・`color_background`・`font_picker`・`image_picker`（テーマの `assets/` の画像から選ぶ）。`header`・`paragraph` は見出しと説明として出します。ほかの種類（`collection`・`product`・`link_list` など）はテーマのファイルの値のままです。
- 欄の名前は宣言の `label`。`t:` で始まるものは `locales/<言語>.schema.json`（無ければ `*.default.schema.json`）から引きます。
- 値は種類ごとに確かめます（色は `#rrggbb`、数は `min`・`max`、選ぶ欄は宣言にある値、URL は `https://` か `/` から、文字は 500 字、長い文は 10,000 字まで）。`richtext`・`html` の値は HTML のまま出ます（テーマを書く人と同じ「デザイン」の項目の人だけが入れる値です）。
- 置くのは版の設定の値だけで、テーマのファイルは変えません。テーマのファイルの値と違うものだけを置き、1 つの版で 64 KB まで。公開中の版で保存すると、お店の画面は 30 秒ほどで切り替わります。公開していない版は保存してからプレビューで確かめます。
- 触っていない欄は変えません。画面では直せないテーマのファイルの値（`shopify://` の URL や画像など）も、そのまま送り返せば元の値のままです。
- **セクションの並び**: JSON のテンプレート（`templates/*.json`）とセクションのまとまり（`sections/*.json`）ごとに、並べ替え・外す・足すができます。番号の小さい順に並べ、チェックを外したセクションは表示しません。足せるのは `{% schema %}` に `presets` のあるセクションだけで（Shopify と同じ）、ひな形の最初のもの（`presets[0]` の `settings`・`blocks`）の中身で末尾に入ります。1 つの置き場に 25 個まで。`{% section %}` で置いたセクションは並べ替えられません。
- 並びも版の設定の値（`__layout`）に置き、テーマのファイルは変えません。テーマのファイルの並びと同じなら置きません。ブロックの並べ替え・足すは、テーマのファイルを直して取り込み直します。

## コマンドから（`cli/banto-theme.mjs`）

テーマのフォルダから直接取り込めます。Shopify CLI の `theme push` / `theme dev` に当たるものです。依存のない 1 ファイルの Node スクリプト（Node 20 以上）なので、テーマのリポジトリに写して使えます。

npm のパッケージにはしていません（メンテナの決定 2026-10-29）。使っている Banto と同じ版のファイルを、リリースのタグから取ってテーマのリポジトリに置きます（API の形が Banto の版と合うように。版を上げたら取り直します）。

```bash
curl -fsSLo banto-theme.mjs https://raw.githubusercontent.com/bantojs/banto/<使っている版のタグ>/cli/banto-theme.mjs
```

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
node cli/banto-theme.mjs prune --keep 5            # 公開していない古い版を消す（取り込みの途中の新しい版は残す）
```

- 取り込む中身は管理画面の zip と同じです（`layout`・`templates`・`sections`・`snippets` の `.liquid`、`templates`・`sections`・`config`・`locales` の `.json`、`assets/` の直下）。翻訳はデプロイの言語と `*.default.json`（設定の画面の文言の `*.schema.json` も同じ）だけ。それ以外のファイル（`README.md` など）と `.` で始まるものは送りません。
- 検査は Banto がします。誤りはファイルの名前と理由がそのまま出ます。資産を送り終える前に止まった版は、CLI が消します。
- `BANTO_URL` は `https://`（手元の `localhost` だけ `http://` も使えます。トークンを平文で送らないため）。混んでいるとき（429）と、読む・置く・消す要求の一時的な失敗はやり直しますが、版を作る・置き終える・公開する要求（POST）は、届いたか分からないときにやり直しません（版が二重にできないように）。
- 置き終えた版の資産は差し替えられません。置き終える処理は、先に資産の受け付けを締めてから揃っているかを確かめます（締めた後に届いた資産は捨てます）。
- `dev` はプレビューのリンクを毎回出します（版が変わるので、新しいリンクを開き直します）。手元でテーマを描くことはしません（描くのは Banto。手元にお店のデータを持ち出さないため）。
- 経路は AI 用 API の REST（`/api/v1/themes`、docs/ai-access.md）です。公開・取り下げ・プレビューを開いたことは監査ログにトークンの名前で残ります。
- **API で出したプレビューのリンクは、お店のオリジンから切り離して描きます**（CSP の `sandbox`）。リンクは開いた人に結ばれない（渡せばだれでも開ける）ので、`theme:write` だけで、まだ公開していない版の JS をお店のオリジンで買い物客に動かさせないためです。テーマの JS は動きますが、お店の Cookie を使った問い合わせ（`/cart.js` など）やフォームの送信はカートに届かず、`type="module"` のスクリプトは読み込めません。レジと会員ページはテーマで描きません。カート・レジまで確かめるときは、管理画面の「デザイン」からプレビューを開きます（そちらは切り離しません）。

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
| `snippets/page-products.liquid`（任意） | ショップのページの「商品を並べる」ブロックの見た目（下の「使える名前」のショップのページ） |
| `blocks/*.liquid` | テーマのブロック（`{% content_for 'blocks' %}`・`{% content_for 'block', type: 'x', id: 'y' %}`）。`{% schema %}` に設定の宣言 |
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
| カート（`/cart`） | `cart` | `cart`（下の「カート」）・`cart_error`（在庫が足りない・クーポンが使えないなどの知らせ） |
| レジ: 配送先 | `checkout` | `checkout`（`values`（入れた値）・`error`・`prefectures`（`name`・`shipping_price`）・`delivery`（お届け日時を選べるショップ）・`marketing_consent`（案内メールの欄を出すか）・`subtotal_price`・`shipping_summary`）。フォームは `{% form 'checkout_address' %}`（下の「レジ」） |
| レジ: 最終確認 | `checkout_confirm` | `checkout.confirmation`（要約に使う値）。中身は **`{% banto_confirmation %}` が必須**（下の「レジ」） |
| 検索（`/search?q=`） | `search` | `search`（`terms`・`results`（商品）・`results_count`・`performed`）。語は 3 文字以上で、2 文字以下は探さず `performed` が false、`too_short`（Banto の名前）が true になります（「3 文字以上で」の案内に使えます） |
| 法務（`/legal`・`/privacy`・`/returns`） | `page` | `page`（`title`・`handle`（`legal` / `privacy` / `returns`）・`url`・`content`）。`content` は Banto が文面から作ります（改行を `<br>` にしてエスケープ）。連携サイトのページに向けていればそちらへ転送します（テーマでは描きません） |
| ショップのページ（`/pages/<名前>`、同梱モジュール「ページ」、docs/pages.md） | `page`（ページで選んだ名前があれば `page.<名前>`。テーマに無ければ `page`） | `page`（`id`・`title`・`handle`・`url`・`content`・`template_suffix`・`published_at`（予約していればその日時）・`updated_at`・`image`（アイキャッチ画像。`src`・`url`・`alt`、無ければ空）、アイキャッチがあれば `page_image`（OG の画像に使う）。`content` は Banto が本文の決まった書式から作った HTML（決まった形のタグだけ）。`template` は `page.faq` のように出て、`template.name` は `page`・`template.suffix` は `faq`。メニューに出すページは `linklists['main-menu']`（ヘッダー）の後ろと `linklists.footer` の前に入ります。本文の「商品を並べる」（`::: products`）は、テーマに `snippets/page-products.liquid` があれば `products`（一覧の形の商品）と `block`（`layout`（`grid` / `scroll`）・`limit`・`sort`・`category`・`tag`・`index`）を渡して描いた HTML が `content` のその場所に入ります（無ければ Banto の既定のカード `ul.banto-products__list`）。「ボタン」は `p.banto-button > a.banto-button__link` です。レイアウトのブロック（グループ・カラム・カバー・画像と文・ギャラリー・アコーディオン・スペーサー）は class だけの HTML と並べ方の最小の CSS で `content` に入り、色と大きさは CSS の変数（`--banto-bg-subtle`・`--banto-bg-accent`・`--banto-pad-m`・`--banto-cover-m` など、docs/pages.md「テーマで決まる値」）をテーマが決めます |
| ブログの記事の一覧（`/blogs/<名前>`、同梱モジュール「ブログ」、docs/blog.md） | `blog`（ブログで選んだ名前があれば `blog.<名前>`） | `blog`（`id`・`handle`・`title`・`url`・`description`・`articles`（その 1 ページの記事、新しい順）・`articles_count`・`all_tags`（そのページの記事のタグ）・`template_suffix`・`comments_enabled`（いつも false））・`current_tags`（`?tag=` で絞ったとき）・`paginate`（`{% paginate %}` の外でも読めます。1 ページは 12 本で Banto が決めます） |
| ブログの記事（`/blogs/<ブログ>/<記事>`） | `article`（記事で選んだ名前があれば `article.<名前>`） | `article`（`id`・`handle`・`title`・`url`・`content`（本文の HTML。ページと同じく決まった形のタグだけ。「商品を並べる」も入ります）・`excerpt`（抜粋か本文の頭の文字）・`image`・`tags`・`author`・`published_at`・`updated_at`）・`blog`。アイキャッチがあれば `page_image`。一覧の `blog.articles` の記事は `content` が空です（`excerpt` を使います） |
| 購入の完了（`/checkout/done`） | `checkout_done` | `checkout`（`status`（`confirmed`・`pending`・`released`・`not_found`・`unknown`）・`order_number`（確定していれば）・`message`（既定のテーマと同じ文言）・`free`・`inquiry_url`・`continue_url`）。確定を待つあいだは数秒ごとに読み込み直します |
| 会員ページ（`/account`） | `customers/account`（`templates/customers/account.liquid`） | `customer`（`email`・`name`・`default_address`・`accepts_marketing`・`orders`（`name`（`#1001`）・`order_number`・`created_at`・`status`・`status_label`・`total_price`・`url`（注文照会））・`orders_count`）。住所の保存・ログインの方法・クーポン・ログアウト・退会などは **`{% banto_account %}`** が Banto の部品として描きます。住所が載るので、レジと同じ CSP を付けます |

**どのページでも**: `shop`・`settings`・`routes`・`request`（`page_type` は `page.faq` でも `page`）・`cart`（`item_count`・`items`・`total_price` など。どのページでも読めるので、ヘッダーのカートの一覧に使えます）・`customer`（ログイン中の会員のメールアドレスだけ）・`linklists['main-menu']`（カテゴリーの木から作ります）・`linklists.footer`（法務と送料のページ）・`collections['<カテゴリーのスラッグ>']`（名前と URL だけ）・`page_title`・`page_description`・`canonical_url`・`template`。これらは `{% render %}` で描く snippet の中でも見えます（Shopify と同じ。ページの変数（`product` など）と親で `assign` した値は見えないので、引数で渡します）。

**商品**（`product`）: `id`・`handle`（スラッグ）・`title`・`url`・`description`（改行を `<br>` にした HTML）・`price` / `price_min` / `price_max` / `price_varies`・`compare_at_price`・`available`・`vendor`（ブランド）・`tags`・`featured_image`・`images`・`variants`（SKU。`id`・`title`・`sku`・`price`・`available`・`options`・`option1`〜`3`）・`options`・`options_with_values`・`selected_or_first_available_variant`。在庫は「あるか」だけで、数は渡しません。一覧（`collection.products`）の `available` は「値段のついた SKU があるか」で、在庫の有無は商品のページでだけ分かります（一覧で在庫を引かないため）。

**金額**: Shopify と同じく、最小の単位の 100 倍の整数です（¥1,200 は `120000`）。`{{ product.price | money }}` で `¥1,200` になります。

**フィルター**（標準の Liquid のフィルターに加えて）: `money`・`money_with_currency`・`money_without_currency`・`money_without_trailing_zeros`・`image_url`（`width:`。Banto の画像は本画像と長辺 400px の 2 つなので、幅 400 以下ならサムネイル）・`img_url`・`image_tag`・`asset_url`・`asset_img_url`・`stylesheet_tag`・`script_tag`・`preload_tag`・`t`・`json`・`handleize`・`pluralize`・`link_to`・`within`・`default_pagination`・`placeholder_svg_tag`・`time_tag`。整数どうしの `divided_by` は切り捨てです。

**タグ**（標準の Liquid のタグに加えて）: `section`・`sections`・`schema`・`form`（`'product'`: カートに入れる（`id` = バリエーション、`quantity`）、`'cart'`: カートの数を変える・購入手続きへ、`'contact'`: お問い合わせ（同梱モジュール「お問い合わせ」が ON のショップ。`contact[email]`・`contact[name]`・`contact[body]` を Banto のお問い合わせの画面に写して続けます）、`'customer_login'` / `'create_customer'`: 会員のログイン（Banto はメールのコードでログインするので、`customer[email]` だけを使います））・`content_for`（`'blocks'` と `'block'`。テーマのブロックは 8 段まで入れ子にできます）・`paginate`（1 ページの数は Banto が決めます（48）。Banto は位置で次のページへ進むので、`paginate.parts` は今のページと前後だけ、2 ページ目より先の `current_page` は 2 です。`paginate.pages`・`items` は全体の数から出します。`paginate.next.url` / `previous.url`）・`style`・`stylesheet`・`javascript`・`layout`。

知らないフィルター・タグは、テーマを取り込むときに断ります。

### レジ（配送先・最終確認）

Shopify では Plus のプランに限られる「チェックアウトの途中の画面」を、Banto ではテーマで作れます（メンテナの決定 2026-10-28）。カード番号を入れる画面はいつも Stripe・KOMOJU のページで、金額・在庫・送料は確定の直前に Banto が引き直す（確認画面と 1 円でも違えば確定しない）ので、画面をどう作っても値段は変わりません。

- **配送先**（`templates/checkout`）: `{% form 'checkout_address' %}` の中に、Banto の欄の名前（`customer_name`・`customer_email`・`phone`・`postal_code`・`state`・`city`・`line1`・`line2`、お届け日時の `delivery_date`・`delivery_slot`、案内メールの `marketing_consent`）で置きます。送り先は選んだ決済手段の確認の画面です。誤りがあれば同じテンプレートを `checkout.error` つきで描き直します。
- **最終確認**（`templates/checkout_confirm`）: 特定商取引法の最終確認画面です。表示しなければならない項目（品目・数・金額・送料・値引き・支払いの方法と時期・引渡しの時期・申込みの撤回の条件・お届け先・法務のページへのリンク）と「注文を確定する」ボタンは、**`{% banto_confirmation %}` が Banto の部品として描きます**（同梱テーマと同じもの）。テーマはその外側（見出し・注文の要約・案内）を作ります。`{% banto_confirmation %}` の無いテーマは取り込めません。描いた結果に無ければ（条件の中に置いて描かなかったなど）、その画面は既定のテーマで描きます。
- レジの画面には **CSP** を付けます（`script-src 'self'; connect-src 'self'`）。動くスクリプトは、ショップのドメインから配るテーマの資産だけで、問い合わせ（fetch など）の宛先もショップのドメインだけです。インラインのスクリプトと外のスクリプト（分析のタグ・チャットなど）は、レジの画面では動きません。住所と連絡先が載る画面だからです。
- これらは、テーマを作る人のうっかりを止める安全網です。テーマの JS は画面を書き換えられるので、悪意のあるテーマへの守りではありません。テーマを取り込み・公開できるのは「デザイン（テーマ）」の項目を持つ人と `theme:publish` のトークンだけにしてください。
- テーマにレジのテンプレートが無ければ、既定のテーマで描きます。決済の後の完了画面は、今は既定のテーマです。

### カート

`cart` は Shopify と同じ形です（`items`・`item_count`・`items_subtotal_price`・`total_discount`・`total_price`・`cart_level_discount_applications`・`empty`）。行（`item`）は `key` と `id` が SKU の id で、`title`・`product_title`・`variant_title`・`sku`・`quantity`・`price`・`final_line_price`・`url`・`url_to_remove`・`options_with_values`・`variant`・`product`・`available`（在庫が足りなければ false）を持ちます。金額は 100 倍の整数で、値引きは商品の値引きだけです（送料と送料無料のクーポンは、配送先が決まってから最終確認の画面で）。行の画像（`item.image`・`featured_image`）は、その SKU に合う商品の画像の最初の 1 枚です（SKU ごとの画像の当てはめは商品のページと同じ）。

**クーポンと決済手段**（Banto の名前。Shopify には無いもの）:

- `routes.cart_coupon_url`: 同梱モジュール「クーポン」が ON のショップだけにあります（OFF なら空）。そこへ `code`（入れる）か `remove`（外すコード）を POST します（カートのページに戻ります）。入っているコードは `cart.discount_codes`（Shopify と同じ `code`・`applicable`）。使えないコードは `applicable` が false で、`banto_message` に理由（「このクーポンは見つかりません」など）が入ります。値引きの額は `cart.cart_level_discount_applications` です。
- `cart.banto_payment_methods`: カートのページ（と `?sections=` で描くカート）で、使える決済手段の一覧（`id` は `stripe` か `komoju`、`name` は表示名）。`{% form 'cart' %}` の中に `provider` の欄（ラジオボタンなど）で置けば、選んだ決済手段で購入手続きに進みます。置かなければ、使える最初の決済手段です。KOMOJU の中の支払い方法（コンビニ・銀行振込など）は、KOMOJU のページで選びます。

```liquid
{% if routes.cart_coupon_url %}
  <form method="post" action="{{ routes.cart_coupon_url }}"><input name="code"><button>使う</button></form>
{% endif %}
{% form 'cart', cart %}
  {% if cart.banto_payment_methods.size > 1 %}
    {% for m in cart.banto_payment_methods %}<label><input type="radio" name="provider" value="{{ m.id }}" {% if forloop.first %}checked{% endif %}> {{ m.name }}</label>{% endfor %}
  {% endif %}
  <button name="checkout">購入手続きへ</button>
{% endform %}
```

カートを変える書き方も Shopify と同じです。どれも同じオリジンからだけ受け付けます（ほかのサイトからの書き込みは断ります）。

| 書き方 | 中身 |
| --- | --- |
| `{% form 'cart', cart %}`（`/cart` に POST） | `updates[]`（画面に出ている行の順。公開をやめた品の行は数えません）か `updates[<key>]` で数を変える。`name="checkout"` のボタンで購入手続き（配送先 → 最終確認 → 決済）へ。決済手段は使える最初のもの（`provider` の欄を置けば選べます。選択肢は `cart.banto_payment_methods`） |
| `item.url_to_remove`・`/cart/change`（`id` か `line` と `quantity`） | 1 行の数を変える・外す。`url_to_remove` は Shopify と同じく GET のリンクなので、ほかのサイトのリンクからも開けます（変わるのはカートにある行の数だけで、値段は確定の前に引き直します） |
| `/cart.js`（GET） | カートの JSON |
| `/cart/add.js`（POST、`id`・`quantity` か `items: [...]`） | カートに入れる。応答は入れた行（`items` で送れば `{ items }`）。公開していない SKU は 404、在庫を超えるなら 422（入れません） |
| `/cart/change.js`・`/cart/update.js`・`/cart/clear.js`（POST） | 数を変える・まとめて変える・空にする。応答はカートの JSON（合計にはクーポンの値引きが入ります）。`change.js` でカートに無い `id` は 400、`update.js` でカートに無い SKU に 1 以上を書けば足します（公開中の SKU だけ） |
| `/cart/add`・`/cart/change` に JSON を求めて送る（`Accept: application/json` か `application/javascript`、または本文が JSON） | `.js` と同じ応答（Dawn などは `routes.cart_add_url`・`routes.cart_change_url` に fetch で送るため） |

### セクションだけを描く（Section Rendering API）

Shopify と同じく、セクションだけを描いて返せます（Dawn などのカートの引き出し・絞り込みの JS が使います）。

- テーマで描くページに `?sections=a,b`（JSON で `{ "a": "<div …>", "b": null }`）か `?section_id=a`（HTML）を付けます。1 回に 5 個まで。
- id は、そのページのテンプレート（JSON）・セクションのまとまり（`sections/*.json`）の中の id か、セクションのファイルの名前（`{% section %}` と同じく、置いたものとして描きます）です。見つからない id は `null`（`section_id` なら 404）です。
- AJAX のカート（`/cart/add.js`・`/cart/change.js`・`/cart/update.js`、`/cart.js` は `?sections=`）に `sections`（`"a,b"` か `["a", "b"]`）を付けると、変えた後のカートで描いたセクションを応答の `sections` に入れます。`sections_url` は見ません（カートのページとして描きます）。
- セクションの包みは Shopify と同じ `<div id="shopify-section-<id>" class="shopify-section">` です。
- レジ（配送先・最終確認）の画面では使えません。
