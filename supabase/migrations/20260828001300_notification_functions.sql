-- BridalHub / にこまる — 通知（Phase 2）
--
-- 正本: 基本設計書 Version 1.2 6-9「業務ロジック：通知」／7-1〜7-3／付録D／5-6。
--
-- 6-9 の要点と、それを DB でどう担保するか:
--   - LINE公式アカウントの無料枠（月200通程度）を前提に、LINE通知は最重要通知に限定する
--   - 案件あたり LINE 週1通、式場あたり LINE 月180通（月200通の安全マージン）
--   - 上限到達時はメールへ切り替えて送信し、切替をログに残す。**通知自体は落とさない**
--   - 「カウント判定と送信可否判定は、DBの一意制約に対する update ... returning でアトミックに行い、
--      同時リクエストによる上限超過の競合を防ぐ」
--   - 上限値はコードに直書きせず設定として持つ（5-6: Phase 2 は設定テーブル）

-- ========================================================== 1. 通知の設定値（5-6）
-- venue_id が NULL の行がシステム既定。式場別に上書きできる。
create table notification_settings (
  id                       uuid        primary key default gen_random_uuid(),
  venue_id                 uuid        references venues(id) on delete cascade,
  line_per_case_per_week   integer     not null default 1,
  line_per_venue_per_month integer     not null default 180,
  -- 6-12「期限N日前・期限超過を抽出し notifications を作成」の N。
  -- 設計は具体値を固定していないため設定として持つ（6-9「コード直書きは避ける」）。
  due_reminder_days_before integer     not null default 7,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint notification_settings_case_limit_check   check (line_per_case_per_week >= 0),
  constraint notification_settings_venue_limit_check  check (line_per_venue_per_month >= 0),
  constraint notification_settings_reminder_check     check (due_reminder_days_before >= 0)
);
comment on table notification_settings is
  'LINE送信上限の設定（6-9）。venue_id が NULL の行がシステム既定。5-6 により Phase 2 は設定テーブルで持つ';

create unique index notification_settings_venue_uk
  on notification_settings (coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid));

insert into notification_settings (venue_id) values (null);

-- ======================================== 2. 送信上限のカウンタ（5-6 の補助テーブル）
create table notification_quota_counters (
  id           uuid        primary key default gen_random_uuid(),
  scope        varchar(20) not null,
  scope_id     uuid        not null,
  window_start date        not null,
  sent_count   integer     not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint notification_quota_scope_check check (scope in ('case_week', 'venue_month')),
  constraint notification_quota_uk unique (scope, scope_id, window_start)
);
comment on table notification_quota_counters is
  'LINE送信上限のカウンタ（6-9／5-6）。一意制約に対する upsert で原子的に数える';

-- ============================================== 3. LINE送信枠の原子的な確保（6-9）
-- 戻り値 true = LINE で送ってよい、false = 上限のためメールへ切り替える。
--
-- 「案件×週」と「式場×月」の2つを同時に満たす必要がある。
-- 先に両方を加算し、どちらかが上限を超えたら例外を投げて**内側のサブトランザクションごと戻す**。
-- こうすると「片方だけ加算されたまま false を返す」状態が生まれない。
-- plpgsql の BEGIN ... EXCEPTION はサブトランザクションを張るので、この用途に使える。
create or replace function claim_line_quota(p_case_id uuid, p_venue_id uuid) returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_case_limit  integer;
  v_venue_limit integer;
  v_case_count  integer;
  v_venue_count integer;
