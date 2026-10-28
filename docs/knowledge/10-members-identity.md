# 10. 会員のアカウントを店ごとに持つ（設計書、2026-10-16）

**状態: 実装済み（2026-10-16）。第 1 段階 `0012_member_auth`（コードとリンク）、第 2 段階 `0013_member_password`（パスワード・WordPress の取り込み、§13）、LINE・Google でのログイン `0014_member_oauth`（§14）。**
運営者向けの手順は、実装のときに docs/members.md を書き直す。

## 1. 決めたこと（人間と合意、2026-10-16）

- 会員（購入者）のアカウントは **ショップごと**（Shopify の新しい顧客アカウントと同じ形）。同じメールアドレスでも、A 店と B 店の会員は別のアカウント。
- ログインは **パスワードなし**。メールに届く **6 桁のコード** か **ログインのリンク** のどちらかで入る（1 通のメールに両方を載せる）。
- アカウントとログインは **Banto が持つ**（Supabase Auth を会員に使わない）。**運営者（管理画面）は今までどおり Supabase Auth**。
- ログインのメールは **Banto がショップの名前・送信元・言語で送る**。

### なぜ（経緯）

1. Supabase Auth はプロジェクト 1 つにつき同じメールアドレスのユーザーを 1 人しか持てず、店ごとに分ける仕組みも無い。多くの店を 1 つのプロジェクトに入れると、会員のアカウントが全店共通になる。
2. 全店共通のアカウント（B 案「Banto ID」）にすると、ログインのリンクを店の独自ドメインに載せられない。悪意のある店主が DNS を自分のサーバーに向け直すと、届いたリンクのトークンで **他店の会員** を乗っ取れるため。パスワードが全店共通になることの説明も要る。
3. Supabase のメールは、送信元・テンプレート・Redirect URLs・送信数の上限（1 時間 30 通など）が **プロジェクトに 1 組**。店ごとの独自ドメイン・ブランドが使えず、多くの店を預かると全店で上限を分け合う。
4. 店ごとに Supabase のプロジェクトを作るのは、1 つ月 10 ドル前後〜で、1 デプロイに小さな店を多く載せる使い方では成り立たない。外部の認証サービス（Auth0 Organizations・Clerk・WorkOS）は利用者数の課金と外部契約が要り、依存を絞る方針（CLAUDE.md §2）と合わない。
5. パスワードを持たなければ、Banto が持つ部品は「乱数・HMAC・回数の制限・署名付きトークン」だけになる。パスワードの保存と漏洩対策・ハッシュ計算の CPU（Workers 無料プランの 10ms）を引き受けずに済む。

### 守る条件（人間と合意）

1. パスワードは持たない（入れたくなったら改めて相談）。
2. 暗号は WebCrypto の標準機能だけ。自作しない。
3. **判定は DB に寄せる**: コードの照合・回数の制限・失効・使い捨ては `SECURITY DEFINER` の RPC の中で行う。Worker の書き間違いで制限をすり抜けられないようにする（在庫と同じ考え方）。
4. 実 PostgreSQL のテストで攻撃側から試す（§10）。
5. 脅威モデルをこの文書に書き、多くの店を預かる形で公開する前に外部のセキュリティ診断を受ける（手配は人間）。
6. 入口を小さく保つ。最初はメールのコードとリンクだけ。LINE・Google のログインやパスキーは、後から 1 つずつ足す（§11）。

## 2. 範囲

| 対象 | 今 | これから |
| --- | --- | --- |
| 運営者（管理画面） | Supabase Auth | **変えない**（運営者は店の利用者ではないので、共通のアカウントで困らない） |
| 会員（ストアフロント・ヘッドレス） | Supabase Auth（`customers.id = auth.users.id`） | Banto のアカウント（`customers` の行がそのままアカウント） |
| 会員のデータの読み書き | RLS（`customers.id = auth.uid()`） | service_role の RPC（`src/db/privileged.ts`）。ショップと会員 ID とセッションの世代を関数の中で確かめる |
| ログインのメール | Supabase（SMTP・テンプレート） | Banto（`src/mail/send.ts`、§7） |

同じ人が運営者で、別の店の会員でもよい（運営者は `owners`、会員は店ごとの `customers` で判定する。互いに関係しない）。

## 3. 脅威モデル

