# テーマを GitHub から出す例

Liquid のテーマ（docs/themes.md）を GitHub のリポジトリで管理し、プルリクエストでプレビュー、`main` への push で公開する例です。
Banto に足すコードはありません。Banto の REST（`/api/v1/themes`）を、依存のない 1 ファイルの CLI（`cli/banto-theme.mjs`）で呼ぶだけです。

## リポジトリの並び

```
.banto/banto-theme.mjs          Banto の cli/banto-theme.mjs を写したもの
.github/workflows/banto-theme.yml   この例のワークフロー
theme/layout/theme.liquid       テーマ（layout・templates・sections・snippets・config・locales・assets）
theme/...
```

## 用意するもの

1. ショップに **独自ドメイン** があり、Banto が **Workers の有料プラン（または Node）** で動いていること（docs/themes.md「使える条件」）。
2. 管理画面 → ショップ → **AI 連携** でトークンを 2 つ発行します（発行する人に「デザイン（テーマ）」の項目が要ります）。
   - プレビュー用: `theme:write`
   - 公開用: `theme:write` と `theme:publish`
3. リポジトリの Settings → Secrets and variables → Actions に置きます。
   - 変数 `BANTO_URL`（Banto の URL = 管理画面を開く URL。例 `https://banto.example.com`。AI 用 API はショップの独自ドメインでは開きません）
   - 秘密 `BANTO_TOKEN_PREVIEW`・`BANTO_TOKEN_PUBLISH`
4. 公開用のトークンは GitHub の Environment（例の `production`）に置き、承認者を付けると、`main` に入っても人が承認するまで公開されません。

## 気をつけること

- テーマの JS はお店の画面で動きます。`theme:write` のトークンでも、プレビューのリンクを開いた人の画面では動くので、リポジトリに書ける人 = テーマを書ける人です。
- フォークからのプルリクエストでは秘密を渡さない（例の `if:` で止めています）。
- 版は 1 つのショップに 20 までです。例ではプレビューのたびに `prune --keep 10` で古い版を消しています。
- 公開・取り下げ・プレビューを開いたことは、Banto の監査ログ（組織 → 監査ログ）にトークンの名前で残ります。
