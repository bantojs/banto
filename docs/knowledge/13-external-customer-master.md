# 13. 顧客マスタの外部連携（HubSpot・独自マスタ）— 設計案（2026-10-23、未決）

**状態: 段階 1 を実装済み（2026-10-23、`0047_customer_master`。メンテナの決定「マーケティングの属性は CRM が持つのが自然で、Banto は読むだけ。実装を進めてほしい」）、段階 1b（Banto 自身を顧客マスタに。`0048`）も実装済み。段階 2 の同梱モジュール `hubspot` は要望が出た時点で（トークンの置き場を決めてから）。`customer_directory` は落とした。**
人間の要望（2026-10-23）「顧客マスタを外部サービス（HubSpot やカスタムマスタ = 独自顧客マスタ等）で使えるようにしたい」。
2026-10-16 の決定「CRM を顧客マスタにして Banto から個人情報を抜く構成は採らない」は「既定では採らない。身元・氏名・住所は Banto が正、マーケティングの属性だけ外部が正にできる」に変えた（02-decisions.md 2026-10-23）。
運営者向けの手順は docs/ai-access.md §7、hooks は docs/hooks.md、実例は `examples/plugin-hubspot`。

## 1. 要望の読み方（3 つ）

| 読み方 | 正（source of truth） | Banto の `customers` | 判定 |
| --- | --- | --- | --- |
| A. 写し | Banto | 今のまま。変化を外へ知らせ、外部は写しを持つ | 既存の決定の中。hooks + API で足りる（段階 1） |
| B. 外部が正 | 外部（プロフィール） | 必要最小の写し（身元 + キャッシュ）。Cron で同期 | 決定の変更が要る（段階 2） |
| C. 外部だけ | 外部 | 持たない | **不可**（下記） |

C が不可の理由:
- ログインはメールアドレス → `customers` 行で引く（10-members-identity.md §4）。`member_sessions`・`coupon_grants`・`orders.customer_id`・`member_identities`・`member_passkeys` が `customers` を参照する。
- リクエストの中で外部へ HTTP を呼べない（Workers 無料プランの CPU 10ms、`test/perf-budget.test.ts` の往復数。外部が落ちるとログインも確認画面も止まる）。
- 180 日のマスク・削除依頼（CLAUDE.md §8）は Banto の表に対して動く。
- 2026-10-16 の決定の理由そのもの: 小規模事業者に外部 SaaS の契約を前提にさせない。

## 2. 今あるもの（2026-10-23）

- `customers`: `id` `shop_id` `email` `name` `default_address` `session_epoch` `last_login_at` パスワードの列（0004・0012・0013）。外部の ID を置く列も、独自項目を置く列も無い。
- AI 用トークンの API（0036）: `api_customers_list`（`query` / `email`）・`api_customer_get`・`api_customer_create`・`api_customer_update`（`name` と `default_address` だけ。**email は変えない**）・`api_customer_delete`。スコープ `customers:read` / `customers:write` → 項目 `customers`。
- hooks: `customer.created` は一覧（`src/hooks/events.ts`、CLAUDE.md §5）に名前だけあり、**どこからも積まれていない**（docs/hooks.md「未実装」）。
- 会員の行が作られる経路（すべて SQL の中）: `member_login_verify`（0012 / 0029）・`member_password_login`（0013）・`member_oauth_login`（0014）・`import_members`（0012）・`api_customer_create`（0036）・`restore_shop_data`（0006 / 0012）。
- 外部プラグインの型: `examples/plugin-slack`（hooks を受け、要るものは API で引く）。CRM は「hooks の送信先 = 外部プラグイン」が今の方針で。

## 3. 提案

### 段階 1: 外部と結びつけられる器 + 出来事の通知（コア、基準 (2) データの形。**実装済み 2026-10-23**）

