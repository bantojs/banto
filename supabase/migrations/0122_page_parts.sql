-- Banto 0122_page_parts: 部品のページ（本文の `::: include page=<handle>` で差し込むページ）。メンテナの決定 2026-11-06（docs/pages.md「部品のページ」）。前方専用。
--   - pages.is_part: 部品として使うページ。お店の画面の /pages/<handle>・ページの一覧の API・サイトマップに出さない（判定は Worker）。
--     本文に差し込むのは公開中のページの匿名の読み取り（RLS のまま。会員限定・下書き・予約・ゴミ箱のページは差し込まない）
--   - 部品はメニューに出さない（nav をいつも none にする。shop_public_get の pages_nav はそのまま）
--   - AI 用 API（api_page_save / api_page_json）でも is_part を読み書きできる（0083 の定義に is_part を足す）

alter table pages add column if not exists is_part boolean not null default false;

create or replace function banto_page_part_nav()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.is_part then new.nav := 'none'; end if;
  return new;
end;
$$;
revoke execute on function banto_page_part_nav() from public, anon, authenticated;
drop trigger if exists pages_part_nav on pages;
create trigger pages_part_nav before insert or update of is_part, nav on pages for each row execute function banto_page_part_nav();

create or replace function api_page_json(p pages, p_body boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'handle', p.handle, 'title', p.title, 'nav', p.nav, 'sort_order', p.sort_order, 'template_suffix', p.template_suffix,
    'seo_title', p.seo_title, 'seo_description', p.seo_description, 'image_url', p.image_url,
    'published', p.published, 'published_at', p.published_at, 'deleted_at', p.deleted_at,
    'status', banto_content_status(p.published, p.published_at, p.deleted_at),
    'is_part', p.is_part,
    'created_at', p.created_at, 'updated_at', p.updated_at)
    || case when p_body then jsonb_build_object('body', p.body) else '{}'::jsonb end;
$$;
revoke execute on function api_page_json(pages, boolean) from public, anon, authenticated;

create or replace function api_page_save(p_token_hash text, p_page jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tok api_tokens; v_p pages%rowtype; v_found boolean := false;
begin
  v_tok := api_content_require(p_token_hash, 'content:write', 'pages');
  perform api_content_check(p_page, 'page');
  if p_page ? 'is_part' and jsonb_typeof(p_page->'is_part') <> 'boolean' then raise exception 'invalid_is_part'; end if;
  if p_page ? 'id' then
    if coalesce(p_page->>'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'not_found'; end if;
    select * into v_p from pages where id = (p_page->>'id')::uuid and shop_id = v_tok.shop_id and deleted_at is null for update;
    if not found then raise exception 'not_found'; end if;
    v_found := true;
  elsif p_page ? 'handle' then
    select * into v_p from pages where shop_id = v_tok.shop_id and handle = p_page->>'handle' and deleted_at is null for update;
    v_found := found;
  end if;
  if p_page ? 'handle' and exists (select 1 from pages where shop_id = v_tok.shop_id and handle = p_page->>'handle' and deleted_at is null and (not v_found or id <> v_p.id)) then
    raise exception 'handle_taken';
  end if;
  if not v_found then
    if not (p_page ? 'handle' and p_page ? 'title') then raise exception 'invalid_values_handle_title_required'; end if;
    insert into pages (shop_id, handle, title, body, seo_title, seo_description, template_suffix, nav, sort_order, published, published_at, image_url, is_part)
    values (v_tok.shop_id, p_page->>'handle', btrim(p_page->>'title'), coalesce(p_page->>'body', ''),
            banto_jtext(p_page, 'seo_title', null), banto_jtext(p_page, 'seo_description', null), banto_jtext(p_page, 'template_suffix', null),
            coalesce(p_page->>'nav', 'none'), coalesce((p_page->>'sort_order')::integer, 0), coalesce((p_page->>'published')::boolean, false),
            banto_jtext(p_page, 'published_at', null)::timestamptz, banto_jtext(p_page, 'image_url', null),
            coalesce((p_page->>'is_part')::boolean, false))
    returning * into v_p;
  else
    update pages set
      handle = banto_jtext(p_page, 'handle', handle),
      title = case when p_page ? 'title' then btrim(p_page->>'title') else title end,
      body = case when p_page ? 'body' then p_page->>'body' else body end,
      seo_title = banto_jtext(p_page, 'seo_title', seo_title),
      seo_description = banto_jtext(p_page, 'seo_description', seo_description),
      template_suffix = banto_jtext(p_page, 'template_suffix', template_suffix),
      nav = case when p_page ? 'nav' then p_page->>'nav' else nav end,
      sort_order = case when p_page ? 'sort_order' then (p_page->>'sort_order')::integer else sort_order end,
      published = case when p_page ? 'published' then (p_page->>'published')::boolean else published end,
      published_at = case when p_page ? 'published_at' then banto_jtext(p_page, 'published_at', null)::timestamptz else published_at end,
      image_url = banto_jtext(p_page, 'image_url', image_url),
      is_part = case when p_page ? 'is_part' then (p_page->>'is_part')::boolean else is_part end,
      updated_at = now()
    where id = v_p.id
    returning * into v_p;
  end if;
  return api_page_json(v_p, true);
end;
$$;
revoke execute on function api_page_save(text, jsonb) from public, anon, authenticated;
grant execute on function api_page_save(text, jsonb) to service_role;

insert into banto_migrations (version) values ('0122_page_parts');
