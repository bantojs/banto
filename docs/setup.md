# セットアップ手順

Banto は、あなた自身の Cloudflare と Supabase のアカウントで動くネットショップです。
レンタルサーバーに WordPress を入れるのと同じくらいの手間で、30〜40 分あれば最初のショップを公開できます。
ターミナルやコマンドは使いません（開発者向けの手順は最後にまとめてあります）。

> 貼り付けるキーや設定は、すべて **あなた自身の** Cloudflare / Supabase に保存されます。
> 開発チームに送られることはなく、開発チームはあなたのショップのデータを見ることができません。

## 全体の流れ

| 手順 | やること | 目安 |
| --- | --- | --- |
| 0 | 無料アカウントを3つ作る（GitHub、Cloudflare、Supabase） | 10 分 |
| 1 | Supabase で「プロジェクト」を作り、値を3つ控える | 5 分 |
| 2 | 「Deploy to Cloudflare」ボタンを押す | 5 分 |
| 3 | Cloudflare の画面で値を3つ貼る | 5 分 |
| 4 | セットアップ画面の指示に従う（データベースの準備、運営者登録、ショップ名） | 10 分 |
| 5 | 決済（Stripe）をつなぐ | 10 分 |
| 7（任意） | 画像を R2 から直接配信する | 5 分 |
| 8（任意） | Worker をデータベースの近くで動かして、ページを速くする | 5 分 |

## 0. アカウントを作る