実装のメモ（設計からの差分）:
- hooks は `enqueue_hook` を通さず、`customers` のトリガー（`banto_customers_hook`、security definer）が `hook_deliveries` に直接積む。`enqueue_hook` は呼び手の役割でイベントを絞る（0028 の M11）ので、RLS 越しの運営者の削除や `member_login_verify` の中の insert からも同じ経路で積めるようにするため。行が変わるのは RLS か service_role の RPC を通ったときだけなので、権限の見直しは要らない。
- `customer.updated` は email・name・default_address・attributes・external_ref が変わったときだけ（`is distinct from`）。ログインの時刻・世代・パスワードの列では積まない。
- `attributes` の検査は SQL（`banto_customer_attributes`）: 定義（`shops.settings.customer_fields`）に無い鍵は `invalid_attribute_<鍵>`。型は product_fields と同じ。更新は渡した鍵だけ重ね、null で消す（`banto_customer_attributes_merge`）。
- `api_customer_upsert` は同じアドレスの同時の呼び出しを `pg_advisory_xact_lock` で直列にする（2 人作らない）。
- `restore_customer_master`（復元の後で id で突き合わせて戻す）。`restore_shop_data` は触っていない。
- Worker は `requireMigration` で 0047 より前の DB に `migration_required` を返す（attributes / external_ref / upsert / 新しい絞り込み）。管理画面の一覧は `migrated()` で列を選ぶ。

1. **0047**: `customers.external_ref jsonb`（`{"provider": "hubspot", "id": "…"}`。ショップ × provider × id の一意索引。provider は `^[a-z][a-z0-9_]{0,31}$`）と `customers.attributes jsonb`（独自項目の値）。定義は `shops.settings.customer_fields`（`products.attributes` / `product_fields` と同じ宣言型。`src/products/fields.ts` を共通化）。
2. **hooks を実際に積む**: `customers` の after insert / update / delete トリガー 1 本で `customer.created` / `customer.updated` / `customer.deleted` を `enqueue_hook`（service_role の経路。M11 の方針どおり、管理画面や API から任意に積ませない）。ペイロードは `customer_id` と `external_ref` だけ（**個人情報は載せない**。要るプラグインは `customers:read` で引く）。`updated` は `name` / `default_address` / `attributes` / `external_ref` / `email` が変わったときだけ（`last_login_at`・世代・パスワードの列では積まない）。`import_members` の一括取り込みでは行ごとに積む（上限は hooks の配信側の量で吸収）。
3. **API（0036 の差し替え）**: `create` / `update` で `external_ref` と `attributes` を受ける（`attributes` は `customer_fields` の定義で検査、知らない鍵は拒む）。`api_customers_list` に `external_ref`（provider + id の完全一致）と `updated_since`。`api_customer_upsert`（email で引いて無ければ作る、あれば `name` / `default_address` / `attributes` / `external_ref` だけ更新。email は変えない）。
4. **文書**: docs/hooks.md の表（3 つのイベント、個人情報なし）、docs/ai-access.md §6、CLAUDE.md §5 の一覧、`examples/plugin-hubspot`（Slack と同じ型: `customer.*` と `order.paid` を受け → `customers:read` で引き → HubSpot Contacts を upsert。HubSpot のトークンはプラグイン側の Secret）。

これで「HubSpot」も「独自マスタ」も **外部プラグインとして** つながる（外部 → Banto は `customers:write`、Banto → 外部は hooks + `customers:read`）。Banto 本体は外部の秘密も仕様も持たない。

### 段階 2: Banto 側から同期する同梱モジュール（メンテナの決定が要る）

目的: ターゲット利用者（コードを書かない。CLAUDE.md §13）が、プラグインを自分で置かずに HubSpot を使う。

