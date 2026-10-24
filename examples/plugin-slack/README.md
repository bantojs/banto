# 外部プラグインの実例: Slack 通知

Banto の hooks を受け取って Slack に投稿する、最小の外部プラグインです。
**Banto 本体のコードは一切読み込まず**、docs/hooks.md の契約（マニフェスト・署名・再送）だけで動きます。
自分のプラグインを作るときの雛形にしてください。

| ファイル | 役割 |
| --- | --- |
| `src/plugin.ts` | 本体。`handleRequest(req, env, deps)` の 1 関数。ランタイムに依存しない |
| `src/index.ts` | Cloudflare Workers の入口（`fetch` を `handleRequest` に渡すだけ） |
| `wrangler.toml` | Workers の設定 |
| `../../test/plugin-example.test.ts` | Banto 本体の署名実装と突き合わせるテスト（本体のリポジトリで `npm test`） |

## 何をするか

- `GET` にマニフェストを返す → Banto の管理画面が「名前・購読イベント・設定項目（メンション、明細を含める、言語）」のフォームを自動で描く
- `POST` で届いたイベントの署名（`X-Banto-Signature`）を検証し、`order.paid` / `order.shipped` / `order.cancelled` / `inventory.low` を Slack に投稿する
- 同じ配信 ID（再送）は二重投稿しない。Slack が落ちていれば 502 を返して Banto に再送してもらう
- 設定値は「テスト送信（banto.ping）」のときだけ届くので、最後に受け取ったものをショップごとに覚える

## 置き方（Cloudflare Workers、開発者向け）

```bash
cd examples/plugin-slack
npm install
npx wrangler secret put SLACK_WEBHOOK_URL     # Slack の Incoming Webhook URL
npx wrangler deploy                           # https://banto-plugin-slack.<あなた>.workers.dev
```

1. Banto の管理画面 → ショップ → **連携** → **送信先を追加** に上の URL を入れる → マニフェストが読まれ、設定フォームが出る
2. 保存すると **署名シークレット** が表示されるので、`npx wrangler secret put BANTO_HOOK_SECRET` で貼る
3. **テスト送信**（banto.ping）を押す → Slack に「接続テスト」が届けば完了

## 自分のプラグインに書き換えるとき

- `MANIFEST` の `name` / `events` / `settings` を変える（`secret` 型は使えません。API キー等は Worker の Secret に）
- `formatMessage()` を、送りたい先の形に変える（CRM の API を叩く、スプレッドシートに追記する、など）
- イベントの `data` に個人情報は入っていません。注文の連絡先が要る場合は、AI 用トークン（`orders:pii`）で `/api/v1/orders/:id` を引く設計にしてください（docs/ai-access.md）
- 長く動かすなら `seen`（配信 ID の記憶）を Workers KV などに置き換えてください。Banto 本体は KV を使いませんが、プラグインは自由です
