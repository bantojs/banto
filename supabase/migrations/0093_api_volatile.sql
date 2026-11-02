-- 0092 の api_image_settings を volatile にする。
-- stable の関数は PostgREST が読み取り専用の取引で実行する。中で呼ぶ api_require はトークンの最終利用（last_used_at）を
-- 書くことがあるので、「読み取り専用の取引では UPDATE できない」で失敗していた（AI 用 API の GET /image-settings が 502）。
-- ほかの api_* と同じく既定（volatile）に戻す。test/db/api-volatility.test.ts が、api_require を呼ぶ関数に stable / immutable が無いことを確かめる。
-- 同じ確かめで 0008 の api_categories_list も stable だった（GET /api/v1/categories と MCP のカテゴリーの一覧が、前の利用から 1 分あくと失敗する）ので、一緒に直す。
alter function api_image_settings(text) volatile;
alter function api_categories_list(text) volatile;

insert into banto_migrations (version) values ('0093_api_volatile');
