# 会員のお気に入り（同梱モジュール `favorites`）

お客様が商品を「お気に入り」に入れられるようにします（メンテナの決定 2026-11-06、`0123_mod_favorites`）。既定は OFF です。管理画面の「モジュール」で ON にします（データベースの更新 0123 が当たってから）。

- **会員**: お気に入りは Banto に残り、端末をまたいで使えます。会員ページに並びます。
- **ゲスト**: ブラウザ（localStorage）に 50 個まで覚えます。ログインすると会員のお気に入りに移り、ブラウザの分は消えます。会員機能が OFF のショップでは、ブラウザに覚えるだけです。
- **運営者**: 会員ごとのお気に入りと、商品ごとの人数を見られます。
- **外部プラグイン**: AI 用 API と hooks で受け取れます。「お気に入りの商品が値下げされた・入荷した」のようなお知らせは、プラグインが送ります（Banto は送りません。配信の機能はコアに入れない決まりのとおり）。

## 決まり

- 1 人 **200 個まで**（`favorites_full`）。
- **書くのは本人だけ**。運営者の画面からも AI 用 API からも足したり外したりはできません（案内メールの同意と同じく、本人の行為として扱う）。
- 足せるのは、その人に見える商品だけです（公開中で、会員限定の商品は条件に合う人だけ）。公開を止めた商品は本人の一覧から見えなくなり、また公開すれば戻ります。
- 商品を消すと、その商品のお気に入りも消えます。会員が退会すると、その人のお気に入りも消えます。
- 運営者の JSON の書き出し（バックアップ）に入ります（`customer_favorites`）。復元では戻しません（会員と商品の id を振り直すため）。

## お店の画面

テーマは押すところに `data-banto-favorite="<商品の id>"` を付けるだけです。Banto のスクリプト（お店の画面の `<head>` に入る）が押せるようにします。

- 押してあるかは `aria-pressed="true"` と class `is-active` で分かります。見た目はテーマの CSS で決めます。
- 押すと、ブラウザの `banto:favorite` の出来事（`detail` に `product_id` と `on`）が起きます。数の表示などに使えます。
- 会員のとき、押してあるかはページの HTML に入れず、スクリプトが自分の一覧を 1 回取ってきて塗ります（お店の画面のキャッシュを崩さない・主要なページの DB の往復を増やさないため）。
- 既定のテーマは、商品ページの商品名の下と、一覧のカードの右上にハートを出します。
- 会員ページに「お気に入り」の欄（新しい順、外すボタン付き）が出ます。
- Liquid のテーマ: `shop.favorites_enabled` が ON か、`customer.favorites`（会員ページ、一覧と同じ `product` の形）、`customer.favorites_remove_url`（`product_id` を POST すると外す）。

```liquid
{% if shop.favorites_enabled %}
  <button type="button" class="fav" data-banto-favorite="{{ product.id }}" aria-label="お気に入り">♥</button>
{% endif %}
```

- お店の画面の口（スクリプトが使う。同じオリジンからだけ）: `GET <ショップ>/account/favorites.json`（`{ ids, member }`）、`POST <ショップ>/account/favorites`（`{ product_id, on }` か `{ merge: [...] }`）。

## 出来事（分析・行動の中継）

- 足した・外したは中立の出来事 `favorite_add` / `favorite_remove`（`product_id`）です。行動の中継（docs/event-relay.md）で、許した連携に渡ります。
- GA4（docs/ga4.md）には、足したときに `add_to_wishlist` を送ります（`item_id` は商品の id）。

## ヘッドレス（会員トークン）

| 操作 | エンドポイント |
| --- | --- |
| 本人のお気に入り（新しい順。商品の中身は公開の商品 API で） | `GET /api/shops/:shop/members/favorites` |
| 足す・外す | `POST /api/shops/:shop/members/favorites`（`{ product_id, on }`） |
| 連携サイトのブラウザに覚えたゲストの分を移す（50 まで） | `POST /api/shops/:shop/members/favorites/merge`（`{ product_ids }`） |

## 運営者・AI 用 API・hooks

- 管理画面: 会員の一覧の「操作」→「お気に入り」で、その人のお気に入り（項目 `customers`）。商品の一覧に「お気に入り」の人数の列（項目 `catalog` でも見えるのは人数だけ、`product_favorite_counts`）。
- AI 用 API（スコープ `customers:read`。docs/ai-access.md §15）:
  - `GET /api/v1/customers/<id>/favorites`: その会員のお気に入り（新しい順）。
  - `GET /api/v1/favorites?product=&since=&after=&limit=`: 足した順にたどる一覧。続きは応答の `cursor` の `since` と `after` を渡す。
  - MCP の `favorites_list`。
  - 返すのは会員 ID・商品 ID・商品の URL の名前・足した日時だけです。
- hooks: `favorite.added` / `favorite.removed`（ペイロードは `shop_id`・`customer_id`・`product_id` だけ。個人情報は載せない）。会員や商品を消したときの連鎖の削除では `favorite.removed` を送りません（`customer.deleted`・商品の削除で分かるため）。

## 個人情報

お気に入りは会員の行動の記録です。運営者と、運営者が許した外部プラグインが読めるので、プライバシーポリシーに「お気に入りの情報を、品ぞろえやお知らせのために使う」ことを書いておいてください。
