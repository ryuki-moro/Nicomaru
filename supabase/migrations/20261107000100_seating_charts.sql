-- 新郎新婦がつくる席次（#181）。
--
-- 新郎新婦は、プランナーから送られた卓の配置パターン（#180）から1つを選び、
-- 確認済み（#179）の出席者を卓に割り当てて、席次を提出する。
--
--   seating_charts      案件ごとに1行。選んだ配置パターン・状態・版（version）
--   seating_assignments ゲストごとに1行。どの卓の何番目の席か
--
-- 状態: draft（作成中）→ submitted（提出済み）→ approved（確定）／ returned（修正のお願い）。
--   approved／returned にするのはプランナーの確認（#182）。ここでは作成と提出だけを扱う。
--   新郎新婦が変えられるのは draft と returned のときだけ。
--
-- 二人が同時に編集したとき: 保存・提出は、読み込んだときの版（version）を一緒に送る。
-- 版が進んでいたら（もう一人が先に保存していたら）BH409 で断り、画面で最新を読み直してもらう。
--
-- 権限:
--   - 参照: 案件に触れられる利用者（新郎新婦・担当スタッフ）
--   - 変更: 新郎新婦だけが、下の関数を通して行う。表への直接の書き込みは許さない
--   - アーカイブ済みの案件は変更できない

-- ------------------------------------------------------------- seating_charts
create table seating_charts (
  case_id            uuid        primary key references wedding_cases(id) on delete cascade,
  -- 選んだ配置パターン。プランナーが消したら NULL に戻る（割り当ても卓と一緒に消える）
  layout_id          uuid        references seating_layouts(id) on delete set null,
  status             varchar(10) not null default 'draft',
  version            integer     not null default 0,
  -- プランナーからの修正のお願い（#182 で使う）
  feedback           text,
  submitted_at       timestamptz,
  updated_by_user_id uuid        references user_profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint seating_charts_status_check
    check (status in ('draft', 'submitted', 'approved', 'returned'))
);

create trigger seating_charts_updated_at_touch before update on seating_charts
  for each row execute function touch_updated_at();

-- -------------------------------------------------------- seating_assignments
create table seating_assignments (
  guest_id   uuid        primary key references case_guests(id) on delete cascade,
  case_id    uuid        not null references wedding_cases(id) on delete cascade,
  -- 卓が消されたら、その卓の人は未配置に戻る
  table_id   uuid        not null references seating_tables(id) on delete cascade,
  -- 卓の中の席順（0 から。主賓・乾杯のご発声を先にするのは画面側で行う）
  seat_order smallint    not null,
  created_at timestamptz not null default now(),
  constraint seating_assignments_order_check check (seat_order >= 0)
);

create index seating_assignments_case_idx on seating_assignments (case_id);
create index seating_assignments_table_idx on seating_assignments (table_id, seat_order);

-- ------------------------------------------------------------------------- RLS
alter table seating_charts enable row level security;
create policy seating_charts_select on seating_charts
  for select using (case_id in (select accessible_case_ids()) and case_is_visible(case_id));

alter table seating_assignments enable row level security;
create policy seating_assignments_select on seating_assignments
  for select using (case_id in (select accessible_case_ids()) and case_is_visible(case_id));

revoke all on seating_charts, seating_assignments from anon, authenticated;
grant select on seating_charts, seating_assignments to authenticated;

-- ------------------------------------------------------- 卓に座れるかの判定（DB 側）
-- ゲストのタグのキー（src/lib/guest-tags.ts と同じ形）。ご関係は新郎新婦が直した値を優先する
create or replace function seating_guest_keys(p_guest_id uuid) returns text[]
  language sql stable security definer set search_path = public, pg_temp as $$
  select array_remove(
           array[
             case when g.guest_side is not null then 'side:' || g.guest_side end,
             case when coalesce(g.relationship_override, g.relationship) is not null
                  then 'relationship:' || coalesce(g.relationship_override, g.relationship) end,
             case when g.age_category is not null then 'age:' || g.age_category end,
             case when coalesce(g.allergy_note, '') <> '' then 'allergy' end,
             case when g.seat_role is not null then 'role:' || g.seat_role end
           ]
           || coalesce(array(select 'assistance:' || n from unnest(g.assistance_needs) n), '{}')
           || coalesce(array(select 'tag:' || l.tag_id from case_guest_tag_links l
                              where l.guest_id = g.id), '{}'),
           null)
    from case_guests g
   where g.id = p_guest_id
