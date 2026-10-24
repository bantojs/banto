# hooks（Webhook 送信）とプラグイン仕様

> API 全体の入口は [docs/api.md](api.md)。

Banto のプラグインは「コアの hooks とヘッドレス API だけを接点とする外部サービス」です（ARCHITECTURE.md）。
コアにコードを読み込む方式は採りません。この文書は、送信先（プラグイン）を作る人向けの仕様です。

## 1. イベント

| イベント | 発生タイミング | data の主な項目 |
| --- | --- | --- |
| `order.created` | 決済 Webhook で注文が作られたとき（`order.paid` と同時） | `order_id` `shop_id` `subtotal_jpy` `shipping_jpy` `discount_jpy` `total_jpy` `status` `payment_provider` `items[]`（`total_jpy` は値引き後。`items[].discount_jpy` は商品ごとの値引き） |
| `order.paid` | 同上 | 同上 |
| `order.shipped` | 管理画面で「発送済み」にしたとき | `order_id` `shop_id` `total_jpy` `status` `shipped_at` |
| `order.cancelled` | 管理画面で「キャンセル」にしたとき | `order_id` `shop_id` `total_jpy` `status` `refunded` `restocked`（在庫を戻したか。取り込んだ注文は false、0031） |
| `product.updated` | 管理画面で商品を保存したとき | `product_id` `shop_id` `slug` `name` `published` |
| `inventory.low` | 注文確定後に在庫が閾値以下になったとき（閾値は `shops.settings.low_stock_threshold`、既定 3） | `shop_id` `sku_id` `available` `threshold` |
| `tryon.requested` | お店で試着の申し込み（同梱モジュール store_tryon、0025） | `request_id` `number` `shop_id` `store_id` `status` `visit_date` `customer_id` |
| `tryon.updated` | お店で試着の状態が変わった（`sent` 店舗へ発送 / `ready` 取り置き開始 / `purchased` / `not_purchased` / `expired` / `cancelled`） | `request_id` `number` `shop_id` `store_id` `status` `hold_until` `customer_id` |
| `customer.created` | 会員の行ができたとき（初回のログイン、取り込み、API での作成。0047） | `customer_id` `shop_id` `external_ref`（外部の顧客マスタでの ID `{provider, id}`、無ければ null）`marketing_consent`（案内メールの同意 true / false / null = 未回答。0050） |
| `customer.updated` | 会員のプロフィール（メールアドレス・氏名・住所・独自項目・外部の ID・案内メールの同意）が変わったとき。ログインの時刻やパスワードの変更では送らない | 同上 |
| `customer.deleted` | 会員が退会した・運営者が削除したとき | 同上 |

**個人情報（氏名・住所・メール・電話）は送りません。** 必要なプラグインは注文 ID・会員 ID を使って AI 用トークンの API（`orders:pii` / `customers:read`、[docs/ai-access.md](ai-access.md)）から取得します。
会員のイベントは、HubSpot などの CRM や自社の顧客マスタに Banto の会員を写すためのものです（向きは Banto → 外部。外部 → Banto は API の `POST /api/v1/customers/upsert`。[docs/knowledge/13-external-customer-master.md](knowledge/13-external-customer-master.md)、実例 [examples/plugin-hubspot](../examples/plugin-hubspot/)）。

## 2. 送信形式

登録した URL に `POST` します。

```
POST https://plugin.example/banto
Content-Type: application/json
User-Agent: banto-hooks
X-Banto-Event: order.paid
X-Banto-Delivery: 7a1c...（配信 ID、再送でも同じ）
X-Banto-Signature: t=1760000000,v1=9f2a...（後述）

{
  "id": "7a1c...",
  "event": "order.paid",
  "created_at": "2026-10-14T12:34:56Z",
  "shop_id": "....",
  "attempt": 1,
  "data": { "order_id": "...", "total_jpy": 6000, "items": [ { "sku_id": "...", "qty": 2, "unit_price_jpy": 3000 } ] }
}
```

- 2xx を返せば配信済みです。10 秒以内に応答してください（処理は非同期で）。
- それ以外の応答・タイムアウト・接続失敗は失敗として扱い、**2, 4, 8, 16 分後**に再送します。5 回失敗で `failed` になり、管理画面の配信履歴に残ります。
- 再送は同じ `id`（`X-Banto-Delivery`）で届きます。重複処理を避けるなら `id` で冪等化してください。
- 管理画面の「テスト送信」は `banto.ping` イベントを同期で送ります。ボディに `settings`（後述）が含まれます。

