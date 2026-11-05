-- Banto 0113_category_media: カテゴリーの説明と画像（docs/storefront.md「カテゴリーの画像と説明」）。前方専用。
--   - description: 文字だけ（2,000 字まで。HTML は書けない。描くときにエスケープして、空の行で段落に分ける）
--   - image: { key, width, height }。画像は管理画面のブラウザで縮小して置き場の categories/<ショップ>/ に置く（サーバーでは画像を処理しない）。
--     key はこのショップの置き場の場所だけ（ほかのショップ・商品の画像の鍵を指させない）。欠けた鍵は NULL になり CHECK を素通りするので coalesce で偽に
--   - 書くのは今までどおり categories の行（項目 catalog の RLS）。読むのも今までどおり（公開中のショップは anon も読める）

alter table categories add column if not exists description text;
alter table categories add column if not exists image jsonb;
alter table categories drop constraint if exists categories_description_check;
alter table categories add constraint categories_description_check check (description is null or char_length(description) <= 2000);
alter table categories drop constraint if exists categories_image_check;
alter table categories add constraint categories_image_check check (
  image is null or coalesce(
    jsonb_typeof(image) = 'object'
    and jsonb_typeof(image->'key') = 'string'
    and (image->>'key') ~ ('^categories/' || shop_id::text || '/[a-f0-9]{8,64}\.(webp|jpg|png|gif|avif)$')
    and jsonb_typeof(image->'width') = 'number' and jsonb_typeof(image->'height') = 'number'
    and (image->>'width')::numeric between 1 and 4096 and (image->>'height')::numeric between 1 and 4096,
    false)
);

insert into banto_migrations (version) values ('0113_category_media');
