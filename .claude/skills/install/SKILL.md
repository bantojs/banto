---
name: install
description: Banto をコマンドラインから導入する（wrangler + Supabase CLI）。Claude Code 等、シェルが使える AI エージェント向け。
---

# Banto の導入（CLI）

前提: Node.js 22、`npx wrangler` と `npx supabase` が使えること。利用者から次を受け取る（チャットに貼られたら、使用後に失効を促す）。

- Cloudflare API トークン（権限: Workers Scripts:Edit、Workers R2 Storage:Edit、Account Settings:Read）→ `CLOUDFLARE_API_TOKEN`
- Supabase の Project URL、anon キー、service_role キー、接続文字列（Transaction pooler）
- Stripe のシークレットキーと Webhook 署名シークレット（決済を使う場合）

## 手順

1. `git clone https://github.com/bantojs/banto && cd banto && npm ci`
2. `npx wrangler whoami` でトークンが有効か確認する（`CLOUDFLARE_API_TOKEN` を環境変数で渡す）。
3. `npx wrangler r2 bucket create banto-media`
4. wrangler.jsonc の `vars` に `SUPABASE_URL` と `SUPABASE_ANON_KEY` を書く（値はファイルに残る。利用者の fork で作業していることを確認する）。
5. Secret を設定する。値は標準入力から渡し、コマンド履歴やログに残さない。
   - `printf '%s' "$SERVICE_ROLE" | npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY`
   - 決済: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
6. `npm run deploy` → 表示された URL を控える。
7. マイグレーション: 接続文字列で `npx supabase db push --db-url "<接続文字列>"`、または `https://<URL>/admin/setup` のフォームに貼る。
8. `curl https://<URL>/admin/setup/status.json` で `next` が `owner` になっていることを確認する。
9. 運営者登録（メール・パスワード）は **利用者自身に** `https://<URL>/admin/setup` で行ってもらう。AI がパスワードを決めない。
10. 決済を使う場合、Stripe の Webhook エンドポイント `https://<URL>/webhooks/stripe` を登録し、管理画面 → プラグイン → Stripe 決済を有効にするよう案内する。

## 終わったら

- 受け取った Cloudflare API トークンは失効を促す。
- 接続文字列・各キーをファイルに保存していないか確認する（wrangler.jsonc の `vars` 以外に残さない）。
