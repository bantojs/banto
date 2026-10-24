-- Banto 0007_tags: 商品のタグ（ヘッドレス API の絞り込み・ストアフロントのタグ別一覧）
-- 前方専用。docs/headless.md

-- タグは 1 商品 20 個まで、1 個 1〜40 文字、カンマと改行を含まない（正規化はアプリと RPC の両方で行う）
-- CHECK 制約から呼ぶので、管理画面（authenticated）が直接 UPDATE できるよう EXECUTE は剥奪しない（副作用のない純関数）
create or replace function banto_valid_tags(p_tags text[])
returns boolean
language sql
immutable
set search_path = public
as $$
  select cardinality(p_tags) <= 20
     and not exists (select 1 from unnest(p_tags) t where length(t) not between 1 and 40 or t ~ '[,\r\n]');
$$;

-- 入力（jsonb の配列）→ 正規化したタグ配列。前後の空白を除き、空と重複を捨て、20 個で切る
create or replace function banto_normalize_tags(p_tags jsonb)
returns text[]
language sql
immutable
set search_path = public
as $$
  select coalesce(array_agg(t order by first_pos), '{}')
    from (select t, min(pos) as first_pos
            from (select left(regexp_replace(btrim(value), '[,\r\n]', '', 'g'), 40) as t, ord as pos
                    from jsonb_array_elements_text(case when jsonb_typeof(p_tags) = 'array' then p_tags else '[]'::jsonb end) with ordinality as e(value, ord)) x
           where t <> ''
           group by t
           order by min(pos)
           limit 20) y;
$$;

alter table products add column tags text[] not null default '{}' check (banto_valid_tags(tags));
create index products_tags_idx on products using gin (tags);

-- AI 用 API: 商品の JSON にタグを載せ、作成・更新でタグを受け付ける（0003_api.sql の同名関数を置き換える。権限は既存のまま）
create or replace function api_product_json(p_product products, p_with_skus boolean default true)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_product.id, 'slug', p_product.slug, 'name', p_product.name, 'description', p_product.description,
    'tags', to_jsonb(p_product.tags),
    'published', p_product.published, 'created_at', p_product.created_at, 'updated_at', p_product.updated_at,
    'images', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'storage_key', i.storage_key, 'sort_order', i.sort_order) order by i.sort_order), '[]'::jsonb)
                 from product_images i where i.product_id = p_product.id),
    'skus', case when p_with_skus then
      (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'code', k.code, 'name', k.name, 'price_jpy', k.price_jpy,
                                                     'available', coalesce(inv.available, 0)) order by k.created_at), '[]'::jsonb)
         from skus k left join inventory inv on inv.sku_id = k.id where k.product_id = p_product.id)
      else null end
  );
$$;

create or replace function api_product_create(p_token_hash text, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_p products%rowtype;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  insert into products (shop_id, slug, name, description, published, tags)
  values (v_tok.shop_id, p_values->>'slug', p_values->>'name', nullif(btrim(coalesce(p_values->>'description', '')), ''),
          coalesce((p_values->>'published')::boolean, false), banto_normalize_tags(p_values->'tags'))
  returning * into v_p;
  perform enqueue_hook(v_tok.shop_id, 'product.updated', jsonb_build_object('product_id', v_p.id, 'shop_id', v_tok.shop_id, 'slug', v_p.slug, 'name', v_p.name, 'published', v_p.published));
  return api_product_json(v_p, true);
end;
$$;

create or replace function api_product_update(p_token_hash text, p_product_id uuid, p_values jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_tok api_tokens; v_p products%rowtype;
begin
  v_tok := api_require(p_token_hash, 'products:write');
  update products set
    slug = coalesce(p_values->>'slug', slug),
    name = coalesce(nullif(btrim(p_values->>'name'), ''), name),
    description = case when p_values ? 'description' then nullif(btrim(p_values->>'description'), '') else description end,
    published = coalesce((p_values->>'published')::boolean, published),
    tags = case when p_values ? 'tags' then banto_normalize_tags(p_values->'tags') else tags end
  where id = p_product_id and shop_id = v_tok.shop_id
  returning * into v_p;
  if not found then raise exception 'not_found'; end if;
  perform enqueue_hook(v_tok.shop_id, 'product.updated', jsonb_build_object('product_id', v_p.id, 'shop_id', v_tok.shop_id, 'slug', v_p.slug, 'name', v_p.name, 'published', v_p.published));
  return api_product_json(v_p, true);
end;
$$;

-- バックアップからの復元: restore_shop_data（0006）の後に呼び、slug で突き合わせてタグを戻す（id は振り直されているため）
create or replace function restore_product_tags(p_shop_id uuid, p_products jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_row jsonb; v_n integer := 0;
begin
  if jsonb_typeof(p_products) <> 'array' then raise exception 'invalid_export'; end if;
  for v_row in select * from jsonb_array_elements(p_products) loop
    if jsonb_typeof(v_row->'tags') = 'array' and jsonb_array_length(v_row->'tags') > 0 then
      update products set tags = banto_normalize_tags(v_row->'tags')
       where shop_id = p_shop_id and slug = v_row->>'slug';
      if found then v_n := v_n + 1; end if;
    end if;
  end loop;
  return v_n;
end;
$$;

revoke all on function banto_normalize_tags(jsonb) from public, anon, authenticated;
revoke all on function restore_product_tags(uuid, jsonb) from public, anon, authenticated;
grant execute on function restore_product_tags(uuid, jsonb) to service_role;

insert into banto_migrations (version) values ('0007_tags');
