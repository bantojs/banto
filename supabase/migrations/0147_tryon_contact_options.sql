-- 0147_tryon_contact_options: お店で試着のお知らせの品目に、SKU の選択肢（カラー・サイズ）と品番を載せる
--   - tryon_contact（0069）の items に code（品番）と options（SKU の options、鍵は 0094 の key）、shop に option_names（key → 表示名）を足す。
--     メールは「品名 / カラー: ネイビー・サイズ: M（品番）× 数」で出す（src/modules/store-tryon/mail.ts）。
--     options は jsonb なので鍵の順は保たれない（短い順）。並べる順のために商品の軸（option_axes、0065）も items に添える。ほかは 0069 と同じ
create or replace function tryon_contact(p_request_id uuid, p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_r tryon_requests%rowtype; v_st stores%rowtype; v_s shops%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'tryon_contact: service_role only' using errcode = '42501';
  end if;
  select * into v_r from tryon_requests where id = p_request_id and shop_id = p_shop_id;
  if not found then raise exception 'not_found'; end if;
  select * into v_st from stores where id = v_r.store_id;
  select * into v_s from shops where id = p_shop_id;
  return jsonb_build_object(
    'request_id', v_r.id, 'number', v_r.number, 'status', v_r.status, 'visit_date', v_r.visit_date, 'hold_until', v_r.hold_until,
    'customer_email', v_r.customer_email, 'customer_name', v_r.customer_name, 'customer_phone', v_r.customer_phone, 'note', v_r.note,
    'store', jsonb_build_object('name', v_st.name, 'postal_code', v_st.postal_code, 'address', v_st.address, 'phone', v_st.phone,
                                'email', v_st.email, 'notify_email', v_st.notify_email, 'hours', v_st.hours, 'special_days', v_st.special_days),
    'shop', jsonb_build_object('name', v_s.name, 'slug', v_s.slug, 'domain', v_s.domain, 'contact_email', v_s.settings->>'contact_email', 'settings', v_s.settings->'store_tryon',
                               'storefront', jsonb_build_object('mode', v_s.settings->'storefront'->>'mode', 'site_url', v_s.settings->'storefront'->>'site_url'),
                               'option_names', v_s.option_names),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'sku', coalesce(k.name, k.code), 'code', k.code, 'options', k.options, 'axes', p.option_axes,
                                                           'qty', t.qty, 'unit_price_jpy', t.unit_price_jpy) order by t.id), '[]'::jsonb)
                from tryon_items t join skus k on k.id = t.sku_id join products p on p.id = k.product_id where t.request_id = v_r.id));
end;
$$;
revoke execute on function tryon_contact(uuid, uuid) from public, anon, authenticated;
grant execute on function tryon_contact(uuid, uuid) to service_role;

insert into banto_migrations (version) values ('0147_tryon_contact_options');
