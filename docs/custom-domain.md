# 独自ドメインで公開する

Banto は既定で `https://banto-○○.○○.workers.dev` の URL で動きます。自分のドメイン（例 `shop.example.com`）で公開する手順です。

ドメインの付け方は 2 つあります。

- **Banto 全体に 1 つ**（この文書の 1〜5）: `https://shop.example.com/<ショップのスラッグ>` で公開します。管理画面もこのドメインです。
- **ショップごとに 1 つ**（[6](#6-ショップごとのドメイン)）: ショップを `https://shop-a.example.jp/` のようにドメインのトップで公開します。会員のログイン（LINE・Google の戻り先、ログインのメールのリンク）や決済後の戻り先も、そのショップのドメインになります。複数のショップを別々のブランドで運営するときに使います。

両方を組み合わせられます（管理画面は Banto 全体のドメイン、ショップはそれぞれのドメイン）。

## 1. ドメインを Cloudflare に置く

Cloudflare の画面で **ドメインを追加**（ネームサーバーを Cloudflare に向ける）か、既に Cloudflare 管理下のドメインを使います。
他社レジストラのドメインでも、ネームサーバーを Cloudflare に変えれば使えます。

## 2. Worker にカスタムドメインを付ける

1. Cloudflare の画面 → **Workers & Pages → banto → 設定（Settings）→ ドメインとルート（Domains & Routes）→ 追加 → カスタムドメイン**
2. `shop.example.com` を入力して追加します。DNS レコードと証明書は自動で作られます（数分）。

## 3. Banto 側の設定

1. **変数とシークレット** で `PUBLIC_BASE_URL` を `https://shop.example.com` にします（未設定ならアクセスされた URL から自動で決まるので、workers.dev と独自ドメインの両方でアクセスされると Stripe のコールバック先が揺れます。独自ドメインにしたら明示してください）。
2. Stripe / KOMOJU の Webhook URL と、Stripe Connect を使う場合のリダイレクト URI を新しいドメインに変えます。
3. ショップの URL は `https://shop.example.com/<ショップのスラッグ>` です。トップ（`/`）は公開ショップが 1 つなら自動でそのショップに転送されます。

## 4. 画像を R2 のカスタムドメインから配信する（推奨）

既定では画像も Worker（`/media/...`）が配信します。R2 バケットにカスタムドメイン（例 `media.example.com`）を付け、
`MEDIA_BASE_URL` を `https://media.example.com` にすると、画像は Worker を通らず Cloudflare の CDN から配信されます。
Workers の無料枠（1 日 10 万リクエスト）を画像で消費しなくなり、表示も速くなります。
キーは同じなので、既存の画像のリンクは切れません。画面の場所は [docs/setup.md の 7](setup.md#7-画像を-r2-から直接配信する推奨)。

## 5. 確認

- `https://shop.example.com/robots.txt` と `/sitemap.xml` が開くこと
- `https://shop.example.com/<スラッグ>` の `<link rel="canonical">` が新しいドメインになっていること
- 管理画面（`/admin`）にログインできること（Cookie はドメインごとなので、再ログインが必要です）

## 6. ショップごとのドメイン

データベースの更新 `0015_shop_domain` が要ります（管理画面 → アップデート）。

1. **Cloudflare で Worker にドメインを付ける**: 2 と同じ手順で、`shop-a.example.jp` を banto の Worker に **カスタムドメイン** として追加します（ショップの数だけ追加します）。
2. **開けることを確かめる**: ブラウザで `https://shop-a.example.jp/` を開き、Banto の画面（ショップの一覧など）が出ることを確かめます。
3. **ショップに設定する**: 管理画面 → ショップ設定 → **独自ドメイン** に `shop-a.example.jp` を入れて保存します（反映まで 30 秒ほど）。
   - `https://shop-a.example.jp/` がそのショップのトップ、商品は `https://shop-a.example.jp/p/<商品>` になります。
   - これまでの URL（`https://<Banto の URL>/<スラッグ>/…`）は、同じページのドメイン側へ転送されます。
   - API（`/api`）・Webhook（`/webhooks`）は、Banto の URL のままで使えます。
   - 管理画面（`/admin`）は **Banto の URL だけ** で開きます。ショップのドメインで `/admin` を開くと Banto の URL へ転送されます（`PUBLIC_BASE_URL` が未設定なら 404）。運営者のログイン画面を店主のドメインに置かないためです。AI からの操作（`/mcp`・`/api/v1`）と決済事業者の Webhook（`/webhooks`）も Banto の URL だけです（ショップのドメインでは 404。AI クライアントの接続先と Webhook の URL には Banto の URL を使ってください）。公開 API（`/api/shops/...`）と画像はどちらでも使えます。
4. **LINE・Google でログイン** を使っているなら、それぞれの設定画面に出るコールバック URL（`https://shop-a.example.jp/_oauth/line/callback` など）を、LINE Developers・Google Cloud のコンソールに登録し直します。Google の「OAuth 同意画面」の承認済みドメインにも、ショップのドメインを足してください。
5. **ヘッドレス連携** で決済後の戻り先を許可リストにしているなら、変える必要はありません（連携側のサイトの設定です）。

- ドメインを外すと（欄を空にして保存）、ショップは `/<スラッグ>` に戻ります。転送は一時的なもの（302）なので、ブラウザに残りません。
- 会員のログインと買い物かごはドメインごとです。ドメインを付ける前にログインしていた会員は、ドメインの上でもう一度ログインします（会員の情報はそのままです）。
- サイトマップはドメインごとです（`https://shop-a.example.jp/sitemap.xml`）。Banto の URL のサイトマップには、独自ドメインのショップは載りません。
- 同じドメインを 2 つのショップには付けられません。`*.workers.dev` や Banto 自身のホスト名も付けられません。
- Banto をホスティングして提供する事業者が「ドメインの提供元」（`DomainAdapter`）を組み込んでいる場合は、1〜2 の手順の代わりに、保存したときに画面に出る DNS のレコード（CNAME など）をドメインの DNS に入れます。セルフホストの既定では提供元は無く、上の手順どおりです。
