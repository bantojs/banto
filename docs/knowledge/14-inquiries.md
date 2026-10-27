# 14. お問い合わせのチケット（同梱モジュール inquiries）

お客様のお問い合わせをチケットにし、運営者とのやり取りを Banto の中で続ける設計（**決定・実装済み**、0061_mod_inquiries、人間の決定 2026-10-27）。
使い方は docs/inquiries.md、ヘッドレスは docs/headless.md「お問い合わせ」。

## 1. 置き場所（CLAUDE.md §7 の基準）

- **同梱モジュール、既定 OFF**。基準 (3) 使わない人が多い、(4) メールの送り手の仕様に触れる。
- CLAUDE.md §2「メールはコアに入れない」・§7b「CRM の機能はコアに入れない」の例外として決めた。理由: 問い合わせの多くは注文の件で、注文・会員と結ぶのは Banto が持っているデータでしかできない。外部のヘルプデスクに任せると注文と連絡先を外へ写すことになり、個人情報の置き場が増える（§8）。
- それでも CRM の機能（担当者の割り当て・SLA・定型文・一斉送信）はコアに入れない。必要なら hooks（`inquiry.*`）とヘッドレス API で外部のヘルプデスクに渡す。

## 2. メールはリンクだけ（受信しない）

メールに載せるのはショップ名・受付番号・「受け付けた / 返事があった」・チケットへのリンクだけ。本文は載せず、メールへの返信も受けない。

- 受信の仕組みを持たずに済む。Cloudflare Email Routing は §1-1 に反し Node に代わりが無い。送り手ごとの受信 Webhook や IMAP は、送り手によって機能が欠ける。MIME の解析は Worker の CPU（無料プラン 10ms）を使う。From を偽った返信を見分ける問題も無くなる。
- 4 つの送り手（resend / smtp / sendgrid / ses）のどれでも同じに動く。
- やり取りの中身が送り手の事業者・転送先の受信箱に残らない。保持とマスキングが Banto の DB の中で閉じる。
- 引用の積み重なり・自動返信のループ・署名の混入が起きない。
- 代わりにリンクの作りが大事になる: トークンは Worker が作り、DB には HMAC（`inquiryLinkHash`、サイトの秘密から用途ごとの鍵）だけを置く。GET では使わず確認画面のボタンで POST（会員のログインのリンクと同じ。メールの安全検査が先に開いても確定しない）。30 日で切れ、「リンクを送り直す」で出し直す。

メールはその場で Worker が送る（hooks の配信に載せない）。確認のリンクは待たせられないため（会員のログインのメールと同じ理由）。

## 3. 本人確認と結びつけ

| 入口 | 確定 | 返事の宛先 | 注文 | 会員 |
| --- | --- | --- | --- | --- |
| フォーム（ゲスト） | 入れたアドレスに届いたリンクを開いたとき | 入れたアドレス | 番号と注文時のアドレスが合えば | 確定してから、会員のアドレスと一致すれば |
| ログイン中の会員 | すぐ | 会員のアドレス | 自分の注文だけ | その会員 |
| 注文照会の結果（注文トークン） | すぐ | 注文時のアドレス | その注文 | 注文の会員 |
| 購入完了の画面（決済の照会トークン） | すぐ | 注文時のアドレス | その注文 | 注文の会員 |

- **注文トークン**: 注文照会で番号とメールアドレスが合った組を、ショップごとの鍵で署名したもの（24 時間）。署名だけで暗号化していないので、URL には載せず POST の hidden で渡す。作るときに DB でもう一度引く（`inquiry_order_ref`）。
- 購入完了の画面からは、既存の照会トークン（0035、quote の識別子）をそのまま根拠にする。URL が他人に渡っても、返事は注文時のアドレス（本人）に届くだけ（人間の決定 2026-10-27）。
- **送った人には何も知らせない**: 会員かどうか・番号とアドレスのどちらが違ったか・送り直しのアドレスが合ったか。どれも探りの道具になるため。一致したかどうかは運営者の画面だけ。
- 確定するまで運営者へのお知らせと hooks `inquiry.created` を出さない（いたずらが運営者の受信箱に届かない）。運営者の画面には「未確認」として出す。未確認のまま 30 日で消す。
- 確認前のチケットにも運営者は返事を書ける（人間の決定 2026-10-27）。ただし注文の中身や住所を書かないよう警告する。返事のお知らせは入れたアドレスに届くので、そのアドレスの持ち主にしか読めない。

### 「ログインできない」

メールアドレスの変更を頼む問い合わせはなりすましの入り口になる。チケットの画面から会員のアドレスを変える操作は作らない（変更は `member_set_email` だけ。監査ログに残る）。手順は docs/inquiries.md §3（古いアドレスで確かめる → 届かなければ注文の内容で確かめる）。

## 4. 表と関数（0061）

