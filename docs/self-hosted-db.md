# 自前の PostgreSQL で動かす（Supabase を使わない）

Banto の DB は、Supabase の中身と同じ 3 つの部品で動きます。Supabase を使わずに、自社の VPS などに自分で立てられます。

| 部品 | 役目 | Supabase での名前 |
| --- | --- | --- |
| PostgreSQL 16 | データ・RLS（行の権限）・在庫などの SQL 関数 | Database |
| PostgREST | Banto が DB を読み書きする HTTP の口 | `/rest/v1`（Data API） |
| GoTrue | 運営者・スタッフのログイン（会員のログインは Banto が自前で持つ） | `/auth/v1`（Auth） |

`selfhost/` に、この 3 つと HTTPS の入口（Caddy）をまとめた docker compose があります。

> **向いている人**: Docker と Linux サーバーを自分で運用できる人。
> そうでなければ Supabase の無料枠をおすすめします（docs/setup.md）。バックアップ・更新・監視・セキュリティ対策は、すべて自分で行うことになります。
>
> この構成は、開発時に docker compose で立てて、セットアップ → 運営者の作成 → ログイン → ショップと商品の登録 → お店の画面 → カート → AI 用 API → 定期処理まで動くことを確かめています（2026-10-20）。本番での常用実績はまだありません。

## 構成を選ぶ

`selfhost/.env` の `GATEWAY_MODE` で選びます。

| | `app`（おすすめ） | `api` |
| --- | --- | --- |
| Banto 本体 | **この VPS** で Node 版を動かす（compose の `banto`） | Cloudflare Workers |
| 外に出すもの | お店の画面だけ（`SHOP_DOMAIN`） | DB の口（`API_DOMAIN` の `/rest/v1` と `/auth/v1`） |
| DB の口 | compose の中だけ（外から届かない） | インターネットに出る（JWT と RLS で守る） |
| マイグレーション | セットアップ・アップデートの画面から | コマンド（`docker compose --profile tools run --rm migrate`） |
| 画像 | VPS のディスク（`MEDIA_DIR`）か S3 互換（docs/run-on-node.md §5） | R2 |

`app` のほうが守りやすく（DB の口を外に出さない）、手順もアップデートも画面で済みます。
`api` は「Workers の無料枠と R2 は使い続けたいが、データは自分のサーバーに置きたい」ときに使います。

## 1. 準備

- Docker と docker compose（v2）が入った Linux サーバー（メモリ 2GB 以上を目安）
- ドメイン（`app` ならお店の、`api` なら DB の口の）。A レコードをこのサーバーに向けておく。証明書は Caddy が自動で取ります
- 80 番と 443 番だけを開ける（5432 は開けない）

```bash
git clone https://github.com/bantojs/banto.git
cd banto/selfhost
node make-keys.mjs > keys.txt     # Node が無ければ: docker run --rm -v "$PWD":/w -w /w node:22-alpine node make-keys.mjs
cp .env.example .env
```

`.env` にドメインを書き、`keys.txt` の中身（`JWT_SECRET` から `SESSION_SECRET` まで）を貼ります。`keys.txt` は消してください。

- `JWT_SECRET` … PostgREST と GoTrue が共有する署名の秘密。`ANON_KEY` と `SERVICE_ROLE_KEY` はこれで署名した鍵です（Supabase の画面で見る 2 つの鍵の代わり）
- `SERVICE_ROLE_KEY` … **RLS を素通りする鍵**。Banto の設定（Secret）と `.env` 以外に置かない
- `.env` はリポジトリに入れない（`.gitignore` 済み）

## 2-A. `app`: この VPS で Banto も動かす

```bash
docker compose --profile app up -d --build
```

Stripe・メールなどの設定は `selfhost/banto.env` に書きます（docs/env.md・docs/run-on-node.md §2 と同じ名前。`SUPABASE_*` と `SESSION_SECRET` は compose が入れるので書かない）。

