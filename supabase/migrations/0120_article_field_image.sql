-- Banto 0120_article_field_image: 記事の項目に「画像」の種類を足す。メンテナの決定 2026-11-05（docs/blog.md「記事の項目」）。前方専用。
--   - 商品のカスタム項目の image（shops.settings.product_fields、DB は値を確かめない）と書き方をそろえる
--   - 値は画像の URL の文字。このショップの画像の置き場のものだけにするのは Worker（管理画面と AI 用 API、src/pages/markdown.ts の shopImageUrl）。
--     DB は形だけを確かめる（/media/ か http(s)、空白・引用符・山かっこ・.. を含まない、2,000 字まで）
--   - 0117 の banto_blog_article_fields_guard と banto_article_fields_norm を定義し直す（トリガーはそのまま）

create or replace function banto_blog_article_fields_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare d jsonb; v_keys text[] := '{}'; v_key text; v_type text;
begin
  if jsonb_typeof(new.article_fields) <> 'array' or jsonb_array_length(new.article_fields) > 20 then
    raise exception 'article_fields_invalid' using errcode = '22023';
  end if;
  for d in select * from jsonb_array_elements(new.article_fields) loop
    if jsonb_typeof(d) <> 'object' then raise exception 'article_fields_invalid' using errcode = '22023'; end if;
    v_key := d->>'key';
    v_type := d->>'type';
    if v_key is null or v_key !~ '^[a-z][a-z0-9_]{0,39}$' or v_key = any(v_keys)
       or coalesce(char_length(btrim(d->>'label')), 0) not between 1 and 60
       or v_type is null or v_type not in ('text', 'number', 'select', 'store', 'product', 'article', 'image')
       or (d ? 'multiple' and jsonb_typeof(d->'multiple') <> 'boolean')
       or (coalesce((d->>'multiple')::boolean, false) and v_type not in ('product', 'article')) then
      raise exception 'article_fields_invalid:%', coalesce(v_key, '') using errcode = '22023';
    end if;
    if v_type = 'select' and not coalesce(
         jsonb_typeof(d->'options') = 'array' and jsonb_array_length(d->'options') between 1 and 50
         and not exists (select 1 from jsonb_array_elements(d->'options') o where jsonb_typeof(o) <> 'string' or char_length(btrim(o #>> '{}')) not between 1 and 60), false) then
      raise exception 'article_fields_invalid:%', v_key using errcode = '22023';
    end if;
    if v_type = 'article' and not coalesce(
         (d->>'blog') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         and exists (select 1 from blogs b where b.id = (d->>'blog')::uuid and b.shop_id = new.shop_id), false) then
      raise exception 'article_fields_invalid:%', v_key using errcode = '22023';
    end if;
    v_keys := v_keys || v_key;
  end loop;
  return new;
end;
$$;
revoke execute on function banto_blog_article_fields_guard() from public, anon, authenticated;

create or replace function banto_article_fields_norm()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_defs jsonb; d jsonb; v_key text; v_type text; v_multi boolean; v jsonb; v_out jsonb := '{}'::jsonb; v_list text[]; x text; n numeric; v_max integer;
begin
  if tg_op = 'UPDATE' and new.fields is not distinct from old.fields and new.blog_id is not distinct from old.blog_id then return new; end if;
  if new.fields is null or jsonb_typeof(new.fields) <> 'object' then raise exception 'article_fields_invalid' using errcode = '22023'; end if;
  select article_fields into v_defs from blogs where id = new.blog_id;
  for d in select * from jsonb_array_elements(coalesce(v_defs, '[]'::jsonb)) loop
    v_key := d->>'key';
    v_type := d->>'type';
    v_multi := coalesce((d->>'multiple')::boolean, false);
    v := new.fields->v_key;
    if v is null or jsonb_typeof(v) = 'null' or (jsonb_typeof(v) = 'string' and btrim(v #>> '{}') = '') or (jsonb_typeof(v) = 'array' and jsonb_array_length(v) = 0) then
      continue;
    end if;
    if v_type = 'text' then
      if jsonb_typeof(v) not in ('string', 'number') or char_length(v #>> '{}') > 500 then raise exception 'article_field_invalid:%', v_key using errcode = '22023'; end if;
      v_out := v_out || jsonb_build_object(v_key, btrim(v #>> '{}'));
    elsif v_type = 'number' then
      begin
        n := (v #>> '{}')::numeric;
      exception when others then
        raise exception 'article_field_invalid:%', v_key using errcode = '22023';
      end;
      if jsonb_typeof(v) not in ('string', 'number') or abs(n) > 1e12 then raise exception 'article_field_invalid:%', v_key using errcode = '22023'; end if;
      v_out := v_out || jsonb_build_object(v_key, n);
    elsif v_type = 'select' then
      if jsonb_typeof(v) <> 'string' or not (d->'options' ? (v #>> '{}')) then raise exception 'article_field_invalid:%', v_key using errcode = '22023'; end if;
      v_out := v_out || jsonb_build_object(v_key, v #>> '{}');
    elsif v_type = 'image' then
      -- 画像の URL（Worker がこのショップの画像の置き場のものに整えてから書く。ここは形だけ: /media/ か http(s)、空白・引用符・山かっこ・.. なし）
      if jsonb_typeof(v) <> 'string' or char_length(v #>> '{}') > 2000
         or (v #>> '{}') !~ '^(/media/|https?://)[^[:space:]"''<>`\\]+$' or position('..' in (v #>> '{}')) > 0 then
        raise exception 'article_field_invalid:%', v_key using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(v_key, v #>> '{}');
    elsif v_type = 'store' then
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or not exists (select 1 from shop_stores ss where ss.shop_id = new.shop_id and ss.store_id = (v #>> '{}')::uuid) then
        raise exception 'article_field_invalid:%', v_key using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object(v_key, v #>> '{}');
    else
      -- product / article: URL の名前（multiple なら配列）。書いた順のまま、重なりは除く
      if jsonb_typeof(v) = 'string' then v_list := array[v #>> '{}'];
      elsif jsonb_typeof(v) = 'array' and not exists (select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'string') then
        select array_agg(s order by o) into v_list from (select distinct on (e #>> '{}') e #>> '{}' as s, o from jsonb_array_elements(v) with ordinality t(e, o) order by e #>> '{}', o) q;
      else raise exception 'article_field_invalid:%', v_key using errcode = '22023';
      end if;
      v_max := case when v_multi then 24 else 1 end;
      if cardinality(v_list) > v_max then raise exception 'article_field_invalid:%', v_key using errcode = '22023'; end if;
      foreach x in array v_list loop
        if x !~ '^[a-z0-9][a-z0-9-]{0,62}$'
           or (v_type = 'product' and not exists (select 1 from products p where p.shop_id = new.shop_id and p.slug = x))
           or (v_type = 'article' and not exists (select 1 from articles a where a.blog_id = (d->>'blog')::uuid and a.shop_id = new.shop_id and a.handle = x and a.deleted_at is null)) then
          raise exception 'article_field_invalid:%', v_key using errcode = '22023';
        end if;
      end loop;
      v_out := v_out || jsonb_build_object(v_key, case when v_multi then to_jsonb(v_list) else to_jsonb(v_list[1]) end);
    end if;
  end loop;
  new.fields := v_out;
  return new;
end;
$$;
revoke execute on function banto_article_fields_norm() from public, anon, authenticated;

insert into banto_migrations (version) values ('0120_article_field_image');