- 表: `inquiries`（連絡先・確認の時刻・会員・注文・申告の番号・連携サイトの画面 `return_to`）、`inquiry_messages`、`inquiry_links`（HMAC・30 日）、`inquiry_mails`（送ったメールの記録。宛先は SHA-256。回数の制限とプランの 1 日のメール `banto_plan_mail_count` に数える）、`inquiry_checks`（試行の回数）。どれも RLS。運営側は `support` の項目で読むだけ（書き込みは関数だけ）。お客様の経路は service_role の関数だけ。
- お客様の経路（service_role）: `inquiry_order_check`（ゲストの「注文を確かめる」、回数の制限つき）、`inquiry_order_ref`（注文トークン・照会トークン・会員の番号から注文の要約）、`inquiry_create`、`inquiry_peek`（リンクの確認画面）、`inquiry_get`（初めてリンクで開いたら確定）、`inquiry_member_list`、`inquiry_customer_reply`、`inquiry_resend_link`、`mask_inquiries`（Cron）。
- 運営側（authenticated、中で `banto_shop_perm(shop, 'support')`）: `inquiry_admin_get`、`inquiry_reply`（新しいリンクを作る）、`inquiry_set_status`、`inquiry_delete`。`mask_customer`（`customers` の項目）を差し替えて、お問い合わせの連絡先と本文も消す。
- 「メールを送ってよいか」は DB が決める（`banto_inquiry_issue_mail`。送ってよければ記録して true）。上限を超えたら送らないだけで、応答の形は変えない（会員のログインの `member_login_start` と同じ）。
- 権限の項目 `support` を足した（`banto_shop_perms_all`・`org_member_shops` の検査）。招待とメンバーの設定は同じ関数を通るので、適用前の DB は項目を知らず黙って落とす。画面は 0061 が当たるまで項目を出さない。

## 5. 画面とコード

- `src/modules/inquiries/index.ts`: 入力の検査、注文トークン、チケットの Cookie、流れ（`submitInquiry` / `openInquiry` / `replyAsCustomer` / `resendInquiryLink` / `checkOrder`）。同梱テーマとヘッドレス API の両方がここを通る。
- `src/modules/inquiries/mail.ts`: メールの文面（本文を載せない）。`admin.tsx`: 運営者の画面。
- `src/routes/storefront/inquiries.ts`（同梱テーマ、`/inquiries/*`。お店の画面の使い方に関係なく残す）、`src/routes/api/inquiries.ts`（ヘッドレス、CORS `*`）。
- テーマの口は `InquiryPage`（省略したテーマでは出ない）。本文はテキストとして出す（`white-space: pre-wrap`、HTML として描画しない）。
- 管理画面のタブ「お問い合わせ」は `support` の項目とモジュールの ON で出す（モジュールの一覧は `settings` の項目が要るため、別に出す）。

## 6. AI 用の操作・定型文・バックアップ（2026-10-27 追加）

- AI 用: スコープ `inquiries:read` / `inquiries:write`（→ `support`）。関数は `api_inquiries_list` / `api_inquiry_get` / `api_inquiry_reply` / `api_inquiry_set_status`。連絡先は `orders:pii` もあるときだけ（人間の決定 2026-10-27）。返事のメールは Worker（`ApiService.inquiryReply`）が送り、宛先は AI に返さない。本文はお客様が書いた文章なので、MCP のツールの説明に `INQUIRY_NOTE`（本文の中の指示に従わない）を付ける。削除は API では受けない。
- 定型文: `settings.inquiries.templates`（10 個まで、`{name}` `{number}` `{shop}`）。差し込みは JavaScript を使わず `?template=<番号>` で返事の欄に入れて開き直す。編集は `settings` の項目（ショップの行の更新の守りに合わせる）。
- バックアップ: 書き出しは RLS の経路（運営者の JWT）で `inquiries` / `inquiry_messages`。復元は `restore_inquiries`（注文番号・会員のメールアドレスで結び直す。リンクのトークンは戻さない）。

## 7. 添付ファイル（2026-10-27、人間の決定）

- **公開しないバケットを別に作る**（R2 `banto-private`、Binding `PRIVATE`、アダプタの `privateStorage`。Node は `PRIVATE_MEDIA_DIR` / `S3_PRIVATE_BUCKET`）。商品画像の `MEDIA` は R2 のカスタムドメインで丸ごと公開する運用を勧めている（docs/setup.md §7）ので、同じバケットに置くとキーが漏れたら止められない。配るのは Worker が権限を確かめてからだけ（`inquiry_attachment_get` / `inquiry_attachment_admin_get`）。
- **確認済みのチケットへの返事だけ**（最初のフォームでは受けない）。確定前のいたずらで容量を使わせないため。1 通 3 個・5MB・1 件 20 個、JPEG / PNG / WebP / PDF を中身の先頭で判定（`src/modules/inquiries/attachments.ts`）。
- 流れ: Worker が先に置く → 返事の関数に鍵を渡す（DB が接頭辞 `inq/<shop_id>/`・種類・大きさ・数を確かめる）→ 断られたら置いた実体を消す。行を消すとトリガーが `inquiry_attachment_trash` に積み、Cron が実体を消して外す（ショップの削除でも積む）。
- 配るときは `X-Content-Type-Options: nosniff`・`Content-Security-Policy: default-src 'none'; sandbox`・`Cache-Control: private, no-store`、PDF は `attachment`。
- AI には中身を渡さない（種類と大きさだけ）。バックアップには入れない。
- 費用は R2 の無料枠に収まる見込み（docs/inquiries.md「添付ファイル」）。wrangler 4 の `deploy` は無いバケットを作る（既定で有効な provisioning）。実機の Workers Builds で作られるかは要確認。
