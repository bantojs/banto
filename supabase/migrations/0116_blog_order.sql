-- Banto 0116_blog_order: ブログの記事の並び順と、フィードを出すか。メンテナの決定 2026-11-05（docs/blog.md「並び順とフィード」）。前方専用。
--   - blogs.article_order: new（公開した日時の新しい順、既定）/ title（題の順）/ manual（手で並べる）。
--     一覧（/blogs/<ブログ>、タグで絞った一覧、ブログの一覧のひな形）と ::: articles の既定がこれに従う。フィードはいつも新しい順
--   - articles.position: 手で並べるときの順（小さいほど前）。同じ数なら新しい順。
--     今ある記事は今の並び（新しい順）で 1 から振る。新しい記事はそのブログの最後（いちばん大きい数 + 1）
--   - 並び順だけを変えても記事の更新日時は変えない（サイトマップ・フィードの更新日時を動かさない）
--   - blogs.feed: false なら /blogs/<ブログ>/feed.atom を出さない（お知らせではないブログ向け）
--   - 会員の一覧（articles_member_page、0100）も同じ並びにする。p_sort（::: articles sort= の上書き）を足す

alter table blogs add column if not exists article_order text not null default 'new';
alter table blogs drop constraint if exists blogs_article_order_check;
alter table blogs add constraint blogs_article_order_check check (article_order in ('new', 'title', 'manual'));
alter table blogs add column if not exists feed boolean not null default true;

alter table articles add column if not exists position integer not null default 0;
alter table articles drop constraint if exists articles_position_check;
alter table articles add constraint articles_position_check check (position between 0 and 1000000);

-- 今ある記事: 今の並び（公開した日時の新しい順、下書きは作った新しい順）で 1 から
update articles a set position = r.n
  from (select id, row_number() over (partition by blog_id order by published_at desc nulls first, created_at desc, id desc) as n from articles) r
 where r.id = a.id and a.position = 0;

create index if not exists articles_blog_position on articles (blog_id, position) where published and deleted_at is null;

-- 新しい記事はそのブログの最後に（数を書かずに作ったとき）
create or replace function banto_article_position()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.position is null or new.position = 0 then
    new.position := coalesce((select max(position) from articles where blog_id = new.blog_id), 0) + 1;
  end if;
  return new;
end;
$$;
revoke execute on function banto_article_position() from public, anon, authenticated;
drop trigger if exists articles_position on articles;
create trigger articles_position before insert on articles for each row execute function banto_article_position();

-- 並び順だけの変更では更新日時を変えない
drop trigger if exists articles_updated_at on articles;
create trigger articles_updated_at before update on articles for each row
  when (old.position is not distinct from new.position)
  execute function banto_set_updated_at();

-- 手で並べる: 記事の id → 順（項目 content）。このブログの記事だけ、1 回に 5,000 本まで
create or replace function article_positions_set(p_blog_id uuid, p_positions jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare v_shop uuid; v integer;
begin
  select shop_id into v_shop from blogs where id = p_blog_id;
  if v_shop is null or not banto_shop_perm(v_shop, 'content') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_positions) <> 'object' or (select count(*) from jsonb_object_keys(p_positions)) > 5000 then
    raise exception 'invalid_positions' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_each(p_positions) e
              where e.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 or jsonb_typeof(e.value) <> 'number' or (e.value #>> '{}') !~ '^[0-9]+$'
                 or (e.value #>> '{}')::bigint not between 1 and 1000000) then
    raise exception 'invalid_positions' using errcode = '22023';
  end if;
  update articles a set position = (e.value #>> '{}')::integer
    from jsonb_each(p_positions) e
   where a.id = e.key::uuid and a.blog_id = p_blog_id and a.shop_id = v_shop and a.position <> (e.value #>> '{}')::integer;
  get diagnostics v = row_count;
  return v;
end;
$$;
revoke execute on function article_positions_set(uuid, jsonb) from public, anon;
grant execute on function article_positions_set(uuid, jsonb) to authenticated;

-- 会員の一覧（0100）: ブログの並び順（p_sort があればそれ）で
drop function if exists articles_member_page(uuid, uuid, integer, integer, text, uuid, integer, uuid);
create or replace function articles_member_page(p_shop_id uuid, p_blog_id uuid, p_offset integer, p_limit integer, p_tag text,
  p_customer_id uuid, p_epoch integer, p_session_id uuid, p_sort text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_aud uuid[]; v_sort text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'articles_member_page: service_role only' using errcode = '42501'; end if;
  if p_offset < 0 or p_offset > 1200 or p_limit not between 1 and 50 then raise exception 'invalid_page'; end if;
  if p_sort is not null and p_sort not in ('new', 'title', 'manual') then raise exception 'invalid_sort' using errcode = '22023'; end if;
  v_sort := coalesce(p_sort, (select b.article_order from blogs b where b.id = p_blog_id and b.shop_id = p_shop_id), 'new');
  v_aud := banto_member_aud_live(p_shop_id, p_customer_id, p_epoch, p_session_id);
  return coalesce((select jsonb_agg(t.x order by t.n) from (
    select jsonb_build_object('id', a.id, 'shop_id', a.shop_id, 'blog_id', a.blog_id, 'handle', a.handle, 'title', a.title, 'body', a.body, 'excerpt', a.excerpt,
      'tags', a.tags, 'image_url', a.image_url, 'author', a.author, 'published_at', a.published_at, 'updated_at', a.updated_at, 'audience_id', a.audience_id,
      'position', a.position) x,
      row_number() over (order by
        case when v_sort = 'manual' then a.position end asc,
        case when v_sort = 'title' then a.title end asc,
        a.published_at desc, a.id desc) n
      from articles a
     where a.shop_id = p_shop_id and a.blog_id = p_blog_id and a.published and a.deleted_at is null and a.published_at <= now()
       and banto_shop_module_public(p_shop_id, 'blog')
       and (a.audience_id is null or a.audience_id = any(v_aud))
       and (p_tag is null or a.tags @> array[p_tag])
     order by n
     offset p_offset limit p_limit + 1) t), '[]'::jsonb);
end;
$$;
revoke execute on function articles_member_page(uuid, uuid, integer, integer, text, uuid, integer, uuid, text) from public, anon, authenticated;
grant execute on function articles_member_page(uuid, uuid, integer, integer, text, uuid, integer, uuid, text) to service_role;

insert into banto_migrations (version) values ('0116_blog_order');