| 脅威 | 起き方 | 対策 |
| --- | --- | --- |
| コードの総当たり | 6 桁（100 万通り）を順に試す | 1 つのコードは **5 回** 間違えたら無効。新しいコードを出したら前のコードは無効（有効なコードは常に 1 つ）。コードの発行は 1 人（ショップ × メールアドレス）あたり **15 分に 5 回・1 日 20 回**。これで 1 日に試せるのは最大 100 回 = 当たる確率 1 万分の 1 / 日。IP ごとの上限も掛ける（§6） |
| DB の中身が漏れる | 保存したハッシュからコードを逆算する（6 桁なら素の SHA-256 は一瞬で総当たりできる） | コード・リンクのトークン・IP は **HMAC-SHA256（サイトの秘密）** で保存する。DB だけが漏れても逆算できない。サイトの秘密は Workers Secret（DB に置かない） |
| 登録の有無を調べられる | 「このアドレスは登録されていません」の違いを見る | 登録の有無にかかわらず同じ画面・同じ応答・同じくらいの時間。初回のログインで会員になる（§5）ので、そもそも「未登録」の分岐が外に見えない |
| メールの安全検査がリンクを先に開く | Outlook の Safe Links などが中身を調べるためにリンクを開き、本人が押す前に使用済みになる | GET では使わない。開いた先の確認画面のボタン（POST）で使う |
| 他人のアカウントでログインさせられる（ログイン CSRF） | 攻撃者が自分のリンクを送りつけ、踏んだ人がそのまま住所を入れる | 確認画面に「t***@gmail.com としてログインします」を出してから押させる。フォームは `csrfGuard` を通す |
| リンクのトークンが漏れる | Referer・ブラウザの履歴・転送 | 確認画面は `Referrer-Policy: same-origin`（外のサイトには送らない。no-referrer だとフォームの POST が `Origin: null` になり csrfGuard に拒まれるため、2026-10-23）、外部の読み込みなし。15 分で失効・1 回限り。使ったら URL からトークンを外した画面に移る |
| メールを大量に送りつけられる（メール爆撃） | 他人のアドレスでログインを何度も頼む | 発行の上限（1 人 15 分に 5 回）と IP ごとの上限。上限に達したら送らずに同じ応答 |
| 他店のコードを使う | A 店のコードを B 店で入れる | チャレンジは `shop_id` に結びつけて保存し、照合も `shop_id` で絞る |
| 悪意のある店主 | 自分の店のドメインを自分のサーバーに向け直してリンクのトークンを集める | アカウントが店ごとなので、取れるのは自分の店の会員だけ（その情報はもともと持っている）。他店には届かない |
| セッションの盗難 | Cookie やヘッドレスのトークンを盗む | Cookie は `HttpOnly; Secure; SameSite=Lax; Path=/<shop>`。トークンにはセッションの世代を入れ、「全端末からログアウト」と運営者によるメールアドレスの変更で世代を上げて一斉に無効にする。端末ごとのセッションの行（§17、0045）で、ログアウト・一覧からの取り消し・refresh の使い回しの検知でその端末だけを止める |
| 運営者によるメールアドレスの変更が乗っ取りの入り口になる | 運営者のアカウントを乗っ取った人が会員のアドレスを書き換えてログインする | 変更は RPC（所有を確かめる）だけ。変える前後の両方のアドレスに知らせ、世代を上げる。変更の記録（いつ・誰が・会員 ID。アドレスそのものは残さない）を残す |
| 同時に照合して 2 回使う | 同じリンクを同時に 2 回押す | 照合はチャレンジの行を `FOR UPDATE` で取ってから使用済みにする（1 回しか成功しない） |
| 時間で答えが漏れる | 比較の時間の差から 1 文字ずつ当てる | 照合は DB の中で HMAC の値どうしの等号（入力から直接比べない）。Worker 側では比べない |

## 4. 表とマイグレーション（`0012_member_auth.sql`）

### customers（変更）

- `id` の `references auth.users(id)` を外した（制約の削除。列は変えない）。既存の会員は同じ ID のまま。新しい会員の ID は DB が振る。
- 追加: `session_epoch integer not null default 0`、`last_login_at timestamptz`。
- 一意: `(shop_id, lower(email)) where email is not null`。照合はこの索引で引く。
  - 設計の段階では照合用に `email_hash`（HMAC）を足すつもりだったが、`customers.email` にはもともと平文のアドレスがある（注文の連絡に要る）ので、ハッシュを別に持っても守れるものが無い。やめて、平文の小文字で引く。
- RLS の `customers_self` 等（`auth.uid()` の経路）は 0012 で消した（§8）。会員の経路は service_role の RPC なので RLS を通らない。owner の閲覧・削除のポリシーは残る。

### member_login_challenges（新規）

| 列 | 内容 |
| --- | --- |
| `id uuid` | チャレンジ ID（リンクに入る。秘密ではない） |
| `shop_id uuid` | ショップ |
| `email text` | 送り先（小文字）。初回のログインで会員を作るときにも使う |
| `code_hash text` / `link_hash text` | HMAC（コード / リンクのトークン、16 進 64 桁） |
| `attempts smallint` | 間違えた回数（5 で無効） |
| `expires_at timestamptz` | 発行から 15 分 |
| `consumed_at timestamptz` | 使った・無効にした時刻 |
| `ip_hash text` | HMAC（IP）。IP ごとの上限に使う |
| `return_to text` | ヘッドレスのリンクの戻り先（許可リストで確かめ済みのもの） |

RLS は有効にして、ポリシーは「誰にも見せない」1 つ（`using (false)`。CLAUDE.md §1-4。service_role だけが RPC で触る）。2 日たった行は Cron（`member_login_cleanup`）で消す。

### RPC（すべて `SECURITY DEFINER`、service_role のみ、PUBLIC から剥奪。`member_set_email` だけ owner）

