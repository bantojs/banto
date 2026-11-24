# AI に手伝ってもらって導入する

Claude や ChatGPT に、導入の付き添いをさせる方法です。AI は「次に何をするか」「どこに何を貼るか」を案内し、
あなたが貼った結果を `status.json` で確認しながら進めます。ターミナルは不要です。

## 使い方

1. 下の台本をコピーして、Claude / ChatGPT に貼ります。
2. 以後は AI の質問に答えながら進めます。キーなどの値は **AI に貼らず、AI が指示する画面に直接貼ってください**。
   AI に必要なのは「貼り終わった」という報告と、ショップの URL だけです。

## 台本（コピーして AI に貼る）

```
あなたは Banto（セルフホスト型ネットショップ、https://github.com/bantojs/banto）の導入を手伝うアシスタントです。
私はターミナルを使えません。ブラウザで画面を操作します。

手順書は https://github.com/bantojs/banto/blob/main/docs/setup.md です。これを読み、手順を1つずつ、
「どの画面の、どのボタンを押し、何を貼るか」の形で案内してください。一度に複数の手順を出さないでください。

ルール:
- 私にキーやパスワードを送らせないでください。値は私が自分の画面に直接貼ります。
- 手順2（Deploy ボタン）が終わってショップの URL が分かったら、私に URL を聞いてください。
- 以後は各手順の終わりに https://<ショップの URL>/admin/setup/status.json を私に開かせ、その JSON を貼らせて、
  何が未設定かを判断してから次の手順に進んでください（JSON に秘密は含まれません）。
- 運営者アカウントの登録（手順4-3）は私が自分で行います。登録が終わったら status.json は見られなくなるので、
  そこからは管理画面の表示を私に報告させて進めてください。
- 決済（Stripe）は手順5のとおり、API キー方式で案内してください。Stripe Connect は使いません。
- 分からないことは推測せず、手順書の該当箇所を示してください。

準備ができたら、手順0（アカウント作成）から始めてください。
```

## status.json の中身

```json
{
  "version": "0.0.1",
  "env": { "missing": ["SUPABASE_SERVICE_ROLE_KEY"], "ok": ["SUPABASE_URL", "SUPABASE_ANON_KEY"] },
  "db": { "status": "ok", "pending_migrations": ["0001_init", "0002_hooks", "0003_api"] },
  "owner": { "exists": false },
  "next": "migrate"
}
```

`next` は `env` → `migrate` → `owner` → `shop` → `done` の順に進みます。運営者が登録されると、このエンドポイントは 404 を返します
（それ以降の状態は、ログインした運営者だけが管理画面で見られます）。

## コマンドが使える AI（Claude Code など）に任せる場合

リポジトリの `.claude/skills/install/SKILL.md` に、wrangler で導入する手順があります。この場合も、**秘密の値は AI に渡しません**。

AI に渡すもの（これだけ）:

- Cloudflare の API トークン。権限は **Workers Scripts:Edit・Workers R2 Storage:Edit・Account Settings:Read** の 3 つだけにし、
  作るときに **TTL（有効期間）の終了日を今日か明日** にします（Cloudflare の My Profile → API Tokens → Create Token）。
- Supabase の Project URL と Publishable key（`sb_publishable_…`）。どちらも公開してよい値です。

AI に渡さないもの: Supabase の Secret key（`sb_secret_…`）、データベースの接続文字列、Supabase のアクセストークン（`sbp_…`）、
`SESSION_SECRET`、Stripe などの決済の秘密。これらは AI が示す場所に **あなたが直接** 入れます。

- Secret（`SUPABASE_SERVICE_ROLE_KEY`・`SESSION_SECRET`・`STRIPE_SECRET_KEY`・`STRIPE_WEBHOOK_SECRET`）は、Cloudflare の
  **Workers & Pages → banto → 設定 → 変数とシークレット** で追加するか、あなた自身のターミナル（AI が動いているものとは別）で
  `npx wrangler secret put <名前>` を打って貼ります（[setup.md の手順 3](setup.md#3-cloudflare-の画面で値を貼る)）。
- マイグレーションは、セットアップ画面（`/admin/setup`）に Supabase のアクセストークンを貼って当てます（[setup.md の手順 4](setup.md#4-セットアップ画面)）。
  AI は接続文字列を使いません。

導入が終わったら、**必ず** 次を行ってください。

1. Cloudflare の API トークンを削除する（My Profile → API Tokens）。
2. マイグレーションに使った Supabase のアクセストークンを削除する（Account preferences → Access Tokens）。
3. 秘密の値をチャットに貼ってしまった場合は、その値を作り直す（Supabase の Secret key は Supabase の画面で、Stripe のキーは Stripe の画面で）。
