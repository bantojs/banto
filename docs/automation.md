# 自動化ツール（n8n・Make・Zapier）でつなぐ

Banto には自動化の仕組み（Shopify Flow のような「きっかけ → 条件 → 動き」の画面）を入れていません。
代わりに、**hooks（出来事を知らせる）** と **AI 用 API（確かめる・書く）** を、n8n・Make・Zapier・自作の Worker などの自動化ツールからつなげば、たいていの自動化は組めます。
このページは、その組み方と見本です。コードの変更も、Banto の追加の設定も要りません。

> 見本の動きは、あなたの自動化ツールの上で動くものです。送るメッセージの中身（景品表示法など）と、案内メールの同意（特定電子メール法）の扱いは運営者の責任です。必ず少ない人数で試してから使ってください。

## 1. 形

```
Banto ──hooks（署名付きの POST）──→ 自動化ツール
                                      │ ① 署名を確かめる・配信 ID で重ねて処理しない
                                      │ ② 条件を確かめる（AI 用 API で読む）
                                      │ ③ 動く（AI 用 API で書く・送る）
Banto ←──AI 用 API（Bearer トークン）──┘
```

- **hooks**（docs/hooks.md）: 注文が支払われた・発送した・キャンセルした・カゴ落ち（`checkout.abandoned`）・会員ができた・在庫が少ない、など。**個人情報は載りません**（注文 ID・会員 ID・金額・商品の ID と数だけ）。
- **AI 用 API**（docs/ai-access.md）: 管理画面 → ショップ → AI 連携で、要るスコープだけを付けたトークンを発行します。
  - API の URL は **Banto 自身のホスト**（管理画面を開いているホスト）です。`/api/v1` は、ショップの独自ドメインの上では 404 を返します（店主のサーバーへトークンが向かないように）。
- 自動化ツールに置くのは、**hooks の署名シークレット**（送信先の画面に出ます）と **AI 用トークン** の 2 つだけです。どちらも、自動化ツールの秘密の置き場（n8n の Credentials など）に入れてください。

## 2. 準備

1. **AI 用トークンを発行する**（管理画面 → ショップ → AI 連携）。見本で使うスコープ:

   | やること | スコープ |
   | --- | --- |
   | 注文を読む・一覧で絞る | `orders:read` |
   | 注文に印（タグ）を付ける | `orders:write` |
   | 購入者の名前・メールアドレス、社内のメモを読み書きする | `orders:pii`（要るときだけ） |
   | 会員を読む（案内メールの同意を含む） | `customers:read` |
   | 会員に LINE を送る（docs/line.md §4） | `line:send` |

2. **hooks の送信先を登録する**（管理画面 → ショップ → プラグイン → hooks）。URL は自動化ツールの受け口（n8n の Webhook ノードの Production URL など）、イベントは使うものだけ選びます。登録すると署名シークレットが出ます。
3. 送信先の画面の「テスト送信」で `banto.ping` が届くことを確かめます。

## 3. 受け口で必ずすること

### 署名を確かめる

`X-Banto-Signature: t=<秒>,v1=<hex>` を、届いたボディの**生の文字列**で確かめます（手順は docs/hooks.md §3）。確かめずに動くと、だれでも偽の「支払われた」を送り込めます。

自動化ツールの「コードを書く」部品（n8n の Code ノード、Make の JavaScript、Zapier の Code など）で書く場合の見本です（Web Crypto。Node 18 以上・Workers・Deno）。

```js
// secret: 署名シークレット（64 桁の hex）、body: 生のボディ（文字列）、header: X-Banto-Signature
async function verifyBantoSignature(secret, body, header, now = Date.now()) {
  const parts = Object.fromEntries(String(header || "").split(",").map((p) => p.split("=", 2)));
  const t = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(t) || Math.abs(now / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}
```

- ツールによっては、受け取ったボディを JSON に直してから渡します。そのときは「生のボディ（raw body）を受け取る」設定を選んでください（JSON に直して文字列に戻すと、空白や並びが変わって署名が合いません）。
- 署名が合わなければ 400 を返して止めます。

### 重ねて処理しない

同じ出来事は、失敗したときに**同じ `id`（`X-Banto-Delivery`）で再送**されます（2・4・8・16 分後、5 回まで）。自動化ツールの保存場所（n8n の Data Store など）に処理した `id` を残し、2 回目は何もせず 2xx を返してください。
10 秒以内に 2xx を返さないと失敗になるので、時間のかかる処理（待ち・外への送信）は受け取った後で別に進めます。

## 4. 見本

### 見本 1: 高額の注文に「要確認」の印を付ける