| 関数 | 中身 |
| --- | --- |
| `member_login_start(shop, email, code_hash, link_hash, ip_hash, return_to)` | 会員機能が有効か・メール通知プラグイン（Resend）の送信元があるか → 同じ人の申込みを `pg_advisory_xact_lock` で直列にして上限（§6）を数える → 超えていれば `{send: false, challenge_id: 使われない ID}` → 同じ人の未使用のチャレンジを無効にして新しい行を作り `{send: true, challenge_id, mail_from}` |
| `member_login_verify(shop, challenge_id, code_hash, link_hash)` | チャレンジを `FOR UPDATE` で取る → 期限・使用済み・回数 → 合わなければ `attempts + 1`（例外にしない。例外にすると加算まで取り消される）→ 合えば使用済みにし、`customers` を引く（無ければ作る）→ `{ok, customer_id, session_epoch, email, created, return_to}` |
| `member_login_peek(shop, challenge_id, link_hash)` | リンクの確認画面に出すアドレス（使わない・数えない。トークンは 256 ビットなので回数の制限は要らない） |
| `member_get` / `member_save_address` / `member_withdraw` / `member_logout_all` | 会員ページの表示（注文 50 件）・住所の保存・退会・全端末からログアウト。どれも世代を確かめる |
| `member_set_email(shop, customer_id, email)` | 運営者による変更（authenticated、`banto_owns_shop`）。重複は `email_taken`。世代を上げ、未使用のチャレンジを無効にする。前後のアドレスへの知らせは Worker |
| `import_members(shop, rows)` | WooCommerce からの取り込み（0011 の `import_customers` の置き換え）。メールアドレスで引いて無ければ作る。足りない項目だけ埋める |
| `attach_reservation_customer`（差し替え） | `customer_id` があるときは `customer_epoch` が今の世代と一致すること。違えば `member_session_invalid`（Worker は予約を戻してログインし直してもらう） |

確定の流れ（予約 → 確定 → 注文の `customer_id`）とクーポンの subject（`c:<会員 ID>`）は変わらない。

## 5. 流れ

### ログイン（会員登録を兼ねる）

```
/<shop>/account/login でメールアドレスを入れる
  → Worker: コード（6 桁、crypto.getRandomValues で偏りなく）とトークン（32 バイト）を作る
  → member_login_start（HMAC の値だけを渡す。生のコードとトークンは DB に渡さない）
  → send が true ならメールを送る（§7）。false でも同じ画面
  → /<shop>/account/code に「コードを入れる」画面（チャレンジ ID は署名付き Cookie に持つ）
     ・コードを入れる → member_login_verify → セッションを書く → /account
     ・メールのリンクを開く → /<shop>/account/verify?c=<id>&t=<token>（確認画面）→ ボタン → member_login_verify → /account
```

- **会員登録の画面は別に持たない**。初めてのアドレスなら、ログインに成功した時点で会員になる。ログイン画面に「初めての方は、このまま会員登録になります」とプライバシーポリシーへのリンクを出す（§12 で確認）。
- 会員機能が OFF のショップでは、どの経路も 404。

### セッション

- Cookie（今の署名付き Cookie の仕組み）: `{customer_id, epoch, exp}`。有効期限は **30 日**、会員ページを開くたびに延ばす（§12 で確認）。
- 世代の確認は、会員の RPC の中で行う（会員ページ・住所の保存・予約への会員の紐づけ）。カートや商品の表示ではしない（速度の予算を増やさない）。
- 「全端末からログアウト」を会員ページに置く。

### ヘッドレス

- `POST /api/shops/<shop>/members/login` `{email, return_to?}` → `{challenge_id}`（常に同じ形）。`return_to` は `settings.headless.return_origins` のオリジンだけ。リンクは `return_to?banto_challenge=<id>&banto_token=<token>` になる（無ければ Banto の確認画面）。
- `POST /api/shops/<shop>/members/verify` `{challenge_id, code}` か `{challenge_id, token}` → `{access_token, refresh_token, expires_in}`。
  - access は 1 時間、refresh は 30 日。どちらも HMAC の署名付き（ショップ ID・会員 ID・世代・期限）。サーバーに状態を持たない。
- `POST /api/shops/<shop>/members/refresh`。世代を確かめて新しい組を返す。
- 今の `Authorization: Bearer` の付け方はそのまま。中身が Supabase のトークンから Banto のトークンに変わる。`/members/config` は Supabase の URL を返さなくなる。
- 公開 API は CORS `*` だが、トークンは本文で受け渡す（Cookie を使わない）ので CSRF にはならない。

## 6. 回数の制限（DB で数える。KV は使わない、§1-2）

| 対象 | 上限 | 超えたら |
| --- | --- | --- |
| コードの発行（ショップ × メールアドレス × IP） | 15 分に 3 回、1 日 10 回（IP が取れなければ メールアドレスだけで 15 分に 5 回） | 送らない（応答は同じ） |
| コードの発行（ショップ × メールアドレス） | 1 日 30 通（メール爆撃の上限） | 送らない（応答は同じ） |
| コードの発行（ショップ × IP） | 1 時間に 30 回（`settings.members_login_limits.per_ip_per_hour`、0033。連携側のサーバーが中継する構成では `headless.relay_ips` と `X-Banto-Client-IP` で購入者の IP に戻す） | 送らない（応答は同じ） |
| コードの発行（ショップ全体） | 1 時間 100 通・1 日 500 通（`settings.members_login_limits`） | 送らない（応答は同じ） |
| 照合（チャレンジ 1 つ） | 5 回 | そのチャレンジを無効。コードの出し直しを案内 |
| 照合の失敗（ショップ × メールアドレス、1 日） | 50 回 | どのチャレンジも通らない（expired） |

