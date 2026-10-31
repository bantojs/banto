-- Banto 0082_page_media_thumb: メディアライブラリの一覧用の小さい画像（ページ・記事の本文の画像）。前方専用。
-- これまで一覧は本画像（長辺 1600px）をそのまま並べていた。画像を置くときに管理画面（ブラウザ）が
-- 長辺 400px の縮小版も作って送り（商品の画像と同じ。サーバーでは画像を処理しない、CLAUDE.md §10 Step 4）、
-- その URL を thumb_url に残す。無い行（前に置いた画像・縮小に失敗したとき）は本画像で並べる。
-- 足すだけの変更（列 1 つ）。権限・RLS は 0080 のまま（insert の権限は表ごとなので新しい列にも効く）。

alter table page_media add column if not exists thumb_url text
  check (thumb_url is null or (char_length(thumb_url) <= 2000 and thumb_url ~ '^(https?://|/)[^\s<>"''`]*$'));

insert into banto_migrations (version) values ('0082_page_media_thumb');
