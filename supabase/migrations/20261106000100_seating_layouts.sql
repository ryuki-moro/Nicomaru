-- 卓の配置パターン（#180）。
--
-- 席次を決める前に、プランナーが会場の形（横型・縦型）に合わせた卓の配置を用意し、
-- 新郎新婦へ送る。新郎新婦は送られたパターンから1つを選んで席を決める（#181）。
--
-- 卓は配置パターンの中の JSON ではなく行として持つ。#181 でゲストを卓へ割り当てるとき、
-- 卓の ID を外部キーで参照するため。保存のたびに卓の ID が変わらないよう、
-- save_seating_layout() は ID の付いた卓を更新し、ID の無い卓だけを追加する。
--
-- 卓の「座れる人」は、ゲストのタグのキー（src/lib/guest-tags.ts）の配列で持つ。
--   例: {side:groom, relationship:colleague, relationship:teacher}
-- 照らし合わせ方は src/lib/seating/layout.ts の tableAccepts()（同じ種類どうしは「または」、
-- 種類が違えば「かつ」）。空の配列は「だれでも座れる」。
--
-- 権限:
--   - 参照: 案件に触れられる利用者（accessible_case_ids()）。ただし新郎新婦は送られたパターンだけ
--   - 変更: 担当プランナー・会場管理者・システム管理者だけが、下の関数を通して行う。
--           表への直接の insert／update／delete は許さない（新郎新婦の書き込みを確実に止めるため）
--   - アーカイブ済みの案件は変更できない

-- ------------------------------------------------------------ seating_layouts
create table seating_layouts (
  id                 uuid        primary key default gen_random_uuid(),
  case_id            uuid        not null references wedding_cases(id) on delete cascade,
  name               varchar(30) not null,
  hall_shape         varchar(10) not null,
  -- 新郎新婦へ送った日時。NULL の間は新郎新婦に見えない
  offered_at         timestamptz,
  created_by_user_id uuid        references user_profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint seating_layouts_name_check check (length(btrim(name)) > 0),
  constraint seating_layouts_hall_shape_check check (hall_shape in ('wide', 'tall'))
);

create index seating_layouts_case_idx on seating_layouts (case_id, created_at);

create trigger seating_layouts_updated_at_touch before update on seating_layouts
  for each row execute function touch_updated_at();

-- ------------------------------------------------------------- seating_tables
create table seating_tables (
  id           uuid         primary key default gen_random_uuid(),
  layout_id    uuid         not null references seating_layouts(id) on delete cascade,
  name         varchar(20)  not null,
  capacity     smallint     not null,
  -- round = 円卓、rect = 長テーブル（横向き）、rectv = 長テーブル（縦向き。高砂に向かって並ぶ）
  shape        varchar(10)  not null,
  -- 会場図の中の位置（左上を 0、右下を 1 とした割合）
  pos_x        numeric(4,3) not null,
  pos_y        numeric(4,3) not null,
  allowed_tags text[]       not null default '{}',
  sort_order   smallint     not null,
  created_at   timestamptz  not null default now(),
  updated_at   timestamptz  not null default now(),
  constraint seating_tables_name_check check (length(btrim(name)) > 0),
  constraint seating_tables_capacity_check check (capacity between 2 and 20),
  constraint seating_tables_shape_check check (shape in ('round', 'rect', 'rectv')),
  constraint seating_tables_pos_check check (pos_x between 0 and 1 and pos_y between 0 and 1),
  constraint seating_tables_tags_check check (cardinality(allowed_tags) <= 30)
);

create index seating_tables_layout_idx on seating_tables (layout_id, sort_order);

create trigger seating_tables_updated_at_touch before update on seating_tables
  for each row execute function touch_updated_at();

-- ------------------------------------------------------------------------- RLS
create or replace function is_staff_user() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from current_app_user() u
                  where u.role in ('planner', 'admin', 'system_admin'))
$$;

alter table seating_layouts enable row level security;
create policy seating_layouts_select on seating_layouts
  for select using (
    case_id in (select accessible_case_ids())
    and case_is_visible(case_id)
    and (offered_at is not null or is_staff_user()));

-- 卓は case_id を持たないため、配置パターン側の見え方に従う（上のポリシーがそのまま効く）
alter table seating_tables enable row level security;
create policy seating_tables_select on seating_tables
  for select using (exists (select 1 from seating_layouts l where l.id = layout_id));

revoke all on seating_layouts, seating_tables from anon, authenticated;
grant select on seating_layouts, seating_tables to authenticated;

