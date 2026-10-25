# Node.js で動かす（脱出経路）

Banto の既定は Cloudflare Workers ですが、API と SSR の本体はランタイムに依存しません。
Cloudflare から移りたくなったとき、あるいは自社サーバーや VPS で動かしたいときは、この手順で Node.js 上で動かせます。
DB は引き続き Supabase（または `pg_dump` で移した PostgreSQL + PostgREST + GoTrue）です。

> この経路は CI で毎回ビルドと起動確認をしています（`npm run build:node` と `npm run smoke:node`）。
> 本番での常用実績はまだありません。Cloudflare を離れると R2 のエグレス無料は使えなくなります。

## 1. ビルド

```bash
npm ci
npm run build:node        # tsc（可搬性チェック）+ esbuild → dist/node/server.js
```

## 2. 環境変数

Workers の `[vars]` と Secret に相当するものを、すべて環境変数で渡します。

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `PORT` / `HOST` | - | 既定 8787 / 0.0.0.0 |
| `PUBLIC_BASE_URL` | 必須（無ければ起動しない） | 外から見た URL（例 `https://shop.example`）。Stripe のコールバック・メールのリンク・OAuth の戻り先の起点。リクエストの Host ヘッダーは使いません（偽装されると会員のログインのリンクを攻撃者のサイトに届けられるため）。`https://` なら、TLS を終端するプロキシの後ろでも Cookie に `Secure`、応答に HSTS が付き、フォームの CSRF 検査も https の Origin を自分とみなします |
| `CLIENT_IP_HEADER` | - | 回数の制限に使う IP のヘッダー。Node の既定は `x-forwarded-for`（前段のプロキシが足す値）。**プロキシを置かずに直接公開する構成では、依頼側がこのヘッダーを書けるので、IP ごとの上限が効きません**。必ずリバースプロキシの後ろに置いてください |
| `TRUSTED_PROXY_HOPS` | - | `x-forwarded-for` の末尾から何段目を利用者の IP とみなすか（既定 1）。CDN + リバースプロキシの 2 段なら 2 |
| `MEDIA_BASE_URL` | - | 画像の公開 URL の起点。省略時は `PUBLIC_BASE_URL/media`（アプリが配信） |
| `SUPABASE_URL` `SUPABASE_ANON_KEY` `SUPABASE_SERVICE_ROLE_KEY` `SESSION_SECRET` | 必須 | docs/setup.md と同じ |
| `STRIPE_CLIENT_ID` `STRIPE_SECRET_KEY` `STRIPE_WEBHOOK_SECRET` | 決済時 | 同上 |
| `LINE_CHANNEL_ACCESS_TOKEN` `KOMOJU_SECRET_KEY` `KOMOJU_WEBHOOK_SECRET` | 任意 | docs/plugins.md |
| `MAIL_TRANSPORT` と送り手の値（`RESEND_API_KEY` / `SMTP_HOST` ほか / `SENDGRID_API_KEY` / `SES_*`） | メールを送るなら | docs/email.md §1。Node でも SMTP は `node:net` / `node:tls` で直接つなぐ（25 番は多くのホスティングが塞いでいるので 587 か 465） |
| `MEDIA_DIR` | - | 画像をローカルに保存するディレクトリ（既定 `./data/media`）。S3 を使わない場合 |
| `S3_ENDPOINT` `S3_REGION` `S3_BUCKET` `S3_ACCESS_KEY_ID` `S3_SECRET_ACCESS_KEY` `S3_PATH_STYLE` | - | S3 互換ストレージ（後述）。`S3_ENDPOINT` があれば `MEDIA_DIR` より優先 |
| `CRON_INTERVAL_SECONDS` | - | 定期処理（予約解放・hooks 配信・個人情報マスク）の間隔。既定 300。`0` で無効 |
| `MASK_ORDERS_AFTER_DAYS` | - | 既定 180 |
| `AUDIT_LOG_KEEP_DAYS` | - | 監査ログの保持日数。既定 365 |

## 3. 起動

```bash
PORT=8787 PUBLIC_BASE_URL=https://shop.example SUPABASE_URL=... node dist/node/server.js
```

systemd や PM2 で常駐させ、前段に Caddy / nginx で TLS を終端してください。

## 4. Docker

```bash
docker build -t banto .
docker run -p 8787:8787 -v banto-data:/app/data \
  -e PUBLIC_BASE_URL=https://shop.example \
  -e SUPABASE_URL=... -e SUPABASE_ANON_KEY=... -e SUPABASE_SERVICE_ROLE_KEY=... -e SESSION_SECRET=... \
  banto
```

`/app/data` に画像が保存されます（`MEDIA_DIR` の既定）。

## 5. 画像ストレージ

| 方式 | 設定 | 向き |
| --- | --- | --- |
| ローカルディレクトリ | `MEDIA_DIR`（既定） | 1 台構成。バックアップは自前で |
| S3 互換 | `S3_ENDPOINT` ほか | 複数台・マネージドストレージ。AWS S3 / **Cloudflare R2 の S3 API** / Backblaze B2 / MinIO |

R2 を S3 API で使う例（Workers を離れても同じバケットを使い続けられます）:

```
S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=banto-media
S3_ACCESS_KEY_ID=...        # R2 の API トークン（S3 互換）
S3_SECRET_ACCESS_KEY=...
MEDIA_BASE_URL=https://media.shop.example   # バケットの公開ドメイン
```

画像 URL は `MEDIA_BASE_URL + キー` で組み立てるので、保存先を変えてもキーが同じならリンクは切れません（ARCHITECTURE.md「StorageAdapter」）。

## 6. 定期処理

Workers の Cron Trigger の代わりに、プロセス内の `setInterval` で同じジョブ（`src/jobs/`）を回します。
複数プロセスで動かす場合は 1 プロセスだけ `CRON_INTERVAL_SECONDS` を設定し、他は `0` にしてください
（hooks 配信はリースで二重配信を防ぎますが、無駄な負荷を避けるため）。

## 7. Supabase から離れる場合

Supabase は標準の PostgreSQL です。PostgreSQL・PostgREST・GoTrue（Supabase Auth 相当）を自前で立てれば、
`SUPABASE_URL` をその URL に向けるだけで動きます。docker compose 一式と手順は **docs/self-hosted-db.md**（`selfhost/`）。