| サービス | 何に使うか | 料金 |
| --- | --- | --- |
| [GitHub](https://github.com/signup) | Deploy ボタンがあなた用のコピーを置く場所。普段は触りません | 無料 |
| [Cloudflare](https://dash.cloudflare.com/sign-up) | ショップの本体（Workers）と画像置き場（R2）が動く場所。作ったら **Workers & Pages → 概要** の右側で **workers.dev のサブドメイン**（`好きな名前.workers.dev`）を決めておく | 無料枠で開始可 |
| [Supabase](https://supabase.com/dashboard/sign-up) | 商品・注文のデータベースと、運営者のログイン | 無料枠で開始可 |

> Cloudflare の R2（画像置き場）は、無料枠でも支払い方法の登録を求められることがあります。
> 月数百件の注文までは、どのサービスも無料枠に収まります。あなたの規模でいくらかかるかは [運用費用試算ページ](cost-estimator.html)（[前提は docs/cost.md](cost.md)）で確認できます。
> Supabase の無料プランには **自動バックアップがありません**。注文データは定期的に書き出すことをおすすめします（Supabase の画面 → Database → Backups は有料プラン）。

## 1. Supabase でプロジェクトを作る

1. Supabase にログインし、**New project** を押します。
2. 名前は何でも構いません（例: `banto`）。**Database Password** は自分で決めて、**必ずメモしてください**（あとで使います）。Region は **Northeast Asia (Tokyo)** を選びます。
3. 作成が終わったら、左メニューの **Project Settings（歯車）→ Data API** を開き、**Project URL** をメモします。
4. 同じく **Project Settings → API Keys** を開き、次の2つをメモします。
   - **anon** **public** の長い文字列
   - **service_role** の長い文字列（**誰にも見せない。公開したら Supabase の画面で再発行する**）

## 2. Cloudflare に置く

やり方は 2 つあります。どちらでも結果は同じです（Worker「banto」と R2 バケット「banto-media」「banto-private」ができます。banto-private はお問い合わせの添付を置く公開しないバケットで、カスタムドメインを付けません）。

### A. Deploy ボタン（公開リポジトリから。いちばん簡単）

1. [README](../README.md) の **Deploy to Cloudflare** ボタンを押します。
2. GitHub と Cloudflare への接続を求められたら許可します。Cloudflare があなたの GitHub にコピーを作り、ショップを配置します。
3. 「Configure」の画面に、R2 バケット `MEDIA`（`banto-media` のまま）と、`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` の入力欄（`REPLACE_ME` 入り）が出ます。手順1でメモした値に置き換えます。
   - 欄が見当たらない、または `REPLACE_ME` のまま進めてしまった場合は、手順3で同じ値を貼れます。セットアップ画面が足りないものを教えてくれます

### B. リポジトリを取り込む（自分のコピーや非公開リポジトリから）

1. GitHub で Banto をフォーク（またはコピー）しておきます。
2. Cloudflare の画面 → **Workers & Pages → 作成（Create）→ リポジトリをインポート（Import a repository）** で、そのリポジトリを選びます。
3. ビルド設定はそのままで構いません（Build command: なし、Deploy command: `npx wrangler deploy`、Root directory: `/`）。**デプロイ** を押します。
4. この方法では値を入力する画面が出ないので、配置が終わったら手順3で 3 つの値を貼ります。

### 配置後の確認

- 1〜2 分で **Workers & Pages → banto** の **Deployments** に「Success」が出ます。ショップの URL は `https://banto.<あなたのサブドメイン>.workers.dev` です（ビルドのログにも表示されます）。
- 概要（Overview）に「No URLs enabled」と出ていても、上の URL が開けば問題ありません（表示が追いつかないことがあります）。開けない場合は **設定 → ドメインとルート** で workers.dev を有効にしてください。

## 3. Cloudflare の画面で値を貼る

1. Cloudflare の画面で **Workers & Pages → banto → 設定（Settings）→ 変数とシークレット（Variables and Secrets）** を開きます。
2. **追加（Add）** を押して、次の 3 つを登録します（手順2-A で入れたものはすでに並んでいます）。種類は「テキスト」でも「シークレット」でも動きますが、service_role は必ず **シークレット** にしてください。

| 名前 | 種類 | 貼る値 |
| --- | --- | --- |
| `SUPABASE_URL` | テキスト | Supabase の Project URL |
| `SUPABASE_ANON_KEY` | テキスト | anon public の文字列 |
| `SUPABASE_SERVICE_ROLE_KEY` | **シークレット** | service_role の文字列 |

3. **デプロイ（Deploy）** を押して保存します。ここで入れた値は、以後 GitHub 側を更新して再ビルドしても消えません（`wrangler.jsonc` の `keep_vars`）。

## 4. セットアップ画面

ブラウザで `https://<ショップの URL>/admin/setup` を開きます。4つの項目が順に表示されます。

1. **環境変数と Secret** — 足りないものがあれば、名前と「Cloudflare のどこで貼るか」「値は Supabase のどこにあるか」が表示されます。貼ったらこのページを再読み込みします。
2. **Supabase への接続とマイグレーション** — データベースに必要なテーブルを作ります。Supabase の **アクセストークン** を使います。
   1. Supabase の画面右上のアカウントメニュー → **Account preferences → Access Tokens**（[直接開く](https://supabase.com/dashboard/account/tokens)）→ **Generate new token**
   2. 名前は「banto setup」など何でも構いません。権限（Permissions）を選ぶ画面では **Database だけ Full access**（テーブルを作るため書き込みが必要）、ほかは No access にします。表示された `sbp_` で始まるトークンをコピーします（この画面を閉じると二度と見られません）
   3. セットアップ画面に貼り付けて **適用する** を押します。SQL は HTTPS で Supabase に送られ、トークンは保存されません。終わったら Supabase 側でトークンを削除して構いません
   - 「別の方法: 接続文字列で適用する」は、Node で動かしている場合やローカルの Supabase 用です。Cloudflare からは TLS の制約で `Connection terminated unexpectedly` になることがあります
3. **運営者アカウント** — メールアドレスとパスワード（8 文字以上）で登録します。**登録できるのは最初の1人だけ**です。確認メールは届きません（確認済みとして作られ、そのままログインします）。
   - 同じメールアドレスが Supabase にすでにある場合は、そのパスワードを入れれば進めます。古いバージョンで登録して確認メールが `localhost:3000` に飛んでしまった人は、Supabase の Authentication → Users でそのユーザーを「Confirm email」してから、管理画面のログインでそのまま入れます
4. **最初のショップ** — ショップ名と、URL に使う短い英字（例 `my-shop`）を入力します。

完了すると管理画面（`/admin`）が開きます。ショップの URL は `https://<ショップの URL>/my-shop` です。

## 5. 決済（Stripe）をつなぐ

クレジットカード決済は [Stripe](https://stripe.com/jp) を使います。カード番号は Stripe の画面で入力され、Banto を通りません。

1. Stripe のアカウントを作り、本人確認（事業情報の登録）を済ませます。
2. Stripe の画面で **開発者 → API キー** を開き、**シークレットキー**（`sk_live_...`、テスト中は `sk_test_...`）をメモします。
3. **開発者 → Webhook → エンドポイントを追加** を押し、次のように登録します。
   - エンドポイント URL: `https://<ショップの URL>/webhooks/stripe`（管理画面 → プラグイン → Stripe 決済 の欄に、あなたの URL と購読イベントがそのまま表示されています）
   - リッスンするイベント: `checkout.session.completed`、`checkout.session.expired`、`checkout.session.async_payment_succeeded`、`checkout.session.async_payment_failed`
   - 登録後に表示される **署名シークレット**（`whsec_...`）をメモします
4. Cloudflare の **変数とシークレット** に、種類「シークレット」で2つ追加します。

| 名前 | 値 |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe のシークレットキー |
| `STRIPE_WEBHOOK_SECRET` | Webhook の署名シークレット |

5. 管理画面 → ショップ設定 → **プラグイン** → **Stripe 決済（カード）** を **有効にする** を押します。

これでカートに「購入手続きへ」が出ます。注文は、Stripe から Webhook が届いたときに確定します。
コンビニ払いや銀行振込を受けたい場合は [docs/plugins.md](plugins.md) の KOMOJU を参照してください。

### 複数のショップで入金先を分けたい場合（上級者向け）

Stripe Connect を使うと、ショップごとに別の Stripe アカウントへ入金できます。Stripe 側で Connect（プラットフォーム）の設定と
`STRIPE_CLIENT_ID` の登録が必要です。ショップ設定の「上級者向け: Stripe Connect」から接続します。
Webhook は「接続済みアカウントのイベントをリッスン」で登録してください。1 ショップだけなら不要です。

## 6. 公開前にやること

- ショップ設定で **特定商取引法に基づく表記・プライバシーポリシー・返品ポリシー** を入力する（未入力のあいだは公開できません）
- ショップ設定の **送料・税・連絡先** で送料（全国一律 / 都道府県別、送料無料ライン）と連絡先メールアドレスを入れる。価格はすべて税込で入力します
- ショップ設定の **購入前の確認画面** に、お届け時期（例: ご入金確認後 3 営業日以内に発送）と、ご注文の取消し・返品の条件を入れる。購入者が「注文を確定する」を押す直前の画面に表示されます（特定商取引法の最終確認画面。未設定のあいだは法務ページへの案内になります）
- 商品を登録し、SKU（サイズ・色など）ごとに価格と在庫を入れる
- プラグインの **メール通知** を有効にして、購入者に注文確認メールが届くようにする（[docs/plugins.md](plugins.md)。送り手は Resend のほか、自分の SMTP サーバー・SendGrid・Amazon SES を選べる: [docs/email.md](email.md)）
- 会員機能を使うなら [docs/members.md](members.md)。会員のログインはパスワードなし（メールのコードとリンク）で、メール通知プラグインの送信元から送ります。Supabase の設定は要りません
- Supabase の画面 → **Authentication → Sign In / Providers → Email** の **Allow new users to sign up** を **オフ** にする（運営者以外が Supabase のアカウントを作れないようにする。会員は Supabase のアカウントを使いません）
- 独自ドメインで公開するなら [docs/custom-domain.md](custom-domain.md)
- 注文メールが迷惑メールにならないよう、送信元ドメインの認証をする（[docs/email.md](email.md)）
- 止まったときに気づけるよう、無料の監視サービスに `/health` を登録する（[docs/monitoring.md](monitoring.md)）
- 独自ドメインにしたら、Cloudflare のレート制限と WAF でログイン画面を守る（[docs/hardening.md](hardening.md)）
- 月に一度、ショップ設定の **バックアップ** から JSON を保存する（[docs/backup.md](backup.md)）

## 7. 画像を R2 から直接配信する（推奨）

既定では画像も Worker が配信するので、画像 1 枚ごとに Workers のリクエスト（無料枠は 1 日 10 万）と R2 の読み取りを使います。
R2 のバケットに自分のドメインを付けると、画像は Cloudflare の CDN から直接配信され、Worker を通らなくなります。
独自ドメイン（[docs/custom-domain.md](custom-domain.md)）を使う人は、あわせて設定してください。

1. Cloudflare の画面 → **R2 オブジェクトストレージ → バケット（`banto-media`）→ 設定（Settings）→ カスタムドメイン → ドメインを追加**
2. `media.example.com` のように、Cloudflare に置いてあるドメインのサブドメインを入力します。DNS と証明書は自動で作られます
3. **Workers & Pages → banto → 設定 → 変数とシークレット** に `MEDIA_BASE_URL` = `https://media.example.com` を追加して保存（再デプロイされます）
4. ショップの商品画像の URL が `https://media.example.com/shops/...` になっていれば完了です。既存の画像もそのまま表示されます

> カスタムドメインを付けると、そのバケットの中身は URL を知っている人なら誰でも読めるようになります。
> Banto の画像キーは推測できないランダムな名前なので、公開前の商品の画像も実質見つけられませんが、画像以外をこのバケットに置かないでください。

画像はアップロード時に管理画面（ブラウザ）が長辺 1600px の WebP に縮小し、一覧用の 400px サムネイルも作ります。
スマホの写真をそのまま選んで大丈夫です。縮小は端末側で行うので、Workers の CPU 時間も使いません。

## 8. ページを速くする（Worker を DB の近くで動かす）

Banto の Worker は、ふだんは買い手の近くの Cloudflare の拠点で動き、ページを描くたびにデータベース（Supabase）へ何回か問い合わせます。
買い手とデータベースが離れていると、その往復のたびに時間がかかります。Worker をデータベースの近くで動かすと（Cloudflare の **Placement**）、商品の一覧や詳細のように DB に問い合わせるページが速くなります。

1. Supabase の画面 → **Project Settings → General** で、プロジェクトの **Region** を見ます（例: Northeast Asia (Tokyo) なら `ap-northeast-1`）
2. Cloudflare の画面 → **Workers & Pages → banto → 設定（Settings）→ ビルド（Builds）**
   - **ビルドの変数（Build variables and secrets）** に `BANTO_PLACEMENT` = `aws:ap-northeast-1`（`aws:` + 1 のリージョン）を追加
   - **Deploy command** を `npm run deploy` に変える（`npx wrangler deploy` のままだと、この変数は使われません）
3. **Deployments** から再デプロイします。ビルドのログに `deploy: placement {"mode":"targeted","region":"aws:ap-northeast-1"}` と出ていれば設定できています

- 確かめ方: ブラウザの開発者ツールでお店のページの応答ヘッダーを見ると、`cf-placement: remote-NRT`（東京へ移した）のように出ます（Cloudflare の仕様が変わると出なくなることがあります）。
- リージョンが分からない、Supabase 以外のデータベースを使っている（[docs/self-hosted-db.md](self-hosted-db.md)）ときは `BANTO_PLACEMENT` = `smart` にすると、Cloudflare が通信を見て決めます。ただしアクセスが少ないうちは移らないことがあります。
- DB に問い合わせない応答（`/robots.txt` など）は、遠くへ回るぶん少し遅くなることがあります。画像は §7 の R2 の独自ドメインから配れば Worker を通らないので影響しません。
- Cloudflare の画面の「配置（Placement）」で直接変えた設定は、次のデプロイで変わることがあります。ずっと使うなら `BANTO_PLACEMENT` で決めてください。
- Node で動かす（[docs/run-on-node.md](run-on-node.md)）ときは関係ありません。サーバーをデータベースの近くに置いてください。

## うまくいかないとき

| 症状 | 確認すること |
| --- | --- |
| 概要に「No URLs enabled」、ショップの URL が無い | **ビルドが Success / Ready なら、アカウントに workers.dev のサブドメインがまだ無いのが原因**です（新しいアカウントで起きる）。Cloudflare の左メニュー **Workers & Pages → 概要（Overview）** の右側 **「あなたのサブドメイン（Your subdomain）」** で `好きな名前.workers.dev` を決めて保存し、Worker の **設定 → ドメインとルート → workers.dev** を有効にする（または Deployments から再デプロイ）。ビルドが失敗していれば Deployments → View build history でビルドの成否を見る。失敗なら: Worker 名を Deploy の画面で変えた場合は `wrangler.jsonc` の `name` と一致しているか（Cloudflare が書き換えるはずだが、違えば合わせる）。ログに `wrangler: not found` とあれば Settings → Builds の Deploy command を `npx wrangler deploy` にする。成功しているのに URL が無ければ 設定 → ドメインとルート → workers.dev を有効化 |
| 設定画面にシークレットの欄が出なかった | 配置後に **設定 → 変数とシークレット → 追加** で `SUPABASE_SERVICE_ROLE_KEY`（種類: シークレット）を登録すれば同じです |
| セットアップ画面で「Supabase に接続できません」 | `SUPABASE_URL` の末尾に `/` が付いていないか。anon キーが正しいか（service_role と取り違えていないか） |
| 「データベースに接続できませんでした … Connection terminated unexpectedly」 | 接続文字列の方法は Cloudflare からだと TLS の制約で切られることがあります。上の **アクセストークン** の方法を使ってください |
| 「アクセストークンが正しくないか、期限切れです」 | `sbp_` で始まる値をそのまま貼ったか。Supabase の Access Tokens 画面で新しく作り直す |
| 「データベースに接続できませんでした」（接続文字列の方法） | 接続文字列の `[YOUR-PASSWORD]` を置き換えたか（角括弧ごと置き換える）。**Direct connection**（`db.〜.supabase.co`）ではなく **Session pooler** の文字列か。Supabase のプロジェクトが一時停止（Paused）になっていないか |
| 変数を入れたのに、再ビルド後に空に戻る | 古い `wrangler.toml` に `vars` が空で書かれていると起きます。最新の `wrangler.jsonc`（`keep_vars: true`、`vars` なし）に更新してください |
| 確認メールのリンクが `http://localhost:3000/#access_token=…` に飛ぶ | Supabase の Site URL が既定のままです。運営者はこのリンクを開いた時点で確認済みになっているので、管理画面のログイン画面からそのまま入れます。会員向けには Authentication → URL Configuration の Site URL と Redirect URLs をショップの URL にします |
| ログインで「メールアドレスの確認が済んでいません」 | Supabase の Authentication → Users でそのユーザーを選び Confirm email する |
| 決済後に注文が管理画面に出ない | Stripe の Webhook が届いていない。URL、購読イベント、`STRIPE_WEBHOOK_SECRET` を確認。Stripe の Webhook 画面に応答コードが出ます |
| 購入手続きボタンが出ない | プラグインの Stripe 決済が無効、または `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` が未設定 |
| 「決済ページを開けませんでした」（ログに `Please include the Stripe-Context header … Organization API key`） | Stripe の「組織」で作ったキーを使っています。**そのアカウント（サンドボックス）の中で** 開発者 → API キー から作り直したキーを `STRIPE_SECRET_KEY` に貼るのがいちばん簡単です。組織キーのまま使うなら、変数 `STRIPE_CONTEXT` に対象アカウントの ID（`acct_…`）を入れます |
| 「決済ページを開けませんでした」 | Stripe が決済ページの作成を拒否しています。Stripe の画面 → **開発者 → ログ** に失敗した `POST /v1/checkout/sessions` が出るので、そのエラーメッセージを見る（キーが `pk_` の公開キーになっている、テストと本番のキーが混在、など）。Cloudflare の banto → **ログ** にも `[banto] checkout:` で理由が出ます |
| ショップが 404 | ショップ設定で「ショップを公開する」がオフ、または法務3項目が未入力 |

## 開発者向け（コマンドで導入する）

```bash
git clone https://github.com/bantojs/banto
cd banto
npm install
npx wrangler login
npx wrangler r2 bucket create banto-media
# wrangler.jsonc の vars に SUPABASE_URL / SUPABASE_ANON_KEY を書く
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npm run deploy
```

マイグレーションは `npx supabase db push` でも、セットアップ画面からでも適用できます。
ローカル開発は `cp .dev.vars.example .dev.vars`（service_role キーを貼る。`SUPABASE_URL` 等は `.dev.vars` に追記するか `wrangler.jsonc` の `vars`）→ `npx supabase start` → `npx supabase db reset` → `npm run dev`。

環境変数と Secret の一覧は [docs/env.md](env.md)。任意の環境変数: `BANTO_LOCALE`（`en` で英語 UI）、`PUBLIC_BASE_URL`（独自ドメインを使うとき）、`MEDIA_BASE_URL`（R2 の公開ドメインから画像を配信するとき）、
`MASK_ORDERS_AFTER_DAYS`（既定 180）。`SESSION_SECRET` は必須（セットアップ画面が値を作って出します。導入後は変えないでください）。