```
order.paid を受ける
  → data.total_jpy が 50,000 以上なら
  → PATCH /api/v1/orders/{data.order_id}  { "add_tags": ["要確認"] }   （orders:write）
```

```bash
curl -X PATCH "https://<Banto のホスト>/api/v1/orders/<order_id>" \
  -H "Authorization: Bearer banto_..." -H "Content-Type: application/json" \
  -d '{"add_tags": ["要確認"]}'
```

- 管理画面の注文の一覧で、印を押すとその注文だけに絞れます。
- 印やメモを変えても hooks は出ないので、自分の付けた印でまた動いてしまうことはありません。

### 見本 2: 処理済みの印で二重に処理しない

外のサービス（会計・倉庫・CRM）に注文を送る自動化では、送った後に印を付けておくと、やり直しや取りこぼしの確かめで重ねて送りません。

```
order.paid を受ける
  → GET /api/v1/orders/{order_id}                 （orders:read。tags を見る）
  → tags に「会計に送った」があれば終わり
  → 外のサービスへ送る
  → PATCH /api/v1/orders/{order_id}  { "add_tags": ["会計に送った"] }
```

### 見本 3: 取りこぼしを拾う（定期の確かめ）

自動化ツールが止まっていた・hooks が 5 回失敗した、といったときのために、1 日に 1 回ほど更新された注文を読み直します。

```
毎日（または 1 時間ごと）
  → GET /api/v1/orders?updated_since=<前回の時刻>          （orders:read）
  → 応答の cursor があれば、?updated_since=<cursor.updated_since>&after=<cursor.after> で続きを読む（has_more が false まで）
  → 「会計に送った」の印が無い支払い済みの注文だけ、見本 2 と同じに処理する
  → 最後に読んだ時刻を残す（少し前から読み直すと確実。書き込みの取引の途中の時刻が付くことがあるため）
```

`?tag=<印>` で、その印の付いた注文だけも読めます。

### 見本 4: カゴ落ちの会員に LINE を送る

```
checkout.abandoned を受ける（会員の予約が、決済されないまま期限切れになったとき）
  → 3 時間待つ（自動化ツールの Wait）
  → GET /api/v1/orders?customer_id={data.customer_id}&updated_since={data.started_at}   （orders:read）
       注文があれば、もう買っているので終わり（期限切れの後で決済が済むこともある）
  → POST /api/v1/customers/{data.customer_id}/line-message                           （line:send）
       Idempotency-Key: abandoned-{data.reservation_id}
       { "text": "カートに商品が残っています", "buttons": { "text": "続きを見る", "actions": [{ "label": "お店へ", "url": "https://shop.example.jp/cart" }] } }
  → 結果の status が no_line / not_friend なら、メールに回すか、何もしないか
```

- `Idempotency-Key` は予約ごとに決まった値にします。再送で同じキーを使えば、二重に届きません（docs/line.md §4）。
- `not_friend`（友だちでない・ブロックされた）や `quota`（宣伝の月の上限）が返っても、失敗ではありません。
- ゲストのカゴ落ちは hooks に出ません（案内の同意が無いため）。

### 見本 5: メールで送るとき（同意を確かめる）

宣伝のメールは、自動化ツール側の送り手（Resend・SendGrid など）で送ります。Banto のメールの送り手は、ログインと注文のメールのために使い、宣伝には使いません。

```
  → GET /api/v1/customers/{customer_id}        （customers:read。email と marketing_consent）
  → marketing_consent が true の人だけに送る
  → 配信停止を押されたら PATCH /api/v1/customers/{customer_id}  { "marketing_consent": false }   （customers:write）
```

- 広告宣伝のメールは、特定電子メール法で同意のある人にしか送れません。配信停止のリンクも必ず付けます。
- `marketing_consent` を `true` にするのは本人だけです（API では `false` にしかできません）。

## 5. 気をつけること

- **トークンは要るスコープだけ**: 印を付けるだけなら `orders:write` と `orders:read` で足ります。`orders:pii`・`customers:read` は、名前やメールアドレスを使う自動化にだけ付けます。
- **個人情報を自動化ツールに残さない**: メールアドレスや LINE の宛先は送る直前に読み、ツールの保存場所や実行の記録に残さない設定にします（n8n なら、実行の記録を残す期間を短くするなど）。LINE の利用者 ID は、Banto が外へ出しません。
- **止めるときは**: 管理画面で hooks の送信先を無効にし、AI 用トークンを取り消します。
- 自動化が大きくなってきたら、外部プラグイン（docs/hooks.md）にまとめることもできます。「つなぐ」（docs/hooks.md §6）を使うと、運営者はトークンや署名シークレットを写さずに済みます。