**2026-10-18（0029）**: 監査 M8 / M10 への対応。それまでは「ショップ × メールアドレス 15 分 5 回・1 日 20 回」で、他人がそのアドレスで申し込むと枠を使い切れ、新しい発行が前のコードを無効にしていたため、第三者が 1 日ログインを止められた。発行の枠を IP ごとに分け、直近 3 つのチャレンジを有効のまま持ち、代わりに照合の失敗をアドレスごとに 1 日 50 回で止める（総当たりの余地は増えない）。ショップ全体の上限は送信元の評判と Resend の枠を守るため。会員の API の CORS も `return_origins` だけに絞った（src/routes/api/members.ts の `memberCors`）。

- 1 人を狙っても、1 日に試せるのは 20 チャレンジ × 5 回 = 100 回（100 万通りのうち）。IP ごとの照合の上限は設計の段階で置いていたが、照合はチャレンジ（= 発行の上限に掛かる）単位でしかできないので省いた。
- 数えるのは `member_login_challenges` の行（索引 `(shop_id, email, created_at)` と `(shop_id, ip_hash, created_at)`）。
- IP は `clientIp()`（`src/routes/common.ts`）。信用するヘッダーは `CLIENT_IP_HEADER`（既定は Cloudflare の `CF-Connecting-IP`。Node でリバースプロキシの後ろなら `x-forwarded-for`）。取れなければ IP の上限は掛けない（メールアドレスの上限は掛かる）。

## 7. メールの送り方

- `src/mail/send.ts` の `createMailer` が `MAIL_TRANSPORT` から送り手を作る（resend（既定）/ smtp / sendgrid / ses。2026-10-23 まで Resend だけだった）。秘密は同梱のメール通知プラグインと同じ Workers Secret、**送信元はそのプラグインのショップごとの設定**（`member_login_start` が返す）。運営者が会員のために新しく設定するものは無い。
  - 送り手の実装は `src/mail/transports/`。SMTP はライブラリなしの小さなクライアント（`src/mail/smtp-client.ts`: EHLO → STARTTLS → AUTH PLAIN / LOGIN → MAIL / RCPT / DATA、1 通ごとに接続）で、文面は `src/mail/message.ts`（encoded-word・base64・multipart/alternative）。接続は `SocketAdapter`（Workers は `cloudflare:sockets`、Node は `node:net` / `node:tls`）。SES は `src/util/sigv4.ts`（S3 と共用）で署名。
- **ログインのメールは、注文確認のような非同期の通知と違い、その場で送らないと会員が入れない**。そのため hooks の配信（Cron・再送）には載せず、リクエストの中で送る。「メールはコアに入れず hooks の外部プラグインにする」（CLAUDE.md §2）の例外（人間と合意）。
- 本文は i18n（`member.mail_subject` / `member.mail_body`）。コードは件名にも入れる（スマホの通知で読める）。ショップ名を件名と本文に入れる。
- 送れなかったら（送り手の 4xx / 5xx・SMTP の 4xx / 5xx）「メールを送れませんでした。時間をおいてお試しいただくか、ショップにお問い合わせください」。送信元が無い・送り手の値が足りないときは「ショップのメールの設定が済んでいません」（`createMailer` が null）。
- ~~後で: SMTP など Resend 以外の送り手~~（2026-10-23。上記）。

## 8. 今あるものからの移り方

**実稼働の前に入れたので、古い版（Supabase Auth の会員）との互換は持たない**（人間の指示、2026-10-16）。0012 で次を消した:

- RLS の `customers_self`・`orders_customer_select`・`order_items_customer_select`（`auth.uid()` の会員の経路）。2 段階にしない。
- 0011 の `banto_users_by_email`・`import_customers`（Auth のユーザーを作る取り込み）。`import_members` に置き換えた。
- 会員のパスワード・会員登録・パスワードを忘れた方・Supabase のメールのリンクの戻り先の画面と、`src/auth/supabase.ts` の会員用のメソッド（`signUp`・`getUser` も）。`/members/config` の Supabase の値。
- `restore_shop_data` は会員を auth.users と突き合わせずに戻す（同じメールアドレスの重なり・アドレスの無い行は飛ばす）。

デモの環境に残る Supabase Auth の会員のユーザーは、Supabase の Authentication → Users で手で消す（片付けのボタンは作らない）。

## 9. 速度の予算

- ログインの開始: RPC 1 回 + メールの送信 1 回。照合: RPC 1 回。
- 会員ページ: 今と同じ往復数（RLS の読み取りが RPC 1 回に置き換わる）。`test/perf-budget.test.ts` に会員ページを足して固定する。
- カート・商品・確認画面: 増やさない（世代の確認は予約に紐づけるときの RPC の中）。

## 10. テスト（実 PostgreSQL、`test/db/member-auth.test.ts`）

