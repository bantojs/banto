-- Banto 0112_product_pick: 本文の「商品を並べる」で、選んだ商品を書いた順に並べる（::: products slugs=a,b,c、docs/pages.md）。前方専用。
--   - 一覧（0058 の product_public_list）と同じ形の行を、slug の並びの順で返す。見えない商品（非公開・会員限定で合わない）は飛ばす
--   - 本文の商品のブロックの slug をまとめて 1 回で引く（ブロックごとに問い合わせを増やさない）。100 個まで
--   - ゲストは product_public_pick（anon）、会員は product_member_pick（service_role、0098 と同じくセッションを確かめて会員の条件を足す）

create or replace function banto_product_pick(p_shop_id uuid, p_slugs text[], p_audiences uuid[] default '{}')
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if p_slugs is null or not exists (select 1 from shops where id = p_shop_id and published) then
    return jsonb_build_object('items', '[]'::jsonb);
  end if;
  if cardinality(p_slugs) > 100 then raise exception 'too_many_slugs' using errcode = '22023'; end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', p.id, 'slug', p.slug, 'name', p.name, 'brand', p.brand, 'category_id', p.category_id,
        'extra_category_ids', p.extra_category_ids, 'tags', p.tags, 'created_at', p.created_at, 'updated_at', p.updated_at,
        'min_price_jpy', p.list_price_jpy, 'compare_at_price_jpy', p.list_compare_at_jpy,
        'image', (select jsonb_build_object('storage_key', i.storage_key, 'thumb_key', i.thumb_key, 'width', i.width, 'height', i.height, 'variants', i.variants, 'thumb_width', i.thumb_width)
                    from product_images i where i.product_id = p.id order by i.sort_order, i.created_at limit 1))
      order by w.ord)
      from unnest(p_slugs) with ordinality w(slug, ord)
      join products p on p.shop_id = p_shop_id and p.slug = w.slug
     where p.published and (p.audience_id is null or p.audience_mode = 'buy' or p.audience_id = any(coalesce(p_audiences, '{}')))
  ), '[]'::jsonb));
end;
$$;
revoke execute on function banto_product_pick(uuid, text[], uuid[]) from public, anon, authenticated;

create or replace function product_public_pick(p_shop_id uuid, p_slugs text[])
returns jsonb language sql stable security definer set search_path = public as $$
  select banto_product_pick(p_shop_id, p_slugs, '{}'::uuid[]);
$$;
revoke execute on function product_public_pick(uuid, text[]) from public;
grant execute on function product_public_pick(uuid, text[]) to anon, authenticated, service_role;

create or replace function product_member_pick(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid, p_slugs text[])
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_aud uuid[] := '{}';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'product_member_pick: service_role only' using errcode = '42501';
  end if;
  if banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then
    v_aud := banto_member_audience_ids(p_shop_id, p_customer_id);
  end if;
  return banto_product_pick(p_shop_id, p_slugs, v_aud);
end;
$$;
revoke execute on function product_member_pick(uuid, uuid, integer, uuid, text[]) from public, anon, authenticated;
grant execute on function product_member_pick(uuid, uuid, integer, uuid, text[]) to service_role;

insert into banto_migrations (version) values ('0112_product_pick');
