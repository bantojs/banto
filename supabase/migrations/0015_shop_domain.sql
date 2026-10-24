-- 0015_shop_domain: ショップごとの独自ドメイン（docs/custom-domain.md、docs/knowledge/10-members-identity.md §15）
--
-- shops.domain に入れたホスト名（例 shop.example.jp）へのアクセスは、そのショップのストアフロントになる（パスにスラッグが要らない）。
-- 会員のログインの戻り先（LINE・Google の redirect_uri）・ログインのメールのリンク・決済後の戻り先・canonical も、このドメインを使う。
-- ホスト名は公開情報なので、公開中のショップなら anon からも読める（shops_public のポリシーのまま）。

alter table shops add column if not exists domain text;

alter table shops drop constraint if exists shops_domain_format;
alter table shops add constraint shops_domain_format check (
  domain is null or (
    length(domain) <= 253
    and domain = lower(domain)
    and domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
  )
);

-- 同じドメインを 2 つのショップに付けない
create unique index if not exists shops_domain_key on shops (domain) where domain is not null;

-- 取引メールの「注文の確認」のリンクもショップのドメインにする
create or replace function order_contact(p_order_id uuid, p_shop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_o orders%rowtype; v_s shops%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'order_contact: service_role only' using errcode = '42501';
  end if;
  select * into v_o from orders where id = p_order_id and shop_id = p_shop_id;
  if not found then raise exception 'not_found'; end if;
  select * into v_s from shops where id = p_shop_id;
  return jsonb_build_object(
    'order_id', v_o.id, 'number', v_o.number, 'status', v_o.status, 'created_at', v_o.created_at,
    'total_jpy', v_o.total_jpy, 'shipping_jpy', v_o.shipping_jpy, 'discount_jpy', v_o.discount_jpy, 'payment_provider', v_o.payment_provider,
    'discounts', (select coalesce(jsonb_agg(jsonb_build_object('code', d->>'code', 'name', d->>'name', 'amount_jpy', (d->>'amount_jpy')::integer)), '[]'::jsonb)
                    from jsonb_array_elements(coalesce(v_o.discounts, '[]'::jsonb)) d),
    'customer_email', v_o.customer_email, 'customer_name', v_o.customer_name, 'shipping_address', v_o.shipping_address,
    'shop', jsonb_build_object('name', v_s.name, 'slug', v_s.slug, 'domain', v_s.domain,
                               'contact_email', v_s.settings->>'contact_email', 'return_policy', v_s.return_policy),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'sku', coalesce(k.name, k.code), 'qty', oi.qty, 'unit_price_jpy', oi.unit_price_jpy) order by oi.id), '[]'::jsonb)
                from order_items oi left join skus k on k.id = oi.sku_id left join products p on p.id = k.product_id where oi.order_id = v_o.id));
end;
$$;

insert into banto_migrations (version) values ('0015_shop_domain');
