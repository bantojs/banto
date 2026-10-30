# 11. 組織・メンバー・役割と実店舗（設計書）

状態: **決定・実装済み（2026-10-17、`0024_organizations`・`0025_store_tryon`）**。要点は 02-decisions.md。実装で設計から変えた点は §11。

## 1. 背景と要望（人間）

- ショップの上に「事業者（会社）」の層が要る。Supabase・GitHub の Organization のようなもの。
- 店舗スタッフ専用のアカウントが要る。**スタッフごとに管理できる実店舗を仕切りたい。**
- 実店舗は **ショップ（ブランド）ごとに使う店舗を分け**、かつ **組織としても一括で管理** したい（住所・営業時間・臨時休業は 1 か所で直したい）。

いまの作り（0001〜）: `owners`（運営者 = Supabase Auth のユーザー 1 人）→ `shops.owner_id`。権限はほぼすべて SQL の `banto_owns_shop(shop_id)`（「そのショップの owner 本人か」）1 か所に集まっている。運営者の自己登録は「まだ owner がいないとき」だけ（`banto_owner_signup_allowed`）。スタッフの仕組みは無い。

## 2. 階層と用語

```
組織 organization … 事業者・会社。メンバーの単位
 ├ メンバー … 運営側の人（Supabase Auth のユーザー）。組織の役割 + ショップ / 実店舗の割り当て
 ├ 実店舗 store（正本）… 店舗名・住所・電話・お知らせの宛先・営業時間・定休日・臨時休業
 └ ショップ shop … ブランドごとの EC（今までどおり）
     ├ ショップ × 実店舗 … このショップで出すか・試着を受けるか・並び順・ショップ独自の案内
     └ 商品・注文・会員・クーポン …（今までどおり shop_id）
```

- **会員（購入者）は今までどおりショップごとの `customers`**。メンバーとは別物（運営側の人だけがメンバー）。
- 1 デプロイに組織が 1 つでも複数でも動くようにする。
- 1 人が複数の組織に入れる（代理店・制作会社が複数の事業者を手伝う形）。

## 3. 役割と権限

組織の役割は 3 つ。`member` には、ショップごと・実店舗ごとに **権限の項目** を割り当てる（人間の指摘「ショップの中でも権限を分けるべき」、2026-10-17。Shopify のスタッフ権限と同じ考え方）。

| 役割 | 範囲 |
| --- | --- |
| `owner` | 組織のすべて。メンバーの管理・組織の削除・請求（段階 2）。最後の 1 人は外せない |
| `admin` | 組織のすべてのショップと実店舗（全項目）。メンバーの招待もできる（owner は作れない） |
| `member` | 割り当てたショップ・実店舗の、割り当てた項目だけ |

### 3-1. ショップの権限の項目

| 項目 | できること | 個人情報 |
| --- | --- | --- |
| `catalog` | 商品・SKU・在庫・カテゴリー・画像・取り込み（WooCommerce の商品） | — |
| `orders` | 注文を見る・発送済みにする・送り状（CSV・番号の取り込み）・領収書 | 購入者の名前・住所・連絡先を見る |
| `orders_cancel` | キャンセル・返金（決済事業者で返金する） | — |
| `customers` | 会員を見る・取り込む・削除依頼への対応（マスキング） | 会員の名前・メール・住所 |
| `marketing` | クーポン（発行・配布）・商品フィード | （会員に配るとき会員の一覧を見る） |
| `reports` | 売上の集計・注文の CSV の書き出し | 書き出しに連絡先が載る（`orders` も要る） |
| `stores` | このショップで使う実店舗・お店で試着の申し込み（見る・状態・在庫を戻す） | 試着の申し込みのお客様の連絡先 |
| `settings` | ショップの設定（法務・送料・税・テーマ・独自ドメイン・会員の設定）・モジュールの ON/OFF・公開 / 非公開 | — |
| `integrations` | 決済の設定・AI 用トークン・hooks の送信先・同梱プラグイン | **外へ送る経路を作れる**（`orders:pii` のトークン・hooks） |

