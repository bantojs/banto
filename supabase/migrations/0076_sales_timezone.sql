-- Banto 0076_sales_timezone: 売上集計の日別・月別の区切りを、デプロイの時間帯（BANTO_TIMEZONE）に合わせる。前方専用。
-- これまでは SQL の中で Asia/Tokyo に決め打ちだった（0003 / 0004）。p_time_zone（IANA 名）を足し、Worker が BANTO_TIMEZONE を渡す。
--   - 省略・null なら Asia/Tokyo（今までと同じ。古い Worker から呼んでも結果は変わらない）
--   - 知らない名前は invalid_time_zone
--   - 期間（p_from / p_to）は今までどおり時刻で受ける。返す timezone は区切りに使った名前
-- 引数を足すので、同じ名前の古い関数は消して作り直す（同じ名前が 2 つあると PostgREST が選べない）。権限は今までと同じ

drop function if exists sales_summary_for_shop(uuid, timestamptz, timestamptz, text);
drop function if exists sales_summary(uuid, timestamptz, timestamptz, text);
drop function if exists api_sales_summary(text, timestamptz, timestamptz, text);

create function sales_summary_for_shop(p_shop_id uuid, p_from timestamptz, p_to timestamptz, p_group_by text, p_time_zone text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_rows jsonb; v_total jsonb; v_tz text := coalesce(nullif(p_time_zone, ''), 'Asia/Tokyo');
begin
  if p_group_by not in ('day', 'month', 'product') then raise exception 'invalid_group_by'; end if;
  begin
    perform now() at time zone v_tz;
  exception when others then
    raise exception 'invalid_time_zone';
  end;
  select jsonb_build_object(
    'orders', count(*), 'revenue_jpy', coalesce(sum(o.total_jpy), 0), 'shipping_jpy', coalesce(sum(o.shipping_jpy), 0),
    'items', coalesce((select sum(oi.qty) from order_items oi join orders o2 on o2.id = oi.order_id
                        where o2.shop_id = p_shop_id and o2.status in ('paid','shipped') and o2.created_at >= p_from and o2.created_at < p_to), 0),
    'avg_order_jpy', coalesce(round(avg(o.total_jpy)), 0))
    into v_total
    from orders o where o.shop_id = p_shop_id and o.status in ('paid','shipped') and o.created_at >= p_from and o.created_at < p_to;

  if p_group_by = 'product' then
    select coalesce(jsonb_agg(r order by (r->>'revenue_jpy')::bigint desc), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('product_id', p.id, 'product_name', coalesce(p.name, '(削除済み)'), 'sku_code', k.code,
                                'qty', sum(oi.qty), 'revenue_jpy', sum(oi.qty * oi.unit_price_jpy)) as r
        from order_items oi
        join orders o on o.id = oi.order_id
        left join skus k on k.id = oi.sku_id
        left join products p on p.id = k.product_id
       where o.shop_id = p_shop_id and o.status in ('paid','shipped') and o.created_at >= p_from and o.created_at < p_to
       group by p.id, p.name, k.code) x;
  else
    select coalesce(jsonb_agg(r order by r->>'period'), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('period', to_char(date_trunc(p_group_by, o.created_at at time zone v_tz), case when p_group_by = 'day' then 'YYYY-MM-DD' else 'YYYY-MM' end),
                                'orders', count(*), 'revenue_jpy', sum(o.total_jpy), 'shipping_jpy', sum(o.shipping_jpy)) as r
        from orders o
       where o.shop_id = p_shop_id and o.status in ('paid','shipped') and o.created_at >= p_from and o.created_at < p_to
       group by date_trunc(p_group_by, o.created_at at time zone v_tz)) x;
  end if;
  return jsonb_build_object('from', p_from, 'to', p_to, 'group_by', p_group_by, 'timezone', v_tz, 'total', v_total, 'rows', v_rows);
end;
$$;
revoke execute on function sales_summary_for_shop(uuid, timestamptz, timestamptz, text, text) from public, anon, authenticated;
grant execute on function sales_summary_for_shop(uuid, timestamptz, timestamptz, text, text) to service_role;

-- 管理画面（0024 と同じ: reports の項目）
create function sales_summary(p_shop_id uuid, p_from timestamptz, p_to timestamptz, p_group_by text default 'day', p_time_zone text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not banto_shop_perm(p_shop_id, 'reports') then raise exception 'shop_not_found' using errcode = '42501'; end if;
  return sales_summary_for_shop(p_shop_id, p_from, p_to, p_group_by, p_time_zone);
end;
$$;
revoke execute on function sales_summary(uuid, timestamptz, timestamptz, text, text) from public, anon;
grant execute on function sales_summary(uuid, timestamptz, timestamptz, text, text) to authenticated, service_role;

-- AI 用（0003 と同じ: stats:read）
create function api_sales_summary(p_token_hash text, p_from timestamptz, p_to timestamptz, p_group_by text default 'day', p_time_zone text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens;
begin
  v_tok := api_require(p_token_hash, 'stats:read');
  return sales_summary_for_shop(v_tok.shop_id, p_from, p_to, p_group_by, p_time_zone);
end;
$$;
revoke execute on function api_sales_summary(text, timestamptz, timestamptz, text, text) from public, anon, authenticated;
grant execute on function api_sales_summary(text, timestamptz, timestamptz, text, text) to service_role;

insert into banto_migrations (version) values ('0076_sales_timezone');
