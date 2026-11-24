---
name: install
description: Banto をコマンドラインから導入する（wrangler）。Claude Code 等、シェルが使える AI エージェント向け。秘密の値は AI が受け取らず、利用者が自分で入れる。
---

# Banto の導入（CLI）

前提: Node.js 22、`npx wrangler` が使えること。

## AI が受け取ってよいもの・受け取らないもの

受け取ってよいもの（これだけ）:

- **Cloudflare の API トークン**（`CLOUDFLARE_API_TOKEN` として使う）。利用者に、次の条件で作ってもらう。
  - 権限は **Workers Scripts:Edit・Workers R2 Storage:Edit・Account Settings:Read** の 3 つだけ
  - **TTL（有効期間）の終了日を今日か明日にする**（Cloudflare の画面の My Profile → API Tokens → Create Token → TTL）
- Supabase の **Project URL** と **Publishable key**（`sb_publishable_…`。今までの anon キーでも可）。どちらも公開してよい値。

**受け取らないもの**（利用者に聞かない。チャットに貼られたら使わず、その値を作り直してもらう）:

- Supabase の Secret key（`sb_secret_…`）・service_role キー
- データベースの接続文字列（パスワードを含む）
- Supabase のアクセストークン（`sbp_…`）
- `SESSION_SECRET`、Stripe のシークレットキー・Webhook の署名シークレット、そのほかの決済の秘密

秘密の値は、利用者が **Cloudflare の画面か利用者自身のターミナル** に直接入れる。AI は「どこに何を入れるか」と、利用者が打つコマンドを示すだけにする。

## 手順

1. `git clone https://github.com/bantojs/banto && cd banto && npm ci`（利用者の fork で作業していることを確かめる）
2. `npx wrangler whoami` でトークンが有効か確かめる（`CLOUDFLARE_API_TOKEN` を環境変数で渡す。トークンをファイルに書かない）。
3. `npx wrangler r2 bucket create banto-media`
4. `wrangler.jsonc` の `vars` に `SUPABASE_URL` と `SUPABASE_ANON_KEY` を書く（公開してよい値だけ。秘密は書かない）。
5. `npm run deploy` → 表示された URL を控える。
6. **秘密の値は利用者が入れる**。次のどちらかを案内する（docs/setup.md §3 と同じ）。
   - Cloudflare の画面: **Workers & Pages → banto → 設定（Settings）→ 変数とシークレット（Variables and Secrets）→ 追加**。種類は **シークレット**。
   - 利用者自身のターミナル（AI が動いているシェルではない、別のターミナル）で `npx wrangler secret put <名前>` を打ち、聞かれたら値を貼る（画面に出ず、履歴にも残らない）。

   入れるもの:
   - `SUPABASE_SERVICE_ROLE_KEY` = Supabase の Secret key（`sb_secret_…`）
   - `SESSION_SECRET` = セットアップ画面（手順 7）の「環境変数と Secret」に出る値
7. 利用者に `https://<URL>/admin/setup` を開いてもらう。AI は `curl https://<URL>/admin/setup/status.json` で足りないものを確かめる（JSON に秘密は含まれない）。`env.missing` が空になるまで手順 6 を繰り返す。
8. **マイグレーションは利用者がセットアップ画面で当てる**（docs/setup.md §4-2）。
   - 利用者が Supabase の **Account preferences → Access Tokens** でトークンを作る。権限は **Database だけ Full access**、ほかは No access。
   - そのトークンを、利用者がセットアップ画面に直接貼って **適用する** を押す。トークンは HTTPS で Supabase に送られ、Banto は保存しない。
   - AI は接続文字列で `supabase db push --db-url` を実行しない。
   - 終わったら `status.json` の `next` が `owner` になっていることを確かめる。
9. 運営者登録（メール・パスワード）は **利用者自身に** `https://<URL>/admin/setup` で行ってもらう。AI がパスワードを決めない。
10. 決済を使う場合（docs/setup.md §5）:
    - Stripe の Webhook エンドポイント `https://<URL>/webhooks/stripe` の登録を案内する。
    - `STRIPE_SECRET_KEY` と `STRIPE_WEBHOOK_SECRET` は、手順 6 と同じく利用者が入れる。
    - 管理画面 → プラグイン → Stripe 決済を有効にするよう案内する。

## 終わったら（必ず行う）

1. 利用者に **Cloudflare の API トークンを削除** してもらう（My Profile → API Tokens）。TTL で切れる場合も、使い終わったら削除する。
2. 手順 8 で作った **Supabase のアクセストークンを削除** してもらう（Account preferences → Access Tokens）。
3. 秘密がどこにも残っていないか確かめる。
   - `git diff` と `git status` で、`wrangler.jsonc` の `vars` に公開してよい値（`SUPABASE_URL`・`SUPABASE_ANON_KEY`）しか無いこと、`.dev.vars` などのファイルを作っていないこと。
   - AI のシェルで秘密を引数や環境変数に入れていないこと（シェルの履歴に残らない）。
   - チャットに秘密が貼られていたら、その値を作り直してもらう（Supabase の Secret key は Supabase の画面で、Stripe のキーは Stripe の画面で）。