- **拡張点** `CustomerDirectory`（`src/customers/directory.ts`）: `pull(shop, since)`（外部の変化を取る）/ `push(customer)`（Banto の変化を送る）。**Cron の `sync_customers` からだけ呼ぶ。** ログイン・確認画面・会員ページでは呼ばない（§1 の C と同じ理由）。1 回の量は `workers_plan`（0038）で決める。
- （段階 1 の `examples/plugin-hubspot` は Banto → HubSpot の方向だけ。HubSpot → Banto の属性は、HubSpot のワークフローの Webhook か中継サーバーから `POST /customers/upsert` を呼ぶ）
- **同梱モジュール `hubspot`**（既定 OFF、基準 (4)）: Contacts ↔ `customers`（email で結び、`external_ref.provider = 'hubspot'`）。項目の対応は設定画面で宣言（独自項目 ↔ Contact のプロパティ）。トークンは Workers Secret `HUBSPOT_ACCESS_TOKEN`（CLAUDE.md §1-5 の既定）。ショップごとに分けるなら `shop_secret_boxes`（LINE と同じ例外。メンテナの決定）。
- ~~同梱モジュール `customer_directory`（独自マスタ。Banto が Cron で取りに行く）~~ → **落とした（メンテナの決定 2026-10-23）**。独自の顧客マスタを持つ人には開発者がいて、既存の API（`POST /customers/upsert` と hooks）で足りる。コードを書かない人は独自マスタを持たない。誰のためのものでもなかった。
- **正の決め方（2026-10-23 に人間と話して固めた方針）**: 同じ項目を両側で直す「双方向」は持たない。**項目ごとに向きを 1 つ**に決める。

  | 項目 | 正 | 向き |
  | --- | --- | --- |
  | `email`・ログインの手段・セッション・世代 | Banto | 外へ知らせるだけ（`customer.*` hooks）。外部から変えない |
  | `name`・`default_address`・電話 | Banto（本人が会員ページで直せる場所） | Banto → 外部 |
  | `attributes`（ランク・メルマガの同意・担当者・タグ等、マーケティングの属性） | 外部 | 外部 → Banto（`customers:write` か Cron の `pull`） |
  | 注文の履歴 | Banto | Banto → 外部（既存の `order.*` hooks） |

  - これで衝突・更新時刻の比較・往復のループ止めが要らない。「新しい方が勝つ」と同期済みハッシュは、本当に双方向の項目を足したくなったときの最後の手段（他のサービスも、項目ごとの方向が本流で、時刻勝負は少数の双方向項目だけ: HubSpot–Salesforce の項目ごとの規則、Shopify → HubSpot の一方向）。
  - 外部 → Banto は Banto の API を通る（Banto の行が唯一の正で、入口が会員ページと API の 2 つあるだけ）。`attributes` の値は `customer_fields` の定義で検査する。
  - `name`・`default_address` も `customers:write`（`api_customer_update` / `api_customer_upsert`、0050 の版）で書ける。運営者の道具が Banto の行を直す入口・移行のときの一度だけの投入として残した（表の向きと実装がずれていたので、書けるまま docs を実装に合わせた。2026-10-27）。CRM から定期的に写す同期の向きには使わない（会員ページで本人が直した値を古い値で上書きする。Banto は時刻を比べない）。docs/ai-access.md §7 の注記。
  - `email` の変更は外部から当てない（0036 の決定と同じ理由: アカウントの受け渡しになる）。変えるのは管理画面の `member_set_email` だけ。
  - 退会・削除依頼（`mask_customer`）は hooks で知らせるだけ。外部側の消し方は外部の責任。外部での削除を Banto の退会に写すかは設定（既定 OFF）。
  - `attributes` が入れば、クーポンの条件（宣言型 JSON）に属性の条件（例: ランク）を足せる。判定はコアの一本道のまま。→ **実装済み（2026-10-23、0049 `conditions.attributes`）**。docs/coupons.md「会員の項目の条件」。
- 外部の独自項目をどこに出すか（会員ページ・確認画面・クーポンの条件）は、同期が動いてから別に決める。

### 段階 1b: Banto 自身を顧客マスタとして使う人向け（メンテナの決定 2026-10-23、**実装済み**、`0048_customer_attributes_admin`）

コードを書かない運営者の多数派は CRM を契約しない。その人には Banto がそのまま顧客マスタになる（メール・氏名・住所・注文の履歴・クーポンの発行は既にあり、0047 で運営者が定義する項目が入った）。足したのは次の 3 つだけで、どれも Banto が既に持っているデータの画面:

- 管理画面の「会員」で独自項目を手で直す（`customer_set_attributes`、項目 `customers`。値の検査は 0047 と同じ SQL。`customers` への直接の UPDATE は引き続き誰にも許さない）。
- 独自項目 1 つの値で絞る（`?f=<鍵>&v=<値>`、部分一致。読んだ 500 件の中で）。
- CSV の書き出し（一覧と同じ絞り込み。外部の ID と独自項目の列つき）。

