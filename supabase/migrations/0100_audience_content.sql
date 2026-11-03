-- 0100_audience_content: 会員限定のページ・記事（同梱モジュール audiences の段 E。メンテナの決定 2026-11-02、docs/audiences.md「会員限定のページ・記事」）
--   - ページ（pages）と記事（articles）に会員の条件（audience_id）と、存在も隠すか（audience_hide）
--   - 匿名（anon）の RLS は条件の無い行だけ。一覧・メニュー（pages_nav）・サイトマップ・RSS・記事を並べるブロックから自動で消える
--   - ログイン中の会員は、会員のセッションを確かめる service_role の関数（page_member_get / article_member_get / articles_member_page）で、
--     DB の最新の独自項目で合う条件の行を足して受け取る
--   - ゲストが URL で来たら「会員の方だけ」（content_public_gate）。存在も隠すなら 404。合わない会員は 404
--   - 表示用の条件（URL のパラメータ）は使えない（商品と同じ。本文の出し分けは本文の囲みで）

alter table pages add column if not exists audience_id uuid;
alter table pages add column if not exists audience_hide boolean not null default false;
alter table pages drop constraint if exists pages_audience_fkey;
alter table pages add constraint pages_audience_fkey foreign key (audience_id, shop_id) references audiences (id, shop_id) on delete restrict;
alter table articles add column if not exists audience_id uuid;
alter table articles add column if not exists audience_hide boolean not null default false;
alter table articles drop constraint if exists articles_audience_fkey;
alter table articles add constraint articles_audience_fkey foreign key (audience_id, shop_id) references audiences (id, shop_id) on delete restrict;

-- 表示用の条件は使えない
create or replace function banto_content_audience_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.audience_id is not null and (tg_op = 'INSERT' or new.audience_id is distinct from old.audience_id)
     and exists (select 1 from audiences a where a.id = new.audience_id and banto_audience_display_only(a.condition)) then
    raise exception 'audience_display_only' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke execute on function banto_content_audience_guard() from public, anon, authenticated;
drop trigger if exists pages_audience_guard on pages;
create trigger pages_audience_guard before insert or update of audience_id on pages for each row execute function banto_content_audience_guard();
drop trigger if exists articles_audience_guard on articles;
create trigger articles_audience_guard before insert or update of audience_id on articles for each row execute function banto_content_audience_guard();

-- 会員の条件を表示用にするのは、商品・価格の決まり（0098・0099）に加えてページ・記事に使われていても断る
create or replace function banto_audiences_display_only_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if banto_audience_display_only(new.condition)
     and (exists (select 1 from products p where p.audience_id = new.id) or exists (select 1 from price_rules r where r.audience_id = new.id)
          or exists (select 1 from pages g where g.audience_id = new.id) or exists (select 1 from articles a where a.audience_id = new.id)) then
    raise exception 'audience_display_only_in_use' using errcode = '22023';
  end if;
  return new;
end;
$$;

-- ---------- 匿名の RLS（0089 の形に、会員の条件の無い行だけを足す） ----------
drop policy if exists pages_public on pages;
create policy pages_public on pages for select
  using (published and deleted_at is null and (published_at is null or published_at <= now()) and audience_id is null and banto_shop_module_public(shop_id, 'pages'));
drop policy if exists articles_public on articles;
create policy articles_public on articles for select
  using (published and deleted_at is null and published_at <= now() and audience_id is null and banto_shop_module_public(shop_id, 'blog'));

-- メニューに出すページ: 会員限定のページは出さない（ほかは 0094 と同じ）
create or replace function banto_shop_public_json(s shops)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', s.id, 'slug', s.slug, 'name', s.name, 'published', s.published,
    'legal_notice', s.legal_notice, 'privacy_policy', s.privacy_policy, 'return_policy', s.return_policy,
    'domain', s.domain, 'stripe_connected', s.stripe_account_id is not null,
    'option_names', s.option_names,
    'settings', banto_shop_public_settings(s.settings),
    'legal_links', banto_legal_links_live(s),
    'theme', (select jsonb_build_object('id', t.id, 'storage_key', t.storage_key, 'settings', t.settings)
                from theme_versions t where t.id = s.theme_version_id and t.shop_id = s.id and s.domain is not null),
    'pages_nav', case when s.settings->'modules'->'pages' = 'true'::jsonb then
      (select coalesce(jsonb_agg(jsonb_build_object('handle', p.handle, 'title', p.title, 'nav', p.nav) order by p.sort_order, p.created_at), '[]'::jsonb)
         from pages p where p.shop_id = s.id and p.published and p.deleted_at is null
          and (p.published_at is null or p.published_at <= now()) and p.nav <> 'none' and p.audience_id is null)
      else '[]'::jsonb end,
    'blogs_nav', case when s.settings->'modules'->'blog' = 'true'::jsonb then
      (select coalesce(jsonb_agg(jsonb_build_object('handle', b.handle, 'title', b.title, 'nav', b.nav) order by b.sort_order, b.created_at), '[]'::jsonb)
         from blogs b where b.shop_id = s.id and b.nav <> 'none')
      else '[]'::jsonb end);
$$;

