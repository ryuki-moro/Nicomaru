-- 基本設計9-1: 業務更新と同一トランザクションで監査する。
-- 値は複写せず、変更された列名だけを保存する。通常の提出・確認は業務ログに任せる。
create or replace function audit_managed_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor record;
  v_old jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  v_new jsonb := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  v_fields jsonb;
begin
  select * into v_actor from current_app_user();
  -- サーバーの定期処理やseedを人の管理操作に偽装しない。
  if v_actor.id is null then return coalesce(new, old); end if;

  select jsonb_agg(k order by k) into v_fields
    from jsonb_object_keys(v_old || v_new) k
   where k not in ('created_at', 'updated_at') and v_old->k is distinct from v_new->k;
  if v_fields is null then return coalesce(new, old); end if;

  if tg_table_name = 'wedding_cases' then
    if not (v_fields ? 'primary_planner_id') then return new; end if;
    perform log_audit('case.planner_changed', tg_table_name, new.id,
                     jsonb_build_object('changed', jsonb_build_array('primary_planner_id')));
  elsif tg_table_name = 'user_profiles' then
    if not (v_fields ? 'role') then return new; end if;
    perform log_audit('user.role_changed', tg_table_name, new.id,
                     jsonb_build_object('changed', jsonb_build_array('role')));
  else
    if v_actor.role not in ('admin', 'system_admin') then return coalesce(new, old); end if;
    if tg_table_name = 'case_tasks' and tg_op = 'UPDATE'
       and not exists (select 1 from jsonb_array_elements_text(v_fields) f
                       where f not in ('status', 'confirmed_by', 'confirmed_at', 'current_submission_id')) then
      return new;
    end if;
    perform log_audit(tg_argv[0] || '.' || lower(tg_op), tg_table_name,
                     coalesce(new.id, old.id), jsonb_build_object('changed', v_fields));
  end if;
  return coalesce(new, old);
end
$$;
revoke all on function audit_managed_change() from public, anon, authenticated;

create trigger audit_task_templates after insert or update or delete on task_templates
  for each row execute function audit_managed_change('task_template');
create trigger audit_plan_types after insert or update or delete on plan_types
  for each row execute function audit_managed_change('plan_type');
create trigger audit_plan_task_templates after insert or update or delete on plan_task_templates
  for each row execute function audit_managed_change('plan_task_template');
create trigger audit_risk_rules after insert or update or delete on risk_rules
  for each row execute function audit_managed_change('risk_rule');
create trigger audit_notification_settings after insert or update or delete on notification_settings
  for each row execute function audit_managed_change('notification_setting');
create trigger audit_ai_prompt_templates after insert or update or delete on ai_prompt_templates
  for each row execute function audit_managed_change('ai_prompt_template');
-- UPDATEは既存の式場APIが記録する。作成時に途中で管理者発行が失敗しても式場の記録は残す。
create trigger audit_venue_create_delete after insert or delete on venues
  for each row execute function audit_managed_change('venue');
create trigger audit_user_role after update of role on user_profiles
  for each row execute function audit_managed_change('user');
create trigger audit_case_planner after update of primary_planner_id on wedding_cases
  for each row execute function audit_managed_change('case');
create trigger audit_case_tasks after insert or update or delete on case_tasks
  for each row execute function audit_managed_change('case_task');
create trigger audit_meeting_notes after insert or update or delete on meeting_notes
  for each row execute function audit_managed_change('meeting_note');
create trigger audit_meeting_sheets after insert or update or delete on meeting_sheets
  for each row execute function audit_managed_change('meeting_sheet');
create trigger audit_follow_logs after insert or update or delete on follow_logs
  for each row execute function audit_managed_change('follow_log');

-- 認証失敗は同一メールのHMACでpassword/OTPを合算し、直近1時間で10件を検知する。
-- 実失敗時刻をwindow_startとして使うため、時計の正時をまたいでも取りこぼさない。
alter table auth_rate_limits drop constraint auth_rate_limits_key_type_check;
alter table auth_rate_limits add constraint auth_rate_limits_key_type_check
  check (key_type in ('initial_register', 'otp_request', 'otp_verify',
                      'otp_verify_failure', 'password_reset', 'password_login', 'login_failure'));
create index audit_auth_failure_account_idx
  on audit_logs ((detail_json->>'account_hash'), created_at desc)
  where action = 'auth.login_failures';

create or replace function record_auth_failure(p_account_hash text, p_method text)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now timestamptz;
  v_count integer;
begin
  if p_account_hash is null or p_account_hash !~ '^[0-9a-f]{64}$'
     or p_method is null or p_method not in ('password', 'otp') then
    raise exception 'Invalid authentication event' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('auth-failure:' || p_account_hash, 0));
  v_now := clock_timestamp();
  insert into auth_rate_limits(key_type, key_hash, window_start, attempt_count)
    values ('login_failure', p_account_hash, v_now, 1)
    on conflict(key_type, key_hash, window_start) do update
      set attempt_count = auth_rate_limits.attempt_count + 1;
  select coalesce(sum(attempt_count), 0)::integer into v_count from auth_rate_limits
   where key_type = 'login_failure' and key_hash = p_account_hash
     and window_start > v_now - interval '1 hour' and window_start <= v_now;
  if v_count >= 10 and not exists (
    select 1 from audit_logs where action = 'auth.login_failures'
      and detail_json->>'account_hash' = p_account_hash
      and created_at > v_now - interval '1 hour'
  ) then
    insert into audit_logs(actor_user_id, action, target_type, detail_json, created_at)
      values(null, 'auth.login_failures', 'auth',
        jsonb_build_object('account_hash', p_account_hash, 'method', p_method,
                           'count', v_count, 'window_seconds', 3600), v_now);
  end if;
  return v_count;
end
$$;
revoke all on function record_auth_failure(text, text) from public, anon, authenticated;

-- 未認証で受け付けるイベントは固定の再設定要求のみ。対象アカウントの存否は残さない。
create or replace function record_password_reset_request()
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into audit_logs(actor_user_id, action, target_type, detail_json)
    values(null, 'auth.password_reset_requested', 'auth', '{}'::jsonb)
$$;
revoke all on function record_password_reset_request() from public, anon, authenticated;

-- 招待中の本人も記録できるようcurrent_app_user(activeのみ)でなくauth.uidから解決する。
create or replace function audit_password_changed()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  select id into v_id from user_profiles where auth_user_id = auth.uid()
    and role in ('planner', 'admin', 'system_admin') and status in ('active', 'invited');
  if v_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  insert into audit_logs(actor_user_id, action, target_type, target_id, detail_json)
    values(v_id, 'auth.password_changed', 'user_profiles', v_id, '{}'::jsonb);
end
$$;
revoke all on function audit_password_changed() from public, anon;
grant execute on function audit_password_changed() to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function record_auth_failure(text,text), record_password_reset_request() to service_role;
  end if;
end $$;