- `integrations` は割り当てると画面に注意を出す（「購入者の個人情報を外部に送る設定ができます」）。
- よく使う組み合わせはひな形として選べるようにする（中身はいつでも直せる）:

| ひな形 | 項目 |
| --- | --- |
| ショップ管理者 | `integrations` 以外すべて |
| 商品担当 | `catalog` |
| 受注担当 | `orders`・`orders_cancel` |
| 販促担当 | `marketing`・`reports` |
| 店舗まわり | `stores` |

### 3-2. 実店舗の権限の項目（store_staff）

| 項目 | できること |
| --- | --- |
| `tryon` | その店舗の試着の申し込みを見る・状態を進める（お客様の名前・電話・メールが見える。連絡に要る。メンテナの決定） |
| `hours` | その店舗の営業時間・臨時休業 / 臨時営業 |

- **「EC の在庫に戻す」は実店舗の権限に入れない**（EC の担当の判断。メンテナの決定 2026-10-17）。戻すのはショップの `stores` を持つ人。
- 実店舗の住所・電話・お知らせの宛先・追加と削除は、組織の owner / admin だけ（担当ショップでだけ使う店舗でも、正本は組織のもの）。

### 3-3. 組織の管理者だけのもの

メンバーの招待と権限の変更・ショップの作成と削除・実店舗の正本・臨時休業のまとめての登録・バックアップと復元・アップデート（マイグレーションの適用）。

## 4. データの形（SQL）

```sql
organizations (id, name, created_at)
org_members (org_id, user_id → auth.users, role in ('owner','admin','member'), created_at, primary key (org_id, user_id))
org_member_shops (org_id, user_id, shop_id, perms text[])     -- §3-1 の項目
org_member_stores (org_id, user_id, store_id, perms text[])   -- §3-2 の項目
org_invitations (id, org_id, email, role, shops jsonb, stores jsonb, token_hash, expires_at, accepted_at, invited_by)
shops.org_id → organizations                     -- 追加。owner_id は 1 マイナー残して後で消す（2 段階の規約）
stores (id, org_id, name, postal_code, address, phone, email, notify_email, hours, special_days, note, active, sort_order)
shop_stores (shop_id, store_id, visible, tryon, sort_order, note, primary key (shop_id, store_id))
```

- 全テーブルに RLS。判定は security definer の関数に集める:
  - `banto_shop_perm(shop_id, perm)` … 組織の owner / admin なら常に true、member ならそのショップの `perms` に `perm` があるか
  - `banto_store_perm(store_id, perm)` … owner / admin なら true、member ならその実店舗の `perms`
  - `banto_owns_shop(shop_id)` は「そのショップの全権（owner / admin）」の意味に作り替える。既存のポリシーと関数はこのままでも owner / admin には今までどおり効く。
- 項目ごとの権限は、**既存のポリシーに「足す」形** で入れる（PostgreSQL の RLS は permissive なポリシーの OR）。例: `products` に `using (banto_shop_perm(shop_id, 'catalog'))` のポリシーを足す。`orders` は `orders`、`customers` は `customers`、クーポンの表は `marketing`、試着は `stores` と実店舗の `tryon`。既存のポリシーを書き換えないので、移行の事故が少ない。
- 権限を確かめている関数（`set_stock`・`import_catalog`・`ship_orders`・`cancel_order` の呼び出し・クーポンの発行・`tryon_update` など、いま `banto_owns_shop` を呼んでいるもの）は、対応する項目で確かめるように 1 つずつ差し替える（一覧は実装の PR に書く）。差し替える前の関数は owner / admin だけが通る（安全側）。
- メンバーを外す・項目を外すと、次のリクエストから効く（RLS がメンバーの表を毎回引く。JWT の失効を待たない）。

## 5. 管理画面

