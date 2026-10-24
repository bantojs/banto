# 公開後の守り（WAF・レート制限・管理画面の保護）

Banto 本体は、署名付き Cookie・CSRF 検査・RLS・Webhook の署名検証を備えていますが、
**総当たりや大量アクセスを止める仕組みはアプリに入れていません**（Workers は状態を持てないため。KV 等は可搬性のために使わない方針）。
その役目は Cloudflare と Supabase の設定で担います。無料プランで十分です。

> ここに書いた設定は **独自ドメイン**（[docs/custom-domain.md](custom-domain.md)）で公開している場合に使えます。
> `workers.dev` の URL のままでは WAF やレート制限のルールを付けられません。

## 1. レート制限（Cloudflare）

Cloudflare の画面 → ドメイン → **セキュリティ → WAF → レート制限ルール → ルールを作成**。
無料プランでは 1 ルール（期間 10 秒）が作れるので、いちばん狙われやすいログイン系にまとめて付けます。

| 項目 | 値 |
| --- | --- |
| ルール名 | `login-brute-force` |
| 一致 | URI パス が次のいずれかを含む: `/admin/login`、`/account/login`、`/account/signup`、`/orders/lookup` かつ リクエストメソッド = `POST` |
| 同一の | IP アドレス |
| しきい値 | 10 秒間に 5 リクエスト |
| 期間・ブロック時間 | 10 秒（無料プランの既定） |
| アクション | ブロック（またはマネージドチャレンジ） |

有料プラン（Pro 以上）なら、`/mcp` と `/api/v1`（AI 用トークンの総当たり対策、1 分 60 回）、`/checkout`・`/api/shops/*/checkout`・`/tryon`（在庫予約の空押し対策、1 分 10 回）、`/orders/lookup`（注文照会の総当たり）にも別ルールを付けてください。

Banto 自身も DB で数える上限を持っています（0029: 同じ人・同じ IP の未確定の予約、会員のログインのメールの枠とショップ全体の上限）。WAF はその外側の守りです。

**WordPress などのサーバーが Banto を中継する構成**では、Banto にも WAF にも購入者の IP は見えず、全員が連携側のサーバーの IP になります。上のルールはそのサーバーの IP を除外し（式に `and ip.src ne <中継元の IP>` を足す）、購入者ごとの制限は連携側のサイトの前で掛けてください。Banto 側の IP ごとの上限は、中継元の宣言と `X-Banto-Client-IP` で購入者ごとに戻せます（docs/headless.md「サーバー側で中継するとき」、0033）。

## 2. WAF カスタムルール（無料で 5 つ）

**セキュリティ → WAF → カスタムルール**。おすすめは次の 2 つです。

1. **管理画面を国で絞る**: `URI パス が /admin で始まる` かつ `国 が 日本 でない` → ブロック。
   海外から管理する人は自分の国を足してください。
2. **既知の悪いボットを落とす**: `脅威スコア > 30`（Bot Fight Mode と併用）→ マネージドチャレンジ。

あわせて **セキュリティ → ボット → Bot Fight Mode** をオンにします（無料）。
ただし AI 用の `/mcp` `/api/v1` と決済の `/webhooks/*` は **ブラウザではないクライアント** が叩くので、
チャレンジ系のアクションは `URI パス が /webhooks、/mcp、/api で始まらない` の条件を付けて除外してください。
Stripe / KOMOJU の Webhook が止まると注文が確定しません。

Banto 自身も管理者ログインの失敗を数えます（0030: 同じメールアドレスで 15 分に 5 回、同じ IP で 20 回）。WAF のルールはその外側で、Supabase の `/token` の上限（Worker の出口 IP でまとめて掛かる）に達して正規の運営者まで締め出されるのを防ぐためのものです。

## 3. 運営者の二段階認証（0054）

管理画面のログインに、パスワードに加えて **認証アプリ（Google Authenticator など）の 6 桁** を求められます。データベースのアップデート `0054_operator_mfa` が要ります（管理画面 → アップデート）。

- **自分の設定**: 管理画面の右上 **二段階認証** → 登録を始める → QR を認証アプリで読み取る → 表示された 6 桁を入れる。次のログインから 6 桁を求めます。
- **全員に必須にする**: 管理画面 → 組織とメンバー → **二段階認証** → 全員に必須にする（組織の owner。先に自分の二段階認証を有効にして、6 桁でログインし直しておきます）。まだ登録していないメンバーは、次のログインで登録の画面に回されます。
- **認証アプリをなくした**: 同じ組織の owner か admin が、組織とメンバーの表の **二段階認証を外す** で外せます（owner の登録を外せるのは owner だけ。監査ログに残ります）。外されたメンバーは、次はパスワードだけで入り、必須の組織なら登録し直します。
- **owner が 1 人だけで、その owner が認証アプリをなくした**: Supabase の SQL エディタで次を実行して登録を消します（メールアドレスは本人のもの）。

  ```sql
  delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'owner@example.com');
  ```

