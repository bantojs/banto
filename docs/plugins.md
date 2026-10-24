# 同梱プラグイン

同梱プラグインはコア本体にバンドルされ、管理画面の **プラグイン** ページで有効/無効を切り替えます（再デプロイ不要）。
有効にすると **連携（hooks）** の送信先として並び、設定・無効化・削除はそこで行います。
API キー等のシークレットは DB に置かず、Cloudflare の **変数とシークレット**（Workers & Pages → banto → 設定）に
種類「シークレット」で登録します（CLAUDE.md §1-5）。以下の `npx wrangler secret put ...` は開発者向けの同じ操作です。

同梱プラグイン一覧: Stripe 決済（カード）、KOMOJU 決済、メール通知、LINE 通知。

## Stripe 決済（カード）

クレジットカード決済。設定手順は [docs/setup.md の「5. 決済（Stripe）をつなぐ」](setup.md#5-決済stripeをつなぐ) を参照してください。
必要なシークレット: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`。

外部プラグイン（自分でホストするもの）の作り方は [docs/hooks.md](hooks.md) を参照してください。

## メール通知

注文確認（`order.paid`）と発送通知（`order.shipped`）を購入者に送ります。運営者にも控えを送れます。お店で試着のお知らせもここから送ります。
会員のログインのコード・メンバーの招待のメールも、このプラグインの送信元から送ります。
購入者の連絡先は hooks のペイロードには載せず、同梱プラグインが DB から直接読みます（外部プラグインには渡りません）。

送り手は Cloudflare の変数 `MAIL_TRANSPORT` でデプロイ全体に 1 つ選びます（[docs/email.md §1](email.md)）:
**Resend**（既定、`RESEND_API_KEY`）/ **自分の SMTP サーバー・SMTP リレー**（`SMTP_HOST` ほか。レンタルサーバーや VPS のメールアカウント）/ **SendGrid**（`SENDGRID_API_KEY`）/ **Amazon SES**（`SES_REGION` と鍵）。

1. 送り手で自分のドメインを認証します（SPF / DKIM。DNS に数件追加）。
2. Cloudflare の変数とシークレットに、送り手の値を追加します（プラグインの画面に、今の送り手と足りない名前が出ます）。
3. 管理画面 → ショップ設定 → プラグイン → **メール通知** を有効にし、送信元（認証したドメインのアドレス）を設定します。
4. ショップ設定の「連絡先メールアドレス」を入れておくと、返信先と運営者控えに使われます。

送信は Cron（5 分おき）で行われ、失敗すると最大 5 回再送されます（Resend には再送しても二重に送らない鍵を付けます）。Resend の無料枠（月 3,000 通）で小規模なショップには十分です。

送信元ドメインの認証（SPF / DKIM）と Supabase の認証メールの設定は [docs/email.md](email.md) を参照してください。未設定だと迷惑メールに入ります。

## LINE 通知

注文が入ったとき・キャンセルされたとき・在庫が閾値以下になったときに、LINE Messaging API で運営者に push します。
購入者の個人情報（氏名・住所・メール）は送りません。

1. [LINE Developers](https://developers.line.biz/) で Messaging API チャネルを作成し、「Messaging API 設定」で **チャネルアクセストークン（長期）** を発行します。
2. 「チャネル基本設定」の **あなたのユーザー ID**（`U` で始まる）を控え、そのチャネル（公式アカウント）を友だち追加します。
3. 管理画面 → プラグイン →「LINE 公式アカウント」にチャネルアクセストークンを貼ります（ショップごと、暗号化して保存。docs/line.md）。ショップが 1 つだけなら、Cloudflare の変数とシークレットに種類「シークレット」で `LINE_CHANNEL_ACCESS_TOKEN` を追加しても構いません。

```bash
# 開発者向け
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
```

4. 管理画面 → ショップ設定 → プラグイン → **LINE 通知** を有効にし、送信先のユーザー ID を保存します。

配信は Cron（5 分おき）で行われ、失敗すると最大 5 回再送されます。結果は「連携」ページの配信履歴に出ます。

## KOMOJU 決済

コンビニ払い・銀行振込・PayPay などを [KOMOJU](https://komoju.com/) のホスト型決済ページで受け付けます。Stripe と併用できます。
KOMOJU の決済ページは配送先を集めないため、Banto 側でお届け先を入力してから KOMOJU へ転送します。

1. KOMOJU ダッシュボードの **設定 → API キー** から **シークレットキー**（`sk_...`）を控えます。
2. **設定 → Webhook** でエンドポイントを追加します。
   - URL: `https://<Worker の URL>/webhooks/komoju`
   - イベント: `payment.captured`, `payment.expired`, `payment.cancelled`
   - 表示される **シークレット** を控えます
3. Cloudflare の変数とシークレットに、種類「シークレット」で `KOMOJU_SECRET_KEY`（シークレットキー）と `KOMOJU_WEBHOOK_SECRET`（Webhook のシークレット）を追加します。

```bash
# 開発者向け
npx wrangler secret put KOMOJU_SECRET_KEY
npx wrangler secret put KOMOJU_WEBHOOK_SECRET
```

4. 管理画面 → ショップ設定 → プラグイン → **KOMOJU 決済** を有効にします。
   - **受け付ける支払い方法**: `konbini,bank_transfer,paypay` のようにカンマ区切り（空なら KOMOJU 側の既定）
   - **在庫を確保しておく時間**: 既定 72 時間。コンビニ払いは支払いまで日数がかかるため、Stripe（30 分）より長く取ります。期限内に支払われなければ在庫は戻ります。期限後に支払われた場合は在庫があれば確定し、無ければ自動で返金します。

注文は **Webhook（`payment.captured`）を受信したときにだけ** 確定します。KOMOJU のテストモードでは、ダッシュボードから支払いを「完了」にして Webhook を発火できます。

### 1 デプロイ = 1 KOMOJU アカウント

KOMOJU の API キーは Workers Secret（デプロイ単位）なので、同じデプロイ内の全ショップで同じ KOMOJU アカウントに入金されます。
ショップごとに別のアカウントが必要な場合は、Stripe Connect（ショップごとに接続）を使ってください。
