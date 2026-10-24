# 死活監視（止まっていることに気づく）

Banto はあなたの Cloudflare と Supabase で動くので、止まっても誰も教えてくれません。
無料の外部監視サービスに 5 分ごとに見てもらい、止まったらメール / LINE / Slack で知らせる設定をしておきます。

## 1. 何を見るか

| URL | 返すもの | 意味 |
| --- | --- | --- |
| `https://<ショップ>/health` | `{"ok":true,"checks":{"db":"ok","cron":"ok"}}`（HTTP 200） | Worker が動き、Supabase にも届き、Cron も 15 分以内に動いた |
| 同上 | `{"ok":false,"checks":{"db":"error",...}}`（HTTP 503） | Worker は動くが Supabase が応答しない（一時停止・障害・キー変更） |
| 同上 | `{"ok":false,"checks":{"db":"ok","cron":"stale"}}`（HTTP 503） | Cron が 15 分以上動いていない（在庫予約の解放・メール送信・hooks の再送が止まっている） |
| 同上 | `"cron":"unknown"` | Cron がまだ一度も動いていない（デプロイ直後）か、`0006_ops` マイグレーションが未適用 |
| `https://<ショップ>/<スラッグ>` | ショップのトップ（HTTP 200） | 公開ページが見える（公開停止やテーマの不具合も拾える） |

`/health` は DB の確認結果を 30 秒キャッシュするので、監視サービスが 1 分ごとに叩いても Supabase の負荷にはなりません。
秘密情報や接続先は返しません。

## 2. UptimeRobot で設定する（無料・5 分間隔）

1. [UptimeRobot](https://uptimerobot.com/) にサインアップ（無料: 50 モニター、5 分間隔）
2. **Add New Monitor**
   - Monitor Type: **HTTP(s)**
   - Friendly Name: `banto health`
   - URL: `https://<ショップ>/health`
   - Monitoring Interval: 5 minutes
3. もう 1 つ **Keyword** 型で、URL `https://<ショップ>/health`、Keyword `"ok":true`、Alert when **keyword not exists** にすると、200 を返しながら DB が落ちているケース（503 でなく `ok:false`）も拾えます
4. **Alert Contacts** にメール（と、あれば Slack / Telegram）を登録

Better Stack、Cronitor、Pingdom などでも同じ URL とキーワードで設定できます。

## 3. 止まったときの切り分け

| `/health` の結果 | 見るところ |
| --- | --- |
| タイムアウト・接続できない | Cloudflare の障害（[cloudflarestatus.com](https://www.cloudflarestatus.com/)）、ドメインの DNS、Workers の **無料枠（1 日 10 万リクエスト）超過**（Cloudflare → Workers & Pages → banto → メトリクス。超過するとその日は 1 日中エラーになる） |
| 503 / `"db":"error"` | Supabase の画面でプロジェクトが **Paused** になっていないか（無料プランは 1 週間アクセスが無いと停止。Banto の Cron が叩くので通常は起きないが、Cron が止まると起きる）、[status.supabase.com](https://status.supabase.com/)、`SUPABASE_URL` / `SUPABASE_ANON_KEY` を変えていないか |
| 200 だがショップページが 500 | Cloudflare → Workers & Pages → banto → **ログ**（リアルタイムログ）。`[banto]` で始まる行にエラーの要約が出る |
| 200 だが注文が入らない | 決済側。Stripe → 開発者 → Webhook の配信失敗、KOMOJU の Webhook ログ。Stripe は失敗が続くとメールで知らせてくれる |

## 4. Cron（在庫予約の解放・メール送信）が動いているか

5 分ごとの Cron が止まると、未決済の在庫予約が戻らず、注文メールと hooks の再送も止まります。
Cron は毎回の最後に `banto_heartbeats` に時刻を書き、`/health` がその経過時間を見て `cron` を判定します（15 分以上で `stale` → 503）。
途中のジョブが失敗すると時刻が進まないので、「動いてはいるがエラーで落ちている」も同じく拾えます。原因は次で確認します。

- Cloudflare → Workers & Pages → banto → **設定 → トリガー → Cron トリガー** に `*/5 * * * *` があること
- **メトリクス** の「Cron」タブで直近の実行と失敗数を見る
- 管理画面 → 連携（hooks）→ 配信履歴で、`pending` のまま古い配信が溜まっていれば Cron が動いていない

## 5. 使用量のアラート

- **Cloudflare**: 無料枠の 1 日 10 万リクエストに近づいたら、Workers Paid（$5/月）に切り替える。目安は [運用費用試算](cost-estimator.html)。Cloudflare → 通知（Notifications）で「Workers の使用量」の通知を作れます
- **Supabase**: Project Settings → **Usage** でデータベース容量と転送量。無料枠の 80% を超えたらメールが来ます
- **Resend**: Dashboard の使用量。無料枠は月 3,000 通・日 100 通

## 6. 何もしなくても届く通知

- Stripe: Webhook の配信失敗が続くとメール
- Supabase: 無料プロジェクトの一時停止予告、使用量超過
- Cloudflare: 請求、Workers のエラー率（通知を設定した場合）
- GitHub: フォークに Banto の新しいリリースが出たとき（Watch → Releases をオンにした場合）。管理画面の **アップデート** にも出ます