`https://<SHOP_DOMAIN>/admin/setup` を開き、画面の手順どおりに進めます。
マイグレーションの手順では「接続文字列で」を開き、次を貼ります（パスワードは `.env` の `POSTGRES_PASSWORD`）。

```
postgres://postgres:<POSTGRES_PASSWORD>@db:5432/banto?sslmode=disable
```

compose の中の通信なので TLS は使いません（`sslmode=disable`）。接続先 `db` は compose が `DB_MIGRATION_HOSTS=db` で許可しています。
アップデートのあとも `/admin/update` から同じ接続文字列で当てます。

## 2-B. `api`: Banto は Cloudflare Workers

```bash
docker compose up -d                                   # db / rest / auth / gateway
docker compose --profile tools run --rm migrate        # マイグレーションを当てる
```

Workers の設定（docs/setup.md）では、Supabase の値の代わりに次を入れます。

| Workers の設定 | 値 |
| --- | --- |
| `SUPABASE_URL` | `https://<API_DOMAIN>`（`.env` の `PUBLIC_API_URL` と同じ） |
| `SUPABASE_ANON_KEY` | `.env` の `ANON_KEY` |
| `SUPABASE_SERVICE_ROLE_KEY`（Secret） | `.env` の `SERVICE_ROLE_KEY` |
| `SESSION_SECRET`（Secret） | `.env` の `SESSION_SECRET` |

セットアップの画面は、マイグレーションが当たっていれば運営者の作成から始まります。

**アップデートのたび**に、Workers に出したのと同じ版のリポジトリで `migrate` を流してください（Workers からは VPS の DB に直接つながないため。CLAUDE.md §1-8）。

```bash
git pull && git checkout v0.x.y     # Workers と同じ版
docker compose --profile tools run --rm --build migrate
```

## 3. 運用

- **バックアップ**: `docker compose exec db pg_dump -U postgres -Fc banto > banto-$(date +%F).dump` を毎日（cron など）。復元は `pg_restore`。管理画面の JSON 書き出し（docs/backup.md）も併用できます
- **更新**: PostgREST・GoTrue・PostgreSQL のイメージは版を固定しています。上げるときは各プロジェクトのリリースノートを読み、バックアップを取ってから
- **監視**: `https://<お店>/health`（docs/monitoring.md）
- **既存の PostgreSQL を使う**: `selfhost/initdb/00-roles.sh` を環境変数付きで流し（ファイルの先頭に書き方）、GoTrue を一度起動してから、マイグレーションを当てます。順番が大事です（Banto のマイグレーションは GoTrue が作る `auth.users` などを参照します）

## Supabase から移る・Supabase へ戻る

中身は同じ PostgreSQL なので、`pg_dump` / `pg_restore` で移せます。`auth` スキーマ（運営者のアカウント）も一緒に移してください。
移したら `SUPABASE_URL` と鍵を新しい方に向けます。鍵の署名の秘密が変わるので、ログイン中の運営者は一度ログインし直しになります。

## 仕組み（開発者向け）

- `selfhost/initdb/00-roles.sh`: Supabase が用意するロール（`anon` / `authenticated` / `service_role`、PostgREST が接続する `authenticator`）と、GoTrue が使う `supabase_auth_admin` と `auth` スキーマ、public の既定の権限（Supabase と同じ）、マイグレーションのあとに PostgREST に表を読み直させるイベントトリガー。テスト用の `supabase/test/auth_shim.sql` と違い、`auth.uid()` などは GoTrue が作ります
- GoTrue は `GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated` が要ります（無いとログインした人のトークンの role が空になり、PostgREST が `role "" does not exist` で断る）
- PostgREST は `PGRST_DB_MAX_ROWS=1000`（Supabase と同じ上限。Banto はそれを前提にページを送る）
- マイグレーションの接続先は `DB_MIGRATION_HOSTS` で許可したホストだけ（`src/db/migrate.ts`。画面からは足せない）。コマンドの `migrate`（`src/entry/migrate.ts`）は運営者が自分で打つので絞らない