- 5 回間違えたら正しいコードでも通らない。新しいコードを出したら前のコードは通らない。
- 期限切れ・使用済みは通らない。同じリンクを 10 本同時に照合して、成功は 1 回だけ。
- 他店のチャレンジ ID・コードは通らない。
- 発行の上限（15 分に 5 回・1 日 20 回・IP ごと）で `send: false`、応答の形は同じ。
- 世代を上げたら古い世代のセッションで会員の RPC が通らない。
- anon / authenticated から RPC と表が見えない（`permission denied`）。
- 画面のテスト（`test/members.test.ts`）: 確認画面は GET では使わない、Referrer-Policy、マスクしたアドレス、メールを送れないときの表示、ヘッドレスの login → verify → refresh、`return_to` の許可リスト。

## 11. 後で足すもの（順番は人間と相談）

1. LINE ログイン（日本の小さな店ではいちばん要望が多いはず）。店ごとの OAuth の設定（チャネル ID は DB、チャネルシークレットは Secret）。
2. Google ログイン。
3. パスキー（WebAuthn）。パスワードなしのまま強い。店のドメインごとに登録する形になる。
4. 「新しい端末からログインしました」の通知。
5. 店をまたいで覚えてもらう層（Shopify の Shop Pay にあたるもの）。要望が出たら、別の設計書で。

## 12. 人間と合意したこと（2026-10-16）

1. ログインはコードとリンク。第 1 段階ではパスワードは無し（第 2 段階は §13）。
2. 初回のログインでそのまま会員になる。ログイン画面に「初めての方は、このまま会員登録になります」とプライバシーポリシーへのリンクを出す。
3. ログインのメールはコアがその場で送る（CLAUDE.md §2 の例外）。
4. セッションは 30 日、会員ページを開くたびに延ばす。
5. ~~Supabase に残る会員のアカウントの片付けはボタンで用意する~~ → 実稼働の前なので作らない（人間の指示、2026-10-16）。互換も持たない（§8）。

## 13. 第 2 段階: パスワード（人間と合意、2026-10-16 に実装。`0013_member_password`）

- **パスワードでのログインは店ごとに選べる**（既定はオフ。コードとリンクはいつでも使える = パスワードを忘れたときの入口）。
- 照合は **Postgres の pgcrypto（`crypt()`、bcrypt）** で行う。Worker の CPU（無料プラン 10ms）を使わない。回数の制限は重い計算の **前** に確かめる（総当たりで DB の CPU を使い切られないように）。パスワードは Worker を通る（保存しない・ログに出さない）。
- 使い回しのパスワードを試される攻撃への備え: アカウントごと・IP ごとの上限、失敗が続いたらコードに切り替える、ログインの成功を知らせるメール。
- **WordPress のパスワードの取り込み**: bcrypt の形式だけを移す（`$wp$2y$…` = WordPress 6.8 以降、`$2y$…` = bcrypt にしているプラグイン）。`$P$…`（phpass、MD5 ベース）は移さず、その会員は初回だけコードで入る。WordPress を 6.8 に上げても、保存済みのパスワードは本人が次にログインするまで `$P$` のままなので、**バージョンではなくハッシュの形式で選ぶ**（よくログインする会員ほど bcrypt になっている）。
  - 6.8 以降の形式は「パスワードを HMAC-SHA384（鍵 `wp-sha384`）にかけて base64 にしたもの」を bcrypt したもの。pgcrypto の `hmac()` と `crypt()` で照合する。**pgcrypto は `$2y$` / `$2b$` を bcrypt と読まない（DES として扱う）** ので、`$2a$` に読み替えて照合する（`banto_wp_password_matches`）。WordPress は保存時に前後の空白を落とすので、合わなければ前後の空白を落として 1 回だけ試し直す。PHP の `password_hash` で作ったテスト用の合成ハッシュで確かめた（`test/db/member-password-line.test.ts`）。
  - ハッシュは REST API では取れないので、WordPress の DB（`wp_users.user_pass`）から CSV で書き出してもらう。ブラウザで読んで小分けに送り、Banto には保存しない。画面に「取り込んだら書き出したファイルを削除してください」と出す。
  - 初めてログインに成功した時点で Banto の bcrypt に保存し直し、元のハッシュは捨てる。180 日使われなかった元のハッシュは消す。
- 実装: `member_password_login`（失敗は `member_login_failures` に記録、例外にしない）・`member_set_password`（世代を上げる）・`import_member_passwords`（bcrypt の形式だけ、会員がいなければ作る、Banto のパスワードは上書きしない）。会員がいないときもダミーの bcrypt を 1 回計算して、応答の時間で登録の有無が分からないようにする。
- 後で: パスワードでのログインに成功したことを知らせるメール（使い回しのパスワードの対策）。

## 14. LINE・Google でのログイン（人間と合意、2026-10-16 に実装。`0014_member_oauth`・同梱モジュール `line_login` / `google_login`）