## 3. 署名の検証

送信先ごとの **署名シークレット**（64 桁の hex）は管理画面の送信先の画面に表示されます。
値はサイトの秘密（`SESSION_SECRET`、未設定なら `SUPABASE_SERVICE_ROLE_KEY` からの導出値）と送信先 ID から導出され、DB には保存されません。
service_role キーを再発行すると署名シークレットも変わるので、送信先側の設定を更新してください。

```
X-Banto-Signature: t=<送信時刻 epoch 秒>,v1=<hex(HMAC-SHA256(secret, `${t}.${body}`))>
```

検証手順（Stripe と同じ方式）:

1. ヘッダを `,` で分け、`t` と `v1` を取り出す
2. `|now - t| > 300 秒` なら拒否（リプレイ防止）
3. `HMAC-SHA256(secret, t + "." + 生のリクエストボディ)` を hex にし、`v1` と定数時間比較する

参考実装は `src/hooks/signing.ts` の `verifyHookSignature()` です（WebCrypto のみ。Workers / Node / Deno でそのまま動きます）。
動く実例は [examples/plugin-slack](../examples/plugin-slack/)（Slack 通知。マニフェスト・署名検証・冪等化・再送の扱いまで入った最小のプラグイン）を見てください。

```ts
import { verifyHookSignature } from "./signing";
export default {
  async fetch(req: Request, env: { BANTO_HOOK_SECRET: string }) {
    const body = await req.text();
    if (!(await verifyHookSignature(env.BANTO_HOOK_SECRET, body, req.headers.get("X-Banto-Signature") ?? undefined))) {
      return new Response("bad signature", { status: 400 });
    }
    const { event, data } = JSON.parse(body);
    // ... 処理
    return new Response("ok");
  },
};
```

## 4. マニフェスト（任意）

送信先 URL に `GET`（`Accept: application/json`）すると JSON を返す場合、管理画面はそれをマニフェストとして読み、
名前・購読イベント・設定項目のフォームを自動で描画します。無くても登録できます。

```json
{
  "name": "LINE 通知",
  "version": "1.0.0",
  "description": "注文が入ったら LINE に通知します",
  "events": ["order.paid", "inventory.low"],
  "settings": [
    { "key": "to", "label": "送信先ユーザー ID", "type": "text", "required": true },
    { "key": "verbose", "label": "明細も送る", "type": "boolean" },
    { "key": "lang", "label": "言語", "type": "select", "options": [{ "value": "ja", "label": "日本語" }] }
  ],
  "admin_url": "https://plugin.example/admin"
}
```

| 項目 | 内容 |
| --- | --- |
| `name` | 必須。200 文字まで |
| `events` | 購読したいイベント。登録画面で変更可 |
| `settings[]` | `key` は `^[a-z][a-z0-9_]{0,63}$`。`type` は `text` / `boolean` / `select`。**`secret` 型は受け付けません**（API キー等はプラグイン側の環境変数に置く。CLAUDE.md §1-5） |
| `admin_url` | `https://` のみ。管理画面に iframe で埋め込み、`?shop_id=&endpoint_id=` を付けて開きます |

設定値は `hook_endpoints.settings` に保存され、テスト送信（`banto.ping`）のボディに `settings` として含まれます。
通常のイベントには含まれないので、必要なら `banto.ping` 受信時に保存するか、プラグイン側で保持してください。

## 5. 配信の仕組み（運用者向け）

- キューは `hook_deliveries` テーブル。`enqueue_hook()` が積み（管理画面からは `catalog` の項目で `product.updated`、`orders` の項目で `order.shipped` だけ。注文の確定・試着などは DB の中の service_role だけが積む。0028）、Cron（`*/5 * * * *`、`deliver_hooks` ジョブ）が `claim_hook_deliveries()` で取り出して送ります。
- 取り出した行には 10 分のリースが張られ、Cron が重なっても二重配信しません。
- 配信履歴は管理画面「連携」ページに最新 50 件。古い履歴の掃除は今後のマイグレーションで追加予定です。
- 送信先を無効にすると、以後のイベントは積まれず、積まれていた分も配信されません。
