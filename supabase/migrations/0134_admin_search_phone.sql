-- Banto 0134_admin_search_phone: 電話番号の検索で「+81 (0)90-…」の書き方も同じ番号として扱う。前方専用。
--
-- 0132 は電話番号を数字だけにしてから先頭の 81 を 0 に読み替えていた。日本の番号は国際表記でも「+81 (0)90-1234-5678」のように
-- もとの 0 を括弧で残すことがあり（名刺・メールの署名など）、数字だけにすると 8109… になって 0 が 2 つ並んでいた。
-- 読み替えを「先頭の 81 と、続く 0 があればそれも」（'^810?' → '0'）にする。インデックスの式と検索の値の両方をそろえる。
-- 日本の国内の番号は 0 で始まり、81 の次に国内の番号の 0 が来るのは括弧付きの書き方だけなので、ほかの番号は 0132 と同じになる。

drop index if exists orders_phone_digits;
create index if not exists orders_phone_digits on orders (shop_id, (regexp_replace(regexp_replace(coalesce(shipping_address->>'phone', ''), '[^0-9]', '', 'g'), '^810?', '0')));

-- admin_search_ids（0132 を差し替え: 電話番号の読み替えだけ）
create or replace function admin_search_ids(p_shop_id uuid, p_kind text, p_q text, p_filters jsonb, p_after_k timestamptz, p_after_id uuid, p_limit integer)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_like text;
  v_where text := 'shop_id = $1';
  v_table text;
  v_perm text;
  v_q text := nullif(btrim(left(coalesce(p_q, ''), 100)), '');
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_desc boolean := coalesce(p_filters->>'sort', 'new') <> 'old';
  v_num integer;
  v_phone text;
  v_track text;
  v_out uuid[];
begin
  case p_kind
    when 'products' then v_table := 'products'; v_perm := 'catalog';
    when 'orders' then v_table := 'orders'; v_perm := 'orders';
    when 'customers' then v_table := 'customers'; v_perm := 'customers';
    else raise exception 'invalid_kind' using errcode = '22023';
  end case;
  if not banto_shop_perm(p_shop_id, v_perm) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_q is not null then
    v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  if p_kind = 'products' then
    if v_like is not null then
      v_where := v_where || ' and (name ilike $2 or slug ilike $2 or id in (select product_id from skus where shop_id = $1 and (code = $3 or gtin = $3)))';
    end if;
    if v_f->>'state' = 'published' then v_where := v_where || ' and published'; end if;
    if v_f->>'state' = 'draft' then v_where := v_where || ' and not published'; end if;
    if coalesce(v_f->>'category', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_where := v_where || ' and (category_id = ($7->>''category'')::uuid or extra_category_ids @> array[($7->>''category'')::uuid])';
    end if;
    if v_f->>'stock' in ('in', 'out') then
      v_where := v_where || case when v_f->>'stock' = 'out' then ' and not' else ' and' end
        || ' exists (select 1 from skus s join inventory i on i.sku_id = s.id where s.product_id = products.id and i.available > 0)';
    end if;
  elsif p_kind = 'orders' then
    if v_like is not null then
      if v_q ~ '^#?\d{1,9}$' then v_num := ltrim(v_q, '#')::integer; end if;
      if v_q ~ '^[0-9+() -]{10,20}$' and length(regexp_replace(v_q, '[^0-9]', '', 'g')) between 10 and 13 then
        v_phone := regexp_replace(regexp_replace(v_q, '[^0-9]', '', 'g'), '^810?', '0');
      end if;
      if v_q ~ '^[0-9A-Za-z-]{4,60}$' and length(replace(v_q, '-', '')) between 4 and 40 then v_track := replace(v_q, '-', ''); end if;
      v_where := v_where || ' and (customer_email ilike $2 or customer_name ilike $2 or payment_ref = $3'
        || case when v_num is not null then ' or number = $8' else '' end
        || case when v_phone is not null then ' or regexp_replace(regexp_replace(coalesce(shipping_address->>''phone'', ''''), ''[^0-9]'', '''', ''g''), ''^810?'', ''0'') = $9' else '' end
        || case when v_track is not null then ' or tracking_number = $10' else '' end
        || ')';
    end if;
    if v_f->>'status' in ('paid', 'shipped', 'cancelled', 'refunded') then v_where := v_where || format(' and status = %L', v_f->>'status'); end if;
    if v_f->>'payment' in ('stripe', 'komoju', 'amazon_pay', 'free') then v_where := v_where || format(' and payment_provider = %L', v_f->>'payment'); end if;
    if coalesce(v_f->>'from', '') ~ '^\d{4}-\d{2}-\d{2}$' then
      v_where := v_where || ' and created_at >= (($7->>''from'')::date)::timestamp at time zone ''Asia/Tokyo''';
    end if;
    if coalesce(v_f->>'to', '') ~ '^\d{4}-\d{2}-\d{2}$' then
      v_where := v_where || ' and created_at < ((($7->>''to'')::date) + 1)::timestamp at time zone ''Asia/Tokyo''';
    end if;
    if coalesce(v_f->>'min', '') ~ '^\d{1,9}$' then v_where := v_where || ' and total_jpy >= ($7->>''min'')::integer'; end if;
    if coalesce(v_f->>'max', '') ~ '^\d{1,9}$' then v_where := v_where || ' and total_jpy <= ($7->>''max'')::integer'; end if;
    if length(btrim(coalesce(v_f->>'tag', ''))) between 1 and 40 then v_where := v_where || ' and tags @> array[btrim($7->>''tag'')]'; end if;
  else
    if v_like is not null then v_where := v_where || ' and (email ilike $2 or name ilike $2)'; end if;
    if coalesce(v_f->>'field', '') ~ '^[a-z][a-z0-9_]{0,39}$' and nullif(v_f->>'value', '') is not null then
      v_where := v_where || format(' and attributes->>%L ilike $4', v_f->>'field');
    end if;
    if v_f->>'consent' = 'yes' then v_where := v_where || ' and marketing_consent is true'; end if;
    if v_f->>'consent' = 'no' then v_where := v_where || ' and marketing_consent is false'; end if;
    if v_f->>'consent' = 'none' then v_where := v_where || ' and marketing_consent is null'; end if;
  end if;
  if p_after_k is not null and p_after_id is not null then
    v_where := v_where || case when v_desc then ' and (created_at < $5 or (created_at = $5 and id < $6))'
                               else ' and (created_at > $5 or (created_at = $5 and id > $6))' end;
  end if;
  execute format('select coalesce(array_agg(id order by created_at %1$s, id %1$s), ''{}'') from (select id, created_at from %2$I where %3$s order by created_at %1$s, id %1$s limit %4$s) x',
                 case when v_desc then 'desc' else 'asc' end, v_table, v_where, least(greatest(coalesce(p_limit, 50), 1), 1000))
    into v_out
    using p_shop_id, v_like, v_q,
          '%' || replace(replace(replace(coalesce(v_f->>'value', ''), '\', '\\'), '%', '\%'), '_', '\_') || '%',
          p_after_k, p_after_id, v_f, v_num, v_phone, v_track;
  return v_out;
end;
$$;
revoke execute on function admin_search_ids(uuid, text, text, jsonb, timestamptz, uuid, integer) from public, anon;
grant execute on function admin_search_ids(uuid, text, text, jsonb, timestamptz, uuid, integer) to authenticated, service_role;

insert into banto_migrations (version) values ('0134_admin_search_phone');