- **置き場所**: ログインの判定と会員の結びつけはコア（`member_oauth_login`）、提供元の仕様に依存する部分は同梱モジュール（既定 OFF、基準 (4)）。`src/modules/social-login/`（`providers.ts` に LINE と Google、`admin.tsx` にショップごとの設定画面）。
- **秘密はショップごと（人間の決定）**: 最初はデプロイに 1 組（Workers Secret）で作ったが、「ショップごとに分けないのは矛盾する。Google では複数ショップを運営するとき同意画面をショップ名にできない」との指摘で、ショップごとにした（CLAUDE.md §1-5 の例外）。
  - client_id は公開してよい値なので `shops.settings.oauth.<provider>.client_id` に写す（ボタンの表示と認可の URL に使う。キャッシュ済みのショップ行だけで判定でき、DB に問い合わせない）。
  - シークレットは Worker がサイトの秘密から作った鍵（HMAC で用途を分けた 256 ビット）で AES-GCM で暗号化し、暗号文だけを `shop_oauth_clients.secret_box` に置く（`src/members/secret-box.ts`）。追加認証データにショップ ID と提供元を入れるので、暗号文を別の行に移しても開けない。
  - 運営者は `shop_oauth_client_save` / `_delete`（owner の JWT）で書き、暗号文の列は列の権限で読めない。読むのは service_role の `shop_oauth_client` だけ（戻ってきたときに 1 回）。
  - サイトの秘密（`SESSION_SECRET`）を変えると開けなくなる。そのときはログインに失敗し（提供元には何も送らない）、運営者が入れ直す。
- **流れ**: OpenID Connect の認可コード + PKCE（S256）+ state + nonce。途中の値は署名付き Cookie（`banto_oauth`、Path=/_oauth、10 分、SameSite=Lax）。戻り先は提供元ごとに 1 つ（`/_oauth/<provider>/callback`。`_` はショップのスラッグに使えないので衝突しない）。どのショップかは Cookie の中身で分かる。
  - LINE は ID トークンを検証 API（`/oauth2/v2.1/verify`）で確かめる。Google はトークンのエンドポイントから HTTPS で直接受け取り、クライアントシークレットで認証しているので署名の検証を省く（OpenID Connect Core 3.1.3.7、Google の案内）。どちらも iss・aud・nonce（Google は期限も）を自分で見る。
- **結びつけ**: 鍵は提供元の利用者 ID（`member_identities`、ショップ × 提供元 × 利用者 ID、1 会員に提供元ごと 1 つ）。確認済みのアドレス（Google の `email_verified`、LINE は返れば確認済み）だけ同じアドレスの会員に結びつける。ログイン中の会員はマイページから連携できる（state に会員 ID と世代を入れ、戻ったときに世代を確かめる）。アドレスの無い会員は連携を外せない（`last_login_method`）。
- **ヘッドレス**: Banto から提供元へ送り出し、戻ったら許可リストの `return_to` に **引き換え券**（`member_handoffs`、2 分・1 回限り、トークンは HMAC で保存）を付けて戻す。連携側は `/members/verify` `{ handoff }` で会員のトークンに替える。
- **ログイン CSRF**: state は利用者のブラウザの Cookie と照合するので、他人の戻り URL を踏まされてもログインしない（テストあり）。
- 後で: LINE の Messaging API での注文通知。（ショップごとの独自ドメインの戻り先は §15 で実装）

## 15. ショップごとの独自ドメインと戻り先（人間の指示、2026-10-16 に実装。`0015_shop_domain`）

- 人間の指示: 「ショップごとの独自ドメインを入れるときは、戻り先もそのドメインにする」。Google の同意画面・承認済みドメインをショップのものにでき、会員から見て店のサイトの中でログインが完結する。
- `shops.domain`（ホスト名、小文字、一意、形は DB の制約で検査）。公開中のショップなら anon から読める（ホスト名は公開情報）。
- **振り分け**（`src/routes/storefront/domain.ts`）: Host がショップのドメインなら、パスの前にスラッグを足して同じストアフロントのルートで処理する（Hono の中で `app.fetch` し直す。ルートを二重に持たない）。`/admin` `/api` `/mcp` `/webhooks` `/media` `/health` `/_oauth` `/robots.txt` `/sitemap.xml` はそのまま。テーマは `shopPath` が `""` になるだけ（もともと `shopPath || "/"` で書いてある）。
  - ホスト名 → ショップは anon の 1 回の問い合わせを isolate に 30 秒覚える（無いホストも覚える）。`PUBLIC_BASE_URL` のホスト・`*.workers.dev`・localhost では引かない（速度の予算は変わらない）。
  - Banto の URL でショップのページを開いたら（GET `/<スラッグ>/…`）ドメインへ 302 で転送する。会員の Cookie と戻り先がドメインごとなので、ショップの画面を 1 つのドメインにそろえる。301 にしないのは、運営者がドメインを外したときにブラウザが転送を覚えたままになるため（検索エンジンには canonical で伝える）。
- **戻り先**（`src/storefront/urls.ts` の `shopHome` / `shopOrigin` に集約）: LINE・Google の `redirect_uri`（`https://<ドメイン>/_oauth/<提供元>/callback`）、ログインのメールのリンク、決済の success / cancel、確認画面の法務ページの URL、取引メールの注文照会、クーポンのリンク、ヘッドレスの `checkout_url`、canonical・サイトマップ。
  - LINE・Google は **ドメインの上で始める**（state の Cookie はホストごと）。Banto の URL の入口（テーマ・ヘッドレス API）は、ドメインの同じ入口へ転送してから始める。state に始めたときの origin とパスを入れ、戻ったときはそれで `redirect_uri` を組み直す（Host は使わない）。