$$;

-- src/lib/seating/layout.ts の tableAccepts() と同じ判定。
-- 同じ種類（":" より前）のキーどうしは「または」、種類が違えば「かつ」。空ならだれでも
create or replace function seating_table_accepts(p_allowed text[], p_keys text[]) returns boolean
  language sql immutable set search_path = public, pg_temp as $$
  select not exists (
    select 1
      from (select split_part(k, ':', 1) as kind, array_agg(k) as ks
              from unnest(coalesce(p_allowed, '{}')) k
             group by 1) g
     where not (g.ks && coalesce(p_keys, '{}')))
$$;

-- 席次に入れるゲスト: 出席の回答で、新郎新婦が確認済みにした人
create or replace function seating_guest_eligible(p_case_id uuid, p_guest_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from case_guests g
                  where g.id = p_guest_id and g.case_id = p_case_id
                    and g.invitation_status = 'reply_yes' and g.checked_at is not null)
$$;

revoke all on function seating_guest_keys(uuid) from public, anon, authenticated;
revoke all on function seating_guest_eligible(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ 共通の前提チェック
-- 新郎新婦本人の案件で、アーカイブされておらず、席次を変更できる状態であることを確かめる。
-- 席次の行が無ければ作り、行をロックして返す（同時の保存を順番に処理するため）。
create or replace function lock_seating_chart_for_couple(p_case_id uuid, p_version integer)
  returns seating_charts
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_chart seating_charts;
begin
  if not exists (select 1 from current_app_user() u where u.role = 'couple')
     or p_case_id is null
     or p_case_id not in (select accessible_case_ids())
     or not case_is_visible(p_case_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if exists (select 1 from wedding_cases where id = p_case_id and archived_at is not null) then
    raise exception 'アーカイブ済みの案件の席次は変更できません' using errcode = 'BH422';
  end if;

  insert into seating_charts (case_id) values (p_case_id) on conflict (case_id) do nothing;
  select * into v_chart from seating_charts where case_id = p_case_id for update;

  if v_chart.status not in ('draft', 'returned') then
    raise exception '提出済みの席次は変更できません' using errcode = 'BH422';
  end if;
  if v_chart.version <> coalesce(p_version, -1) then
    raise exception 'もう一人が先に席次を保存しました。最新の内容を読み込み直してから、もう一度操作してください'
      using errcode = 'BH409';
  end if;
  return v_chart;
end
$$;

revoke all on function lock_seating_chart_for_couple(uuid, integer) from public, anon, authenticated;

-- 割り当てが、配置パターン・ゲスト・卓の条件・定員に合っているかを確かめる（合わなければ例外）
create or replace function assert_seating_assignments_valid(p_case_id uuid, p_layout_id uuid)
  returns void
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from seating_assignments a
              where a.case_id = p_case_id
                and not seating_guest_eligible(p_case_id, a.guest_id)) then
    raise exception '席次に入れられるのは、出席で確認済みの方だけです' using errcode = 'BH422';
  end if;
  if exists (select 1 from seating_assignments a
               join seating_tables t on t.id = a.table_id
              where a.case_id = p_case_id and t.layout_id is distinct from p_layout_id) then
    raise exception '選んだ配置パターンにない卓があります' using errcode = 'BH422';
  end if;
  if exists (select 1 from seating_assignments a
               join seating_tables t on t.id = a.table_id
              where a.case_id = p_case_id
                and not seating_table_accepts(t.allowed_tags, seating_guest_keys(a.guest_id))) then
    raise exception '卓の「座れる人」の条件に合わない方がいます' using errcode = 'BH422';
  end if;
  if exists (select 1 from seating_assignments a
               join seating_tables t on t.id = a.table_id
              where a.case_id = p_case_id
              group by t.id, t.capacity
             having count(*) > t.capacity) then
    raise exception '定員を超えている卓があります' using errcode = 'BH422';
  end if;
end
$$;

revoke all on function assert_seating_assignments_valid(uuid, uuid) from public, anon, authenticated;

-- -------------------------------------------------------------- 席次の保存
-- p_assignments: [{guestId, tableId}, ...]。同じ卓の人は、配列の並びがそのまま席順になる。
-- 送らなかった人は未配置になる。戻り値は保存後の版。
create or replace function save_seating_chart(
  p_case_id     uuid,
  p_layout_id   uuid,
  p_version     integer,
  p_assignments jsonb
) returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_chart seating_charts;
  v_user  uuid;
begin
  v_chart := lock_seating_chart_for_couple(p_case_id, p_version);
  select u.id into v_user from current_app_user() u;

  if jsonb_typeof(coalesce(p_assignments, '[]'::jsonb)) <> 'array' then
    raise exception '席次の形が正しくありません' using errcode = 'BH422';
  end if;
  if p_layout_id is not null and not exists (
       select 1 from seating_layouts l
        where l.id = p_layout_id and l.case_id = p_case_id and l.offered_at is not null) then
    raise exception 'プランナーから届いた配置パターンを選んでください' using errcode = 'BH422';
  end if;
  if p_layout_id is null and jsonb_array_length(coalesce(p_assignments, '[]'::jsonb)) > 0 then
    raise exception '先に配置パターンを選んでください' using errcode = 'BH422';
  end if;
  if (select count(*) <> count(distinct a ->> 'guestId')
        from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb)) a) then
    raise exception '同じ方を2つの席に入れることはできません' using errcode = 'BH422';
  end if;

  delete from seating_assignments where case_id = p_case_id;
  insert into seating_assignments (guest_id, case_id, table_id, seat_order)
  select (a.v ->> 'guestId')::uuid,
         p_case_id,
         (a.v ->> 'tableId')::uuid,
         (row_number() over (partition by a.v ->> 'tableId' order by a.n) - 1)::smallint
    from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb)) with ordinality a(v, n);

  perform assert_seating_assignments_valid(p_case_id, p_layout_id);

  update seating_charts
     set layout_id = p_layout_id,
         version = version + 1,
         updated_by_user_id = v_user
   where case_id = p_case_id
  returning version into v_chart.version;
  return v_chart.version;