**線引き**: ARCHITECTURE.md「CRM など法的リスクのある領域は自前で持たず、利用者の外部アカウントに連携する」はそのまま。メール配信・営業の進捗・メモの蓄積のような CRM の機能はコアに入れない。「Banto の CRM」とは呼ばない。

### 段階 1c: 「お得な情報やセールの案内を受け取る」の同意（メンテナの決定 2026-10-23、**実装済み**、`0050_marketing_consent`）

MA（Klaviyo・Mailchimp・HubSpot の配信など）は Resend の代わりではなく、お知らせメールを出す別の仕事。Banto は「メール配信はコアに入れない」ままで、会員・注文・同意を渡す側。そのために同意だけはコアが規定の列で持つ（`attributes` には置かない）:

- 同意は本人が Banto の画面で行う行為で、CRM 側は作れない（最初の同意が永遠に入らない）。法務に関わる（基準 (1)）ので、いつ・どこで（`marketing_consent_at` / `_source`: checkout / account / import / api / admin）の記録が要る。MA プラグインが決まった名前で読める。
- **向きの例外**: `true` は本人の行為だけ（レジ → 予約の購入者情報 → `orders` の before / after insert トリガーで注文と会員に写す。`confirm_reservation` は触らない。会員ページは `member_set_marketing_consent`）。`false` はどこで起きても正しい（MA の配信停止 → API の `marketing_consent: false`、運営者の「同意を外す」、本人）。API で `true` は `consent_requires_person`。
- 欄はショップの設定（`settings.marketing_consent`、既定 OFF）× 0050 が当たっているときだけ（`consentCollected`）。欄を出さないショップでは未回答（null）のまま、false を書かない。ゲストの注文は `orders.marketing_consent` にだけ残る（会員になっても引き継がない）。
- 出る場所: 最終確認画面（同梱テーマ・ヘッドレスの `confirmation.marketing_consent`）、会員ページ、管理画面の会員の一覧（絞り込み・CSV・外す）、API（`marketing_consent` で絞る）、hooks `customer.*` のペイロード。
- 日本の法律では購入者・自分でアドレスを知らせた人への広告メールは同意の例外。MA 側や海外の顧客で明示の同意が要るので、MA を使う前提なら先に入れておく。文言の適法性は専門家の確認が未実施（docs/members.md §3-5）。

### やらないこと（この案の中で）

- リクエスト中の外部への問い合わせ（§1 の C）。
- 外部の仕様をコアに持ち込むこと。HubSpot の API を呼ぶコードは同梱モジュールか外部プラグインだけ。
- hooks のペイロードに個人情報を載せること（docs/hooks.md の原則はそのまま）。

## 4. 人間に決めてほしいこと

1. ~~2026-10-16 の決定を「既定では採らない。ON にしたショップでは、マーケティングの属性（`attributes`）だけ外部を正にできる。身元・氏名・住所は Banto が正」に変えるか。~~（決定 2026-10-23: 変える）
2. ~~段階 1 だけ先に進めてよいか。~~（決定 2026-10-23: 進める。実装済み）
3. HubSpot は同梱モジュール（段階 2）か、外部プラグインの例（段階 1 の `examples/plugin-hubspot`）か。両方なら順番。
4. HubSpot のトークンの置き場: デプロイに 1 組（Workers Secret）か、ショップごと（`shop_secret_boxes`、§1-5 の例外を増やす）。
5. ~~独自マスタの契約（`customer_directory`）を Banto が決めてよいか。~~（決定 2026-10-23: 落とす。API で足りる）

## 5. 規模の目安

| 段階 | 変更 | テスト |
| --- | --- | --- |
| 1 | 0047（列・索引・トリガー・API 4 関数 + upsert）、`src/api/service.ts`・`src/mcp/tools.ts`・`openapi.ts`、`src/products/fields.ts` の共通化、docs 3 本、examples/plugin-hubspot | `test/db/`（トリガーで積まれる・個人情報が無い・API の検査）、`test/plugin-example.test.ts` の型 |
| 2 | 拡張点 + Cron + モジュール 2 つ + 設定画面 + 要確認の一覧（0048）、`migrated()` の分岐 | `test/db/`（同期の冪等・email を当てない）、画面、perf-budget（往復を増やさない） |
