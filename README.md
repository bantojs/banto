# Banto（番頭）

**自分の Cloudflare と Supabase で動かす、手数料ゼロのセルフホスト型 EC プラットフォーム。**

> ⚠️ 本ソフトウェアは MIT ライセンスのもと「現状のまま（AS IS）」無保証で提供されます。
> 稼働・データ保全・法令対応の責任はすべて運営者にあります。
> 開発チームはホスティングを行わず、どのデプロイのデータにもアクセスできません。

## これは何か

- 商品・在庫・注文を管理し、Hono SSR のストアフロントとヘッドレス API を提供します
- 決済は運営者自身の Stripe / KOMOJU アカウントに接続します。カード情報は通過しません。送料（都道府県別・無料ライン）、税込表示、注文確認メール、キャンセル返金、会員機能（任意）を備えます
- インフラは運営者自身の Cloudflare Workers / R2 と Supabase。小規模なら無料枠で動きます
  （Cloudflare の代わりに Node.js で動かす: docs/run-on-node.md。Supabase の代わりに自前の PostgreSQL を使う: docs/self-hosted-db.md）
- プラグインは Webhook（hooks）とヘッドレス API 経由。コアにコードを読み込みません

## 誰向けか

**レンタルサーバーに WordPress を入れて運用できる人** を想定しています。ターミナルやコマンドは使いません。
無料アカウントを3つ（GitHub・Cloudflare・Supabase）作り、ボタンを押して、画面の指示どおりに値を貼れば動きます。
Web 制作会社・フリーランスがクライアントのアカウントにデプロイして納品する使い方にも向いています。

## 導入

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bantojs/banto)

1. Supabase でプロジェクトを作り、URL とキーを控える
2. 上のボタンで自分の Cloudflare アカウントにデプロイし、Cloudflare の画面で値を3つ貼る（フォークや非公開リポジトリから入れる場合は Workers & Pages の「リポジトリをインポート」。docs/setup.md §2-B）
3. `https://<ショップの URL>/admin/setup` を開き、画面の指示に従う（データベースの準備・運営者登録・ショップ作成）
4. Stripe のキーを貼り、プラグインで「Stripe 決済」を有効にする

所要 30〜40 分。詳しい手順（画面の場所つき）は [docs/setup.md](docs/setup.md)。

**いくらかかる？** 月数百件までは各社の無料枠に収まり、費用はほぼ決済手数料だけです。注文数・アクセス数から月額を見積もる [運用費用試算ページ](docs/cost-estimator.html)（リポジトリを ZIP でダウンロードしてブラウザで開くか、GitHub Pages で `/docs` を公開して URL で配れます）と、前提をまとめた [docs/cost.md](docs/cost.md) を用意しています。

## AI と一緒に使う

- **導入を AI に手伝ってもらう**: [docs/install-with-ai.md](docs/install-with-ai.md) の台本を Claude / ChatGPT に貼るだけ
- **AI で商品・注文・集計を操作する**: 管理画面で AI 用トークンを発行し、MCP（`/mcp`）または REST（`/api/v1`）でつなぐ。エンドポイントの一覧は [docs/api.md](docs/api.md)、設計と権限の考え方は [docs/ai-access.md](docs/ai-access.md)
- **AI エージェント向けの案内**: [AGENTS.md](AGENTS.md)

## English UI

Set the `BANTO_LOCALE` variable to `en` (Cloudflare → Workers & Pages → banto → Settings → Variables and Secrets) and the admin screens, storefront and emails switch to English. The default is Japanese. Strings live in `src/i18n/`.

## クイックスタート（開発者向け）

```bash
git clone https://github.com/bantojs/banto
cd banto
npm install
cp .dev.vars.example .dev.vars   # service_role キーを貼る。SUPABASE_URL 等は wrangler.jsonc の vars
npx supabase start          # ローカル Supabase
npx supabase db reset       # migrations 適用
npm run dev                 # http://localhost:8787
```

初回アクセスでセットアップウィザードが起動します。詳細は [docs/setup.md](docs/setup.md)。

### テスト

```bash
npm run lint                 # 型チェック
npm test                     # 単体テスト（DB テストは BANTO_TEST_DB_URL が無ければスキップ）
npm run test:db              # ローカル Supabase（npx supabase start）に向けて RLS / 在庫 RPC のテスト
npm run check:rls            # 全テーブルの RLS 有効化を検査
```

DB テストは素の PostgreSQL 16 でも動きます（`supabase/test/auth_shim.sql` が auth スキーマを補う）。
CI はこの方式で回しています。

## ドキュメント

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 設計書
- [docs/ROADMAP.md](docs/ROADMAP.md) — 開発ロードマップ
- [docs/cost.md](docs/cost.md) — 運用費用の目安（[試算ページ](docs/cost-estimator.html)）
- **API の入口**: [docs/api.md](docs/api.md) — 公開 API / AI 用 API / hooks の使い分けと共通の決まり、エンドポイントの一覧
- プラグインを作る: [docs/hooks.md](docs/hooks.md)（仕様）と [examples/plugin-slack](examples/plugin-slack/)（Slack 通知の実例）
- 運用ガイド: [docs/backup.md](docs/backup.md)（バックアップと復元）/ [docs/email.md](docs/email.md)（メールの到達性）/ [docs/monitoring.md](docs/monitoring.md)（死活監視）/ [docs/hardening.md](docs/hardening.md)（WAF・レート制限・管理画面の保護）
- [CLAUDE.md](CLAUDE.md) — 開発規約（AI エージェント向けの判断基準。人間にも有効）
- [docs/knowledge/](docs/knowledge/README.md) — 開発に参加する人向けのナレッジ（設計判断・実機の落とし穴・コードの地図）。参加の手引きは [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md) — 脆弱性報告

## ライセンス

MIT — 第三者がホスティング版を提供することも歓迎します。
