# 環境変数と Secret の一覧

| 名前 | 種類 | 必須 | 値の場所・意味 |
| --- | --- | --- | --- |
| `SUPABASE_URL` | 変数または Secret | 必須 | Supabase → Project Settings → Data API → Project URL |
| `SUPABASE_ANON_KEY` | 変数または Secret | 必須 | Supabase → Project Settings → API Keys → anon public |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret**（`.dev.vars.example`） | 必須 | Supabase → Project Settings → API Keys → service_role。誰にも見せない |
| `SESSION_SECRET` | **Secret**（`.dev.vars.example`） | 新しい導入では必須 | 32 文字以上のランダム文字列（セットアップ画面が作って出す）。セッション・会員のログイン・hooks の署名・暗号化（LINE のトークン、LINE / Google のシークレット）の鍵のもと。**導入後は変えない**。2026-10-18 より前の導入で未設定なら service_role キーから導出して動き続ける（ダッシュボードに案内が出る。後から設定すると全員がログアウトし、暗号化した秘密は入れ直し） |
| `PUBLIC_BASE_URL` | 変数 | 任意 | 独自ドメインを使うとき `https://shop.example.com`。未設定ならアクセスされた URL から自動 |
| `MEDIA_BASE_URL` | 変数 | 任意 | R2 のカスタムドメインから画像を配信するとき `https://media.example.com`（docs/setup.md §7） |
| `BANTO_LOCALE` | 変数 | 任意 | `en` で英語 UI。既定は日本語 |
| `BANTO_TIMEZONE` | 変数 | 任意 | 管理画面・CSV・メールの日時表示と、売上集計の日別・月別の区切りの時間帯（IANA 名、例 `Asia/Tokyo`、`America/Los_Angeles`）。既定 `Asia/Tokyo` |
| `BANTO_PLACEMENT` | **ビルドの変数**（Settings → Builds） | 任意 | Worker を動かす場所（Cloudflare の Placement）。`aws:<Supabase のリージョン>`（例 `aws:ap-northeast-1`）か `smart`。Deploy command を `npm run deploy` にしたときだけ効く（docs/setup.md §8）。実行中の Worker からは読まない |
| `MASK_ORDERS_AFTER_DAYS` | 変数 | 任意 | 発送から何日で個人情報をマスクするか。既定 180 |
| `AUDIT_LOG_KEEP_DAYS` | 変数 | 任意 | 監査ログ（0051、管理画面「組織とメンバー」→「監査ログ」）を何日残すか。既定 365、30 より短くはならない |
| `STRIPE_SECRET_KEY` | Secret | Stripe を使うなら | Stripe → 開発者 → API キー → シークレットキー |
| `STRIPE_WEBHOOK_SECRET` | Secret | Stripe を使うなら | Stripe → 開発者 → Webhook → 署名シークレット（デプロイ後に作る） |
| `STRIPE_CLIENT_ID` | Secret | Connect を使うなら | Stripe → Connect の設定 → クライアント ID（上級者向け） |
| `STRIPE_CONTEXT` | 変数 | 組織キーを使うなら | Stripe の「組織」で発行した API キーを使うとき、対象アカウントの ID（`acct_…`、Stripe → 設定 → ビジネス → アカウント ID）。アカウント内で発行したキーなら不要 |
| `KOMOJU_SECRET_KEY` / `KOMOJU_WEBHOOK_SECRET` | Secret | KOMOJU を使うなら | KOMOJU の管理画面 |
| `MAIL_TRANSPORT` | 変数 | 任意 | メールの送り手: `resend`（既定）/ `smtp` / `sendgrid` / `ses`（docs/email.md §1）。注文メール・会員のログインのコード・招待がすべてこれで送られる |
| `RESEND_API_KEY` | Secret | `resend` のとき | Resend → API Keys（docs/email.md） |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_TLS` | `SMTP_HOST` は Secret 扱い、他は変数（`SMTP_PASS` は Secret） | `smtp` のとき | 自分のメールサーバーや SMTP リレー。`SMTP_PORT` は既定 587（`SMTP_TLS=on` なら 465）、`SMTP_TLS` は `starttls`（既定）/ `on` / `off`。**25 番は使えない**（Cloudflare が塞ぐ） |
| `SENDGRID_API_KEY` | Secret | `sendgrid` のとき | SendGrid → Settings → API Keys（Mail Send の権限） |
| `SES_REGION` / `SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY` / `SES_ENDPOINT` | `SES_REGION` と `SES_ENDPOINT` は変数、鍵は Secret | `ses` のとき | Amazon SES（`ses:SendEmail` だけの IAM ユーザー）。`SES_ENDPOINT` は省略可（VPC エンドポイント等） |
| `DB_MIGRATION_HOSTS` | 変数 | 自前の PostgreSQL なら | セットアップ・アップデートの画面から接続文字列でマイグレーションを当ててよいホスト（カンマ区切り、完全一致）。Supabase のホストと localhost は書かなくても使える（docs/self-hosted-db.md） |
| `CLIENT_IP_HEADER` | 変数 | 任意 | 回数の制限（会員のログイン・在庫の予約・運営者のログイン）に使う IP のヘッダー。Cloudflare の既定は `cf-connecting-ip`。Node の既定は `x-forwarded-for`（リバースプロキシの後ろに置く前提） |
| `TRUSTED_PROXY_HOPS` | 変数 | 任意 | `x-forwarded-for` のとき、信頼するプロキシの段数（既定 1 = 直前のプロキシが足した値を使う）。先頭の値は依頼側が自由に書けるので使わない。前段に CDN とリバースプロキシの 2 段があるなら 2 |
| `LINE_CHANNEL_ACCESS_TOKEN` | Secret | LINE 通知を使うなら | LINE Developers → Messaging API 設定 → チャネルアクセストークン |

- 値が空、または `REPLACE_ME` のままの項目は「未設定」として扱われます（`.dev.vars.example` の雛形をそのまま配置しても壊れません）。
- `wrangler.jsonc` には値を書きません（`keep_vars: true`。画面で入れた変数を wrangler が消さないため）。必須の 3 つは `.dev.vars.example` に列挙してあり、Deploy ボタンの画面で入力できます。
- Secret は Cloudflare の **Workers & Pages → banto → 設定 → 変数とシークレット** で種類「シークレット」として追加します（コマンドなら `npx wrangler secret put 名前`）。
- Node で動かす場合はすべてを環境変数として渡します（docs/run-on-node.md）。
- セットアップ画面（`/admin/setup`）が未設定の項目を検出して、この表と同じ案内を出します。
