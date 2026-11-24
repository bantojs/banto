---
name: install
description: Banto をコマンドラインから導入する（wrangler）。Claude Code 等、シェルが使える AI エージェント向け。秘密の値は AI が受け取らず、利用者が自分で入れる。
---

# Banto の導入（CLI）

前提: Node.js 22、`npx wrangler` が使えること。

## AI が受け取ってよいもの・受け取らないもの

受け取ってよいもの（これだけ）:

- **Cloudflare の API トークン**（`CLOUDFLARE_API_TOKEN`）。利用者に、次の条件で作ってもらう（Cloudflare の My Profile → API Tokens → Create Token）。
  - 権限は **Workers Scripts:Edit・Workers R2 Storage:Edit・Account Settings:Read** の 3 つだけ
  - **Account Resources は導入するアカウント 1 つだけ** に絞る
  - **TTL（有効期間）の終了日を今日か明日にする**
  - チャットに貼るより、AI を起動する前に利用者のターミナルで `export CLOUDFLARE_API_TOKEN=...` しておいてもらうほうがよい（チャットの記録に残らない）。貼られた場合も、短い有効期間と手順の最後の削除で守る。
- **Cloudflare のアカウント ID**（`CLOUDFLARE_ACCOUNT_ID`）。秘密ではない（Cloudflare の画面の右側に出ている）。
  - そのアカウントに **workers.dev のサブドメイン** がすでにあること（無いと wrangler が途中で聞いてくる。Workers & Pages の画面を一度開けば作れる）。

**受け取らないもの**（利用者に聞かない。チャットに貼られたら使わず、その値を作り直してもらう）:

- Supabase の Secret key（`sb_secret_…`）・service_role キー
- データベースの接続文字列（パスワードを含む）
- Supabase のアクセストークン（`sbp_…`）
- `SESSION_SECRET`、Stripe のシークレットキー・Webhook の署名シークレット、そのほかの決済の秘密

Supabase の Project URL と Publishable key は秘密ではないが、利用者が手順 6 で Cloudflare の画面に自分で入れるので、AI は受け取らなくてよい。

## 「AI が秘密を見ない」ための約束

秘密は Cloudflare の中にだけ置かれ、AI はそれを読む道を持たない。ただしこれは **AI がコードを変えないこと** が前提になる。

- AI は `src/` や `scripts/`（デプロイの仕組み）、`wrangler.jsonc` を書き換えない。
- AI は `.dev.vars` を読まない・作らない。`wrangler secret bulk`・`wrangler tail`（ログの中継）を実行しない。
- 利用者は、最初のデプロイの前に自分の fork で `git status` と `git diff` を見て、何も書き換えられていないことを確かめる。
- Secret は Cloudflare のトークンが生きているあいだに入れる。トークンは短い有効期間にし、AI の作業が終わったらすぐ削除する（手順の最後）。

## 手順

1. `git clone https://github.com/<利用者>/banto && cd banto && npm ci`（利用者の fork を使う）。
2. `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を環境変数で渡し、`npx wrangler whoami` でトークンが有効か確かめる（トークンをファイルに書かない）。
3. 利用者に `git status` / `git diff` で何も変わっていないことを確かめてもらう。
4. `npm run deploy` → 表示された URL（`https://banto.<サブドメイン>.workers.dev` など）を控える。R2 のバケット（`banto-media`・`banto-private`）は、無ければデプロイのときに作られる（`wrangler.jsonc` の `r2_buckets`）。
   - ここまでで AI の Cloudflare の作業は終わり。**ここで利用者に Cloudflare の API トークンを削除してもらってよい**（手順 6 を画面で行う場合）。
