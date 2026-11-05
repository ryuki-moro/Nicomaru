-- ゲストのタグ（座席表で卓の役割と照らし合わせて分類するため）。
--
-- タグは2種類ある:
--   - 自動タグ: 出欠回答の列（新郎新婦側・関係・年齢区分・アレルギー）から画面側で導く。保存しない
--   - 自由タグ: 新郎新婦（担当プランナーも可）が案件ごとに作る「大学の友人」などの分類。ここで保存する
-- 権限は case_guests と同じく、案件に触れられる利用者に限る（付録A accessible_case_ids()）。

-- ------------------------------------------------------- case_guest_tags 自由タグ
create table case_guest_tags (
  id         uuid        primary key default gen_random_uuid(),
  case_id    uuid        not null references wedding_cases(id) on delete cascade,
  name       varchar(20) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint case_guest_tags_name_check check (length(btrim(name)) > 0)
);

-- 同じ案件で同名のタグは作れない（大文字小文字・前後の空白は区別しない）
create unique index case_guest_tags_case_name_uk
  on case_guest_tags (case_id, lower(btrim(name)));

create trigger case_guest_tags_updated_at_touch before update on case_guest_tags
  for each row execute function touch_updated_at();

-- ------------------------------------------------ case_guest_tag_links ゲストとの対応
create table case_guest_tag_links (
  guest_id   uuid        not null references case_guests(id) on delete cascade,
  tag_id     uuid        not null references case_guest_tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (guest_id, tag_id)
);

create index case_guest_tag_links_tag_idx on case_guest_tag_links (tag_id);

-- ------------------------------------------------------------------------- RLS
alter table case_guest_tags enable row level security;
create policy case_guest_tags_all on case_guest_tags
  for all using (case_id in (select accessible_case_ids()) and case_is_visible(case_id))
  with check (case_id in (select accessible_case_ids()) and case_is_visible(case_id));

-- 対応表は case_id を持たないため、タグ側の案件で判定する。付け替えは set_guest_tags() に閉じる
alter table case_guest_tag_links enable row level security;
create policy case_guest_tag_links_select on case_guest_tag_links
  for select using (exists (
    select 1 from case_guest_tags t
     where t.id = tag_id
       and t.case_id in (select accessible_case_ids()) and case_is_visible(t.case_id)));

revoke all on case_guest_tags, case_guest_tag_links from anon;
grant select, insert, update, delete on case_guest_tags to authenticated;
revoke all on case_guest_tag_links from authenticated;
grant select on case_guest_tag_links to authenticated;

-- ---------------------------------------------------------- ゲストのタグの付け替え
-- 指定したゲストの自由タグを p_tag_ids の内容に置き換える。
-- 別案件のタグを付けられると、他案件のタグ名が一覧に漏れるため、同じ案件のタグに限る。
create or replace function set_guest_tags(p_guest_id uuid, p_tag_ids uuid[])
  returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_case uuid;
begin
  select g.case_id into v_case from case_guests g where g.id = p_guest_id;
  if v_case is null
     or v_case not in (select accessible_case_ids())
     or not case_is_visible(v_case) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if exists (select 1 from wedding_cases where id = v_case and archived_at is not null) then
    raise exception 'archived' using errcode = '42501';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_tag_ids, '{}')) as t(id)
     where not exists (select 1 from case_guest_tags ct where ct.id = t.id and ct.case_id = v_case)
  ) then
    raise exception '対象の案件にないタグは付けられません' using errcode = 'BH422';
  end if;

  delete from case_guest_tag_links where guest_id = p_guest_id;
  insert into case_guest_tag_links (guest_id, tag_id)
  select distinct p_guest_id, t.id from unnest(coalesce(p_tag_ids, '{}')) as t(id);
end
$$;

revoke all on function set_guest_tags(uuid, uuid[]) from public, anon;
grant execute on function set_guest_tags(uuid, uuid[]) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on case_guest_tags, case_guest_tag_links to service_role;
  end if;
end
$$;
