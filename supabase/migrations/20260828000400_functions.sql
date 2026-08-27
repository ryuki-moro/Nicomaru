-- BridalHub / にこまる — RLS共通関数と業務用 security definer 関数
-- 正本: 基本設計書 Version 1.2 付録A「RLSポリシー全文・補足」および 6-3-4。
--
-- 【なぜ security definer が必須か】
-- ポリシー式の中で他テーブルを直接参照すると、そのテーブルのRLSも評価される。
-- couple_profiles → wedding_cases → couple_profiles は相互に展開され、
-- 42P17（infinite recursion detected in policy）で実行時に失敗する。
-- したがって本関数群は「重複削減のため」ではなく「再帰を断ち切るため」に必須である（6-3-4）。
--
-- すべての関数は status='active' を条件に含める。
-- これにより U03／U04 で停止・削除した利用者は、セッションが生きていてもDB層で遮断される（13-1）。

-- ---------------------------------------------------------------- 0. 共通関数
create or replace function current_app_user()
  returns table (id uuid, role text, venue_id uuid)
  language sql stable security definer set search_path = public, pg_temp as $$
  select up.id, up.role, up.venue_id
    from user_profiles up
   where up.auth_user_id = auth.uid()
     and up.status = 'active'
$$;

create or replace function is_system_admin() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from current_app_user() u where u.role = 'system_admin')
$$;

create or replace function is_admin_of(v uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from current_app_user() u where u.role = 'admin' and u.venue_id = v)
$$;

-- 現在の利用者が触れてよい案件ID。case_id を持つ全テーブルはこの1関数だけを見る。
-- planner 分岐を落とすと案件管理画面が0行になる（6-3-3）。
create or replace function accessible_case_ids() returns setof uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select c.id
    from wedding_cases c
    cross join current_app_user() u
   where u.role = 'system_admin'
      or (u.role = 'admin'   and c.venue_id = u.venue_id)
      or (u.role = 'planner' and c.primary_planner_id = u.id)
      or (u.role = 'couple'  and c.id in (select cp.case_id from couple_profiles cp
                                           where cp.user_profile_id = u.id))
$$;

create or replace function can_see_archived() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from current_app_user() u where u.role in ('admin', 'system_admin'))
$$;

create or replace function case_is_visible(cid uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from wedding_cases c
                  where c.id = cid
                    and (c.archived_at is null or can_see_archived()))
$$;

-- plan_task_templates のポリシーから plan_types を直接参照しないための解決関数（付録A）
create or replace function plan_type_venue(p uuid) returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select venue_id from plan_types where id = p
$$;

create or replace function notification_owner(p uuid)
  returns table (recipient_user_id uuid, venue_id uuid)
  language sql stable security definer set search_path = public, pg_temp as $$
  select n.recipient_user_id, n.venue_id from notifications n where n.id = p
$$;

-- ------------------------------------------------- 1. memo の staff 限定アクセス
-- 行レベルポリシーでは列を隠せない。memo は列レベル権限で剥奪し、本関数経由でのみ参照する（付録A）。
create or replace function get_couple_memo(p_couple_profile_id uuid) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
  select cp.memo
    from couple_profiles cp
    cross join current_app_user() u
   where cp.id = p_couple_profile_id
     and cp.case_id in (select accessible_case_ids())
     and u.role in ('planner', 'admin', 'system_admin')
$$;

-- --------------------------------------------------- 2. couple の提出に伴う更新
-- case_tasks に couple の update ポリシーを開けないため、提出時の状態遷移を本関数へ集約する（付録A）。
create or replace function submit_task(p_case_task_id uuid, p_status text) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_case uuid;
  v_role text;
begin
  select ct.case_id into v_case from case_tasks ct where ct.id = p_case_task_id;
  select u.role   into v_role from current_app_user() u;

  if v_case is null
     or v_case not in (select accessible_case_ids())
     or not case_is_visible(v_case) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_role <> 'couple' or p_status <> 'submitted' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update case_tasks
     set status = p_status, last_submitted_at = now(), updated_at = now()
   where id = p_case_task_id;
end
$$;

-- ------------------------------------------------------------- 3. 監査ログ書き込み
-- actor_user_id を引数で受け取らず関数内で解決することで、実行者の偽装を防ぐ（付録A）。
create or replace function log_audit(p_action text, p_target_type text,
                                     p_target_id uuid, p_detail jsonb)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into audit_logs (actor_user_id, action, target_type, target_id, detail_json)
  values ((select u.id from current_app_user() u), p_action, p_target_type, p_target_id, p_detail);
end
$$;

-- --------------------------------------------------------------- 4. 案件番号の採番
-- 書式: venues.code + '-' + 西暦4桁 + '-' + 式場内連番4桁（例 BRIDAL01-2026-0001）。
-- 連番は式場×年でリセットする（5-7）。最終的な一意性は UNIQUE(venue_id, case_code) が担保し、
-- 競合時はサービス層が最大3回まで再試行する。
create or replace function next_case_code(p_venue_id uuid, p_year integer) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_code   text;
  v_prefix text;
  v_next   integer;
begin
  select code into v_code from venues where id = p_venue_id;
  if v_code is null then
    raise exception 'venue not found' using errcode = '23503';
  end if;

  v_prefix := v_code || '-' || to_char(p_year, 'FM0000') || '-';

  select coalesce(max(substring(case_code from char_length(v_prefix) + 1)::integer), 0) + 1
    into v_next
    from wedding_cases
   where venue_id = p_venue_id
     and case_code like v_prefix || '%'
     and substring(case_code from char_length(v_prefix) + 1) ~ '^[0-9]{4}$';

  return v_prefix || to_char(v_next, 'FM0000');
end
$$;

-- ----------------------------------------------------------- 5. レート制限の判定
-- サーバーレス実行はインスタンスをまたぐためインメモリカウンタは機能しない。
-- insert ... on conflict do update returning による原子的インクリメントで判定する（5-3）。
-- 戻り値 true = 許可、false = 上限超過（API は 429 RATE_LIMITED を返す）。
create or replace function check_rate_limit(p_key_type text, p_key_hash text,
                                            p_window_seconds integer, p_max_attempts integer)
  returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_window timestamptz;
  v_count  integer;
begin
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into auth_rate_limits (key_type, key_hash, window_start, attempt_count)
  values (p_key_type, p_key_hash, v_window, 1)
  on conflict (key_type, key_hash, window_start)
  do update set attempt_count = auth_rate_limits.attempt_count + 1,
                updated_at    = now()
  returning attempt_count into v_count;

  return v_count <= p_max_attempts;
end
$$;

-- --------------------------------------------------------------- 6. updated_at 保守
create or replace function touch_updated_at() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'venues', 'user_profiles', 'plan_types', 'wedding_cases', 'couple_profiles',
    'case_invitations', 'case_guests', 'task_templates', 'plan_task_templates',
    'case_tasks', 'timeline_items', 'auth_rate_limits', 'risk_rules',
    'meeting_notes', 'ai_prompt_templates', 'ai_jobs'
  ] loop
    execute format(
      'create trigger %I_touch before update on %I for each row execute function touch_updated_at()',
      t || '_updated_at', t);
  end loop;
end
$$;
