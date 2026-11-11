-- Banto 0138_product_images_order: 商品の画像の並びを 1 回で書く（管理画面の画像のまとめ方の並べ替え、メンテナの決定 2026-11-08）。前方専用。
--
-- product_images_order(p_shop_id, p_product_id, p_ids): その商品の画像の id を、並べたい順に全部受け取り、sort_order を 0 から振り直す。
--   - 1 つの update で書く（画像の数だけ Worker から送ると、Workers の無料プランの外部呼び出し 50 回に届き、途中で止まると半分だけ振り直される）
--   - id はその商品の画像ちょうど全部（足りない・余る・重なる・他の商品の画像があれば invalid_images。何も変えない）
--   - 項目 catalog。読み書きはどれも shop_id と product_id で絞る（security definer）

create or replace function product_images_order(p_shop_id uuid, p_product_id uuid, p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  if not banto_shop_perm(p_shop_id, 'catalog') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  perform 1 from product_images where shop_id = p_shop_id and product_id = p_product_id order by id for update;
  if p_ids is null or cardinality(p_ids) > 500
     or cardinality(p_ids) <> (select count(distinct x) from unnest(p_ids) x)
     or cardinality(p_ids) <> (select count(*) from product_images where shop_id = p_shop_id and product_id = p_product_id)
     or exists (select 1 from unnest(p_ids) x where not exists (select 1 from product_images i where i.id = x and i.shop_id = p_shop_id and i.product_id = p_product_id)) then
    raise exception 'invalid_images' using errcode = '22023';
  end if;
  update product_images i set sort_order = x.ord - 1
    from unnest(p_ids) with ordinality x(id, ord)
   where i.id = x.id and i.shop_id = p_shop_id and i.product_id = p_product_id and i.sort_order is distinct from (x.ord - 1)::integer;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function product_images_order(uuid, uuid, uuid[]) from public, anon;
grant execute on function product_images_order(uuid, uuid, uuid[]) to authenticated;

insert into banto_migrations (version) values ('0138_product_images_order');