5. 利用者に `https://<URL>/admin/setup` を開いてもらう。AI は `curl https://<URL>/admin/setup/status.json` で足りないものを確かめる（JSON に秘密は含まれない）。
6. **Cloudflare の変数とシークレット（利用者が入れる）**。docs/setup.md §3 のとおり、Cloudflare の画面の **Workers & Pages → banto → 設定（Settings）→ 変数とシークレット（Variables and Secrets）→ 追加** で入れる。
   - `SUPABASE_URL`（テキスト）= Supabase の Project URL
   - `SUPABASE_ANON_KEY`（テキスト）= Publishable key（`sb_publishable_…`）
   - `SUPABASE_SERVICE_ROLE_KEY`（**シークレット**）= Secret key（`sb_secret_…`）
   - 公開してよい値（URL・Publishable key）も、この画面の 1 か所だけに入れる。`wrangler.jsonc` に `vars` は書かない（`keep_vars` で画面の値が残る。両方に書くと、デプロイのたびに `wrangler.jsonc` の値で上書きされる）。
7. **`SESSION_SECRET`（利用者が入れる）**。セットアップ画面の「環境変数と Secret」に、作られた値が出るので、それをコピーして手順 6 と同じ画面に **シークレット** で追加する。自分で作るなら、利用者のターミナルで `openssl rand -base64 32`。
   - 画面の代わりに **利用者自身のターミナル**（AI が動いているシェルではない）で入れてもよい。
     - `cd banto`（手順 1 の fork）してから、`npx wrangler login`（または利用者自身のトークンを `export CLOUDFLARE_API_TOKEN=...`。手順 2 の制限つきのトークンでも入れられる）。
     - `npx wrangler secret put SESSION_SECRET`（聞かれたら値を貼る。画面に出ず、履歴にも残らない）。ほかの Secret も同じ。
     - Worker の名前を変えている（ビルドの変数 `BANTO_WORKER_NAME`）ときは `--name <Worker名>` を付ける。
   - 入れたら `status.json` の `env.missing` が空になったか AI が確かめる。名前が出たままなら、足りないか、値を取り違えている（Publishable key と Secret key の入れ違いなど）。取り違えのときは値を入れ直す。
8. **マイグレーションは利用者がセットアップ画面で当てる**（docs/setup.md §4-2）。
   - 利用者が Supabase の **Account preferences → Access Tokens** でトークンを作る。権限は **Database だけ Full access**、ほかは No access。
   - そのトークンを、利用者がセットアップ画面に直接貼って **適用する** を押す。トークンは HTTPS で Supabase に送られ、Banto は保存しない。
   - AI は接続文字列で `supabase db push --db-url` を実行しない。
   - 終わったら `status.json` の `next` が `owner` になっていることを確かめる。
9. 運営者登録（メール・パスワード）は **利用者自身に** `https://<URL>/admin/setup` で行ってもらう。AI がパスワードを決めない（登録が終わると `status.json` は 404 になる）。
10. 決済を使う場合（docs/setup.md §5）:
    - Stripe の Webhook エンドポイント `https://<URL>/webhooks/stripe` の登録を案内する。
    - `STRIPE_SECRET_KEY` と `STRIPE_WEBHOOK_SECRET` は、手順 6・7 と同じく利用者が入れる。
    - 管理画面 → プラグイン → Stripe 決済を有効にするよう案内する。

## 終わったら（必ず行う）

順番:

1. **Cloudflare の API トークンを削除** してもらう（My Profile → API Tokens）。手順 4 の後（AI の Cloudflare の作業が終わった時点）で削除するのがいちばんよい。遅くとも、利用者がターミナルで Secret を入れ終えたらすぐ。TTL で切れる場合も削除する。
2. 手順 8 で作った **Supabase のアクセストークンを削除** してもらう（Account preferences → Access Tokens）。
3. 秘密がどこにも残っていないか確かめる。
   - 利用者の fork で `git status` と `git diff` を見て、何も書き換えられていないこと（`wrangler.jsonc` に `vars` が足されていない・`.dev.vars` などのファイルが無い）。
   - AI のシェルで秘密を引数や環境変数に入れていないこと（シェルの履歴に残らない）。
   - チャットに秘密が貼られていたら、その値を作り直してもらう（Supabase の Secret key は Supabase の画面で、Stripe のキーは Stripe の画面で）。
