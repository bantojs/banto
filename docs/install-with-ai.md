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

リポジトリの `.claude/skills/install/SKILL.md` に、wrangler と Supabase CLI で導入する手順があります。
AI に渡すもの: Cloudflare の API トークン（Workers Scripts と R2 の編集権限）、Supabase の接続文字列、各キー。
渡したトークンは導入後に Cloudflare / Supabase の画面で失効してください。