- **Host を信じてよいか**: Cloudflare では、そのホスト名がこの Worker に向いているときだけ届く。Node で Host を偽っても、見えるのはそのショップの公開ページだけで、Cookie はホストごとなので他のショップのログインには触れない。戻り先は DB の domain から組む。
- **落とし穴（2026-10-16、実機）**: ショップ行を読む列に `domain` を足したため、コードが先にデプロイされて `0015` を適用する前の DB では PostgREST が 42703（列が無い）を返し、ストアフロントがすべて 500 になった。Workers Builds は main に入るとすぐデプロイするので、**コードとデータベースの更新のあいだ** は必ずある。v0.1.0 からは、新しい列を読むときは `migrated()`（`src/db/migration-state.ts`）で適用済みかを見てから列を選ぶ（CLAUDE.md §11「コードと DB の版のずれ」。0015 の分の読み直しは v0.1.0 の土台に入ったので消した）。
- **他人同士を同居させる場合に要るもの**: ドメインの所有の確認（今は「先に Cloudflare で Worker に付けて開けることを確かめてから保存」を運営者に案内するだけ。見知らぬ他人同士が同居しない前提 §3 なので、先取りされる心配は運営者の中に閉じる）。ホスティングの提供者は Cloudflare for SaaS（カスタムホスト名、所有の確認と証明書）を `DomainAdapter` の裏に置く（2026-10-23 に継ぎ目を入れた）。

## 16. パスワードでのログインの知らせと HTML のメール（2026-10-16 に実装。`0016_member_notice`）

- **知らせ**: パスワードでログインに成功したら、会員のアドレスに「パスワードでログインしました」を送る（使い回しのパスワードで入られたときに本人が気づけるように。§13 の「後で」）。
  - 同じ端末で前にこの会員がログインしていれば送らない。端末の印は Cookie（`banto_member_dev_<ショップ>`、400 日、中身は「ショップ × 会員」の HMAC だけ）。コード・リンク・LINE / Google・パスワードのどれでログインしても付ける。
  - ヘッドレス（`password-login`）には端末の印が無いので毎回送る。
  - 送信元は `member_password_login` が返す（`0016` で差し替え、メール通知プラグインの「送信元」）。0016 の前・プラグインが無効なら送らない（ログインは止めない）。
  - 送るのは応答の後（`afterResponse`: Workers は `waitUntil`、Node とテストはその場で待つ）。失敗はログにだけ残す。
- **HTML のメール**（`src/mail/html.ts`）: ログインのコードと知らせは、テーマ設定のロゴ（https のみ）とアクセントカラー（`#rrggbb` のみ）で HTML にする。テキスト版も必ず付ける。値はすべてエスケープし、ボタンの URL は http(s) だけ。見た目はインラインの style だけ（メールソフトが `<style>` を落とすため）。

## 17. 端末ごとのセッション（監査 M9、2026-10-23 に実装。`0045_member_sessions`）

- **なぜ**: それまでのセッション（Cookie・`bm1.`）はサーバーに状態が無く、止められるのは「全端末からログアウト」（世代を上げる）だけだった。ログアウトしても盗まれた Cookie は 30 日使え、refresh は回らず、使い回しにも気づけなかった。トークンの中身（署名付きの平文）にメールアドレスが入っていた。
- **形**: ログインのたびに `member_sessions` に 1 行（ショップ・会員・世代・種類 web / api・端末の目安・絶対の期限 90 日）。Cookie とトークンにその ID（sid）を入れる。端末の目安はブラウザと OS の名前だけ（`deviceLabel`。User-Agent・IP は置かない）。1 人 20 行まで（超えたら古いものから取り消す）。
- **Cookie**: `SESSION_CHECK_SECONDS`（5 分）ごとに `member_session_check` で行を確かめ直し、確かめた時刻（`chk`）を Cookie に入れる。毎回は問い合わせない（速度の予算は変えない。会員ページは今までどおり `member_get` 1 回）。そのため取り消しが効くまで最大 5 分。確かめるときに DB が失敗したら、そのリクエストだけゲスト扱い（Cookie は消さない）。
- **ヘッドレス**: access は 15 分（1 時間から短くした。DB で確かめないので、取り消しが効くまでの最大の時間になる）。refresh は 1 回ごとに世代（`refresh_gen`）を進める。トークンは署名付きなので、DB には世代の数だけ置けばよい（refresh のハッシュは要らない）。前の世代は回した直後の 30 秒だけ通す（同時の呼び出し）。それより古い世代を使ったら行ごと取り消す（盗んだ側と本人のどちらが先か分からないので両方を止める）。
- **世代との関係**: 行は作ったときの世代を持ち、今の世代と違えば通らない。パスワードを変えた端末は新しい世代で新しい行を作る（ほかの端末は世代で止まる）。
- **0045 を当てる前後**: 当てる前は sid の無い今までの形で動く（`migrated()`）。当てた後は sid の無い Cookie・refresh を通さない（行が無いと取り消せないため。会員は 1 回ログインし直し）。access は 15 分以内に切れるので確かめない。
- **画面と API**: お店の画面の「ログイン中の端末」（`/account/sessions`、テーマの任意の部品 `MemberSessionsPage`）、ヘッドレスの `/members/sessions`・`/members/sessions/:id/revoke`・`/members/logout`。
- **片付け**: Cron の `member_login_cleanup` が、期限切れ・取り消してから 1 日・古い世代の行を消す（0045 を当てた後だけ）。退会で行も消える（外部キー）。