**強制はデータベースで行います。** パスワードを知っている人は、管理画面を通らずに Supabase へ直接ログインして鍵（JWT）を受け取れます。そこで Banto は PostgREST の「リクエストの前の関数」（`pgrst.db_pre_request = public.banto_pre_request`）で、二段階目を済ませていない運営者の鍵をテーブルにも関数にも通しません。お客様の画面（anon）と Worker の特権の経路（service_role）は関係ありません。
自前の PostgreSQL（docs/self-hosted-db.md）でも、PostgREST が DB の設定を読む既定（`PGRST_DB_CONFIG=true`）のままなら同じように効きます。

## 4. 管理画面に二重の鍵をかける（Cloudflare Access、任意）

Cloudflare Zero Trust の **Access** は 50 ユーザーまで無料で、`/admin` を開く前にメールのワンタイムコードや Google ログインを要求できます。
Supabase のパスワードが漏れても管理画面に入れないので、運営者が 1〜数人のショップには強くおすすめします。

1. Cloudflare の画面 → **Zero Trust → Access → アプリケーション → アプリケーションを追加 → セルフホスト**
2. アプリケーションドメイン: `shop.example.com`、パス: `admin`
3. ポリシー: 許可、ルール: **メール** が運営者のアドレス（複数可）
4. 認証方法は既定の「ワンタイム PIN」でよい

`/webhooks` `/api` `/mcp` `/media` には **かけないでください**（外部サービスと AI が直接叩くため）。

## 5. Supabase 側

- **Authentication → Sign In / Providers → Email → Allow new users to sign up**: 会員機能を使わないなら **オフ**（docs/setup.md §6）
- **Authentication → Rate Limits**: ログイン試行と OTP の上限を確認する（既定で IP ごとの制限があります）
- **Project Settings → API**: `service_role` キーは Cloudflare の Secret 以外に貼らない。漏れたら **ここで再生成** → Cloudflare の値を差し替え
- **Database → Backups**: 無料プランには無い（[docs/backup.md](backup.md)）
- **プランの上限**（0052）: AI 用トークンや取り込みの誤操作で商品や会員が大量にできるのを止めたいときは、Supabase の SQL エディタで `select site_settings_set('plan_limits', '{"products": 1000, "customers": 5000}');` を実行します（管理画面からは入れられません。今の数は「サイトの設定」に出ます）
- **監査ログ**（0051）: 管理画面「組織とメンバー」→「監査ログ」で、誰がいつ何を変えたか（会員のメール・注文の状態・権限・AI 用トークン・ドメイン / Stripe / 公開）を組織の owner / admin が読めます。DB のトリガーが書くので Banto の画面からは消せません。スタッフの操作に心当たりが無いときはまずここを見ます

## 6. シークレットの入れ替え（漏れたかもしれないとき）

| 何を | どこで作り直す | その後 |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → Reset | Cloudflare の変数とシークレットを更新。`SESSION_SECRET` を設定していない古い導入では、全員のログインが切れ、会員のセッション・hooks の署名・暗号化した LINE のトークンと LINE / Google のシークレットも無効になる（導出値が変わるため）。**先に `SESSION_SECRET` を設定してから**回す |
| `SESSION_SECRET` | 自分で作り直す（32 文字以上のランダム文字列） | 漏れたときだけ。全員がログアウトし、暗号化した LINE のトークン・LINE / Google のシークレット・hooks の署名の値を入れ直す |
| `STRIPE_SECRET_KEY` | Stripe → 開発者 → API キー → ロール | Cloudflare を更新 |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Webhook → 署名シークレットをロール | Cloudflare を更新（ロール中は新旧両方が有効） |
| `RESEND_API_KEY` / `SENDGRID_API_KEY` / `SES_SECRET_ACCESS_KEY` / `SMTP_PASS` / `KOMOJU_SECRET_KEY` / `LINE_CHANNEL_ACCESS_TOKEN` | 各サービス（SMTP はそのサーバーのアカウント） | Cloudflare を更新 |
| AI 用トークン | 管理画面 → AI 用トークン → 失効 → 再発行 | AI クライアントの設定を更新 |
| 運営者のパスワード | Supabase → Authentication → Users → 該当ユーザー → Send password recovery（届くメールは [docs/email.md](email.md) の SMTP 設定が必要） | ついでに Access（§3）を付ける |

## 7. 更新を止めない

Banto の更新は管理画面の **アップデート** に表示されます。セキュリティ修正はリリースノートに **[security]** と書くので、
その表示が出たら GitHub のフォークで **Sync fork** → Cloudflare が自動デプロイ → 未適用マイグレーションがあれば画面から適用、の順で当ててください（[docs/upgrade.md](upgrade.md)）。
脆弱性を見つけた場合の報告先は [SECURITY.md](../SECURITY.md) です。
