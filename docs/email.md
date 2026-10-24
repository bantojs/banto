# メールが届くようにする（到達性と送り手の選び方）

Banto が送るメールは 2 系統あります。どちらも **自分のドメインを送信元にして、SPF / DKIM / DMARC を設定する** のが到達性の要です。
`@gmail.com` などフリーメールのアドレスを送信元にすると、受信側で迷惑メール扱いされるか、そもそも送信を拒否されます。

| 系統 | 何を送るか | 送信者 | 設定場所 |
| --- | --- | --- | --- |
| Banto のメール | 注文確認・発送通知（購入者）、控え（運営者）、会員のログインのコード、メンバーの招待、お店で試着のお知らせ | 同梱プラグイン「メール通知」の送信元から、`MAIL_TRANSPORT` で選んだ送り手（下表） | Cloudflare の変数とシークレット + DNS |
| 認証メール | 運営者のメール確認・パスワード再設定 | Supabase Auth | Supabase の SMTP 設定（§2） |

## 1. 送り手を選ぶ（`MAIL_TRANSPORT`）

送り手はデプロイ全体で 1 つです。Cloudflare の **変数とシークレット** に `MAIL_TRANSPORT` を置き、送り手ごとの値を足します（[docs/env.md](env.md)）。
送信元（`ショップ名 <order@example.com>`）はショップごとにプラグインの設定で入れます。**どの送り手でも、送信元のドメインをその送り手で認証（SPF / DKIM）しておく**ことは同じです。

| `MAIL_TRANSPORT` | 向いている人 | 要る値 |
| --- | --- | --- |
| `resend`（既定。未設定ならこれ） | 手早く始めたい人。無料枠 月 3,000 通 | `RESEND_API_KEY` |
| `smtp` | レンタルサーバーや VPS に自分のメールサーバーがある人、各社の SMTP リレーを使う人 | `SMTP_HOST`（+ `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `SMTP_TLS`） |
| `sendgrid` | SendGrid をすでに契約している人 | `SENDGRID_API_KEY` |
| `ses` | AWS をすでに使っている人。1,000 通 0.1 USD | `SES_REGION` `SES_ACCESS_KEY_ID` `SES_SECRET_ACCESS_KEY` |

管理画面 → プラグイン → **メール通知** に、今の送り手と足りない値が出ます。値を変えたら再デプロイは要りません（Secret の反映には数十秒かかることがあります）。

### 1a. Resend（既定）

1. [Resend](https://resend.com/) にサインアップ（無料: 月 3,000 通・日 100 通）
2. **Domains → Add Domain** で `example.com`（または `mail.example.com` のようなサブドメイン）を追加
3. 表示される DNS レコード（DKIM の `TXT`、SPF 用の `MX` と `TXT`、あれば DMARC）を **Cloudflare の DNS** に追加
   - Cloudflare の画面 → ドメイン → **DNS → レコード → レコードを追加**。種類・名前・値をそのまま写す
   - プロキシ（オレンジ雲）は **オフ（DNS のみ）** にする
4. Resend の画面で **Verify** を押し、すべて緑になるのを待つ（数分〜数時間）
5. **API Keys** でキーを作り、Cloudflare の **変数とシークレット** に `RESEND_API_KEY`（種類: シークレット）として貼る（`MAIL_TRANSPORT` は書かなくてよい）
6. 管理画面 → プラグイン → **メール通知** を有効にし、送信元を `ショップ名 <order@example.com>` のように認証済みドメインで設定する

### 1b. 自分の SMTP サーバー・SMTP リレー（`smtp`）

レンタルサーバー（さくら・ロリポップ・エックスサーバー等）のメールアカウント、VPS に立てた Postfix、各社の SMTP リレー（Resend / SendGrid / SES にも SMTP の口があります）に、Banto が直接 SMTP で渡します。

| 名前 | 値 |
| --- | --- |
| `MAIL_TRANSPORT` | `smtp` |
| `SMTP_HOST` | サーバー名（例 `example.sakura.ne.jp`、`mail.example.jp`） |
| `SMTP_PORT` | 省略時は 587（`SMTP_TLS=on` なら 465） |
| `SMTP_TLS` | `starttls`（既定。587 で接続してから TLS に切り替える。サーバーが STARTTLS を出さなければ送らない）/ `on`（465、最初から TLS）/ `off`（平文。**同じホストや閉じた網の中のサーバーにだけ**。認証情報がそのまま流れます） |
| `SMTP_USER` / `SMTP_PASS` | メールアカウントの ID とパスワード（AUTH PLAIN か LOGIN）。認証の無いリレーなら省略 |

- **Cloudflare Workers は外向きの 25 番ポートを塞いでいます**。必ず 587 か 465 を使ってください（レンタルサーバーの「サブミッションポート」です）。Node で動かす場合も、多くのホスティングが 25 番を塞いでいます。
- SMTP の送り手は **Workers と Node のどちらでも同じコード**で動きます（接続だけランタイムのアダプタ。`src/adapters/workers/socket.ts` と `src/adapters/node/socket.ts`）。ライブラリは使っていません。
- 送信元のアドレスは、そのサーバーが送ってよいドメインのものにしてください（レンタルサーバーなら、そのサーバーのメールアカウントのアドレス）。SPF にそのサーバーを含め、DKIM を有効にしておくと届きやすくなります。
- EHLO で名乗る名前は `PUBLIC_BASE_URL` のホスト名です（未設定なら `banto`）。
- Banto は 1 通ごとに接続して送り、応答を 20 秒待って切ります。注文メールは Cron から（失敗は再送）、ログインのメールはその場で送ります。

### 1c. SendGrid（`sendgrid`）

1. SendGrid の **Settings → Sender Authentication** で自分のドメインを認証する（DNS に CNAME を数件）
2. **Settings → API Keys** で **Mail Send** の権限だけ持つキーを作る（`SG.` で始まる）
3. Cloudflare の変数とシークレットに `MAIL_TRANSPORT=sendgrid` と `SENDGRID_API_KEY`（種類: シークレット）

Banto は v3 の Mail Send API（`https://api.sendgrid.com/v3/mail/send`）を呼びます。宛先の控え（運営者 BCC）と返信先もそのまま渡します。

