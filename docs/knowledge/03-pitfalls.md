# 03. 実機で踏んだ落とし穴

症状 → 原因 → 対処。すべて 2026-10-15 に本物の環境で確認したもの。docs/setup.md の「うまくいかないとき」にも反映済み。

## Cloudflare

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| Deploy 後に変数が空に戻る | `wrangler.toml` の空の `vars` がビルドのたびに画面の値を上書き | `vars` を書かない + `keep_vars: true`（対応済み） |
| 設定画面にシークレットの欄が出ない | Deploy ボタンはシークレットを `.dev.vars.example` から読む。空の値は欄にならない | `KEY=REPLACE_ME` の形で列挙（対応済み）。非公開リポジトリの「インポート」では Configure 画面自体が出ないので画面で貼る |
| 概要に「No URLs enabled」 | ビルド成功でも workers.dev のトグルが有効にならないことがある | 設定 → ドメインとルート → workers.dev を有効化。ビルドログに URL が出ていればコードは載っている |
| `Illegal invocation: function called with incorrect this` | 素の `fetch` をオブジェクトのプロパティ経由で呼んだ | ラッパー関数で渡す（対応済み。`registerJobs` / `deliverPendingHooks`） |
| 接続文字列で `Connection terminated unexpectedly` | Workers → Supabase pooler の TLS が切られる（workerd #2712） | Management API 経由に変更（対応済み） |
| 初回のマイグレーションが途中で切れる（もう一度押すと続きから当たる） | Management API は 1 ファイル = 1 リクエスト。60 本を 1 回で送ると、Workers 無料プランのサブリクエスト 50 とブラウザとの接続の持ち時間を超える | 1 回の送信は 40 回・20 秒まで。残りは画面のスクリプトが同じフォームを送り直す（`src/routes/admin/migrate.tsx`。トークンは入力欄から毎回送るだけで残さない）。スクリプトが動かなくても、押し直せば続きから（対応済み） |
| 初回のデプロイ直後にログインすると 500 | マイグレーション前の DB には `banto_setup_state` が無い | ログインの前に確かめ、使えなければセットアップの画面へ（`adminDbReady`、対応済み） |
| ビルドログは「View build history」 | Deployments タブの一番下 | ログに `Deployed banto triggers` と URL が出ていれば成功 |

## Supabase

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| 接続文字列が「形式が正しくありません」 | パスワードの記号を `new URL()` が解釈できない | 独自パーサで「最後の @ より前」をパスワードに（対応済み） |
| Direct connection でつながらない | `db.<ref>.supabase.co` は IPv6 専用 | Session pooler を使う。今は Management API が既定なので無関係 |
| 確認メールが `http://localhost:3000/#access_token=…` に飛ぶ | Site URL が既定のまま | 運営者は Admin API で確認済み作成に変更（対応済み）。会員は 0012 から Supabase Auth を使わないので関係なくなった |
| SMTP（Resend）を設定したのに `noreply@mail.app.supabase.io` から英語のメールが届く（2026-10-16） | 設定したのが別のプロジェクトだった（同じアカウントに複数のプロジェクト） | 画面の URL の `project/<ref>` が `SUPABASE_URL` の ref と同じか確かめる。Auth のログ（`mail.send` の `mail_from`）で、どの送り手で送ったか分かる |
| 会員登録が「登録できませんでした」になり、Auth のログに `550 This API key is not authorized to send emails from <domain>` | Resend の API キーのドメインの制限と、送信元のアドレスのドメインが違う（`demo.example.com` と `example.com` など） | 送信元を確認済みのドメインに合わせるか、そのドメインを Resend で確認する。Supabase は SMTP の失敗で登録ごと 500 にする（0012 の Banto のログインでは「メールを送れませんでした」と出す） |
| アクセストークンの権限 | マイグレーションはテーブル作成（書き込み） | Database だけ Full access、ほかは No access |
| 無料プランの一時停止 | 1 週間アクセス無しで Paused | Banto の Cron が 5 分ごとに叩くので通常は起きない |

## Stripe

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| 「決済ページを開けませんでした」+ `Invalid API Key provided: whsec_…` | `STRIPE_SECRET_KEY` に Webhook 署名シークレットを貼った | 取り違え。プラグイン画面が形を検査するようにした（対応済み） |
| 同上 + `Please include the Stripe-Context header … Organization API key` | 組織レベルで発行したキー | アカウント（サンドボックス）内で発行したキーを使う。または `STRIPE_CONTEXT=acct_…` |
| Stripe のログに何も出ない | 認証段階で弾かれている、または別環境（サンドボックス / 本番）を見ている | テストモードのトグルは無くなり「サンドボックス」になった。左上のアカウント名 → サンドボックス |
| Webhook のイベントが見つからない | `order.paid` 等は Banto の hooks 名で Stripe のイベントではない | `checkout.session.*` の 4 つ。プラグイン画面に URL とイベントを表示するようにした |
| Checkout 作成が 30 分の下限で弾かれる可能性 | `expires_at` ぴったり 30 分 | 35 分に（対応済み） |

## Resend / hooks

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| メールが送られない、配信履歴が「送信待ち」 | 上の `Illegal invocation` | 対応済み。再送は 2/4/8/16 分後 |
| Stripe / KOMOJU 宛ての配信が失敗し続ける | 受信処理の無いプラグインがイベントを購読していた | 購読させない + 既存は 204 で完了（対応済み） |
| ドメイン未認証 | Resend 無料は `onboarding@resend.dev` から自分宛てだけ | docs/email.md のドメイン認証 |

## ブラウザ（2026-10-23、Chromium で確認）

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| 会員のログイン・コード入力・マイページのフォームを送ると 403（CSRF） | `Referrer-Policy: no-referrer` のページからのフォームの POST に、ブラウザは `Origin: null` を付ける（Fetch の仕様）。0031 で csrfGuard が `null` を拒むようにした | 会員の画面と領収書の画面は `same-origin` に（対応済み）。テストの Browser は no-referrer のページからの POST を `Origin: null` にして再現する。CSRF を守る画面に no-referrer を付けない |
| WebAuthn を試したいが、テスト用の証明書だと動かない | Chrome は証明書のエラーがあるページでは WebAuthn を使わせない | Playwright で `--host-resolver-rules=MAP shop.example.jp:443 127.0.0.1:<port>` と `--ignore-certificate-errors-spki-list=<自己署名の証明書の SPKI>` を付け、CDP の `WebAuthn.addVirtualAuthenticator` で仮想の認証器を足す。エージェントのプロキシを通らないよう `--no-proxy-server` |

## SQL の差し替え

- **列の CHECK で呼ぶ関数**（`banto_image_options_ok`・`banto_option_axes_ok` など）は、行を書くロール（管理画面の `authenticated`）に EXECUTE が要る。剥奪すると、その表への insert / update が `permission denied for function` で止まる（`check:rls` の allowlist に足す）。
- **`import_catalog` は 0065 で包んである**（中身は `banto_import_catalog_0042` に改名、`import_catalog` は取り込みの間だけ SKU の軸を写さない設定を入れて中身を呼ぶ）。取り込みの中身を直すときは `banto_import_catalog_0042` を差し替える。`import_catalog` を `create or replace` で書き直すと包みが消える。

## 開発環境（このリポジトリで作業するとき）

- `git push origin main` は**本番ビルドを直接走らせる**。壊れた状態で push しない（`npm run lint && npm test && npm run build:workers` を先に）。
- サンドボックスの PostgreSQL は落ちやすい。`ECONNREFUSED 127.0.0.1:54329` が出たら 04 の起動コマンド。
