# Banto ロードマップ

CLAUDE.md §10 と同期させること。各ステップは「他人に渡せる状態」を満たして次へ進む。

## v0.1.0（MVP）

- [x] Step 1 リポジトリ初期化 — CLAUDE.md / LICENSE / README / SECURITY / wrangler.jsonc / .dev.vars.example / CI
- [x] Step 2 Supabase スキーマ + RLS + 在庫 RPC — `0001_init.sql`、RLS テスト、同時購入テスト（`test/db/`、CI の `db` ジョブ）
- [x] Step 3 セットアップウィザード + Deploy ボタン — Secret はコピー方式（ウィザードは検出と案内のみ）。マイグレーション適用も案内のみ（CLAUDE.md §13）
      → **ここで開発メンバー以外の1人にセットアップさせる**（未実施）
- [x] Step 4 商品管理 + R2 画像アップロード — StorageAdapter 経由のアップロード/配信（`/media/*`）、SKU と在庫（`set_stock`）。縮小とサムネイルはブラウザ側で生成（`0005_images.sql`）。配信は R2 カスタムドメイン + `MEDIA_BASE_URL` を推奨
- [x] Step 5 Hono SSR ストアフロント — 商品一覧・詳細・カート（署名付き Cookie）・法務ページ、公開前チェック（DB 制約 + 設定画面）、公開読み取り API（`/api/shops/...`）
- [x] Step 6 Stripe Connect 決済 — OAuth、Checkout、Webhook、予約在庫の確定/解放、Cron、注文管理画面（発送・キャンセル・マスク）
- [x] Step 7 アップデート機構 — バージョン表示、GitHub 最新リリース表示（失敗時は非表示）、未適用マイグレーション検出、docs/upgrade.md。管理画面からの適用は未決（CLAUDE.md §13）
- [x] 送料・税（全国一律 / 都道府県別、送料無料ライン、税込表示）、配送先入力の統一、注文番号
- [x] 購入者へのメール（同梱プラグイン: Resend）、注文キャンセル（返金 → 在庫戻し）、注文検索・CSV、購入者向け注文照会
- [x] SEO（meta / OG / canonical / robots / sitemap）、既定テーマの設定（紹介文・お知らせ・色・ロゴ）、独自ドメインの手順（docs/custom-domain.md）
- [x] 会員機能（オプトイン: 登録・ログイン・注文履歴・既定住所・退会、管理画面の会員一覧）
- [ ] Step 8 リリース — 残り: 実 Supabase / Stripe / KOMOJU / Resend（テストモード）での通し確認、第三者導入テスト、v0.1.0 タグ
      実機確認（2026-10-15、非公開リポジトリから Workers Builds で配置）: マイグレーション（Management API）→ 運営者 → ショップ → 商品・画像 → 公開 →
      Stripe（サンドボックス）でテスト購入 → Webhook で注文確定・在庫減 → キャンセルで返金・在庫戻し、まで通過。
      未確認: 公開リポジトリからの Deploy ボタン（設定画面にシークレット欄が出るか）、メール通知（Resend）、KOMOJU、LINE、第三者の導入テスト、v0.1.0 タグ

## v0.2

- [x] 非技術者向けの導入体験（インストーラーの代替）— ウィザードがマイグレーションを適用、必須 Secret を1つに削減、Stripe を API キー方式に、docs/setup.md を画面語で全面書き換え。
      残課題: 実際に WordPress 経験者1人に docs/setup.md だけで導入してもらうテスト。
- [ ] ステートレスなインストーラー（GitHub Pages 上の静的ページ、Cloudflare / Supabase OAuth）— **見送り**。上記で代替。以下は調査記録。
      調査結果: (1) Cloudflare には第三者アプリ向けの OAuth が無く、API トークンを利用者に発行・貼付してもらう必要がある。
      (2) Cloudflare API（api.cloudflare.com）と Supabase Management API はブラウザからの CORS 要求を受け付けないため、
      「開発チームがサーバーを持たない静的ページ」からは Worker のデプロイや SQL 実行ができない。
      代替案: a) `npx banto init` 形式の CLI インストーラー（利用者の端末で動く。トークンは保存しない）、
      b) 利用者自身の Cloudflare アカウントに置く「インストーラー Worker」（Deploy ボタンで配置し、使い終わったら削除）。
      どちらも「開発チームはホストしない」原則は守れる。選択後に着手する。