### 1d. Amazon SES（`ses`）

1. SES の **Verified identities** で送信元のドメイン（か、まずはアドレス）を認証する（Easy DKIM の CNAME を DNS に追加）
2. 新しいアカウントは **サンドボックス**（認証済みの宛先にしか送れない、1 日 200 通）。本番前に **Request production access** を出す
3. IAM で `ses:SendEmail` だけを許すユーザーを作り、アクセスキーを発行する
4. Cloudflare の変数とシークレットに `MAIL_TRANSPORT=ses`、`SES_REGION`（例 `ap-northeast-1`）、`SES_ACCESS_KEY_ID` と `SES_SECRET_ACCESS_KEY`（種類: シークレット）

Banto は SES v2 の `SendEmail`（`https://email.<region>.amazonaws.com/v2/email/outbound-emails`）を SigV4 で署名して呼びます（SDK なし。VPC エンドポイント等を使うなら `SES_ENDPOINT` で差し替え）。

## 2. Supabase の認証メールも同じドメインから送る

Supabase 既定の送信（`noreply@mail.app.supabase.io`）は **1 時間 2 通** の制限があり、本番運用には足りません。
会員のログインは Banto が送るので Supabase の設定は要りませんが、運営者のパスワード再設定のために設定しておくと安心です。
Resend 以外の送り手でも、その送り手の SMTP の口（SendGrid は `smtp.sendgrid.net`、SES は `email-smtp.<region>.amazonaws.com`、自前のサーバーならそのまま）を同じように入れられます。

1. Supabase の画面 → **Project Settings → Authentication → SMTP Settings** → **Enable Custom SMTP** をオン
2. 次の値を入れる

   | 項目 | 値 |
   | --- | --- |
   | Sender email | `auth@example.com`（Resend で認証したドメイン） |
   | Sender name | ショップ名 |
   | Host | `smtp.resend.com` |
   | Port | `465` |
   | Username | `resend` |
   | Password | Resend の API キー |

3. **Authentication → URL Configuration** で **Site URL** を `https://<ショップの URL>`、**Redirect URLs** に `https://<ショップの URL>/**` を追加する。これが無いと確認メールのリンクが `http://localhost:3000` に飛びます
4. **Authentication → Rate Limits** で送信上限を実態に合わせて上げる（既定は低い）
5. **Authentication → Email Templates** の文面を日本語にし、ショップ名を入れる（件名も）

## 3. DMARC を付ける

SPF と DKIM が通ったら、DMARC のレコードを 1 つ追加すると Gmail / iCloud での扱いがさらに安定します。

```
種類: TXT   名前: _dmarc   値: v=DMARC1; p=none; rua=mailto:dmarc@example.com
```

最初は `p=none`（監視だけ）で始め、レポートで問題が無ければ `p=quarantine` に上げます。

## 4. 確認のしかた

- 自分の Gmail 宛にテスト注文し、「表示 → 元のメッセージを表示」で `SPF: PASS` `DKIM: PASS` `DMARC: PASS` を確認する
- [mail-tester.com](https://www.mail-tester.com/) に表示されたアドレスへ送ると、10 点満点で採点してくれます
- 送り手の画面（Resend の **Logs**、SendGrid の **Activity**、SES の **CloudWatch**）で配信状態（Delivered / Bounced）を見る。バウンスが続くアドレスは各サービスが自動で抑止します。自前の SMTP ならサーバーのログ

## 5. 文面で気をつけること

- 件名にショップ名と注文番号を入れる（Banto の既定の文面は入っています）
- URL は自分のドメイン（独自ドメインを設定している場合）にする。`workers.dev` の URL でも届きますが、独自ドメインのほうが信頼されます
- 画像だけのメール、短縮 URL、大量の記号は避ける

## 届かないとき

| 症状 | 確認すること |
| --- | --- |
| 送り手のログに出ない | プラグインが有効か、`MAIL_TRANSPORT` と送り手の値が揃っているか（プラグインの画面に足りない名前が出る）、`hook_deliveries` の失敗（管理画面 → 連携 → 配信履歴。送り手の応答がそのまま残る） |
| ログは Delivered だが受信箱に無い | 迷惑メールフォルダ。SPF / DKIM が PASS しているか |
| `from` のドメインが拒否される | 送り手のドメイン認証が完了していない。送信元が認証済みドメインか |
| SMTP で `does not offer STARTTLS` | サーバーが 587 で STARTTLS を出していない。465 なら `SMTP_TLS=on`、同じホストのサーバーなら `SMTP_TLS=off` |
| SMTP で `timeout waiting for server` / つながらない | ポートが 25 になっていないか（Cloudflare は 25 を塞ぐ）。ホスト名・ファイアウォール |
| SMTP で `535` | ID かパスワードが違う。レンタルサーバーは「メールアドレス全体」が ID のことが多い |
| 会員のログインのメールで「メールの設定が済んでいません」 | プラグインの送信元が空か、送り手の値が足りない |
| 会員の登録確認メールが来ない | Supabase の Custom SMTP が有効か。Rate Limits。Email Templates の確認リンクが正しいか |
