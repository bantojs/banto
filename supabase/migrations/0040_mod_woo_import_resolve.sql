-- Banto 0040_mod_woo_import_resolve: 大きすぎる画像を管理画面のブラウザで縮小して取り込んだとき、裏の取り込みの予約を「取り込み済み」にする。docs/woo-import.md
-- 前方専用。Cron は 5MB を超える画像を too_large で失敗にする（サーバーでは縮小しない）。管理画面がブラウザで縮小して送ったら、
-- その URL の予約（失敗・待ち）を done にして、「取り込めなかった画像」から外す。

create or replace function image_import_resolve(p_shop_id uuid, p_product_id uuid, p_url text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if not banto_shop_perm(p_shop_id, 'catalog') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  update image_import_jobs set status = 'done', last_error = null
   where shop_id = p_shop_id and product_id = p_product_id and url = p_url and status in ('pending', 'failed');
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function image_import_resolve(uuid, uuid, text) from public, anon;
grant execute on function image_import_resolve(uuid, uuid, text) to authenticated, service_role;

insert into banto_migrations (version) values ('0040_mod_woo_import_resolve');
