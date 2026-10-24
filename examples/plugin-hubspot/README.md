# 外部プラグインの実例: HubSpot 連携

Banto の会員の出来事（登録・プロフィールの変更・退会）を受け取って、HubSpot の Contacts に写す最小の外部プラグインです。
**Banto 本体のコードは一切読み込まず**、docs/hooks.md と docs/ai-access.md の契約（マニフェスト・署名・再送・API）だけで動きます。
[examples/plugin-slack](../plugin-slack/) と同じ型です。

| ファイル | 役割 |
| --- | --- |
| `src/plugin.ts` | 本体。`handleRequest(req, env, deps)` の 1 関数。ランタイムに依存しない |
| `src/index.ts` | Cloudflare Workers の入口 |
| `wrangler.toml` | Workers の設定 |
| `../../test/plugin-example-hubspot.test.ts` | Banto 本体の署名実装と突き合わせるテスト（本体のリポジトリで `npm test`） |

## 向き（docs/knowledge/13-external-customer-master.md）

| 項目 | 正 | この例でやること |
| --- | --- | --- |
| メールアドレス・氏名・住所 | Banto | `customer.created` / `customer.updated` を受けたら Banto の API（`customers:read`）でプロフィールを引き、HubSpot のコンタクトにメールアドレスで upsert |
| HubSpot のコンタクト ID | HubSpot | Banto の会員の `external_ref`（`{provider: "hubspot", id}`）に書き戻す（`customers:write`） |
| 退会 | Banto | `customer.deleted` を受けたら、設定が ON のときだけ HubSpot のコンタクトをアーカイブ |
| ランク・メルマガの同意などの属性 | HubSpot | **この例には含めない。** HubSpot のワークフローの Webhook や中継サーバーから Banto の `POST /api/v1/customers/upsert` に `attributes` を送る（docs/ai-access.md §7） |

hooks のペイロードに個人情報は入っていません。HubSpot に送る氏名・住所は、このプラグインが Banto の API で引きます。
そのトークンは会員の名簿そのものなので、この Worker の Secret にだけ置いてください。

## 置き方（Cloudflare Workers、開発者向け）

```bash
cd examples/plugin-hubspot
npm install
npx wrangler secret put HUBSPOT_ACCESS_TOKEN   # HubSpot の非公開アプリ（crm.objects.contacts.read / write）
npx wrangler secret put BANTO_API_URL          # https://<Banto の URL>/api/v1
npx wrangler secret put BANTO_API_TOKEN        # Banto の管理画面 → AI 連携（トークン）で発行（customers:read + customers:write）
npx wrangler deploy                            # https://banto-plugin-hubspot.<あなた>.workers.dev
```

1. Banto の管理画面 → ショップ → **連携** → **送信先を追加** に上の URL を入れる → マニフェストが読まれ、設定フォーム（退会でアーカイブ / 書き戻さない）が出る
2. 保存すると **署名シークレット** が表示されるので、`npx wrangler secret put BANTO_HOOK_SECRET` で貼る
3. **テスト送信**（banto.ping）を押す → 設定がプラグインに届く
4. 会員が登録・住所を変更すると、数分以内（hooks の配信は 5 分ごとの Cron）に HubSpot のコンタクトが作られる・更新される

## 動き

- 再送（同じ配信 ID）は二重に処理しない。Banto の API や HubSpot が落ちていれば 502 を返して Banto に再送してもらう（2, 4, 8, 16 分後、5 回まで）
- 書き戻すと Banto から `customer.updated` がもう 1 回届くが、`external_ref` が一致するので 2 回目は書き戻さない（ここで止まる）
- 同じ HubSpot の ID が別の会員に付いていて書き戻せない（409 `external_ref_taken`）ときは、再送しても直らないので進む。運営者が Banto の管理画面でメールアドレスを揃える
- メールアドレスの無い会員（LINE だけでログイン）は HubSpot で突き合わせられないので飛ばす