begin
  -- 式場別の設定があればそれを、無ければシステム既定（venue_id is null）を使う
  select s.line_per_case_per_week, s.line_per_venue_per_month
    into v_case_limit, v_venue_limit
    from notification_settings s
   where s.venue_id = p_venue_id;

  if v_case_limit is null then
    select s.line_per_case_per_week, s.line_per_venue_per_month
      into v_case_limit, v_venue_limit
      from notification_settings s
     where s.venue_id is null;
  end if;

  -- 設定が1行も無ければ LINE を使わない（黙って無制限に送るより安全側に倒す）
  if v_case_limit is null then
    return false;
  end if;

  begin
    -- 週は月曜始まり、月は1日始まりで数える（date_trunc の既定に合わせる）
    insert into notification_quota_counters (scope, scope_id, window_start, sent_count)
    values ('case_week', p_case_id, date_trunc('week', current_date)::date, 1)
    on conflict (scope, scope_id, window_start)
    do update set sent_count = notification_quota_counters.sent_count + 1,
                  updated_at = now()
    returning sent_count into v_case_count;

    insert into notification_quota_counters (scope, scope_id, window_start, sent_count)
    values ('venue_month', p_venue_id, date_trunc('month', current_date)::date, 1)
    on conflict (scope, scope_id, window_start)
    do update set sent_count = notification_quota_counters.sent_count + 1,
                  updated_at = now()
    returning sent_count into v_venue_count;

    if v_case_count > v_case_limit or v_venue_count > v_venue_limit then
      -- 加算を取り消すために例外で抜ける。サブトランザクションが巻き戻る。
      raise exception 'line quota exceeded' using errcode = 'BH409';
    end if;
  exception
    when others then
      return false;
  end;

  return true;
end
$$;

revoke execute on function claim_line_quota(uuid, uuid) from public;
-- 送信は API 層（Service Role／内部処理）から行う。authenticated には開かない。

-- ================================================= 4. 通知の作成（planner／admin）
-- notifications には select と「受信者による既読化」の update しか無く（付録A）、
-- planner が 7-1 の重要通知を作る経路が無い。作成だけを許す関数を置く。
create or replace function create_notification(
  p_case_id           uuid,
  p_recipient_user_id uuid,
  p_channel           text,
  p_notification_type text,
  p_title             text,
  p_body              text
) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_role  text;
  v_me    uuid;
  v_venue uuid;
  v_id    uuid;
begin
  select u.id, u.role into v_me, v_role from current_app_user() u;

  if v_role not in ('planner', 'admin', 'system_admin') then
    raise exception 'この操作を行う権限がありません' using errcode = '42501';
  end if;

  if p_case_id is null
     or p_case_id not in (select accessible_case_ids())
     or not case_is_visible(p_case_id) then
    raise exception 'この操作を行う権限がありません' using errcode = '42501';
  end if;

  select c.venue_id into v_venue from wedding_cases c where c.id = p_case_id;

  -- 宛先は同じ案件に属する利用者に限る。任意の user_profiles.id を渡せてはいけない。
  if not exists (
    select 1 from couple_profiles cp
     where cp.case_id = p_case_id and cp.user_profile_id = p_recipient_user_id
  ) then
    raise exception '宛先が案件に紐付いていません' using errcode = 'BH422';
  end if;

  insert into notifications
    (venue_id, case_id, recipient_user_id, created_by, channel, notification_type, title, body,
     status)
  values
    (v_venue, p_case_id, p_recipient_user_id, v_me, p_channel, p_notification_type,
     p_title, p_body, 'queued')
  returning id into v_id;

  return v_id;
end
$$;

revoke execute on function create_notification(uuid, uuid, text, text, text, text) from public;
grant  execute on function create_notification(uuid, uuid, text, text, text, text) to authenticated;

-- ============================================================== 5. 権限（grant）
-- 000500 の一括 grant は「その時点で存在した表」にしか効かない。
-- 以降に作った表は個別に付与する（batch_runs で同じ穴を踏んでいる）。
alter table notification_settings enable row level security;
grant select on notification_settings to authenticated;
-- 参照は自式場ぶんとシステム既定。変更は admin／system_admin（T03 と同じ考え方）。
create policy notification_settings_select on notification_settings
  for select using (
    is_system_admin() or venue_id is null
    or venue_id = (select u.venue_id from current_app_user() u));
create policy notification_settings_write on notification_settings
  for all using (is_system_admin() or (venue_id is not null and is_admin_of(venue_id)))
  with check (is_system_admin() or (venue_id is not null and is_admin_of(venue_id)));
grant insert, update, delete on notification_settings to authenticated;

-- カウンタはアプリから直接参照させず、claim_line_quota() 経由のみとする
-- （auth_rate_limits と同じ扱い。付録A）。
alter table notification_quota_counters enable row level security;
revoke select, insert, update, delete on notification_quota_counters from authenticated;

create index notification_quota_window_idx
  on notification_quota_counters (scope, window_start);