- ログイン後の最初の画面は、メンバーの割り当てで変わる: owner / admin・shop_manager は今のダッシュボード（自分が触れるショップだけ）、store_staff は「担当店舗の試着の申し込み」。
- `requireOwner` → `requireMember`（組織のメンバーか）。`loadShop` は `owner_id` ではなく「自分が触れるショップか」で引き、そのショップでの自分の項目（`banto_my_shop_perms(shop_id)`、1 回の往復）を一緒に返す。
- 各画面は必要な項目で守る（`requirePerm("catalog")` など）。持っていない項目のメニューは出さない。画面で隠すだけでなく、DB の RLS と関数でも同じ項目で止める（二重）。
- 組織の画面: メンバーの一覧・招待・役割と割り当ての変更・実店舗（正本）・臨時休業のまとめての登録（全店舗 / 選んだ店舗に「12/31〜1/3 年末年始休業」）。
- ショップの画面の「実店舗」: そのショップで使う店舗と、試着を受けるか・並び順・ショップ独自の案内。

## 6. 招待

1. owner / admin がメールアドレス・役割・割り当てを入れて招待する。Banto がその場で招待のメールを送る（ログインのメールと同じ `src/mail/send.ts`、送信元はメール通知プラグインの設定。§9-3）。
2. メールのリンク（トークンは HMAC にして DB に。7 日・1 回限り）→ 確認画面のボタン（POST）→ まだ Supabase Auth のユーザーでなければパスワードを決めて作る（GoTrue の Admin API で確認済みのユーザーを作る。運営者の初回作成と同じ `privileged.ts` の経路。メールの所有はリンクで確かめている）→ メンバーになる。
3. 自己登録（`banto_owner_signup_allowed`）は「最初の 1 人 = 最初の組織の owner」を作るときだけ残す。2 人目からは招待だけ。

## 7. 移行（前方専用）

- 0024（お店で試着）はまだ main に入っておらず、どこにも適用されていない。**番号を振り直して、組織を先に入れる**:
  - `0024_organizations` … 組織・メンバー・招待、`shops.org_id`、`banto_owns_shop` の作り替え、既存のデータの移し替え（owner ごとに組織を 1 つ作り、その owner を `owner` にして、shops に `org_id` を入れる）
  - `0025_store_tryon` … 0024 の試着を、実店舗を組織の下に置く形（`stores` + `shop_stores`）に直したもの
- ~~アプリは `org_id` が無い DB（0024 の適用前）でも今までどおり動くようにする~~ → v0.1.0 の土台（0001〜0027）に入ったので、0024 の前の経路は消した（2026-10-17。CLAUDE.md §11「コードと DB の版のずれ」）。
- AI 用トークン（`api_tokens.owner_id`）は発行した人の記録として残す。権限の判定はショップ単位のまま。

## 8. ホスティングして提供する場合（この設計の外）

- 組織の作成（申し込み）・請求・プランの上限・事業者ごとのデータの書き出しと削除は、提供側の仕事。Banto はプランの上限の器（`plan_limits`、0052）と監査ログ（0051）だけを持つ。
- 分け方 A（1 デプロイに他人同士が相乗り）にするなら、RLS が「ショップの整理」から「事業者の隔離」になるので、公開前に外部の診断を受ける（10-members-identity.md の方針と同じ）。B（事業者ごとにプロジェクトと Worker）なら組織はデプロイに 1 つで、Banto の前提はほぼ変わらない（B を推す。02-decisions.md 2026-10-23）。
- B では 1 デプロイ = 1 組織で、0024 の `owners` のトリガーが初回サインアップで組織を作る。Banto 側に「組織作成」の追加は要らない。

## 9. 人間に決めてほしいこと

