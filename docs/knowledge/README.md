# ナレッジベース（開発を引き継ぐ人・AI のために）

別のセッション・別の人が Banto の開発を続けるときに、まずここを読む。CLAUDE.md が「守るべき規約」、ここは「ここまでに分かったこと・決めたこと」。

| ファイル | 内容 |
| --- | --- |
| [02-decisions.md](02-decisions.md) | 設計判断とその理由。「なぜそうなっているか」を蒸し返さないため |
| [03-pitfalls.md](03-pitfalls.md) | 実機で踏んだ落とし穴（Cloudflare / Supabase / Stripe / Resend）。症状 → 原因 → 対処 |
| [05-map.md](05-map.md) | コードの地図。どの機能がどのファイルにあるか |
| [08-woo-migration.md](08-woo-migration.md) | WooCommerce からの移行に向けた機能計画。コア / 同梱モジュール / 外部プラグインの振り分けと順番 |
| [10-members-identity.md](10-members-identity.md) | 会員のアカウントを店ごとに Banto が持つ設計（Shopify 型。メールのコードとリンク、店ごとに選べるパスワードと WordPress のパスワードの取り込み、ショップごとの設定の LINE・Google でのログイン）。脅威モデル・表と RPC・回数の制限・ヘッドレス |
| [11-organizations.md](11-organizations.md) | 組織・メンバー・役割（owner / admin / ショップの担当 / 実店舗のスタッフ）と、実店舗を組織に置いてショップごとに使い分ける設計（**決定・実装済み**、0024〜0027）。権限の項目・招待・移行・実装メモ |
| [09-coupons.md](09-coupons.md) | クーポン（値引き）の設計。判定はコア・混合型（公開コード / 配布型 / 使い捨てコード）・Stripe への渡し方・枠の取り合いで遅くならない仕組み・次に作るもの |
| [13-external-customer-master.md](13-external-customer-master.md) | 顧客マスタの外部連携（HubSpot・独自マスタ）。項目ごとに向きを 1 つ、Banto 自身を顧客マスタとして使う |

更新のルール: 実機で新しい事実が分かったら 03 に、設計を決めたら 02 に、予定が変わったら docs/ROADMAP.md に書く。日付を添える。テストやビルドの回し方は CONTRIBUTING.md。