- [x] 同梱プラグイン第1弾（LINE 通知、KOMOJU 決済）— `src/plugins/`、docs/plugins.md。同梱プラグインも hooks の送信先として扱う（内部 URL `https://banto.invalid/plugins/<id>`）
- [x] 外部プラグイン登録 UI とマニフェスト仕様 — hooks 送信基盤（0002_hooks、署名・再送・配信履歴）、docs/hooks.md
- [x] Node.js アダプタ + docs/run-on-node.md — `src/adapters/node/`（ローカル FS / S3 互換 SigV4）、`src/entry/node.ts`、Dockerfile、CI で起動確認
- [ ] ヘッドレス化（docs/headless.md）— UI は連携側が自由に作り、判定（価格・在庫・送料・合計・確定）は Banto。
      済（2026-10-16）: 公開 API の CORS、購入リンク、カート API、チェックアウト API、特商法の最終確認画面（同梱テーマ + API の confirmation）、
      商品のタグと一覧の絞り込み / 並べ替え / ページング / `updated_at`（0007_tags）、埋め込みスニペット（docs/headless.md）。
      済（2026-10-17）: お店で試着（0025）のヘッドレス API・AI 用の操作・会員ページ（0026）。
      済（2026-10-23）: 顧客マスタの外部連携の器（0047。`customers.external_ref` / `attributes`、hooks `customer.*`、API の upsert。HubSpot は外部プラグインの例 `examples/plugin-hubspot`。CRM を契約しない人向けに管理画面で会員の項目の編集・絞り込み・CSV（0048）、会員の項目をクーポンの条件に（0049）、案内メールの同意（0050。Banto は配信しない。MA の外部プラグインが読む）。docs/knowledge/13-external-customer-master.md）。
      残り: 実際の WordPress での確認、WordPress ブロック（別リポジトリ）、店頭受け取り、同梱モジュール `hubspot`（要望が出た時点で）。
      決済なしの取り置き・LINE LIFF 購入・ギフト・請求書払いはコアに入れない
- [ ] WooCommerce からの移行（docs/knowledge/08-woo-migration.md）— 機能をコア / 同梱モジュール（既定 OFF）/ 外部プラグインの 3 層に置く方針（docs/ARCHITECTURE.md）。
      順番: 速度の予算の検査とモジュールの ON/OFF → 商品マスタの拡張 + インポーター → クーポン → 商品フィード + JSON-LD → 配送日時・軽減税率・送り状 CSV
      - [x] クーポン（判定型・公開コード、0010 + 同梱モジュール coupons、docs/coupons.md）
      - [x] クーポン（配布型・使い捨てコード・自動発行・先着の獲得ボタン・WooCommerce からの取り込み。docs/knowledge/09-coupons.md）
      済（2026-10-16）: 速度の予算の検査（DB 往復回数のテスト、Worker サイズの上限）、商品マスタの拡張（0008_catalog: カテゴリー・ブランド・カスタム項目・SKU の選択肢 / JAN / 通常価格）、
      同梱モジュールの ON/OFF、WooCommerce インポーター（CSV。0009_catalog_import）。次: REST API 方式（数値メタの正確な移行・パーマリンク）
- [ ] お問い合わせのチケット（同梱モジュール inquiries、docs/inquiries.md、docs/knowledge/14-inquiries.md）
      済（2026-10-27）: フォーム（ゲスト・会員・注文から・購入完了の画面から）、確認画面、アドレスの確認、チケットの画面、運営者の画面と返事、メールはリンクだけ、ヘッドレス API、権限の項目 `support`、マスキング（0061）。
      次: AI 用の操作、添付ファイル、定型文、バックアップの書き出し

## 組織・メンバー（v0.1 に同梱。docs/knowledge/11-organizations.md）

- [x] 組織・メンバー・役割とショップごとの権限の項目、招待（0024）
- [x] 実店舗を組織の正本に、ショップごとに使う店舗、実店舗のスタッフの項目、臨時休業のまとめての登録（0025）
- [x] AI 用トークンは発行者の権限が続く間だけ有効（0026）、スタッフの一覧のショップ名（0027）
- [x] 運営者の環境での実機確認（2026-10-17）

## v0.3（AI）

- [x] AI 用トークン（スコープ・期限・失効、ハッシュ保存）と `api_*` RPC、売上集計 — `0003_api.sql`、docs/ai-access.md
- [x] MCP サーバー（`/mcp`）と REST（`/api/v1`、OpenAPI）
- [x] AI に導入を手伝ってもらう台本（docs/install-with-ai.md）、`/admin/setup/status.json`、AGENTS.md、CLI 導入スキル
- [ ] Claude デスクトップ / ChatGPT の実機で MCP 接続を確認する（認証ヘッダ付き HTTP MCP への対応状況はクライアントごとに異なる）

## 運用まわり（v0.1 に同梱）

- [x] 運用費用試算（docs/cost-estimator.html、docs/cost.md）
- [x] 画像のブラウザ側リサイズとサムネイル（`0005_images.sql`）、R2 カスタムドメイン配信の案内
- [x] `/health`（DB と Cron の生存。`0006_ops.sql` の `banto_heartbeats`）、docs/monitoring.md
- [x] バックアップの JSON 書き出しと空ショップへの復元（`restore_shop_data`）、docs/backup.md
- [x] メール到達性（docs/email.md）、WAF・レート制限・Access（docs/hardening.md）
- [x] 英語 UI（`src/i18n/en.ts`、`BANTO_LOCALE=en`）
- [x] 外部プラグインの実例（examples/plugin-slack、契約テスト付き）
- [ ] 既存画像のサムネイル一括生成（今は上げ直しのみ）

## 将来（条件が揃った時のみ）

- 有料ホスティング版（プール型 DB、AGPL への切り替え検討） — docs/ARCHITECTURE.md「将来拡張」参照
