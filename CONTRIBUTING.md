# Banto に参加する

Banto に興味を持ってくださってありがとうございます。issue・PR・ドキュメントの直しを歓迎します。
脆弱性は issue に書かず、SECURITY.md の窓口から知らせてください。

## 最初に読むもの

| 読みたいこと | ファイル |
| --- | --- |
| 守る規約（絶対に守る制約・技術スタック・コーディング規約） | CLAUDE.md |
| 設計の全体 | docs/ARCHITECTURE.md、docs/ROADMAP.md |
| 設計の理由・実機の落とし穴・コードの地図 | docs/knowledge/README.md |
| AI エージェントで開発するとき | AGENTS.md |

大きな設計の変更（新しい外部依存、コアに機能を足す、テナントモデルや RLS の経路を変える）は、先に issue で相談してください。
機能をコア / 同梱モジュール / 外部プラグインのどこに置くかの判定基準は CLAUDE.md §7 にあります。

## 1 サイクル

```bash
npm install
npm run lint                 # gen-migrations --check + tsc（src と test）
npx vitest run               # DB テストは BANTO_TEST_DB_URL が無いとスキップ
BANTO_TEST_DB_URL=postgres://postgres@127.0.0.1:5432/banto_test npx vitest run   # 実 PostgreSQL 込み（推奨）
npm run build:workers        # wrangler の dry-run。Cloudflare 固有の型の漏れを検出
npm run build:node && npm run smoke:node   # 可搬性（Node で起動できるか）
BANTO_TEST_DB_URL=... npm run check:rls    # 全テーブルの RLS・関数の権限
npm run check:size           # Worker の圧縮後サイズ（上限 1 MiB）
```

マイグレーションを足したら `node scripts/gen-migrations.mjs`（`src/db/migrations.generated.ts` を更新。lint が差分を検査する）。埋め込むのは `--` の注釈と字下げを外した SQL（`scripts/sql-strip.mjs`、Worker の大きさのため）で、DB のテストもこの SQL を当てる。`/* */` の注釈は使わない（生成が止まる）。
マイグレーションは前方専用です（ロールバック用は書かない）。

## 実 PostgreSQL でテストする

RLS と RPC のテストは実 PostgreSQL に向けて流します。素の `postgres:16` で足ります（CI もこれ）。
テストが `supabase/test/auth_shim.sql`（Supabase の auth スキーマの最小再現）と全マイグレーションを自分で適用します。

```bash
docker run -d --name banto-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 5432:5432 postgres:16
createdb -h 127.0.0.1 -U postgres banto_test
BANTO_TEST_DB_URL=postgres://postgres@127.0.0.1:5432/banto_test npx vitest run
```

Supabase CLI がある環境なら `npx supabase start` のあと `npm run test:db`（54322）でも同じテストが通ります。

## コミットと PR

- Conventional Commits（`feat:` `fix:` `docs:` `chore:`）。本文に「何を・なぜ」。
- ブランチの名前もコミットの種類から始めます: `feat/<短い名前>`・`fix/…`・`docs/…`・`chore/…`（例: `feat/page-media-thumb`、`chore/v0.5.0`）。道具の名前や人の名前（`claude/…` など）は付けません。
- PR には、通したコマンド（lint / test / build:workers / check:rls）と、依存を足したときは Worker の追加サイズを書いてください。
- UI の文言は `src/i18n/ja.ts` を正とし、`en.ts` に同じキーで英訳を置きます。

## ドキュメントの置き場

| 読者 | ファイル |
| --- | --- |
| 導入する運営者 | docs/setup.md（画面の場所つき）、docs/env.md、docs/email.md、docs/backup.md、docs/monitoring.md、docs/hardening.md、docs/custom-domain.md、docs/cost.md + cost-estimator.html |
| プラグイン作者 | docs/hooks.md、docs/plugins.md、examples/ |
| AI クライアント | docs/ai-access.md、docs/install-with-ai.md、AGENTS.md、.claude/skills/install |
| 開発者 | CLAUDE.md、docs/ARCHITECTURE.md、docs/ROADMAP.md、docs/run-on-node.md、docs/knowledge/、ここ |

実機で新しい落とし穴が分かったら docs/knowledge/03-pitfalls.md に、設計を決めたら docs/knowledge/02-decisions.md に、日付を添えて書いてください。

## 行動規範

CODE_OF_CONDUCT.md に従ってください。