-- ---------- 会員の読み取りの経路 ----------
create or replace function banto_member_aud_live(p_shop_id uuid, p_customer_id uuid, p_epoch integer, p_session_id uuid)
returns uuid[] language sql stable security definer set search_path = public as $$
  select case when banto_member_session_live(p_shop_id, p_customer_id, p_epoch, p_session_id) then banto_member_audience_ids(p_shop_id, p_customer_id) else '{}'::uuid[] end;
$$;
revoke execute on function banto_member_aud_live(uuid, uuid, integer, uuid) from public, anon, authenticated;

create or replace function page_member_get(p_shop_id uuid, p_handle text, p_customer_id uuid, p_epoch integer, p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_aud uuid[];
begin
  if auth.role() is distinct from 'service_role' then raise exception 'page_member_get: service_role only' using errcode = '42501'; end if;
  v_aud := banto_member_aud_live(p_shop_id, p_customer_id, p_epoch, p_session_id);
  return (select to_jsonb(p) from pages p
           where p.shop_id = p_shop_id and p.handle = p_handle and p.published and p.deleted_at is null
             and (p.published_at is null or p.published_at <= now()) and banto_shop_module_public(p_shop_id, 'pages')
             and (p.audience_id is null or p.audience_id = any(v_aud))
           limit 1);
end;
$$;
revoke execute on function page_member_get(uuid, text, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function page_member_get(uuid, text, uuid, integer, uuid) to service_role;

create or replace function article_member_get(p_shop_id uuid, p_blog_id uuid, p_handle text, p_customer_id uuid, p_epoch integer, p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_aud uuid[];
begin
  if auth.role() is distinct from 'service_role' then raise exception 'article_member_get: service_role only' using errcode = '42501'; end if;
  v_aud := banto_member_aud_live(p_shop_id, p_customer_id, p_epoch, p_session_id);
  return (select to_jsonb(a) from articles a
           where a.shop_id = p_shop_id and a.blog_id = p_blog_id and a.handle = p_handle and a.published and a.deleted_at is null
             and a.published_at <= now() and banto_shop_module_public(p_shop_id, 'blog')
             and (a.audience_id is null or a.audience_id = any(v_aud))
           limit 1);
end;
$$;
revoke execute on function article_member_get(uuid, uuid, text, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function article_member_get(uuid, uuid, text, uuid, integer, uuid) to service_role;

-- 記事の一覧（公開した日時の新しい順。p_limit + 1 件まで返し、呼び出し側が次のページの有無を見る）
create or replace function articles_member_page(p_shop_id uuid, p_blog_id uuid, p_offset integer, p_limit integer, p_tag text,
                                                p_customer_id uuid, p_epoch integer, p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_aud uuid[];
begin
  if auth.role() is distinct from 'service_role' then raise exception 'articles_member_page: service_role only' using errcode = '42501'; end if;
  if p_offset < 0 or p_offset > 1200 or p_limit not between 1 and 50 then raise exception 'invalid_page'; end if;
  v_aud := banto_member_aud_live(p_shop_id, p_customer_id, p_epoch, p_session_id);
  return coalesce((select jsonb_agg(x order by (x->>'published_at') desc, (x->>'id') desc) from (
    select jsonb_build_object('id', a.id, 'shop_id', a.shop_id, 'blog_id', a.blog_id, 'handle', a.handle, 'title', a.title, 'body', a.body, 'excerpt', a.excerpt,
                              'tags', a.tags, 'image_url', a.image_url, 'author', a.author, 'published_at', a.published_at, 'updated_at', a.updated_at, 'audience_id', a.audience_id) x
      from articles a
     where a.shop_id = p_shop_id and a.blog_id = p_blog_id and a.published and a.deleted_at is null and a.published_at <= now()
       and banto_shop_module_public(p_shop_id, 'blog')
       and (a.audience_id is null or a.audience_id = any(v_aud))
       and (p_tag is null or a.tags @> array[p_tag])
     order by a.published_at desc, a.id desc
     offset p_offset limit p_limit + 1) t), '[]'::jsonb);
end;
$$;
revoke execute on function articles_member_page(uuid, uuid, integer, integer, text, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function articles_member_page(uuid, uuid, integer, integer, text, uuid, integer, uuid) to service_role;

-- ゲストが会員限定のページ・記事の URL で来たとき「会員の方だけ」と出してよいか（'members' か null だけ。中身は返さない）
create or replace function content_public_gate(p_shop_id uuid, p_kind text, p_blog_id uuid, p_handle text)
returns text language sql stable security definer set search_path = public as $$
  select case
    when p_kind = 'page' then (select 'members' from pages p
      where p.shop_id = p_shop_id and p.handle = p_handle and p.published and p.deleted_at is null and (p.published_at is null or p.published_at <= now())
        and p.audience_id is not null and not p.audience_hide and banto_shop_module_public(p_shop_id, 'pages') limit 1)
    when p_kind = 'article' then (select 'members' from articles a
      where a.shop_id = p_shop_id and a.blog_id = p_blog_id and a.handle = p_handle and a.published and a.deleted_at is null and a.published_at <= now()
        and a.audience_id is not null and not a.audience_hide and banto_shop_module_public(p_shop_id, 'blog') limit 1)
  end;
$$;
revoke execute on function content_public_gate(uuid, text, uuid, text) from public;
grant execute on function content_public_gate(uuid, text, uuid, text) to anon, authenticated, service_role;

insert into banto_migrations (version) values ('0100_audience_content');