1. （決定 2026-10-17）ショップの中の権限は項目に分ける（§3-1。人間の指摘「ショップの中でも権限を分けるべき」）。決済・トークン・hooks は `integrations` として独立させ、ひな形「ショップ管理者」にも入れない。
2. （決定 2026-10-17）実店舗のスタッフ: お客様の連絡先は見える、「EC の在庫に戻す」はできない。
3. （決定 2026-10-17）招待のメールは Banto がその場で送る（ログインのメールと同じ扱い。§2「メールは外部プラグイン」の例外を招待にも広げる）。
4. （決定 2026-10-17）段階 1 は v0.1 に入れる。組織（0024）を先に入れ、試着は 0025 に振り直す。

## 10. 作業の分け方

1. （済）PR 1: `0024_organizations` + 管理画面の認可の差し替え + 組織の画面（メンバー・招待）+ `0025_store_tryon`（実店舗を組織の下に + ショップ × 実店舗 + 臨時休業のまとめての登録 + 実店舗のスタッフの画面）。試着は main に入る前だったので同じ PR で作り直した
2. （済）PR 2: 試着のヘッドレス API・AI 用の操作、会員ページの試着の申し込み（`0026_tryon_api`）。あわせて AI 用トークンを「発行者が integrations を持つ間だけ有効」にした（`api_require`・`api_has_scope`・`api_token_shop` が `banto_token_issuer_ok` を見る）

## 11. 実装メモ（設計から変えた点・落とし穴）

- **判定の入口**: 管理画面は `src/routes/admin/access.ts`（`shopAccess` = `banto_admin_shop` の 1 往復でショップの行と自分の役割・項目、`can`、`requireOrgAdmin`、`myShops`）。`loadShop(c, id, perm)` は項目を必ず受け取り、持っていなければ null（404）。
- **`shops` の RLS は行の列で判定する**: `banto_owns_shop` は表を引き直すので、`INSERT ... RETURNING` の新しい行が見えずに RLS 違反になった。`shops_admin` は `case when org_id is null then owner_id = auth.uid() else banto_org_admin(org_id) end`。
- **`enqueue_hook` は orders / catalog の項目を求める**（0024）。実店舗のスタッフが試着の状態を進めると hooks を積めないので、試着の関数は内部用の `banto_enqueue_tryon_hook`（誰にも EXECUTE させない）で積む。
- **割り当ての JSON は 1 本**: `org_invite`・`org_member_set` の `p_shops` に `{ shop_id, perms }` と `{ store_id, perms }` を混ぜて渡す（`banto_set_member_shops` を 0025 で差し替え）。招待の表に `stores` の列は足していない。
- **`shop_stores` は `tryon`・`sort_order` だけ**（設計の `visible`・ショップ独自の案内は入れていない。結ばなければ出ない）。お客様の画面は `shop_store_list(shop_id)`（anon、公開の列だけ）。`stores` の表は anon に読ませない。
- **スタッフは商品の表を読めない**ので、申し込み 1 件は `tryon_request_detail`（明細の品名・ショップの試着の設定も返す）。在庫を戻すボタンは `can_restock`（ショップの `stores`）のときだけ。
- **臨時休業のまとめての登録**: `stores_set_special_days(org, store_ids, days)`。同じ日付は置き換え、`{ date, remove: true }` で消す。項目を持たない店舗は飛ばす（エラーにしない）。期間の書き方 `2026-12-31〜2027-01-03 休業 年末年始`（31 日まで）は `parseSpecialDays` が日ごとに展開する（店舗の画面でも使える）。
- **招待のメールの送信元**: `org_invite` が組織のショップのメール通知プラグインの `from` を返す。送れなければ招待した人の画面にリンクを一度だけ出す（URL や履歴に残さない）。
- 組織・メンバー・実店舗はショップのバックアップ（JSON の書き出し）に含めない（ショップ単位の書き出しのため）。
- **スタッフはショップの表を読めない**ので、申し込みの一覧のショップ名は `tryon_store_shops(store_id)`（0027。その店舗の tryon の項目を持つ人に、名前と id だけ）。