end
$$;

-- -------------------------------------------------------------- 席次の提出
-- 全員の席が決まり、条件と定員に合っているときだけ提出できる。提出後は変更できない。
create or replace function submit_seating_chart(p_case_id uuid, p_version integer)
  returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_chart    seating_charts;
  v_user     uuid;
  v_unplaced integer;
begin
  v_chart := lock_seating_chart_for_couple(p_case_id, p_version);
  select u.id into v_user from current_app_user() u;

  if v_chart.layout_id is null or not exists (
       select 1 from seating_layouts l where l.id = v_chart.layout_id and l.offered_at is not null) then
    raise exception '配置パターンを選んで席を決めてから提出してください' using errcode = 'BH422';
  end if;

  select count(*) into v_unplaced
    from case_guests g
   where g.case_id = p_case_id and g.invitation_status = 'reply_yes' and g.checked_at is not null
     and not exists (select 1 from seating_assignments a where a.guest_id = g.id);
  if v_unplaced > 0 then
    raise exception 'まだ席の決まっていない方が%名います', v_unplaced using errcode = 'BH422';
  end if;

  perform assert_seating_assignments_valid(p_case_id, v_chart.layout_id);

  update seating_charts
     set status = 'submitted',
         submitted_at = now(),
         version = version + 1,
         updated_by_user_id = v_user
   where case_id = p_case_id
  returning version into v_chart.version;
  return v_chart.version;
end
$$;

revoke all on function save_seating_chart(uuid, uuid, integer, jsonb) from public, anon;
revoke all on function submit_seating_chart(uuid, integer) from public, anon;
grant execute on function save_seating_chart(uuid, uuid, integer, jsonb) to authenticated;
grant execute on function submit_seating_chart(uuid, integer) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on seating_charts, seating_assignments to service_role;
  end if;
end
$$;