-- ------------------------------------------------------------ 共通の前提チェック
-- 案件の担当スタッフであること、案件がアーカイブされていないことを確かめ、利用者IDを返す
create or replace function assert_seating_editable(p_case_id uuid) returns uuid
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_user jsonb;
begin
  v_user := assert_case_staff(p_case_id);
  if p_case_id is null or not case_is_visible(p_case_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if exists (select 1 from wedding_cases where id = p_case_id and archived_at is not null) then
    raise exception 'アーカイブ済みの案件の卓の配置は変更できません' using errcode = 'BH422';
  end if;
  return (v_user ->> 'user_id')::uuid;
end
$$;

revoke all on function is_staff_user() from public, anon;
grant execute on function is_staff_user() to authenticated;
revoke all on function assert_seating_editable(uuid) from public, anon, authenticated;

-- 送られた「座れる人」のキーを、重複を除いて送られた順のまま配列にする
create or replace function seating_tag_list(p_tags jsonb) returns text[]
  language sql immutable set search_path = public, pg_temp as $$
  select coalesce(array_agg(k.key order by k.n), '{}')
    from (select e.key, min(e.n) as n
            from jsonb_array_elements_text(coalesce(p_tags, '[]'::jsonb)) with ordinality e(key, n)
           group by e.key) k
$$;

-- ------------------------------------------------------ 配置パターンの保存
-- p_layout_id が NULL なら新しく作り、あれば名前・会場の形・卓をまとめて置き換える。
-- p_tables は卓の配列: [{id?, name, capacity, shape, x, y, allowedTags: [...]}, ...]
-- 配列の並びがそのまま卓の並び（sort_order）になる。
create or replace function save_seating_layout(
  p_case_id    uuid,
  p_layout_id  uuid,
  p_name       text,
  p_hall_shape text,
  p_tables     jsonb
) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user   uuid;
  v_layout uuid := p_layout_id;
  v_ids    uuid[];
begin
  v_user := assert_seating_editable(p_case_id);

  if jsonb_typeof(p_tables) is distinct from 'array'
     or jsonb_array_length(p_tables) < 1
     or jsonb_array_length(p_tables) > 26 then
    raise exception '卓は1〜26卓で作ってください' using errcode = 'BH422';
  end if;

  -- 卓の「座れる人」は、決まった形のタグのキーか、この案件の自由タグだけ
  if exists (
    select 1
      from jsonb_array_elements(p_tables) t,
           jsonb_array_elements_text(coalesce(t -> 'allowedTags', '[]'::jsonb)) k(key)
     where not (
       k.key ~ '^(side|relationship|age|assistance|role):[a-z_]+$'
       or k.key = 'allergy'
       or (k.key ~ '^tag:[0-9a-f-]{36}$'
           and exists (select 1 from case_guest_tags ct
                        where ct.id = substr(k.key, 5)::uuid and ct.case_id = p_case_id))
     )
  ) then
    raise exception '卓の「座れる人」に使えない条件があります' using errcode = 'BH422';
  end if;

  if v_layout is null then
    if (select count(*) from seating_layouts where case_id = p_case_id) >= 20 then
      raise exception '配置パターンは1つの案件に20個まで作れます' using errcode = 'BH422';
    end if;
    insert into seating_layouts (case_id, name, hall_shape, created_by_user_id)
    values (p_case_id, btrim(p_name), p_hall_shape, v_user)
    returning id into v_layout;
  else
    update seating_layouts
       set name = btrim(p_name), hall_shape = p_hall_shape
     where id = v_layout and case_id = p_case_id;
    if not found then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  -- ID の付いた卓は、このパターンの卓でなければならない（別パターンの卓を書き換えさせない）
  select coalesce(array_agg((t ->> 'id')::uuid), '{}') into v_ids
    from jsonb_array_elements(p_tables) t
   where t ? 'id' and t ->> 'id' is not null;
  if exists (
    select 1 from unnest(v_ids) i(id)
     where not exists (select 1 from seating_tables st where st.id = i.id and st.layout_id = v_layout)
  ) then
    raise exception '別の配置パターンの卓は変更できません' using errcode = 'BH422';
  end if;

  delete from seating_tables where layout_id = v_layout and not (id = any (v_ids));

  update seating_tables st
     set name         = btrim(t.v ->> 'name'),
         capacity     = (t.v ->> 'capacity')::smallint,
         shape        = t.v ->> 'shape',
         pos_x        = round((t.v ->> 'x')::numeric, 3),
         pos_y        = round((t.v ->> 'y')::numeric, 3),
         allowed_tags = seating_tag_list(t.v -> 'allowedTags'),
         sort_order   = t.n - 1
    from jsonb_array_elements(p_tables) with ordinality t(v, n)
   where t.v ->> 'id' is not null and st.id = (t.v ->> 'id')::uuid;

  insert into seating_tables (layout_id, name, capacity, shape, pos_x, pos_y, allowed_tags, sort_order)
  select v_layout,
         btrim(t.v ->> 'name'),
         (t.v ->> 'capacity')::smallint,
         t.v ->> 'shape',
         round((t.v ->> 'x')::numeric, 3),
         round((t.v ->> 'y')::numeric, 3),
         seating_tag_list(t.v -> 'allowedTags'),
         t.n - 1
    from jsonb_array_elements(p_tables) with ordinality t(v, n)
   where t.v ->> 'id' is null;

  return v_layout;
end
$$;

-- ------------------------------------------------ 新郎新婦へ送る／送るのをやめる
create or replace function set_seating_layout_offered(p_layout_id uuid, p_offered boolean)
  returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_case uuid;
begin
  select case_id into v_case from seating_layouts where id = p_layout_id;
  if v_case is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform assert_seating_editable(v_case);

  update seating_layouts
     set offered_at = case when p_offered then coalesce(offered_at, now()) else null end
   where id = p_layout_id;
end
$$;

-- -------------------------------------------------------------- 配置パターンの削除
create or replace function delete_seating_layout(p_layout_id uuid)
  returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_case uuid;
begin
  select case_id into v_case from seating_layouts where id = p_layout_id;
  if v_case is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform assert_seating_editable(v_case);

  delete from seating_layouts where id = p_layout_id;
end
$$;

revoke all on function save_seating_layout(uuid, uuid, text, text, jsonb) from public, anon;
revoke all on function set_seating_layout_offered(uuid, boolean) from public, anon;
revoke all on function delete_seating_layout(uuid) from public, anon;
grant execute on function save_seating_layout(uuid, uuid, text, text, jsonb) to authenticated;
grant execute on function set_seating_layout_offered(uuid, boolean) to authenticated;
grant execute on function delete_seating_layout(uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on seating_layouts, seating_tables to service_role;
  end if;
end
$$;