## 18. パスキー（人間の決定、2026-10-23 に実装。`0046_mod_passkey`・同梱モジュール `passkey`）

- **いつ出すか**: 2026-10-17 の「v0.1 の後」を、人間が 2026-10-23 に「実装したい」と変えた。前提の M9（端末ごとのセッション、§17）を先に入れた。
- **RP ID = ショップのドメイン**（人間と合意）。親ドメインにすると、その下のどのサブドメインのページ（同じドメインのブログの XSS 等）からでも呼べてしまう。独自ドメイン（`shops.domain`）の無いショップには出さない（Banto の URL にパスで同居するショップ同士で RP ID を共有しないため）。ショップごとのサブドメインで預かる形なら、RP ID はそのサブドメインにし、共通の親ドメインそのものは使わない。
- **置き場所**: 使わない人が多い（基準 (3)）ので既定 OFF の同梱モジュール。署名の検証は `src/members/webauthn.ts`（WebCrypto、ライブラリなし。CBOR は必要な部分だけ、長さ不定・浮動小数点・タグは読まない）、ルートは `src/routes/storefront/members.ts` の「パスキー」の節、ブラウザのスクリプトは `src/modules/passkey`（テーマが `<script src>` で読む。ビルドを通さない ES2017 の文字列）。
- **確かめること**: clientDataJSON の type・challenge・origin（`https://<ドメイン>` だけ）・crossOrigin、rpIdHash、UP と UV（本人確認を必須にする）、BS は BE なしに立たない、公開鍵の形（ES256 / EdDSA / RS256 は 2048 ビット以上）、ECDSA の DER を厳密に、ログインでは保存した鍵で `authenticatorData || SHA-256(clientDataJSON)` の署名。認証器の証明（attestation）は求めない（`none`。機種で絞らない）。
- **DB で確かめること**: challenge は 5 分・1 回限り・目的（login / register）と会員とセッションに結びつく（Worker が HMAC にして渡す）。署名の回数が前より進んでいない（どちらも 0 なら数えない認証器）なら複製の疑いで通さない。ログインは今のドメインで登録したパスキーだけ。認証器が返した利用者の ID（会員 ID の 16 バイト）がそのパスキーの会員と違えば通さない（Worker）。ログインの challenge は同じ IP から 10 分に 30 回まで。
- **追加はログインしてから 15 分以内**（`member_sessions.created_at`）。盗まれた Cookie でパスキーを足されると、セッションを取り消しても入れてしまうため。追加したら本人にメールで知らせる。過ぎていたら、マイページから確かめのコードを送り、ログインし直してから戻る（ログインし直した端末の前のセッションは取り消す）。
- **消えるとき**: 会員が消す・運営者が全部消す（`member_passkeys_reset`、項目 customers）・退会。世代（全端末からログアウト・メールアドレスの変更）では消えない（パスキーは「その人の端末」で、ログインの状態ではないため）。乗っ取りの救済では運営者が全部消す。
- **ヘッドレス**: 連携サイトの画面の上では使わない（RP ID がショップのドメインなので）。`/api/shops/:shop/members/passkey` → ショップのドメインのパスキーだけの画面 → 引き換え券（LINE・Google と同じ）。
- **本物のブラウザでの確認**（2026-10-23）: Chromium（Playwright）の仮想の認証器で、ES256・EdDSA・RS256 の応答が検証を通ることと、お店の画面の「追加 → ログアウト → パスキーでログイン」が通しで動くことを確かめた（テストの認証器 `test/webauthn-authenticator.ts` は、検証の部品とは別に CBOR を組む）。このときに、会員の画面の `Referrer-Policy: no-referrer` のせいでフォームの POST が `Origin: null` になり、csrfGuard（0031 の Low の修正で null を拒む）に拒まれていた既存の不具合を見つけて直した（03-pitfalls.md）。
- **後で**: ログイン画面のメールアドレスの欄でパスキーを候補に出す（conditional UI）、連携サイトの画面の上で直接使う（Related Origin Requests）、運営者の会員の画面にパスキーの数を出す。


- **ヘッドレスの追加（2026-10-28、0070）**: 会員トークン（ログインしてから 15 分以内の api のセッション）で `member_passkey_ticket_create` の券（2 分・1 回限り）→ ショップのドメインの `/account/passkey/add`（GET は確かめ、POST で `member_passkey_ticket_take`）→ 新しい web のセッション → 既存の追加の API（`return_to` があれば、済んだらそのセッションを取り消して連携サイトへ）。
